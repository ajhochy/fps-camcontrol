import type { AppConfig } from '../config/configLoader';

export interface ResolvedSource {
  sonyCameraId: string; device: string; invertPan: boolean; invertTilt: boolean;
  sourceId: string; cameraId: string | null;
  /** True when derived from the rig (gimbal + bound Sony camera) rather than listed in `tracking.sources`. */
  auto?: boolean;
}

const MAX_SOURCES = 8;
const TRACKABLE = new Set(['dji-bridge', 'visca']);

/**
 * Tracking sources: explicit `tracking.sources` entries (kept as written, they override per device),
 * plus - unless `tracking.autoSources` is false - one per rig in the active profile whose controller is a
 * DJI gimbal (dji-bridge) or a VISCA head and which has a Sony camera with a known camera id bound. VISCA
 * heads are driven through the dead-man ViscaTrackingDriver (the head keeps moving until told to stop). Physical inventory identity
 * (device key) is the source id; it survives profile/working-copy slot changes.
 */
export function resolveTrackingSources(config: AppConfig): ResolvedSource[] {
  const explicit = config.tracking?.sources ?? [];
  const cameraFor = (device: string) => config.cameras.find(camera => camera.deviceKey === device)?.id ?? null;
  const sources: ResolvedSource[] = explicit.map(source => ({ ...source, sourceId: source.device, cameraId: cameraFor(source.device) }));
  if (config.tracking?.autoSources === false) return sources;
  const devices = config.devices ?? {};
  const takenDevices = new Set(explicit.map(source => source.device));
  const takenCameras = new Set(explicit.map(source => source.sonyCameraId.toUpperCase()));
  for (const camera of config.cameras) {
    if (sources.length >= MAX_SOURCES) break;
    const device = camera.deviceKey;
    if (!device || !TRACKABLE.has(camera.protocol) || !camera.camera || takenDevices.has(device)) continue;
    if (devices[device]?.protocol !== camera.protocol) continue;
    const sony = devices[camera.camera];
    const sonyCameraId = sony?.protocol === 'sony' ? sony.sonyCameraId : undefined;
    if (!sonyCameraId || takenCameras.has(sonyCameraId.toUpperCase())) continue;
    takenDevices.add(device); takenCameras.add(sonyCameraId.toUpperCase());
    sources.push({ sonyCameraId, device, invertPan: false, invertTilt: false, sourceId: device, cameraId: camera.id, auto: true });
  }
  return sources;
}
