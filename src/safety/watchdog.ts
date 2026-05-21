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
        // Use the socket-level connected flag as the source of truth.
        // The VISCA probe (CAM_PowerInq) is just a soft health check — some
        // cameras (e.g. V-BOT) don't reply to that specific inquiry even when
        // they're perfectly responsive to control commands, so a probe miss
        // must NOT force the camera into a disconnected state.
        state.cameraConnected[id] = client.connected;
        client.probe().then(reachable => {
          if (!reachable && client.connected) {
            logger.warn({ cameraId: id }, 'camera probe returned no reply (camera may still be controllable)');
          }
        }).catch(() => { /* ignore */ });
      }
    }
  }, 1000);
}
