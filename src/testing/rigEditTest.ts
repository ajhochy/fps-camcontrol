import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as YAML from 'yaml';
import { readDevicesFile, writeDevicesFile, ConfigConflictError, devicesFileVersion } from '../config/configLoader';
import { applyRigPatch, applyAtemPatch, applySaveProfile, applySaveProfileAs, renameProfile, deleteProfile, createRig, removeRig, rigPositionOf, createSonyDevice, patchSonyDevice, deleteSonyDevice, RigEditError } from '../config/rigEdit';
import { shiftPresetsAfterRemoval, presetSlotsSet } from '../model/presetShift';

/**
 * Rig and Sony-device edits (plan issues #4/#5), through the real comment-preserving
 * writer. Run: npx ts-node src/testing/rigEditTest.ts
 */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const refused = (name: string, action: () => unknown, pattern: RegExp, status?: number): void => {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  check(name, error instanceof RigEditError && pattern.test(error.message) && (status === undefined || error.status === status));
};

const fixture = [
  '# Sandbox-style config. Every comment here must survive every edit.',
  'atem:', '  ip: 192.168.50.153', '  defaultTransition: cut', '  meIndex: 0',
  'devices:',
  '  vbot: { label: "V-BOT", protocol: visca, cameraType: vbot, viscaIp: 192.168.50.15, viscaPort: 52381, cameraAddress: 1, speedScale: 2 }',
  '  birddog1: { label: "BirdDog 1", protocol: visca, cameraType: birddog, viscaIp: 192.168.50.16 }',
  '  # The gimbals share one Pi, one bridge instance each.',
  '  rs3:',
  '    label: "DJI RS3"',
  '    protocol: dji-bridge',
  '    bridge: { host: dji-bridge.local, port: 7878, gimbalModel: RS3, safetyTimeoutMs: 250, rollEnabled: false }',
  '  rs3pro: { label: "DJI RS3 Pro", protocol: dji-bridge, bridge: { host: dji-bridge.local, port: 7879 } }',
  '  # Sony cameras.',
  '  fx3: { label: "FX3A", protocol: sony, sonyCameraId: "78:F5:05:43:AD:50" }',
  '  a7s3: { label: "a7S III", protocol: sony, sonyCameraId: "9C:50:D1:AC:7B:72" }',
  'activeProfile: production',
  'profiles:',
  '  production:',
  '    slots:',
  '      - { device: vbot, inputId: 6, camera: a7s3 } # slot 1 = X',
  '      - { device: birddog1, inputId: 7 } # slot 2 = A',
  '      - { device: rs3, inputId: 2, camera: fx3 } # slot 3 = B',
  '  test:',
  '    slots:',
  '      - { device: vbot, inputId: 6 }',
  '      - { device: rs3pro }',
  '',
].join('\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-rig-edit-'));
const file = path.join(dir, 'devices.yaml');
const previous = process.env.DEVICES_CONFIG;
process.env.DEVICES_CONFIG = file;
const reset = (): void => fs.writeFileSync(file, fixture);
const comments = (text: string): number => text.split('\n').filter((line) => line.includes('#')).length;
const current = (): any => readDevicesFile();
const onDisk = (): any => YAML.parse(fs.readFileSync(file, 'utf8'));
reset();

// ---- rig: hardware record
let raw = applyRigPatch(current(), 'vbot', { label: '  V-BOT main  ' });
check('a rig can be renamed and the name is trimmed', raw.devices.vbot.label === 'V-BOT main');
check('renaming leaves every other device alone', JSON.stringify(raw.devices.rs3) === JSON.stringify(current().devices.rs3));
refused('an empty name is refused', () => applyRigPatch(current(), 'vbot', { label: '   ' }), /name must be 1 to 64/);
refused('a name over 64 characters is refused', () => applyRigPatch(current(), 'vbot', { label: 'x'.repeat(65) }), /name must be 1 to 64/);
raw = applyRigPatch(current(), 'vbot', { visca: { host: '10.0.0.9', port: 52400, address: 2 } });
check('VISCA host, port and address map onto the device', raw.devices.vbot.viscaIp === '10.0.0.9' && raw.devices.vbot.viscaPort === 52400 && raw.devices.vbot.cameraAddress === 2);
refused('a VISCA address outside 0-7 is refused', () => applyRigPatch(current(), 'vbot', { visca: { address: 9 } }), /VISCA address must be/);
refused('a port outside 1-65535 is refused', () => applyRigPatch(current(), 'vbot', { visca: { port: 70000 } }), /port must be/);
refused('VISCA settings on a gimbal are refused', () => applyRigPatch(current(), 'rs3', { visca: { host: '1.2.3.4' } }), /not a VISCA camera/);
refused('bridge settings on a VISCA camera are refused', () => applyRigPatch(current(), 'vbot', { gimbal: { host: 'x' } }), /not a gimbal/);
raw = applyRigPatch(current(), 'rs3', { gimbal: { host: 'pi.local' } });
check('a gimbal edit changes only what was sent', raw.devices.rs3.bridge.host === 'pi.local' && raw.devices.rs3.bridge.port === 7878);
check('bridge fields that were not sent survive (model, safety timeout)', raw.devices.rs3.bridge.gimbalModel === 'RS3' && raw.devices.rs3.bridge.safetyTimeoutMs === 250);
check('gimbal model can be cleared with null', applyRigPatch(current(), 'rs3', { gimbal: { gimbalModel: null } }).devices.rs3.bridge.gimbalModel === undefined);
check('roll and safety timeout can be set', (() => { const r = applyRigPatch(current(), 'rs3', { gimbal: { rollEnabled: true, safetyTimeoutMs: 400 } }); return r.devices.rs3.bridge.rollEnabled === true && r.devices.rs3.bridge.safetyTimeoutMs === 400; })());
refused('a safety timeout below 50 ms is refused', () => applyRigPatch(current(), 'rs3', { gimbal: { safetyTimeoutMs: 10 } }), /safety stop timeout/);
refused('a safety timeout above 2000 ms is refused', () => applyRigPatch(current(), 'rs3', { gimbal: { safetyTimeoutMs: 5000 } }), /safety stop timeout/);
refused('a bad reconnect back-off is refused', () => applyRigPatch(current(), 'rs3', { gimbal: { reconnectBackoffMs: [5] } }), /reconnect back-off/);
check('the speed multiplier can be set', applyRigPatch(current(), 'vbot', { speedScale: 3 }).devices.vbot.speedScale === 3);
refused('a speed multiplier outside 0.1-5 is refused', () => applyRigPatch(current(), 'vbot', { speedScale: 9 }), /speed multiplier/);
refused('the protocol cannot be changed from here (issue #18)', () => applyRigPatch(current(), 'rs3', { protocol: 'visca' }), /"protocol" cannot be changed here/);
refused('the controller type cannot be changed from here', () => applyRigPatch(current(), 'vbot', { cameraType: 'birddog' }), /"cameraType" cannot be changed here/);
// ---- rig: changing the controller type (follow-up F3)
raw = applyRigPatch(current(), 'vbot', { controller: 'generic' });
check('a V-BOT can become another VISCA-IP camera: only the camera type changes', raw.devices.vbot.cameraType === 'generic' && raw.devices.vbot.protocol === 'visca' && raw.devices.vbot.viscaIp === '192.168.50.15' && raw.devices.vbot.viscaPort === 52381 && raw.devices.vbot.speedScale === 2);
raw = applyRigPatch(current(), 'vbot', { controller: 'gimbal' });
check('a VISCA camera becomes a gimbal on the Pi the other gimbals use, on a bridge port no active rig drives', raw.devices.vbot.protocol === 'dji-bridge' && raw.devices.vbot.bridge.host === 'dji-bridge.local' && raw.devices.vbot.bridge.port === 7879);
check('becoming a gimbal drops the VISCA-only fields and keeps the name and speed', ['viscaIp', 'viscaPort', 'cameraAddress', 'cameraType'].every((k) => !(k in raw.devices.vbot)) && raw.devices.vbot.label === 'V-BOT' && raw.devices.vbot.speedScale === 2);
check('the gimbal keeps its Sony camera', raw.profiles.production.slots[0].camera === 'a7s3');
raw = applyRigPatch(current(), 'rs3pro', { controller: 'vbot' });
check('a gimbal can become a V-BOT on the bridge host, VISCA port 52381 address 1', raw.devices.rs3pro.protocol === 'visca' && raw.devices.rs3pro.cameraType === 'vbot' && raw.devices.rs3pro.viscaIp === 'dji-bridge.local' && raw.devices.rs3pro.viscaPort === 52381 && raw.devices.rs3pro.cameraAddress === 1 && !('bridge' in raw.devices.rs3pro));
raw = applyRigPatch(current(), 'rs3', { controller: 'gimbal' });
check('choosing the type it already is changes nothing', JSON.stringify(raw.devices.rs3) === JSON.stringify(current().devices.rs3));
raw = applyRigPatch(current(), 'rs3pro', { controller: 'generic', visca: { port: 52400 } });
check('connection settings sent with the change apply to the new kind', raw.devices.rs3pro.viscaPort === 52400 && raw.devices.rs3pro.viscaIp === 'dji-bridge.local');
refused('becoming a BirdDog is refused while a Sony camera is on the rig, naming the profile', () => applyRigPatch(current(), 'vbot', { controller: 'birddog' }), /built-in camera.*take the Sony camera off.*"production"/);
check('a rig with no Sony camera can become a BirdDog', applyRigPatch(current(), 'rs3pro', { controller: 'birddog' }).devices.rs3pro.cameraType === 'birddog');
refused('an unknown controller type is refused', () => applyRigPatch(current(), 'vbot', { controller: 'ptzoptics' }), /controller must be/);
refused('a Sony camera cannot be turned into a controller', () => applyRigPatch(current(), 'fx3', { controller: 'vbot' }), /Sony cameras are edited/);
reset();
writeDevicesFile(applyRigPatch(current(), 'rs3pro', { controller: 'vbot' }));
check('a controller change survives the comment-preserving writer and reloads', onDisk().devices.rs3pro.cameraType === 'vbot' && onDisk().devices.rs3pro.viscaIp === 'dji-bridge.local' && onDisk().devices.rs3pro.bridge === undefined && comments(fs.readFileSync(file, 'utf8')) === comments(fixture));
reset();
refused('two rigs of the active profile cannot drive the same gimbal bridge', () => applyRigPatch(applyRigPatch(current(), 'vbot', { controller: 'gimbal' }), 'vbot', { gimbal: { port: 7878 } }), /already driven by "DJI RS3"/);
check('a bridge used only by a rig of another profile can be chosen', applyRigPatch(applyRigPatch(current(), 'vbot', { controller: 'gimbal' }), 'vbot', { gimbal: { host: 'dji-bridge.local', port: 7879 } }).devices.vbot.bridge.port === 7879);
refused('an unknown field is refused rather than ignored', () => applyRigPatch(current(), 'vbot', { colour: 'red' }), /"colour" cannot be changed here/);
refused('an empty VISCA address (IP) is refused', () => applyRigPatch(current(), 'vbot', { visca: { host: '' } }), /camera address \(IP\) must be/);

// ---- rig: wiring in the active profile
raw = applyRigPatch(current(), 'birddog1', { inputId: 9 });
check('a rig ATEM input can be changed', raw.profiles.production.slots[1].inputId === 9);
check('changing the active profile rig leaves the other profile alone', JSON.stringify(raw.profiles.test) === JSON.stringify(current().profiles.test));
check('a null input makes the rig control-only (the key is removed)', !('inputId' in applyRigPatch(current(), 'birddog1', { inputId: null }).profiles.production.slots[1]));
refused('an ATEM input another rig already uses is refused', () => applyRigPatch(current(), 'birddog1', { inputId: 6 }), /already used by rig 1/);
refused('a non-whole ATEM input is refused', () => applyRigPatch(current(), 'birddog1', { inputId: 2.5 }), /ATEM input must be/);
check('a Sony camera can be put on a V-BOT rig (after the gimbal rig gives it up)', applyRigPatch(applyRigPatch(current(), 'rs3', { camera: null }), 'vbot', { camera: 'fx3' }).profiles.production.slots[0].camera === 'fx3');
raw = applyRigPatch(applyRigPatch(current(), 'vbot', { camera: null }), 'rs3', { camera: 'a7s3' });
check('a camera can be cleared from one rig and given to another', raw.profiles.production.slots[0].camera === undefined && raw.profiles.production.slots[2].camera === 'a7s3');
refused('the same Sony camera on two rigs in one profile is refused', () => applyRigPatch(current(), 'rs3', { camera: 'a7s3' }), /is on both rig 1 and rig 3/);
refused('a BirdDog rig takes no Sony camera', () => applyRigPatch(current(), 'birddog1', { camera: 'fx3' }), /built-in camera/);
refused('a camera that is not in the inventory is refused', () => applyRigPatch(current(), 'rs3', { camera: 'nope' }), /not in the device inventory/);
refused('a camera that is not a Sony device is refused', () => applyRigPatch(current(), 'rs3', { camera: 'rs3pro' }), /not a Sony camera device/);
refused('a device that is not in the active profile has no wiring to edit', () => applyRigPatch(current(), 'rs3pro', { inputId: 3 }), /not a rig in the active profile/);
check('a device that is not in the active profile can still have its hardware edited', applyRigPatch(current(), 'rs3pro', { label: 'Pro B' }).devices.rs3pro.label === 'Pro B');
refused('an unknown device is a 404', () => applyRigPatch(current(), 'nope', { label: 'x' }), /unknown device/, 404);
refused('a Sony camera is not edited as a rig', () => applyRigPatch(current(), 'fx3', { label: 'x' }), /Sony camera routes/);
const twice = current(); twice.profiles.production.slots.push({ device: 'vbot', inputId: 10 });
refused('a device filling two rigs needs a position for wiring edits', () => applyRigPatch(twice, 'vbot', { inputId: 11 }), /fills more than one rig/);
check('with a position the right rig is edited', applyRigPatch(twice, 'vbot', { inputId: 11, position: 4 }).profiles.production.slots[3].inputId === 11);
check('the input passed in is never mutated', current().devices.vbot.label === 'V-BOT');

// ---- through the real writer: comments, protocol and versions
reset();
const before = fs.readFileSync(file, 'utf8');
writeDevicesFile(applyRigPatch(current(), 'rs3', { label: 'DJI RS3 (stage)', gimbal: { host: 'pi.local' } }));
const after = fs.readFileSync(file, 'utf8');
check('a rig edit through the writer keeps every comment', comments(after) === comments(before));
check('a rig edit through the writer keeps the gimbal a gimbal', onDisk().devices.rs3.protocol === 'dji-bridge' && onDisk().devices.rs3.bridge.host === 'pi.local');
check('a rig edit through the writer keeps the trailing slot comments', after.includes('# slot 1 = X') && after.includes('# slot 3 = B'));
check('a rig edit through the writer writes the new name', onDisk().devices.rs3.label === 'DJI RS3 (stage)');
check('a rig edit adds no stray cameras: list', onDisk().cameras === undefined);
reset();
const stale = devicesFileVersion();
fs.writeFileSync(file, fixture.replace('192.168.50.153', '192.168.50.99'));
let conflict = false;
try { writeDevicesFile(applyRigPatch(current(), 'vbot', { label: 'late' }), stale); } catch (error) { conflict = error instanceof ConfigConflictError; }
check('an edit based on a stale file version is refused', conflict && onDisk().devices.vbot.label === 'V-BOT');
reset();

// ---- Sony devices
let created = createSonyDevice(current(), { label: 'FX3 — stage left', sonyCameraId: '78:f5:05:43:b5:aa' });
check('a Sony device can be created with a name and camera id', created.key === 'sony-fx3-stage-left' && created.raw.devices[created.key].protocol === 'sony');
check('the camera id is stored in upper case', created.raw.devices[created.key].sonyCameraId === '78:F5:05:43:B5:AA');
check('a Sony device can be created before its camera is known', createSonyDevice(current(), { label: 'Spare' }).raw.devices['sony-spare'].sonyCameraId === undefined);
const dup = createSonyDevice(created.raw, { label: 'FX3 — stage left' });
check('creating a second device with the same name gets its own key', dup.key === 'sony-fx3-stage-left-2');
refused('a device cannot claim a camera id another device already has', () => createSonyDevice(current(), { label: 'Again', sonyCameraId: '78:F5:05:43:AD:50' }), /both use camera id/);
refused('a bad camera id is refused', () => createSonyDevice(current(), { label: 'Bad', sonyCameraId: 'not an id!' }), /camera id must look like/);
refused('a Sony device needs a name', () => createSonyDevice(current(), { sonyCameraId: '9C:50:D1:AC:7B:99' }), /a name is required/);
refused('a blank Sony device name is refused', () => createSonyDevice(current(), { label: '  ' }), /name must be 1 to 64/);
refused('a Sony device create refuses unknown fields', () => createSonyDevice(current(), { label: 'x', protocol: 'visca' }), /"protocol" cannot be changed here/);
raw = patchSonyDevice(current(), 'fx3', { label: 'FX3A — stage right' });
check('a Sony device can be renamed', raw.devices.fx3.label === 'FX3A — stage right' && raw.devices.fx3.sonyCameraId === '78:F5:05:43:AD:50');
check('a Sony device can be bound to a camera', patchSonyDevice(createSonyDevice(current(), { label: 'Spare' }).raw, 'sony-spare', { sonyCameraId: '9c:50:d1:ac:7b:99' }).devices['sony-spare'].sonyCameraId === '9C:50:D1:AC:7B:99');
check('a Sony device can be unbound with null', patchSonyDevice(current(), 'fx3', { sonyCameraId: null }).devices.fx3.sonyCameraId === undefined);
refused('binding a camera another device has is refused', () => patchSonyDevice(current(), 'fx3', { sonyCameraId: '9c:50:d1:ac:7b:72' }), /both use camera id/);
refused('a rig controller is not a Sony device', () => patchSonyDevice(current(), 'vbot', { label: 'x' }), /unknown Sony camera/, 404);
refused('an unknown Sony device is a 404', () => patchSonyDevice(current(), 'ghost', { label: 'x' }), /unknown Sony camera/, 404);
refused('a Sony device in use cannot be deleted (409, says where)', () => deleteSonyDevice(current(), 'fx3'), /still used by production rig 3/, 409);
refused('a Sony device used only by another profile cannot be deleted either', () => { const r = current(); r.profiles.test.slots[0].camera = 'a7s3'; r.profiles.production.slots[0].camera = undefined; delete r.profiles.production.slots[0].camera; return deleteSonyDevice(r, 'a7s3'); }, /still used by test rig 1/, 409);
const unused = createSonyDevice(current(), { label: 'Spare' });
check('an unused Sony device can be deleted', deleteSonyDevice(unused.raw, unused.key).devices[unused.key] === undefined);
check('deleting a Sony device leaves the others', Object.keys(deleteSonyDevice(unused.raw, unused.key).devices).length === Object.keys(current().devices).length);
writeDevicesFile(createSonyDevice(current(), { label: 'New one', sonyCameraId: '9C:50:D1:AC:7B:98' }).raw);
check('creating a Sony device through the writer keeps every comment', comments(fs.readFileSync(file, 'utf8')) === comments(fixture));
check('the created Sony device is on disk', onDisk().devices['sony-new-one'].protocol === 'sony');

// ---- add rigs
reset();
let made = createRig(current(), { label: 'Side gimbal', controller: 'gimbal', gimbal: { host: 'pi.local', port: 7881 }, inputId: 12 });
check('a new gimbal rig is appended at the end of the active profile', made.position === 4 && made.raw.profiles.production.slots[3].device === made.key);
check('a new gimbal is a dji-bridge device with the host and port it was given', made.raw.devices[made.key].protocol === 'dji-bridge' && made.raw.devices[made.key].bridge.host === 'pi.local' && made.raw.devices[made.key].bridge.port === 7881);
check('the new rig key is made from its name', made.key === 'side-gimbal');
check('existing rigs do not move when one is added', made.raw.profiles.production.slots.slice(0, 3).map((slot: any) => slot.device).join() === 'vbot,birddog1,rs3');
check('the new rig keeps the requested ATEM input', made.raw.profiles.production.slots[3].inputId === 12);
check('adding a rig does not touch the other profile', JSON.stringify(made.raw.profiles.test) === JSON.stringify(current().profiles.test));
made = createRig(current(), { label: 'V-BOT 2', controller: 'vbot', visca: { host: '192.168.50.40' }, speedScale: 2 });
check('a new V-BOT is a VISCA device with its controller type, default port and address', made.raw.devices[made.key].protocol === 'visca' && made.raw.devices[made.key].cameraType === 'vbot' && made.raw.devices[made.key].viscaPort === 52381 && made.raw.devices[made.key].cameraAddress === 1);
check('a rig with no ATEM input is control-only', !('inputId' in made.raw.profiles.production.slots[3]));
check('two rigs with the same name get different keys', createRig(made.raw, { label: 'V-BOT 2', controller: 'vbot', visca: { host: '192.168.50.41' } }).key === 'v-bot-2-2');
const withCamera = applyRigPatch(applyRigPatch(current(), 'rs3', { camera: null }), 'vbot', { camera: null });
check('a new V-BOT rig can take a free Sony camera', createRig(withCamera, { label: 'Cam rig', controller: 'vbot', visca: { host: '10.0.0.5' }, camera: 'fx3' }).raw.profiles.production.slots[3].camera === 'fx3');
refused('a new rig cannot take a Sony camera another rig already has', () => createRig(current(), { label: 'Dup', controller: 'vbot', visca: { host: '10.0.0.5' }, camera: 'a7s3' }), /is on both rig 1 and rig 4/);
refused('a new BirdDog rig takes no Sony camera', () => createRig(current(), { label: 'BD', controller: 'birddog', visca: { host: '10.0.0.5' }, camera: 'fx3' }), /built-in camera/);
refused('a new rig cannot use an ATEM input another rig has', () => createRig(current(), { label: 'Clash', controller: 'vbot', visca: { host: '10.0.0.5' }, inputId: 6 }), /already used by rig 1/);
refused('a new camera rig needs an IP address', () => createRig(current(), { label: 'NoIP', controller: 'vbot' }), /needs its IP address/);
refused('a new gimbal rig needs a bridge host', () => createRig(current(), { label: 'NoHost', controller: 'gimbal' }), /needs its bridge host/);
refused('a new rig needs a known controller type', () => createRig(current(), { label: 'X', controller: 'ptz9000', visca: { host: '1.2.3.4' } }), /controller must be/);
refused('a new rig needs a name', () => createRig(current(), { controller: 'vbot', visca: { host: '1.2.3.4' } }), /name must be text/);
refused('a gimbal rig refuses VISCA settings', () => createRig(current(), { label: 'G', controller: 'gimbal', gimbal: { host: 'x' }, visca: { host: 'y' } }), /no VISCA settings/);
refused('a camera rig refuses bridge settings', () => createRig(current(), { label: 'C', controller: 'vbot', visca: { host: 'y' }, gimbal: { host: 'x' } }), /only a gimbal has bridge settings/);
const crowded = current(); for (let i = 0; i < 5; i++) crowded.profiles.production.slots.push({ device: 'vbot', inputId: 30 + i });
refused('a profile cannot have more than 8 rigs', () => createRig(crowded, { label: 'Ninth', controller: 'vbot', visca: { host: '1.2.3.4' } }), /8/);
made = createRig(current(), { deviceKey: 'rs3pro', inputId: 13 });
check('an existing controller from the inventory can be put on a new rig', made.key === 'rs3pro' && made.position === 4 && made.raw.profiles.production.slots[3].inputId === 13);
check('adding an existing device creates no new hardware entry', Object.keys(made.raw.devices).length === Object.keys(current().devices).length);
refused('an existing controller already in the profile cannot be added twice', () => createRig(current(), { deviceKey: 'vbot' }), /already a rig in the active profile/);
refused('a Sony camera cannot be added as a rig', () => createRig(current(), { deviceKey: 'fx3' }), /not a controller/);
refused('an unknown device cannot be added', () => createRig(current(), { deviceKey: 'ghost' }), /unknown device/, 404);
refused('an existing device is added as it is (no hardware fields)', () => createRig(current(), { deviceKey: 'rs3pro', label: 'new name' }), /added as it is/);
reset();
writeDevicesFile(createRig(current(), { label: 'Side gimbal', controller: 'gimbal', gimbal: { host: 'pi.local' } }).raw);
check('adding a rig through the writer keeps every comment', comments(fs.readFileSync(file, 'utf8')) === comments(fixture));
check('adding a rig through the writer appends the slot and the gimbal stays a gimbal', onDisk().profiles.production.slots.length === 4 && onDisk().devices['side-gimbal'].protocol === 'dji-bridge');
reset();

// ---- remove rigs
check('rigPositionOf finds a rig', rigPositionOf(current(), 'birddog1') === 2);
refused('rigPositionOf refuses a device that is not a rig in the active profile', () => rigPositionOf(current(), 'rs3pro'), /not a rig in the active profile/, 404);
let removed = removeRig(current(), 'birddog1');
check('removing a rig takes its slot out and later rigs move up', removed.position === 2 && removed.raw.profiles.production.slots.map((slot: any) => slot.device).join() === 'vbot,rs3');
check('removing a rig keeps the hardware entry by default', removed.deviceRemoved === false && removed.raw.devices.birddog1 !== undefined);
check('removing a rig leaves the other profile alone', JSON.stringify(removed.raw.profiles.test) === JSON.stringify(current().profiles.test));
removed = removeRig(current(), 'rs3');
check('removing the last rig changes no other rig', removed.position === 3 && removed.raw.profiles.production.slots.map((slot: any) => slot.device).join() === 'vbot,birddog1');
check('removing a rig that has a Sony camera leaves the camera in the inventory', removed.raw.devices.fx3?.protocol === 'sony');
removed = removeRig(current(), 'birddog1', { deleteDevice: true });
check('the hardware entry can be deleted with the rig when nothing else uses it', removed.deviceRemoved === true && removed.raw.devices.birddog1 === undefined);
refused('the hardware entry is kept (409) while another profile uses it', () => removeRig(current(), 'vbot', { deleteDevice: true }), /still used by test rig 1/, 409);
const single = current(); single.profiles.production.slots = [single.profiles.production.slots[0]];
refused('the last remaining rig cannot be removed', () => removeRig(single, 'vbot'), /at least one rig/);
refused('a device filling two rigs needs a position to remove', () => removeRig(twice, 'vbot'), /fills more than one rig/);
check('with a position the right rig is removed', removeRig(twice, 'vbot', { position: 4 }).raw.profiles.production.slots.length === 3);
check('the input passed to removeRig is never mutated', current().profiles.production.slots.length === 3);
reset();
writeDevicesFile(removeRig(current(), 'birddog1').raw);
const afterRemove = fs.readFileSync(file, 'utf8');
check('removing a rig through the writer keeps the documentation that is not about that rig', afterRemove.includes('# Sandbox-style config') && afterRemove.includes('# The gimbals share one Pi') && afterRemove.includes('# Sony cameras.'));
check('position comments stay with their position after a removal (slot 1 = X, slot 2 = A); only the now-missing last slot loses its comment', comments(afterRemove) === comments(fixture) - 1 && afterRemove.includes('# slot 1 = X') && afterRemove.includes('# slot 2 = A') && !afterRemove.includes('# slot 3 = B'));
check('removing a rig through the writer keeps the gimbal a gimbal', onDisk().devices.rs3.protocol === 'dji-bridge');
reset();

// ---- presets follow their rig
const presets: Record<string, Record<string, unknown>> = {
  cam1: { A: null, X: null }, cam2: { A: { pan: 1 }, X: null }, cam3: { A: null, X: { pan: 3 } }, cam4: { A: null, X: null, Y: { yaw: 4 } },
};
const shifted = shiftPresetsAfterRemoval(presets, 2, 4);
check('removing rig 2 moves rig 3 presets to cam2 and rig 4 presets to cam3', JSON.stringify(shifted.cam2) === JSON.stringify(presets.cam3) && JSON.stringify(shifted.cam3) === JSON.stringify(presets.cam4));
check('removing rig 2 leaves rig 1 presets alone and drops the last camera id', shifted.cam1 === presets.cam1 && shifted.cam4 === undefined);
check('the old presets object is never mutated', presets.cam4 !== undefined && presets.cam2.A !== null);
check('removing the last rig just drops its presets', JSON.stringify(Object.keys(shiftPresetsAfterRemoval(presets, 4, 4))) === JSON.stringify(['cam1', 'cam2', 'cam3']));
check('removing the first rig shifts everyone down', JSON.stringify(shiftPresetsAfterRemoval(presets, 1, 4).cam1) === JSON.stringify(presets.cam2));
check('a camera with no saved presets entry shifts as empty', shiftPresetsAfterRemoval({ cam1: { A: null }, cam3: { A: { pan: 9 } } } as any, 1, 3).cam1 === undefined);
check('presetSlotsSet lists only slots that hold a position', presetSlotsSet(presets.cam4).join() === 'Y' && presetSlotsSet(undefined).length === 0 && presetSlotsSet({ A: null }).length === 0);

// ---- ATEM
reset();
let atemRaw = applyAtemPatch(current(), { ip: '10.0.0.77', defaultTransition: 'auto', meIndex: 1 });
check('the ATEM address, default transition and mix/effect can be changed', atemRaw.atem.ip === '10.0.0.77' && atemRaw.atem.defaultTransition === 'auto' && atemRaw.atem.meIndex === 1);
check('an ATEM edit leaves the devices and profiles alone', JSON.stringify(atemRaw.devices) === JSON.stringify(current().devices) && JSON.stringify(atemRaw.profiles) === JSON.stringify(current().profiles));
atemRaw = applyAtemPatch(current(), { graphics: { type: 'usk', dskIndex: 1, uskIndex: 2, meIndex: 1, fadeFrames: 30 } });
check('the graphics keyer settings can be changed (and created when the file had none)', atemRaw.graphics.type === 'usk' && atemRaw.graphics.dskIndex === 1 && atemRaw.graphics.uskIndex === 2 && atemRaw.graphics.meIndex === 1 && atemRaw.graphics.fadeFrames === 30);
check('a partial graphics edit changes only what was sent', applyAtemPatch(atemRaw, { graphics: { fadeFrames: 0 } }).graphics.dskIndex === 1 && applyAtemPatch(atemRaw, { graphics: { fadeFrames: 0 } }).graphics.fadeFrames === 0);
refused('an empty ATEM address is refused', () => applyAtemPatch(current(), { ip: '  ' }), /ATEM address \(IP\) must be/);
refused('a placeholder ATEM address is refused by the same rule the loader uses', () => applyAtemPatch(current(), { ip: 'undefined' }), /real hostname or IP/);
refused('a default transition other than cut or auto is refused', () => applyAtemPatch(current(), { defaultTransition: 'fade' }), /cut or auto/);
refused('a mix/effect index outside 0-3 is refused', () => applyAtemPatch(current(), { meIndex: 7 }), /mix\/effect index must be/);
refused('a graphics keyer other than dsk, usk or auto is refused', () => applyAtemPatch(current(), { graphics: { type: 'xyz' } }), /dsk, usk or auto/);
refused('a key fade over 250 frames is refused', () => applyAtemPatch(current(), { graphics: { fadeFrames: 300 } }), /key fade/);
refused('a DSK index outside 0-3 is refused', () => applyAtemPatch(current(), { graphics: { dskIndex: 4 } }), /DSK index must be/);
refused('an unknown ATEM field is refused', () => applyAtemPatch(current(), { firmware: '9' }), /"firmware" cannot be changed here/);
refused('an unknown graphics field is refused', () => applyAtemPatch(current(), { graphics: { colour: 'red' } }), /"colour" cannot be changed here/);
reset();
writeDevicesFile(applyAtemPatch(current(), { ip: '10.0.0.77', graphics: { fadeFrames: 20 } }));
check('an ATEM edit through the writer keeps every comment and the devices', comments(fs.readFileSync(file, 'utf8')) >= comments(fixture) && onDisk().devices.rs3.protocol === 'dji-bridge' && onDisk().atem.ip === '10.0.0.77' && onDisk().graphics.fadeFrames === 20);
reset();

// ---- profiles: save, save as, rename, delete
reset();
const workSlots = [{ device: 'vbot', inputId: 9, camera: 'a7s3' }, { device: 'rs3', inputId: 2, camera: 'fx3' }];
let saved = applySaveProfile(current(), workSlots);
check('Save writes the working rigs into the active profile', JSON.stringify(saved.profiles.production.slots) === JSON.stringify(workSlots));
check('Save leaves the other profile and the hardware alone', JSON.stringify(saved.profiles.test) === JSON.stringify(current().profiles.test) && JSON.stringify(saved.devices) === JSON.stringify(current().devices));
refused('Save refuses rigs that break the rules', () => applySaveProfile(current(), [{ device: 'birddog1', inputId: 7, camera: 'fx3' }]), /built-in camera/);
check('Save does not mutate its input', current().profiles.production.slots.length === 3);
const asNew = applySaveProfileAs(current(), '  Sunday — two cams  ', workSlots);
check('Save as adds a new profile with the working rigs and makes it active', asNew.key === 'sunday-two-cams' && asNew.raw.activeProfile === 'sunday-two-cams' && asNew.raw.profiles['sunday-two-cams'].label === 'Sunday — two cams' && asNew.raw.profiles['sunday-two-cams'].slots.length === 2);
check('Save as leaves the original profile exactly as it was saved', JSON.stringify(asNew.raw.profiles.production) === JSON.stringify(current().profiles.production));
check('a second Save as with another name gets another key', applySaveProfileAs(asNew.raw, 'Sunday two cams!', workSlots).key === 'sunday-two-cams-2');
refused('Save as refuses a name that is already used (ignoring case)', () => applySaveProfileAs(asNew.raw, 'SUNDAY — TWO CAMS', workSlots), /already exists/);
refused('Save as needs a name', () => applySaveProfileAs(current(), '  ', workSlots), /profile name must be 1 to 64/);
refused('Save as refuses rigs that break the rules', () => applySaveProfileAs(current(), 'Bad', [{ device: 'fx3' }]), /not a controller/);
check('the key for a new profile is unique even when the names slug the same', (() => { const a = applySaveProfileAs(current(), 'Same name', workSlots).raw; const b = applySaveProfileAs(a, 'Same-name', workSlots); return b.key === 'same-name-2'; })());
const renamed = renameProfile(asNew.raw, 'test', 'Test rig set');
check('a profile can be renamed', renamed.profiles.test.label === 'Test rig set' && renamed.profiles.test.slots.length === 2);
refused('renaming to a name another profile has is refused', () => renameProfile(asNew.raw, 'test', 'Sunday — two cams'), /already exists/);
check('a profile can keep its own name when renamed', renameProfile(asNew.raw, 'test', 'test').profiles.test.label === 'test');
refused('renaming an unknown profile is a 404', () => renameProfile(current(), 'ghost', 'x'), /unknown profile/, 404);
check('an inactive profile can be deleted', deleteProfile(asNew.raw, 'test').profiles.test === undefined && deleteProfile(asNew.raw, 'test').activeProfile === 'sunday-two-cams');
refused('the active profile cannot be deleted (409)', () => deleteProfile(current(), 'production'), /Switch to another profile/, 409);
const lone = current(); delete lone.profiles.test;
refused('the last profile cannot be deleted (409)', () => deleteProfile(lone, 'production'), /Switch to another profile|last profile/, 409);
refused('deleting an unknown profile is a 404', () => deleteProfile(current(), 'ghost'), /unknown profile/, 404);
reset();
writeDevicesFile(applySaveProfileAs(current(), 'Sunday', workSlots).raw);
check('Save as through the writer keeps every comment and the original profile', comments(fs.readFileSync(file, 'utf8')) >= comments(fixture) - 0 && onDisk().profiles.production.slots.length === 3 && onDisk().activeProfile === 'sunday');
reset();

if (previous === undefined) delete process.env.DEVICES_CONFIG; else process.env.DEVICES_CONFIG = previous;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`rig edit: ${passed} checks passed`);
