// Git smart HTTP: info/refs (v0 and v2), upload-pack (ls-refs, fetch) and
// receive-pack (push). Speaks the protocol v2 the suite requires and the v0
// receive-pack the client pushes through.

import { decodePktLines, packetLines, pktDelim, pktFlush, pktLine, pktLines, SIDEBAND_MAX, ZERO_OID, HEX40 } from './util.ts';
import { isAncestor, peelTag } from './gitcore.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';

const UPLOAD_CAPS_V2 = ['ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1', 'agent=github-core-clone/1.0'];
const UPLOAD_CAPS_V0 = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack';
const RECEIVE_CAPS_V0 = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0';

export type GitResponse = { status: number; contentType: string; body: Buffer };

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

/** The refs a v0 advertisement lists: HEAD first, then refs sorted by name. */
function v0RefLines(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = repo.refs;
  const mainTip = refs.get('refs/heads/main');
  if (refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? [...refs.values()][0]!;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelTag(repo.objects, oid);
        parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function preamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), pktFlush()]);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=...
 * upload-pack with `Git-Protocol: version=2` answers v2; anything else answers v0.
 * receive-pack always answers v0. A missing repo is a 404.
 */
export function infoRefs(forge: Forge, repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', protocolVersion2: boolean): GitResponse {
  if (repo === undefined) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', Buffer.concat([preamble(service), v0RefLines(repo, RECEIVE_CAPS_V0)]));
  }
  if (protocolVersion2) {
    const parts: Buffer[] = [preamble(service), pktLine('version 2\n')];
    for (const cap of UPLOAD_CAPS_V2) parts.push(pktLine(`${cap}\n`));
    parts.push(pktFlush());
    return ok('application/x-git-upload-pack-advertisement', Buffer.concat(parts));
  }
  return ok('application/x-git-upload-pack-advertisement', Buffer.concat([preamble(service), v0RefLines(repo, UPLOAD_CAPS_V0)]));
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(body: Buffer): LsRefsRequest | null {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return null;
  }
  const lines = packetLines(packets);
  if (lines.length === 0 || lines[0]!.trim() !== 'command=ls-refs') return null;
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') request.peel = true;
    else if (text === 'symrefs') request.symrefs = true;
    else if (text === 'unborn') request.unborn = true;
    else if (text.startsWith('ref-prefix ')) request.prefixes.push(text.slice('ref-prefix '.length));
  }
  return request;
}

/** POST /{owner}/{repo}.git/git-upload-pack: ls-refs or fetch (v2), or a v0 fetch. */
export function uploadPack(forge: Forge, repo: Repo, body: Buffer, protocolVersion2: boolean): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed request' })) };
  }
  const lines = packetLines(packets);
  const first = lines[0]?.replace(/\n$/, '') ?? '';
  if (first === 'command=ls-refs') {
    return lsRefs(forge, repo, body);
  }
  if (first === 'command=fetch') {
    return fetchV2(forge, repo, body);
  }
  if (first.startsWith('want ') || lines.some((line) => line.startsWith('want '))) {
    return fetchV0(forge, repo, body);
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown upload-pack command' })) };
}

function lsRefs(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const request = parseLsRefs(body);
  if (request === null) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed ls-refs request' })) };
  }
  const keep = (name: string): boolean => request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD${request.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else {
      parts.push(pktLine(`unborn HEAD${request.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const [name, oid] of forge.sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (request.symrefs && name === 'HEAD') line += ' symref-target:refs/heads/main';
    const object = repo.objects.get(oid);
    if (request.peel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${peelTag(repo.objects, oid)}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetch(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) request.depth = n;
    }
  }
  return request;
}

/** One sideband packet per chunk of pack bytes (band 1), then a flush. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_MAX));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function fetchV2(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const lines = packetLines(decodePktLines(body).packets);
  const request = parseFetch(lines);
  return fetchResponse(forge, repo, request, true);
}

function fetchV0(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  const lines = packetLines(decodePktLines(body).packets);
  const request = parseFetch(lines);
  return fetchResponse(forge, repo, request, false);
}

function fetchResponse(forge: Forge, repo: Repo, request: FetchRequest, v2: boolean): GitResponse {
  const wants = [...new Set(request.wants)].filter((oid) => HEX40.test(oid));
  const haves = request.haves.filter((oid) => HEX40.test(oid));
  const plan = forge.planFetch(repo, wants, haves, request.shallow, request.depth);
  const pack = forge.buildPack(plan.objects);
  const parts: Buffer[] = [];
  if (v2) {
    // Real git only reads an acknowledgments section when the request carried `have`
    // lines; a fresh clone (no haves) expects the packfile section first. The kit's
    // client dispatches on section headers, so it accepts either shape.
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const heldHaves = haves.filter((oid) => repo.objects.has(oid));
      for (const oid of heldHaves) parts.push(pktLine(`ACK ${oid}\n`));
      if (heldHaves.length === haves.length) parts.push(pktLine('ready\n'));
      else parts.push(pktLine('NAK\n'));
      parts.push(pktDelim());
    }
    if (request.depth !== null || plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    // v0: ACK/NAK/shallow lines as plain packets, then the sideband pack.
    const heldHaves = haves.filter((oid) => repo.objects.has(oid));
    if (haves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of heldHaves) parts.push(pktLine(`ACK ${oid}\n`));
    }
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  }
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack: a command list, a flush, then a pack.
 * Every command is judged on its own; the report carries one ok/ng line per ref, and a
 * refused ref never moves. Objects are stored even when a ref is refused (unpack ok).
 */
export function receivePack(forge: Forge, repo: Repo, body: Buffer): GitResponse {
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed request' })) };
  }
  const lines = packetLines(decoded.packets);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
    if (match === null) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed command list' })) };
    }
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'no commands' })) };
  }

  // Unpack first: a bad pack is an unpack error, not a crash, and no ref moves.
  const pack = decoded.trailing;
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      forge.storePack(repo, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: PushReportLine[] = [];
  if (!unpackOk) {
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: unpackDetail });
  } else {
    for (const command of commands) {
      report.push({ ref: command.ref, ...applyCommand(forge, repo, command) });
    }
  }

  const inner: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const line of report) {
    inner.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  // The report stream itself ends with a flush inside the band-1 data: git's report reader
  // reads the demultiplexed stream until that flush, and dies on EOF without it.
  inner.push('flush');
  const innerBytes = pktLines(inner);
  const band = pktLine(Buffer.concat([Buffer.from([1]), innerBytes]));
  return ok('application/x-git-receive-pack-result', Buffer.concat([band, pktFlush()]));
}

function applyCommand(forge: Forge, repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  const lookup = forge.lookup(repo);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old value does not match' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const newObject = repo.objects.get(command.newOid);
  if (newObject === undefined) return { ok: false, reason: 'object not found' };
  if (current === undefined) {
    // Create.
    if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'remote ref does not exist' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update: old must match, and the new tip must descend from the old one (or equal it).
  if (command.oldOid !== current) return { ok: false, reason: 'old value does not match' };
  if (command.newOid === current) return { ok: true, reason: '' };
  if (newObject.type === 'commit') {
    let isDescendant = false;
    try {
      isDescendant = isAncestor(current, command.newOid, lookup);
    } catch {
      isDescendant = false;
    }
    if (!isDescendant) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

export { DEFAULT_BRANCH };
