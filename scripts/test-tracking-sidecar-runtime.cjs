#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { fileEvidence } = require('./electron-signing-support.cjs');
const root = path.resolve(__dirname, '..');
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const app = option('--app');
const resources = app ? path.join(app, 'Contents/Resources') : option('--resources');
const sidecar = option('--sidecar-dir') || (resources && path.join(resources, 'tracker-sidecar'));
async function packagedMotionProof(python, model, temporary) {
  // The mock trajectory is a supported test-only CLI mode. No shipped code or
  // app configuration is rewritten; use actual packaged TS control modules.
  require('ts-node/register/transpile-only');
  const load = module => require(app ? path.join(resources, 'backend/dist', module) : path.join(root, 'src', module));
  const { TrackingClient } = load('tracking/trackingClient');
  const { TrackingManager } = load('tracking/trackingManager');
  const { TrackingSchema } = load('tracking/configSchema');
  const { DjiBridgeDevice } = load('devices/djiBridgeDevice');
  const { VirtualDjiBridge } = require('../src/testing/virtualDjiBridge');
  const token = crypto.randomBytes(32).toString('base64url');
  const backendOrigin = 'http://127.0.0.1:34560';
  const child = spawn(python, ['-I', '-B', path.join(sidecar, 'main.py'), '--source', 'mock', '--port', '0', '--trajectory', 'sine', '--model', model], {
    cwd: temporary, env: { HOME: temporary, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
      TRACKER_WS_TOKEN: token, TRACKER_FRAME_TOKEN: crypto.randomBytes(32).toString('base64url'), TRACKER_BACKEND_ORIGIN: backendOrigin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let ready, exited = false, invalid = false, bytes = 0, buffer = '';
  child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; });
  child.stdin.on('error', () => {}); child.stderr.resume();
  child.stdout.on('data', chunk => {
    if (ready || invalid) return;
    bytes += chunk.length; buffer += chunk.toString();
    if (bytes > 4096) { invalid = true; return; }
    if (!buffer.includes('\n')) return;
    try {
      const value = JSON.parse(buffer.split('\n')[0]);
      if (Object.keys(value).sort().join(',') !== 'pid,port,protocol,type' || value.type !== 'ready' || value.protocol !== 1 || value.pid !== child.pid || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) invalid = true;
      else ready = value;
    } catch { invalid = true; }
  });
  const heartbeat = setInterval(() => { if (!exited) child.stdin.write('heartbeat\n'); }, 500);
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Packaged mock-to-gimbal runtime deadline'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20 });
  let device, client, manager;
  try {
    await until(() => ready || exited || invalid); assert.ok(ready && !exited && !invalid);
    const port = await bridge.start();
    device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam1', 'Synthetic gimbal');
    device.connect(); await until(() => device.connected && device.gimbalAttached);
    client = new TrackingClient({ enabled: true, packaged: true, url: `ws://127.0.0.1:${ready.port}`, token, backendOrigin });
    const source = { sourceId: 'rig', device: 'rig', cameraId: 'cam1', sonyCameraId: 'AA:BB', invertPan: false, invertTilt: false };
    client.configure([{ sourceId: 'rig', frameUrl: backendOrigin + '/api/sony/cameras/AA%3ABB/live-view/frame' }]);
    manager = new TrackingManager({ config: TrackingSchema.parse({ enabled: true }), sources: [source], devices: new Map([['cam1', device]]), client });
    manager.start(); await until(() => client.connected); manager.select('rig', .7, .4);
    const motionCount = () => bridge.log.filter(line => line.startsWith('moveVelocity ')).length;
    await until(() => motionCount() >= 4);
    assert.equal(manager.getStatus().rig.state, 'tracking'); assert.equal(client.invalidMessages, 0);
    manager.operatorOverride('cam1'); const overridden = motionCount();
    await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(motionCount(), overridden);
    assert.equal(bridge.velPan, 0); assert.equal(bridge.velTilt, 0);
    manager.resume('rig'); await until(() => motionCount() > overridden);
    child.kill('SIGKILL'); await until(() => exited);
    await until(() => manager.getStatus().rig.sessionId === null && bridge.velPan === 0 && bridge.velTilt === 0);
    const stopped = motionCount(); await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(motionCount(), stopped);
    assert.equal(manager.getStatus().rig.state, 'sidecar_offline');
    return { scope: app ? 'actual packaged Python + packaged TS control + virtual gimbal' : 'staged Python + source TS control + virtual gimbal',
      motion: 'PASS', manualOverrideResume: 'PASS', helperCrashStopNoReplay: 'PASS', physicalHardware: 'NOT_TESTED' };
  } finally {
    manager?.stop(); client?.stop(); device?.close(); clearInterval(heartbeat);
    if (!exited) {
      child.stdin.end(); child.kill('SIGTERM');
      try { await until(() => exited); } catch { child.kill('SIGKILL'); await until(() => exited); }
    }
    if (bridge.port) await bridge.stop();
  }
}
async function main() {
  assert.ok(resources && path.isAbsolute(resources), 'Specify --app or an absolute --resources directory');
  assert.ok(sidecar && path.isAbsolute(sidecar));
  const packagedSupervisor = path.join(resources, 'backend/dist/tracking/sidecarProcess.js');
  let SidecarProcess;
  if (app) ({ SidecarProcess } = require(packagedSupervisor));
  else { require('ts-node/register/transpile-only'); ({ SidecarProcess } = require('../src/tracking/sidecarProcess')); }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-tracking-runtime-proof-'));
  const home = path.join(temporary, 'empty HOME'), cwd = path.join(temporary, 'random cwd spaces');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const python = path.join(resources, 'python/bin/python3');
  const model = path.join(resources, 'models/object_detection_yolox_2022nov.onnx');
  const report = { testedAt: new Date().toISOString(), scope: app ? 'packaged-runtime' : 'staged-runtime', app: app || null,
    model: fileEvidence(model), hostArchitecture: process.arch, cleanOS: 'NOT_TESTED', physicalHID: 'NOT_TESTED' };
  // Actual model inference is OS-network-denied, with no user Python/site/cwd.
  const code = 'import sys,json;sys.path.insert(0,sys.argv[1]);from detector import verify_inference;print(json.dumps(verify_inference(sys.argv[2]),separators=(",",":")))';
  const inference = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', python, '-I', '-B', '-c', code, sidecar, model], {
    cwd, env: { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderrBytes = 0;
  inference.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) inference.kill('SIGKILL'); });
  inference.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 1024 * 1024) inference.kill('SIGKILL'); });
  const timer = setTimeout(() => inference.kill('SIGKILL'), 120000);
  const [codeResult] = await once(inference, 'close'); clearTimeout(timer);
  assert.equal(codeResult, 0, 'Actual bundled model inference must pass with network denied; private diagnostics suppressed');
  report.inference = JSON.parse(stdout.trim());
  assert.equal(report.inference.inferenceCount, 2); assert.equal(report.inference.inputDependent, true);
  assert.equal(report.inference.finite, true); assert.deepEqual(report.inference.shape, [1, 8400, 85]);
  report.networkDeniedInference = 'PASS';
  const owner = new SidecarProcess({ enabled: true, resourcesRoot: resources, pythonPath: python, scriptPath: path.join(sidecar, 'main.py'), modelPath: model,
    source: 'mock', backendOrigin: 'http://127.0.0.1:34560', frameToken: crypto.randomBytes(32).toString('base64url') });
  let socket;
  try {
    const ready = await owner.start();
    socket = new WebSocket(ready.url, { headers: { Authorization: `Bearer ${ready.token}` } });
    const messages = []; socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    const send = message => socket.send(JSON.stringify({ protocol: 1, ...message }));
    const until = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) { if (Date.now() >= deadline) throw new Error('Bundled helper protocol deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 20)); }
    };
    send({ type: 'hello' }); await until(() => messages.some(message => message.type === 'hello'));
    send({ type: 'configure', sources: [{ sourceId: 'fixture', frameUrl: 'http://127.0.0.1:34560/api/sony/cameras/fixture/live-view/frame' }] });
    const sessionId = crypto.randomUUID();
    send({ type: 'select', sourceId: 'fixture', sessionId, x: .5, y: .5 });
    await until(() => messages.some(message => message.type === 'track' && message.state === 'tracking' && message.sessionId === sessionId));
    send({ type: 'cancel', sourceId: 'fixture', sessionId });
    await until(() => messages.some(message => message.type === 'track' && message.state === 'idle'));
    send({ type: 'ping', nonce: 'runtime-proof' }); await until(() => messages.some(message => message.type === 'pong' && message.nonce === 'runtime-proof'));
    socket.close(); await once(socket, 'close'); socket = null;
    const exited = once(owner, 'exit'); const started = Date.now(); await owner.stop(); await exited;
    report.helper = { handshake: 'PASS', selectTrackingCancelIdle: 'PASS', heartbeat: 'PASS', ownedStopAwaited: 'PASS', shutdownMs: Date.now() - started };
  } finally { socket?.terminate(); await owner.stop(); }
  report.motionIntegration = await packagedMotionProof(python, model, temporary);
  const evidence = option('--evidence') || path.join(root, 'dist', `tracking-runtime-evidence-${crypto.randomUUID()}.json`);
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o444 });
  console.log(JSON.stringify({ evidence, scope: report.scope, inference: report.inference, helper: report.helper }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
