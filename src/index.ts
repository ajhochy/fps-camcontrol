import pino from 'pino';
import path from 'path';

export const logger = (global as any).__testLogger ?? pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
  level: process.env.LOG_LEVEL ?? 'info',
});

import { loadConfig } from './config/configLoader';
import { defaultState, AppState, CameraId } from './app/state';
import { AtemClient } from './atem/atemClient';
import { MotionDevice } from './devices/motionDevice';
import { createMotionDevice } from './devices/deviceFactory';
import { loadProfiles } from './input/profileDetector';
import { ControllerSupervisor } from './input/controllerSupervisor';
import { throttledLog } from './app/logThrottle';
import { normalizeHIDReport } from './input/normalizers';
import { ControlStateMachine } from './model/controlStateMachine';
import { PresetManager } from './model/presetManager';
import { startControllerLoop } from './app/controllerLoop';
import { eventBus } from './app/eventBus';
import { createStatusServer, startStatusServer } from './ui/statusServer';
import { ActivityLog } from './app/activityLog';
import { startWatchdog } from './safety/watchdog';
import { CalibrationWizard } from './input/calibrationWizard';

async function main() {
  logger.info('FPS CamControl starting…');

  const config = loadConfig();
  const state: AppState = { ...defaultState };
  const activityLog = new ActivityLog();

  // Step 1: Connect to ATEM
  const atem = new AtemClient(config.atem.ip);
  atem.setActivityLog(activityLog);
  try {
    await atem.connect();
  } catch (err) {
    logger.warn({ err }, 'ATEM initial connection failed, will retry in background');
  }

  // Step 2: Connect to cameras (non-blocking)
  const devices = new Map<CameraId, MotionDevice>();
  for (const cam of config.cameras) {
    const device = createMotionDevice(cam, activityLog);
    device.on('connected', () => {
      state.cameraConnected[cam.id as CameraId] = true;
    });
    device.on('disconnected', () => {
      state.cameraConnected[cam.id as CameraId] = false;
    });
    devices.set(cam.id as CameraId, device);
    device.connect();
  }

  // Step 3 & 4: Detect controller and load profile.
  // Detection is supervised, not one-shot — a controller that pairs or wakes up
  // after startup is picked up on the next poll instead of being ignored until
  // the app restarts.
  const profilesDir = path.join(process.cwd(), 'controller-profiles');
  const profiles = loadProfiles(profilesDir);

  const presetManager = new PresetManager(state, config, devices);
  const machine = new ControlStateMachine(state, config, atem, devices, activityLog);

  const supervisor = new ControllerSupervisor(profiles);

  supervisor.on('attached', (info: { profile: { name: string }; connectionType: 'usb' | 'bluetooth' }) => {
    state.activeControllerProfile = info.profile.name;
    state.activeConnectionType = info.connectionType;
    logger.info({ profile: info.profile.name, connectionType: info.connectionType }, 'controller profile loaded');
  });
  supervisor.on('detached', () => {
    state.activeControllerProfile = null;
    state.activeConnectionType = null;
    state.controllerConnected = false;
    state.controllerStatusDetail = null;
    logger.warn('controller removed — watching for a controller to connect');
  });
  supervisor.on('connected', () => {
    state.controllerConnected = true;
    state.controllerStatusDetail = null;
    logger.info('controller connected');
  });
  supervisor.on('statusDetail', (detail: string) => {
    state.controllerStatusDetail = detail;
    throttledLog.warn('controller-status-detail', 60000, {}, detail);
  });
  supervisor.on('disconnected', () => {
    state.controllerConnected = false;
    logger.warn('controller disconnected, will retry');
  });
  supervisor.on('data', (data: Buffer) => {
    const profile = supervisor.activeProfile;
    if (!profile) return;
    const input = normalizeHIDReport(data, profile);
    machine.updateInput(input);
    eventBus.emit('controllerData', { type: 'rawHidData', raw: data, normalized: input });
  });

  supervisor.start();

  if (!supervisor.isAttached()) {
    logger.warn('no known controller found — watching for one to connect; calibration wizard available at http://localhost:8080');
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
  startWatchdog(state, atem, devices);

  // Step 10: Status UI
  const app = createStatusServer(state, config, presetManager, activityLog, atem, devices);
  const port = parseInt(process.env.STATUS_PORT ?? '8080', 10);
  startStatusServer(app, activityLog, port);

  logger.info({ controlledCamera: state.controlledCamera }, 'FPS CamControl running');

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('shutting down');
    supervisor.stop();
    atem.disconnect();
    for (const [, device] of devices) device.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('fatal error:', err);
  process.exit(1);
});
