import path from 'node:path';
import { z } from 'zod';

/**
 * devices.yaml `programCapture:` (issue #95) and `streaming:` (issue #69) blocks. Both are optional: an existing config
 * loads with capture off and streaming idle. These are separate from `program:` (the preview's fps/width), whose meaning
 * does not change.
 */

/** Modes the capture helper accepts as its initial/fallback mode (auto-detect still picks the real one). */
export const CAPTURE_MODES = ['720p50', '720p5994', '720p60', '1080p25', '1080p2997', '1080p30', '1080p50', '1080p5994', '1080p60', '1080i50', '1080i5994', '1080i60'] as const;
export const ProgramCaptureSchema = z.object({
  enabled: z.boolean().default(false),
  /** DeckLink device index or name substring; null = first input-capable device. */
  device: z.string().regex(/^[\w .:-]{1,100}$/, 'device may contain letters, digits, spaces and . : - _ only').nullable().default(null),
  mode: z.enum(CAPTURE_MODES, { message: `mode must be one of ${CAPTURE_MODES.join(', ')}` }).default('1080p30'),
  /** Per-consumer queue (frames) before that consumer's video is dropped. */
  queueFrames: z.number().int().min(2).max(120).default(12),
  /** A consumer blocked this long is dropped (the others never wait for it). */
  stallMs: z.number().int().min(250).max(30_000).default(2000),
}).strict();
export type ProgramCaptureConfig = z.infer<typeof ProgramCaptureSchema>;

/**
 * Qualified output profiles. 1080p30 at exactly 30/1 is what the UltraStudio Recorder 3G delivers (#64 evidence,
 * 2026-10-15); 1080p29.97 (30000/1001) is proven end to end on the synthetic path (#68). Nothing else is offered,
 * and nothing is substituted: an unknown profile is an error, never "the nearest one".
 */
export const STREAMING_PROFILES = {
  '1080p30': { width: 1920, height: 1080, fps: '30/1', captureMode: '1080p30' },
  '1080p2997': { width: 1920, height: 1080, fps: '30000/1001', captureMode: '1080p2997' },
} as const;
export type StreamingProfileName = keyof typeof STREAMING_PROFILES;
const PROFILE_NAMES = Object.keys(STREAMING_PROFILES) as [StreamingProfileName, ...StreamingProfileName[]];
/** tee slave paths: no tee separators/quoting, no control whitespace (inner spaces are fine, see teeArgs.ts). */
const FOLDER_UNSAFE = /[\[\]|:\\'",=\t\n\r\f\v]/;

export const StreamingSchema = z.object({
  /** Off: the Streaming page shows setup only and no session can start. */
  enabled: z.boolean().default(false),
  /** The program capture service is the only source (sessions never open the card themselves, #70). */
  source: z.literal('program-capture', { message: "source must be 'program-capture' (the shared program capture)" }).default('program-capture'),
  profile: z.enum(PROFILE_NAMES, { message: `Unsupported streaming profile: qualified profiles are ${PROFILE_NAMES.join(', ')}` }).default('1080p30'),
  videoBitrateKbps: z.number({ message: 'videoBitrateKbps must be a number' }).int('videoBitrateKbps must be a whole number').min(2500, 'videoBitrateKbps must be at least 2500').max(12000, 'videoBitrateKbps must be at most 12000').default(6000),
  /** Absolute folder for MP4 recordings; null = not chosen yet (sessions refuse to start). */
  recordingFolder: z.string()
    .refine(p => path.isAbsolute(p), 'recordingFolder must be an absolute path')
    .refine(p => !FOLDER_UNSAFE.test(p) && !/\s$/.test(p), 'recordingFolder cannot contain [ ] | : \\ \' " , = or end in a space')
    .refine(p => p.length <= 400, 'recordingFolder is too long')
    .nullable().default(null),
  /** Video delay applied once before the encoder, so the MP4 and the stream share it (#68). */
  videoDelayFrames: z.number({ message: 'videoDelayFrames must be a number' }).int('videoDelayFrames must be a whole number of frames').min(0, 'videoDelayFrames must be 0-15').max(15, 'videoDelayFrames must be 0-15').default(0),
}).strict();
export type StreamingConfig = z.infer<typeof StreamingSchema>;

export type FieldError = { field: string; message: string };
/** Specific, per-field errors (unknown keys included) for the API; never a silent fallback. */
export function validateStreaming(input: unknown): { ok: true; value: StreamingConfig } | { ok: false; errors: FieldError[] } {
  const r = StreamingSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map(i => ({ field: i.code === 'unrecognized_keys' ? (i as { keys?: string[] }).keys?.join(', ') ?? '' : i.path.join('.'), message: i.code === 'unrecognized_keys' ? `Unknown setting: ${(i as { keys?: string[] }).keys?.join(', ')}` : i.message })) };
}

/** Fields that define what a running session is producing: none may change while a session runs (#69). */
export const SESSION_LOCKED_FIELDS: readonly (keyof StreamingConfig)[] = ['source', 'profile', 'videoBitrateKbps', 'recordingFolder', 'videoDelayFrames'];
export const CAPTURE_LOCKED_FIELDS: readonly (keyof ProgramCaptureConfig)[] = ['enabled', 'device', 'mode'];
export function changedFields<T extends object>(before: T, after: T, fields: readonly (keyof T)[]): (keyof T)[] {
  return fields.filter(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}
