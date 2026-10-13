import { z } from 'zod';

export const MAX_MESSAGE_BYTES = 65536;
const bounded = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const timestamp = z.number().finite().int().nonnegative().safe();
const unit = z.number().finite().min(0).max(1);
const base = { protocol: z.literal(1) };
const session = z.string().uuid();
export function safeFrameUrl(value: string, backendOrigin?: string): boolean {
  try {
    const url = new URL(value);
    const route = /^\/api\/sony\/cameras\/([^/]+)\/live-view\/frame$/.exec(url.pathname);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.search && !url.hash &&
      (!backendOrigin || url.origin === backendOrigin) && !!route && /^[A-Za-z0-9:-]{1,128}$/.test(decodeURIComponent(route[1]));
  } catch { return false; }
}
export const TrackerSourceSchema = z.object({ sourceId: bounded, frameUrl: z.string().max(2048).refine(value => safeFrameUrl(value)) }).strict();
export const ToTrackerSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('hello') }).strict(),
  z.object({ ...base, type: z.literal('configure'), sources: z.array(TrackerSourceSchema).max(64) }).strict(),
  z.object({ ...base, type: z.literal('select'), sourceId: bounded, sessionId: session, x: unit, y: unit }).strict(),
  z.object({ ...base, type: z.literal('cancel'), sourceId: bounded, sessionId: session }).strict(),
  z.object({ ...base, type: z.literal('ping'), nonce: bounded }).strict(),
]);
export const TrackSchema = z.object({ ...base, type: z.literal('track'), sourceId: bounded, sessionId: session,
  seq: timestamp, state: z.enum(['locking', 'tracking', 'lost', 'idle']), cx: unit, cy: unit, w: unit, h: unit, conf: unit,
  frameTs: timestamp, processedAt: timestamp }).strict();
export const FromTrackerSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('hello'), version: bounded, capabilities: z.tuple([z.literal('person')]), detector: bounded, provider: bounded, degradedTiming: z.boolean() }).strict(),
  TrackSchema,
  z.object({ ...base, type: z.literal('pong'), nonce: bounded }).strict(),
  z.object({ ...base, type: z.literal('error'), code: bounded, message: z.string().max(256), sourceId: bounded.optional(), sessionId: session.optional() }).strict(),
  z.object({ ...base, type: z.literal('status'), sourceId: bounded, fps: z.number().finite().nonnegative(), dropped: timestamp, busy: timestamp,
    detectP50Ms: z.number().finite().nonnegative(), detectP95Ms: z.number().finite().nonnegative(), frameAgeMs: z.number().finite().nonnegative(), degradedTiming: z.boolean() }).strict(),
]);
export type TrackerSource = z.infer<typeof TrackerSourceSchema>;
export type ToTracker = z.infer<typeof ToTrackerSchema>;
export type FromTracker = z.infer<typeof FromTrackerSchema>;
export type TrackMessage = z.infer<typeof TrackSchema>;
export function validGeometry(value: Pick<TrackMessage, 'cx'|'cy'|'w'|'h'|'conf'>): boolean {
  return [value.cx, value.cy, value.w, value.h, value.conf].every(Number.isFinite) && value.conf > 0 && value.conf <= 1 && value.w > 0 && value.h > 0 &&
    value.cx - value.w / 2 >= 0 && value.cy - value.h / 2 >= 0 && value.cx + value.w / 2 <= 1 && value.cy + value.h / 2 <= 1;
}
export function parseFromTracker(value: unknown, now = Date.now()): FromTracker | null {
  const parsed = FromTrackerSchema.safeParse(value); if (!parsed.success) return null;
  const m = parsed.data;
  if (m.type === 'track') {
    if (m.processedAt < m.frameTs || m.frameTs > now + 50 || m.processedAt > now + 50) return null;
    if (m.state === 'tracking' ? !validGeometry(m) : (m.conf !== 0 || !((m.cx === 0 && m.cy === 0 && m.w === 0 && m.h === 0) || validGeometry({ ...m, conf: 1 })))) return null;
  }
  return m;
}
export function parseToTracker(value: unknown): ToTracker | null {
  const parsed = ToTrackerSchema.safeParse(value); if (!parsed.success) return null;
  if (parsed.data.type === 'configure' && (new Set(parsed.data.sources.map(x => x.sourceId)).size !== parsed.data.sources.length ||
      new Set(parsed.data.sources.map(x => x.frameUrl)).size !== parsed.data.sources.length)) return null;
  return parsed.data;
}
