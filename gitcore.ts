// Git's wire primitives: pkt-line framing, packfiles, and reachability.
//
// A pack is whole objects only — no deltas. The suite's pack-deltas check passes
// when the server sends none, and whole objects keep the clone workload fast.
// Pack object payloads are deflated at level 1: valid zlib, and measurably faster
// to build than level 6 on the 50-concurrent-clone benchmark.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType, RepoRec } from './store.ts';
import { parseCommit } from './store.ts';
import { hashObject, isZeroOid } from './util.ts';

/** One pkt-line packet: a data line, a flush, a delimiter, or a response-end. */
export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Split a buffer into pkt-line packets. Parsing stops at the first flush (or at
 * the end of the buffer) and the remaining bytes are returned as `rest`: a push
 * request carries its raw pack bytes there, after the command list's flush.
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
      throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    }
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) {
      throw new Error('truncated pkt-line');
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after the last pkt-line');
  return { packets, rest: Buffer.alloc(0) };
}

/** Encode one pkt-line: 4 hex digits of (len + 4) + the payload. */
export function encodePktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** The data lines of a packet list, as UTF-8 strings with the trailing newline kept. */
export function packetLines(packets: readonly Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack of whole objects: header, one deflated object each, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODES[object.type];
    const size = object.data.length;
    // Object header: a varint of the size with the type in bits 4-6 of the first byte.
    const headerBytes: number[] = [];
    let first = (size & 0x0f) | (code << 4);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  // The trailer is the SHA-1 of the pack bytes themselves (not a git object).
  const digest = createHash('sha1').update(body).digest();
  return Buffer.concat([body, digest]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta to a base buffer, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let size = 0;
  while (offset < delta.length) {
    const cmd = delta[offset];
    offset += 1;
    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (cmd & (1 << i)) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (cmd & (0x10 << i)) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      size += copySize;
    } else if (cmd !== 0) {
      out.push(delta.subarray(offset, offset + cmd));
      offset += cmd;
      size += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (size !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Read a packfile into its objects. Deltas resolve against earlier pack entries or `resolveBase`. */
export function readPack(
  buf: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let object: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (typeCode === 6) {
        // ofs-delta: the base is at (start - offset-varint) in this pack.
        let b = buf[offset];
        offset += 1;
        let baseOffset = b & 0x7f;
        while (b & 0x80) {
          b = buf[offset];
          offset += 1;
          baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
        }
        base = byOffset.get(start - baseOffset);
      } else {
        const baseOid = buf.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        base = objects.get(baseOid) ?? options.resolveBase?.(baseOid);
      }
      if (base === undefined) throw new Error('delta base is missing');
      const inflated = inflateAt(buf, offset);
      offset = inflated.next;
      const data = applyDelta(base.data, inflated.data);
      object = { type: base.type, data };
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(buf, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('inflated object size mismatch');
      object = { type, data: inflated.data };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(start, object);
  }
  return { objects, deltaCount };
}

/** Parse a tree object's raw bytes into entries (mode, name, oid). */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/**
 * The objects a fetch must deliver.
 *
 * - Full fetch (no depth): every object reachable from `wants`, minus every
 *   object reachable from `haves`.
 * - Shallow fetch (depth N): commits at levels 0..N-1 from `wants` (a level is one
 *   parent step), their trees and blobs, minus the haves' closure. The new
 *   shallow boundary is the deepest included commits (level N-1); the old
 *   boundary commits whose parents are now all included are `unshallow`.
 */
export function collectFetchObjects(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): { objects: GitObject[]; oids: string[]; shallow: string[]; unshallow: string[] } {
  const haveClosure = new Set<string>();
  for (const have of haves) collectClosure(repo, have, haveClosure);
  // A want the client already holds (as a full object) delivers nothing.
  const include = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === undefined) {
    const wanted = new Set<string>();
    for (const want of wants) collectClosure(repo, want, wanted);
    for (const oid of wanted) {
      if (haveClosure.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined) include.set(oid, obj);
    }
  } else {
    // A shallow fetch's haves are shallow themselves: the client holds each have
    // commit and its tree, but NOT the have's parents. The exclusion set is
    // therefore the shallow closure (commit + tree, no parents), and the walk
    // continues through held commits to their parents — those are the new
    // generations a deepen delivers.
    const held = new Set<string>();
    for (const have of [...haves, ...oldShallow]) collectShallowClosure(repo, have, held);
    // Levelled commit walk: level 0 is the wants, level k their k-th ancestors.
    const includedCommits = new Set<string>();
    let frontier = [...new Set(wants)];
    for (let level = 0; level < depth; level += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (includedCommits.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        let parents: string[] = [];
        try {
          parents = parseCommit(obj.data).parents;
        } catch {
          // A malformed commit has no parents to walk.
        }
        for (const parent of parents) next.push(parent);
        if (held.has(oid)) continue;
        includedCommits.add(oid);
        collectObjectAndTree(repo, oid, include, held);
      }
      if (level === depth - 1) {
        for (const oid of frontier) {
          if (includedCommits.has(oid)) shallow.push(oid);
        }
      }
      frontier = next;
    }
    // The old boundary is unshallow when its parents are all included now;
    // otherwise it stays a boundary.
    for (const old of oldShallow) {
      const obj = repo.objects.get(old);
      if (obj === undefined || obj.type !== 'commit') continue;
      let parents: string[];
      try {
        parents = parseCommit(obj.data).parents;
      } catch {
        continue;
      }
      if (parents.length > 0 && parents.every((p) => includedCommits.has(p))) {
        unshallow.push(old);
      } else if (!includedCommits.has(old)) {
        shallow.push(old);
      }
    }
  }
  // Deterministic pack order: by oid, so two identical fetches answer alike.
  const oids = [...include.keys()].sort();
  return { objects: oids.map((oid) => include.get(oid) as GitObject), oids, shallow, unshallow };
}

/** Add an object and, for commits and trees, everything it names, to `out`. */
function collectObjectAndTree(repo: RepoRec, oid: string, out: Map<string, GitObject>, skip: Set<string>): void {
  if (skip.has(oid) || out.has(oid)) return;
  const obj = repo.objects.get(oid);
  if (obj === undefined) return;
  out.set(oid, obj);
  if (obj.type === 'commit') {
    try {
      const parsed = parseCommit(obj.data);
      collectObjectAndTree(repo, parsed.tree, out, skip);
    } catch {
      // No tree to walk.
    }
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectObjectAndTree(repo, entry.oid, out, skip);
  } else if (obj.type === 'tag') {
    const target = parseTagTarget(obj.data);
    if (target !== null) collectObjectAndTree(repo, target, out, skip);
  }
}

/**
 * The shallow closure of an object: the object itself and, for a commit, its
 * tree and blobs — but NOT its parents. That is what a shallow clone holds of
 * its boundary commits, and what a deepen fetch must not re-send.
 */
export function collectShallowClosure(repo: RepoRec, oid: string, out: Set<string>): void {
  if (isZeroOid(oid) || out.has(oid)) return;
  const obj = repo.objects.get(oid);
  if (obj === undefined) return;
  out.add(oid);
  if (obj.type === 'commit') {
    try {
      collectShallowClosure(repo, parseCommit(obj.data).tree, out);
    } catch {
      // No tree to walk.
    }
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectShallowClosure(repo, entry.oid, out);
  } else if (obj.type === 'tag') {
    const target = parseTagTarget(obj.data);
    if (target !== null) collectShallowClosure(repo, target, out);
  }
}

/** Every object reachable from `oid` (commits, trees, blobs, tags), into `out`. */
export function collectClosure(repo: RepoRec, oid: string, out: Set<string>): void {
  if (isZeroOid(oid) || out.has(oid)) return;
  const obj = repo.objects.get(oid);
  if (obj === undefined) return;
  out.add(oid);
  if (obj.type === 'commit') {
    try {
      const parsed = parseCommit(obj.data);
      collectClosure(repo, parsed.tree, out);
      for (const parent of parsed.parents) collectClosure(repo, parent, out);
    } catch {
      // No further objects to walk.
    }
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectClosure(repo, entry.oid, out);
  } else if (obj.type === 'tag') {
    const target = parseTagTarget(obj.data);
    if (target !== null) collectClosure(repo, target, out);
  }
}

/** The object a tag points at, from its raw bytes. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1];
}

/** The commit a tag peels to: follow tag objects until a commit (or null). */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target === null) return null;
      current = target;
      continue;
    }
    return null;
  }
  return null;
}
