// GraphQL v4: POST /api/graphql.
//
// A hand-written executor for the documents gh and github-mcp-server send: a
// recursive-descent parser for the query language subset they use (operations,
// fields, aliases, arguments, variables, inline fragments, fragment spreads,
// input objects, enums, lists), a small schema table for validation and
// introspection, and resolvers over the same store the REST surface uses — so a
// mutation is visible over REST afterwards and vice versa.
//
// Wire rules (from the sealed suite's graphql-client.ts):
//   - a GraphQL-level failure (an unknown field, a bad argument) is HTTP 200
//     with an `errors` array, never an HTTP error;
//   - an unauthenticated request is 401;
//   - a JSON array body is operation batching: one response per operation,
//     in the same order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { parseJsonBody, readBody, sendError, sendJson } from './app.ts';
import {
  buildTree,
  commitTree,
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
  type Store,
} from './store.ts';
import { EPOCH_SECONDS, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import { nodeId, parseNodeId } from './util.ts';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
}

class ParseError extends Error {}

/** Split a document into tokens. Commas are insignificant; # starts a comment. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek() !== undefined) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token?.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new ParseError('a fragment needs "on Type"');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selection: this.parseSelectionSet() };
    }
    let operation: OperationNode['operation'] = 'query';
    let name: string | undefined;
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = this.next().value as OperationNode['operation'];
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables = this.parseVariableDefinitions();
    return { kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() };
  }

  /** Variable definitions: ($name: Type = default, ...) — the type is consumed, not checked. */
  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const variables: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  /** A type annotation: Name, [Type] and ! in any nesting — consumed, never validated. */
  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      const next = this.peek();
      if (next?.kind === 'name' && next.value !== 'on') {
        return { kind: 'spread', name: this.next().value };
      }
      let typeCondition: string | undefined;
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

/** The fields each object type carries, for validation and __type introspection. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body', 'author'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

/** The values of each enum type, for __type introspection. */
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

/** A resolved node: its GraphQL type plus the record behind it. */
type Node =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: RepoRec }
  | { __typename: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __typename: 'IssueConnection'; nodes: Node[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __typename: 'PullRequestConnection'; nodes: Node[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changes: number }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Node[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'CreateIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { __typename: 'CloseIssuePayload'; repo: RepoRec; issue: IssueRec }
  | { __typename: 'CreatePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { __typename: 'MergePullRequestPayload'; repo: RepoRec; pull: PullRec }
  | { __typename: 'AddCommentPayload'; comment: { id: string; body: string; author: string } }
  | { __typename: 'IssueCommentEdge'; comment: { id: string; body: string; author: string } }
  | { __typename: 'IssueComment'; id: string; body: string; author: string }
  | { __typename: 'User'; login: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

/** The cursor of a connection page: base64url("cursor:<number>"). */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

/** The number a cursor names, or null when it is not one of ours. */
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Validate a selection set against a parent type; unknown fields become errors. */
function validateSelection(ex: Executor, parentType: string, selections: SelectionNode[]): void {
  const fields = TYPE_FIELDS[parentType];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        if (selection.selection !== undefined) validateSelection(ex, parentType, selection.selection);
        continue;
      }
      if (fields === undefined || !fields.includes(selection.name)) {
        ex.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        continue;
      }
      if (selection.selection !== undefined) {
        validateSelection(ex, resultType(parentType, selection.name), selection.selection);
      }
    } else if (selection.kind === 'inline') {
      const type = selection.typeCondition ?? parentType;
      validateSelection(ex, type, selection.selection);
    } else {
      const fragment = ex.fragments.get(selection.name);
      if (fragment !== undefined) validateSelection(ex, fragment.typeCondition, fragment.selection);
    }
  }
}

/** The type a field returns, for validation of its sub-selections. */
function resultType(parentType: string, field: string): string {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    Issue: { author: 'User' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[field] ?? 'String';
}

/** Execute a selection set against a parent node. */
function executeSelection(ex: Executor, parentType: string, parent: Node, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = parentType;
        continue;
      }
      out[key] = resolveField(ex, parentType, parent, selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelection(ex, parentType, parent, selection.selection));
    } else {
      const fragment = ex.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelection(ex, parentType, parent, fragment.selection));
    }
  }
  return out;
}

/** The arguments of a field, resolved against the operation's variables. */
function argsOf(ex: Executor, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ex.variables);
  return out;
}

/** Find a repo by its global id ("Repository:<dbId>"), or null. */
function repoByGlobalId(store: Store, id: string): RepoRec | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^Repository:(\d+)$/.exec(text);
    if (match === null) return null;
    const dbId = Number(match[1]);
    for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
    return null;
  } catch {
    return null;
  }
}

/** Find an issue by its global id ("Issue:<dbId>:<number>"), or null. */
function issueByGlobalId(store: Store, id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseNodeId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  for (const repo of store.repos.values()) {
    if (repo.dbId !== parsed.repoDbId) continue;
    const issue = repo.issues.find((entry) => entry.number === parsed.number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

/** Find a pull request by its global id ("PullRequest:<dbId>:<number>"), or null. */
function pullByGlobalId(store: Store, id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseNodeId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  for (const repo of store.repos.values()) {
    if (repo.dbId !== parsed.repoDbId) continue;
    const pull = repo.pulls.find((entry) => entry.number === parsed.number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

/** Create an issue in the store (shared with the REST surface). */
function createIssueInStore(store: Store, repo: RepoRec, title: string, body: string): IssueRec {
  repo.issueCounter += 1;
  const number = repo.issueCounter;
  const seq = tick(store);
  const issue: IssueRec = {
    restId: store.nextRestId,
    nodeId: nodeId('Issue', repo.dbId, number),
    repoDbId: repo.dbId,
    number,
    title,
    body,
    state: 'open',
    labels: [],
    assignees: [],
    author: VIEWER_LOGIN,
    createdSeq: seq,
    updatedSeq: seq,
    comments: [],
  };
  store.nextRestId += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request in the store (shared with the REST surface). */
function createPullInStore(store: Store, repo: RepoRec, headRef: string, baseRef: string, title: string, body: string): PullRec | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef)) return null;
  repo.pullCounter += 1;
  const number = repo.pullCounter;
  const seq = tick(store);
  const pull: PullRec = {
    restId: store.nextRestId,
    nodeId: nodeId('PullRequest', repo.dbId, number),
    repoDbId: repo.dbId,
    number,
    title,
    body,
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
  store.nextRestId += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge a pull request in the store; null when it cannot merge. */
function mergePullInStore(store: Store, repo: RepoRec, pull: PullRec): string | null {
  if (pull.merged) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const merged = mergeTrees(
    flattenTree(repo, commitTree(repo, pull.baseSha)),
    flattenTree(repo, commitTree(repo, headTip)),
    flattenTree(repo, commitTree(repo, baseTip)),
  );
  if (merged.conflict || merged.paths === undefined) return null;
  const treeOid = buildTree(repo, merged.paths);
  const seq = tick(store);
  const mergeCommit = makeCommit(repo, treeOid, [baseTip], VIEWER_NAME, VIEWER_EMAIL, EPOCH_SECONDS + seq, pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso(seq);
  pull.mergeCommitSha = mergeCommit;
  pull.updatedSeq = seq;
  repo.updatedSeq = seq;
  return mergeCommit;
}

/** The issues of a repo, ordered and paged for a connection field. */
function issueConnection(ex: Executor, repo: RepoRec, args: Record<string, unknown>): Node {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const field = orderBy.field ?? 'CREATED_AT';
  const direction = orderBy.direction ?? 'DESC';
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const byCreated = (a: IssueRec, b: IssueRec): number => {
    const bySeq = direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq;
    if (bySeq !== 0) return bySeq;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  };
  const byUpdated = (a: IssueRec, b: IssueRec): number => {
    const bySeq = direction === 'ASC' ? a.updatedSeq - b.updatedSeq : b.updatedSeq - a.updatedSeq;
    if (bySeq !== 0) return bySeq;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  };
  const byComments = (a: IssueRec, b: IssueRec): number => {
    const byCount = direction === 'ASC' ? a.comments.length - b.comments.length : b.comments.length - a.comments.length;
    if (byCount !== 0) return byCount;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  };
  list.sort(field === 'UPDATED_AT' ? byUpdated : field === 'COMMENTS' ? byComments : byCreated);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    start = index === -1 ? 0 : index + 1;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue }) as Node),
    hasNextPage,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
  };
}

/** The pull requests of a repo, as a connection (open by default). */
function pullConnection(ex: Executor, repo: RepoRec, args: Record<string, unknown>): Node {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((state) => state.toLowerCase()));
  const list = repo.pulls
    .filter((pull) => {
      const state = pull.merged ? 'merged' : pull.state;
      return wanted.has(state) || (state === 'closed' && wanted.has('closed'));
    })
    .sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as Node),
    hasNextPage: first < list.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
  };
}

/** One field's value, given its parent node. */
function resolveField(ex: Executor, parentType: string, parent: Node, field: FieldNode): unknown {
  const args = argsOf(ex, field);
  const sub = field.selection ?? [];
  const nested = (node: Node, type: string): unknown => (sub.length === 0 ? null : executeSelection(ex, type, node, sub));

  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') {
        return nested({ __typename: 'User', login: VIEWER_LOGIN }, 'User');
      }
      if (field.name === 'repository') {
        const repo = getRepo(ex.store, String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        return nested({ __typename: 'Repository', repo }, 'Repository');
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const repo = repoByGlobalId(ex.store, id);
        if (repo !== null) return nested({ __typename: 'Repository', repo }, 'Repository');
        const issue = issueByGlobalId(ex.store, id);
        if (issue !== null) return nested({ __typename: 'Issue', repo: issue.repo, issue: issue.issue }, 'Issue');
        const pull = pullByGlobalId(ex.store, id);
        if (pull !== null) return nested({ __typename: 'PullRequest', repo: pull.repo, pull: pull.pull }, 'PullRequest');
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return nested({ __typename: '__Type', name }, '__Type');
      }
      return null;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repo = repoByGlobalId(ex.store, String(input.repositoryId ?? ''));
        if (repo === null) {
          ex.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          return null;
        }
        const issue = createIssueInStore(ex.store, repo, String(input.title ?? ''), String(input.body ?? ''));
        return nested({ __typename: 'CreateIssuePayload', repo, issue }, 'CreateIssuePayload');
      }
      if (field.name === 'closeIssue') {
        const found = issueByGlobalId(ex.store, String(input.issueId ?? ''));
        if (found === null) {
          ex.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.updatedSeq = tick(ex.store);
        return nested({ __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue }, 'CloseIssuePayload');
      }
      if (field.name === 'createPullRequest') {
        const repo = repoByGlobalId(ex.store, String(input.repositoryId ?? ''));
        if (repo === null) {
          ex.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          return null;
        }
        const pull = createPullInStore(
          ex.store,
          repo,
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
          String(input.title ?? ''),
          String(input.body ?? ''),
        );
        if (pull === null) {
          ex.errors.push({ message: 'Could not create a pull request from those branches.' });
          return null;
        }
        return nested({ __typename: 'CreatePullRequestPayload', repo, pull }, 'CreatePullRequestPayload');
      }
      if (field.name === 'mergePullRequest') {
        const found = pullByGlobalId(ex.store, String(input.pullRequestId ?? ''));
        if (found === null) {
          ex.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
          return null;
        }
        const merged = mergePullInStore(ex.store, found.repo, found.pull);
        if (merged === null) {
          ex.errors.push({ message: 'Pull request cannot be merged.' });
          return null;
        }
        return nested({ __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull }, 'MergePullRequestPayload');
      }
      if (field.name === 'addComment') {
        const body = String(input.body ?? '');
        const issue = issueByGlobalId(ex.store, String(input.subjectId ?? ''));
        const pull = issue === null ? pullByGlobalId(ex.store, String(input.subjectId ?? '')) : null;
        if (issue === null && pull === null) {
          ex.errors.push({ message: 'Could not resolve to a subject with the id provided.' });
          return null;
        }
        const comment = {
          restId: ex.store.nextRestId,
          nodeId: nodeId('IssueComment', (issue ?? pull)!.repo.dbId, ex.store.nextRestId),
          body,
          author: VIEWER_LOGIN,
          createdSeq: tick(ex.store),
        };
        ex.store.nextRestId += 1;
        if (issue !== null) issue.issue.comments.push(comment);
        else pull!.pull.comments.push(comment);
        return nested(
          { __typename: 'AddCommentPayload', comment: { id: comment.nodeId, body, author: VIEWER_LOGIN } },
          'AddCommentPayload',
        );
      }
      return null;
    }
    case 'CreateIssuePayload': {
      const payload = parent as { repo: RepoRec; issue: IssueRec };
      return field.name === 'issue' ? nested({ __typename: 'Issue', repo: payload.repo, issue: payload.issue }, 'Issue') : null;
    }
    case 'CloseIssuePayload': {
      const payload = parent as { repo: RepoRec; issue: IssueRec };
      return field.name === 'issue' ? nested({ __typename: 'Issue', repo: payload.repo, issue: payload.issue }, 'Issue') : null;
    }
    case 'CreatePullRequestPayload': {
      const payload = parent as { repo: RepoRec; pull: PullRec };
      return field.name === 'pullRequest' ? nested({ __typename: 'PullRequest', repo: payload.repo, pull: payload.pull }, 'PullRequest') : null;
    }
    case 'MergePullRequestPayload': {
      const payload = parent as { repo: RepoRec; pull: PullRec };
      return field.name === 'pullRequest' ? nested({ __typename: 'PullRequest', repo: payload.repo, pull: payload.pull }, 'PullRequest') : null;
    }
    case 'AddCommentPayload': {
      const payload = parent as { comment: { id: string; body: string; author: string } };
      return field.name === 'commentEdge' ? nested({ __typename: 'IssueCommentEdge', comment: payload.comment }, 'IssueCommentEdge') : null;
    }
    case 'IssueCommentEdge': {
      const edge = parent as { comment: { id: string; body: string; author: string } };
      return field.name === 'node' ? nested({ __typename: 'IssueComment', id: edge.comment.id, body: edge.comment.body, author: edge.comment.author }, 'IssueComment') : null;
    }
    case 'Repository': {
      const repo = (parent as { repo: RepoRec }).repo;
      switch (field.name) {
        case 'id':
          return repo.nodeId;
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return nested({ __typename: 'User', login: repo.owner }, 'User');
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return nested({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref');
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === Number(args.number));
          if (issue === undefined) return null;
          return nested({ __typename: 'Issue', repo, issue }, 'Issue');
        }
        case 'issues':
          return nested(issueConnection(ex, repo, args), 'IssueConnection');
        case 'pullRequests':
          return nested(pullConnection(ex, repo, args), 'PullRequestConnection');
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
          if (pull === undefined) return null;
          return nested({ __typename: 'PullRequest', repo, pull }, 'PullRequest');
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = (parent as { issue: IssueRec }).issue;
      switch (field.name) {
        case 'id':
          return issue.nodeId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return nested({ __typename: 'User', login: issue.author }, 'User');
        case 'createdAt':
          return iso(issue.createdSeq);
        case 'updatedAt':
          return iso(issue.updatedSeq);
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const conn = parent as { nodes: Node[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.nodes.map((node) => nested(node, 'Issue'));
      if (field.name === 'pageInfo') return nested({ __typename: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor }, 'PageInfo');
      return null;
    }
    case 'PullRequest': {
      const pull = (parent as { pull: PullRec }).pull;
      const repo = (parent as { repo: RepoRec }).repo;
      switch (field.name) {
        case 'id':
          return pull.nodeId;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.state === 'open' ? (pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
          const files = pull.files.slice(0, first);
          const conn: Node = {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }) as Node),
            hasNextPage: first < pull.files.length,
            endCursor: null,
          };
          return nested(conn, 'PullRequestChangedFileConnection');
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      const conn = parent as { nodes: Node[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.nodes.map((node) => nested(node, 'PullRequest'));
      if (field.name === 'pageInfo') return nested({ __typename: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor }, 'PageInfo');
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = parent as { nodes: Node[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.nodes.map((node) => nested(node, 'PullRequestChangedFile'));
      if (field.name === 'pageInfo') return nested({ __typename: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor }, 'PageInfo');
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = parent as { path: string; additions: number; deletions: number; changes: number };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changes') return file.changes;
      return null;
    }
    case 'IssueComment': {
      const comment = parent as { id: string; body: string; author: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return nested({ __typename: 'User', login: comment.author }, 'User');
      return null;
    }
    case 'User': {
      const user = parent as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return Buffer.from(`User:${user.login}`, 'utf8').toString('base64url');
      if (field.name === 'name') return user.login === VIEWER_LOGIN ? VIEWER_NAME : user.login;
      if (field.name === 'email') return user.login === VIEWER_LOGIN ? VIEWER_EMAIL : '';
      return null;
    }
    case 'Ref': {
      return field.name === 'name' ? (parent as { name: string }).name : null;
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      return null;
    }
    case '__Type': {
      const type = parent as { name: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return ENUM_VALUES[type.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[type.name] ?? [];
        return names.map((name) => nested({ __typename: '__Field', name }, '__Field'));
      }
      if (field.name === 'enumValues') {
        const values = ENUM_VALUES[type.name];
        if (values === undefined) return null;
        return values.map((name) => nested({ __typename: '__EnumValue', name }, '__EnumValue'));
      }
      return null;
    }
    case '__Field':
      return field.name === 'name' ? (parent as { name: string }).name : null;
    case '__EnumValue':
      return field.name === 'name' ? (parent as { name: string }).name : null;
    default:
      return null;
  }
}

/** Run one operation document against the store. */
function executeOperation(store: Store, document: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: Array<{ message: string }> } {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(tokenize(document)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((entry) => entry.name === operationName);
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation to execute.' }] };
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variables[variable.name] !== undefined) mergedVariables[variable.name] = variables[variable.name];
    else if (variable.defaultValue !== undefined) mergedVariables[variable.name] = resolveValue(variable.defaultValue, variables);
    else mergedVariables[variable.name] = null;
  }
  const ex: Executor = { store, variables: mergedVariables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Node = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  validateSelection(ex, rootType, operation.selection);
  if (ex.errors.length > 0) return { data: null, errors: ex.errors };
  const data = executeSelection(ex, rootType, root, operation.selection);
  if (ex.errors.length > 0) return { data, errors: ex.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/** POST /api/graphql: one operation, or a JSON array of operations (batching). */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: Ctx, method: string): Promise<void> {
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }
  if (!ctx.authed) {
    sendError(res, 401, 'Requires authentication', ctx);
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    sendError(res, 413, 'request body too large', ctx);
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON', ctx);
    return;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Each operation needs a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'Each operation needs a query string.' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    return executeOperation(ctx.store, record.query, variables, typeof record.operationName === 'string' ? record.operationName : undefined);
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne), ctx);
    return;
  }
  sendJson(res, 200, runOne(parsed.value), ctx);
}
