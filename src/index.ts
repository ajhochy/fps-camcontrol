import fs from 'fs';
import pino from 'pino';
import path from 'path';

// P3-A: File transport alongside pretty stdout
const dateStr = new Date().toISOString().split('T')[0];
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const transport = (global as any).__testLogger
  ? undefined
  : pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          options: { colorize: true },
          level: process.env.LOG_LEVEL ?? 'info',
        },
        {
          target: 'pino/file',
          options: { destination: path.join(logDir, `service-${dateStr}.log`), mkdir: true },
          level: process.env.LOG_LEVEL ?? 'info',
        },
      ],
    });

export const logger = (global as any).__testLogger ?? pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  transport!
);

import { loadConfig } from './config/configLoader';
import { defaultState, AppState, CameraId } from './app/state';
import { AtemClient } from './atem/atemClient';
import { ViscaClient } from './visca/viscaClient';
import { stopPTZ } from './visca/ptzActions';
import { loadProfiles, findConnectedController } from './input/profileDetector';
import { GamepadDevice } from './input/gamepad';
import { normalizeHIDReport, NormalizedInput } from './input/normalizers';
import { ControlStateMachine } from './model/controlStateMachine';
import { startControllerLoop } from './app/controllerLoop';
import { createStatusServer, startStatusServer } from './ui/statusServer';
import { startWatchdog } from './safety/watchdog';
import { CalibrationWizard } from './input/calibrationWizard';

const ZERO_INPUT: NormalizedInput = { axes: {}, buttons: {}, triggers: {} };

async function main() {
  logger.info('FPS CamControl starting…');

  const config = loadConfig();

  const state: AppState = {
    ...defaultState,
    // Build cameraConnected dynamically from config (P3-E)
    cameraConnected: Object.fromEntries(config.cameras.map(c => [c.id, false])),
  };

  // Step 1: Connect to ATEM
  const atem = new AtemClient(config.atem.ip);
  try {
    await atem.connect();
  } catch (err) {
    logger.warn({ err }, 'ATEM initial connection failed, will retry in background');
  }

  // P1-A/D: Sync program/preview/DSK from hardware stateChanged events
  atem.on('stateChanged', (atemState: any) => {
    const meIndex = config.atem.meIndex;
    const programInput = atemState?.video?.mixEffects?.[meIndex]?.programInput;
    const previewInput = atemState?.video?.mixEffects?.[meIndex]?.previewInput;

    if (programInput != null) {
      const cam = config.cameras.find(c => c.inputId === programInput);
      if (cam) state.programCamera = cam.id;
    }
    if (previewInput != null) {
      const cam = config.cameras.find(c => c.inputId === previewInput);
      if (cam) state.previewCamera = cam.id;
    }

    // P1-D: DSK onAir sync
    const dskOnAir = atemState?.video?.downstreamKeyers?.[config.lowerThirds.dskIndex]?.onAir;
    if (typeof dskOnAir === 'boolean') {
      state.lowerThirdsActive = dskOnAir;
    }
  });

  // Step 2: Connect to cameras (non-blocking)
  const viscaClients = new Map<CameraId, ViscaClient>();
  for (const cam of config.cameras) {
    const client = new ViscaClient(cam.id, cam.viscaIp, cam.viscaPort);
    client.on('connected', () => {
      state.cameraConnected[cam.id] = true;
    });
    client.on('disconnected', () => {
      state.cameraConnected[cam.id] = false;
    });
    viscaClients.set(cam.id, client);
    client.connect();
  }

  // Step 3 & 4: Detect controller and load profile
  const profilesDir = path.join(process.cwd(), 'controller-profiles');
  const profiles = loadProfiles(profilesDir);
  const found = findConnectedController(profiles);

  const machine = new ControlStateMachine(state, config, atem, viscaClients);

  let gamepad: GamepadDevice | undefined;

  if (found) {
    logger.info({ profile: found.profile.name }, 'controller profile loaded');
    gamepad = new GamepadDevice(found.device.vendorId, found.device.productId);
    machine.setGamepad(gamepad);

    gamepad.on('connected', () => {
      state.controllerConnected = true;
      logger.info('controller connected');
    });
    gamepad.on('disconnected', () => {
      // P0-A: Zero input and stop all cameras immediately on disconnect
      machine.updateInput(ZERO_INPUT);
      for (const [, client] of viscaClients) {
        stopPTZ(client);
      }
      state.controllerConnected = false;
      logger.warn('controller disconnected — all cameras stopped, will retry');
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
    const meIndex = config.atem.meIndex;
    const previewInputId = atem.getPreviewInput(meIndex) ?? config.cameras[1]?.inputId;
    const cam = config.cameras.find(c => c.inputId === previewInputId);
    if (cam) {
      state.controlledCamera = cam.id;
      state.cameraIndex = config.cameras.indexOf(cam);
    } else {
      state.controlledCamera = config.cameras[1]?.id ?? config.cameras[0]?.id ?? 'cam2';
      state.cameraIndex = Math.min(1, config.cameras.length - 1);
    }
    const programInputId = atem.getProgramInput(meIndex) ?? config.cameras[1]?.inputId;
    const pgmCam = config.cameras.find(c => c.inputId === programInputId);
    if (pgmCam) state.programCamera = pgmCam.id;
  } else {
    state.controlledCamera = config.cameras[1]?.id ?? config.cameras[0]?.id ?? 'cam2';
    state.cameraIndex = Math.min(1, config.cameras.length - 1);
  }
  state.previewCamera = state.controlledCamera;

  // Step 8: Sync ATEM preview to controlledCamera
  const controlledCam = config.cameras.find(c => c.id === state.controlledCamera);
  if (controlledCam && atem.connected) {
    await atem.changePreviewInput(controlledCam.inputId, config.atem.meIndex);
  }

  // P3-F: Startup connectivity summary
  logger.info('Running startup connectivity checks…');
  const atemMark = atem.connected ? '✓' : '✗';
  const camResults: string[] = [];
  for (const cam of config.cameras) {
    const client = viscaClients.get(cam.id);
    if (client) {
      const reachable = await client.probe(2000);
      state.cameraConnected[cam.id] = reachable;
      camResults.push(`${cam.id} ${reachable ? '✓' : '✗ (no response)'}`);
    }
  }
  const ctrlMark = found ? '✓' : '✗ (not found)';
  logger.info(`Ready: ATEM ${atemMark} | ${camResults.join(' | ')} | Controller ${ctrlMark}`);

  // Step 9: Start controller loop
  startControllerLoop(machine);

  // Watchdog
  startWatchdog(state, atem, viscaClients);

  // Step 10: Status UI
  const app = createStatusServer(state, config, machine.getPresetManager());
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
