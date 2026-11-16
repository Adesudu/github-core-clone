// The forge's store: every repository, ref, issue, pull request, label and comment,
// all in memory. One user (the token owner); any other owner is a 404, never a 403.

import {
  buildCommit,
  buildTree,
  collectReachable,
  fetchPlan,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelTag,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { HEX40, ZERO_OID, b64encode, b64url, hashObject, isoOf, trialNowSec } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidRepoName(name: string): boolean {
  return NAME_RE.test(name) && !name.endsWith('.git');
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

const DEFAULT_LABELS: Array<[string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface CommitResult {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private clockSeq = 0;

  /** Deterministic "now": the trial's now plus one second per call, in call order. */
  nowSec(): number {
    const sec = trialNowSec() + this.clockSeq;
    this.clockSeq += 1;
    return sec;
  }

  nowIso(): string {
    return isoOf(this.nowSec());
  }

  private newId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.newId(),
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repos.size,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(DEFAULT_LABELS.map(([labelName, color]) => [labelName, { name: labelName, color, description: '' }])),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(`${VIEWER_LOGIN}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------------------------
  // objects and refs
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All refs sorted by name, HEAD's target first when present. */
  sortedRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Store a pack's objects; returns the parsed objects. */
  storePack(repo: Repo, pack: Buffer): Map<string, GitObject> {
    const read = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    return read.objects;
  }

  /** The commit a tag peels to (or the oid itself when it is not a tag). */
  peel(repo: Repo, oid: string): string {
    return peelTag(repo.objects, oid);
  }

  // -------------------------------------------------------------------------------------------
  // trees (flattened path -> entry)
  // -------------------------------------------------------------------------------------------

  /** Flatten a tree object to path -> {mode, oid}, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
      }
    }
    return out;
  }

  /** Build (and store) a tree object from a flattened path map. */
  buildTreeFromMap(repo: Repo, flat: Map<string, TreeEntry>): string {
    interface Node {
      files: TreeEntry[];
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: [], dirs: new Map() });
    const root = make();
    for (const entry of flat.values()) {
      const segments = entry.name.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index]!;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment)!;
      }
      node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid at a ref, or null when the ref is unborn. */
  treeOfRef(repo: Repo, ref: string): string | null {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** List a directory's immediate children at a ref: {type, name, path, sha}. */
  listDirectory(repo: Repo, ref: string, dir: string): Array<{ type: string; name: string; path: string; sha: string }> | null {
    const treeOid = this.treeOfRef(repo, ref);
    if (treeOid === null) return null;
    let current = treeOid;
    if (dir !== '') {
      for (const segment of dir.split('/')) {
        const object = repo.objects.get(current);
        if (object === undefined || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: dir === '' ? entry.name : `${dir}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // contents commits
  // -------------------------------------------------------------------------------------------

  /**
   * Commit one file on `branch` (creating the branch from the default tip when it does not
   * exist yet, and the repository's first commit when there is no tip at all).
   * `sha` is the blob sha the caller expects to replace; a mismatch is a 409.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): CommitResult | { error: 'stale-sha' } {
    const ref = `refs/heads/${branch}`;
    let baseTip = repo.refs.get(ref);
    let baseTree: string | null = null;
    if (baseTip !== undefined) {
      baseTree = this.treeOfRef(repo, ref);
    } else if (branch !== repo.defaultBranch) {
      // A new branch starts at the default branch's tip.
      baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (baseTip !== undefined) baseTree = this.treeOfRef(repo, `refs/heads/${repo.defaultBranch}`);
    }
    const flat = baseTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTree);
    const existing = flat.get(path);
    if (expectedSha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
        return { error: 'stale-sha' };
      }
    }
    const created = existing === undefined;
    const blobSha = this.putObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', name: path, oid: blobSha });
    const treeOid = this.buildTreeFromMap(repo, flat);
    const timestamp = this.nowSec();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree: treeOid,
      parents: baseTip === undefined ? [] : [baseTip],
      message,
      author: identity,
      committer: identity,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  /** Remove one file on `branch` and commit. */
  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): CommitResult | { error: 'stale-sha' | 'not-found' } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { error: 'not-found' };
    const treeOid = this.treeOfRef(repo, ref);
    if (treeOid === null) return { error: 'not-found' };
    const flat = this.flattenTree(repo, treeOid);
    const existing = flat.get(path);
    if (existing === undefined) return { error: 'not-found' };
    if (expectedSha !== undefined && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return { error: 'stale-sha' };
    }
    flat.delete(path);
    const tree = this.buildTreeFromMap(repo, flat);
    const timestamp = this.nowSec();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree,
      parents: [tip],
      message,
      author: identity,
      committer: identity,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha: existing.oid, created: false };
  }

  // -------------------------------------------------------------------------------------------
  // commits listing
  // -------------------------------------------------------------------------------------------

  /** Commits reachable from `ref`, newest first. */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const timestamp = parseIdentTimestamp(commit.author) ?? parseIdentTimestamp(commit.committer) ?? 0;
      out.push({
        sha: oid,
        message: commit.message.replace(/\n$/, ''),
        author: commit.author,
        committer: commit.committer,
        timestamp,
      });
      for (const parent of commit.parents) queue.push(parent);
    }
    // BFS from the tip is newest-first for the linear histories the suite builds.
    return out;
  }

  /** The merge-base of two commits (the newest common ancestor), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsB = new Set<string>();
    const queueB = [b];
    while (queueB.length > 0) {
      const oid = queueB.pop()!;
      if (ancestorsB.has(oid)) continue;
      ancestorsB.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    const queueA = [a];
    const seenA = new Set<string>();
    while (queueA.length > 0) {
      const oid = queueA.shift()!;
      if (seenA.has(oid)) continue;
      seenA.add(oid);
      if (ancestorsB.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // issues
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: 'bad-label'; label: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: 'bad-label', label };
    }
    const issue: Issue = {
      number: repo.nextIssue,
      id: this.newId(),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.issues.length,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    let list = repo.issues;
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    return direction === 'desc' ? sorted.reverse() : sorted;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextComment, body };
    repo.nextComment += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return { error: `head branch ${head} does not exist` };
    if (baseSha === undefined) return { error: `base branch ${base} does not exist` };
    const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
    if (existing !== undefined) return { error: 'a pull request is already open for this head' };
    const pull: PullRequest = {
      number: repo.nextPull,
      id: this.newId(),
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.pulls.length,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string): PullRequest[] {
    let list = repo.pulls;
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    return [...list].sort((a, b) => a.seq - b.seq);
  }

  /** The files a pull request changes (base tip tree vs head tip tree). */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTree = this.treeOfRef(repo, `refs/heads/${pull.baseRef}`);
    const headTree = this.treeOfRef(repo, `refs/heads/${pull.headRef}`);
    const baseFlat = baseTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTree);
    const headFlat = headTree === null ? new Map<string, TreeEntry>() : this.flattenTree(repo, headTree);
    // Use the tips recorded at creation when the branches have since moved (a merged PR's
    // base ref now points at the merge commit); the files are those of the pull itself.
    const baseAtCreate = this.flatAtCommit(repo, pull.baseSha);
    const headAtCreate = this.flatAtCommit(repo, pull.headSha);
    const baseMap = baseAtCreate ?? baseFlat;
    const headMap = headAtCreate ?? headFlat;
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const baseEntry = baseMap.get(path);
      const headEntry = headMap.get(path);
      if (baseEntry === undefined && headEntry !== undefined) {
        const lines = countLines(this.blobText(repo, headEntry.oid));
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (baseEntry !== undefined && headEntry === undefined) {
        const lines = countLines(this.blobText(repo, baseEntry.oid));
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid !== headEntry.oid) {
        const { added, removed } = lineDiff(this.blobText(repo, baseEntry.oid), this.blobText(repo, headEntry.oid));
        files.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed });
      }
    }
    return files;
  }

  /** Flatten the tree of a commit oid (or null when it is not a commit). */
  flatAtCommit(repo: Repo, commitOid: string): Map<string, TreeEntry> | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /**
   * Whether a pull request's head conflicts with its base (three-way). The base side is the
   * CURRENT base branch tip, not the tip recorded at creation: after another pull request
   * merges, a second pull request touching the same file conflicts with the new tip.
   */
  isConflicting(repo: Repo, pull: PullRequest): boolean {
    const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, pull.headSha, currentBaseTip);
    if (base === null) return false;
    const baseFlat = this.flatAtCommit(repo, base) ?? new Map<string, TreeEntry>();
    const headFlat = this.flatAtCommit(repo, pull.headSha) ?? new Map<string, TreeEntry>();
    const tipFlat = this.flatAtCommit(repo, currentBaseTip) ?? new Map<string, TreeEntry>();
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const atBase = baseFlat.get(path)?.oid;
      const atHead = headFlat.get(path)?.oid;
      const atTip = tipFlat.get(path)?.oid;
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. */
  squashMerge(repo: Repo, pull: PullRequest): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (this.isConflicting(repo, pull)) return { error: 'merge conflict' };
    const headObject = repo.objects.get(pull.headSha);
    if (headObject === undefined || headObject.type !== 'commit') return { error: 'head commit not found' };
    const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    // Three-way merged tree: the current base tip's tree with the head's changes (relative to
    // the merge-base) applied. When the base has not moved this is exactly the head's tree.
    let tree = parseCommit(headObject.data).tree;
    const base = this.mergeBase(repo, pull.headSha, currentBaseTip);
    if (base !== null) {
      const baseFlat = this.flatAtCommit(repo, base) ?? new Map<string, TreeEntry>();
      const headFlat = this.flatAtCommit(repo, pull.headSha) ?? new Map<string, TreeEntry>();
      const tipFlat = this.flatAtCommit(repo, currentBaseTip) ?? new Map<string, TreeEntry>();
      const merged = new Map<string, TreeEntry>(tipFlat);
      for (const [path, headEntry] of headFlat) {
        if (baseFlat.get(path)?.oid !== headEntry.oid) merged.set(path, headEntry);
      }
      for (const path of baseFlat.keys()) {
        if (!headFlat.has(path)) merged.delete(path);
      }
      tree = this.buildTreeFromMap(repo, merged);
    }
    const timestamp = this.nowSec();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree,
      parents: [currentBaseTip],
      message: pull.title,
      author: identity,
      committer: identity,
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = isoOf(timestamp);
    pull.merge_commit_sha = sha;
    return { sha };
  }

  // -------------------------------------------------------------------------------------------
  // global ids (opaque, stable)
  // -------------------------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return b64url(`repo:${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64url(`issue:${repo.owner}/${repo.name}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return b64url(`pr:${repo.owner}/${repo.name}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return b64url(`comment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
  }

  /** Decode a global id back to its kind and parts, or null. */
  decodeGlobalId(id: string): { kind: string; owner: string; repo: string; number: number; commentId: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const repoMatch = /^repo:([^/]+)\/(.+)$/.exec(text);
      if (repoMatch) return { kind: 'repo', owner: repoMatch[1]!, repo: repoMatch[2]!, number: 0, commentId: 0 };
      const issueMatch = /^issue:([^/]+)\/(.+):(\d+)$/.exec(text);
      if (issueMatch) return { kind: 'issue', owner: issueMatch[1]!, repo: issueMatch[2]!, number: Number(issueMatch[3]), commentId: 0 };
      const prMatch = /^pr:([^/]+)\/(.+):(\d+)$/.exec(text);
      if (prMatch) return { kind: 'pr', owner: prMatch[1]!, repo: prMatch[2]!, number: Number(prMatch[3]), commentId: 0 };
      const commentMatch = /^comment:([^/]+)\/(.+):(\d+):(\d+)$/.exec(text);
      if (commentMatch) {
        return { kind: 'comment', owner: commentMatch[1]!, repo: commentMatch[2]!, number: Number(commentMatch[3]), commentId: Number(commentMatch[4]) };
      }
      return null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // REST views
  // -------------------------------------------------------------------------------------------

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: this.repoGlobalId(repo),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
      created_at: isoOf(trialNowSec()),
      updated_at: isoOf(trialNowSec()),
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: this.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => this.labelJson(repo, name)),
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      comments: issue.comments.length,
      created_at: isoOf(trialNowSec()),
      updated_at: isoOf(trialNowSec()),
    };
  }

  labelJson(repo: Repo, name: string): Record<string, unknown> {
    const label = repo.labels.get(name);
    return {
      id: this.newIdForLabel(repo, name),
      name,
      color: label?.color ?? 'ededed',
      description: label?.description ?? '',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    };
  }

  private labelIds = new Map<string, number>();
  private newIdForLabel(repo: Repo, name: string): number {
    const key = `${repo.owner}/${repo.name}/${name}`;
    let id = this.labelIds.get(key);
    if (id === undefined) {
      id = this.newId();
      this.labelIds.set(key, id);
    }
    return id;
  }

  commentJson(comment: IssueComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: isoOf(trialNowSec()),
      updated_at: isoOf(trialNowSec()),
    };
  }

  pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: this.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      mergeable: this.isConflicting(repo, pull) ? false : true,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER_ID } },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER_ID } },
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      created_at: isoOf(trialNowSec()),
      updated_at: isoOf(trialNowSec()),
    };
  }

  /** A fetch plan for the git surface (thin wrapper over gitcore). */
  planFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallow: readonly string[],
    depth: number | null,
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    return fetchPlan(wants, haves, shallow, depth, this.lookup(repo));
  }

  /** Write a pack of the given objects. */
  buildPack(objects: readonly GitObject[]): Buffer {
    return writePack(objects);
  }
}

/** The timestamp at the end of a `Name <email> <ts> +0000` ident, or null. */
function parseIdentTimestamp(ident: string): number | null {
  const match = / (\d+) \+0000$/.exec(ident);
  return match ? Number(match[1]) : null;
}

/** Lines in a text (a trailing newline does not add a line). */
function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Added/removed line counts between two texts (multiset line difference). */
function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldCounts = count(oldText);
  const newCounts = count(newText);
  let added = 0;
  let removed = 0;
  for (const [line, n] of newCounts) {
    const inOld = oldCounts.get(line) ?? 0;
    if (n > inOld) added += n - inOld;
  }
  for (const [line, n] of oldCounts) {
    const inNew = newCounts.get(line) ?? 0;
    if (n > inNew) removed += n - inNew;
  }
  return { added, removed };
}

export { ZERO_OID, HEX40 };
