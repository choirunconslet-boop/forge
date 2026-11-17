// Git smart HTTP: the /<owner>/<repo>.git/ surface.
//
// Two protocols, chosen by the request:
//   - v2 (Git-Protocol: version=2) for git-upload-pack: a capability advertisement,
//     ls-refs, and fetch with sections. Receive-pack is v0 only — the suite's
//     client refuses a v2 receive-pack advertisement outright.
//   - v0 for both services: a ref advertisement (capabilities after a NUL on the
//     first line), and fetch with want/have/done/deepen.
//
// Every pack is whole objects only, framed as sideband band-1 packets of at most
// 65515 data bytes (the pkt-line ceiling is 65520). A fetch that delivers nothing
// still answers a pack: an empty one (32 bytes), never an absent one.
// A missing repo is 404 on every git route, even unauthenticated; an existing repo
// without the trial token is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { readBody, sendError } from './app.ts';
import { getRepo, isAncestor, type RepoRec } from './store.ts';
import { collectFetchObjects, decodePktLines, encodePktLine, peelToCommit, PKT_DELIM, PKT_FLUSH, readPack, writePack } from './gitcore.ts';
import { DEFAULT_BRANCH } from './scenario.ts';
import { isZeroOid, ZERO_OID } from './util.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The capabilities a v2 upload-pack advertisement carries. */
const V2_CAPABILITIES = ['agent', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
/** The capabilities a v0 upload-pack advertisement carries (after the NUL). */
const V0_UPLOAD_CAPABILITIES = 'symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack';
/** The capabilities a v0 receive-pack advertisement carries (after the NUL). */
const V0_RECEIVE_CAPABILITIES = 'symref=HEAD:refs/heads/main report-status delete-refs side-band-64k ofs-delta agent';

/** Send a raw git body with its content type and the request id. */
function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer, ctx: Ctx): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  res.end(body);
}

/** Split pack bytes into sideband band-1 pkt-lines (each ≤ 65520 bytes total). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    // An empty pack still needs one band-1 packet so the client sees a pack.
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return out;
}

/** All refs of a repo, sorted by name: branches then tags, with HEAD first. */
function sortedRefs(repo: RepoRec): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The v2 capability advertisement for git-upload-pack. */
function v2Advertisement(): Buffer {
  const lines: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), PKT_FLUSH, encodePktLine('version 2\n')];
  for (const cap of V2_CAPABILITIES) lines.push(encodePktLine(`${cap}\n`));
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The v0 ref advertisement for a service. The first line carries the capabilities after a NUL. */
function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPABILITIES : V0_RECEIVE_CAPABILITIES;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? refs[0].oid;
    parts.push(encodePktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        const tagObj = repo.objects.get(ref.oid);
        if (peeled !== null && tagObj?.type === 'tag') {
          parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
        }
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The data lines of a pkt-line body, as strings. */
function bodyLines(body: Buffer): string[] {
  const { packets } = decodePktLines(body);
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

/** The ls-refs answer: one pkt-line per ref, honouring peel / symrefs / unborn / ref-prefix. */
function lsRefsAnswer(repo: RepoRec, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(encodePktLine(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? refs[0].oid;
  if (keep('HEAD')) {
    lines.push(encodePktLine(`${mainTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      const tagObj = repo.objects.get(ref.oid);
      if (peeled !== null && tagObj?.type === 'tag') line += ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The v2 fetch answer: acknowledgments, shallow-info and packfile sections. */
function v2FetchAnswer(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
): Buffer {
  const { objects, shallow, unshallow } = collectFetchObjects(repo, wants, haves, oldShallow, depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(encodePktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(encodePktLine('NAK\n'));
    parts.push(encodePktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK lines, shallow lines, then the sideband pack. */
function v0FetchAnswer(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
): Buffer {
  const { objects, shallow, unshallow } = collectFetchObjects(repo, wants, haves, oldShallow, depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(encodePktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 command request: the command line, the args after the delimiter. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  return { command, args };
}

/** Parse a v0 fetch request: wants, haves, shallow boundaries and depth, from two sections. */
function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined } {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    void section;
  }
  return { wants, haves, shallow, depth };
}

/** Parse a receive-pack request: the command list, and the raw pack bytes after the flush. */
function parseReceivePack(body: Buffer): { commands: Array<{ oldOid: string; newOid: string; ref: string }>; pack: Buffer } {
  const { packets, rest } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  return { commands, pack: rest };
}

/** Apply one push command; returns null on success or the ng reason. */
function applyCommand(repo: RepoRec, command: { oldOid: string; newOid: string; ref: string }): string | null {
  const current = repo.refs.get(command.ref);
  if (isZeroOid(command.newOid)) {
    // Delete: the ref must exist, and the old value must match it.
    if (current === undefined) return 'remote ref does not exist';
    if (!isZeroOid(command.oldOid) && command.oldOid !== current) return 'old value does not match';
    repo.refs.delete(command.ref);
    return null;
  }
  // Create or update: the new object must be present.
  const obj = repo.objects.get(command.newOid);
  if (obj === undefined) return 'object not found';
  if (obj.type !== 'commit' && obj.type !== 'tag') return 'object is not a commit or tag';
  if (current === undefined) {
    // Create: the old value must be zero.
    if (!isZeroOid(command.oldOid)) return 'old value does not match';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  // Update: the old value must match, and the move must be a fast-forward.
  if (command.oldOid !== current) return 'old value does not match';
  if (command.newOid === current) return null;
  if (!isAncestor(repo, current, command.newOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/** The git entry point: route /<owner>/<repo>.git/<service> to the right handler. */
export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string, method: string): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  const [, owner, repoName, service] = match;
  const repo = getRepo(ctx.store, owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found', ctx);
    return;
  }
  if (!ctx.authed) {
    sendError(res, 401, 'Requires authentication', ctx);
    return;
  }

  if (service === 'info/refs') {
    if (method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed', ctx);
      return;
    }
    const query = new URL(req.url ?? '/', 'http://entry').searchParams;
    const requested = query.get('service');
    if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') {
      sendError(res, 400, 'a service parameter is required', ctx);
      return;
    }
    const v2 = req.headers['git-protocol'] === 'version=2' && requested === 'git-upload-pack';
    const body = v2 ? v2Advertisement() : v0Advertisement(repo, requested);
    sendGit(res, 200, requested === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body, ctx);
    return;
  }

  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed', ctx);
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    sendError(res, 413, 'request body too large', ctx);
    return;
  }

  try {
    if (service === 'git-upload-pack') {
      const v2 = req.headers['git-protocol'] === 'version=2';
      if (v2) {
        const { command, args } = parseV2Request(raw);
        if (command === 'ls-refs') {
          const answer = lsRefsAnswer(repo, {
            peel: args.includes('peel'),
            symrefs: args.includes('symrefs'),
            unborn: args.includes('unborn'),
            prefixes: args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length)),
          });
          sendGit(res, 200, UPLOAD_RESULT, answer, ctx);
          return;
        }
        if (command === 'fetch') {
          const wants: string[] = [];
          const haves: string[] = [];
          const shallow: string[] = [];
          let depth: number | undefined;
          for (const arg of args) {
            if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
            else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
            else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
            else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
          }
          sendGit(res, 200, UPLOAD_RESULT, v2FetchAnswer(repo, wants, haves, shallow, depth), ctx);
          return;
        }
        sendError(res, 400, `unknown command ${command}`, ctx);
        return;
      }
      const { wants, haves, shallow, depth } = parseV0Fetch(raw);
      sendGit(res, 200, UPLOAD_RESULT, v0FetchAnswer(repo, wants, haves, shallow, depth), ctx);
      return;
    }

    // git-receive-pack: v0 only.
    const { commands, pack } = parseReceivePack(raw);
    const report: string[] = [];
    if (commands.length === 0) {
      report.push('unpack error: no commands');
    } else {
      let unpackOk = true;
      let unpackDetail = 'ok';
      if (pack.length > 0) {
        try {
          const { objects } = readPack(pack);
          for (const [oid, object] of objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, object);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'unpack error';
        }
      }
      if (!unpackOk) {
        report.push(`unpack ${unpackDetail}`);
      } else {
        report.push('unpack ok');
        for (const command of commands) {
          const reason = applyCommand(repo, command);
          report.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
        }
      }
    }
    const inner = Buffer.concat([...report.map((line) => encodePktLine(`${line}\n`)), PKT_FLUSH]);
    const body = Buffer.concat([...sidebandPack(inner), PKT_FLUSH]);
    sendGit(res, 200, RECEIVE_RESULT, body, ctx);
  } catch (err) {
    // A malformed pkt-line stream or pack: answer 400 and stay healthy.
    sendError(res, 400, err instanceof Error ? err.message : 'malformed request', ctx);
  }
}
