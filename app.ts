// Forge HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and
// MCP from its own in-memory store. This file owns the listener, the routing table
// and the shared reply helpers; the four surfaces live in githttp.ts, rest.ts,
// graphql.ts and mcp.ts, and the store in store.ts.
//
// Every JSON reply carries a non-empty X-GitHub-Request-Id header. Every REST reply
// is application/json, never HTML. A request without the trial's bearer token is 401
// on every surface except GET /healthz (the env's boot probe).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token this process accepts, from the trial environment. */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The login the token names: the scenario's viewer, derived in scenario.ts. */
export function viewerLogin(): string {
  return process.env.FORGE_VIEWER ?? 'adaiversen';
}

/** One request's context: the store, the auth verdict and the request id. */
export interface Ctx {
  store: Store;
  /** True when the request carried the trial's bearer token. */
  authed: boolean;
  requestId: string;
}

let requestCounter = 0;

/** A request id that is unique per process and never repeats: req-<counter>. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body and the shared headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown, ctx: Ctx, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  res.end(text);
}

/** The error body every surface uses: {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string, ctx: Ctx): void {
  sendJson(res, status, { message }, ctx);
}

/** The request path, decoded, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}

/** The request query, as a URLSearchParams (never a throw). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body fully, up to `cap` bytes; null when it is larger. */
export async function readBody(req: IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > cap) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns { ok: false } on malformed JSON (the caller answers 400). */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = createStore();
  const token = shopToken();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const ctx: Ctx = {
      store,
      authed: token !== '' && (req.headers.authorization ?? '') === `Bearer ${token}`,
      requestId: nextRequestId(),
    };
    void dispatch(req, res, ctx).catch((err: unknown) => {
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'internal error', ctx);
      } catch {
        // The peer went away; nothing to write to.
      }
    });
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  if (path.endsWith('.git/info/refs') || path.includes('.git/git-upload-pack') || path.includes('.git/git-receive-pack')) {
    await handleGit(req, res, ctx, path, method);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, ctx, path, method);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    await handleGraphql(req, res, ctx, method);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    await handleMcp(req, res, ctx, method);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendError(res, 404, 'Not Found', ctx);
}
