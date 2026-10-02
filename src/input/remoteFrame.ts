/**
 * Validation for everything an iPad (or anything else) can send over /ws/remote-controller. The socket is
 * reachable by whoever is on the network, so nothing from it is trusted: bad input is rejected, numbers are
 * clamped, and a flood is dropped by a token bucket.
 */
export const MAX_PAYLOAD_BYTES = 512;
export const MAX_INVALID_MESSAGES = 20;
export const BUCKET_RATE_PER_S = 60;
export const BUCKET_BURST = 20;
export const MAX_DROPS_PER_WINDOW = 300;
export const DROP_WINDOW_MS = 5000;

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; pin: string | null; pad: { id: string; mapping: string } | null }
  | { t: 'claim' }
  | { t: 'release' }
  | { t: 'idle' }
  | { t: 'stop' }
  | { t: 'select'; camera: string }
  | { t: 'ping'; ts: number }
  | { t: 'in'; s: number; a: number[]; tr: number[]; b: number };

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; reason: string };

const fail = (reason: string): ParseResult => ({ ok: false, reason });
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Trim to a short, printable label (a name goes into the activity log and the desk page). */
export function cleanLabel(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
}

/**
 * Parse and validate one client message. `lastSeq` is the highest input sequence already accepted from this
 * session; an `in` frame must be newer, so reordered or replayed frames never reach the camera.
 */
export function parseClientMessage(raw: string | Buffer, lastSeq: number): ParseResult {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_PAYLOAD_BYTES) return fail('too large');
  let obj: unknown;
  try { obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return fail('not json'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('not an object');
  const m = obj as Record<string, unknown>;
  switch (m.t) {
    case 'hello': {
      if (m.v !== 1) return fail('unsupported version');
      let pin: string | null = null;
      if (m.pin !== undefined && m.pin !== null) {
        if (typeof m.pin !== 'string' || m.pin.length > 16) return fail('bad pin');
        pin = m.pin;
      }
      let pad: { id: string; mapping: string } | null = null;
      if (m.pad && typeof m.pad === 'object') {
        const p = m.pad as Record<string, unknown>;
        pad = { id: cleanLabel(p.id, 80), mapping: cleanLabel(p.mapping, 20) };
      }
      return { ok: true, msg: { t: 'hello', v: 1, name: cleanLabel(m.name, 40), pin, pad } };
    }
    case 'claim': case 'release': case 'idle': case 'stop':
      return { ok: true, msg: { t: m.t } };
    case 'select':
      // Which camera the owning iPad wants to control: a plain id (cam1..), nothing else.
      if (typeof m.camera !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(m.camera)) return fail('bad camera');
      return { ok: true, msg: { t: 'select', camera: m.camera } };
    case 'ping':
      if (!isFiniteNumber(m.ts)) return fail('bad ping');
      return { ok: true, msg: { t: 'ping', ts: m.ts } };
    case 'in': {
      if (!Number.isInteger(m.s) || (m.s as number) <= lastSeq) return fail('stale or bad sequence');
      if (!Array.isArray(m.a) || m.a.length !== 4 || !m.a.every(isFiniteNumber)) return fail('bad axes');
      if (!Array.isArray(m.tr) || m.tr.length !== 2 || !m.tr.every(isFiniteNumber)) return fail('bad triggers');
      if (!Number.isInteger(m.b) || (m.b as number) < 0 || (m.b as number) > 0xffff) return fail('bad buttons');
      return {
        ok: true,
        msg: {
          t: 'in',
          s: m.s as number,
          a: (m.a as number[]).map((v) => clamp(v, -1, 1)),
          tr: (m.tr as number[]).map((v) => clamp(v, 0, 1)),
          b: m.b as number,
        },
      };
    }
    default:
      return fail('unknown type');
  }
}

/** Token bucket: `rate` tokens per second up to `burst`. The clock is injectable for tests. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private rate = BUCKET_RATE_PER_S, private burst = BUCKET_BURST, private now: () => number = Date.now) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events in a sliding window (drops in the last 5 s, bad PINs in the last minute). */
export class WindowCounter {
  private stamps: number[] = [];
  constructor(private windowMs: number, private now: () => number = Date.now) {}
  add(): number {
    this.stamps.push(this.now());
    return this.count();
  }
  count(): number {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && this.stamps[0] < cutoff) this.stamps.shift();
    return this.stamps.length;
  }
  clear(): void { this.stamps = []; }
}
