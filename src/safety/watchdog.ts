import { AppState, CameraId, applyDeviceLinkState } from '../app/state';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { ViscaDevice } from '../devices/viscaDevice';
import { viscaTransportInfo } from '../visca/viscaClient';
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
    // First sweep 2 s after start so the tiles say something real quickly, then every 30 s.
    if (tick === 2 || tick % PROBE_EVERY_TICKS === 0) {
      const transport = viscaTransportInfo();
      state.viscaRepliesHeard = transport.localPort === null ? null : transport.onStandardPort;
      for (const [id, device] of devices) {
        if (device instanceof ViscaDevice) {
          const client = device.client;
        // `connected` only says the app's VISCA socket is open (UDP has no link to lose). Whether the camera is
        // actually there is told by its replies: the probe asks power status, then pan/tilt position, and any
        // reply counts. A miss does not mark the camera disconnected (commands may still work), it marks it as
        // not answering, which the Status page shows.
        applyDeviceLinkState(state, id, { connected: client.connected });
        client.probe().then(reachable => {
          state.cameraAnswering[id] = reachable;
          if (client.lastReplyAt !== null) state.cameraLastReplyAt[id] = client.lastReplyAt;
          if (!reachable && client.connected) {
            throttledLog.warn(`probe-${id}`, 300000, { cameraId: id }, 'camera did not answer VISCA inquiries');
          }
        }).catch(() => { /* ignore */ });
          continue;
        }
        // `probe()` on a DJI bridge pings the Pi, which keeps acking with no
        // gimbal attached — so it measures the bridge, not the camera. Pair it
        // with the device's own gimbal verdict, or this 30s sweep would keep
        // resurrecting a dead gimbal as "connected".
        const details = device as MotionDevice & { reportedGimbalModel?: string | null; motionResponsive?: boolean; linkHealth?: import('../app/state').GimbalLinkHealth | null; reportedAsleep?: boolean | null };
        device.probe().then(reachable => {
          applyDeviceLinkState(state, id, { connected: reachable, gimbalAttached: device.gimbalAttached, reportedGimbalModel: details.reportedGimbalModel, motionResponsive: details.motionResponsive, linkHealth: details.linkHealth, reportedAsleep: details.reportedAsleep });
          if (!reachable) {
            logger.warn({ cameraId: id }, 'camera probe failed — not reachable');
          }
        }).catch(() => {
          applyDeviceLinkState(state, id, { connected: false, gimbalAttached: device.gimbalAttached, reportedGimbalModel: details.reportedGimbalModel, motionResponsive: details.motionResponsive, linkHealth: details.linkHealth, reportedAsleep: details.reportedAsleep });
        });
      }
    }
  }, 1000);
}
