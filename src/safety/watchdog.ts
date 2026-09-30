import { AppState, CameraId, applyDeviceLinkState } from '../app/state';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { ViscaDevice } from '../devices/viscaDevice';
import { throttledLog } from '../app/logThrottle';
import { logger } from '../index';

const PROBE_EVERY_TICKS = 30; // probe cameras every 30s (watchdog runs at 1s)

export function startWatchdog(
  state: AppState,
  atem: AtemClient,
  devices: Map<CameraId, MotionDevice>
): NodeJS.Timeout {
  let tick = 0;

  return setInterval(() => {
    state.atemConnected = atem.connected;

    tick++;
    if (tick % PROBE_EVERY_TICKS === 0) {
      for (const [id, device] of devices) {
        if (device instanceof ViscaDevice) {
          const client = device.client;
        // Use the socket-level connected flag as the source of truth.
        // The VISCA probe (CAM_PowerInq) is just a soft health check — some
        // cameras (e.g. V-BOT) don't reply to that specific inquiry even when
        // they're perfectly responsive to control commands, so a probe miss
        // must NOT force the camera into a disconnected state.
        applyDeviceLinkState(state, id, { connected: client.connected });
        client.probe().then(reachable => {
          if (!reachable && client.connected) {
            throttledLog.warn(`probe-${id}`, 300000, { cameraId: id }, 'camera probe returned no reply (camera may still be controllable)');
          }
        }).catch(() => { /* ignore */ });
          continue;
        }
        // `probe()` on a DJI bridge pings the Pi, which keeps acking with no
        // gimbal attached — so it measures the bridge, not the camera. Pair it
        // with the device's own gimbal verdict, or this 30s sweep would keep
        // resurrecting a dead gimbal as "connected".
        device.probe().then(reachable => {
          applyDeviceLinkState(state, id, { connected: reachable, gimbalAttached: device.gimbalAttached });
          if (!reachable) {
            logger.warn({ cameraId: id }, 'camera probe failed — not reachable');
          }
        }).catch(() => {
          applyDeviceLinkState(state, id, { connected: false, gimbalAttached: device.gimbalAttached });
        });
      }
    }
  }, 1000);
}
