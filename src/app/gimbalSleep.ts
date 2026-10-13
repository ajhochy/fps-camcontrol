import type { AppState } from './state';
import type { MotionDevice } from '../devices/motionDevice';
import type { TrackingHooks } from './trackingHooks';

/** A rig counts as being driven for this long after the last non-zero stick velocity or move-to. */
export const DRIVEN_WITHIN_MS = 2000;

export const SLEEP_OLD_BRIDGE_MESSAGE = 'Update the Pi bridge to 0.7.0 to use Sleep';

/**
 * Why putting this gimbal to sleep must be refused right now, or null when it is allowed.
 * Sleep switches the motors off, so the gimbal goes limp: never while the rig is live or in use.
 *  1. the rig is on PROGRAM (ATEM program input);
 *  2. a tracking session is active on it;
 *  3. it is being driven: the shared motion ledger says it is moving, or the stick/preset commanded motion
 *     within the last DRIVEN_WITHIN_MS.
 * Pure: everything it reads is passed in, so every branch is unit-tested.
 */
export function sleepRefusal(
  cameraId: string,
  ctx: { state: Pick<AppState, 'programCamera'>; device?: MotionDevice; tracking?: TrackingHooks; now?: number },
): string | null {
  if (ctx.state.programCamera === cameraId) return 'this rig is on PROGRAM (live): it will not be put to sleep';
  const sessions = Object.values(ctx.tracking?.manager.getStatus() ?? {});
  if (sessions.some((s) => s.cameraId === cameraId && !!s.sessionId)) return 'tracking is active on this rig: cancel tracking first';
  if (ctx.device && (ctx.tracking?.ledger.isMoving(ctx.device) || ctx.device.recentlyDriven?.(DRIVEN_WITHIN_MS, ctx.now))) {
    return 'this rig is being driven (motion in progress): let it stop first';
  }
  return null;
}
