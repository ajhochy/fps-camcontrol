'use strict';
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { SidecarProcess } = require('../src/tracking/sidecarProcess');
const model = path.resolve(__dirname, '../dist/tracking-cache/object_detection_yolox_2022nov.onnx');
const frameToken = 'synthetic-frame-credential-for-test-only';
function fixture(t, mode = 'ready') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sidecar-owner-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'helper');
  const ready = mode === 'ready' ? 'printf \'{"type":"ready","protocol":1,"port":34567,"pid":%s}\\n\' "$$"'
    : mode === 'wrongpid' ? 'printf \'{"type":"ready","protocol":1,"port":34567,"pid":1}\\n\'' : '';
  fs.writeFileSync(executable, '#!/bin/sh\n' + ready + '\nwhile IFS= read -r heartbeat; do :; done\n', { mode: 0o700 });
  const script = path.join(directory, 'main.py'); fs.writeFileSync(script, '# fixture, not executed\n');
  assert.ok(fs.existsSync(model), 'Run verified runtime cache/staging first; do not silently skip model checks');
  return { enabled: true, backendOrigin: 'http://127.0.0.1:12345', frameToken, pythonPath: executable, scriptPath: script, modelPath: model, source: 'mock', startupTimeoutMs: mode === 'silent' ? 100 : 5000 };
}
test('disabled/paused helper refuses startup without reading or spawning runtime', async () => {
  for (const options of [{ enabled: false }, { enabled: true, paused: true }]) {
    const child = new SidecarProcess({ ...options, backendOrigin: 'not-used', frameToken: 'not-used' });
    await assert.rejects(child.start(), /disabled or paused/); await child.stop();
  }
});
test('actual ready port/pid is validated; simultaneous start owns one child; EOF stop awaits exit', async t => {
  const owner = new SidecarProcess(fixture(t)); t.after(() => owner.stop());
  const first = owner.start(); assert.equal(first, owner.start());
  const ready = await first;
  assert.equal(ready.url, 'ws://127.0.0.1:34567'); assert.match(ready.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ready.token, frameToken);
  await new Promise(resolve => setTimeout(resolve, 550)); // Own heartbeat keeps it alive.
  const exited = once(owner, 'exit'); await owner.stop(); await exited;
  const again = await owner.start(); assert.notEqual(again.token, ready.token, 'No credential replay on explicit new launch');
  await owner.stop();
});
test('malformed readiness and bounded timeout clean owned child before rejecting', async t => {
  for (const mode of ['wrongpid', 'silent']) {
    const owner = new SidecarProcess(fixture(t, mode)); t.after(() => owner.stop());
    await assert.rejects(owner.start(), mode === 'wrongpid' ? /readiness was invalid/ : /timed out/);
    await owner.stop();
  }
});
test('loopback origin and model checksum fail closed with curated errors', async t => {
  const options = fixture(t);
  const remote = new SidecarProcess({ ...options, backendOrigin: 'http://example.invalid:1234' });
  await assert.rejects(remote.start(), /private local backend/);
  const corrupted = path.join(path.dirname(options.scriptPath), 'corrupt.onnx'); fs.writeFileSync(corrupted, 'invalid');
  const bad = new SidecarProcess({ ...options, modelPath: corrupted });
  await assert.rejects(bad.start(), error => /verified model is unavailable/.test(error.message) && !error.message.includes(corrupted));
});
test('readiness bound counts UTF-8 bytes, and spawn failure clears ownership promptly', async t => {
  const options = fixture(t);
  fs.writeFileSync(options.pythonPath, '#!/bin/sh\nprintf \'\'' + 'é'.repeat(2200) + '\'\'\nwhile IFS= read -r heartbeat; do :; done\n');
  const oversized = new SidecarProcess(options); t.after(() => oversized.stop());
  await assert.rejects(oversized.start(), /readiness was invalid/);
  fs.chmodSync(options.pythonPath, 0o600);
  const failed = new SidecarProcess(options); t.after(() => failed.stop());
  const started = Date.now();
  await assert.rejects(failed.start(), /could not start/);
  assert.ok(Date.now() - started < 1500, 'A never-spawned child does not consume the force-kill shutdown budget');
});
