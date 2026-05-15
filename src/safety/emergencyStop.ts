import { AppState, CameraId } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { toggleLowerThirds } from '../atem/switcherActions';
import { stopPTZ } from '../visca/ptzActions';
import { logger } from '../index';

export async function emergencyStopAll(
  state: AppState,
  config: AppConfig,
  atem: AtemClient,
  viscaClients: Map<CameraId, ViscaClient>
): Promise<void> {
  logger.warn('EMERGENCY STOP triggered');
  for (const [, client] of viscaClients) {
    stopPTZ(client);
  }
  if (state.lowerThirdsActive) {
    await toggleLowerThirds(atem, state, config, false);
  }
  logger.warn('EMERGENCY STOP complete');
}
