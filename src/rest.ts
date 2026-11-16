// REST v3: repositories, branches, commits, contents, labels, issues, comments,
// pull requests, files and merges. Every reply is JSON with a message on errors.

import { b64decode, b64encode, isoOf } from './util.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isValidRepoName,
  type Forge,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  bodyParseError: boolean;
  host: string;
}

export interface RestResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(json: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, json, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; total: number; pages: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), total, pages };
}

/** The Link pagination header for a list, with absolute same-origin URLs. */
function linkHeader(host: string, basePath: string, query: URLSearchParams, page: number, pages: number, perPage: number): string {
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<http://${host}${basePath}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < pages) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  parts.push(`${urlFor(1)}; rel="first"`);
  parts.push(`${urlFor(pages)}; rel="last"`);
  return parts.join(', ');
}

export function handleRest(forge: Forge, req: RestRequest): RestResponse {
  if (req.bodyParseError) return err(400, 'malformed JSON body');
  const segments = req.path.split('/').filter((segment) => segment !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return err(404, 'Not Found');
  const rest = segments.slice(2);
  const method = req.method;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  // /api/v3/user...
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'POST') return createRepo(forge, req);
      if (method === 'GET') return listUserRepos(forge, req);
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1]!);
    const name = decodeSegment(rest[2]!);
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) return err(404, 'Not Found');
    const tail = rest.slice(3);
    if (tail.length === 0) return repoRoot(forge, repo, req);
    if (tail[0] === 'branches') return branches(forge, repo, tail.slice(1), req);
    if (tail[0] === 'commits') return commits(forge, repo, req);
    if (tail[0] === 'git' && tail[1] === 'refs') return gitRefs(forge, repo, tail.slice(2), req);
    if (tail[0] === 'contents') return contents(forge, repo, tail.slice(1), req);
    if (tail[0] === 'labels') return labels(forge, repo, req);
    if (tail[0] === 'issues') return issues(forge, repo, tail.slice(1), req);
    if (tail[0] === 'pulls') return pulls(forge, repo, tail.slice(1), req);
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createRepo(forge: Forge, req: RestRequest): RestResponse {
  if (!isRecord(req.body)) return err(422, 'a repository name is required');
  const name = typeof req.body.name === 'string' ? req.body.name : '';
  if (name === '' || !isValidRepoName(name)) return err(422, 'a valid repository name is required');
  if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
  const repo = forge.createRepo(name, req.body.private === true, typeof req.body.description === 'string' ? req.body.description : '');
  return ok(forge.repoJson(repo), 201);
}

function listUserRepos(forge: Forge, req: RestRequest): RestResponse {
  const { page, perPage } = pageOf(req.query);
  const all = forge.listRepos();
  const { slice, pages } = paginate(all, page, perPage);
  const headers: Record<string, string> = {
    link: linkHeader(req.host, '/api/v3/user/repos', req.query, page, pages, perPage),
  };
  return ok(slice.map((repo) => forge.repoJson(repo)), 200, headers);
}

function repoRoot(forge: Forge, repo: Repo, req: RestRequest): RestResponse {
  if (req.method === 'GET') return ok(forge.repoJson(repo));
  if (req.method === 'PATCH') {
    if (!isRecord(req.body)) return err(422, 'a JSON body is required');
    if (typeof req.body.description === 'string') repo.description = req.body.description;
    if (typeof req.body.private === 'boolean') repo.private = req.body.private;
    return ok(forge.repoJson(repo));
  }
  if (req.method === 'DELETE') {
    forge.deleteRepo(repo.owner, repo.name);
    return { status: 204, json: null };
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// branches, commits, git refs
// ---------------------------------------------------------------------------------------------

function branches(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResponse {
  if (req.method !== 'GET') return err(404, 'Not Found');
  if (tail.length === 0) {
    const list = forge.sortedRefs(repo)
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    return ok(list);
  }
  const branch = decodeSegment(tail.join('/'));
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return err(404, 'Not Found');
  return ok({ name: branch, commit: { sha }, protected: false });
}

function commits(forge: Forge, repo: Repo, req: RestRequest): RestResponse {
  if (req.method !== 'GET') return err(404, 'Not Found');
  const shaParam = req.query.get('sha');
  const ref = shaParam !== null && shaParam !== '' ? `refs/heads/${shaParam}` : `refs/heads/${repo.defaultBranch}`;
  const list = forge.listCommits(repo, ref).map((commit) => ({
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: identJson(commit.author, commit.timestamp),
      committer: identJson(commit.committer, commit.timestamp),
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
  }));
  return ok(list);
}

function identJson(ident: string, timestamp: number): Record<string, unknown> {
  const match = /^(.+?) <([^>]+)> \d+ \+0000$/.exec(ident);
  return {
    name: match ? match[1] : VIEWER_NAME,
    email: match ? match[2] : VIEWER_EMAIL,
    date: isoOf(timestamp),
  };
}

function gitRefs(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResponse {
  if (req.method === 'POST' && tail.length === 0) {
    if (!isRecord(req.body)) return err(422, 'a JSON body is required');
    const ref = typeof req.body.ref === 'string' ? req.body.ref : '';
    const sha = typeof req.body.sha === 'string' ? req.body.sha : '';
    if (!/^refs\/(heads|tags)\/\S+$/.test(ref)) return err(422, 'ref must be refs/heads/<name> or refs/tags/<name>');
    if (!/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) return err(422, 'sha does not name an object in this repository');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return ok({ ref, object: { sha }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` }, 201);
  }
  if (req.method === 'GET' && tail.length >= 2 && tail[0] === 'heads') {
    const branch = decodeSegment(tail.slice(1).join('/'));
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ ref: `refs/heads/${branch}`, object: { sha }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}` });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contents(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResponse {
  const path = tail.map(decodeSegment).join('/');
  const refParam = req.query.get('ref');
  const branch = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;

  if (req.method === 'GET') {
    const treeOid = forge.treeOfRef(repo, `refs/heads/${branch}`);
    if (treeOid === null) return err(404, 'Not Found');
    const flat = forge.flattenTree(repo, treeOid);
    const entry = path === '' ? undefined : flat.get(path);
    if (path !== '' && entry === undefined) {
      // Maybe a directory.
      const listing = forge.listDirectory(repo, `refs/heads/${branch}`, path);
      if (listing === null) return err(404, 'Not Found');
      return ok(listing);
    }
    if (path === '') {
      const listing = forge.listDirectory(repo, `refs/heads/${branch}`, '');
      if (listing === null) return err(404, 'Not Found');
      return ok(listing);
    }
    const object = repo.objects.get(entry!.oid);
    if (object === undefined || object.type !== 'blob') return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: path.split('/').pop(),
      path,
      content: b64encode(object.data),
      sha: entry!.oid,
    });
  }

  if (req.method === 'PUT') {
    if (!isRecord(req.body)) return err(422, 'a JSON body is required');
    const message = typeof req.body.message === 'string' ? req.body.message : '';
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    if (message === '' || content === '') return err(422, 'message and content are required');
    let bytes: Buffer;
    try {
      bytes = b64decode(content);
    } catch {
      return err(422, 'content is not valid base64');
    }
    const putBranch = typeof req.body.branch === 'string' && req.body.branch !== '' ? req.body.branch : branch;
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = forge.commitFile(repo, putBranch, path, bytes, message, sha);
    if ('error' in result) return err(409, 'the sha does not match the current content');
    return ok(
      {
        content: {
          name: path.split('/').pop(),
          path,
          sha: result.blobSha,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
          content: b64encode(bytes),
        },
        commit: { sha: result.commitSha, message },
      },
      result.created ? 201 : 200,
    );
  }

  if (req.method === 'DELETE') {
    if (!isRecord(req.body)) return err(422, 'a JSON body is required');
    const message = typeof req.body.message === 'string' ? req.body.message : '';
    if (message === '') return err(422, 'message is required');
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = forge.deleteFile(repo, branch, path, message, sha);
    if ('error' in result) {
      if (result.error === 'not-found') return err(404, 'Not Found');
      return err(409, 'the sha does not match the current content');
    }
    return ok({ content: null, commit: { sha: result.commitSha, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function labels(forge: Forge, repo: Repo, req: RestRequest): RestResponse {
  if (req.method === 'GET') {
    return ok([...repo.labels.values()].map((label) => forge.labelJson(repo, label.name)));
  }
  if (req.method === 'POST') {
    if (!isRecord(req.body)) return err(422, 'a JSON body is required');
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    if (name === '') return err(422, 'a label name is required');
    const color = typeof req.body.color === 'string' ? req.body.color.replace(/^#/, '') : 'ededed';
    const description = typeof req.body.description === 'string' ? req.body.description : '';
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color, description });
    return ok(forge.labelJson(repo, name), 201);
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

function issues(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResponse {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const { page, perPage } = pageOf(req.query);
      const list = forge.listIssues(repo, state, direction);
      const { slice } = paginate(list, page, perPage);
      return ok(slice.map((issue) => forge.issueJson(repo, issue)));
    }
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return err(422, 'a JSON body is required');
      const title = typeof req.body.title === 'string' ? req.body.title : '';
      if (title === '') return err(422, 'a title is required');
      const body = typeof req.body.body === 'string' ? req.body.body : '';
      const labels = Array.isArray(req.body.labels) ? req.body.labels.filter((label): label is string => typeof label === 'string') : [];
      const created = forge.createIssue(repo, title, body, labels);
      if ('error' in created) return err(422, `Label '${created.label}' does not exist`);
      return ok(forge.issueJson(repo, created), 201);
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (req.method === 'GET') return ok(forge.issueJson(repo, issue));
    if (req.method === 'PATCH') {
      if (!isRecord(req.body)) return err(422, 'a JSON body is required');
      if (req.body.state === 'open' || req.body.state === 'closed') issue.state = req.body.state;
      if (typeof req.body.title === 'string') issue.title = req.body.title;
      if (typeof req.body.body === 'string') issue.body = req.body.body;
      return ok(forge.issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (req.method === 'GET') return ok(issue.comments.map((comment) => forge.commentJson(comment)));
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return err(422, 'a JSON body is required');
      const body = typeof req.body.body === 'string' ? req.body.body : '';
      if (body === '') return err(422, 'a comment body is required');
      const comment = forge.addComment(repo, issue, body);
      return ok(forge.commentJson(comment), 201);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function pulls(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResponse {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const { page, perPage } = pageOf(req.query);
      const list = forge.listPulls(repo, state);
      const { slice } = paginate(list, page, perPage);
      return ok(slice.map((pull) => forge.pullJson(repo, pull)));
    }
    if (req.method === 'POST') {
      if (!isRecord(req.body)) return err(422, 'a JSON body is required');
      const title = typeof req.body.title === 'string' ? req.body.title : '';
      const head = typeof req.body.head === 'string' ? req.body.head : '';
      const base = typeof req.body.base === 'string' ? req.body.base : '';
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const body = typeof req.body.body === 'string' ? req.body.body : '';
      const created = forge.createPull(repo, title, body, head, base);
      if ('error' in created) return err(422, created.error);
      return ok(forge.pullJson(repo, created), 201);
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = forge.getPull(repo, number);
  if (pull === undefined) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (req.method === 'GET') return ok(forge.pullJson(repo, pull));
    return err(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok(forge.pullFiles(repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (req.method !== 'PUT') return err(404, 'Not Found');
    const merged = forge.squashMerge(repo, pull);
    if ('error' in merged) {
      if (merged.error === 'merge conflict') return err(405, 'merge conflict');
      return err(422, merged.error);
    }
    return ok({ sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return err(404, 'Not Found');
}

export { DEFAULT_BRANCH };
