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
// ---- editable controls
const control = (info: any, id: string): any => [...(info.controls ?? []), ...(info.advancedControls ?? [])].find((c: any) => c.id === id);
check('an editable rig inspector says where its changes go', rig.endpoint === '/api/rigs/vbot' && gimbal.endpoint === '/api/rigs/rs3');
check('the name is a required text control of at most 64 characters', control(rig, 'label').type === 'text' && control(rig, 'label').path === 'label' && control(rig, 'label').maxLength === 64 && control(rig, 'label').required === true);
check('the controller type is a choice of V-BOT, BirdDog, DJI gimbal or other VISCA-IP camera', control(rig, 'controller').type === 'select' && control(rig, 'controller').path === 'controller' && control(rig, 'controller').value === 'vbot' && control(rig, 'controller').options.map((o: any) => o.value).join() === 'vbot,birddog,gimbal,generic' && /VISCA-IP/.test(control(rig, 'controller').options[3].label));
check('switching between VISCA kinds asks nothing; switching to or from a gimbal asks first and mentions presets', control(rig, 'controller').confirm.generic === undefined && control(rig, 'controller').confirm.birddog === undefined && /choose which gimbal from the Gimbal list/.test(control(rig, 'controller').confirm.gimbal) && /Presets/.test(control(rig, 'controller').confirm.gimbal) && /VISCA at dji-bridge\.local, port 52381/.test(control(gimbal, 'controller').confirm.vbot));
check('a rig with a Sony camera says why it cannot become a BirdDog', /take the Sony camera off/.test(control(rig, 'controller').note));
const choice = (scan: any): any => control(model.inspectorFor({ ...data, gimbalScan: scan }, 'rig:rs3'), 'gimbal.bridge');
let gc = choice(null);
check('before a scan the gimbal choice holds only the current bridge and says it is looking', gc.type === 'select' && gc.rescan === true && gc.value === 'dji-bridge.local:7878' && gc.options.length === 1 && /Looking for gimbals/.test(gc.note));
const scan = { at: 1, gimbals: [
  { host: 'dji-bridge.local', port: 7878, reachable: true, model: 'RS3', gimbalConnected: true, drivenBy: 'cam3', usedBy: [{ deviceKey: 'rs3', label: 'DJI RS3', rig: 3 }] },
  { host: 'dji-bridge.local', port: 7879, reachable: true, model: 'RS3Pro', gimbalConnected: false, drivenBy: null, usedBy: [] },
  { host: 'pi-2.local', port: 7878, reachable: true, model: 'RS 4 Pro', gimbalConnected: true, drivenBy: null, usedBy: [{ deviceKey: 'vbot', label: 'V-BOT', rig: 1 }] },
  { host: 'pi-3.local', port: 7878, reachable: true, model: null, gimbalConnected: null, drivenBy: null, usedBy: [] },
] };
gc = choice(scan);
check('every gimbal found is offered, from every Pi, with its model, port, Pi and link', gc.options.length === 4 && gc.options[0].label === 'RS3 — port 7878 on dji-bridge.local — gimbal connected' && /^V-BOT \(RS 4 Pro\) — port 7878 on pi-2/.test(gc.options[2].label) && /RS3Pro — port 7879 on dji-bridge.local — no gimbal attached/.test(gc.options[1].label) && /^Gimbal — port 7878 on pi-3\.local — no gimbal reporting/.test(gc.options[3].label));
check('a gimbal another rig drives is shown but cannot be chosen', gc.options[2].disabled === true && /on V-BOT/.test(gc.options[2].label) && !gc.options[0].disabled && !gc.options[1].disabled);
check('choosing a gimbal points the rig at that Pi and port and labels it with the reported model', JSON.stringify(gc.patches['pi-3.local:7878']) === JSON.stringify({ gimbal: { host: 'pi-3.local', port: 7878 } }) && JSON.stringify(gc.patches['dji-bridge.local:7879']) === JSON.stringify({ gimbal: { host: 'dji-bridge.local', port: 7879, gimbalModel: 'RS3Pro' } }));
gc = choice({ at: 1, gimbals: [{ host: 'pi-2.local', port: 7878, reachable: true, model: 'RS 4 Pro', gimbalConnected: true, usedBy: [] }] });
check('a rig whose bridge did not answer keeps it listed as not found and asks for a choice', gc.options[0].value === 'dji-bridge.local:7878' && /not found/.test(gc.options[0].label) && /did not answer/.test(gc.note));
check('with no bridges answering the note says what to check', /No gimbal bridges answered/.test(choice({ at: 1, gimbals: [] }).note));
check('a failed scan says so', /Could not look for gimbals: boom/.test(choice({ at: 1, gimbals: [], error: 'boom' }).note));
gc = choice({ at: 1, gimbals: [{ host: 'dji-bridge.local', port: 7879, reachable: true, model: 'RS3', gimbalConnected: true, instance: 'rs3pro-a', gimbalAddress: '48:1C:B9:54:C6:BC', usedBy: [] }] });
check('a gimbal from a current bridge is named by its instance, model and Bluetooth address', /^rs3pro-a \(RS3 · BT …C6:BC\) — port 7879/.test(gc.options[1].label));
{
  const d = JSON.parse(JSON.stringify(data));
  d.rigs.find((r: any) => r.deviceKey === 'rs3').gimbal.host = '192.168.50.150';
  const aliased = control(model.inspectorFor({ ...d, gimbalScan: { at: 1, gimbals: [{ host: 'dji-bridge.local', port: 7878, aliases: ['dji-bridge.local:7878', '192.168.50.150:7878'], reachable: true, model: 'RS3', gimbalConnected: true, usedBy: [] }] } }, 'rig:rs3'), 'gimbal.bridge');
  check('a rig saved with another of the Pi\'s addresses shows as that gimbal, not as not found', aliased.value === 'dji-bridge.local:7878' && aliased.options.length === 1 && /saved as 192\.168\.50\.150/.test(aliased.note));
}
{
  const d = JSON.parse(JSON.stringify(data));
  const g = d.rigs.find((r: any) => r.deviceKey === 'rs3');
  g.live = { connected: false, bridgeReachable: true, gimbalAttached: true, gimbalResponding: false };
  const line = model.statusFor(d, 'rig:rs3').lines.find((l: any) => l.label === 'Gimbal');
  check('a linked gimbal that ignores moves says so in the status column', line.tone === 'warn' && /not moving/.test(line.value));
}
check('the old typed gimbal model is gone from the inspector', control(gimbal, 'gimbal.gimbalModel') === undefined);
check('a V-BOT has IP, port and VISCA address controls with their limits', control(rig, 'visca.host').path === 'visca.host' && control(rig, 'visca.port').min === 1 && control(rig, 'visca.port').max === 65535 && control(rig, 'visca.address').max === 7 && control(rig, 'visca.address').integer === true && control(rig, 'gimbal.host') === undefined);
check('a gimbal has bridge host, port and model controls and no VISCA controls', control(gimbal, 'gimbal.host').value === 'dji-bridge.local' && control(gimbal, 'gimbal.port').value === 7878 && control(gimbal, 'visca.host') === undefined);
check('the ATEM input control is optional, and empty means control only', control(rig, 'inputId').nullable === true && control(rig, 'inputId').value === 6 && control(gimbal, 'inputId').value === '' && /control only/.test(control(gimbal, 'inputId').note));
check('gimbal safety timeout and roll are advanced controls with limits', control(gimbal, 'gimbal.safetyTimeoutMs').min === 50 && control(gimbal, 'gimbal.safetyTimeoutMs').max === 2000 && control(gimbal, 'gimbal.rollEnabled').type === 'toggle' && gimbal.advancedControls.includes(control(gimbal, 'gimbal.rollEnabled')));
check('the speed multiplier is an advanced number from 0.1 to 5', control(rig, 'speedScale').min === 0.1 && control(rig, 'speedScale').max === 5 && rig.advancedControls.includes(control(rig, 'speedScale')));
const cameraSelect = control(rig, 'camera');
check('the camera control is a select that can be cleared', cameraSelect.type === 'select' && cameraSelect.nullable === true && cameraSelect.value === 'sony-a' && cameraSelect.options[0].value === '' && cameraSelect.options[0].label === 'None');
check('the camera choices are the named Sony cameras', cameraSelect.options.slice(1).map((o: any) => o.label).join('|').startsWith('a7S III — stage left|FX3A — stage right — on DJI RS3|Not yet bound'));
check('a camera on another rig is shown but cannot be chosen', cameraSelect.options.find((o: any) => o.value === 'sony-b').disabled === true && /on DJI RS3/.test(cameraSelect.options.find((o: any) => o.value === 'sony-b').hint));
check('the rig\'s own camera and free cameras can be chosen', !cameraSelect.options.find((o: any) => o.value === 'sony-a').disabled && !cameraSelect.options.find((o: any) => o.value === 'sony-c').disabled);
check('a camera with no bound id says so', cameraSelect.options.find((o: any) => o.value === 'sony-c').hint === 'no camera bound yet');
check('a BirdDog has no camera choice, only a built-in note', control(birddog, 'camera').type === 'readonly' && control(birddog, 'camera').value === 'Built-in camera');
check('the ATEM inspector edits through its own route', atem.endpoint === '/api/atem' && control(atem, 'ip').path === 'ip' && control(atem, 'ip').note === 'Changing it reconnects the switcher');
check('the ATEM default transition is a cut/auto select', control(atem, 'defaultTransition').type === 'select' && control(atem, 'defaultTransition').options.map((o: any) => o.value).join() === 'cut,auto' && control(atem, 'defaultTransition').value === 'cut');
check('the ATEM mix/effect and graphics controls carry their limits', control(atem, 'meIndex').max === 3 && control(atem, 'graphics.fadeFrames').max === 250 && control(atem, 'graphics.type').options.length === 3 && atem.advancedControls.includes(control(atem, 'graphics.dskIndex')));

// ---- Sony connection actions
const [camA, camB, camC] = conn.devices;
check('a connected, approved camera can be forgotten but not connected or retried', camA.canForget === true && camA.canConnect === false && camA.canRetry === false);
check('a camera with an error can be retried', camB.canRetry === true && camB.canForget === true);
const firstFail = payload(); firstFail.sony.cameras = firstFail.sony.cameras.map((c: any) => c.id === '78:F5:05:43:AD:50' ? { ...c, approved: false } : c);
check('a first connect that failed (camera not approved yet) can still be retried', model.inspectorFor(firstFail, 'sony').devices[1].canRetry === true && model.inspectorFor(firstFail, 'sony').devices[1].canForget === false);
const failedFound = payload(); failedFound.unboundCameras = [{ id: 'Q1', model: 'ILCE-7M4', state: 'error', message: 'Camera connection failed' }];
check('a found camera whose connect failed can be retried but not connected again', model.inspectorFor(failedFound, 'sony').found[0].canRetry === true && model.inspectorFor(failedFound, 'sony').found[0].canConnect === false);
check('a camera that is connecting can be neither retried nor connected', (() => { const c = payload(); c.sonyDevices[0].state = 'connecting'; const d = model.inspectorFor(c, 'sony').devices[0]; return d.canRetry === false && d.canConnect === false; })());
check('a camera on a rig cannot be deleted; an unused one can', camA.canDelete === false && camC.canDelete === true);
check('an unbound device can be bound to a found camera, a bound one cannot', camC.canBind === true && camA.canBind === false && camC.canRetry === false && camC.canForget === false);
check('a newly found camera can be connected (approved) and comes with a suggested name', conn.found[0].canConnect === true && conn.found[0].suggestedName === 'ILCE-7M4');
check('a healthy Sony service offers refresh but not retry', conn.service.canRetry === false && conn.canRefresh === true);
const downConn = model.inspectorFor(downService, 'sony');
check('a Sony service that is not running offers retry but not refresh', downConn.service.canRetry === true && downConn.canRefresh === false);
const freshDevice = payload(); freshDevice.sonyDevices = [{ key: 'n', label: 'N', sonyCameraId: 'Z', model: 'M', state: 'discovered_unapproved', usedByRigs: [], usedInProfiles: [] }]; freshDevice.unboundCameras = []; freshDevice.sony.cameras = [{ id: 'Z', model: 'M', state: 'discovered_unapproved', approved: false, message: null }];
check('a named camera that has been found but not approved offers Connect', model.inspectorFor(freshDevice, 'sony').devices[0].canConnect === true && model.inspectorFor(freshDevice, 'sony').devices[0].canForget === false);

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

// ---- status: actions and preview reasons
const vbotStatus = model.statusFor(data, 'rig:vbot');
check('every rig can reconnect its controller', vbotStatus.actions[0].id === 'reconnect-controller' && vbotStatus.actions[0].url === '/api/reconnect/camera/cam1' && vbotStatus.actions[0].method === 'POST' && vbotStatus.actions[0].label === 'Reconnect camera control');
check('a gimbal rig says it reconnects the gimbal', rigStatus.actions[0].label === 'Reconnect gimbal' && rigStatus.actions[0].url === '/api/reconnect/camera/cam3');
check('a rig whose Sony camera has an error can retry it', rigStatus.actions.some((a: any) => a.id === 'retry-sony' && a.url === '/api/sony/cameras/78%3AF5%3A05%3A43%3AAD%3A50/retry'));
check('a rig whose Sony camera is connected offers no Sony retry', !vbotStatus.actions.some((a: any) => a.id === 'retry-sony' || a.id === 'connect-sony'));
const waiting = payload(); waiting.sonyDevices[0].state = 'discovered_unapproved'; waiting.sony.cameras[0].state = 'discovered_unapproved';
check('a rig whose Sony camera is found but not approved offers Connect', model.statusFor(waiting, 'rig:vbot').actions.some((a: any) => a.id === 'connect-sony'));
check('a BirdDog rig only offers reconnecting its controller', model.statusFor(data, 'rig:birddog1').actions.length === 1);
check('the last Sony message shows as a status line', line(rigStatus, 'Last message').value === 'Camera connection failed' && line(rigStatus, 'Last message').tone === 'bad');
check('a connected Sony camera gives a preview', vbotStatus.previewCameraId === '9C:50:D1:AC:7B:72' && vbotStatus.noPreviewReason === null);
check('a BirdDog says why it has no preview', model.statusFor(data, 'rig:birddog1').noPreviewReason.includes('built-in camera'));
check('a rig with no camera says why it has no preview', /no Sony camera is assigned/.test(model.statusFor(payload(config('test')), 'rig:rs3').noPreviewReason));
check('a rig whose camera has an error says so', rigStatus.noPreviewReason === 'No preview: the Sony camera has a connection error.');
check('a rig whose camera was found but not connected says where to connect it', /found but is not connected yet \(connect it in Sony connections\)/.test(model.statusFor(waiting, 'rig:vbot').noPreviewReason));
check('a rig whose camera device has no camera bound says so', (() => { const c = payload(); c.sonyDevices[0].sonyCameraId = null; return /not bound to a physical camera/.test(model.statusFor(c, 'rig:vbot').noPreviewReason); })());
check('the ATEM can be reconnected', model.statusFor(data, 'atem').actions[0].url === '/api/reconnect/atem');
check('a healthy Sony service offers Refresh cameras', model.statusFor(data, 'sony').actions.map((a: any) => a.id).join() === 'refresh');
check('a Sony service that is not running offers Retry Sony service', model.statusFor(downService, 'sony').actions.map((a: any) => a.id).join() === 'retry-service');

// ---- adding and removing rigs
const addData = payload(); addData.availableControllers = [{ key: 'rs3-spare', label: 'DJI RS3 Spare', controller: 'gimbal' }]; addData.maxRigs = 8;
const addInfo = model.inspectorFor(addData, 'new:rig');
check('the add-rig form is an inspector with its own endpoint', addInfo.kind === 'new-rig' && addInfo.endpoint === '/api/rigs' && addInfo.title === 'Add a rig');
check('the new rig goes at the end and the form says so', addInfo.nextPosition === 4 && addInfo.notes[0].includes('position 4'));
check('the controller types are offered, BirdDog noting its built-in camera', addInfo.controllers.map((c: any) => c.value).join() === 'vbot,birddog,gimbal,generic' && /built-in camera/.test(addInfo.controllers[1].label));
check('an existing controller can be chosen, with its type', addInfo.existing.length === 1 && addInfo.existing[0].value === 'rs3-spare' && /DJI gimbal/.test(addInfo.existing[0].label));
check('VISCA and gimbal connection fields have their defaults', addInfo.connection.visca.find((c: any) => c.id === 'port').value === 52381 && addInfo.connection.visca.find((c: any) => c.id === 'address').value === 1 && addInfo.connection.gimbal.find((c: any) => c.id === 'port').value === 7878);
check('cameras already on a rig are shown but not selectable for a new rig', addInfo.cameraOptions[0].value === '' && addInfo.cameraOptions.find((o: any) => o.value === 'sony-a').disabled === true && !addInfo.cameraOptions.find((o: any) => o.value === 'sony-c').disabled);
check('a full profile cannot take another rig', model.inspectorFor({ ...addData, maxRigs: 3 }, 'new:rig').full === true && addInfo.full === false);
check('the transient New rig row appears only while it is being added', model.itemsOf(addData)[0].items.length === 3 && model.itemsOf(addData, 'new:rig')[0].items.length === 4 && model.itemsOf(addData, 'new:rig')[0].items[3].key === 'new:rig');
check('the new-rig selection survives a refresh', model.resolveSelection(addData, 'new:rig') === 'new:rig');

const built = (values: any): any => model.buildNewRigPayload(values);
check('a new V-BOT builds a VISCA request with its defaults', JSON.stringify(built({ mode: 'new', label: ' Side V-BOT ', controller: 'vbot', host: '192.168.50.40', inputId: '9' }).payload) === JSON.stringify({ label: 'Side V-BOT', controller: 'vbot', visca: { host: '192.168.50.40', port: 52381, address: 1 }, inputId: 9 }));
check('a new gimbal builds a bridge request and leaves the model out when blank', JSON.stringify(built({ mode: 'new', label: 'G', controller: 'gimbal', host: 'pi.local', port: '7881', gimbalModel: '  ' }).payload) === JSON.stringify({ label: 'G', controller: 'gimbal', gimbal: { host: 'pi.local', port: 7881 } }));
check('a gimbal model is passed on when given', built({ mode: 'new', label: 'G', controller: 'gimbal', host: 'pi', gimbalModel: 'RS3Pro' }).payload.gimbal.gimbalModel === 'RS3Pro');
check('a blank ATEM input means control only (no inputId sent)', !('inputId' in built({ mode: 'new', label: 'C', controller: 'vbot', host: 'h', inputId: '' }).payload));
check('a Sony camera is passed on for a V-BOT', built({ mode: 'new', label: 'C', controller: 'vbot', host: 'h', camera: 'sony-c' }).payload.camera === 'sony-c');
check('a Sony camera is never sent for a BirdDog', !('camera' in built({ mode: 'new', label: 'C', controller: 'birddog', host: 'h', camera: 'sony-c' }).payload));
check('an existing controller builds a short request', JSON.stringify(built({ mode: 'existing', deviceKey: 'rs3-spare', inputId: 12, camera: 'sony-c' }).payload) === JSON.stringify({ deviceKey: 'rs3-spare', inputId: 12, camera: 'sony-c' }));
const bad = (values: any, pattern: RegExp): boolean => { const r = built(values); return r.ok === false && pattern.test(r.error); };
check('a new rig needs a name', bad({ mode: 'new', label: '  ', controller: 'vbot', host: 'h' }, /Give the rig a name/));
check('a name over 64 characters is refused', bad({ mode: 'new', label: 'x'.repeat(65), controller: 'vbot', host: 'h' }, /at most 64/));
check('a new rig needs a controller type', bad({ mode: 'new', label: 'A', controller: '', host: 'h' }, /Choose a controller type/));
check('a camera rig needs its IP address and a gimbal its bridge host', bad({ mode: 'new', label: 'A', controller: 'vbot', host: ' ' }, /camera address/) && bad({ mode: 'new', label: 'A', controller: 'gimbal', host: '' }, /bridge host/));
check('a port outside 1-65535 is refused', bad({ mode: 'new', label: 'A', controller: 'vbot', host: 'h', port: 70000 }, /Port must be a whole number/));
check('a VISCA address outside 0-7 is refused', bad({ mode: 'new', label: 'A', controller: 'vbot', host: 'h', address: 9 }, /VISCA address must be/));
check('an ATEM input that is not a whole number is refused', bad({ mode: 'new', label: 'A', controller: 'vbot', host: 'h', inputId: '2.5' }, /ATEM input must be/));
check('choosing an existing controller is required in that mode', bad({ mode: 'existing' }, /Choose a controller/));

const removable = model.inspectorFor(data, 'rig:vbot').removable;
check('a rig can be removed when the profile has more than one', removable.allowed === true && removable.endpoint === '/api/rigs/vbot' && removable.position === 1);
const single = payload(); single.rigs = [single.rigs[0]];
check('the last rig cannot be removed and the screen says why', model.inspectorFor(single, 'rig:vbot').removable.allowed === false && /at least one rig/.test(model.inspectorFor(single, 'rig:vbot').removable.reason));

const lines = model.impactLines({ position: 2, id: 'cam2', label: 'BirdDog 1', deviceKey: 'birddog1', presetsLost: ['A', 'Y'], shifted: [{ deviceKey: 'rs3', label: 'DJI RS3', fromId: 'cam3', toId: 'cam2', fromHotkey: 'B', toHotkey: 'A', presetsMoved: ['X'] }], usedInOtherProfiles: ['test'] });
check('the removal confirmation names the rig and its position', lines[0] === 'Remove "BirdDog 1" (rig 2, cam2) from the active profile.');
check('it lists the presets that will be deleted', lines.some((l: string) => l === 'Its saved presets (A, Y) will be deleted.'));
check('it says which rig moves, its new id and hotkey, and that its presets go with it', lines.some((l: string) => l === '"DJI RS3" moves from cam3 to cam2 (B becomes A); its presets move with it.'));
check('it says other profiles keep the hardware and that moved rigs reconnect', lines.some((l: string) => /also used in: test/.test(l)) && lines.some((l: string) => l === 'The moved rigs reconnect briefly.'));
check('removing the last rig has a short confirmation', model.impactLines({ position: 4, id: 'cam4', label: 'DJI RS3', presetsLost: [], shifted: [], usedInOtherProfiles: [] }).length === 1);

// ---- profiles and unsaved changes
const changeData = payload();
changeData.profile = { active: 'production', modified: true, notice: null, changes: [
  { kind: 'input', label: 'V-BOT', from: 6, to: 9 }, { kind: 'camera', label: 'V-BOT', from: 'a7S III — stage left', to: null },
  { kind: 'removed', label: 'BirdDog 1', position: 2 }, { kind: 'moved', label: 'DJI RS3', from: 3, to: 2 }, { kind: 'added', label: 'V-BOT 2', position: 5 },
  { kind: 'input', label: 'DJI RS3', from: 2, to: null },
] };
const cl = model.changeLines(changeData.profile.changes);
check('an ATEM input change reads "from → to"', cl[0] === 'V-BOT: ATEM input 6 → 9.');
check('a camera change uses the cameras\' names and says none when empty', cl[1] === 'V-BOT: Sony camera a7S III — stage left → none.');
check('a removed rig says which position it had', cl[2] === 'Removed BirdDog 1 (was rig 2).');
check('a moved rig says from and to', cl[3] === 'DJI RS3 moved from rig 3 to rig 2.');
check('an added rig says its position', cl[4] === 'Added V-BOT 2 as rig 5.');
check('going control-only is explained', cl[5] === 'DJI RS3: ATEM input 2 → none (control only).');
check('no changes, no lines', model.changeLines([]).length === 0 && model.changeLines(undefined).length === 0);

const pinfo = model.profileInfo(changeData);
check('the profile bar lists the profiles by name and knows the active one', pinfo.options.map((o: any) => o.label).join() === 'Production,Test' && pinfo.active === 'production' && pinfo.activeLabel === 'Production');
check('the profile bar knows there are unsaved changes and describes them', pinfo.modified === true && pinfo.changeLines.length === 6);
check('an unmodified profile has no change lines', model.profileInfo(payload()).modified === false && model.profileInfo(payload()).changeLines.length === 0);
check('a profile can be deleted only when there is more than one', pinfo.canDelete === true && (() => { const one = payload(); one.profiles = [one.profiles[0]]; return model.profileInfo(one).canDelete === false; })());
check('a notice about the working copy is passed through', (() => { const n = payload(); n.profile = { active: 'production', modified: false, changes: [], notice: 'Unsaved rig changes could not be restored.' }; return model.profileInfo(n).notice === 'Unsaved rig changes could not be restored.'; })());
check('a legacy config has no profile choices', model.profileInfo(payload({ ...config(), cameras: resolveProfile(devices, profiles.production), profiles: undefined, devices: undefined })).options.length === 0);
check('Save as suggests the profile name with (edited)', model.saveAsSuggestion(data) === 'Production (edited)');
check('the suggestion avoids names that exist', (() => { const d = payload(); d.profiles.push({ name: 'p2', label: 'Production (edited)', active: false, rigCount: 1, rigs: [] }); return model.saveAsSuggestion(d) === 'Production (edited 2)'; })());

// ---- what a switch would change
const switchData = payload(); switchData.programInput = 7;
const toTest = model.switchImpact(switchData, 'test');
check('a switch lists each position that changes, with old and new rig', toTest.changed.map((c: any) => c.position + ':' + c.kind).join() === '2:device,3:removed');
check('the lines name the hotkey for the position', toTest.lines[0] === 'Rig 2 (A): BirdDog 1 → DJI RS3' && toTest.lines[1] === 'Rig 3 (B): DJI RS3 → (no rig)');
check('a program output on a rig that changes produces a warning', /ATEM program output is on BirdDog 1 \(input 7\)/.test(toTest.programWarning));
const programElsewhere = payload(); programElsewhere.programInput = 6;
check('no warning when the program rig keeps its position and device', model.switchImpact(programElsewhere, 'test').programWarning === null);
check('no warning when the ATEM is not connected', model.switchImpact(payload(), 'test').programWarning === null);
check('switching to the active profile changes nothing', model.switchImpact(switchData, 'production').changed.length === 0);
check('switching to an unknown profile is null', model.switchImpact(switchData, 'nope') === null);
const extraProfile = payload(); extraProfile.profiles.push({ name: 'inputs', label: 'Inputs', active: false, rigCount: 3, rigs: [{ deviceKey: 'vbot', label: 'V-BOT', inputId: 9 }, { deviceKey: 'birddog1', label: 'BirdDog 1', inputId: 7 }, { deviceKey: 'rs3', label: 'DJI RS3', inputId: null }] });
const sameDevices = model.switchImpact(extraProfile, 'inputs');
check('the same device on a different ATEM input is a change, and unchanged rigs are not', sameDevices.changed.map((c: any) => c.position + ':' + c.kind).join() === '1:input' && sameDevices.lines[0] === 'Rig 1 (X): V-BOT — ATEM input 6 → 9');
const controlOnly = payload(); controlOnly.profiles.push({ name: 'co', label: 'Control only', active: false, rigCount: 3, rigs: [{ deviceKey: 'vbot', label: 'V-BOT', inputId: 6 }, { deviceKey: 'birddog1', label: 'BirdDog 1', inputId: null }, { deviceKey: 'rs3', label: 'DJI RS3', inputId: null }] });
check('going control-only on a rig is reported with "none"', model.switchImpact(controlOnly, 'co').lines.join('|') === 'Rig 2 (A): BirdDog 1 — ATEM input 7 → none');

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
check('a legacy rig without a device key is not editable', model.inspectorFor(legacy, 'rig:cam1').endpoint === null);
check('a legacy rig inspector works without a device key', model.inspectorFor(legacy, 'rig:cam1').title === 'V-BOT');
check('a legacy rig cannot be removed', model.inspectorFor(legacy, 'rig:cam1').removable.allowed === false);
check('the state text helper names Sony states', model.sonyStateText('needs_pairing') === 'Needs pairing / camera setup' && model.sonyStateText(null) === 'Not seen yet' && model.sonyStateText('weird_state') === 'weird state');

console.log(`rigs ui model: ${passed} checks passed`);
