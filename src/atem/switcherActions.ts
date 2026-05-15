import { AtemClient } from './atemClient';
import { AppState } from '../app/state';
import { CameraConfig } from '../config/configLoader';
import { GamepadDevice } from '../input/gamepad';
import { logger } from '../index';

export async function cutControlledCameraLive(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  meIndex = 0,
  gamepad?: GamepadDevice
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId, meIndex);
  await atem.cut(meIndex);
  state.programCamera = state.controlledCamera;
  logger.info({ camera: state.controlledCamera }, 'cut live');
  gamepad?.rumble(60);
}

export async function autoTransitionControlledCamera(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[],
  meIndex = 0,
  gamepad?: GamepadDevice
): Promise<void> {
  if (atem.isTransitionInProgress(meIndex)) {
    logger.warn({ camera: state.controlledCamera }, 'auto-transition skipped: transition already in progress');
    return;
  }
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId, meIndex);
  await atem.autoTransition(meIndex);
  state.programCamera = state.controlledCamera;
  logger.info({ camera: state.controlledCamera }, 'auto transition');
  gamepad?.rumble(60);
}
