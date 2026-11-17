// Shared primitives: SHA-1 object ids, pkt-line framing, opaque node ids, line diffs.
// No Date.now() / Math.random() here: every timestamp in the forge comes from the
// store's monotonic counter, so two runs of the same request sequence answer alike.

import { createHash } from 'node:crypto';

/** The SHA-1 of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The 40-hex zero id: "no object". */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** True when the id is the 40-zero id. */
export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

/** Encode a pkt-line: 4 hex digits of (len + 4) followed by the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

/** The flush packet: "0000". */
export const FLUSH = Buffer.from('0000', 'ascii');

/** The delimiter packet: "0001". */
export const DELIM = Buffer.from('0001', 'ascii');

/** The response-end packet: "0002". */
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** An opaque, stable node id: base64url("<Kind>:<repoDbId>:<number>"). */
export function nodeId(kind: string, repoDbId: number, number: number): string {
  return Buffer.from(`${kind}:${repoDbId}:${number}`, 'utf8').toString('base64url');
}

/** Decode a node id back to its parts, or null when it is not one of ours. */
export function parseNodeId(id: string): { kind: string; repoDbId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoDbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(repoDbId) || !Number.isInteger(number)) return null;
    return { kind: parts[0], repoDbId, number };
  } catch {
    return null;
  }
}

/** Count added and removed lines between two texts, by longest-common-subsequence. */
export function diffLines(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // A trailing newline makes the last split element ''; drop it on both sides so a
  // file that only gains a final newline counts as unchanged.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = a[i] === b[j] ? dp[(i + 1) * cols + (j + 1)] + 1 : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }
  const common = dp[0];
  return { additions: b.length - common, deletions: a.length - common };
}

/** Split a string on newlines, keeping the semantics of diffLines (no trailing ''). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
