import { AtemClient } from './atemClient';
import { AppState, CameraId } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { MotionDevice } from '../devices/motionDevice';
import { logger } from '../index';

// After a take, the camera that just left air becomes both the standby (green)
// and the armed/selected camera the joystick controls. This preserves the
// `controlled === preview` invariant that manual selection maintains, so a
// second switch takes the previous camera back live without the operator
// re-selecting it — the live/standby ping-pong from the old system.
function armPreviousProgramAsStandby(
  state: AppState,
  cameras: CameraConfig[],
  devices: Map<CameraId, MotionDevice>
): void {
  const previousProgram = state.programCamera;
  const nowLive = state.controlledCamera;

  state.programCamera = nowLive;

  if (previousProgram === nowLive) return; // took the already-live camera; nothing to swap

  // The camera we just took goes live — stop any joystick PTZ so it doesn't
  // keep drifting on air once control hands off to the new standby.
  devices.get(nowLive)?.stop();

  state.previewCamera = previousProgram;
  state.controlledCamera = previousProgram;
  const idx = cameras.findIndex(c => c.id === previousProgram);
  if (idx >= 0) state.cameraIndex = idx;
}

/**
 * Note the operator is arming a camera that cannot move, but let the take
 * proceed.
 *
 * Deliberately NOT a hard refusal like the unwired-camera guard below. The two
 * failures are not comparable: an unwired camera has no video at all, so taking
 * it cuts black to air. A camera whose gimbal is off still feeds the switcher a
 * perfectly good picture — it just cannot be panned. Refusing would mean that
 * when a gimbal sleeps mid-service (the RS3 Pros do this on their own) the
 * operator's take silently does nothing and the WRONG camera stays on air, which
 * is a far worse outcome than a static shot. So: log it, show it in the Status
 * tab, and let the human decide.
 */
function warnIfGimbalDetached(
  cam: CameraConfig,
  devices: Map<CameraId, MotionDevice>
): void {
  if (devices.get(cam.id as CameraId)?.gimbalAttached === false) {
    logger.warn(
      { camera: cam.id, label: cam.label },
      'taking a camera live whose gimbal is not attached — video is fine but it cannot be moved'
    );
  }
}

export async function cutControlledCameraLive(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  devices: Map<CameraId, MotionDevice>
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  if (cam.inputId === undefined) {
    logger.warn({ camera: cam.id, label: cam.label }, 'refusing cut: camera has no ATEM input (not wired) — would put black on program');
    return;
  }
  warnIfGimbalDetached(cam, devices);
  await atem.changePreviewInput(cam.inputId);
  await atem.cut();
  armPreviousProgramAsStandby(state, cameras, devices);
  logger.info({ program: state.programCamera, standby: state.previewCamera }, 'cut live');
}

export async function autoTransitionControlledCamera(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  devices: Map<CameraId, MotionDevice>
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  if (cam.inputId === undefined) {
    logger.warn({ camera: cam.id, label: cam.label }, 'refusing take: camera has no ATEM input (not wired) — would put black on program');
    return;
  }
  warnIfGimbalDetached(cam, devices);
  await atem.changePreviewInput(cam.inputId);
  await atem.autoTransition();
  armPreviousProgramAsStandby(state, cameras, devices);
  logger.info({ program: state.programCamera, standby: state.previewCamera }, 'auto transition');
}

/**
 * Mirror the switcher: set state.lowerThirdsActive from the key's real on-air state, so the buttons are right even
 * when someone takes the slides on or off at the ATEM panel. Returns true when it changed.
 */
export function syncLowerThirdsFromAtem(atem: AtemClient, state: AppState, config: AppConfig): boolean {
  const gfx = config.graphics;
  const onAir = atem.graphicsOnAir({ ...gfx, type: gfx.type === 'auto' ? 'dsk' : gfx.type });
  if (onAir === undefined || onAir === state.lowerThirdsActive) return false;
  state.lowerThirdsActive = onAir;
  return true;
}

export async function toggleLowerThirds(
  atem: AtemClient,
  state: AppState,
  config: AppConfig,
  onAir?: boolean,
  instant = false
): Promise<void> {
  const newState = onAir !== undefined ? onAir : !state.lowerThirdsActive;
  const gfx = config.graphics;
  const effectiveType = gfx.type === 'auto' ? 'dsk' : gfx.type;
  // Fade unless explicitly instant (e.g. emergency stop) or the configured
  // fade is 0 frames. USK on-air has no simple auto path, so it stays instant.
  const fade = !instant && gfx.fadeFrames > 0 && effectiveType === 'dsk';

  if (effectiveType === 'dsk') {
    if (fade) {
      await atem.setDownstreamKeyRate(gfx.dskIndex, gfx.fadeFrames);
      await atem.autoDownstreamKey(gfx.dskIndex, newState);
    } else {
      await atem.setDownstreamKeyOnAir(gfx.dskIndex, newState);
    }
  } else {
    await atem.setUpstreamKeyerOnAir(gfx.meIndex, gfx.uskIndex, newState);
  }

  state.lowerThirdsActive = newState;
  logger.info({ newState, type: effectiveType, fade }, 'lower thirds toggled');
}
