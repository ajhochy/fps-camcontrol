import { z } from 'zod';

const SidecarUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search;
}, 'Tracking sidecar must be a ws/wss URL without credentials or fragment');

export const TrackingSchema = z.object({
  enabled: z.boolean().default(false),
  /** Derive a source for every active gimbal rig that has a Sony camera; explicit `sources` entries override per device. */
  autoSources: z.boolean().default(true),
  sidecarUrl: SidecarUrl.default('ws://127.0.0.1:7900'),
  maxSpeed: z.number().finite().min(.05).max(1).default(.35),
  /** Extra cap for VISCA heads (their speed steps are coarse and unfiltered); the effective cap is min(maxSpeed, viscaMaxSpeed). */
  viscaMaxSpeed: z.number().finite().min(.05).max(1).default(.3),
  deadzone: z.number().finite().min(0).max(.3).default(.04),
  lostHoldMs: z.number().int().min(0).max(30000).default(3000),
  reacquireMs: z.number().int().min(100).max(5000).default(1000),
  pipelineDelayMs: z.number().finite().min(0).max(2000).default(300),
  kp: z.number().finite().min(0).max(5).default(1.2),
  kd: z.number().finite().min(0).max(2).default(.12),
  sources: z.array(z.object({
    sonyCameraId: z.string().regex(/^[A-Za-z0-9:-]{1,128}$/),
    device: z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Tracking device key cannot contain control characters'),
    invertPan: z.boolean().default(false),
    invertTilt: z.boolean().default(false),
  }).strict()).max(8).default([]),
}).strict();
export type TrackingConfig = z.infer<typeof TrackingSchema>;

export function collectTrackingIssues(tracking: TrackingConfig | undefined, devices: Record<string, {protocol: string}> = {}) {
  const issues: {message:string;path:(string|number)[]}[] = [];
  const deviceKeys = new Set<string>(), sonyIds = new Set<string>();
  for (const [i, source] of (tracking?.sources ?? []).entries()) {
    const device = devices[source.device];
    if (!device || !['dji-bridge', 'visca'].includes(device.protocol)) issues.push({message:`Tracking source ${source.device} requires an existing dji-bridge or visca inventory device`,path:['tracking','sources',i,'device']});
    if (deviceKeys.has(source.device) || sonyIds.has(source.sonyCameraId.toUpperCase())) issues.push({message:`Duplicate tracking source ${source.device}: each device and Sony camera may be mapped only once`,path:['tracking','sources',i]});
    deviceKeys.add(source.device); sonyIds.add(source.sonyCameraId.toUpperCase());
  }
  return issues;
}

export function resolveTrackingConfig(raw: unknown, env = process.env): TrackingConfig {
  const config = TrackingSchema.parse(raw ?? {});
  if (env.TRACKING_ENABLED !== undefined) {
    if (!['true','false','1','0'].includes(env.TRACKING_ENABLED)) throw new Error('TRACKING_ENABLED must be true, false, 1, or 0');
    config.enabled = ['true','1'].includes(env.TRACKING_ENABLED);
  }
  if (env.TRACKING_SIDECAR_URL !== undefined) config.sidecarUrl = SidecarUrl.parse(env.TRACKING_SIDECAR_URL);
  return config;
}
