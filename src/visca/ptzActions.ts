import { ViscaClient } from './viscaClient';

// VISCA-over-IP uses an 8-byte header before the VISCA payload
function viscaIpPacket(payload: number[]): Buffer {
  const header = [0x01, 0x00, 0x00, payload.length, 0x00, 0x00, 0x00, 0x01];
  return Buffer.from([...header, ...payload]);
}

export type CameraType = 'birddog' | 'vbot' | 'generic';

// Convert -1..1 speed to VISCA speed byte, clamped to camera's max
function toViscaSpeed(normalized: number, maxSpeed: number): number {
  return Math.max(1, Math.min(maxSpeed, Math.round(Math.abs(normalized) * maxSpeed)));
}

export function panTilt(
  client: ViscaClient,
  panSpeed: number,  // -1 to 1
  tiltSpeed: number, // -1 to 1
  cameraType: CameraType = 'generic'
): void {
  // V-BOT cameras cap at speed 0x14 (20) instead of 0x18 (24)
  const maxSpeed = cameraType === 'vbot' ? 0x14 : 0x18;
  const panByte = toViscaSpeed(panSpeed, maxSpeed);
  const tiltByte = toViscaSpeed(tiltSpeed, maxSpeed);

  let panDir: number;
  if (Math.abs(panSpeed) < 0.02) panDir = 0x03; // stop
  else panDir = panSpeed > 0 ? 0x02 : 0x01;     // right : left

  let tiltDir: number;
  if (Math.abs(tiltSpeed) < 0.02) {
    tiltDir = 0x03; // stop
  } else if (cameraType === 'vbot') {
    // V-BOT has inverted tilt convention: 0x01=down, 0x02=up
    tiltDir = tiltSpeed > 0 ? 0x01 : 0x02;
  } else {
    // Standard VISCA: tilt up = 0x01... but BirdDog uses 0x02=up like pan-right convention
    tiltDir = tiltSpeed > 0 ? 0x02 : 0x01;
  }

  const payload = [0x81, 0x01, 0x06, 0x01, panByte, tiltByte, panDir, tiltDir, 0xFF];
  client.send(viscaIpPacket(payload));
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
  const payload = [0x81, 0x01, 0x04, 0x07, cmd, 0xFF];
  client.send(viscaIpPacket(payload));
}

export function stopPTZ(client: ViscaClient): void {
  panTilt(client, 0, 0);
  zoom(client, 0);
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

  const payload = [
    0x81, 0x01, 0x06, 0x02,
    panSpeed, tiltSpeed,
    (pan >> 12) & 0xF, (pan >> 8) & 0xF, (pan >> 4) & 0xF, pan & 0xF,
    (tilt >> 12) & 0xF, (tilt >> 8) & 0xF, (tilt >> 4) & 0xF, tilt & 0xF,
    0xFF
  ];
  client.send(viscaIpPacket(payload));

  // Zoom separately
  const zPayload = [
    0x81, 0x01, 0x04, 0x47,
    (z >> 12) & 0xF, (z >> 8) & 0xF, (z >> 4) & 0xF, z & 0xF,
    0xFF
  ];
  client.send(viscaIpPacket(zPayload));
}

// Send position inquiries (fire-and-forget, for callers that handle responses via the 'message' event)
export function queryPosition(client: ViscaClient): void {
  const ptPayload = [0x81, 0x09, 0x06, 0x12, 0xFF];
  client.send(viscaIpPacket(ptPayload));
  const zPayload = [0x81, 0x09, 0x04, 0x47, 0xFF];
  client.send(viscaIpPacket(zPayload));
}

// Async version that returns the parsed position. Throws on timeout.
export async function queryPositionAsync(client: ViscaClient): Promise<PTZPosition> {
  const { pan, tilt } = await client.queryPanTilt();
  const z = await client.queryZoom();
  return { pan, tilt, zoom: z };
}
