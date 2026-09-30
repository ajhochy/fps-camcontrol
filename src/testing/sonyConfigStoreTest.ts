import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../config/configLoader';
import { saveDevicesConfig } from '../config/configLoader';
import { SonyStateStore } from '../sony/sonyStateStore';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sony-config-store-'));
const devicesPath = path.join(tempDir, 'devices.yaml');
const speedsPath = path.join(tempDir, 'speeds.json');
const mappingsPath = path.join(tempDir, 'mappings.yaml');

function writeBaseConfig(sony = ''): void {
  fs.writeFileSync(devicesPath, `# hand-written comment survives saves\natem:\n  ip: 127.0.0.1\n  defaultTransition: cut\ncameras:\n  - id: cam1\n    label: Camera\n    viscaIp: 127.0.0.1\n${sony}`, 'utf8');
  fs.writeFileSync(speedsPath, JSON.stringify({ presets: [], activePreset: 0 }), 'utf8');
  fs.writeFileSync(mappingsPath, '{}\n', 'utf8');
}

function withEnv(values: Record<string, string | undefined>, check: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  writeBaseConfig();
  withEnv({ DEVICES_CONFIG: devicesPath, SPEEDS_FILE: speedsPath, MAPPINGS_FILE: mappingsPath, SONY_ENABLED: undefined, SONY_API_URL: undefined, SONY_SERVER_EXECUTABLE: undefined, SONY_STATE_FILE: undefined }, () => {
    const config = loadConfig();
    assert.deepStrictEqual(config.sony!, {
      enabled: true,
      apiUrl: 'http://127.0.0.1:8181',
      executable: undefined,
      stateFile: path.join(tempDir, 'sony-cameras.json'),
    });
  });

  writeBaseConfig('sony:\n  enabled: false\n  apiUrl: http://yaml.invalid:9000\n  stateFile: state/approved.json\n');
  withEnv({ DEVICES_CONFIG: devicesPath, SPEEDS_FILE: speedsPath, MAPPINGS_FILE: mappingsPath, SONY_ENABLED: '1', SONY_API_URL: 'http://127.0.0.1:9191', SONY_SERVER_EXECUTABLE: '/tmp/CameraWebApp', SONY_STATE_FILE: 'env.json' }, () => {
    const config = loadConfig();
    assert.deepStrictEqual(config.sony!, {
      enabled: true,
      apiUrl: 'http://127.0.0.1:9191',
      executable: '/tmp/CameraWebApp',
      stateFile: path.join(tempDir, 'env.json'),
    });
  });
  withEnv({ DEVICES_CONFIG: devicesPath, SPEEDS_FILE: speedsPath, MAPPINGS_FILE: mappingsPath, SONY_ENABLED: 'maybe' }, () => {
    assert.throws(() => loadConfig(), /SONY_ENABLED/);
  });
  withEnv({ DEVICES_CONFIG: devicesPath, SPEEDS_FILE: speedsPath, MAPPINGS_FILE: mappingsPath, SONY_ENABLED: undefined, SONY_API_URL: undefined, SONY_SERVER_EXECUTABLE: undefined, SONY_STATE_FILE: undefined }, () => {
    const config = loadConfig();
    saveDevicesConfig({ atem: config.atem, cameras: config.cameras, graphics: config.graphics });
    const saved = fs.readFileSync(devicesPath, 'utf8');
    assert.match(saved, /hand-written comment survives saves/);
    assert.match(saved, /stateFile: state\/approved.json/);
  });

  const statePath = path.join(tempDir, 'state', 'approved.json');
  const store = new SonyStateStore(statePath);
  assert.deepStrictEqual(await store.load(), []);
  await store.approve({ id: 'D10F60149B0C', model: 'ILCE-9M3', connectionType: 'USB' });
  await assert.rejects(() => store.approve({ id: 'D10F60149B0C', token: 'never' } as any), /unsupported fields/);
  await store.approve({ id: 'D10F60149B0C', model: 'ILCE-9M3A' });
  assert.deepStrictEqual((await new SonyStateStore(statePath).load()).map(({ id, model, connectionType }) => ({ id, model, connectionType })), [{ id: 'D10F60149B0C', model: 'ILCE-9M3A', connectionType: 'USB' }]);
  await store.forget('D10F60149B0C');
  assert.deepStrictEqual(await store.load(), []);
  assert.strictEqual(fs.statSync(statePath).mode & 0o777, 0o600);

  fs.writeFileSync(statePath, '{"version":1,"approvedCameras":[{"id":"same","approvedAt":"2026-08-13T20:00:00.000Z"},{"id":"same","approvedAt":"2026-08-13T20:00:00.000Z"}]}\n');
  assert.deepStrictEqual(await new SonyStateStore(statePath).load(), []);
  assert.ok(fs.readdirSync(path.dirname(statePath)).some((entry) => entry.startsWith('approved.json.corrupt-')));

  const concurrent = new SonyStateStore(path.join(tempDir, 'concurrent.json'));
  await Promise.all(['one', 'two', 'three'].map((id) => concurrent.approve({ id })));
  assert.deepStrictEqual((await new SonyStateStore(path.join(tempDir, 'concurrent.json')).load()).map((camera) => camera.id).sort(), ['one', 'three', 'two']);

  const safePath = path.join(tempDir, 'safe.json');
  fs.writeFileSync(safePath, '{"version":1,"approvedCameras":[]}\n');
  const failing = new SonyStateStore(safePath, { fs: { rename: async () => { throw new Error('rename failed'); } } });
  await assert.rejects(() => failing.approve({ id: 'safe' }), /rename failed/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(safePath, 'utf8')), { version: 1, approvedCameras: [] });
  console.log('sony config/store: 8 checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
