// The forge's whole state: one in-memory store.
//
// A repo is its refs, its objects, its issues, its pull requests and its labels.
// Nothing is persisted: the trial boots a fresh process per run, and the suite
// creates every repo it reads, so an empty store at boot is the correct start.
//
// Determinism: every timestamp comes from one monotonic counter. `tick()` returns
// the next sequence number; `iso(seq)` renders it as an ISO timestamp counting
// seconds from the scenario epoch (2025-01-01T00:00:00Z). Creation order and
// created_at order therefore always agree, and two runs of the same request
// sequence answer alike. No Date.now(), no Math.random().
//
// Git object ids are real SHA-1s (util.hashObject), so a clone that verifies a
// pack trailer or an object hash passes.

import { DEFAULT_BRANCH, EPOCH_SECONDS, ORG_LOGIN, STRANGER_LOGIN, TEAMMATE_LOGIN, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import { diffLines, hashObject, isZeroOid, ZERO_OID } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface UserRec {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  restId: number;
  nodeId: string;
  body: string;
  author: string;
  createdSeq: number;
}

export interface IssueRec {
  restId: number;
  nodeId: string;
  repoDbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  author: string;
  createdSeq: number;
  updatedSeq: number;
  comments: CommentRec[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRec {
  restId: number;
  nodeId: string;
  repoDbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  author: string;
  createdSeq: number;
  updatedSeq: number;
  comments: CommentRec[];
  files: PullFile[];
}

export interface RepoRec {
  dbId: number;
  nodeId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: IssueRec[];
  pulls: PullRec[];
  labels: LabelRec[];
  issueCounter: number;
  pullCounter: number;
}

export interface Store {
  /** The monotonic counter behind every timestamp and creation order. */
  seq: number;
  repos: Map<string, RepoRec>;
  users: Map<string, UserRec>;
  nextRepoId: number;
  nextRestId: number;
}

/** The next sequence number. Every created thing takes one. */
export function tick(store: Store): number {
  store.seq += 1;
  return store.seq;
}

/** Render a sequence number as an ISO timestamp, seconds from the epoch. */
export function iso(seq: number): string {
  return new Date((EPOCH_SECONDS + seq) * 1000).toISOString();
}

/** The store, seeded with the scenario's four accounts and no repos. */
export function createStore(): Store {
  const users = new Map<string, UserRec>();
  users.set(VIEWER_LOGIN, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  users.set(TEAMMATE_LOGIN, { login: TEAMMATE_LOGIN, id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' });
  users.set(STRANGER_LOGIN, { login: STRANGER_LOGIN, id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' });
  users.set(ORG_LOGIN, { login: ORG_LOGIN, id: 1003, name: 'faint meadow org', email: '', type: 'Organization' });
  return { seq: 0, repos: new Map(), users, nextRepoId: 1, nextRestId: 1 };
}

/** The map key for a repo: "owner/name". */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Look a repo up by owner and name; undefined when it does not exist. */
export function getRepo(store: Store, owner: string, name: string): RepoRec | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** Create a repo under the viewer. The caller checks the name is free first. */
export function createRepo(store: Store, owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const dbId = store.nextRepoId;
  store.nextRepoId += 1;
  const seq = tick(store);
  const repo: RepoRec = {
    dbId,
    nodeId: Buffer.from(`Repository:${dbId}`, 'utf8').toString('base64url'),
    name,
    owner,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdSeq: seq,
    updatedSeq: seq,
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: [],
    issueCounter: 0,
    pullCounter: 0,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

/** Delete a repo; true when one existed. */
export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

/** Store an object and return its id. */
export function putObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** A parsed commit: its tree, its parents, and its message. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

/** Parse a commit's raw bytes. Throws on malformed input. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  if (tree === '') throw new Error('commit has no tree');
  return { tree, parents, authorLine, committerLine, message };
}

/** Build a commit object, store it, and return its id. */
export function makeCommit(
  repo: RepoRec,
  treeOid: string,
  parents: string[],
  name: string,
  email: string,
  timestampSeconds: number,
  message: string,
): string {
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const ident = `${name} <${email}> ${timestampSeconds} +0000`;
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  lines.push('');
  lines.push(message);
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/** One entry of a flattened tree: a path to a blob (or a submodule, which never occurs here). */
export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree object into path -> entry, recursing into subtrees. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  let offset = 0;
  const data = obj.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    offset = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') {
      for (const [subPath, entry] of flattenTree(repo, oid, path)) out.set(subPath, entry);
    } else {
      out.set(path, { mode, oid });
    }
  }
  return out;
}

/** Build (and store) a tree object from a flattened path map. Returns the tree id. */
export function buildTree(repo: RepoRec, paths: Map<string, FlatEntry>): string {
  // Group by first path segment; leaves are files, groups are subtrees.
  const children = new Map<string, { mode: string; oid: string; name: string }>();
  const dirs = new Map<string, Map<string, FlatEntry>>();
  for (const [path, entry] of paths) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      children.set(path, { mode: entry.mode, oid: entry.oid, name: path });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let sub = dirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(rest, entry);
    }
  }
  for (const [dir, sub] of dirs) {
    const oid = buildTree(repo, sub);
    children.set(dir, { mode: '40000', oid, name: dir });
  }
  const entries = [...children.values()].sort((a, b) => {
    // Git sorts tree entries by name, with directories sorted as if named "name/".
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

/** The empty tree's id (constant across every repo). */
export function emptyTreeOid(repo: RepoRec): string {
  return putObject(repo, 'tree', Buffer.alloc(0));
}

/** The tree of a commit, or the empty tree when the commit is missing. */
export function commitTree(repo: RepoRec, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return emptyTreeOid(repo);
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return emptyTreeOid(repo);
  }
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (isZeroOid(ancestor) || isZeroOid(descendant)) return false;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } catch {
      // A malformed commit has no parents to walk.
    }
  }
  return false;
}

/**
 * Three-way merge of flattened trees: base, head and target.
 * Returns the merged path map, or { conflict: true } when both sides changed
 * the same path differently. The winner's mode is kept.
 */
export function mergeTrees(
  base: Map<string, FlatEntry>,
  head: Map<string, FlatEntry>,
  target: Map<string, FlatEntry>,
): { conflict: boolean; paths?: Map<string, FlatEntry> } {
  const merged = new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...target.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const t = target.get(path);
    const hOid = h?.oid;
    const tOid = t?.oid;
    if (hOid === tOid) {
      if (h !== undefined) merged.set(path, h);
    } else if (b?.oid === hOid) {
      if (t !== undefined) merged.set(path, t);
    } else if (b?.oid === tOid) {
      if (h !== undefined) merged.set(path, h);
    } else {
      return { conflict: true };
    }
  }
  return { conflict: false, paths: merged };
}

/** The file list of a pull: base tree -> head tree, with real line counts. */
export function diffFiles(repo: RepoRec, baseTree: string, headTree: string): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b !== undefined && h === undefined) {
      // A deleted file: GitHub lists it as removed; the suite never deletes, so
      // count it as a modification of zero lines rather than inventing a status.
      const blob = repo.objects.get(b.oid);
      const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      files.push({ filename: path, status: 'modified', additions: 0, deletions: lines, changes: lines });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const before = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const after = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = diffLines(before, after);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Whether a pull can merge right now: its three-way merge has no conflicts. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  const baseTree = commitTree(repo, pull.baseSha);
  const headTree = commitTree(repo, pull.headSha);
  const targetTree = commitTree(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID);
  return !mergeTrees(flattenTree(repo, baseTree), flattenTree(repo, headTree), flattenTree(repo, targetTree)).conflict;
}
