import assert from 'assert';
import { AppConfig, resolveProfile, InventoryDevice, Profile } from '../config/configLoader';
import { buildRigs } from '../config/rigs';
import { createInitialState } from '../app/state';

/**
 * buildRigs is a pure read of the running config, so this needs no app, no
 * hardware and no files. Run: npx ts-node src/testing/rigsTest.ts
 */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const devices: Record<string, InventoryDevice> = {
  vbot: { label: 'V-BOT', protocol: 'visca', cameraType: 'vbot', viscaIp: '192.168.50.15', viscaPort: 52381, cameraAddress: 1, speedScale: 2 },
  birddog1: { label: 'BirdDog 1', protocol: 'visca', cameraType: 'birddog', viscaIp: '192.168.50.16', viscaPort: 52381, cameraAddress: 1, speedScale: 1 },
  rs3: {
    label: 'DJI RS3', protocol: 'dji-bridge', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1,
    bridge: { host: 'dji-bridge.local', port: 7878, gimbalModel: 'RS3', safetyTimeoutMs: 250, reconnectBackoffMs: [1000], rollEnabled: false },
  },
};
const profiles: Record<string, Profile> = {
  production: { label: 'Production', slots: [{ device: 'vbot', inputId: 6 }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', inputId: 2 }] },
  test: { label: 'Test', slots: [{ device: 'vbot', inputId: 6 }, { device: 'rs3' }] },
};
const baseConfig = (activeProfile?: string): AppConfig => {
  const cameras = activeProfile ? resolveProfile(devices, profiles[activeProfile]) : [];
  return {
    atem: { ip: '192.168.50.153', defaultTransition: 'cut', meIndex: 0 },
    cameras,
    graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
    speeds: {} as AppConfig['speeds'],
    mappings: { selectCam1: 'X', selectCam2: 'A', selectCam3: 'B', selectCam4: 'Y' } as unknown as AppConfig['mappings'],
    devices, profiles, activeProfile,
  };
};

const state = createInitialState({} as never);
state.cameraConnected = { cam1: true, cam2: false, cam3: true };
state.cameraBridgeReachable = { cam3: true };
state.cameraGimbalAttached = { cam3: false };

const view = buildRigs(baseConfig('production'), state, 'v1');
check('version is passed through', view.version === 'v1');
check('the active profile is reported', view.activeProfile === 'production' && view.legacy === false);
check('one rig per slot, in slot order', view.rigs.map((rig) => rig.deviceKey).join() === 'vbot,birddog1,rs3');
check('ids follow position (cam1..cam3)', view.rigs.map((rig) => rig.id).join() === 'cam1,cam2,cam3');
check('positions are 1-based', view.rigs.map((rig) => rig.position).join() === '1,2,3');
check('controller kinds are classified', view.rigs.map((rig) => rig.controller).join() === 'vbot,birddog,gimbal');
check('the rig name is the device label', view.rigs[0].label === 'V-BOT' && view.rigs[2].label === 'DJI RS3');
check('hotkeys come from mappings.yaml selectCamN', view.rigs.map((rig) => rig.hotkey).join() === 'X,A,B');
check('VISCA rigs carry connection details and no gimbal block', view.rigs[0].visca?.host === '192.168.50.15' && view.rigs[0].visca?.port === 52381 && view.rigs[0].gimbal === null);
check('gimbal rigs carry bridge details and no VISCA block', view.rigs[2].gimbal?.host === 'dji-bridge.local' && view.rigs[2].gimbal?.gimbalModel === 'RS3' && view.rigs[2].visca === null);
check('gimbal safety timeout and roll are exposed', view.rigs[2].gimbal?.safetyTimeoutMs === 250 && view.rigs[2].gimbal?.rollEnabled === false);
check('speed multiplier is exposed', view.rigs[0].speedScale === 2);
check('a wired rig reports its ATEM input', view.rigs[0].inputId === 6 && view.rigs[0].wired === true);
check('only BirdDog rigs have a built-in camera', view.rigs.map((rig) => rig.builtInCamera).join() === 'false,true,false');
check('no Sony camera is assigned yet (inventory devices come in a later issue)', view.rigs.every((rig) => rig.camera === null));
check('usedInProfiles lists every profile that includes the device', view.rigs[0].usedInProfiles.join() === 'production,test' && view.rigs[1].usedInProfiles.join() === 'production');
check('live connection state is reported per rig', view.rigs[0].live.connected === true && view.rigs[1].live.connected === false);
check('bridge and gimbal state appear only for gimbal rigs', view.rigs[2].live.bridgeReachable === true && view.rigs[2].live.gimbalAttached === false && !('bridgeReachable' in view.rigs[0].live));
check('the profile list marks the active one', view.profiles.find((p) => p.active)?.name === 'production' && view.profiles.length === 2);
check('profile rig counts are reported', view.profiles.find((p) => p.name === 'test')?.rigCount === 2);
check('the ATEM and graphics settings are included', view.atem.ip === '192.168.50.153' && view.graphics.fadeFrames === 15);

const unwired = buildRigs(baseConfig('test'), state, 'v2');
check('a rig with no inputId is control-only', unwired.rigs[1].inputId === null && unwired.rigs[1].wired === false);
const freshState = createInitialState({} as never);
const untracked = buildRigs(baseConfig('test'), freshState, 'v5');
check('a connection state the app has not reported yet is null, not false', untracked.rigs.every((rig) => rig.live.connected === null));
check('no bridge or gimbal keys appear before the app tracks them', untracked.rigs.every((rig) => !('bridgeReachable' in rig.live) && !('gimbalAttached' in rig.live)));

const noKeys = baseConfig('production');
(noKeys.mappings as unknown as Record<string, unknown>).selectCam2 = undefined;
check('an unmapped hotkey is null', buildRigs(noKeys, state, 'v3').rigs[1].hotkey === null);

const legacy = buildRigs({ ...baseConfig(), cameras: resolveProfile(devices, profiles.production), profiles: undefined, devices: undefined }, state, 'v4');
check('a flat cameras: config is flagged legacy', legacy.legacy === true && legacy.activeProfile === null);
check('legacy rigs have no device key and still list', legacy.rigs.length === 3 && legacy.rigs.every((rig) => rig.deviceKey === null));
check('legacy rigs have no profile membership', legacy.rigs.every((rig) => rig.usedInProfiles.length === 0) && legacy.profiles.length === 0);

const payload = JSON.stringify(view);
// ---- Sony devices in the view
const withSony: AppConfig = baseConfig('production');
withSony.devices = {
  ...devices,
  'sony-a': { label: 'a7S III — stage left', protocol: 'sony', sonyCameraId: '9c:50:d1:ac:7b:72' } as InventoryDevice,
  'sony-b': { label: 'FX3A — stage right', protocol: 'sony', sonyCameraId: '78:F5:05:43:AD:50' } as InventoryDevice,
  'sony-c': { label: 'Not yet bound', protocol: 'sony' } as InventoryDevice,
};
withSony.profiles = {
  production: { label: 'Production', slots: [{ device: 'vbot', inputId: 6, camera: 'sony-a' }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', inputId: 2, camera: 'sony-b' }] },
  test: { label: 'Test', slots: [{ device: 'vbot', inputId: 6, camera: 'sony-a' }, { device: 'rs3' }] },
};
withSony.cameras = resolveProfile(withSony.devices as Record<string, InventoryDevice>, withSony.profiles.production);
const seen = [
  { id: '9C:50:D1:AC:7B:72', model: 'ILCE-7SM3', state: 'connected' },
  { id: '78:F5:05:43:AD:50', model: 'ILME-FX3A', state: 'error' },
  { id: 'AA:00:00:00:00:09', model: 'ILCE-7M4', state: 'discovered_unapproved' },
];
const sonyView = buildRigs(withSony, state, 'v6', seen);
check('a rig reports its Sony camera key and the camera\'s name', sonyView.rigs[0].camera === 'sony-a' && sonyView.rigs[0].cameraLabel === 'a7S III — stage left');
check('a rig with no camera reports none', sonyView.rigs[1].camera === null && sonyView.rigs[1].cameraLabel === null);
check('Sony devices are not listed as rigs or controllers', sonyView.rigs.length === 3 && sonyView.rigs.every((rig) => rig.deviceKey !== null && !rig.deviceKey!.startsWith('sony-')));
check('all Sony devices are listed with their names', sonyView.sonyDevices.map((d) => d.label).join('|') === 'a7S III — stage left|FX3A — stage right|Not yet bound');
check('a Sony device picks up the camera state by id, ignoring case', sonyView.sonyDevices[0].state === 'connected' && sonyView.sonyDevices[0].model === 'ILCE-7SM3');
check('a Sony device shows the rigs that use it', sonyView.sonyDevices[0].usedByRigs.map((r) => r.id).join() === 'cam1' && sonyView.sonyDevices[1].usedByRigs.map((r) => r.id).join() === 'cam3');
check('a Sony device lists every profile that uses it', sonyView.sonyDevices[0].usedInProfiles.join() === 'production,test' && sonyView.sonyDevices[1].usedInProfiles.join() === 'production');
check('an unused, unbound Sony device is listed with no camera id', sonyView.sonyDevices[2].sonyCameraId === null && sonyView.sonyDevices[2].state === null && sonyView.sonyDevices[2].usedByRigs.length === 0);
check('only discovered cameras no device is bound to appear as unbound', sonyView.unboundCameras.map((c) => c.id).join() === 'AA:00:00:00:00:09');
check('with no Sony service the lists are empty but devices still show', buildRigs(withSony, state, 'v7').unboundCameras.length === 0 && buildRigs(withSony, state, 'v7').sonyDevices.length === 3);

check('the payload carries no secrets or credentials', !/password|token|secret|fingerprint/i.test(payload));
check('the payload is JSON round-trippable', JSON.stringify(JSON.parse(payload)) === payload);

console.log(`rigs: ${passed} checks passed`);
