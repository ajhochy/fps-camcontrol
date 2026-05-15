import { AppState, CameraId } from '../app/state';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { logger } from '../index';

const PROBE_EVERY_TICKS = 30; // probe cameras every 30s (watchdog runs at 1s)

export function startWatchdog(
  state: AppState,
  atem: AtemClient,
  viscaClients: Map<CameraId, ViscaClient>
): NodeJS.Timeout {
  let tick = 0;

  return setInterval(() => {
    state.atemConnected = atem.connected;

    tick++;
    if (tick % PROBE_EVERY_TICKS === 0) {
      for (const [id, client] of viscaClients) {
        client.probe().then(reachable => {
          state.cameraConnected[id] = reachable;
          if (!reachable) {
            logger.warn({ cameraId: id }, 'camera probe failed — not reachable');
          }
        }).catch(() => {
          state.cameraConnected[id] = false;
        });
      }
    }
  }, 1000);
}
