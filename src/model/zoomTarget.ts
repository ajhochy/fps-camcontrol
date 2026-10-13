import type { AppConfig } from '../config/configLoader';

/** The slice of SonyManager the zoom path needs (tests pass a stub). */
export interface SonyZoom {
  connected(id: string): boolean;
  zoom(id: string, speed: number): Promise<unknown>;
}

export type ZoomTarget = { kind: 'sony'; sonyId: string } | { kind: 'head' };

/**
 * Where a rig's zoom goes. A rig with a bound Sony camera that is connected zooms the camera itself (its power zoom
 * or Clear Image / Digital Zoom); pan/tilt always stays on the head. `zoom: head` on the slot opts out.
 * Kept out of controlStateMachine.ts so a unit test can import it without the app's logger.
 */
export function zoomTarget(
  cameraId: string,
  config: Pick<AppConfig, 'cameras' | 'devices'>,
  sony: { connected(id: string): boolean } | null
): ZoomTarget {
  const rig = config.cameras.find((camera) => camera.id === cameraId);
  if (!sony || !rig?.camera || rig.zoom === 'head') return { kind: 'head' };
  const device = config.devices?.[rig.camera];
  const sonyId = device?.protocol === 'sony' ? device.sonyCameraId : undefined;
  return sonyId && sony.connected(sonyId) ? { kind: 'sony', sonyId } : { kind: 'head' };
}

/** Effective speed (-1..1) to the sidecar's integer -10..10. Only 0 maps to 0: a held trigger always moves. */
export function sonyZoomSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed === 0) return 0;
  const n = Math.round(Math.max(-1, Math.min(1, speed)) * 10);
  return n === 0 ? Math.sign(speed) : n;
}
