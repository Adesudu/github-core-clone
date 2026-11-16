// Git objects, packfiles and reachability, implemented from scratch (no git binary).
// Objects are stored verbatim: a clone returns byte-identical objects.

import { deflateSync, inflateSync } from 'node:zlib';
import { HEX40, ZERO_OID, hashObject } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!HEX40.test(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!HEX40.test(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface CommitInput {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Build a commit object. `author`/`committer` are `Name <email>`; the timestamp is appended. */
export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

/** Peel an annotated tag to its target commit (following tag-to-tag chains). */
export function peelTag(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = data[offset] & 0x7f;
  let next = offset + 1;
  let shift = 7;
  while (data[offset] & 0x80) {
    value |= (data[next] & 0x7f) << shift;
    shift += 7;
    offset = next;
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readSize();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackRead {
  version: number;
  declaredCount: number;
  /** oid -> object, fully resolved (deltas applied). */
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. `resolveBase` supplies
 * thin-pack bases the pack itself does not hold (oid -> object); without it a thin pack that
 * references a missing base throws.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: Array<{ type: GitObjectType; data: Buffer; oid: string }> = [];
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  let offset = 12;
  let deltaCount = 0;
  interface Pending {
    index: number;
    baseOffset?: number;
    baseOid?: string;
  }
  const pending: Pending[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset to the base, variable-length
      byte = pack[offset];
      offset += 1;
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - base;
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    }
    const inflated = inflateSync(pack.subarray(offset));
    offset += inflatedLength(pack, offset);
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      pending.push({ index, baseOffset, baseOid });
      entries.push({ type: 'blob', data: inflated, oid: '' }); // placeholder; resolved below
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const oid = hashObject(type, inflated);
    const entry = { type, data: inflated, oid };
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const objects = new Map<string, GitObject>();
  for (const entry of entries) if (entry.oid !== '') objects.set(entry.oid, { type: entry.type, data: entry.data });
  // Resolve deltas (possibly chained): iterate until every pending entry resolves.
  const resolveOne = (entryIndex: number, depth = 0): GitObject => {
    if (depth > 100) throw new Error('delta chain too deep');
    const entry = entries[entryIndex];
    const pend = pending.find((p) => p.index === entryIndex);
    if (!pend) return { type: entry.type, data: entry.data };
    let base: GitObject | undefined;
    if (pend.baseOffset !== undefined) {
      const baseEntry = byOffset.get(pend.baseOffset);
      if (baseEntry !== undefined) {
        const baseIndex = entries.indexOf(baseEntry);
        base = baseIndex >= 0 && pending.some((p) => p.index === baseIndex) ? resolveOne(baseIndex, depth + 1) : { type: baseEntry.type, data: baseEntry.data };
      }
    } else if (pend.baseOid !== undefined) {
      base = objects.get(pend.baseOid) ?? resolveBase?.(pend.baseOid);
    }
    if (base === undefined) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  for (const pend of pending) {
    const resolved = resolveOne(pend.index);
    const oid = hashObject(resolved.type, resolved.data);
    entries[pend.index] = { type: resolved.type, data: resolved.data, oid };
    objects.set(oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount: count, objects, deltaCount };
}

/** How many compressed bytes a zlib stream at `offset` occupies (walk the deflate stream). */
function inflatedLength(pack: Buffer, offset: number): number {
  // inflateSync consumed the whole tail; find the stream end by re-inflating incrementally.
  // The deflate stream ends at the first point where inflate of a prefix succeeds fully.
  // Binary-search on length is overkill for our sizes: scan with growing windows.
  let lo = 1;
  let hi = pack.length - offset;
  // The stream must end before the 20-byte trailer.
  hi = Math.min(hi, pack.length - offset - 20);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Write a packfile of plain (non-delta) objects, version 2, with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createSha1(body);
  return Buffer.concat([body, trailer]);
}

import { createHash as nodeCreateHash } from 'node:crypto';
function createSha1(data: Buffer): Buffer {
  return nodeCreateHash('sha1').update(data).digest();
}

/** Verify a pack's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = nodeCreateHash('sha1').update(body).digest('hex');
  return { ok: actual === expected, expected, actual };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * The closure of `roots`: every object reachable from them (commits, their trees and blobs,
 * tag targets). Throws when a referenced object is missing.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (HEX40.test(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are the same commit). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * Commit generations from `wants`: generation 1 is the wants themselves, generation N+1 the
 * parents of generation N. Returns the map commit -> generation, capped at `maxDepth`
 * (Infinity for a full walk).
 */
export function commitGenerations(
  wants: readonly string[],
  lookup: ObjectLookup,
  maxDepth = Infinity,
): Map<string, number> {
  const generations = new Map<string, number>();
  let frontier = [...new Set(wants)].filter((oid) => HEX40.test(oid) && oid !== ZERO_OID);
  let generation = 0;
  while (frontier.length > 0 && generation < maxDepth) {
    generation += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      if (generations.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      generations.set(oid, generation);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return generations;
}

/**
 * The objects a fetch must send for `wants`, given the client's `haves` (objects it already
 * holds) and `shallowBoundaries` (commits whose parents the client does not hold).
 *
 *   - no depth: closure(wants) minus closure(haves, stopping at shallow boundaries).
 *   - depth N: closure of wants limited to N commit generations (trees/blobs of those
 *     commits included), minus closure(haves, stopping at shallow boundaries).
 *
 * Returns the objects plus the new shallow boundaries and the old boundaries that are now
 * fully included (unshallow).
 */
export function fetchPlan(
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  lookup: ObjectLookup,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const held = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  // Closure of haves, stopping at shallow boundaries (their parents are not held).
  const haveQueue = [...haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      haveQueue.push(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) haveQueue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) haveQueue.push(entry.oid);
    } else if (object.type === 'tag') {
      haveQueue.push(parseTag(object.data).object);
    }
  }

  const send = new Set<string>();
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    for (const oid of collectReachable(wants, lookup)) if (!held.has(oid)) send.add(oid);
  } else {
    const generations = commitGenerations(wants, lookup, depth);
    // The commits at generation `depth` are the new shallow boundaries.
    for (const [oid, generation] of generations) if (generation === depth) newShallow.push(oid);
    // Everything reachable from the included commits, minus held objects.
    const include = new Set<string>();
    for (const oid of generations.keys()) {
      const object = lookup(oid);
      if (object === undefined) continue;
      include.add(oid);
      const commit = parseCommit(object.data);
      include.add(commit.tree);
      const treeQueue = [commit.tree];
      while (treeQueue.length > 0) {
        const treeOid = treeQueue.pop()!;
        if (include.has(treeOid) && treeOid !== commit.tree) continue;
        const treeObject = lookup(treeOid);
        if (treeObject === undefined || treeObject.type !== 'tree') continue;
        include.add(treeOid);
        for (const entry of parseTree(treeObject.data)) {
          include.add(entry.oid);
          if (entry.mode === '40000') treeQueue.push(entry.oid);
        }
      }
    }
    // Tags pointing at wanted commits are included too (a want may be a tag oid).
    for (const want of wants) {
      const object = lookup(want);
      if (object !== undefined && object.type === 'tag') {
        include.add(want);
        for (const oid of collectReachable([want], lookup)) include.add(oid);
      }
    }
    for (const oid of include) if (!held.has(oid)) send.add(oid);
    // Old boundaries whose parents are now included are unshallow.
    for (const boundary of shallowBoundaries) {
      if (!generations.has(boundary)) continue;
      const generation = generations.get(boundary)!;
      if (generation < depth) unshallow.push(boundary);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: newShallow, unshallow };
}
