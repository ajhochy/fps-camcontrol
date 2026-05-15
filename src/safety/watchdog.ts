import { AppState, CameraId } from '../app/state';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';

export function startWatchdog(
  state: AppState,
  atem: AtemClient,
  viscaClients: Map<CameraId, ViscaClient>
): NodeJS.Timeout {
  return setInterval(() => {
    state.atemConnected = atem.connected;
    for (const [id, client] of viscaClients) {
      state.cameraConnected[id] = client.connected;
    }
  }, 1000);
}
