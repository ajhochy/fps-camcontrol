'use strict';
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixtureConfig, sonyFixture } = require('./test-electron-tracking-runtime.cjs');
const { validateImportedDevicesConfig, resolveProfile } = require('../src/config/configLoader');
const { resolveTrackingSources } = require('../src/tracking/sourceResolver');
const { SonyManager } = require('../src/sony/sonyManager');
const { SonyStateStore } = require('../src/sony/sonyStateStore');

test('mounted runtime fixture uses valid production rig and tracking configuration', () => {
  const config = validateImportedDevicesConfig(fixtureConfig(12345, 12346));
  const cameras = resolveProfile(config.devices, config.profiles.fixture);
  const sources = resolveTrackingSources({ ...config, cameras });
  assert.equal(sources[0].device, 'rig'); assert.equal(sources[0].cameraId, 'cam1');
  assert.equal(sources[0].sonyCameraId, 'AA:BB'); assert.equal(config.tracking.enabled, true);
  assert.equal(cameras[0].bridge.host, '127.0.0.1'); assert.equal(config.sony.executable, undefined);
});
test('disposable Sony fixture supports real discovery, durable explicit approval and exact binary frame', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fps tracking fixture validation '));
  const stateFile = path.join(directory, 'sony-state.json');
  const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const fixture = await sonyFixture(bytes);
  const manager = new SonyManager({ enabled: true, apiUrl: 'http://127.0.0.1:' + fixture.port, stateFile }, new SonyStateStore(stateFile));
  t.after(async () => {
    await manager.stop(); fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  });
  manager.start(); await manager.whenIdle();
  assert.equal(manager.getStatus().sidecar.mode, 'external');
  await manager.discover(); assert.equal(manager.getStatus().cameras[0].state, 'discovered_unapproved');
  await manager.connect('AA:BB', false);
  assert.equal(manager.getStatus().cameras[0].state, 'connected');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).approvedCameras[0].id, 'AA:BB');
  const frame = await manager.liveViewFrame('AA:BB');
  assert.deepEqual(frame.body, bytes); assert.equal(frame.contentType, 'image/jpeg');
  assert.equal(fixture.frames(), 1); assert.ok(Math.abs(Date.now() - frame.capturedAt) < 2000);
});
