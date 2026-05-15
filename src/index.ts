import pino from 'pino';
import path from 'path';

export const logger = (global as any).__testLogger ?? pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
  level: process.env.LOG_LEVEL ?? 'info',
});

import { loadConfig } from './config/configLoader';
import { defaultState, AppState, CameraId } from './app/state';
import { AtemClient } from './atem/atemClient';
import { ViscaClient } from './visca/viscaClient';
import { loadProfiles, findConnectedController } from './input/profileDetector';
import { GamepadDevice } from './input/gamepad';
import { normalizeHIDReport } from './input/normalizers';
import { ControlStateMachine } from './model/controlStateMachine';
import { PresetManager } from './model/presetManager';
import { startControllerLoop } from './app/controllerLoop';
import { createStatusServer, startStatusServer } from './ui/statusServer';
import { startWatchdog } from './safety/watchdog';
import { CalibrationWizard } from './input/calibrationWizard';

async function main() {
  logger.info('FPS CamControl starting…');

  const config = loadConfig();
  const state: AppState = { ...defaultState };

  // Step 1: Connect to ATEM
  const atem = new AtemClient(config.atem.ip);
  try {
    await atem.connect();
  } catch (err) {
    logger.warn({ err }, 'ATEM initial connection failed, will retry in background');
  }

  // Step 2: Connect to cameras (non-blocking)
  const viscaClients = new Map<CameraId, ViscaClient>();
  for (const cam of config.cameras) {
    const client = new ViscaClient(cam.id, cam.viscaIp, cam.viscaPort);
    client.on('connected', () => {
      state.cameraConnected[cam.id as CameraId] = true;
    });
    client.on('disconnected', () => {
      state.cameraConnected[cam.id as CameraId] = false;
    });
    viscaClients.set(cam.id as CameraId, client);
    client.connect();
  }

  // Step 3 & 4: Detect controller and load profile
  const profilesDir = path.join(process.cwd(), 'controller-profiles');
  const profiles = loadProfiles(profilesDir);
  const found = findConnectedController(profiles);

  const presetManager = new PresetManager(state, config, viscaClients);
  const machine = new ControlStateMachine(state, config, atem, viscaClients);

  if (found) {
    logger.info({ profile: found.profile.name }, 'controller profile loaded');
    const gamepad = new GamepadDevice(found.device.vendorId, found.device.productId);

    gamepad.on('connected', () => {
      state.controllerConnected = true;
      logger.info('controller connected');
    });
    gamepad.on('disconnected', () => {
      state.controllerConnected = false;
      logger.warn('controller disconnected, will retry');
    });
    gamepad.on('data', (data: Buffer) => {
      const input = normalizeHIDReport(data, found.profile);
      machine.updateInput(input);
    });
    gamepad.open();
  } else {
    logger.warn('no known controller found — calibration wizard available at http://localhost:8080');
    const wizard = new CalibrationWizard();
    wizard.start();
  }

  // Step 6 & 7: Read ATEM program/preview, set controlled camera
  if (atem.connected) {
    const previewInputId = atem.getPreviewInput() ?? config.cameras[1].inputId;
    const cam = config.cameras.find(c => c.inputId === previewInputId);
    if (cam) {
      state.controlledCamera = cam.id as CameraId;
      state.cameraIndex = config.cameras.indexOf(cam);
    } else {
      state.controlledCamera = 'cam2';
      state.cameraIndex = 1;
    }
    const programInputId = atem.getProgramInput() ?? config.cameras[1].inputId;
    const pgmCam = config.cameras.find(c => c.inputId === programInputId);
    if (pgmCam) state.programCamera = pgmCam.id as CameraId;
  } else {
    state.controlledCamera = 'cam2';
    state.cameraIndex = 1;
  }
  state.previewCamera = state.controlledCamera;

  // Step 8: Sync ATEM preview to controlledCamera
  const controlledCam = config.cameras.find(c => c.id === state.controlledCamera);
  if (controlledCam && atem.connected) {
    await atem.changePreviewInput(controlledCam.inputId);
  }

  // Step 9: Start controller loop
  startControllerLoop(machine);

  // Watchdog
  startWatchdog(state, atem, viscaClients);

  // Step 10: Status UI
  const app = createStatusServer(state, config, presetManager);
  const port = parseInt(process.env.STATUS_PORT ?? '8080', 10);
  startStatusServer(app, port);

  logger.info({ controlledCamera: state.controlledCamera }, 'FPS CamControl running');

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('shutting down');
    atem.disconnect();
    for (const [, client] of viscaClients) client.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('fatal error:', err);
  process.exit(1);
});
