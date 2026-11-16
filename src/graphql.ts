// GraphQL v4: a hand-written parser and executor for the shapes the suite needs —
// viewer, repository, node, __type, issues/pullRequests connections with cursors,
// and the five mutations (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment). Unknown fields surface as GraphQL errors;
// a missing repository answers data.repository = null with no errors.

import { b64decode, b64encode, isoOf, trialNowSec } from './util.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// schema description (used by __type and by field validation)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  RepositoryDefaultBranchRef: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'url', 'author'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  User: ['login', 'id', 'name', 'email'],
  Node: ['id'],
  IssueComment: ['id', 'body', 'createdAt'],
  AddCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields'],
  __Field: ['name', 'description', 'type'],
  __InputValue: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const TYPE_KIND: Record<string, 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'SCALAR'> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Viewer: 'OBJECT',
  Repository: 'OBJECT',
  RepositoryDefaultBranchRef: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  User: 'OBJECT',
  Node: 'INTERFACE',
  IssueComment: 'OBJECT',
  AddCommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __InputValue: 'OBJECT',
  __EnumValue: 'OBJECT',
  __Schema: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  RepositoryPermission: 'ENUM',
  RepositoryVisibility: 'ENUM',
  String: 'SCALAR',
  Int: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
  DateTime: 'SCALAR',
  CreateIssueInput: 'INPUT_OBJECT',
  CloseIssueInput: 'INPUT_OBJECT',
  CreatePullRequestInput: 'INPUT_OBJECT',
  MergePullRequestInput: 'INPUT_OBJECT',
  AddCommentInput: 'INPUT_OBJECT',
  IssueOrder: 'INPUT_OBJECT',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
};

const INPUT_FIELDS: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'variable'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (j < source.length && source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@=$&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: GqlValue[] }
  | { kind: 'object'; value: Record<string, GqlValue> }
  | { kind: 'variable'; value: string };

interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
  typeCondition?: string;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, GqlValue | undefined>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
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
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const document: Document = { operations: [], fragments: new Map() };
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        document.operations.push({ type: 'query', name: null, varDefs: new Map(), selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        document.operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        document.fragments.set(name, { typeCondition, selections });
      } else {
        throw new Error(`unexpected token ${token.kind} ${token.value} in GraphQL document`);
      }
    }
    return document;
  }

  private parseOperation(): Operation {
    const type = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name') {
      name = this.next().value;
    }
    const varDefs = new Map<string, GqlValue | undefined>();
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const variable = this.next();
        if (variable.kind !== 'variable') throw new Error('expected a variable in variable definitions');
        this.expectPunct(':');
        // The type name (with possible [ ] and ! wrappers) is skipped; defaults are kept.
        let depth = 0;
        let defaultValue: GqlValue | undefined;
        for (;;) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '=') {
            defaultValue = this.parseValue();
            break;
          }
          if (tok.kind === 'punct' && tok.value === '[') depth += 1;
          if (tok.kind === 'punct' && tok.value === ']') depth -= 1;
          if (tok.kind === 'punct' && (tok.value === ')' || tok.value === ',') && depth === 0) {
            this.pos -= 1;
            break;
          }
          if (tok.kind === 'punct' && tok.value === ',' && depth === 0) break;
        }
        varDefs.set(variable.value, defaultValue);
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ',') this.next();
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', name: '', args: {}, selections: this.parseSelectionSet(), typeCondition };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        return { kind: 'fragment', name, args: {}, selections: [] };
      }
      throw new Error('expected a fragment name or "on"');
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ',') this.next();
      }
    }
    // Directives are parsed and ignored.
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    let selections: Selection[] = [];
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'variable') return { kind: 'variable', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.acceptPunct(']')) {
        values.push(this.parseValue());
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ',') this.next();
      }
      return { kind: 'list', value: values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ',') this.next();
      }
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${token.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

/** A resolved object: its concrete GraphQL type plus the underlying store value. */
interface Node {
  type: string;
  value: unknown;
}

interface ExecContext {
  forge: Forge;
  document: Document;
  variables: Record<string, unknown>;
}

class GraphQLError extends Error {}

function node(type: string, value: unknown): Node {
  return { type, value };
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      return variables[value.value] ?? null;
    }
    case 'list':
      return value.value.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.value)) out[key] = resolveValue(item, variables);
      return out;
    }
    default:
      return value.value;
  }
}

function encodeCursor(kind: string, number: number): string {
  return b64encode(Buffer.from(`${kind}:${number}`, 'utf8'));
}

function decodeCursor(cursor: string): { kind: string; number: number } | null {
  try {
    const text = b64decode(cursor).toString('utf8');
    const match = /^([a-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1]!, number: Number(match[2]) };
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { cursor: string }>(edges: T[], hasNext: boolean): Node {
  return node('PageInfo', {
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: edges.length > 0 ? edges[0]!.cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
  });
}

/**
 * Slice a list into a connection. `ordered` is already in final order; `after`
 * is a cursor produced by encodeCursor for one of its items.
 */
function makeConnection<T>(
  ctx: ExecContext,
  ordered: T[],
  args: Record<string, unknown>,
  itemType: string,
  edgeType: string,
  connectionType: string,
  cursorOf: (item: T) => string,
  toNode: (item: T) => Node,
): Node {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      const index = ordered.findIndex((item) => cursorOf(item) === after);
      if (index >= 0) start = index + 1;
    }
  }
  const window = first === null ? ordered.slice(start) : ordered.slice(start, start + first);
  const hasNext = start + window.length < ordered.length;
  const edges = window.map((item) => node(edgeType, { item, cursor: cursorOf(item), itemType, toNode }));
  return node(connectionType, { edges, pageInfo: pageInfoFor(edges.map((edge) => (edge.value as { cursor: string })), hasNext), totalCount: ordered.length });
}

/** The issue state as GraphQL sees it (OPEN/CLOSED) and the store's (open/closed). */
function stateGql(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueNode(repo: Repo, issue: Issue): Node {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: PullRequest): Node {
  return node('PullRequest', { repo, pull });
}

function repoNode(repo: Repo): Node {
  return node('Repository', repo);
}

function viewerNode(): Node {
  return node('Viewer', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL });
}

function userNode(login: string, id: number): Node {
  return node('User', { login, id, name: login, email: `${login}@example.invalid` });
}

// ---------------------------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------------------------

function resolveField(ctx: ExecContext, typeName: string, parent: unknown, field: Selection): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, ctx.variables);

  if (field.name === '__typename') return typeName;

  const valid = TYPE_FIELDS[typeName];
  if (valid === undefined || !valid.includes(field.name)) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
  }

  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, field, args);
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'Viewer': {
      const viewer = parent as { login: string; id: number; name: string; email: string };
      if (field.name === 'login') return viewer.login;
      if (field.name === 'id') return viewer.id;
      if (field.name === 'name') return viewer.name;
      if (field.name === 'email') return viewer.email;
      break;
    }
    case 'User': {
      const user = parent as { login: string; id: number; name: string; email: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.id;
      if (field.name === 'name') return user.name;
      if (field.name === 'email') return user.email;
      break;
    }
    case 'Repository':
      return resolveRepository(ctx, parent as Repo, field, args);
    case 'RepositoryDefaultBranchRef': {
      const ref = parent as { name: string; sha: string };
      if (field.name === 'name') return ref.name;
      break;
    }
    case 'Issue':
      return resolveIssue(ctx, parent as { repo: Repo; issue: Issue }, field, args);
    case 'PullRequest':
      return resolvePullRequest(ctx, parent as { repo: Repo; pull: PullRequest }, field, args);
    case 'PullRequestChangedFile': {
      // The store's pullFiles rows name the file `filename`; GraphQL calls it `path`.
      const file = parent as { filename: string; additions: number; deletions: number; changes: number };
      if (field.name === 'path') return file.filename;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changes') return file.changes;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = parent as { edges: Node[]; pageInfo: Node; totalCount: number };
      if (field.name === 'nodes') return connection.edges.map((edge) => (edge.value as { toNode: (item: unknown) => Node }).toNode((edge.value as { item: unknown }).item));
      if (field.name === 'edges') return connection.edges;
      if (field.name === 'pageInfo') return connection.pageInfo;
      if (field.name === 'totalCount') return connection.totalCount;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge': {
      const edge = parent as { item: unknown; cursor: string; itemType: string; toNode: (item: unknown) => Node };
      if (field.name === 'node') return edge.toNode(edge.item);
      if (field.name === 'cursor') return edge.cursor;
      break;
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage;
      if (field.name === 'startCursor') return info.startCursor;
      if (field.name === 'endCursor') return info.endCursor;
      break;
    }
    case 'IssueComment': {
      const subject = parent as { repo: Repo; issue: Issue; comment: IssueComment };
      if (field.name === 'id') return ctx.forge.commentGlobalId(subject.repo, subject.issue, subject.comment);
      if (field.name === 'body') return subject.comment.body;
      if (field.name === 'createdAt') return isoOf(trialNowSec() + subject.comment.id);
      break;
    }
    case 'AddCommentEdge': {
      const edge = parent as { node: Node; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = parent as { issue: Node; clientMutationId: string | null };
      if (field.name === 'issue') return payload.issue;
      if (field.name === 'clientMutationId') return payload.clientMutationId;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = parent as { pullRequest: Node; clientMutationId: string | null };
      if (field.name === 'pullRequest') return payload.pullRequest;
      if (field.name === 'clientMutationId') return payload.clientMutationId;
      break;
    }
    case 'AddCommentPayload': {
      const payload = parent as { commentEdge: Node; clientMutationId: string | null };
      if (field.name === 'commentEdge') return payload.commentEdge;
      if (field.name === 'clientMutationId') return payload.clientMutationId;
      break;
    }
    case '__Type': {
      const type = parent as { name: string; kind: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const fields = TYPE_FIELDS[type.name];
        if (fields === undefined) return null;
        return fields.map((name) => node('__Field', { name, description: null }));
      }
      if (field.name === 'enumValues') {
        const values = ENUM_VALUES[type.name];
        if (values === undefined) return null;
        return values.map((name) => node('__EnumValue', { name, description: null }));
      }
      if (field.name === 'inputFields') {
        const fields = INPUT_FIELDS[type.name];
        if (fields === undefined) return null;
        return fields.map((name) => node('__InputValue', { name, description: null }));
      }
      break;
    }
    case '__Field':
    case '__InputValue': {
      const value = parent as { name: string; description: string | null };
      if (field.name === 'name') return value.name;
      if (field.name === 'description') return value.description;
      if (field.name === 'type') return node('__Type', { name: 'String', kind: 'SCALAR' });
      break;
    }
    case '__EnumValue': {
      const value = parent as { name: string; description: string | null };
      if (field.name === 'name') return value.name;
      if (field.name === 'description') return value.description;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return node('__Type', { name: 'Query', kind: 'OBJECT' });
      if (field.name === 'mutationType') return node('__Type', { name: 'Mutation', kind: 'OBJECT' });
      if (field.name === 'types') {
        return Object.keys(TYPE_KIND).map((name) => node('__Type', { name, kind: TYPE_KIND[name]! }));
      }
      break;
    }
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

function resolveQuery(ctx: ExecContext, field: Selection, args: Record<string, unknown>): unknown {
  if (field.name === 'viewer') return viewerNode();
  if (field.name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) return null;
    return repoNode(repo);
  }
  if (field.name === 'node') {
    const id = typeof args.id === 'string' ? args.id : '';
    const decoded = ctx.forge.decodeGlobalId(id);
    if (decoded === null) return null;
    const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    if (decoded.kind === 'repo') return repoNode(repo);
    if (decoded.kind === 'issue') {
      const issue = ctx.forge.getIssue(repo, decoded.number);
      if (issue === undefined) return null;
      return issueNode(repo, issue);
    }
    if (decoded.kind === 'pr') {
      const pull = ctx.forge.getPull(repo, decoded.number);
      if (pull === undefined) return null;
      return pullNode(repo, pull);
    }
    if (decoded.kind === 'comment') {
      const issue = ctx.forge.getIssue(repo, decoded.number);
      if (issue === undefined) return null;
      const comment = issue.comments.find((item) => item.id === decoded.commentId);
      if (comment === undefined) return null;
      return node('IssueComment', { repo, issue, comment });
    }
    return null;
  }
  if (field.name === '__type') {
    const name = typeof args.name === 'string' ? args.name : '';
    const kind = TYPE_KIND[name];
    if (kind === undefined) return null;
    return node('__Type', { name, kind });
  }
  if (field.name === '__schema') return node('__Schema', {});
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
}

function resolveRepository(ctx: ExecContext, repo: Repo, field: Selection, args: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return ctx.forge.repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userNode(repo.owner, VIEWER_ID);
    case 'defaultBranchRef': {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (sha === undefined) return null;
      return node('RepositoryDefaultBranchRef', { name: repo.defaultBranch, sha });
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = ctx.forge.getIssue(repo, number);
      if (issue === undefined) return null;
      return issueNode(repo, issue);
    }
    case 'issues': {
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? undefined;
      if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
      } else if (orderBy !== undefined && orderBy.direction === 'DESC') {
        list.sort((a, b) => b.number - a.number);
      } else {
        list.sort((a, b) => a.number - b.number);
      }
      return makeConnection(ctx, list, args, 'Issue', 'IssueEdge', 'IssueConnection', (issue) => encodeCursor('issue', issue.number), (issue) => issueNode(repo, issue));
    }
    case 'pullRequests': {
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((pull) => wanted.has(pull.state));
      }
      list.sort((a, b) => a.number - b.number);
      return makeConnection(ctx, list, args, 'PullRequest', 'PullRequestEdge', 'PullRequestConnection', (pull) => encodeCursor('pr', pull.number), (pull) => pullNode(repo, pull));
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = ctx.forge.getPull(repo, number);
      if (pull === undefined) return null;
      return pullNode(repo, pull);
    }
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`);
}

function resolveIssue(ctx: ExecContext, parent: { repo: Repo; issue: Issue }, field: Selection, _args: Record<string, unknown>): unknown {
  const { repo, issue } = parent;
  switch (field.name) {
    case 'id':
      return ctx.forge.issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return stateGql(issue.state);
    case 'body':
      return issue.body;
    case 'createdAt':
      return isoOf(trialNowSec() + issue.seq);
    case 'url':
      return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'author':
      return userNode(repo.owner, VIEWER_ID);
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Issue".`);
}

function resolvePullRequest(ctx: ExecContext, parent: { repo: Repo; pull: PullRequest }, field: Selection, args: Record<string, unknown>): unknown {
  const { repo, pull } = parent;
  switch (field.name) {
    case 'id':
      return ctx.forge.pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : stateGql(pull.state);
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      if (pull.state === 'closed') return 'UNKNOWN';
      return ctx.forge.isConflicting(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'files': {
      const files = ctx.forge.pullFiles(repo, pull);
      return makeConnection(ctx, files, args, 'PullRequestChangedFile', 'PullRequestChangedFileEdge', 'PullRequestChangedFileConnection', (file) => encodeCursor('file', files.indexOf(file) + 1), (file) => node('PullRequestChangedFile', file));
    }
    case 'createdAt':
      return isoOf(trialNowSec() + pull.seq);
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequest".`);
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function clientMutationId(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function resolveMutation(ctx: ExecContext, field: Selection, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = ctx.forge.decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'repo') throw new GraphQLError('Could not resolve to a Repository with the id of "' + repositoryId + '".');
      const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id of "' + repositoryId + '".');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const created = ctx.forge.createIssue(repo, title, body, []);
      if ('error' in created) throw new GraphQLError(created.error);
      return node('CreateIssuePayload', { issue: issueNode(repo, created), clientMutationId: clientMutationId(input) });
    }
    case 'closeIssue': {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = ctx.forge.decodeGlobalId(issueId);
      if (decoded === null || decoded.kind !== 'issue') throw new GraphQLError('Could not resolve to an Issue with the id of "' + issueId + '".');
      const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
      const issue = repo === undefined ? undefined : ctx.forge.getIssue(repo, decoded.number);
      if (repo === undefined || issue === undefined) throw new GraphQLError('Could not resolve to an Issue with the id of "' + issueId + '".');
      issue.state = 'closed';
      return node('CloseIssuePayload', { issue: issueNode(repo, issue), clientMutationId: clientMutationId(input) });
    }
    case 'createPullRequest': {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = ctx.forge.decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'repo') throw new GraphQLError('Could not resolve to a Repository with the id of "' + repositoryId + '".');
      const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id of "' + repositoryId + '".');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const created = ctx.forge.createPull(repo, title, body, head, base);
      if ('error' in created) throw new GraphQLError(created.error);
      return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, created), clientMutationId: clientMutationId(input) });
    }
    case 'mergePullRequest': {
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = ctx.forge.decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.kind !== 'pr') throw new GraphQLError('Could not resolve to a PullRequest with the id of "' + pullRequestId + '".');
      const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
      const pull = repo === undefined ? undefined : ctx.forge.getPull(repo, decoded.number);
      if (repo === undefined || pull === undefined) throw new GraphQLError('Could not resolve to a PullRequest with the id of "' + pullRequestId + '".');
      const merged = ctx.forge.squashMerge(repo, pull);
      if ('error' in merged) throw new GraphQLError(merged.error);
      return node('MergePullRequestPayload', { pullRequest: pullNode(repo, pull), clientMutationId: clientMutationId(input) });
    }
    case 'addComment': {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const decoded = ctx.forge.decodeGlobalId(subjectId);
      if (decoded === null) throw new GraphQLError('Could not resolve to a subject with the id of "' + subjectId + '".');
      const repo = ctx.forge.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new GraphQLError('Could not resolve to a subject with the id of "' + subjectId + '".');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = decoded.kind === 'issue' || decoded.kind === 'pr' ? ctx.forge.getIssue(repo, decoded.number) : undefined;
      if (issue === undefined) throw new GraphQLError('Could not resolve to a subject with the id of "' + subjectId + '".');
      const comment = ctx.forge.addComment(repo, issue, body);
      const commentNodeValue = node('IssueComment', { repo, issue, comment });
      return node('AddCommentPayload', {
        commentEdge: node('AddCommentEdge', { node: commentNodeValue, cursor: encodeCursor('comment', comment.id) }),
        clientMutationId: clientMutationId(input),
      });
    }
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
}

// ---------------------------------------------------------------------------------------------
// execution driver
// ---------------------------------------------------------------------------------------------

function executeSelections(ctx: ExecContext, typeName: string, parent: unknown, selections: Selection[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName && selection.typeCondition !== 'Node') continue;
      if (selection.name !== '') {
        const fragment = ctx.document.fragments.get(selection.name);
        if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}".`);
        if (fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') continue;
        executeSelections(ctx, typeName, parent, fragment.selections, out);
      } else {
        executeSelections(ctx, typeName, parent, selection.selections, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, typeName, parent, selection);
    out[key] = completeValue(ctx, value, selection);
  }
}

function completeValue(ctx: ExecContext, value: unknown, field: Selection): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object' && 'type' in (value as Record<string, unknown>) && 'value' in (value as Record<string, unknown>)) {
    const nodeValue = value as Node;
    if (field.selections.length === 0) return nodeValue.value;
    const out: Record<string, unknown> = {};
    executeSelections(ctx, nodeValue.type, nodeValue.value, field.selections, out);
    return out;
  }
  return value;
}

function executeOperation(ctx: ExecContext, operation: Operation): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  try {
    executeSelections(ctx, rootType, null, operation.selections, out);
    return { data: out };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/**
 * Execute one operation document (or a batch of them) and return the GraphQL
 * result object(s). Throws on a document that cannot even be parsed.
 */
export function executeGraphql(forge: Forge, requests: GraphqlRequest[]): Array<{ data: Record<string, unknown> | null; errors?: { message: string }[] }> {
  return requests.map((request) => {
    let document: Document;
    try {
      document = new Parser(tokenize(request.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
    }
    const variables: Record<string, unknown> = request.variables ?? {};
    let operation = document.operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'no operation found in document' }] };
    if (request.operationName !== undefined) {
      const named = document.operations.find((item) => item.name === request.operationName);
      if (named !== undefined) operation = named;
    }
    // Apply variable defaults.
    for (const [name, defaultValue] of operation.varDefs) {
      if (!(name in variables) && defaultValue !== undefined) variables[name] = resolveValue(defaultValue, variables);
    }
    const ctx: ExecContext = { forge, document, variables };
    return executeOperation(ctx, operation);
  });
}
