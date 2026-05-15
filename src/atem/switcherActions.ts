import { AtemClient } from './atemClient';
import { AppState } from '../app/state';
import { CameraConfig } from '../config/configLoader';
import { logger } from '../index';

export async function cutControlledCameraLive(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[]
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId);
  await atem.cut();
  state.programCamera = state.controlledCamera;
  logger.info({ camera: state.controlledCamera }, 'cut live');
}

export async function autoTransitionControlledCamera(
  atem: AtemClient,
  state: AppState,
  cameras: CameraConfig[]
): Promise<void> {
  const cam = cameras.find(c => c.id === state.controlledCamera);
  if (!cam) return;
  await atem.changePreviewInput(cam.inputId);
  await atem.autoTransition();
  state.programCamera = state.controlledCamera;
  logger.info({ camera: state.controlledCamera }, 'auto transition');
}
