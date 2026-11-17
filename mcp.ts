// MCP: POST /mcp, Streamable HTTP, JSON-RPC 2.0.
//
// Two eras, both accepted:
//   - modern 2026-07-28: `server/discover` returns the identity, capabilities
//     and supported versions in one request; no handshake, no session.
//   - legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// The server is stateless: it never issues a Mcp-Session-Id, so a legacy client
// has no session to close.
//
// Wire rules (from the sealed suite's mcp-client.ts):
//   - every request declares its revision in `_meta` and mirrors it in the
//     `MCP-Protocol-Version` header; a revision outside the supported list
//     answers -32022 with the supported list in `data.supported`;
//   - a body that is not JSON answers HTTP 400 with JSON-RPC -32700;
//   - an unknown tool answers JSON-RPC -32602, never HTTP 500;
//   - a tools/call without the required arguments answers isError:true;
//   - a tools/call with no Authorization header answers HTTP 401;
//   - notifications (no id) answer HTTP 202 with an empty body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { parseJsonBody, readBody, sendJson } from './app.ts';
import {
  buildTree,
  commitTree,
  createRepo,
  diffFiles,
  flattenTree,
  getRepo,
  iso,
  makeCommit,
  mergeTrees,
  pullMergeable,
  tick,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { EPOCH_SECONDS, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import { nodeId } from './util.ts';

/** The revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The server's identity, in both the result and the _meta the client reads first. */
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const MCP_UNSUPPORTED_VERSION = -32022;

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The public shape of a repository, as the REST surface answers it. */
function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdSeq),
    updated_at: iso(repo.updatedSeq),
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
    user: { login: issue.author, type: 'User' },
    labels: issue.labels.map((name) => ({ name })),
    created_at: iso(issue.createdSeq),
    updated_at: iso(issue.updatedSeq),
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
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : false,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: iso(pull.createdSeq),
    updated_at: iso(pull.updatedSeq),
  };
}

/** A tool result: text blocks plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool-level failure: isError:true with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** The JSON-RPC envelope for a result, echoing the request id. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** The JSON-RPC envelope for an error, echoing the request id. */
function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Load a repo for a tool call, or the tool error to answer with. */
function loadRepoForTool(ctx: Ctx, owner: string, repoName: string): RepoRec | Record<string, unknown> {
  const repo = getRepo(ctx.store, owner, repoName);
  if (repo === undefined) return toolError(`Repository ${owner}/${repoName} was not found.`);
  return repo;
}

/** Run one tool; the value is a tool result (never a throw for a tool failure). */
function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    // The dispatcher answers unknown tools as a JSON-RPC error, not here.
    return toolError(`Unknown tool: ${name}`);
  }
  for (const required of tool.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (getRepo(ctx.store, VIEWER_LOGIN, repoName) !== undefined) {
        return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists.`);
      }
      const repo = createRepo(ctx.store, VIEWER_LOGIN, repoName, asString(args.description), args.private === true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = loadRepoForTool(ctx, asString(args.owner), asString(args.repo));
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      return toolResult(repoJson(repo as RepoRec));
    }
    case 'create_issue': {
      const repo = loadRepoForTool(ctx, asString(args.owner), asString(args.repo));
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as RepoRec;
      target.issueCounter += 1;
      const number = target.issueCounter;
      const seq = tick(ctx.store);
      const issue: IssueRec = {
        restId: ctx.store.nextRestId,
        nodeId: nodeId('Issue', target.dbId, number),
        repoDbId: target.dbId,
        number,
        title: asString(args.title),
        body: asString(args.body),
        state: 'open',
        labels: [],
        assignees: [],
        author: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      ctx.store.nextRestId += 1;
      target.issues.push(issue);
      return toolResult(issueJson(issue, target));
    }
    case 'list_issues': {
      const repo = loadRepoForTool(ctx, asString(args.owner), asString(args.repo));
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as RepoRec;
      const state = asString(args.state) || 'open';
      const list = target.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return toolResult(list.map((issue) => issueJson(issue, target)));
    }
    case 'create_pull_request': {
      const repo = loadRepoForTool(ctx, asString(args.owner), asString(args.repo));
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as RepoRec;
      const headRef = asString(args.head);
      const baseRef = asString(args.base);
      const headSha = target.refs.get(`refs/heads/${headRef}`);
      const baseSha = target.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        return toolError('Head or base branch does not exist.');
      }
      if (target.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef)) {
        return toolError('A pull request from that head into that base is already open.');
      }
      target.pullCounter += 1;
      const number = target.pullCounter;
      const seq = tick(ctx.store);
      const pull: PullRec = {
        restId: ctx.store.nextRestId,
        nodeId: nodeId('PullRequest', target.dbId, number),
        repoDbId: target.dbId,
        number,
        title: asString(args.title),
        body: asString(args.body),
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
        files: diffFiles(target, commitTree(target, baseSha), commitTree(target, headSha)),
      };
      ctx.store.nextRestId += 1;
      target.pulls.push(pull);
      return toolResult(pullJson(pull, target));
    }
    case 'merge_pull_request': {
      const repo = loadRepoForTool(ctx, asString(args.owner), asString(args.repo));
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as RepoRec;
      const number = Number(args.pull_number);
      const pull = target.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`Pull request #${number} was not found.`);
      if (pull.merged) return toolError(`Pull request #${number} is already merged.`);
      const baseTip = target.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = target.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) return toolError('Head or base branch does not exist.');
      const merged = mergeTrees(
        flattenTree(target, commitTree(target, pull.baseSha)),
        flattenTree(target, commitTree(target, headTip)),
        flattenTree(target, commitTree(target, baseTip)),
      );
      if (merged.conflict || merged.paths === undefined) {
        return toolError(`Pull request #${number} has a merge conflict.`);
      }
      const treeOid = buildTree(target, merged.paths);
      const seq = tick(ctx.store);
      const mergeCommit = makeCommit(target, treeOid, [baseTip], VIEWER_NAME, VIEWER_EMAIL, EPOCH_SECONDS + seq, pull.title);
      target.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = iso(seq);
      pull.mergeCommitSha = mergeCommit;
      pull.updatedSeq = seq;
      target.updatedSeq = seq;
      return toolResult({ number: pull.number, merged: true, state: 'closed', sha: mergeCommit });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/** Answer one JSON-RPC request object (or null for a notification). */
function handleRpc(ctx: Ctx, req: IncomingMessage, request: unknown): Record<string, unknown> | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }
  const record = request as Record<string, unknown>;
  const id = record.id ?? null;
  const isNotification = record.id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // A notification is acknowledged and nothing more.
  if (isNotification) return null;

  // The declared revision must be one this server speaks.
  const headerVersion = req.headers['mcp-protocol-version'];
  if (typeof headerVersion === 'string' && headerVersion !== '' && !SUPPORTED_VERSIONS.includes(headerVersion)) {
    return rpcError(id, MCP_UNSUPPORTED_VERSION, `Unsupported protocol version: ${headerVersion}`, { supported: SUPPORTED_VERSIONS });
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = typeof (params.protocolVersion as string | undefined) === 'string' ? (params.protocolVersion as string) : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list': {
      return rpcResult(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: tool.properties,
            required: tool.required,
          },
        })),
      });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${toolName}`);
      }
      return rpcResult(id, callTool(ctx, toolName, args));
    }
    default:
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** POST /mcp: JSON-RPC over Streamable HTTP (plain JSON answers, no SSE). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx, method: string): Promise<void> {
  if (method === 'DELETE') {
    // A legacy session's goodbye: there is no session to forget.
    res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    res.end();
    return;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': ctx.requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Method Not Allowed' } }));
    return;
  }
  if (!ctx.authed) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': ctx.requestId });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    res.writeHead(413, { 'content-type': 'application/json', 'x-github-request-id': ctx.requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_PARAMS, message: 'Request body too large' } }));
    return;
  }
  // A body that is not JSON is HTTP 400 with JSON-RPC -32700.
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': ctx.requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } }));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown> | null> = parsed.map((entry) => handleRpc(ctx, req, entry));
    sendJson(res, 200, answers.filter((answer) => answer !== null), ctx);
    return;
  }
  const answer = handleRpc(ctx, req, parsed);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    res.end();
    return;
  }
  sendJson(res, 200, answer, ctx);
}
