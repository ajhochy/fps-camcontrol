import type { AppConfig } from '../config/configLoader';

/** Physical inventory identity survives profile/working-copy slot changes. */
export function resolveTrackingSources(config: AppConfig) {
  return (config.tracking?.sources ?? []).map(source => ({
    ...source,
    sourceId: source.device,
    cameraId: config.cameras.find(camera => camera.deviceKey === source.device)?.id ?? null,
  }));
}
