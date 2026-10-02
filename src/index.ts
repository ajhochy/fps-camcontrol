import pino from 'pino';
import crypto from 'node:crypto';

export const logger = (global as any).__testLogger ?? pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
  level: process.env.LOG_LEVEL ?? 'info',
});

import { loadConfig } from './config/configLoader';
import { getResourcePath } from './config/paths';
import { createInitialState, AppState, CameraId, trackDeviceLinkState } from './app/state';
import { AtemClient } from './atem/atemClient';
import { MotionDevice } from './devices/motionDevice';
import { createMotionDevice } from './devices/deviceFactory';
import { loadProfiles } from './input/profileDetector';
import { ControllerSupervisor } from './input/controllerSupervisor';
import { throttledLog } from './app/logThrottle';
import { normalizeHIDReport } from './input/normalizers';
import { ControlStateMachine } from './model/controlStateMachine';
import { InputArbiter } from './input/inputArbiter';
import { RemoteControlHub } from './input/remoteControl';
import { emergencyStopAll } from './safety/emergencyStop';
import { PresetManager } from './model/presetManager';
import { startControllerLoop, stopControllerLoop } from './app/controllerLoop';
import { eventBus } from './app/eventBus';
import { createStatusServer, startStatusServer, waitForListening } from './ui/statusServer';
import { ActivityLog } from './app/activityLog';
import { startWatchdog } from './safety/watchdog';
import { CalibrationWizard } from './input/calibrationWizard';
import { SonyStateStore } from './sony/sonyStateStore';
import { SonyManager } from './sony/sonyManager';
import { startTrackingRuntime } from './app/trackingRuntime';
import { stopMotionBeforeHelpers } from './app/stopMotionBeforeHelpers';

export interface ApplicationLifecycle {
  server: ReturnType<typeof startStatusServer>;
  shutdown(): Promise<void>;
}

export interface StartApplicationOptions {
  /** The embedded utility process always supplies an OS-assigned port (0). */
  statusPort?: number;
  /** Embedded startup must not wait for unavailable production hardware. */
  embedded?: boolean;
}

/**
 * Start one app instance explicitly. Importing this module deliberately has no
 * startup side effects so the Electron utility process can control readiness.
 */
export async function startApplication(
  options: StartApplicationOptions = {},
  startServer: typeof startStatusServer = startStatusServer,
): Promise<ApplicationLifecycle> {
  logger.info('FPS CamControl starting…');

  const config = loadConfig();
  const controlsPaused = process.env.CAMCONTROL_INPUT_SUSPENDED === '1';
  if (config.working) logger.info({ profile: config.working.base, rigs: config.working.slots.length }, 'restored unsaved rig changes (working copy)');
  if (config.workingNotice) logger.warn(config.workingNotice);
  const state: AppState = createInitialState();
  const activityLog = new ActivityLog();
  const sonyManager = new SonyManager(controlsPaused ? { ...config.sony!, enabled: false } : config.sony!, new SonyStateStore(config.sony!.stateFile));
  // Sony is optional; readiness stays in the manager background lane.
  sonyManager.start();

  // Step 1: Connect to ATEM
  const atem = new AtemClient(config.atem.ip);
  atem.setActivityLog(activityLog);
  const connectAtem = (controlsPaused ? Promise.resolve() : atem.connect()).catch(err => {
    logger.warn({ err }, 'ATEM initial connection failed, will retry in background');
  });
  // Packaged readiness must not wait for absent hardware; CLI behavior stays unchanged.
  if (!options.embedded) await connectAtem;

  // Step 2: Connect to cameras (non-blocking)
  const devices = new Map<CameraId, MotionDevice>();
  for (const cam of config.cameras) {
    const device = createMotionDevice(cam, activityLog);
    trackDeviceLinkState(state, cam.id, device);
    devices.set(cam.id as CameraId, device);
    if (!controlsPaused) device.connect();
  }

  // Step 3 & 4: Detect controller and load profile.
  // Detection is supervised, not one-shot — a controller that pairs or wakes up
  // after startup is picked up on the next poll instead of being ignored until
  // the app restarts.
  const profilesDir = process.env.PROFILES_DIR ?? getResourcePath('controller-profiles');
  const profiles = loadProfiles(profilesDir);

  const presetManager = new PresetManager(state, config, devices);
  const machine = new ControlStateMachine(state, config, atem, devices, activityLog);

  // The desk controller and (once the remote hub is wired) an iPad both feed the machine through the arbiter:
  // one owner at a time, the desk always wins, and every handover stops the camera first.
  const arbiter = new InputArbiter(machine);
  machine.setSourceConnected(() => arbiter.sourceConnected(state.controllerConnected));

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
    arbiter.fromLocal(input);
    eventBus.emit('controllerData', { type: 'rawHidData', raw: data, normalized: input });
  });

  // CAMCONTROL_NO_CONTROLLER=1 (the sandbox, isolated tests): never open the real
  // HID controller, so a second copy of the app cannot take it from the live one.
  const controllerDisabled = process.env.CAMCONTROL_NO_CONTROLLER === '1' || process.env.CAMCONTROL_INPUT_SUSPENDED === '1';
  if (controllerDisabled) logger.warn('controller input disabled (CAMCONTROL_NO_CONTROLLER=1)');
  else supervisor.start();

  if (!controllerDisabled && !supervisor.isAttached()) {
    logger.warn('no known controller found — watching for one to connect; calibration wizard available at http://localhost:8080');
    const wizard = new CalibrationWizard();
    wizard.start();
  }

  // Step 6 & 7: Read ATEM program/preview, set controlled camera
  // Cameras whose video isn't wired to the switcher have no inputId. They must
  // never match an ATEM input here — `undefined === undefined` would otherwise
  // pick an unwired camera as the live/preview source.
  const byInput = (inputId: number | undefined) =>
    inputId === undefined ? undefined : config.cameras.find(c => c.inputId === inputId);
  const firstWired = config.cameras.find(c => c.inputId !== undefined);
  const fallback = firstWired ?? config.cameras[0];

  if (atem.connected) {
    const cam = byInput(atem.getPreviewInput()) ?? fallback;
    if (cam) {
      state.controlledCamera = cam.id as CameraId;
      state.cameraIndex = config.cameras.indexOf(cam);
    }
    const pgmCam = byInput(atem.getProgramInput());
    if (pgmCam) state.programCamera = pgmCam.id as CameraId;
  } else if (fallback) {
    state.controlledCamera = fallback.id as CameraId;
    state.cameraIndex = config.cameras.indexOf(fallback);
  }
  state.previewCamera = state.controlledCamera;

  // Step 8: Sync ATEM preview to controlledCamera
  const controlledCam = config.cameras.find(c => c.id === state.controlledCamera);
  if (controlledCam?.inputId !== undefined && atem.connected) {
    await atem.changePreviewInput(controlledCam.inputId);
  }

  // Step 9: Start controller loop
  if (!controlsPaused) startControllerLoop(machine);

  // Watchdog
  const watchdog = controlsPaused ? undefined : startWatchdog(state, atem, devices);

  // Step 10: Status UI
  // iPad remote control (off unless config remoteControl.enabled or the desk page switches it on).
  const remoteHub = new RemoteControlHub({
    state, config, arbiter, activityLog, pin: config.remoteControl?.pin ?? null,
    emergencyStop: () => emergencyStopAll(state, config, atem, devices),
    selectCamera: (id, who, movePreview) => machine.selectCameraById(id, who, movePreview),
    setPreview: (id, who) => machine.previewCameraById(id, who),
    transition: (who) => machine.takePreviewLive(who),
  });
  // A suspended-input (second, non-owning Electron variant) instance never starts with remote control on.
  remoteHub.setEnabled(!controlsPaused && (config.remoteControl?.enabled ?? false));
  remoteHub.start();

  const frameToken = process.env.CAMCONTROL_EMBEDDED === '1' ? crypto.randomBytes(32).toString('base64url') : process.env.TRACKER_FRAME_TOKEN ?? crypto.randomBytes(32).toString('base64url');
  // The tracking hooks/frame token (PR #58) keep their positions (getTracking keeps its default); remoteHub (PR #59) is last.
  const app = createStatusServer(state, config, presetManager, activityLog, atem, devices, sonyManager, undefined, { frameToken }, remoteHub);
  const port = options.statusPort ?? parseInt(process.env.STATUS_PORT ?? '8080', 10);
  // The CLI honours server.host (iPad over the LAN); the embedded backend's startServer stays loopback-only.
  const server = startServer(app, activityLog, port, config.serverHost ?? '127.0.0.1', remoteHub);
  await waitForListening(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local server address unavailable');
  const tracking = startTrackingRuntime(state, config, devices, `http://127.0.0.1:${address.port}`, frameToken, controlsPaused);

  logger.info({ controlledCamera: state.controlledCamera }, 'FPS CamControl running');

  // Graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info('shutting down');
      stopControllerLoop();
      if (watchdog) clearInterval(watchdog);
      supervisor.stop();
      const failures: unknown[] = [];
      // Revoke any iPad seat (stops its camera) and close remote sockets before devices stop.
      try { remoteHub.stop(); } catch (error) { failures.push(error); }
      // Halts tracking, stops every device and flushes the stops before ending the tracking helper.
      try { await stopMotionBeforeHelpers(tracking, devices.values()); } catch (error) { failures.push(error); }
      server.emit('shutdown');
      server.closeAllConnections();
      try { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); } catch (error) { failures.push(error); }
      try { atem.disconnect(); } catch (error) { failures.push(error); }
      for (const [, device] of devices) {
        try { device.close(); } catch (error) { failures.push(error); }
      }
      try { await sonyManager.stop(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Application shutdown could not confirm every resource');
    })();
    return shutdownPromise;
  };

  return { server, shutdown };
}

/** Retain the historical CLI entrypoint while keeping imports inert. */
export async function main(): Promise<void> {
  const lifecycle = await startApplication();
  // The CLI exits explicitly once cleanup has finished (as before #57): background timers (health, gimbal
  // scans, Sony polling) must not keep a stopped app alive under launchd. The embedded backend exits in embed.ts.
  const exitAfterShutdown = () => void lifecycle.shutdown().then(() => process.exit(0), (err) => {
    console.error('shutdown error:', err);
    process.exit(1);
  });
  process.once('SIGINT', exitAfterShutdown);
  process.once('SIGTERM', exitAfterShutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error('fatal error:', err);
    process.exitCode = 1;
  });
}
