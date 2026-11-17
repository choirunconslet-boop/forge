// GitHub REST v3: /api/v3/*.
//
// The contract (from the sealed suite's checks-rest.ts header):
//   GET  /api/v3/                 200 JSON + X-OAuth-Scopes
//   GET  /api/v3/meta             200 {"installed_version": string}
//   POST /api/v3/user/repos       201, duplicate name 422
//   GET  /api/v3/repos/{o}/{r}    200, 404 when absent
//   PATCH/DELETE /repos/{o}/{r}   200 description update / 204 gone
//   GET  /api/v3/user/repos       paginated, Link rel="next", same origin
//   POST /repos/{o}/{r}/git/refs  201 {ref, object:{sha}}
//   GET  /repos/{o}/{r}/branches  [{name, commit:{sha}}]
//   GET  /repos/{o}/{r}/commits   [{sha, commit:{message}}], ?sha=<branch> scopes it
//   PUT  /repos/{o}/{r}/contents/{path}  201 create / 200 update / 409 stale sha
//   GET  /repos/{o}/{r}/contents/{path}  file {encoding:"base64",...} or dir listing
//   DELETE /contents/{path}       200 {commit:{sha}}, 404 afterwards
//   POST /repos/{o}/{r}/labels    201 {name, color}
//   POST/GET/PATCH /issues        201/200, 422 on an unknown label
//   POST/GET /issues/{n}/comments 201 {id, body}
//   POST/GET /pulls               201 {number, state:"open", head, base}
//   GET  /pulls/{n}/files        [{filename, status, additions, ...}]
//   PUT  /pulls/{n}/merge         200 {sha, merged:true, message}; 404 unknown, 405 conflict
//
// Ownership: a repo under another login is 404 (never 403); no token is 401 on
// private repos. Every reply is application/json with X-GitHub-Request-Id.
// A malformed JSON body is 400. An unknown route is a JSON 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeId } from './util.ts';
import type { Ctx } from './app.ts';
import { parseJsonBody, pathOf, queryOf, readBody, sendError, sendJson } from './app.ts';
import {
  buildTree,
  commitTree,
  createRepo,
  deleteRepo,
  diffFiles,
  flattenTree,
  getRepo,
  iso,
  makeCommit,
  mergeTrees,
  parseCommit,
  pullMergeable,
  putObject,
  tick,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';
import { EPOCH_SECONDS, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import { isZeroOid } from './util.ts';

/** A paginated slice plus the Link header value for the next page, if any. */
function paginate<T>(items: readonly T[], query: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    link = `<http://${host}${basePath}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return { page: slice, link };
}

/** Send a JSON reply, adding a Link header when the page has a next one. */
function sendPage(res: ServerResponse, status: number, body: unknown, ctx: Ctx, link: string | null): void {
  sendJson(res, status, body, ctx, link === null ? {} : { link });
}

/** The public shape of a repository. */
function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdSeq),
    updated_at: iso(repo.updatedSeq),
    pushed_at: iso(repo.updatedSeq),
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

/** The public shape of an issue. */
function issueJson(issue: IssueRec, repo: RepoRec): Record<string, unknown> {
  return {
    id: issue.restId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.author, id: issue.author === VIEWER_LOGIN ? VIEWER_ID : 1002, type: 'User' },
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((label) => label.name === name);
      return { name, color: found?.color ?? 'ededed', description: found?.description ?? '' };
    }),
    assignees: issue.assignees.map((login) => ({ login })),
    comments: issue.comments.length,
    created_at: iso(issue.createdSeq),
    updated_at: iso(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? iso(issue.updatedSeq) : null,
  };
}

/** The public shape of a pull request. */
function pullJson(pull: PullRec, repo: RepoRec): Record<string, unknown> {
  return {
    id: pull.restId,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: pull.author, id: pull.author === VIEWER_LOGIN ? VIEWER_ID : 1002, type: 'User' },
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : false,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: iso(pull.createdSeq),
    updated_at: iso(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? iso(pull.updatedSeq) : null,
  };
}

/** 401 unless the request carries the trial token. */
function requireAuth(res: ServerResponse, ctx: Ctx): boolean {
  if (ctx.authed) return true;
  sendError(res, 401, 'Requires authentication', ctx);
  return false;
}

/**
 * Load a repo for a REST call: 404 when absent (never 403, even for another
 * owner), 401 when it is private and the request has no token.
 */
function loadRepo(res: ServerResponse, ctx: Ctx, owner: string, name: string): RepoRec | null {
  const repo = getRepo(ctx.store, owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found', ctx);
    return null;
  }
  if (repo.private && !ctx.authed) {
    sendError(res, 401, 'Requires authentication', ctx);
    return null;
  }
  return repo;
}

/** The tip of a branch, or null when the branch does not exist. */
function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Walk commits from a tip, newest first, deduplicated. */
function walkCommits(repo: RepoRec, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || isZeroOid(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let parsed;
    try {
      parsed = parseCommit(obj.data);
    } catch {
      continue;
    }
    out.push({ sha: oid, message: parsed.message.replace(/\n+$/, '') });
    for (const parent of parsed.parents) stack.push(parent);
  }
  return out;
}

/** Commit a file's new bytes onto a branch; returns the commit and blob ids. */
function commitFile(
  store: Store,
  repo: RepoRec,
  branch: string,
  filePath: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const tip = branchTip(repo, branch);
  const baseTree = tip === null ? '' : commitTree(repo, tip);
  const flat = tip === null ? new Map() : flattenTree(repo, baseTree);
  const blobOid = putObject(repo, 'blob', content);
  flat.set(filePath, { mode: '100644', oid: blobOid });
  const treeOid = buildTree(repo, flat);
  const seq = tick(store);
  const commitOid = makeCommit(
    repo,
    treeOid,
    tip === null ? [] : [tip],
    VIEWER_NAME,
    VIEWER_EMAIL,
    EPOCH_SECONDS + seq,
    message,
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedSeq = seq;
  return { commitSha: commitOid, contentSha: blobOid };
}

/** The REST entry point: route /api/v3/* to the right handler. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string, method: string): Promise<void> {
  const sub = path === '/api/v3' ? '' : path.slice('/api/v3'.length);
  const query = queryOf(req);

  // GET /api/v3/ — the API root. Public, like GitHub's.
  if ((sub === '' || sub === '/') && method === 'GET') {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
        rate_limit_url: '/api/v3/rate_limit',
        meta_url: '/api/v3/meta',
      },
      ctx,
      { 'x-oauth-scopes': 'repo' },
    );
    return;
  }

  // GET /api/v3/meta — public.
  if (sub === '/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, ctx);
    return;
  }

  // Bodies: read once for the methods that carry one; a malformed JSON body is 400.
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw === null) {
      sendError(res, 413, 'request body too large', ctx);
      return;
    }
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON', ctx);
        return;
      }
      body = parsed.value;
    } else {
      body = {};
    }
  }
  const fields = (body ?? {}) as Record<string, unknown>;
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

  // GET /api/v3/user — the viewer.
  if (sub === '/user' && method === 'GET') {
    if (!requireAuth(res, ctx)) return;
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }, ctx);
    return;
  }

  // /api/v3/user/repos — list (GET) and create (POST).
  if (sub === '/user/repos') {
    if (!requireAuth(res, ctx)) return;
    if (method === 'GET') {
      const owned = [...ctx.store.repos.values()]
        .filter((repo) => repo.owner === VIEWER_LOGIN)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(owned, query, req, '/api/v3/user/repos');
      sendPage(res, 200, page.map(repoJson), ctx, link);
      return;
    }
    if (method === 'POST') {
      const name = asString(fields.name);
      if (name === '' || /[/\s]/.test(name) || name.length > 100) {
        sendError(res, 422, 'Invalid repository name', ctx);
        return;
      }
      if (getRepo(ctx.store, VIEWER_LOGIN, name) !== undefined) {
        sendError(res, 422, 'Repository already exists', ctx);
        return;
      }
      const repo = createRepo(ctx.store, VIEWER_LOGIN, name, asString(fields.description), fields.private === true);
      sendJson(res, 201, repoJson(repo), ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // /api/v3/repos/{owner}/{name}[/...]
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(sub);
  if (repoMatch === null) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const [, owner, repoName, rest] = repoMatch;
  const restPath = rest ?? '';

  // The repo itself: GET / PATCH / DELETE. DELETE needs auth even for a public repo.
  if (restPath === '') {
    if (method === 'GET') {
      const repo = loadRepo(res, ctx, owner, repoName);
      if (repo === null) return;
      sendJson(res, 200, repoJson(repo), ctx);
      return;
    }
    if (!requireAuth(res, ctx)) return;
    if (method === 'PATCH') {
      const repo = loadRepo(res, ctx, owner, repoName);
      if (repo === null) return;
      if (typeof fields.description === 'string') repo.description = fields.description;
      if (typeof fields.default_branch === 'string' && repo.refs.has(`refs/heads/${fields.default_branch}`)) {
        repo.defaultBranch = fields.default_branch;
      }
      repo.updatedSeq = tick(ctx.store);
      sendJson(res, 200, repoJson(repo), ctx);
      return;
    }
    if (method === 'DELETE') {
      const repo = loadRepo(res, ctx, owner, repoName);
      if (repo === null) return;
      deleteRepo(ctx.store, owner, repoName);
      res.writeHead(204, { 'x-github-request-id': ctx.requestId });
      res.end();
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // Everything below needs the repo to exist (404 first, then 401 for private).
  const repo = loadRepo(res, ctx, owner, repoName);
  if (repo === null) return;

  // POST /git/refs — create a branch (or a tag ref) at a sha.
  if (restPath === 'git/refs' && method === 'POST') {
    if (!requireAuth(res, ctx)) return;
    const ref = asString(fields.ref);
    const sha = asString(fields.sha);
    if (!/^refs\/(heads|tags)\/[^\s]+$/.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) {
      sendError(res, 422, 'Invalid ref or sha', ctx);
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Reference already exists', ctx);
      return;
    }
    if (!repo.objects.has(sha)) {
      sendError(res, 422, 'Object does not exist', ctx);
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha }, url: `${req.url ?? ''}` }, ctx);
    return;
  }

  // GET /git/refs/heads/{branch} — read one branch ref (used by the MCP setup).
  if (restPath.startsWith('git/refs/heads/') && method === 'GET') {
    const branch = decodeURIComponent(restPath.slice('git/refs/heads/'.length));
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }, ctx);
    return;
  }

  // GET /branches.
  if (restPath === 'branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches, ctx);
    return;
  }

  // GET /branches/{branch} — read one branch (used by the MCP setup).
  if (restPath.startsWith('branches/') && method === 'GET') {
    const branch = decodeURIComponent(restPath.slice('branches/'.length));
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    sendJson(res, 200, { name: branch, commit: { sha } }, ctx);
    return;
  }

  // GET /commits[?sha=<branch>].
  if (restPath === 'commits' && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = branchTip(repo, ref);
    if (tip === null) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    const commits = walkCommits(repo, tip).map((entry) => ({ sha: entry.sha, commit: { message: entry.message } }));
    sendJson(res, 200, commits, ctx);
    return;
  }

  // /contents/{path...} — GET / PUT / DELETE.
  if (restPath.startsWith('contents')) {
    const filePath = restPath.slice('contents'.length).replace(/^\//, '');
    return handleContents(req, res, ctx, repo, filePath, method, query, fields);
  }

  // /labels — GET / POST.
  if (restPath === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, repo.labels, ctx);
      return;
    }
    if (method === 'POST') {
      if (!requireAuth(res, ctx)) return;
      const name = asString(fields.name);
      if (name === '') {
        sendError(res, 422, 'A label name is required', ctx);
        return;
      }
      if (repo.labels.some((label) => label.name === name)) {
        sendError(res, 422, 'Label already exists', ctx);
        return;
      }
      const label = { name, color: asString(fields.color) || 'ededed', description: asString(fields.description) };
      repo.labels.push(label);
      sendJson(res, 201, label, ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // /issues — GET / POST.
  if (restPath === 'issues') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, link } = paginate(list, query, req, `/api/v3/repos/${owner}/${repoName}/issues`);
      sendPage(res, 200, page.map((issue) => issueJson(issue, repo)), ctx, link);
      return;
    }
    if (method === 'POST') {
      if (!requireAuth(res, ctx)) return;
      const title = asString(fields.title);
      if (title === '') {
        sendError(res, 422, 'A title is required', ctx);
        return;
      }
      const labelNames = Array.isArray(fields.labels) ? fields.labels.map((label) => String(label)) : [];
      for (const name of labelNames) {
        if (!repo.labels.some((label) => label.name === name)) {
          sendError(res, 422, `Label ${name} does not exist`, ctx);
          return;
        }
      }
      repo.issueCounter += 1;
      const number = repo.issueCounter;
      const seq = tick(ctx.store);
      const issue: IssueRec = {
        restId: ctx.store.nextRestId,
        nodeId: nodeId('Issue', repo.dbId, number),
        repoDbId: repo.dbId,
        number,
        title,
        body: asString(fields.body),
        state: 'open',
        labels: labelNames,
        assignees: [],
        author: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      ctx.store.nextRestId += 1;
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(issue, repo), ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // /issues/{n} — GET / PATCH; /issues/{n}/comments — GET / POST.
  const issueMatch = /^issues\/(\d+)(\/comments)?$/.exec(restPath);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.restId, node_id: comment.nodeId, body: comment.body, user: { login: comment.author } })), ctx);
        return;
      }
      if (method === 'POST') {
        if (!requireAuth(res, ctx)) return;
        const text = asString(fields.body);
        if (text === '') {
          sendError(res, 422, 'A comment body is required', ctx);
          return;
        }
        const comment = {
          restId: ctx.store.nextRestId,
          nodeId: nodeId('IssueComment', repo.dbId, ctx.store.nextRestId),
          body: text,
          author: VIEWER_LOGIN,
          createdSeq: tick(ctx.store),
        };
        ctx.store.nextRestId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.restId, node_id: comment.nodeId, body: comment.body, user: { login: comment.author } }, ctx);
        return;
      }
      sendError(res, 405, 'Method Not Allowed', ctx);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue, repo), ctx);
      return;
    }
    if (method === 'PATCH') {
      if (!requireAuth(res, ctx)) return;
      if (typeof fields.state === 'string' && (fields.state === 'open' || fields.state === 'closed')) issue.state = fields.state;
      if (typeof fields.title === 'string') issue.title = fields.title;
      if (typeof fields.body === 'string') issue.body = fields.body;
      issue.updatedSeq = tick(ctx.store);
      sendJson(res, 200, issueJson(issue, repo), ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // /pulls — GET / POST.
  if (restPath === 'pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number);
      const { page, link } = paginate(list, query, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
      sendPage(res, 200, page.map((pull) => pullJson(pull, repo)), ctx, link);
      return;
    }
    if (method === 'POST') {
      if (!requireAuth(res, ctx)) return;
      const headRef = asString(fields.head);
      const baseRef = asString(fields.base);
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) {
        sendError(res, 422, 'Head or base branch does not exist', ctx);
        return;
      }
      repo.pullCounter += 1;
      const number = repo.pullCounter;
      const seq = tick(ctx.store);
      const pull: PullRec = {
        restId: ctx.store.nextRestId,
        nodeId: nodeId('PullRequest', repo.dbId, number),
        repoDbId: repo.dbId,
        number,
        title: asString(fields.title),
        body: asString(fields.body),
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        author: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
        files: diffFiles(repo, commitTree(repo, baseSha), commitTree(repo, headSha)),
      };
      ctx.store.nextRestId += 1;
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(pull, repo), ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  // /pulls/{n} — GET; /pulls/{n}/files — GET; /pulls/{n}/merge — PUT.
  const pullMatch = /^pulls\/(\d+)(\/(files|merge))?$/.exec(restPath);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    const suffix = pullMatch[3] ?? '';
    if (suffix === 'files' && method === 'GET') {
      sendJson(res, 200, pull.files, ctx);
      return;
    }
    if (suffix === 'merge' && method === 'PUT') {
      if (!requireAuth(res, ctx)) return;
      if (pull.merged) {
        sendError(res, 405, 'Pull request is already merged', ctx);
        return;
      }
      const baseTip = branchTip(repo, pull.baseRef);
      const headTip = branchTip(repo, pull.headRef);
      if (baseTip === null || headTip === null) {
        sendError(res, 404, 'Head or base branch does not exist', ctx);
        return;
      }
      const baseTree = flattenTree(repo, commitTree(repo, pull.baseSha));
      const headTree = flattenTree(repo, commitTree(repo, headTip));
      const targetTree = flattenTree(repo, commitTree(repo, baseTip));
      const merged = mergeTrees(baseTree, headTree, targetTree);
      if (merged.conflict || merged.paths === undefined) {
        sendError(res, 405, 'Merge conflict', ctx);
        return;
      }
      const treeOid = buildTree(repo, merged.paths);
      const seq = tick(ctx.store);
      const mergeCommit = makeCommit(repo, treeOid, [baseTip], VIEWER_NAME, VIEWER_EMAIL, EPOCH_SECONDS + seq, pull.title);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = iso(seq);
      pull.mergeCommitSha = mergeCommit;
      pull.updatedSeq = seq;
      repo.updatedSeq = seq;
      sendJson(res, 200, { sha: mergeCommit, merged: true, message: 'Pull Request successfully merged' }, ctx);
      return;
    }
    if (suffix === '' && method === 'GET') {
      sendJson(res, 200, pullJson(pull, repo), ctx);
      return;
    }
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }

  sendError(res, 404, 'Not Found', ctx);
}

/** The /contents/{path} handlers: GET a file or a directory, PUT a file, DELETE a file. */
async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: RepoRec,
  filePath: string,
  method: string,
  query: URLSearchParams,
  fields: Record<string, unknown>,
): Promise<void> {
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, ref);

  if (method === 'GET') {
    if (tip === null) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    const flat = flattenTree(repo, commitTree(repo, tip));
    const entry = flat.get(filePath);
    if (entry !== undefined) {
      const blob = repo.objects.get(entry.oid);
      const bytes = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: bytes.toString('base64'),
        sha: entry.oid,
      }, ctx);
      return;
    }
    // A directory: the immediate children of the path (or the root when empty).
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, flatEntry] of flat) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { type: 'file', name: rest, path, sha: flatEntry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          const sub = new Map<string, { mode: string; oid: string }>();
          for (const [subPath, subEntry] of flat) {
            if (subPath.startsWith(`${prefix}${dir}/`)) sub.set(subPath.slice(`${prefix}${dir}/`.length), subEntry);
          }
          children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: buildTree(repo, sub) });
        }
      }
    }
    if (children.size === 0) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), ctx);
    return;
  }

  if (method === 'PUT') {
    if (!requireAuth(res, ctx)) return;
    const message = asString(fields.message);
    const contentB64 = asString(fields.content);
    if (message === '' || contentB64 === '') {
      sendError(res, 422, 'A message and base64 content are required', ctx);
      return;
    }
    const branch = asString(fields.branch) || repo.defaultBranch;
    const branchTipOid = branchTip(repo, branch);
    if (branchTipOid === null && repo.refs.size > 0) {
      sendError(res, 404, 'Branch does not exist', ctx);
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(res, 422, 'Content is not valid base64', ctx);
      return;
    }
    const sha = asString(fields.sha);
    if (branchTipOid !== null) {
      const flat = flattenTree(repo, commitTree(repo, branchTipOid));
      const current = flat.get(filePath);
      if (current !== undefined) {
        // Update: the sha must be the current blob's.
        if (sha === '' || sha.toLowerCase() !== current.oid.toLowerCase()) {
          sendError(res, 409, 'sha does not match the current file', ctx);
          return;
        }
      } else if (sha !== '') {
        sendError(res, 409, 'sha does not match the current file', ctx);
        return;
      }
    }
    const existed = branchTipOid !== null && flattenTree(repo, commitTree(repo, branchTipOid)).has(filePath);
    const { commitSha, contentSha } = commitFile(ctx.store, repo, branch, filePath, content, message);
    sendJson(res, existed ? 200 : 201, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message },
    }, ctx);
    return;
  }

  if (method === 'DELETE') {
    if (!requireAuth(res, ctx)) return;
    const branch = asString(fields.branch) || repo.defaultBranch;
    const branchTipOid = branchTip(repo, branch);
    if (branchTipOid === null) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    const flat = flattenTree(repo, commitTree(repo, branchTipOid));
    const current = flat.get(filePath);
    if (current === undefined) {
      sendError(res, 404, 'Not Found', ctx);
      return;
    }
    const sha = asString(fields.sha);
    if (sha !== '' && sha.toLowerCase() !== current.oid.toLowerCase()) {
      sendError(res, 409, 'sha does not match the current file', ctx);
      return;
    }
    flat.delete(filePath);
    const treeOid = buildTree(repo, flat);
    const seq = tick(ctx.store);
    const commitOid = makeCommit(repo, treeOid, [branchTipOid], VIEWER_NAME, VIEWER_EMAIL, EPOCH_SECONDS + seq, asString(fields.message) || `Delete ${filePath}`);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedSeq = seq;
    sendJson(res, 200, { commit: { sha: commitOid } }, ctx);
    return;
  }

  sendError(res, 405, 'Method Not Allowed', ctx);
}
