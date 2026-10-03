import { AppState, CameraId } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { toggleLowerThirds } from '../atem/switcherActions';
import { logger } from '../index';
import { trackingFor } from '../app/trackingHooks';
import { SonyZoom, zoomTarget } from '../model/zoomTarget';

export async function emergencyStopAll(
  state: AppState,
  config: AppConfig,
  atem: AtemClient,
  devices: Map<CameraId, MotionDevice>,
  sony: SonyZoom | null = null
): Promise<void> {
  logger.warn('EMERGENCY STOP triggered');
  const tracking = trackingFor(state);
  tracking?.manager.emergencyStop({ stopDevices: false });
  for (const [, device] of devices) {
    if (tracking) tracking.ledger.stop(device); else device.stop();
  }
  // A rig whose zoom is its Sony camera's: stop that zoom too (best effort, never blocks the stop).
  for (const camera of config.cameras) {
    const target = zoomTarget(camera.id, config, sony);
    if (target.kind === 'sony') sony?.zoom(target.sonyId, 0).catch(() => undefined);
  }
  if (state.lowerThirdsActive) {
    await toggleLowerThirds(atem, state, config, false, true); // instant kill, no fade
  }
  logger.warn('EMERGENCY STOP complete');
}
