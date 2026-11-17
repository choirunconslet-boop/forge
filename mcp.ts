// MCP — STUB. Replaced by the real endpoint in step 8.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendError } from './app.ts';

export async function handleMcp(_req: IncomingMessage, res: ServerResponse, ctx: Ctx, _method: string): Promise<void> {
  sendError(res, 501, 'MCP not implemented yet', ctx);
}
