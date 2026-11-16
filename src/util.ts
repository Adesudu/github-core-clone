// Shared helpers: hashing, pkt-line codec, base64, the deterministic clock.
// No wall clock and no unseeded randomness anywhere a request can see it:
// dates come from MAKEFUN_TRIAL_NOW (or a fixed epoch), ids from counters.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const HEX40 = /^[0-9a-f]{40}$/;

/** SHA-1 of a git object: `<type> <size>\0` + bytes. */
export function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** URL-safe base64 without padding (opaque global ids). */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Standard base64 of UTF-8 text (contents API). */
export function b64encode(text: string | Buffer): string {
  return Buffer.isBuffer(text) ? text.toString('base64') : Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64, ignoring whitespace/newlines (GitHub wraps content at 60 cols). */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;
/** Largest sideband payload per packet: pkt-line max minus header minus the 1-byte band. */
export const SIDEBAND_MAX = PKT_LINE_MAX - 4 - 1;

/** Encode one data packet: 4 hex length bytes then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload ${data.length} bytes over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a sequence; 'flush' / 'delim' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a whole buffer into pkt-line packets. Stops at the first bytes that are not a
 * pkt-line header and returns them as `trailing` (the raw pack after a receive-pack flush).
 * Throws on a malformed header or a truncated packet.
 */
export function decodePktLines(bytes: Buffer): { packets: Packet[]; trailing: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) break; // raw trailing bytes (a pack)
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, trailing: bytes.subarray(offset) };
}

/** The text of the data packets, in order. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// deterministic clock
// ---------------------------------------------------------------------------------------------

/** The trial's "now" in seconds, or the fixed epoch when the env does not name one. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

/** ISO 8601 UTC for a seconds timestamp. */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}
