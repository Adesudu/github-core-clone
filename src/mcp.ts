// MCP: Streamable HTTP at /mcp, plain JSON responses. Implements the modern
// `server/discover` handshake plus the legacy `initialize` fallback, and six
// tools that read and write the same Forge store as REST and GraphQL.

import { VIEWER_LOGIN, type Forge } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18'];

export interface McpResponse {
  status: number;
  json: unknown | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolTextResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): Record<string, unknown> {
  return toolError(`missing required argument: ${name}`);
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

export function handleMcp(forge: Forge, body: unknown, bodyParseError: boolean): McpResponse {
  if (bodyParseError) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = body as Record<string, unknown>;
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params as Record<string, unknown> | undefined) ?? {};

  // Notifications carry no id and are answered with 202 and no body.
  if (id === undefined) {
    return { status: 202, json: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion : undefined;
    const protocolVersion = requested !== undefined && SUPPORTED_VERSIONS.includes(requested as string) ? requested : SUPPORTED_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = TOOLS.find((item) => item.name === toolName);
    if (tool === undefined) {
      return rpcError(id, -32601, `Unknown tool: ${toolName}`);
    }
    try {
      const result = callTool(forge, toolName, args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcError(id, -32602, err instanceof Error ? err.message : 'tool call failed');
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(forge: Forge, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'create_repo': {
      const name = stringArg(args, 'name');
      if (name === undefined || name === '') return missingArg('name');
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${name} already exists`);
      const description = stringArg(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const repo = forge.createRepo(name, isPrivate, description);
      return toolTextResult(forge.repoJson(repo));
    }
    case 'get_repo': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolTextResult(forge.repoJson(repo));
    }
    case 'create_issue': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      const title = stringArg(args, 'title');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      if (title === undefined || title === '') return missingArg('title');
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const body = stringArg(args, 'body') ?? '';
      const created = forge.createIssue(repo, title, body, []);
      if ('error' in created) return toolError(created.error);
      return toolTextResult(forge.issueJson(repo, created));
    }
    case 'list_issues': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = stringArg(args, 'state') ?? 'all';
      const list = forge.listIssues(repo, state === 'all' ? 'all' : state, 'asc');
      const payload = list.map((issue) => forge.issueJson(repo, issue));
      return toolTextResult(payload);
    }
    case 'create_pull_request': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      if (title === undefined || title === '') return missingArg('title');
      if (head === undefined || head === '') return missingArg('head');
      if (base === undefined || base === '') return missingArg('base');
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const body = stringArg(args, 'body') ?? '';
      const created = forge.createPull(repo, title, body, head, base);
      if ('error' in created) return toolError(created.error);
      return toolTextResult(forge.pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      const pullNumber = args.pull_number;
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) return missingArg('pull_number');
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = forge.getPull(repo, pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
      const merged = forge.squashMerge(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolTextResult({ sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    }
  }
  throw new Error(`Unknown tool: ${toolName}`);
}
