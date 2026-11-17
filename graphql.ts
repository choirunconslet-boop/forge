// GraphQL v4 — STUB. Replaced by the real executor in step 7.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendError } from './app.ts';

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse, ctx: Ctx, _method: string): Promise<void> {
  sendError(res, 501, 'GraphQL not implemented yet', ctx);
}
