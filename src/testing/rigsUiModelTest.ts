import assert from 'assert';
import path from 'path';
import { AppConfig, resolveProfile, InventoryDevice, Profile } from '../config/configLoader';
import { buildRigs } from '../config/rigs';
import { createInitialState } from '../app/state';

/**
 * The rigs screen's logic (ui/rigs/rigsModel.js) fed with a real /api/rigs payload built by buildRigs, so the
 * two cannot drift apart. Run: npx ts-node src/testing/rigsUiModelTest.ts
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = require(path.resolve(__dirname, '../../ui/rigs/rigsModel.js'));

let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const devices: Record<string, InventoryDevice> = {
  vbot: { label: 'V-BOT', protocol: 'visca', cameraType: 'vbot', viscaIp: '192.168.50.15', viscaPort: 52381, cameraAddress: 1, speedScale: 2 },
  birddog1: { label: 'BirdDog 1', protocol: 'visca', cameraType: 'birddog', viscaIp: '192.168.50.16', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
  rs3: { label: 'DJI RS3', protocol: 'dji-bridge', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1, bridge: { host: 'dji-bridge.local', port: 7878, gimbalModel: 'RS3', safetyTimeoutMs: 250, reconnectBackoffMs: [1000], rollEnabled: false } },
  'sony-a': { label: 'a7S III — stage left', protocol: 'sony', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1, sonyCameraId: '9C:50:D1:AC:7B:72' },
  'sony-b': { label: 'FX3A — stage right', protocol: 'sony', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1, sonyCameraId: '78:F5:05:43:AD:50' },
  'sony-c': { label: 'Not yet bound', protocol: 'sony', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
};
const profiles: Record<string, Profile> = {
  production: { label: 'Production', slots: [{ device: 'vbot', inputId: 6, camera: 'sony-a' }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', camera: 'sony-b' }] },
  test: { label: 'Test', slots: [{ device: 'vbot', inputId: 6, camera: 'sony-a' }, { device: 'rs3' }] },
};
const config = (activeProfile?: string): AppConfig => ({
  atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
  cameras: activeProfile ? resolveProfile(devices, profiles[activeProfile]) : [],
  graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
  speeds: {} as AppConfig['speeds'],
  mappings: { selectCam1: 'X', selectCam2: 'A', selectCam3: 'B', selectCam4: 'Y' } as unknown as AppConfig['mappings'],
  devices, profiles, activeProfile,
});
const state = createInitialState({} as never);
state.cameraConnected = { cam1: true, cam2: false };
state.cameraBridgeReachable = { cam3: true };
state.cameraGimbalAttached = { cam3: false };
const sonyCameras = [
  { id: '9C:50:D1:AC:7B:72', model: 'ILCE-7SM3', state: 'connected', approved: true, lastSeenAt: null, nextRetryAt: null, message: null },
  { id: '78:F5:05:43:AD:50', model: 'ILME-FX3A', state: 'error', approved: true, lastSeenAt: null, nextRetryAt: null, message: 'Camera connection failed' },
  { id: 'AA:00:00:00:00:09', model: 'ILCE-7M4', state: 'discovered_unapproved', approved: false, lastSeenAt: null, nextRetryAt: null, message: null },
];
const payload = (cfg = config('production'), atemConnected: boolean | null = false): any => ({
  ...buildRigs(cfg, state, 'v1', sonyCameras), atemConnected, sony: { sidecar: { state: 'healthy', mode: 'external', message: null }, cameras: sonyCameras },
});
const data = payload();

// ---- list
const sections = model.itemsOf(data);
check('the list has a Rigs section and a Connections section, in that order', sections.map((s: any) => s.id).join() === 'rigs,connections');
const rigItems = sections[0].items;
check('one list item per rig, keyed by device', rigItems.map((i: any) => i.key).join() === 'rig:vbot,rig:birddog1,rig:rs3');
check('a rig item shows its name and controller type', rigItems[0].title === 'V-BOT' && rigItems[0].subtitle === 'V-BOT' && rigItems[2].subtitle === 'DJI gimbal' && rigItems[1].subtitle === 'BirdDog');
check('a rig badge is its hotkey', rigItems.map((i: any) => i.badge).join() === 'X,A,B');
check('a wired rig shows its ATEM input and an unwired one says control only', rigItems[0].chips[0].text === 'ATEM 6' && rigItems[2].chips[0].text === 'Control only' && rigItems[2].chips[0].tone === 'warn');
check('the camera chip shows the Sony camera name, the built-in camera, or a warning', rigItems[0].chips[1].text === 'a7S III — stage left' && rigItems[1].chips[1].text === 'Built-in camera' && payload(config('test')).rigs[1].camera === null);
const noCamera = model.itemsOf(payload(config('test')))[0].items[1];
check('a V-BOT or gimbal rig with no camera gets a warning chip', noCamera.chips[1].text === 'No camera assigned' && noCamera.chips[1].tone === 'warn');
check('a rig status dot follows the controller link', rigItems[0].dot === 'ok' && rigItems[1].dot === 'bad' && rigItems[2].dot === 'idle');
const connections = sections[1].items;
check('Connections holds the ATEM and one Sony connections item, not one item per camera', connections.map((i: any) => i.key).join() === 'atem,sony');
check('the ATEM is its own item with its address', connections[0].title === 'ATEM switcher' && connections[0].subtitle === '192.168.50.153');
check('the ATEM dot follows its connection', connections[0].dot === 'bad' && model.itemsOf(payload(config('production'), true))[1].items[0].dot === 'ok' && model.itemsOf(payload(config('production'), null))[1].items[0].dot === 'idle');
const sonyItem = connections[1];
check('the Sony connections item counts every camera, named or new', sonyItem.title === 'Sony connections' && sonyItem.subtitle === '4 cameras');
check('it summarizes how many are connected and how many are new', sonyItem.chips.map((c: any) => c.text).join('|') === '1 of 4 connected|1 new');
check('it shows trouble when a camera has an error', sonyItem.dot === 'bad');
const allGood = payload();
allGood.sonyDevices = [{ key: 'a', label: 'A', sonyCameraId: 'X', model: 'M', state: 'connected', usedByRigs: [], usedInProfiles: [] }];
allGood.unboundCameras = [];
const goodItem = model.itemsOf(allGood)[1].items[1];
check('all cameras connected and none new is green', goodItem.dot === 'ok' && goodItem.chips[0].text === '1 of 1 connected' && goodItem.chips.length === 1);
const mixed = payload(); mixed.sonyDevices = [{ key: 'a', label: 'A', sonyCameraId: 'X', model: 'M', state: 'disconnected', usedByRigs: [], usedInProfiles: [] }]; mixed.unboundCameras = [];
check('a saved camera that is off is amber, not red', model.itemsOf(mixed)[1].items[1].dot === 'warn');
const downService = payload(); downService.sony.sidecar = { state: 'absent', mode: 'absent', message: 'Sony service unavailable' };
check('a Sony service that is not running shows as a problem', model.itemsOf(downService)[1].items[1].dot === 'bad' && model.itemsOf(downService)[1].items[1].chips[0].text === 'Not running');
const noSony = payload(); noSony.sony = null;
check('with no Sony service configured the item says so and is idle', model.itemsOf(noSony)[1].items[1].subtitle === 'Not configured' && model.itemsOf(noSony)[1].items[1].dot === 'idle' && model.itemsOf(noSony)[1].items[1].chips[0].text === 'Sony service off');
check('with no cameras at all the item is idle', (() => { const e = payload(); e.sonyDevices = []; e.unboundCameras = []; return model.itemsOf(e)[1].items[1].dot === 'idle' && model.itemsOf(e)[1].items[1].chips[0].text === '0 of 0 connected'; })());

// ---- inspector
const rig = model.inspectorFor(data, 'rig:vbot');
const value = (info: any, label: string): string | undefined => [...info.fields, ...info.advanced].find((f: any) => f.label === label)?.value;
check('a V-BOT rig inspector shows name, controller, IP, port, address, input and camera', value(rig, 'Name') === 'V-BOT' && value(rig, 'Controller') === 'V-BOT' && value(rig, 'Camera address (IP)') === '192.168.50.15' && value(rig, 'Port') === '52381' && value(rig, 'VISCA address') === '1' && value(rig, 'ATEM input') === '6' && value(rig, 'Sony camera') === 'a7S III — stage left');
check('the position line names the rig id and hotkey', value(rig, 'Position') === 'Rig 1 (cam1) — selected with X');
check('the speed multiplier is under Advanced', rig.advanced.some((f: any) => f.label === 'Speed multiplier' && f.value === '2'));
check('shared hardware is flagged with the profiles that use it', rig.notes.some((n: string) => /used in 2 profiles \(production, test\)/.test(n)));
const gimbal = model.inspectorFor(data, 'rig:rs3');
check('a gimbal inspector shows bridge host, port and model instead of VISCA fields', value(gimbal, 'Bridge host') === 'dji-bridge.local' && value(gimbal, 'Gimbal model') === 'RS3' && value(gimbal, 'Camera address (IP)') === undefined);
check('gimbal safety timeout and roll are under Advanced', value(gimbal, 'Safety stop timeout') === '250 ms' && value(gimbal, 'Roll') === 'Off');
check('an unwired rig explains control only', gimbal.fields.find((f: any) => f.label === 'ATEM input').value === 'None — control only' && /cannot be taken live/.test(gimbal.fields.find((f: any) => f.label === 'ATEM input').note));
const birddog = model.inspectorFor(data, 'rig:birddog1');
check('a BirdDog inspector says it has a built-in camera', value(birddog, 'Sony camera') === 'Built-in camera' && birddog.fields.find((f: any) => f.label === 'Controller').note === 'Has a built-in camera');
const atem = model.inspectorFor(data, 'atem');
check('the ATEM inspector shows the switcher and the graphics settings', value(atem, 'IP address') === '192.168.50.153' && value(atem, 'Default transition') === 'Cut' && value(atem, 'Key fade (frames)') === '15' && value(atem, 'Graphics keyer') === 'DSK');
const conn = model.inspectorFor(data, 'sony');
check('the Sony connections inspector shows the service state', conn.kind === 'sony-connections' && conn.service.text === 'Running' && conn.service.tone === 'ok' && conn.service.mode === 'external');
check('it lists every named camera with the name the operator gave it', conn.devices.map((d: any) => d.label).join('|') === 'a7S III — stage left|FX3A — stage right|Not yet bound');
check('a camera shows its model, id, state and last message', conn.devices[1].model === 'ILME-FX3A' && conn.devices[1].sonyCameraId === '78:F5:05:43:AD:50' && conn.devices[1].stateText === 'Connection error' && conn.devices[1].tone === 'bad' && conn.devices[1].message === 'Camera connection failed');
check('a camera says which rig it is on', conn.devices[0].usedBy.join() === 'V-BOT (rig 1)' && conn.devices[1].usedBy.join() === 'DJI RS3 (rig 3)' && conn.devices[2].usedBy.length === 0);
check('a camera with no bound id says it has no camera yet', conn.devices[2].stateText === 'No camera bound yet' && conn.devices[2].tone === 'idle' && conn.devices[2].sonyCameraId === null);
check('it lists cameras found that no device is bound to', conn.found.length === 1 && conn.found[0].id === 'AA:00:00:00:00:09' && conn.found[0].model === 'ILCE-7M4' && conn.found[0].stateText === 'New camera — connect to approve');
check('a camera the app has approved is marked approved; an unbound device is not', conn.devices[0].approved === true && conn.devices[1].approved === true && conn.devices[2].approved === false);
check('an unknown key has no inspector (including the retired per-camera keys)', model.inspectorFor(data, 'rig:nope') === null && model.inspectorFor(data, 'mystery') === null && model.inspectorFor(data, null) === null && model.inspectorFor(data, 'sony:sony-a') === null && model.inspectorFor(data, 'camera:AA:00:00:00:00:09') === null);

// ---- live status
const rigStatus = model.statusFor(data, 'rig:rs3');
const line = (status: any, label: string): any => status.lines.find((l: any) => l.label === label);
check('a gimbal rig status shows link, bridge and gimbal state', line(rigStatus, 'Gimbal link').value === 'Unknown' && line(rigStatus, 'Bridge (Pi)').value === 'Reachable' && line(rigStatus, 'Gimbal').value === 'Not attached' && line(rigStatus, 'Gimbal').tone === 'bad');
check('a rig status says whether video is wired to the ATEM', line(rigStatus, 'Video to ATEM').value === 'Not wired (control only)' && line(model.statusFor(data, 'rig:vbot'), 'Video to ATEM').value === 'Input 6');
check('a rig status shows its Sony camera and its state', line(rigStatus, 'Sony camera').value === 'FX3A — stage right — Connection error' && line(rigStatus, 'Sony camera').tone === 'bad');
check('a BirdDog rig status says the camera is built in', line(model.statusFor(data, 'rig:birddog1'), 'Camera').value === 'Built in');
check('a connected Sony camera on the selected rig offers a preview', model.statusFor(data, 'rig:vbot').previewCameraId === '9C:50:D1:AC:7B:72' && rigStatus.previewCameraId === null);
check('the ATEM status shows the connection', model.statusFor(data, 'atem').lines[0].value === 'Not connected' && model.statusFor(payload(config('production'), true), 'atem').lines[0].value === 'Connected');
const sonyStatus = model.statusFor(data, 'sony');
check('the Sony connections status shows the service and how many cameras are connected', line(sonyStatus, 'Sony service').value === 'Running' && line(sonyStatus, 'Cameras connected').value === '1 of 4');
check('it lists each named camera with its state', line(sonyStatus, 'FX3A — stage right').value === 'Connection error' && line(sonyStatus, 'FX3A — stage right').tone === 'bad' && line(sonyStatus, 'Not yet bound').value === 'No camera bound yet');
check('it lists each new camera as new', line(sonyStatus, 'ILCE-7M4 (new)').value === 'New camera — connect to approve');
check('a service message is shown when there is one', line(model.statusFor(downService, 'sony'), 'Service message').value === 'Sony service unavailable');

// ---- selection
check('a selection that still exists is kept', model.resolveSelection(data, 'rig:birddog1') === 'rig:birddog1');
check('a selection that vanished falls back to the first item', model.resolveSelection(data, 'rig:gone') === 'rig:vbot' && model.resolveSelection(data, null) === 'rig:vbot');
check('an empty payload falls back to the ATEM item', model.resolveSelection({ rigs: [], sonyDevices: [], unboundCameras: [], atem: {} }, 'rig:x') === 'atem');
check('a selection saved before Sony cameras became one item falls back safely', model.resolveSelection(data, 'sony:sony-a') === 'rig:vbot' && model.resolveSelection(data, 'camera:AA:00:00:00:00:09') === 'rig:vbot');
check('findItem returns the item or null', model.findItem(data, 'atem').title === 'ATEM switcher' && model.findItem(data, 'nope') === null);
check('flatItems lists every item in display order', model.flatItems(data).length === 3 + 2 && model.flatItems(data).map((i: any) => i.key).join() === 'rig:vbot,rig:birddog1,rig:rs3,atem,sony');

// ---- legacy (flat cameras: list)
const legacy = payload({ ...config(), cameras: resolveProfile(devices, profiles.production), profiles: undefined, devices: undefined });
check('a legacy config still lists its rigs, keyed by camera id', legacy.legacy === true && model.itemsOf(legacy)[0].items.map((i: any) => i.key).join() === 'rig:cam1,rig:cam2,rig:cam3');
check('a legacy rig inspector works without a device key', model.inspectorFor(legacy, 'rig:cam1').title === 'V-BOT');
check('the state text helper names Sony states', model.sonyStateText('needs_pairing') === 'Needs pairing / camera setup' && model.sonyStateText(null) === 'Not seen yet' && model.sonyStateText('weird_state') === 'weird state');

console.log(`rigs ui model: ${passed} checks passed`);
