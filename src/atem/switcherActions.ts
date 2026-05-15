import { AtemClient } from './atemClient';
import { AppState } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
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

export async function toggleLowerThirds(
  atem: AtemClient,
  state: AppState,
  config: AppConfig,
  onAir?: boolean
): Promise<void> {
  const newState = onAir !== undefined ? onAir : !state.lowerThirdsActive;
  const gfx = config.graphics;
  const effectiveType = gfx.type === 'auto' ? 'dsk' : gfx.type;

  if (effectiveType === 'dsk') {
    await atem.setDownstreamKeyOnAir(gfx.dskIndex, newState);
  } else {
    await atem.setUpstreamKeyerOnAir(gfx.meIndex, gfx.uskIndex, newState);
  }

  state.lowerThirdsActive = newState;
  logger.info({ newState, type: effectiveType }, 'lower thirds toggled');
}
