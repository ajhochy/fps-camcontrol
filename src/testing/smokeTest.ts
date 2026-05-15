import { defaultState, AppState, CameraId } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { VirtualController } from './virtualController';
import { VirtualAtem } from './virtualAtem';
import { VirtualVisca } from './virtualVisca';
import { ControlStateMachine } from '../model/controlStateMachine';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { PresetManager } from '../model/presetManager';
import { SpeedManager } from '../model/speedManager';
import { CameraSelector } from '../model/cameraSelector';
import { emergencyStopAll } from '../safety/emergencyStop';
import { EdgeState, createEdgeState, risingEdge, triggerRisingEdge } from '../input/edgeTriggers';
import { applyCurve, applyDeadzone, clamp } from '../visca/speedCurves';
import { panTilt, zoom, stopPTZ } from '../visca/ptzActions';
import { cutControlledCameraLive, autoTransitionControlledCamera } from '../atem/switcherActions';

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
  atem: { ip: '127.0.0.1', defaultTransition: 'cut' },
  cameras: [
    { id: 'cam1', label: 'BirdDog Left', inputId: 1, viscaIp: '127.0.0.1', viscaPort: 52381 },
    { id: 'cam2', label: 'BirdDog Center', inputId: 2, viscaIp: '127.0.0.1', viscaPort: 52381 },
    { id: 'cam3', label: 'V-BOT', inputId: 3, viscaIp: '127.0.0.1', viscaPort: 52381 },
  ],
  lowerThirds: { type: 'dsk', dskIndex: 0 },
  speeds: {
    presets: [
      { name: 'Slow', multiplier: 0.2 },
      { name: 'Normal', multiplier: 0.5 },
      { name: 'Fast', multiplier: 1.0 },
    ],
    activePreset: 1,
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

// ---- Wire virtual VISCA clients via duck-typing ----
const viscaClients = new Map<CameraId, any>();
for (const [id, vv] of Object.entries(virtualViscas)) {
  viscaClients.set(id as CameraId, vv);
}

// ---- Wire virtual ATEM client via duck-typing ----
const atemProxy = virtualAtem as unknown as AtemClient;

// ---- Build sub-systems ----
const edgeState: EdgeState = createEdgeState();
const cameraSelector = new CameraSelector(state, config.cameras, atemProxy, viscaClients);

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

  // LT precision mode
  state.precisionMode = (triggers['leftTrigger'] ?? 0) >= 0.3;
  state.sprintMode = buttons['LS'] ?? false;

  // Camera selector
  const leftX = applyDeadzone(axes['leftStickX'] ?? 0);
  cameraSelector.handleLeftStickX(leftX);

  // PT
  const rightX = applyDeadzone(axes['rightStickX'] ?? 0);
  const rightY = applyDeadzone(axes['rightStickY'] ?? 0);
  const leftY = applyDeadzone(axes['leftStickY'] ?? 0);
  const currentClient = viscaClients.get(state.controlledCamera);
  if (currentClient) {
    const mul = config.speeds.presets[state.speedPreset].multiplier;
    const speed = (v: number) => clamp(applyCurve(v) * mul * (state.precisionMode ? 0.25 : 1) * (state.sprintMode ? 1.75 : 1), -1, 1);
    panTilt(currentClient, speed(rightX), speed(-rightY));
    zoom(currentClient, speed(-leftY));
  }

  // RT
  if (triggerRisingEdge('rightTrigger', triggers['rightTrigger'] ?? 0, 0.5, edgeState)) {
    await cutControlledCameraLive(atemProxy, state, config.cameras);
  }

  // RB
  if (risingEdge('RB', buttons['RB'] ?? false, edgeState)) {
    await autoTransitionControlledCamera(atemProxy, state, config.cameras);
  }

  // Emergency stop
  if (risingEdge('back', buttons['back'] ?? false, edgeState)) {
    await emergencyStopAll(state, config, atemProxy, viscaClients);
  }

  // Lower thirds
  const ltToggle =
    risingEdge('dpadLeft', buttons['dpadLeft'] ?? false, edgeState) ||
    risingEdge('dpadRight', buttons['dpadRight'] ?? false, edgeState);
  if (ltToggle) {
    state.lowerThirdsActive = !state.lowerThirdsActive;
    await virtualAtem.setDownstreamKeyOnAir(config.lowerThirds.dskIndex, state.lowerThirdsActive);
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

  // Test 4: RT cut live
  console.log('\nTest 4: RT cut → cam3 live, controlledCamera unchanged');
  virtualAtem.log = [];
  await tick({ triggers: { rightTrigger: 0 } });
  await tick({ triggers: { rightTrigger: 0.8 } });
  assert('ATEM cut called', virtualAtem.log.some(l => l.includes('cut()')));
  assert('programCamera = cam3', state.programCamera === 'cam3');
  assert('controlledCamera still cam3 after cut', state.controlledCamera === 'cam3');

  // Test 5: Flick left after cut → cam2 controlled, live cam3 unchanged
  console.log('\nTest 5: Flick left after cut → cam2 controlled, live cam3 unchanged');
  virtualAtem.log = [];
  await tick({ triggers: { rightTrigger: 0 } });
  await tick({ axes: { leftStickX: -0.9 } });
  await tick({ axes: { leftStickX: 0 } });
  assert('controlledCamera = cam2', state.controlledCamera === 'cam2');
  assert('ATEM preview updated to inputId 2', virtualAtem.log.some(l => l.includes('changePreviewInput(2)')));
  assert('programCamera still cam3 (live unchanged)', state.programCamera === 'cam3');

  // Test 6: Emergency stop
  console.log('\nTest 6: Emergency stop');
  state.lowerThirdsActive = true;
  virtualViscas.cam1.reset(); virtualViscas.cam2.reset(); virtualViscas.cam3.reset();
  virtualAtem.log = [];
  await tick({ buttons: { back: false } });
  await tick({ buttons: { back: true } });
  assert('lower thirds turned off', !state.lowerThirdsActive);
  assert('DSK set off in ATEM log', virtualAtem.log.some(l => l.includes('setDownstreamKeyOnAir(0, false)')));

  // Test 7: Preset save — queries real camera position via VISCA inquiry
  console.log('\nTest 7: Preset save via LB+A — queries real VISCA position');
  virtualViscas.cam2.state = { pan: 1234, tilt: -500, zoom: 8192 };
  virtualViscas.cam2.reset();
  state.controlledCamera = 'cam2';
  const presetManager = new PresetManager(state, config, viscaClients);
  await presetManager.savePreset('cam2', 'A');
  const data = presetManager.getData();
  assert('cam2 slot A has position data', data['cam2']?.['A'] !== null);
  assert('cam2 slot A pan = 1234', (data['cam2']?.['A'] as any)?.pan === 1234);
  assert('cam2 slot A tilt = -500', (data['cam2']?.['A'] as any)?.tilt === -500);
  assert('cam2 slot A zoom = 8192', (data['cam2']?.['A'] as any)?.zoom === 8192);
  assert('VirtualVisca received pan/tilt inquiry', virtualViscas.cam2.log.some(l => l.includes('inquire(')));

  // Test 8: Preset recall
  console.log('\nTest 8: Preset recall via A');
  virtualViscas.cam2.reset();
  state.controlledCamera = 'cam2';
  await presetManager.recallPreset('cam2', 'A');
  assert('cam2 VISCA received absolute position command', virtualViscas.cam2.log.length > 0);

  // Test 9: Preset clear
  console.log('\nTest 9: Preset clear');
  presetManager.clearPreset('cam2', 'A');
  const dataAfterClear = presetManager.getData();
  assert('cam2 slot A is null after clear', dataAfterClear['cam2']?.['A'] === null);

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
