#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { fileEvidence } = require('./electron-signing-support.cjs');
const root = path.resolve(__dirname, '..');
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const app = option('--app');
const resources = app ? path.join(app, 'Contents/Resources') : option('--resources');
const sidecar = option('--sidecar-dir') || (resources && path.join(resources, 'tracker-sidecar'));
const recon = process.argv.includes('--recon');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function loadControl(module) {
  if (!app) require('ts-node/register/transpile-only');
  return require(app ? path.join(resources, 'backend/dist', module) : path.join(root, 'src', module));
}
async function liveFrameProbe(SidecarProcess, python, model, temporary) {
  const { parseFromTracker } = loadControl('tracking/protocol');
  const jpeg = execFileSync(python, ['-I', '-B', '-c',
    'import sys;from PIL import Image,ImageDraw;i=Image.new("RGB",(640,480),(23,29,33));d=ImageDraw.Draw(i);d.rectangle((180,120,460,360),fill=(50,90,120));i.save(sys.stdout.buffer,format="JPEG")'],
  { cwd: temporary, env: { HOME: temporary, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 1024 * 1024 });
  const frameToken = crypto.randomBytes(32).toString('base64url');
  const frames = [], messages = [];
  let invalidMessages = 0, deniedFrames = 0, socket, owner, heartbeat;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/sony/cameras/fixture/live-view/frame') { response.writeHead(404); response.end(); return; }
    if (request.headers.authorization !== `Bearer ${frameToken}`) { deniedFrames++; response.writeHead(403); response.end(); return; }
    const capturedAt = Date.now();
    frames.push({ capturedAt, bytes: jpeg.length, jpegAccepted: request.headers.accept === 'image/jpeg' });
    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'X-Frame-Captured-At': String(capturedAt) });
    response.end(jpeg);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const backendOrigin = 'http://127.0.0.1:' + server.address().port;
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error('Actual live Python frame probe deadline'); await wait(20); }
  };
  try {
    owner = new SidecarProcess({ enabled: true, resourcesRoot: resources, pythonPath: python, scriptPath: path.join(sidecar, 'main.py'), modelPath: model,
      source: 'live', backendOrigin, frameToken });
    const ready = await owner.start();
    const anonymousWebSocketStatus = await new Promise(resolve => {
      const anonymous = new WebSocket(ready.url, { handshakeTimeout: 2000, maxPayload: 65536 });
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); anonymous.terminate(); resolve(value); } };
      const timer = setTimeout(() => finish('timeout'), 3000);
      anonymous.on('unexpected-response', (_request, response) => { response.resume(); finish(response.statusCode); });
      anonymous.on('open', () => finish('accepted')); anonymous.on('error', () => finish('connection-error'));
    });
    const anonymousFrameStatus = (await fetch(backendOrigin + '/api/sony/cameras/fixture/live-view/frame')).status;
    socket = new WebSocket(ready.url, { headers: { Authorization: `Bearer ${ready.token}` }, maxPayload: 65536, perMessageDeflate: false });
    socket.on('error', () => { invalidMessages++; });
    socket.on('message', (bytes, binary) => {
      let value;
      try { value = !binary && bytes.length <= 65536 ? parseFromTracker(JSON.parse(bytes.toString())) : null; } catch { value = null; }
      if (value) messages.push(value); else invalidMessages++;
    });
    await once(socket, 'open');
    const send = message => socket.send(JSON.stringify({ protocol: 1, ...message }));
    heartbeat = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) send({ type: 'ping', nonce: 'live-proof-heartbeat' }); }, 500);
    send({ type: 'hello' }); await until(() => messages.some(message => message.type === 'hello'));
    send({ type: 'configure', sources: [{ sourceId: 'fixture', frameUrl: backendOrigin + '/api/sony/cameras/fixture/live-view/frame' }] });
    const sessionId = crypto.randomUUID();
    send({ type: 'select', sourceId: 'fixture', sessionId, x: .5, y: .5 });
    await until(() => messages.some(message => message.type === 'error' && message.sessionId === sessionId));
    await wait(100);
    const observation = { scope: app ? 'actual packaged live Python and model' : 'staged live Python and model',
      anonymousWebSocketStatus, anonymousFrameStatus, deniedFrames, frames, invalidMessages,
      hello: messages.find(message => message.type === 'hello'),
      metrics: messages.filter(message => message.type === 'status'),
      tracks: messages.filter(message => message.type === 'track'),
      errors: messages.filter(message => message.type === 'error').map(({ code, sourceId, sessionId: id }) => ({ code, sourceId, sessionId: id })),
      imageRetention: 'generated geometric JPEG only, memory-only; no identifiable footage or persisted frame' };
    socket.close(); await once(socket, 'close'); socket = null;
    await owner.stop();
    return observation;
  } finally {
    clearInterval(heartbeat); socket?.terminate(); await owner?.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
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
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20, safetyTimeoutMs: 250 });
  // Passive observation of actual commands received over the loopback wire.
  // The bridge's real 250ms watchdog and handler are unchanged.
  const received = [];
  bridge.wss.on('connection', socket => socket.on('message', bytes => {
    try {
      const value = JSON.parse(bytes.toString());
      if (value.v === 1 && value.type === 'cmd' && Number.isInteger(value.id)) received.push({ method: value.method, at: performance.now() });
    } catch { /* The production bridge owns parsing/rejection. */ }
  }));
  const observeStop = async trigger => {
    const offset = received.length, logOffset = bridge.log.length, began = performance.now(); trigger();
    let stop;
    while (!(stop = received.slice(offset).find(command => command.method === 'stop')) && performance.now() - began < 1000) await wait(5);
    return { explicitStopReceived: !!stop, stopMs: stop ? stop.at - began : null, watchdogMs: 250,
      handledStopCommands: bridge.log.slice(logOffset).filter(line => line.startsWith('stop ')).length,
      watchdogFired: bridge.log.slice(logOffset).includes('safety-stop') };
  };
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
    assert.ok(Math.abs(bridge.velPan) + Math.abs(bridge.velTilt) > 0, 'Override must interrupt actual nonzero motion');
    const manualStop = await observeStop(() => manager.operatorOverride('cam1')); const overridden = motionCount();
    if (!recon) assertExplicitStop(manualStop, 'manual override');
    await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(motionCount(), overridden);
    assert.equal(bridge.velPan, 0); assert.equal(bridge.velTilt, 0);
    manager.resume('rig'); await until(() => motionCount() > overridden);
    assert.ok(Math.abs(bridge.velPan) + Math.abs(bridge.velTilt) > 0, 'Crash must interrupt actual nonzero motion');
    const crashStop = await observeStop(() => child.kill('SIGKILL')); await until(() => exited);
    if (!recon) assertExplicitStop(crashStop, 'helper crash');
    await until(() => manager.getStatus().rig.sessionId === null && bridge.velPan === 0 && bridge.velTilt === 0);
    const stopped = motionCount(); await new Promise(resolve => setTimeout(resolve, 600)); assert.equal(motionCount(), stopped);
    assert.equal(manager.getStatus().rig.state, 'sidecar_offline');
    return { scope: app ? 'actual packaged Python + packaged TS control + virtual gimbal' : 'staged Python + source TS control + virtual gimbal',
      motion: 'PASS', manualOverrideResume: 'PASS', helperCrashStopNoReplay: 'PASS', manualStop, crashStop, physicalHardware: 'NOT_TESTED' };
  } finally {
    manager?.stop(); client?.stop(); device?.close(); clearInterval(heartbeat);
    if (!exited) {
      child.stdin.end(); child.kill('SIGTERM');
      try { await until(() => exited); } catch { child.kill('SIGKILL'); await until(() => exited); }
    }
    if (bridge.port) await bridge.stop();
  }
}
function assertExplicitStop(observation, label) {
  assert.equal(observation.explicitStopReceived, true, label + ': a new stop command must arrive over the real socket');
  assert.ok(observation.handledStopCommands >= 1, label + ': the bridge must handle the new stop command');
  assert.ok(Number.isFinite(observation.stopMs) && observation.stopMs >= 0 && observation.stopMs < 200,
    label + ': explicit stop must arrive within 200ms, before the unchanged 250ms watchdog');
  assert.equal(observation.watchdogFired, false, label + ': watchdog cannot stand in for an explicit stop');
}
function assertLiveFrame(observation) {
  assert.equal(observation.anonymousWebSocketStatus, 401);
  assert.equal(observation.anonymousFrameStatus, 403); assert.equal(observation.deniedFrames, 1);
  assert.ok(observation.frames.length >= 1, 'Live helper must actually fetch the bearer-authenticated JPEG');
  for (const frame of observation.frames) {
    assert.equal(frame.jpegAccepted, true); assert.ok(frame.bytes > 0);
    assert.ok(Number.isSafeInteger(frame.capturedAt) && frame.capturedAt > 0);
  }
  assert.equal(observation.invalidMessages, 0, 'All actual helper messages must pass the packaged strict protocol parser');
  assert.equal(observation.hello.detector, 'yolox-s-opencv-zoo-2022nov');
  assert.deepEqual(observation.hello.capabilities, ['person']);
  assert.ok(observation.metrics.length >= 1, 'Real live inference must emit actual metrics, not only locking/idle');
  for (const metric of observation.metrics) {
    assert.equal(metric.sourceId, 'fixture'); assert.equal(metric.degradedTiming, false);
    for (const key of ['fps', 'detectP50Ms', 'detectP95Ms']) assert.ok(Number.isFinite(metric[key]) && metric[key] > 0, 'Actual positive finite inference metric: ' + key);
    assert.ok(Number.isFinite(metric.frameAgeMs) && metric.frameAgeMs >= 0);
    assert.equal(metric.dropped, 0); assert.equal(metric.busy, 0);
  }
  assert.deepEqual(observation.errors.map(error => error.code), ['no_target'], 'Generated image must yield curated no_target, never source_unavailable');
  assert.ok(observation.tracks.some(track => track.state === 'locking'));
  assert.ok(observation.tracks.some(track => track.state === 'idle'));
  assert.ok(observation.tracks.every(track => track.state !== 'tracking' && track.sourceId === 'fixture' && track.sessionId === observation.errors[0].sessionId));
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
  if (recon) {
    const observation = { ...report, mode: 'OBSERVATION_ONLY', live: await liveFrameProbe(SidecarProcess, python, model, temporary),
      motion: await packagedMotionProof(python, model, temporary) };
    const evidence = option('--evidence') || path.join(root, 'dist', `tracking-live-recon-${crypto.randomUUID()}.json`);
    fs.writeFileSync(evidence, JSON.stringify(observation, null, 2), { flag: 'wx', mode: 0o444 });
    console.log(JSON.stringify({ evidence, mode: observation.mode, live: observation.live, motion: observation.motion })); return;
  }
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
  report.liveFrame = await liveFrameProbe(SidecarProcess, python, model, temporary);
  assertLiveFrame(report.liveFrame);
  report.motionIntegration = await packagedMotionProof(python, model, temporary);
  const evidence = option('--evidence') || path.join(root, 'dist', `tracking-runtime-evidence-${crypto.randomUUID()}.json`);
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o444 });
  console.log(JSON.stringify({ evidence, scope: report.scope, inference: report.inference, helper: report.helper,
    liveFrame: { result: 'PASS', authenticatedFrames: report.liveFrame.frames.length, invalidMessages: report.liveFrame.invalidMessages,
      metrics: report.liveFrame.metrics, errors: report.liveFrame.errors.map(error => error.code) }, motionIntegration: report.motionIntegration }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
