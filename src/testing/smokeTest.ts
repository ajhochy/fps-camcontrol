import { defaultState, AppState, CameraId } from '../app/state';
import { AppConfig } from '../config/configLoader';
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
    process.env.STATUS_PORT = '0';
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

  // Sony contract: catches regressions that expose the sidecar to browsers,
  // render disconnected cameras, accept unsafe proxy input, or omit required UI behavior.
  console.log('\nTest 9b: Sony dashboard and narrow sidecar proxy');
  const http = require('http');
  const upstreamRequests: Array<{ method: string; url: string; body: string }> = [];
  const sonyProperties = {
    properties: {
      aperture: { current_value: 28, current_formatted: 'F2.8', writable: true, available_values: [{ value: 28, formatted: 'F2.8' }, { value: 40, formatted: 'F4' }] },
      'shutter-speed': { current_value: '1/50', current_formatted: '1/50', writable: true, available_values: [{ value: '1/50', formatted: '1/50' }] },
      iso: { current_value: 800, current_formatted: 'ISO 800', writable: true, available_values: [{ value: 800, formatted: 'ISO 800' }] },
      'white-balance': { current_value: 'auto', current_formatted: 'Auto', writable: true, available_values: [{ value: 'auto', formatted: 'Auto' }] },
      'focus-mode': { current_value: 'af-c', current_formatted: 'AF-C', writable: true, available_values: [{ value: 'af-c', formatted: 'AF-C' }] },
      'focus-area': { current_value: 'wide', current_formatted: 'Wide', writable: true, available_values: [{ value: 'wide', formatted: 'Wide' }] },
    },
  };
  const fakeSony = http.createServer((req: any, res: any) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      upstreamRequests.push({ method: req.method, url: req.url, body });
      if (req.url === '/api/cameras') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ cameras: [
          { id: 'AA:BB:CC:DD:EE:01', model: 'ILCE-7SM3 A', connected: true, connectionType: 'USB' },
          { id: 'AA:BB:CC:DD:EE:02', model: 'ILME-FX3 B', connected: true, connectionType: 'Wi-Fi' },
          { id: 'AA:BB:CC:DD:EE:03', model: 'ILCE-7IV C', connected: true, connectionType: 'USB' },
          { id: 'AA:BB:CC:DD:EE:04', model: 'ILME-FX30 D', connected: true, connectionType: 'Wi-Fi' },
          { id: 'AA:BB:CC:DD:EE:05', model: 'Offline', connected: false, connectionType: 'USB' },
        ] }));
      } else if (req.url?.endsWith('/connection') && req.method === 'GET') {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({
          camera: req.url.includes('AA:BB:CC:DD:EE:01') ? { id: 'AA:BB:CC:DD:EE:01', model: 'ILCE-7SM3 A', connected: true } : { connected: /EE:0[2-4]/.test(req.url) },
          data: req.url.includes('AA:BB:CC:DD:EE:01') ? { mode: 'remote' } : {},
        }));
      } else if (req.url?.endsWith('/properties/all')) {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: sonyProperties }));
      } else if (req.url?.endsWith('/live-view/frame')) {
        res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      } else {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>(resolve => fakeSony.listen(0, '127.0.0.1', resolve));
  const fakeSonyPort = (fakeSony.address() as any).port;
  process.env.SONY_API_URL = `http://127.0.0.1:${fakeSonyPort}`;
  const { createStatusServer: createSonyStatusServer } = require('../ui/statusServer');
  const sonyApp = createSonyStatusServer(state, config, presetManager);
  const sonyServer = await new Promise<any>(resolve => {
    const server = sonyApp.listen(0, '127.0.0.1', () => resolve(server));
  });
  const sonyBase = `http://127.0.0.1:${sonyServer.address().port}`;
  const sonyGet = async (path: string, init?: any) => {
    const response = await fetch(sonyBase + path, init);
    const text = await response.text();
    return { response, text };
  };
  const home = await sonyGet('/');
  assert('Sony UI is below existing home controls', home.text.indexOf('id="sony-cameras"') > home.text.indexOf('id="home"'));
  const expectedSonyProperties = ['aperture', 'shutter-speed', 'iso', 'white-balance', 'focus-mode', 'focus-area'];
  const sonyPropertyArray = home.text.match(/var SONY_PROPERTIES = (\[[^;]+\]);/);
  assert('Sony UI uses exactly the six live upstream property names', sonyPropertyArray !== null && JSON.stringify(JSON.parse(sonyPropertyArray[1].replace(/'/g, '"'))) === JSON.stringify(expectedSonyProperties));
  assert('Sony camera IDs are escaped in every generated HTML attribute', (home.text.match(/esc\(camera\.id\)/g) || []).length >= 4 && (home.text.match(/esc\(key\)/g) || []).length >= 5 && !home.text.includes('data-camera-id="\' + camera.id + \'"'));
  assert('Sony UI includes sequential hidden-aware bounded preview polling', home.text.includes('document.hidden') && home.text.includes('setTimeout') && home.text.includes('sony-preview-stale'));
  assert('Sony UI includes contained-image touch mapping and keyboard fallback', home.text.includes('naturalWidth') && home.text.includes('Apply touch point') && home.text.includes('aria-live'));
  assert('Sony UI explains camera Touch Function behavior', home.text.includes('Touch Function determines focus vs tracking'));
  assert('Device Config has explicit Sony discovery/connect controls', home.text.includes('sony-device-config') && home.text.includes('Connect'));
  // UI review repair: catches five-second wholesale DOM replacement that loses focus,
  // select values, previews, and can start overlapping property requests/pollers.
  assert('Sony refresh reconciles widgets by camera ID without replacing the root', home.text.includes('sony-grid-root') && home.text.includes('appendChild') && home.text.includes('state.article.remove()') && !home.text.includes("root.innerHTML = '<div class=\"section-header\">Sony Cameras"));
  assert('Sony reconciliation preserves existing controls and prevents overlapping property loads', home.text.includes('updateSonyWidget') && home.text.includes('state.loadingProperties'));
  assert('Sony widget removal deactivates polling, cancels its timer, and revokes its object URL', home.text.includes('state.active = false') && home.text.includes('clearTimeout(state.timer)') && home.text.includes('URL.revokeObjectURL(state.frameUrl)'));
  assert('Sony layout has a below-320px one-column overflow guard', home.text.includes('@media (max-width:319px)') && home.text.includes('.sony-controls { grid-template-columns:1fr; }') && home.text.includes('min-width:0'));
  assert('Sony loading, stale, recovered, and live-view failure states are accessible', home.text.includes('sony-preview-loading') && home.text.includes('Live preview loading') && home.text.includes("sonyStatus(id, 'Live preview stale.'") && home.text.includes("'Live preview recovered.'") && home.text.includes('Live preview failed to start'));
  // Re-review regression: repeated frames/failures must not rewrite aria-live;
  // these assertions fail if pollSonyFrame announces outside state transitions.
  assert('Sony preview aria-live updates only on loading/ready/stale/recovered transitions', home.text.includes("previewAnnouncementState:'loading'") && home.text.includes("state.previewAnnouncementState === 'loading') sonyStatus(id, 'Live preview ready.'") && home.text.includes("state.previewAnnouncementState === 'stale') sonyStatus(id, 'Live preview recovered.'") && home.text.includes("state.previewAnnouncementState !== 'stale') sonyStatus(id, 'Live preview stale.'") && !home.text.includes("sonyStatus(id, recovered ?"));
  assert('Sony discovery and connect failures clear stale state and report accessibly', home.text.includes('sonyDiscovered = [];') && home.text.includes('sony-device-status') && home.text.includes("if (!response.ok) throw new Error('Connect failed')"));
  assert('Sony controls alone have 44px targets', home.text.includes('.sony-widget select, .sony-widget input, .sony-widget button { min-height:44px; }'));
  assert('Sony desktop layout has four equal widget columns with 16:9 previews', home.text.includes('grid-template-columns:repeat(4,minmax(0,1fr))') && home.text.includes('aspect-ratio:16 / 9'));
  assert('Sony layout uses two widget columns on tablet and one on mobile', home.text.includes('@media (max-width:1100px)') && home.text.includes('@media (max-width:700px)'));
  assert('Sony settings remain a compact two-column grid at desktop widths', home.text.includes('.sony-controls { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));'));
  assert('Every Sony widget has a heading labeling its article and preview', (home.text.match(/aria-labelledby="sony-heading-/g) || []).length === 2 && home.text.includes('<h3 class="sony-widget__title" id="sony-heading-'));
  assert('Browser code only references CamControl Sony API', !home.text.includes(`127.0.0.1:${fakeSonyPort}`) && !home.text.includes('127.0.0.1:8181'));

  const camerasResult = await sonyGet('/api/sony/cameras');
  const camerasJson = JSON.parse(camerasResult.text);
  assert('Sony proxy returns four connected plus one disconnected fixtures', camerasJson.cameras.filter((camera: any) => camera.connected).length === 4 && camerasJson.cameras.filter((camera: any) => !camera.connected).length === 1);
  // Regression: discovery can hang after the first scan; known cameras must be
  // checked individually and retain the nested live connection response shape.
  const discoveryRequests = () => upstreamRequests.filter(request => request.url === '/api/cameras').length;
  const discoveredOnce = discoveryRequests();
  await sonyGet('/api/sony/cameras/AA:BB:CC:DD:EE:01/connect', { method: 'POST' });
  const refreshedCameras = JSON.parse((await sonyGet('/api/sony/cameras')).text);
  assert('Sony repeated list reuses cached identities without rediscovery', discoveryRequests() === discoveredOnce);
  assert('Sony connection checks merge nested camera and data fields', refreshedCameras.cameras[0]?.mode === 'remote' && refreshedCameras.cameras[0]?.connected === true);
  const badId = await sonyGet('/api/sony/cameras/not-a-mac/properties');
  assert('Sony proxy rejects non-MAC camera IDs', badId.response.status === 400);
  const badProperty = await sonyGet('/api/sony/cameras/AA:BB:CC:DD:EE:01/properties/evil', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 1 }) });
  assert('Sony proxy rejects properties outside six-name allowlist', badProperty.response.status === 400);
  for (const property of expectedSonyProperties) {
    await sonyGet(`/api/sony/cameras/AA:BB:CC:DD:EE:01/properties/${property}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 1 }) });
  }
  assert('Sony proxy forwards exactly six upstream-compatible property names', expectedSonyProperties.every(property => upstreamRequests.some(request => request.url === `/api/cameras/AA:BB:CC:DD:EE:01/properties/${property}`)));
  const badValue = await sonyGet('/api/sony/cameras/AA:BB:CC:DD:EE:01/properties/iso', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: { unsafe: true } }) });
  assert('Sony proxy rejects non-scalar property values', badValue.response.status === 400);
  const badTouch = await sonyGet('/api/sony/cameras/AA:BB:CC:DD:EE:01/touch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ normalized: { x: 2, y: 0.5 } }) });
  assert('Sony proxy rejects out-of-range touch coordinates', badTouch.response.status === 400);
  const goodTouch = await sonyGet('/api/sony/cameras/AA:BB:CC:DD:EE:01/touch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ normalized: { x: 0.25, y: 0.75 } }) });
  assert('Sony proxy accepts normalized touch coordinates', goodTouch.response.status === 200);
  assert('Sony upstream receives literal colon camera ID', upstreamRequests.some(request => request.url === '/api/cameras/AA:BB:CC:DD:EE:01/actions/touch'));
  await new Promise<void>(resolve => sonyServer.close(resolve));
  await new Promise<void>(resolve => fakeSony.close(resolve));
  delete process.env.SONY_API_URL;

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
