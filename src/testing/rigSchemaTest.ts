import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as YAML from 'yaml';
import { validateDevicesConfig, saveProfiles, resolveProfile, InventoryDevice } from '../config/configLoader';

/**
 * Rules for Sony cameras as inventory devices and the `camera:` field on rigs
 * (docs/ai/plans/2026-09-30-device-config-rigs-ui.md, D1/D4/D14).
 * Run: npx ts-node src/testing/rigSchemaTest.ts
 */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const rejects = (name: string, payload: unknown, pattern: RegExp): void => {
  let message = '';
  try { validateDevicesConfig(payload); } catch (error) { message = String(error); }
  check(name, pattern.test(message));
};

const base = {
  atem: { ip: '127.0.0.1', defaultTransition: 'cut', meIndex: 0 },
  devices: {
    vbot: { label: 'V-BOT', protocol: 'visca', cameraType: 'vbot', viscaIp: '192.168.50.15' },
    birddog1: { label: 'BirdDog 1', protocol: 'visca', cameraType: 'birddog', viscaIp: '192.168.50.16' },
    rs3: { label: 'DJI RS3', protocol: 'dji-bridge', bridge: { host: 'dji-bridge.local', port: 7878 } },
    rs3pro: { label: 'DJI RS3 Pro', protocol: 'dji-bridge', bridge: { host: 'dji-bridge.local', port: 7879 } },
    fx3: { label: 'FX3 — stage right', protocol: 'sony', sonyCameraId: '78:F5:05:43:AD:50' },
    a7s3: { label: 'a7S III — stage left', protocol: 'sony', sonyCameraId: '9C:50:D1:AC:7B:72' },
    spare: { label: 'Spare (not yet bound)', protocol: 'sony' },
  } as Record<string, unknown>,
  profiles: {
    production: { slots: [{ device: 'vbot', inputId: 6, camera: 'a7s3' }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', inputId: 2, camera: 'fx3' }] },
    test: { slots: [{ device: 'vbot', inputId: 6, camera: 'fx3' }, { device: 'rs3pro' }] },
  } as Record<string, unknown>,
  activeProfile: 'production',
};
const variant = (mutate: (copy: any) => void): unknown => { const copy = JSON.parse(JSON.stringify(base)); mutate(copy); return copy; };

// ---- valid configurations
const ok = validateDevicesConfig(base);
check('a config with Sony devices and cameras on rigs is valid', ok.cameras.length === 3);
check('a resolved rig carries its Sony camera key', ok.cameras[0].camera === 'a7s3' && ok.cameras[2].camera === 'fx3');
check('a rig with no camera resolves without one', ok.cameras[1].camera === undefined);
check('a V-BOT or gimbal rig without a camera is valid', validateDevicesConfig(variant((c) => { delete c.profiles.production.slots[0].camera; })).cameras[0].camera === undefined);
check('a Sony device with no camera id yet (not bound) is valid', validateDevicesConfig(variant((c) => { c.profiles.production.slots[0].camera = 'spare'; })).cameras[0].camera === 'spare');
check('the same Sony camera may be used by a rig in two different profiles', validateDevicesConfig(base).cameras.length === 3 && (base.profiles as any).test.slots[0].camera === 'fx3');
check('a config with no Sony devices at all still validates', validateDevicesConfig(variant((c) => {
  for (const key of ['fx3', 'a7s3', 'spare']) delete c.devices[key];
  for (const profile of Object.values<any>(c.profiles)) for (const slot of profile.slots) delete slot.camera;
})).cameras.length === 3);

// ---- rejected configurations
rejects('a Sony device cannot be a rig controller', variant((c) => { c.profiles.production.slots[1].device = 'fx3'; }), /is a Sony camera, not a controller/);
rejects('a rig camera must exist in the inventory', variant((c) => { c.profiles.production.slots[0].camera = 'nope'; }), /not in the device inventory/);
rejects('a rig camera must be a Sony device', variant((c) => { c.profiles.production.slots[0].camera = 'rs3pro'; }), /not a Sony camera device/);
rejects('a BirdDog rig takes no Sony camera (built-in camera)', variant((c) => { c.profiles.production.slots[1].camera = 'spare'; }), /built-in camera/);
rejects('one Sony camera cannot be on two rigs in the same profile', variant((c) => { c.profiles.production.slots[2].camera = 'a7s3'; }), /is on both rig 1 and rig 3/);
rejects('the same physical camera id cannot be claimed by two Sony devices', variant((c) => { c.devices.spare.sonyCameraId = '78:f5:05:43:ad:50'; }), /both use camera id/);
rejects('a camera id with spaces or shell characters is refused', variant((c) => { c.devices.spare.sonyCameraId = '78:F5 05;43'; }), /sonyCameraId must be a camera id/);
rejects('rules apply to profiles that are not active', variant((c) => { c.profiles.test.slots[0].camera = 'rs3'; }), /rig 1: camera .{0,4}rs3.{0,4} is not a Sony camera device/);

// ---- resolveProfile refuses a Sony controller directly
let resolveMessage = '';
try { resolveProfile(base.devices as unknown as Record<string, InventoryDevice>, { slots: [{ device: 'fx3' }] }); } catch (error) { resolveMessage = String(error); }
check('resolving a profile whose controller is a Sony device throws a clear error', /is a Sony camera, not a controller/.test(resolveMessage));

// ---- profile saves use the same rules and keep the file documented
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-rig-schema-'));
const file = path.join(dir, 'devices.yaml');
const previous = process.env.DEVICES_CONFIG;
process.env.DEVICES_CONFIG = file;
const fixture = [
  '# Documented on purpose: a save must not erase this.',
  'atem:', '  ip: 127.0.0.1', '  defaultTransition: cut', '  meIndex: 0',
  'devices:',
  '  vbot: { label: "V-BOT", protocol: visca, cameraType: vbot, viscaIp: 192.168.50.15 }',
  '  birddog1: { label: "BirdDog 1", protocol: visca, cameraType: birddog, viscaIp: 192.168.50.16 }',
  '  # The FX3A needs pairing mode after each power cycle.',
  '  fx3: { label: "FX3A", protocol: sony, sonyCameraId: "78:F5:05:43:AD:50" }',
  'activeProfile: production',
  'profiles:',
  '  production:',
  '    slots:',
  '      - { device: vbot, inputId: 6 } # slot 1 = X',
  '      - { device: birddog1, inputId: 7 } # slot 2 = A',
  '',
].join('\n');
fs.writeFileSync(file, fixture);
const commentCount = (text: string): number => text.split('\n').filter((line) => line.includes('#')).length;

let refused = '';
try { saveProfiles({ production: { slots: [{ device: 'vbot', inputId: 6, camera: 'nope' }, { device: 'birddog1', inputId: 7 }] } }); } catch (error) { refused = String(error); }
check('saving a profile with an unknown camera is refused', /not in the device inventory/.test(refused));
check('a refused profile save leaves the file byte-identical', fs.readFileSync(file, 'utf8') === fixture);
refused = '';
try { saveProfiles({ production: { slots: [{ device: 'vbot', inputId: 6 }, { device: 'birddog1', inputId: 7, camera: 'fx3' }] } }); } catch (error) { refused = String(error); }
check('saving a Sony camera onto a BirdDog rig is refused', /built-in camera/.test(refused));
saveProfiles({ production: { slots: [{ device: 'vbot', inputId: 6, camera: 'fx3' }, { device: 'birddog1', inputId: 7 }] } });
const saved = YAML.parse(fs.readFileSync(file, 'utf8'));
check('a valid profile save stores the rig camera', saved.profiles.production.slots[0].camera === 'fx3');
check('a valid profile save keeps the Sony device entry', saved.devices.fx3.protocol === 'sony' && saved.devices.fx3.sonyCameraId === '78:F5:05:43:AD:50');
check('a valid profile save keeps every comment', commentCount(fs.readFileSync(file, 'utf8')) === commentCount(fixture));

if (previous === undefined) delete process.env.DEVICES_CONFIG; else process.env.DEVICES_CONFIG = previous;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`rig schema: ${passed} checks passed`);
