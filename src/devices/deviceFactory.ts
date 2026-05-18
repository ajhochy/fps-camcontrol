import { CameraConfig } from '../config/configLoader';
import { ViscaClient } from '../visca/viscaClient';
import { ViscaDevice } from './viscaDevice';
import { DjiBridgeDevice } from './djiBridgeDevice';
import { MotionDevice } from './motionDevice';
import { ActivityLog } from '../app/activityLog';

export function createMotionDevice(cam: CameraConfig, activityLog: ActivityLog | null): MotionDevice {
  if (cam.protocol === 'dji-bridge') {
    if (!cam.bridge) throw new Error(`camera ${cam.id}: dji-bridge protocol requires bridge config`);
    const device = new DjiBridgeDevice(cam.bridge, cam.id, cam.label);
    if (activityLog) device.setActivityLog(activityLog, cam.label);
    return device;
  }
  // Default: visca
  if (!cam.viscaIp) throw new Error(`camera ${cam.id}: visca protocol requires viscaIp`);
  const client = new ViscaClient(cam.id, cam.viscaIp, cam.viscaPort, cam.cameraType);
  const device = new ViscaDevice(client, cam.id, cam.label);
  if (activityLog) device.setActivityLog(activityLog, cam.label);
  return device;
}
