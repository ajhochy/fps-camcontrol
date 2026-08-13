import { createInitialState, trackDeviceLinkState, AppState, CameraId } from '../app/state';
import { AppConfig, resolveProfile } from '../config/configLoader';
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
// createInitialState, not { ...defaultState }: the latter is a shallow copy, so
// every test state would share one cameraConnected object and leak into the next.
const state: AppState = createInitialState({
  controlledCamera: 'cam2',
  programCamera: 'cam2',
  previewCamera: 'cam2',
  cameraIndex: 1,
});

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
  const djiState: AppState = createInitialState({ controlledCamera: 'cam4' });
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
  const uState: AppState = createInitialState({ controlledCamera: 'cam1', programCamera: 'cam1', previewCamera: 'cam1', cameraIndex: 0 });

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

  // Test 17: a reachable bridge with no gimbal is NOT a connected camera.
  // Regression guard for issue #16: `connected` fired on the `hello` handshake,
  // so a gimbal whose BLE link was gone still showed green and could be taken
  // live. Two behaviours were measured on the real Pi and are modelled by the
  // virtual bridge here: a bridge with no gimbal keeps acking hello/ping and
  // emits NO `status` frames at all (it never sends gimbalConnected:false), but
  // it rejects any gimbal-touching call instantly with `sdk_error`.
  console.log('\nTest 17: bridge reachable but gimbal detached reports as disconnected');

  // Short quiet window so the check fires in test time; the real device waits
  // 10s against a ~2s telemetry cadence.
  const gimbalBridge = new VirtualDjiBridge({ statusIntervalMs: 100, safetyTimeoutMs: 250 });
  const gimbalPort = await gimbalBridge.start();
  const gDev = new DjiBridgeDevice(
    {
      host: '127.0.0.1', port: gimbalPort, safetyTimeoutMs: 250,
      reconnectBackoffMs: [50], rollEnabled: false, gimbalStatusTimeoutMs: 600,
    },
    'cam2', 'DJI RS3',
  );

  const gState = createInitialState({ controlledCamera: 'cam2' });
  trackDeviceLinkState(gState, 'cam2', gDev as unknown as MotionDevice);

  await new Promise<void>((resolve) => { gDev.once('connected', () => resolve()); gDev.connect(); });
  await new Promise(r => setTimeout(r, 300)); // let a status frame or two land

  assert('attached gimbal: device reports gimbalAttached', gDev.gimbalAttached === true);
  assert('attached gimbal: cameraConnected true', gState.cameraConnected['cam2'] === true);
  assert('attached gimbal: bridge recorded as reachable', gState.cameraBridgeReachable['cam2'] === true);
  assert('attached gimbal: gimbal recorded as attached', gState.cameraGimbalAttached['cam2'] === true);

  // Power the gimbal off. The WebSocket stays up and pings keep acking; the
  // status stream simply stops — exactly what the Pi does. Detection therefore
  // has to come from the active check the quiet window triggers.
  gimbalBridge.setGimbalConnected(false);
  const detached = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    gDev.once('gimbalDetached', () => { clearTimeout(t); resolve(true); });
  });
  assert('silent telemetry plus a rejected check detects a detached gimbal', detached);
  assert('detached gimbal: cameraConnected flips to false', gState.cameraConnected['cam2'] === false);
  assert('detached gimbal: bridge still reported REACHABLE (distinguishable)',
    gState.cameraBridgeReachable['cam2'] === true);
  assert('detached gimbal: gimbal reported as not attached', gState.cameraGimbalAttached['cam2'] === false);
  assert('detached gimbal: bridge socket really is still up', gDev.connected === true);
  assert('detached gimbal: ping still round-trips to the bridge', (await gDev.probe(1000)) === true);

  // Powering it back on returns to connected.
  gimbalBridge.setGimbalConnected(true);
  const reattached = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    gDev.once('gimbalAttached', () => { clearTimeout(t); resolve(true); });
  });
  assert('gimbal powered back on returns to attached', reattached);
  assert('re-attached gimbal: cameraConnected true again', gState.cameraConnected['cam2'] === true);

  // A bridge that DOES report gimbalConnected:false explicitly must be honoured
  // too, so this keeps working if the Pi later grows a heartbeat status frame.
  gimbalBridge.explicitDetachedStatus = true;
  gimbalBridge.setGimbalConnected(false);
  const explicit = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    gDev.once('gimbalDetached', () => { clearTimeout(t); resolve(true); });
  });
  assert('explicit gimbalConnected:false is honoured immediately', explicit);
  assert('explicit detach: cameraConnected false', gState.cameraConnected['cam2'] === false);

  // A failing motion command is the fastest and most direct evidence there is —
  // it is literally the operator's "I pressed the stick and nothing moved". It
  // must not wait for the quiet window.
  gimbalBridge.explicitDetachedStatus = false;
  gimbalBridge.setGimbalConnected(true);
  await new Promise<void>((resolve) => {
    if (gDev.gimbalAttached) return resolve();
    gDev.once('gimbalAttached', () => resolve());
  });
  gimbalBridge.setGimbalConnected(false);
  const failedCommandDetect = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 1000);
    gDev.once('gimbalDetached', () => { clearTimeout(t); resolve(true); });
    gDev.setPanTilt(0.5, 0); // nacked with sdk_error by a bridge with no gimbal
  });
  assert('a rejected motion command detects the detached gimbal at once', failedCommandDetect);
  assert('rejected command: cameraConnected false', gState.cameraConnected['cam2'] === false);

  // The inverse must NOT happen: a gimbal that is merely SLOW must never be
  // reported as absent. On a shared bridge a healthy gimbal's pose poll was
  // measured at 13.6s, so an unanswered check has to stay inconclusive.
  const slowBridge = new VirtualDjiBridge({ statusIntervalMs: 100, safetyTimeoutMs: 250 });
  const slowPort = await slowBridge.start();
  const slowDev = new DjiBridgeDevice(
    {
      host: '127.0.0.1', port: slowPort, safetyTimeoutMs: 250,
      reconnectBackoffMs: [50], rollEnabled: false, gimbalStatusTimeoutMs: 300,
    },
    'cam3', 'DJI slow',
  );
  await new Promise<void>((resolve) => { slowDev.once('connected', () => resolve()); slowDev.connect(); });
  await new Promise(r => setTimeout(r, 250));
  assert('slow bridge: starts attached', slowDev.gimbalAttached === true);
  // Telemetry stops and the bridge answers NOTHING (not even a rejection) —
  // the contended-but-healthy case, which must leave the verdict untouched.
  slowBridge.goSilent();
  await new Promise(r => setTimeout(r, 3000));
  assert('an unanswered gimbal check leaves a healthy gimbal attached',
    slowDev.gimbalAttached === true);
  assert('slow bridge: still reported connected', slowDev.connected === true);
  slowDev.close();
  await slowBridge.stop();

  // Now the OTHER failure: the bridge itself goes away. This must look different
  // from a detached gimbal, because the remedy is different.
  gDev.close();
  await gimbalBridge.stop();
  await new Promise(r => setTimeout(r, 50));
  assert('unreachable bridge: cameraConnected false', gState.cameraConnected['cam2'] === false);
  assert('unreachable bridge: bridge reported NOT reachable (vs. true when only the gimbal is off)',
    gState.cameraBridgeReachable['cam2'] === false);
  assert('unreachable bridge: device transport is down', gDev.connected === false);

  // VISCA must be unaffected: no second stage, so no gimbal keys at all, and a
  // missing key must never be read as "detached".
  const viscaState = createInitialState();
  const viscaDev = new ViscaDevice(virtualViscas.cam1 as unknown as ViscaClient, 'cam1', 'V-BOT');
  trackDeviceLinkState(viscaState, 'cam1', viscaDev);
  assert('VISCA device exposes no gimbalAttached notion',
    (viscaDev as MotionDevice).gimbalAttached === undefined);
  assert('VISCA camera gets no gimbal detail key',
    !Object.prototype.hasOwnProperty.call(viscaState.cameraGimbalAttached, 'cam1'));
  assert('VISCA camera gets no bridge detail key',
    !Object.prototype.hasOwnProperty.call(viscaState.cameraBridgeReachable, 'cam1'));
  assert('VISCA cameraConnected still tracks the socket',
    viscaState.cameraConnected['cam1'] === viscaDev.connected);

  // Taking a gimbal-off camera live is deliberately ALLOWED (its video is fine,
  // only motion is dead) — unlike an unwired camera, whose take cuts black.
  // Blocking it would mean a sleeping gimbal silently swallows the operator's
  // take and leaves the wrong camera on air.
  const gimbalOffCams = resolveProfile(inventory, { slots: [{ device: 'vbot', inputId: 6 }, { device: 'rs3', inputId: 4 }] });
  const offDevices = new Map<CameraId, MotionDevice>();
  offDevices.set('cam1' as CameraId, new ViscaDevice(virtualViscas.cam1 as unknown as ViscaClient, 'cam1', 'V-BOT'));
  offDevices.set('cam2' as CameraId, gDev as unknown as MotionDevice); // detached gimbal
  const offState = createInitialState({ controlledCamera: 'cam2', programCamera: 'cam1', previewCamera: 'cam2', cameraIndex: 1 });
  virtualAtem.log = [];
  await autoTransitionControlledCamera(atemProxy, offState, gimbalOffCams, offDevices);
  assert('take on a gimbal-off camera is allowed (video is still valid)',
    virtualAtem.log.some(l => l.includes('autoTransition')));
  assert('take on a gimbal-off camera still updates program', offState.programCamera === 'cam2');

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
