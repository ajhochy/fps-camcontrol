import { AtemClient } from './atemClient';
import { AppState, CameraId } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { ViscaClient } from '../visca/viscaClient';
import { stopPTZ } from '../visca/ptzActions';
import { logger } from '../index';

// After a take, the camera that just left air becomes both the standby (green)
// and the armed/selected camera the joystick controls. This preserves the
// `controlled === preview` invariant that manual selection maintains, so a
// second switch takes the previous camera back live without the operator
// re-selecting it — the live/standby ping-pong from the old system.
function armPreviousProgramAsStandby(
  state: AppState,
  cameras: CameraConfig[],
  viscaClients: Map<CameraId, ViscaClient>
): void {
  const previousProgram = state.programCamera;
  const nowLive = state.controlledCamera;

  state.programCamera = nowLive;

  if (previousProgram === nowLive) return; // took the already-live camera; nothing to swap

  // The camera we just took goes live — stop any joystick PTZ so it doesn't
  // keep drifting on air once control hands off to the new standby.
  const liveClient = viscaClients.get(nowLive);
  if (liveClient) stopPTZ(liveClient);

  state.previewCamera = previousProgram;
  state.controlledCamera = previousProgram;
  const idx = cameras.findIndex(c => c.id === previousProgram);
  if (idx >= 0) state.cameraIndex = idx;
}

export async function cutControlledCameraLive(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  viscaClients: Map<CameraId, ViscaClient>
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId);
  await atem.cut();
  armPreviousProgramAsStandby(state, cameras, viscaClients);
  logger.info({ program: state.programCamera, standby: state.previewCamera }, 'cut live');
}

export async function autoTransitionControlledCamera(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  viscaClients: Map<CameraId, ViscaClient>
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId);
  await atem.autoTransition();
  armPreviousProgramAsStandby(state, cameras, viscaClients);
  logger.info({ program: state.programCamera, standby: state.previewCamera }, 'auto transition');
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
