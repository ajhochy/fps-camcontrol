import fs from 'fs';
import os from 'os';
import path from 'path';
import * as YAML from 'yaml';
import { defaultState, AppState, CameraId } from '../app/state';
import {
  AppConfig, resolveProfile, validateDevicesConfig, saveDevicesConfig,
  saveActiveProfile, saveProfiles,
} from '../config/configLoader';
import { VirtualAtem } from './virtualAtem';
import { VirtualVisca } from './virtualVisca';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { ViscaDevice } from '../devices/viscaDevice';
import { MotionDevice } from '../devices/motionDevice';
import { PresetManager } from '../model/presetManager';
import { CameraSelector } from '../model/cameraSelector';
import { ControlStateMachine } from '../model/controlStateMachine';
import { emergencyStopAll } from '../safety/emergencyStop';
import { EdgeState, createEdgeState, risingEdge } from '../input/edgeTriggers';
import { ControllerSupervisor, explainOpenFailure } from '../input/controllerSupervisor';
import { applyCurve, applyDeadzone, clamp } from '../visca/speedCurves';
import { panTilt, zoom } from '../visca/ptzActions';
import { autoTransitionControlledCamera, toggleLowerThirds } from '../atem/switcherActions';

// ---- minimal logger for tests ----
const logger = {
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  debug: (..._args: unknown[]) => {},
};

// Patch index exports so imported modules get the test logger
(global as any).__testLogger = logger;

// ---- Build virtual hardware ----
const virtualAtem = new VirtualAtem();
const virtualViscas: Record<string, VirtualVisca> = {
  cam1: new VirtualVisca(),
  cam2: new VirtualVisca(),
  cam3: new VirtualVisca(),
};

const config: AppConfig = {
  atem: { ip: '127.0.0.1', defaultTransition: 'cut', meIndex: 0 },
  cameras: [
    { id: 'cam1', label: 'V-BOT', protocol: 'visca', cameraType: 'vbot', inputId: 1, viscaIp: '127.0.0.1', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
    { id: 'cam2', label: 'BirdDog 1', protocol: 'visca', cameraType: 'birddog', inputId: 2, viscaIp: '127.0.0.1', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
    { id: 'cam3', label: 'BirdDog 2', protocol: 'visca', cameraType: 'birddog', inputId: 3, viscaIp: '127.0.0.1', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
  ],
  graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
  speeds: {
    presets: [
      { name: 'Slow', multiplier: 0.2 },
      { name: 'Normal', multiplier: 0.5 },
      { name: 'Fast', multiplier: 1.0 },
    ],
    activePreset: 1,
  },
  mappings: {
    panTilt: 'rightStick',
    zoomIn: 'rightTrigger',
    zoomOut: 'leftTrigger',
    cameraSelectLeft: 'leftStickLeft',
    cameraSelectRight: 'leftStickRight',
    autoTransition: 'RB',
    precisionMode: 'LS',
    selectCam1: 'X',
    selectCam2: 'A',
    selectCam3: 'B',
    selectCam4: 'Y',
    speedUp: 'dpadUp',
    speedDown: 'dpadDown',
    lowerThirds: 'dpadLeft',
    emergencyStop: 'back',
  },
};

// ---- Build state ----
const state: AppState = {
  ...defaultState,
  controlledCamera: 'cam2',
  programCamera: 'cam2',
  previewCamera: 'cam2',
  cameraIndex: 1,
};

// ---- Wire virtual VISCA clients via duck-typing through ViscaDevice ----
// VirtualVisca only implements sendPayload, so we keep the raw map around for
// the smoke test's direct panTilt/zoom calls and also expose a MotionDevice
// view for the state-machine-shaped consumers.
const viscaClients = new Map<CameraId, any>();
const devices = new Map<CameraId, MotionDevice>();
for (const [id, vv] of Object.entries(virtualViscas)) {
  viscaClients.set(id as CameraId, vv);
  // ViscaDevice forwards to ViscaClient; VirtualVisca is duck-typed in.
  const device = new ViscaDevice(vv as unknown as ViscaClient, id, id);
  devices.set(id as CameraId, device);
}

// ---- Wire virtual ATEM client via duck-typing ----
const atemProxy = virtualAtem as unknown as AtemClient;

// ---- Build sub-systems ----
const edgeState: EdgeState = createEdgeState();
const cameraSelector = new CameraSelector(state, config.cameras, atemProxy, devices);

// ---- Assertion helpers ----
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ---- Simulate tick helper ----
async function tick(input: { axes?: Record<string, number>; buttons?: Record<string, boolean>; triggers?: Record<string, number> }): Promise<void> {
  const axes = input.axes ?? {};
  const buttons = input.buttons ?? {};
  const triggers = input.triggers ?? {};

  // Precision mode = left-stick click (sprint removed)
  state.precisionMode = buttons['LS'] ?? false;
  state.sprintMode = false;

  // Camera selector
  const leftX = applyDeadzone(axes['leftStickX'] ?? 0);
  cameraSelector.handleLeftStickX(leftX);

  // PT (right stick) + zoom (triggers: RT in, LT out)
  const rightX = applyDeadzone(axes['rightStickX'] ?? 0);
  const rightY = applyDeadzone(axes['rightStickY'] ?? 0);
  const rt = triggers['rightTrigger'] ?? 0;
  const lt = triggers['leftTrigger'] ?? 0;
  const zoomAxis = (rt > 0.05 ? rt : 0) - (lt > 0.05 ? lt : 0);
  const currentClient = viscaClients.get(state.controlledCamera);
  if (currentClient) {
    const mul = config.speeds.presets[state.speedPreset].multiplier;
    const speed = (v: number) => clamp(applyCurve(v) * mul * (state.precisionMode ? 0.25 : 1), -1, 1);
    panTilt(currentClient, speed(rightX), speed(-rightY));
    zoom(currentClient, speed(zoomAxis));
  }

  // RB — Take Live (auto transition). The hard cut on RT was removed; RT/LT now zoom.
  if (risingEdge('RB', buttons['RB'] ?? false, edgeState)) {
    await autoTransitionControlledCamera(atemProxy, state, config.cameras, devices);
  }

  // Emergency stop
  if (risingEdge('back', buttons['back'] ?? false, edgeState)) {
    await emergencyStopAll(state, config, atemProxy, devices);
  }

  // Lower thirds
  const ltToggle =
    risingEdge('dpadLeft', buttons['dpadLeft'] ?? false, edgeState) ||
    risingEdge('dpadRight', buttons['dpadRight'] ?? false, edgeState);
  if (ltToggle) {
    await toggleLowerThirds(atemProxy, state, config);
  }
}

// ===== SMOKE TESTS =====
async function runTests(): Promise<void> {
  console.log('\n=== FPS CamControl Smoke Tests ===\n');

  // Test 1: Startup
  console.log('Test 1: Startup initialization');
  assert('controlledCamera initialized to cam2', state.controlledCamera === 'cam2');
  assert('cameraIndex initialized to 1', state.cameraIndex === 1);

  // Test 2: Flick right → cam3
  console.log('\nTest 2: Flick right → cam3');
  virtualAtem.log = [];
  virtualViscas.cam2.reset();
  await tick({ axes: { leftStickX: 0.9 } });
  await tick({ axes: { leftStickX: 0 } });
  assert('controlledCamera = cam3 after right flick', state.controlledCamera === 'cam3');
  assert('cameraIndex = 2', state.cameraIndex === 2);
  assert('ATEM preview updated to inputId 3', virtualAtem.log.some(l => l.includes('changePreviewInput(3)')));

  // Test 3: Move right stick → VISCA panTilt on cam3
  console.log('\nTest 3: PTZ goes to controlled camera');
  virtualViscas.cam3.reset();
  virtualViscas.cam2.reset();
  await tick({ axes: { rightStickX: 0.8, rightStickY: 0 } });
  assert('cam3 VISCA received panTilt', virtualViscas.cam3.log.length > 0);
  assert('cam2 VISCA NOT called', virtualViscas.cam2.log.length === 0);

  // Test 4: RB take (auto transition) → cam3 live, previous program (cam2) auto-armed as standby
  console.log('\nTest 4: RB take → cam3 live, cam2 auto-armed as standby');
  virtualAtem.log = [];
  await tick({ buttons: { RB: false } });
  await tick({ buttons: { RB: true } });
  assert('ATEM auto transition called', virtualAtem.log.some(l => l.includes('autoTransition()')));
  assert('programCamera = cam3 (live)', state.programCamera === 'cam3');
  assert('controlledCamera = cam2 (auto-armed to old program)', state.controlledCamera === 'cam2');
  assert('previewCamera = cam2 (standby)', state.previewCamera === 'cam2');
  assert('cameraIndex = 1 (tracks new controlled)', state.cameraIndex === 1);

  // Test 5: Take again WITHOUT selecting → ping-pong back to cam2 live
  console.log('\nTest 5: Second take with no re-select → ping-pong back to cam2 live');
  virtualAtem.log = [];
  await tick({ buttons: { RB: false } });
  await tick({ buttons: { RB: true } });
  assert('ATEM auto transition called', virtualAtem.log.some(l => l.includes('autoTransition()')));
  assert('programCamera = cam2 (ping-ponged back live)', state.programCamera === 'cam2');
  assert('controlledCamera = cam3 (re-armed to old program)', state.controlledCamera === 'cam3');
  assert('previewCamera = cam3 (standby)', state.previewCamera === 'cam3');
  assert('cameraIndex = 2 (tracks new controlled)', state.cameraIndex === 2);

  // Test 6: Emergency stop
  console.log('\nTest 6: Emergency stop');
  state.lowerThirdsActive = true;
  virtualViscas.cam1.reset(); virtualViscas.cam2.reset(); virtualViscas.cam3.reset();
  virtualAtem.log = [];
  await tick({ buttons: { back: false } });
  await tick({ buttons: { back: true } });
  assert('lower thirds turned off', !state.lowerThirdsActive);
  assert('DSK set off in ATEM log', virtualAtem.log.some(l => l.includes('setDownstreamKeyOnAir(0, false)')));

  // Test 7: Preset save (LB+A)
  console.log('\nTest 7: Preset save via LB+A (placeholder)');
  const presetManager = new PresetManager(state, config, devices);
  await presetManager.savePreset('cam2', 'A');
  const data = presetManager.getData();
  assert('cam2 slot A has a value', data['cam2'] != null && 'A' in data['cam2']);

  // Test 8: Preset recall
  console.log('\nTest 8: Preset recall via A');
  virtualViscas.cam2.reset();
  (presetManager as any).data['cam2']['A'] = { kind: 'visca', pan: 1000, tilt: 500, zoom: 8000 };
  state.controlledCamera = 'cam2';
  await presetManager.recallPreset('cam2', 'A');
  assert('cam2 VISCA received absolute position command', virtualViscas.cam2.log.length > 0);

  // Test 9: /api/controllers endpoint returns valid JSON
  console.log('\nTest 9: /api/controllers endpoint');
  await new Promise<void>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createStatusServer } = require('../ui/statusServer');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http');
    const testApp = createStatusServer(state, config, presetManager);
    const testServer = testApp.listen(18080, '127.0.0.1', () => {
      const req = http.get('http://127.0.0.1:18080/api/controllers', (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => { body += chunk; });
        res.on('end', () => {
          // Accept 200 (HID enumeration succeeded) or 500 (HID unavailable in test env)
          assert('/api/controllers returns JSON response', res.statusCode === 200 || res.statusCode === 500);
          let parsed: unknown = null;
          try { parsed = JSON.parse(body); } catch (_) {}
          assert('/api/controllers body is valid JSON', parsed !== null);
          if (res.statusCode === 200) {
            assert('/api/controllers returns array on 200', Array.isArray(parsed));
          }
          testServer.close(() => resolve());
        });
      });
      req.on('error', (_e: Error) => {
        assert('/api/controllers reachable', false);
        testServer.close(() => resolve());
      });
    });
  });

  // Test 10: Face-button camera hotkeys arm standby directly.
  // Drives the REAL ControlStateMachine (not the tick() reimplementation above)
  // so this exercises the shipping button-handling code.
  console.log('\nTest 10: Face buttons A/B/X/Y arm cameras as standby');
  state.controlledCamera = 'cam2';
  state.cameraIndex = 1;
  state.previewCamera = 'cam2';
  state.controllerConnected = true;
  const csm = new ControlStateMachine(state, config, atemProxy, devices, null);
  const press = (btn: string, down: boolean) => {
    csm.updateInput({ axes: {}, buttons: { [btn]: down }, triggers: {} });
    csm.tick();
  };
  const faceCases: Array<[string, string, number]> = [
    ['X', 'cam1', 1],
    ['A', 'cam2', 2],
    ['B', 'cam3', 3],
  ];
  for (const [btn, camId, inputId] of faceCases) {
    virtualAtem.log = [];
    press(btn, false); // establish a released baseline for the rising edge
    press(btn, true);
    assert(`${btn} arms ${camId} as controlled`, state.controlledCamera === camId);
    assert(`${btn} sets ${camId} as standby (preview)`, state.previewCamera === camId);
    assert(`${btn} moves ATEM preview to input ${inputId}`,
      virtualAtem.log.some(l => l.includes(`changePreviewInput(${inputId})`)));
  }
  // Y maps to a 4th camera; with only 3 configured it must be a safe no-op
  const beforeY = state.controlledCamera;
  virtualAtem.log = [];
  press('Y', false);
  press('Y', true);
  assert('Y with no 4th camera is a no-op (controlled unchanged)', state.controlledCamera === beforeY);
  assert('Y with no 4th camera does not touch ATEM preview', virtualAtem.log.length === 0);

  // Test 11: KEY (lower thirds) toggle fades instead of hard-cutting.
  console.log('\nTest 11: KEY toggle uses a fade (auto), not a hard cut');
  state.lowerThirdsActive = false;
  state.controllerConnected = true;
  const csm2 = new ControlStateMachine(state, config, atemProxy, devices, null);
  const pressDpad = async (btn: string, down: boolean) => {
    csm2.updateInput({ axes: {}, buttons: { [btn]: down }, triggers: {} });
    csm2.tick();
    await new Promise(res => setTimeout(res, 10)); // let fire-and-forget ATEM calls resolve
  };
  virtualAtem.log = [];
  await pressDpad('dpadLeft', false);
  await pressDpad('dpadLeft', true);
  assert('KEY on sets DSK fade rate (15 frames)', virtualAtem.log.some(l => l.includes('setDownstreamKeyRate(0, 15)')));
  assert('KEY on uses autoDownstreamKey fade toward on', virtualAtem.log.some(l => l.includes('autoDownstreamKey(0, true)')));
  assert('KEY on does NOT hard-cut', !virtualAtem.log.some(l => l.includes('setDownstreamKeyOnAir')));
  assert('lowerThirdsActive = true after fade on', state.lowerThirdsActive);

  virtualAtem.log = [];
  await pressDpad('dpadLeft', false);
  await pressDpad('dpadLeft', true);
  assert('KEY off uses autoDownstreamKey fade toward off', virtualAtem.log.some(l => l.includes('autoDownstreamKey(0, false)')));
  assert('lowerThirdsActive = false after fade off', !state.lowerThirdsActive);

  // Emergency stop must still kill the KEY instantly (no fade)
  console.log('\nTest 11b: Emergency stop kills KEY instantly (hard cut)');
  state.lowerThirdsActive = true;
  virtualAtem.log = [];
  await emergencyStopAll(state, config, atemProxy, devices);
  assert('E-stop hard-cuts KEY off (setDownstreamKeyOnAir)', virtualAtem.log.some(l => l.includes('setDownstreamKeyOnAir(0, false)')));
  assert('E-stop does NOT fade the KEY', !virtualAtem.log.some(l => l.includes('autoDownstreamKey')));

  // Test 12: Triggers drive zoom (RT = in / LT = out), and RT no longer takes.
  // Drives the REAL ControlStateMachine so this exercises the shipping code.
  console.log('\nTest 12: RT = zoom in, LT = zoom out, RT does not take');
  state.controlledCamera = 'cam2';
  state.cameraIndex = 1;
  state.programCamera = 'cam2';
  state.controllerConnected = true;
  const csm3 = new ControlStateMachine(state, config, atemProxy, devices, null);
  // Extract the VISCA zoom command byte from a virtual camera's log:
  // payload = [0x81,0x01,0x04,0x07,cmd,0xFF]; cmd 0x2X = tele (in), 0x3X = wide (out).
  const zoomCmd = (vv: any): number | null => {
    const line = [...vv.log].reverse().find((l: string) => l.includes(',4,7,'));
    if (!line) return null;
    const nums: number[] = line.replace(/[^0-9,]/g, '').split(',').map(Number);
    const i = nums.findIndex((n: number, idx: number) => n === 4 && nums[idx + 1] === 7);
    return i >= 0 ? nums[i + 2] : null;
  };

  virtualViscas.cam2.reset();
  const progBeforeZoom = state.programCamera;
  csm3.updateInput({ axes: {}, buttons: {}, triggers: { rightTrigger: 0.8 } });
  csm3.tick();
  const inCmd = zoomCmd(virtualViscas.cam2);
  assert('RT sends a zoom command', inCmd !== null);
  assert('RT zooms IN (tele, 0x2X)', inCmd !== null && (inCmd & 0xF0) === 0x20);
  assert('RT does NOT take (program unchanged)', state.programCamera === progBeforeZoom);

  // release trigger → zoom stop
  csm3.updateInput({ axes: {}, buttons: {}, triggers: { rightTrigger: 0 } });
  csm3.tick();

  virtualViscas.cam2.reset();
  csm3.updateInput({ axes: {}, buttons: {}, triggers: { leftTrigger: 0.8 } });
  csm3.tick();
  const outCmd = zoomCmd(virtualViscas.cam2);
  assert('LT sends a zoom command', outCmd !== null);
  assert('LT zooms OUT (wide, 0x3X)', outCmd !== null && (outCmd & 0xF0) === 0x30);

  // ===== DJI bridge device =====
  console.log('\nTest 10: DJI bridge — hello, velocity, getPosition, moveTo, stop');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VirtualDjiBridge } = require('./virtualDjiBridge');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DjiBridgeDevice } = require('../devices/djiBridgeDevice');

  const bridge = new VirtualDjiBridge({});
  const bridgePort = await bridge.start();
  const dji = new DjiBridgeDevice(
    {
      host: '127.0.0.1',
      port: bridgePort,
      safetyTimeoutMs: 250,
      reconnectBackoffMs: [50, 100, 200],
      rollEnabled: false,
    },
    'cam4',
    'DJI RS4 Pro',
  );

  const connected = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    dji.once('connected', () => { clearTimeout(t); resolve(true); });
    dji.connect();
  });
  assert('DJI bridge handshake completed', connected);
  assert('capabilities include velocity', dji.capabilities.pan && dji.capabilities.tilt);
  assert('capabilities include position', dji.capabilities.position);

  // velocity → safety stop after silence
  dji.setPanTilt(0.5, 0.25);
  await new Promise(r => setTimeout(r, 50));
  assert('bridge received moveVelocity', bridge.log.some((l: string) => l.startsWith('moveVelocity')));
  await new Promise(r => setTimeout(r, 400));
  assert('bridge auto-stopped on safety timeout', bridge.velPan === 0 && bridge.velTilt === 0);

  // getPosition + moveTo
  dji.setPanTilt(0.5, 0);
  await new Promise(r => setTimeout(r, 100));
  dji.stop();
  await new Promise(r => setTimeout(r, 20));
  const pos = await dji.getPosition();
  assert('getPosition returns gimbal position', pos.kind === 'gimbal');

  bridge.reset();
  await dji.moveTo({ kind: 'gimbal', yaw: 10, pitch: -5, roll: 0 });
  assert('bridge yaw after moveTo', bridge.yaw === 10);
  assert('bridge pitch after moveTo', bridge.pitch === -5);

  // preset save/recall via PresetManager on a DJI device
  const djiDevices = new Map<CameraId, any>();
  djiDevices.set('cam4' as CameraId, dji);
  const djiState: AppState = { ...defaultState, controlledCamera: 'cam4' };
  const djiConfig: AppConfig = {
    ...config,
    cameras: [
      ...config.cameras,
      {
        id: 'cam4', label: 'DJI RS4 Pro', protocol: 'dji-bridge', cameraType: 'generic',
        inputId: 4, viscaPort: 52381, cameraAddress: 1, speedScale: 1,
        bridge: { host: '127.0.0.1', port: bridgePort, safetyTimeoutMs: 250, reconnectBackoffMs: [50], rollEnabled: false },
      },
    ],
  };
  const djiPresetMgr = new PresetManager(djiState, djiConfig, djiDevices);
  await djiPresetMgr.savePreset('cam4', 'A');
  const saved = (djiPresetMgr as any).data['cam4']?.A;
  assert('DJI preset saved with kind:gimbal', saved?.kind === 'gimbal');

  bridge.yaw = 99; bridge.pitch = 99;
  await djiPresetMgr.recallPreset('cam4', 'A');
  assert('DJI preset recall restores yaw', Math.abs(bridge.yaw - (saved?.yaw ?? 0)) < 0.001);
  assert('DJI preset recall restores pitch', Math.abs(bridge.pitch - (saved?.pitch ?? 0)) < 0.001);

  // recenter
  bridge.yaw = 42; bridge.pitch = -7; bridge.roll = 3;
  await dji.recenter();
  assert('recenter zeros yaw', bridge.yaw === 0);
  assert('recenter zeros pitch', bridge.pitch === 0);
  assert('recenter zeros roll', bridge.roll === 0);

  // disconnect cleanup
  dji.close();
  await bridge.stop();

  // Roll capability gating
  console.log('\nTest 11: Roll capability is opt-in via rollEnabled');
  const rollBridge = new VirtualDjiBridge({ capabilities: ['velocity', 'position', 'moveTo', 'roll'] });
  const rollPort = await rollBridge.start();
  const djiRollOff = new DjiBridgeDevice(
    { host: '127.0.0.1', port: rollPort, safetyTimeoutMs: 250, reconnectBackoffMs: [50], rollEnabled: false },
    'cam5', 'DJI roll-off',
  );
  await new Promise<void>((resolve) => {
    djiRollOff.once('connected', () => resolve());
    djiRollOff.connect();
  });
  assert('rollEnabled:false → capabilities.roll false even if bridge offers it', djiRollOff.capabilities.roll === false);
  djiRollOff.close();

  const djiRollOn = new DjiBridgeDevice(
    { host: '127.0.0.1', port: rollPort, safetyTimeoutMs: 250, reconnectBackoffMs: [50], rollEnabled: true },
    'cam5', 'DJI roll-on',
  );
  await new Promise<void>((resolve) => {
    djiRollOn.once('connected', () => resolve());
    djiRollOn.connect();
  });
  assert('rollEnabled:true + bridge advertises roll → capabilities.roll true', djiRollOn.capabilities.roll === true);
  djiRollOn.close();
  await rollBridge.stop();

  // Test 12: Controller hot-plug — a pad that appears AFTER startup must attach.
  // Regression guard: detection used to be one-shot at boot, so a controller
  // paired later was never picked up and the home screen stayed "Not Connected"
  // even though the OS (and the Controller tab) listed the device.
  console.log('\nTest 12: Controller supervisor attaches a pad that appears after startup');
  const hotplugProfile = {
    name: 'Test Pad',
    vendorIds: [0x045e],
    productIds: [0x0b13],
    connectionType: 'bluetooth' as const,
    axes: {},
    buttons: {},
  };
  const hotplugDevice = { vendorId: 0x045e, productId: 0x0b13, path: 'test:pad' } as any;

  let padPresent = false;
  const virtualPad = new (require('events').EventEmitter)();
  let padOpened = 0;
  let padClosed = 0;
  virtualPad.open = () => { padOpened++; };
  virtualPad.close = () => { padClosed++; };

  const supervisor = new ControllerSupervisor([hotplugProfile], 60000, {
    detect: () => (padPresent
      ? { device: hotplugDevice, profile: hotplugProfile, connectionType: 'bluetooth' as const }
      : null),
    enumerate: () => (padPresent ? [hotplugDevice] : []),
    createGamepad: () => virtualPad,
  });

  const events: string[] = [];
  for (const e of ['attached', 'detached', 'connected', 'disconnected']) {
    supervisor.on(e, () => events.push(e));
  }
  let padData = 0;
  supervisor.on('data', () => { padData++; });

  supervisor.start(); // pad absent at "startup"
  assert('supervisor not attached when no pad is present at startup', !supervisor.isAttached());
  assert('no attach event fired with no pad present', !events.includes('attached'));

  padPresent = true;
  supervisor.poll();
  assert('supervisor attaches a pad that appears after startup', supervisor.isAttached());
  assert('attach opens the gamepad', padOpened === 1);
  assert('attach reports the matched profile', supervisor.activeProfile?.name === 'Test Pad');
  assert('attach emits an attached event', events.includes('attached'));

  // Data only counts as "connected" once packets actually arrive — that is what
  // the home-screen Controller tile reflects.
  virtualPad.emit('connected');
  virtualPad.emit('data', Buffer.from([0x00]));
  assert('supervisor forwards the connected event', events.includes('connected'));
  assert('supervisor forwards HID data', padData === 1);

  // Unpair the pad: one missed poll must not tear down a working device.
  padPresent = false;
  supervisor.poll();
  assert('a single missed enumeration does not detach', supervisor.isAttached());
  supervisor.poll();
  assert('two consecutive missed enumerations detach the pad', !supervisor.isAttached());
  assert('detach closes the gamepad', padClosed === 1);
  assert('detach emits a detached event', events.includes('detached'));
  assert('detach clears the active profile', supervisor.activeProfile === null);

  // …and it must be re-attachable, not permanently lost.
  padPresent = true;
  supervisor.poll();
  assert('a re-paired pad attaches again', supervisor.isAttached());
  assert('re-attach opens the gamepad again', padOpened === 2);

  // A pad macOS refuses to hand over must explain itself rather than fail silently.
  let lastDetail: string | null = null;
  supervisor.on('statusDetail', (d: string) => { lastDetail = d; });
  virtualPad.emit('openFailed', { kind: 'openDenied', err: new Error('cannot open device') });
  assert('open denial surfaces a status detail', typeof lastDetail === 'string');
  assert('Bluetooth open denial mentions exclusive-access contention',
    (lastDetail ?? '').includes('exclusively'));
  assert('supervisor exposes the status detail', supervisor.statusDetail === lastDetail);

  virtualPad.emit('connected');
  assert('a working connection clears the status detail', supervisor.statusDetail === null);

  // An idle pad is not a broken pad — the advice must say so before blaming permissions.
  const noDataDetail = explainOpenFailure({ kind: 'noData', err: null }, 'usb');
  assert('opened-but-silent pad says to move a stick first', noDataDetail.includes('Move a stick'));
  assert('opened-but-silent pad still points at Input Monitoring', noDataDetail.includes('Input Monitoring'));
  assert('USB open denial does not suggest a USB cable',
    !explainOpenFailure({ kind: 'openDenied', err: null }, 'usb').includes('USB cable'));

  supervisor.stop();

  // Test 14: environment profiles resolve into camera slots.
  // Slot order defines cam1..camN, which is also the X/A/B/Y hotkey order, so a
  // profile swap must renumber slots without touching anything downstream.
  console.log('\nTest 14: profiles resolve devices into camera slots');
  const inventory = {
    vbot: { label: 'V-BOT', protocol: 'visca' as const, cameraType: 'vbot' as const, viscaIp: '10.0.0.1', viscaPort: 52381, cameraAddress: 1, speedScale: 2 },
    rs3: { label: 'DJI RS3', protocol: 'dji-bridge' as const, cameraType: 'generic' as const, viscaPort: 52381, cameraAddress: 1, speedScale: 1,
           bridge: { host: 'pi.local', port: 7878, safetyTimeoutMs: 250, reconnectBackoffMs: [1000], rollEnabled: false } },
    rs3proA: { label: 'RS3 Pro A', protocol: 'dji-bridge' as const, cameraType: 'generic' as const, viscaPort: 52381, cameraAddress: 1, speedScale: 1,
               bridge: { host: 'pi.local', port: 7879, safetyTimeoutMs: 250, reconnectBackoffMs: [1000], rollEnabled: false } },
  };

  const prod = resolveProfile(inventory, { slots: [{ device: 'vbot', inputId: 6 }, { device: 'rs3', inputId: 4 }] });
  assert('resolves one camera per slot', prod.length === 2);
  assert('slot 1 becomes cam1', prod[0].id === 'cam1');
  assert('slot 2 becomes cam2', prod[1].id === 'cam2');
  assert('carries the device label', prod[0].label === 'V-BOT');
  assert('takes inputId from the slot, not the device', prod[1].inputId === 4);
  assert('carries device tuning (speedScale)', prod[0].speedScale === 2);
  assert('carries visca address', prod[0].viscaIp === '10.0.0.1');
  assert('carries the gimbal bridge port', prod[1].bridge?.port === 7878);

  // Same devices, different slots: the gimbal moves to cam1 and gets the X hotkey.
  const alt = resolveProfile(inventory, { slots: [{ device: 'rs3proA', inputId: 9 }, { device: 'vbot', inputId: 6 }] });
  assert('a device can occupy a different slot in another profile', alt[0].label === 'RS3 Pro A' && alt[0].id === 'cam1');
  assert('routing follows the slot (bridge port 7879 now cam1)', alt[0].bridge?.port === 7879);
  assert('same device keeps its tuning across profiles', alt[1].speedScale === 2);

  let profileErr = '';
  try {
    resolveProfile(inventory, { slots: [{ device: 'ghost', inputId: 1 }] });
  } catch (e) {
    profileErr = String((e as Error).message);
  }
  assert('unknown device in a slot throws instead of silently dropping', profileErr.includes('ghost'));

  // Test 15: control-only cameras (video not wired to the switcher).
  // Taking an unwired input would cut BLACK to air, so selecting such a camera
  // must hand over motion control without arming it, and takes must be refused.
  console.log('\nTest 15: unwired camera is control-only and cannot be taken live');
  const unwiredCams = resolveProfile(
    { ...inventory, rs3proA: inventory.rs3proA },
    { slots: [{ device: 'vbot', inputId: 6 }, { device: 'rs3proA' }] } // slot 2: no inputId
  );
  assert('unwired slot resolves with inputId undefined', unwiredCams[1].inputId === undefined);
  assert('wired slot keeps its inputId', unwiredCams[0].inputId === 6);

  const unwiredDevices = new Map<CameraId, MotionDevice>();
  for (const c of unwiredCams) {
    unwiredDevices.set(c.id as CameraId, new ViscaDevice(virtualViscas.cam1 as unknown as ViscaClient, c.id, c.label));
  }
  const uState: AppState = { ...defaultState, controlledCamera: 'cam1', programCamera: 'cam1', previewCamera: 'cam1', cameraIndex: 0 };

  // Selecting the unwired camera: control moves, preview bus must NOT.
  virtualAtem.log = [];
  const uSelector = new CameraSelector(uState, unwiredCams, atemProxy, unwiredDevices);
  uSelector.selectByIndex(1);
  assert('selecting unwired camera still takes motion control', uState.controlledCamera === 'cam2');
  assert('selecting unwired camera does NOT move the preview bus',
    !virtualAtem.log.some(l => l.includes('changePreviewInput')));
  assert('preview stays on the wired camera', uState.previewCamera === 'cam1');

  // Taking it live must be refused on both paths.
  virtualAtem.log = [];
  const pgmBefore = uState.programCamera;
  await autoTransitionControlledCamera(atemProxy, uState, unwiredCams, unwiredDevices);
  assert('RB take on unwired camera is refused (no autoTransition)',
    !virtualAtem.log.some(l => l.includes('autoTransition')));
  assert('program is unchanged after refused take', uState.programCamera === pgmBefore);

  // And the wired camera still works normally, so the guard is not over-broad.
  virtualAtem.log = [];
  uSelector.selectByIndex(0);
  assert('wired camera still moves the preview bus',
    virtualAtem.log.some(l => l.includes('changePreviewInput(6)')));
  virtualAtem.log = [];
  await autoTransitionControlledCamera(atemProxy, uState, unwiredCams, unwiredDevices);
  assert('wired camera can still be taken live',
    virtualAtem.log.some(l => l.includes('autoTransition')));

  // Test 16: saving Device Config must not destroy the devices it did not edit.
  //
  // Two real incidents, both from the same save path:
  //   * The Device Config tab renders every camera as VISCA, so a gimbal's
  //     absent viscaIp reached the form as the string "undefined", came back in
  //     the payload as a real IP, and the write-back overwrote protocol
  //     dji-bridge with visca. One click destroyed all three gimbals (#18).
  //   * The writer re-serialized the file, discarding every comment: the
  //     inventory explanation, the slot-to-hotkey mapping, and the note saying a
  //     slot may deliberately have no inputId (#14).
  console.log('\nTest 16: config saves keep gimbals gimbals, and keep the file documented');

  const fixture = [
    'atem:',
    '  ip: 192.168.50.153',
    '  defaultTransition: cut',
    '  meIndex: 0',
    'graphics:',
    '  type: dsk',
    '  dskIndex: 0',
    '  uskIndex: 0',
    '  meIndex: 0',
    '  # Fade duration in frames for the KEY on/off. 0 = hard cut.',
    '  fadeFrames: 15',
    '',
    '# Device inventory — every piece of hardware we own, described once.',
    'devices:',
    '  vbot:',
    '    label: "V-BOT"',
    '    protocol: "visca"',
    '    cameraType: "vbot"',
    '    viscaIp: "192.168.50.15"',
    '    viscaPort: 52381',
    '    cameraAddress: 1',
    '    speedScale: 2',
    '',
    '  # The gimbals share one Pi, one bridge instance per gimbal, one port each.',
    '  rs3:',
    '    label: "DJI RS3"',
    '    protocol: "dji-bridge"',
    '    bridge:',
    '      host: "dji-bridge.local"',
    '      port: 7878',
    '      gimbalModel: "RS3"',
    '      safetyTimeoutMs: 250',
    '      rollEnabled: false',
    '',
    '# Slot order IS cam1..camN: slot 1 = X, slot 2 = A, slot 3 = B, slot 4 = Y.',
    'activeProfile: production',
    'profiles:',
    '  production:',
    '    label: "Production"',
    '    slots:',
    '      - device: vbot',
    '        inputId: 6',
    '      - device: rs3',
    '        inputId: 4',
    '  test:',
    '    label: "Test"',
    '    slots:',
    '      - device: vbot',
    '        inputId: 6',
    '      # Deliberately no inputId: this camera is not wired to the switcher, so',
    '      # motion works but it cannot be taken live (that would cut black to air).',
    '      - device: rs3',
    '',
  ].join('\n');

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-config-'));
  const cfgPath = path.join(cfgDir, 'devices.yaml');
  const previousDevicesConfig = process.env.DEVICES_CONFIG;
  process.env.DEVICES_CONFIG = cfgPath;
  const resetFixture = (): void => fs.writeFileSync(cfgPath, fixture, 'utf8');
  const readYaml = (): any => YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
  const commentLines = (text: string): string[] =>
    text.split('\n').filter(l => l.trim().startsWith('#') || l.includes(' #'));

  // The exact body the broken Device Config tab sent for a gimbal. "undefined"
  // is a non-empty string, so it used to sail through validation.
  resetFixture();
  let brokenPayloadErr = '';
  try {
    validateDevicesConfig({
      atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
      graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
      cameras: [
        { id: 'cam1', label: 'V-BOT', cameraType: 'vbot', viscaIp: '192.168.50.15', viscaPort: 52381, cameraAddress: 1, speedScale: 2, inputId: 6 },
        { id: 'cam2', label: 'DJI RS3', cameraType: 'generic', viscaIp: 'undefined', viscaPort: 52381, cameraAddress: 1, speedScale: 1, inputId: 4 },
      ],
    });
  } catch (e) {
    brokenPayloadErr = String((e as Error).message);
  }
  assert('the payload that destroyed the gimbals is now rejected', brokenPayloadErr !== '');
  assert('rejection names viscaIp as the problem', brokenPayloadErr.includes('viscaIp'));
  assert('the string "undefined" is not accepted as an IP', /placeholder|hostname or IP/i.test(brokenPayloadErr));
  assert('a rejected save does not touch the file', fs.readFileSync(cfgPath, 'utf8') === fixture);

  for (const bogus of ['undefined', 'null', 'NaN', '  ']) {
    let err = '';
    try {
      validateDevicesConfig({
        atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
        cameras: [{ id: 'cam1', label: 'X', protocol: 'visca', viscaIp: bogus, inputId: 1 }],
      });
    } catch (e) { err = String((e as Error).message); }
    assert('viscaIp "' + bogus.trim() + '" is rejected', err !== '');
  }

  let bogusHostErr = '';
  try {
    validateDevicesConfig({
      atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
      cameras: [{ id: 'cam1', label: 'G', protocol: 'dji-bridge', bridge: { host: 'undefined', port: 7878 }, inputId: 1 }],
    });
  } catch (e) { bogusHostErr = String((e as Error).message); }
  assert('a bridge host of "undefined" is rejected too', bogusHostErr !== '');

  // A client that knows nothing about protocols (exactly what the tab sent) must
  // not be able to convert a gimbal by omission: missing means "leave alone".
  resetFixture();
  const omittingPayload = {
    atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
    graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
    cameras: [
      { id: 'cam1', label: 'V-BOT', cameraType: 'vbot', viscaIp: '192.168.50.15', viscaPort: 52381, cameraAddress: 1, speedScale: 2, inputId: 6 },
      { id: 'cam2', label: 'DJI RS3', cameraType: 'generic', speedScale: 1, inputId: 4 },
    ],
  };
  const omittingParsed = validateDevicesConfig(omittingPayload);
  assert('an omitted protocol resolves from the inventory, not the visca default',
    omittingParsed.cameras[1].protocol === 'dji-bridge');
  assert('the resolved gimbal still has its bridge', omittingParsed.cameras[1].bridge?.port === 7878);
  saveDevicesConfig(omittingParsed);
  assert('a protocol-blind save leaves the gimbal on dji-bridge', readYaml().devices.rs3.protocol === 'dji-bridge');
  assert('a protocol-blind save leaves the bridge block intact', readYaml().devices.rs3.bridge.port === 7878);
  assert('a protocol-blind save invents no viscaIp', readYaml().devices.rs3.viscaIp === undefined);

  // The fixed tab: it sends protocol + bridge host/port, and nothing else about
  // the bridge. The fields it does not render must survive anyway.
  resetFixture();
  const uiPayload = {
    atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
    graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
    cameras: [
      { id: 'cam1', label: 'V-BOT MAIN', protocol: 'visca', cameraType: 'vbot', viscaIp: '192.168.50.15', viscaPort: 52381, cameraAddress: 1, speedScale: 2.5, inputId: 6 },
      { id: 'cam2', label: 'DJI RS3', protocol: 'dji-bridge', cameraType: 'generic', speedScale: 1, inputId: null, bridge: { host: 'dji-bridge.local', port: 7878 } },
    ],
  };
  saveDevicesConfig(validateDevicesConfig(uiPayload));
  const afterUi = readYaml();
  assert('gimbal keeps protocol dji-bridge through a real UI save', afterUi.devices.rs3.protocol === 'dji-bridge');
  assert('gimbal keeps its bridge host/port', afterUi.devices.rs3.bridge.host === 'dji-bridge.local' && afterUi.devices.rs3.bridge.port === 7878);
  assert('bridge fields the form never showed survive (gimbalModel)', afterUi.devices.rs3.bridge.gimbalModel === 'RS3');
  assert('bridge fields the form never showed survive (safetyTimeoutMs)', afterUi.devices.rs3.bridge.safetyTimeoutMs === 250);
  assert('an edit the user did make is persisted (label)', afterUi.devices.vbot.label === 'V-BOT MAIN');
  assert('an edit the user did make is persisted (speedScale)', afterUi.devices.vbot.speedScale === 2.5);
  assert('the inventory is not reduced to the edited slots', Object.keys(afterUi.devices).length === 2);
  assert('every profile survives a device-config save', Object.keys(afterUi.profiles).length === 2);
  assert('cameras: stays derived, not written back as a stale list', afterUi.cameras === undefined);

  // Blank ATEM input means control-only. Defaulting it to an input would make an
  // unwired camera takeable to air, i.e. cut black to program.
  assert('a blank ATEM input clears the slot instead of defaulting to 1',
    afterUi.profiles.production.slots[1].inputId === undefined);
  assert('a blank ATEM input does not resolve to a wired camera',
    validateDevicesConfig(uiPayload).cameras[1].inputId === undefined);
  assert('the wired slot keeps its input', afterUi.profiles.production.slots[0].inputId === 6);
  assert('the untouched profile keeps its deliberately unwired slot',
    afterUi.profiles.test.slots[1].inputId === undefined && afterUi.profiles.test.slots[1].device === 'rs3');

  // Issue #14: the documentation has to be there after a save, not just before.
  const savedText = fs.readFileSync(cfgPath, 'utf8');
  assert('a save keeps every comment in the file',
    commentLines(savedText).length === commentLines(fixture).length);
  assert('the slot-to-hotkey mapping is still documented', savedText.includes('slot 1 = X'));
  assert('why a slot has no inputId is still documented', savedText.includes('not wired to the switcher'));
  assert('the inventory explanation is still documented', savedText.includes('Device inventory'));
  assert('the KEY fade comment stays attached to fadeFrames',
    /# Fade duration[^\n]*\n\s*fadeFrames:/.test(savedText));

  // Saving twice must be stable, or every save would churn the file.
  saveDevicesConfig(validateDevicesConfig(uiPayload));
  assert('a second identical save changes nothing', fs.readFileSync(cfgPath, 'utf8') === savedText);

  // The profile-tab writers share the same merge path.
  resetFixture();
  saveActiveProfile('test');
  const afterSwitch = fs.readFileSync(cfgPath, 'utf8');
  assert('switching the active profile is persisted', readYaml().activeProfile === 'test');
  assert('switching the active profile keeps the comments',
    commentLines(afterSwitch).length === commentLines(fixture).length);
  assert('switching the active profile keeps the inventory', Object.keys(readYaml().devices).length === 2);

  resetFixture();
  saveProfiles({ production: { label: 'Production', slots: [{ device: 'rs3', inputId: 4 }] }, test: { label: 'Test', slots: [{ device: 'vbot' }] } });
  const afterProfiles = fs.readFileSync(cfgPath, 'utf8');
  assert('saving profiles rewrites the slots', readYaml().profiles.production.slots[0].device === 'rs3');
  assert('saving profiles keeps a slot unwired when no input was given',
    readYaml().profiles.test.slots[0].inputId === undefined);
  assert('saving profiles keeps the inventory comments', afterProfiles.includes('Device inventory'));

  // A file with no comments at all must still round-trip cleanly.
  fs.writeFileSync(cfgPath, 'atem:\n  ip: 10.0.0.1\n  defaultTransition: cut\n  meIndex: 0\ncameras:\n  - id: cam1\n    label: Solo\n    protocol: visca\n    viscaIp: 10.0.0.2\n    inputId: 1\n', 'utf8');
  const legacy = validateDevicesConfig({
    atem: { ip: '10.0.0.1', defaultTransition: 'cut', meIndex: 0 },
    cameras: [{ id: 'cam1', label: 'Solo', protocol: 'visca', viscaIp: '10.0.0.3', viscaPort: 52381, cameraAddress: 1, speedScale: 1, inputId: null }],
  });
  saveDevicesConfig(legacy);
  assert('a legacy cameras-only config still saves', readYaml().cameras[0].viscaIp === '10.0.0.3');
  assert('a legacy config with a blank input stores no inputId', readYaml().cameras[0].inputId === undefined);

  if (previousDevicesConfig === undefined) delete process.env.DEVICES_CONFIG;
  else process.env.DEVICES_CONFIG = previousDevicesConfig;
  fs.rmSync(cfgDir, { recursive: true, force: true });

  // Results
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('smoke test error:', err);
  process.exit(1);
});
