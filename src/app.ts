// The forge's HTTP surface: /healthz, REST v3 under /api/v3, GraphQL v4 at
// /api/graphql, MCP at /mcp, and git smart HTTP under /{owner}/{repo}.git.
// Every API surface answers JSON (never HTML); git answers raw protocol bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphql, type GraphqlRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite passes; empty in local dev, where any non-empty token is accepted. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  let requestId = 0;

  const requestIdHeader = (): Record<string, string> => {
    requestId += 1;
    return { 'x-github-request-id': `req-${requestId}` };
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Bearer auth on every other surface: the exact token when the env sets one,
      // any non-empty bearer token in local dev.
      const authorization = req.headers.authorization ?? '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      const authorized = SHOP_TOKEN !== '' ? bearer === SHOP_TOKEN : bearer !== '';
      if (!authorized) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestIdHeader());
        return;
      }

      try {
        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const raw = method === 'GET' || method === 'DELETE' ? await readBody(req) : await readBody(req);
          let body: unknown = undefined;
          let bodyParseError = false;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8')) as unknown;
            } catch {
              bodyParseError = true;
            }
          }
          const host = req.headers.host ?? '127.0.0.1';
          const result = handleRest(forge, { method, path, query: queryOf(req), body, bodyParseError, host });
          const headers = { ...requestIdHeader(), ...(result.headers ?? {}) };
          if (result.status === 204) {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          sendJson(res, result.status, result.json, headers);
          return;
        }

        // GraphQL v4: one operation object, or a JSON array of them (batched).
        if (method === 'POST' && path === '/api/graphql') {
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] }, requestIdHeader());
            return;
          }
          const requests: GraphqlRequest[] = Array.isArray(parsed) ? (parsed as GraphqlRequest[]) : [parsed as GraphqlRequest];
          if (requests.some((item) => typeof item !== 'object' || item === null || typeof item.query !== 'string')) {
            sendJson(res, 400, { errors: [{ message: 'each operation needs a query string' }] }, requestIdHeader());
            return;
          }
          const results = executeGraphql(forge, requests);
          sendJson(res, 200, Array.isArray(parsed) ? results : results[0], requestIdHeader());
          return;
        }

        // MCP: Streamable HTTP, plain JSON responses.
        if (method === 'POST' && path === '/mcp') {
          const raw = await readBody(req);
          let body: unknown = undefined;
          let bodyParseError = false;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8')) as unknown;
            } catch {
              bodyParseError = true;
            }
          }
          const result = handleMcp(forge, body, bodyParseError);
          if (result.status === 202 || result.json === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, result.status, result.json, requestIdHeader());
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          const repo = forge.getRepo(owner, repoName);
          if (action === 'info/refs' && method === 'GET') {
            const service = queryOf(req).get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
              return;
            }
            const protocolVersion2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = infoRefs(forge, repo, service, protocolVersion2);
            if (result.status === 404) {
              sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
              return;
            }
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const protocolVersion2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = uploadPack(forge, repo, raw, protocolVersion2);
            if (result.status !== 200) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown, requestIdHeader());
              return;
            }
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const result = receivePack(forge, repo, raw);
            if (result.status !== 200) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown, requestIdHeader());
              return;
            }
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
      } catch (err) {
        // Never let one bad request kill the server.
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestIdHeader());
        else res.end();
      }
    })();
  });
}
