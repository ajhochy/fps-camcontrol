import { ViscaClient } from './viscaClient';

// Pan speed: VISCA spec 0x01–0x18 (1–24)
function toPanSpeed(normalized: number): number {
  return Math.max(1, Math.min(0x18, Math.round(Math.abs(normalized) * 0x18)));
}

// Tilt speed: VISCA spec 0x01–0x14 (1–20)
function toTiltSpeed(normalized: number): number {
  return Math.max(1, Math.min(0x14, Math.round(Math.abs(normalized) * 0x14)));
}

export function panTilt(
  client: ViscaClient,
  panSpeed: number,  // -1 to 1, positive = right
  tiltSpeed: number  // -1 to 1, positive = up
): void {
  const panByte = toPanSpeed(panSpeed);
  const tiltByte = toTiltSpeed(tiltSpeed);

  // Pan: right=0x02, left=0x01, stop=0x03
  let panDir: number;
  if (Math.abs(panSpeed) < 0.02) panDir = 0x03;
  else panDir = panSpeed > 0 ? 0x02 : 0x01;

  // Tilt: up=0x01, down=0x02, stop=0x03 (per VISCA spec)
  let tiltDir: number;
  if (Math.abs(tiltSpeed) < 0.02) tiltDir = 0x03;
  else tiltDir = tiltSpeed > 0 ? 0x01 : 0x02;

  client.sendPayload([0x81, 0x01, 0x06, 0x01, panByte, tiltByte, panDir, tiltDir, 0xFF]);
}

export function zoom(
  client: ViscaClient,
  zoomSpeed: number  // -1 to 1
): void {
  let cmd: number;
  if (Math.abs(zoomSpeed) < 0.02) {
    cmd = 0x00; // stop
  } else if (zoomSpeed > 0) {
    const speed = Math.max(1, Math.min(7, Math.round(zoomSpeed * 7)));
    cmd = 0x20 | speed; // tele
  } else {
    const speed = Math.max(1, Math.min(7, Math.round(-zoomSpeed * 7)));
    cmd = 0x30 | speed; // wide
  }
  client.sendPayload([0x81, 0x01, 0x04, 0x07, cmd, 0xFF]);
}

export function stopPanTilt(client: ViscaClient): void {
  client.sendPayload([0x81, 0x01, 0x06, 0x01, 0x00, 0x00, 0x03, 0x03, 0xFF]);
}

export function stopZoom(client: ViscaClient): void {
  client.sendPayload([0x81, 0x01, 0x04, 0x07, 0x00, 0xFF]);
}

export function stopPTZ(client: ViscaClient): void {
  stopPanTilt(client);
  stopZoom(client);
}

export interface PTZPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

export function gotoAbsolutePosition(
  client: ViscaClient,
  pos: PTZPosition,
  panSpeed = 12,
  tiltSpeed = 12
): void {
  const pan = pos.pan;
  const tilt = pos.tilt;
  const z = pos.zoom;

  client.sendPayload([
    0x81, 0x01, 0x06, 0x02,
    panSpeed, tiltSpeed,
    (pan >> 12) & 0xF, (pan >> 8) & 0xF, (pan >> 4) & 0xF, pan & 0xF,
    (tilt >> 12) & 0xF, (tilt >> 8) & 0xF, (tilt >> 4) & 0xF, tilt & 0xF,
    0xFF
  ]);

  client.sendPayload([
    0x81, 0x01, 0x04, 0x47,
    (z >> 12) & 0xF, (z >> 8) & 0xF, (z >> 4) & 0xF, z & 0xF,
    0xFF
  ]);
}

export async function queryPosition(client: ViscaClient): Promise<PTZPosition> {
  const [pt, z] = await Promise.all([
    client.queryPanTilt(),
    client.queryZoom(),
  ]);
  return { pan: pt.pan, tilt: pt.tilt, zoom: z.zoom };
}
