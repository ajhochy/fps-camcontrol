import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as YAML from 'yaml';
import { readDevicesFile, writeDevicesFile, ConfigConflictError, devicesFileVersion } from '../config/configLoader';
import { applyRigPatch, createSonyDevice, patchSonyDevice, deleteSonyDevice, RigEditError } from '../config/rigEdit';

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

if (previous === undefined) delete process.env.DEVICES_CONFIG; else process.env.DEVICES_CONFIG = previous;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`rig edit: ${passed} checks passed`);
