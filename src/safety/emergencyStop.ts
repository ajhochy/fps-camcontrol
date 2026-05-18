import { AppState, CameraId } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { toggleLowerThirds } from '../atem/switcherActions';
import { logger } from '../index';

export async function emergencyStopAll(
  state: AppState,
  config: AppConfig,
  atem: AtemClient,
  devices: Map<CameraId, MotionDevice>
): Promise<void> {
  logger.warn('EMERGENCY STOP triggered');
  for (const [, device] of devices) {
    device.stop();
  }
  if (state.lowerThirdsActive) {
    await toggleLowerThirds(atem, state, config, false);
  }
  logger.warn('EMERGENCY STOP complete');
}
