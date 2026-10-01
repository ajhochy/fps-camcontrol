const test = require('node:test'), assert = require('node:assert/strict');
const { load, FakeDevice, delay } = require('./helpers.cjs');
const frame = (shift = 0, capturedAt = 0) => {
  const width = 80, height = 30, pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const column = (x - shift + width) % width; pixels[y * width + x] = (column * 31 + y * 17 + (column * y % 5) * 20) % 256; }
  return { width, height, pixels, capturedAt };
};
test('issue-34-c1: real grayscale registration measures onset and motion uses bounded normal device commands', async () => {
  const { estimateHorizontalDisplacement, calibrate } = load('tracking/calibration');
  assert.equal(estimateHorizontalDisplacement(frame(), frame(4)).pixels, 4);
  assert.equal(estimateHorizontalDisplacement(frame(), frame(-3)).pixels, -3);
  assert.equal(estimateHorizontalDisplacement(frame(), frame()).pixels, 0);
  const device = new FakeDevice(); let now = 0, started = null;
  device.setPanTilt = (pan, tilt) => { started ??= now; device.log.push({ type: 'move', pan, tilt, at: now }); };
  const result = await calibrate({ device, yesMove: true, trackingConnected: true, trials: 1, durationMs: 800, speed: .15,
    now: () => now, sleep: async ms => { now += ms; }, capture: async () => frame(started === null ? 0 : Math.max(0, Math.floor((now - started - 150) / 50)), now) });
  assert.ok(result.trials[0].delayMs >= 150 && result.trials[0].delayMs <= 250);
  assert.ok(result.trials[0].pixelsPerSecond > 0);
  assert.ok(device.log.filter(x => x.type === 'move').every(x => x.pan <= .15 && x.tilt === 0 && x.at <= 800));
  assert.equal(device.log.at(-1).type, 'stop');
  assert.equal(result.trials[0].degreesPerSecond, undefined, 'pixels are not angles without calibrated field of view');
});
test('issue-34-c2: dry run uses actual VirtualDjiBridge with synthetic in-memory frames and prints a report', async () => {
  const { runDryCalibration } = load('tracking/calibration');
  const result = await runDryCalibration({ trials: 2, durationMs: 600 });
  assert.equal(result.synthetic, true); assert.equal(result.trials.length, 2);
  assert.ok(result.medianDelayMs > 0); assert.ok(result.medianPixelsPerSecond > 0); assert.ok(result.virtualCommandCount > 0);
});
test('issue-34-c3: no consent or detached devices refuse movement; abort errors and blocked frame capture always stop', async () => {
  const { calibrate } = load('tracking/calibration');
  for (const options of [{ yesMove: false }, { trackingConnected: false }, { connected: false }, { gimbalAttached: false }]) {
    const device = new FakeDevice(); if ('connected' in options) device.connected = false; if ('gimbalAttached' in options) device.gimbalAttached = false;
    await assert.rejects(calibrate({ device, yesMove: true, trackingConnected: true, trials: 1, capture: async () => frame(), ...options }));
    assert.equal(device.log.filter(x => x.type === 'move').length, 0);
  }
  const device = new FakeDevice(); let calls = 0;
  await assert.rejects(calibrate({ device, yesMove: true, trackingConnected: true, trials: 1, capture: async () => { if (calls++) throw new Error('synthetic failure'); return frame(); } }));
  assert.equal(device.log.at(-1).type, 'stop');
  const blocked = new FakeDevice(); calls = 0;
  const work = calibrate({ device: blocked, yesMove: true, trackingConnected: true, trials: 1, durationMs: 80,
    capture: async () => { if (calls++) await delay(200); return frame(0, Date.now()); } });
  await delay(120); assert.equal(blocked.log.at(-1).type, 'stop', 'independent deadline stops while capture is blocked');
  await work;
  const abort = new AbortController(), cancelled = new FakeDevice(); calls = 0;
  await assert.rejects(calibrate({ device: cancelled, yesMove: true, trackingConnected: true, trials: 1, signal: abort.signal,
    capture: async () => { if (calls++) abort.abort(); return frame(); } }));
  assert.equal(cancelled.log.at(-1).type, 'stop');
});
test('issue-34-c4: report contains recommendations and raw numbers without implicit config access or writes', () => {
  const { summarizeTrials } = load('tracking/calibration');
  const result = summarizeTrials([{ delayMs: 150, pixelsPerSecond: 12, speed: .1, width: 160 }]);
  assert.ok(result.recommendedConfig.pipelineDelayMs >= 150); assert.ok(Number.isFinite(result.recommendedConfig.kp));
  assert.equal(result.trials[0].pixelsPerSecond, 12); assert.equal(result.units, 'processed pixels/second');
  const fs = require('node:fs'), text = fs.readFileSync(require.resolve('../../src/tracking/calibration.ts'), 'utf8');
  assert.doesNotMatch(text, /writeFile|writeDevices|loadConfig|devices\.yaml/);
});
test('issue-34-c5: N trials report median and spread and flag unreliable high variance', () => {
  const { summarizeTrials } = load('tracking/calibration');
  const report = summarizeTrials([100, 160, 600].map(delayMs => ({ delayMs, pixelsPerSecond: 10, speed: .1, width: 160 })));
  assert.equal(report.medianDelayMs, 160); assert.equal(report.delaySpreadMs, 500); assert.equal(report.reliability, 'unreliable rig');
  const stable = summarizeTrials([140, 150, 160].map(delayMs => ({ delayMs, pixelsPerSecond: 10, speed: .1, width: 160 })));
  assert.equal(stable.reliability, 'consistent synthetic/observed trials');
});
test('calibration rate includes quantized unchanged frames rather than overstating one-pixel jumps', () => {
  const { analyzeCalibrationFrames } = load('tracking/calibration');
  const frames = [frame(0, 0)];
  for (let time = 50; time <= 800; time += 50) frames.push(frame(Math.floor(time * 8 / 1000), time));
  const report = analyzeCalibrationFrames(frames, 0, .1, 60);
  assert.ok(report.pixelsPerSecond > 7 && report.pixelsPerSecond < 9, String(report.pixelsPerSecond));
  assert.ok(report.degreesPerSecondPerUnit > 50 && report.degreesPerSecondPerUnit < 70);
});
test('calibration CLI refuses movement without consent before networking and owns no hardware socket', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const cli = path.resolve(__dirname, '../../scripts/tracking-calibrate.ts');
  assert.ok(fs.existsSync(cli), 'Calibration CLI implementation is missing');
  const { runCli } = require(cli);
  assert.match((await runCli(['--help'])).description, /Developer calibration/);
  await assert.rejects(runCli(['--backend-url', 'http://127.0.0.1:1', '--source', 'rig-one']), /yes-move/);
  await assert.rejects(runCli(['--yes-move', '--backend-url', 'http://example.com', '--source', 'rig-one']), /loopback/);
  assert.doesNotMatch(fs.readFileSync(cli, 'utf8'), /new DjiBridgeDevice|writeFile|loadConfig|devices\.yaml/);
});
test('calibration HTTP ownership caps motion, excludes tracking/manual owners and stops on health loss', async () => {
  const express = require('express'), { randomUUID } = require('node:crypto');
  const { config, source, managerFixture } = require('./helpers.cjs');
  const { MotionLedger } = load('tracking/motionLedger');
  const { installTrackingCalibrationRoutes } = load('ui/trackingCalibrationRoutes');
  const ledger = new MotionLedger(), fixture = managerFixture({ ledger });
  const app = express(); app.use(express.json());
  const cleanup = installTrackingCalibrationRoutes(app, { tracking: { ...config, sources: [source] }, cameras: [{ id: 'cam4', deviceKey: 'rig-one' }] },
    new Map([['cam4', fixture.device]]), () => ({ ...fixture, ledger }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (action, body) => { const response = await fetch(base + '/api/tracking/calibration/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const start = () => post('start', { sourceId: source.sourceId, yesMove: true });
  try {
    assert.equal((await post('start', { sourceId: source.sourceId })).status, 400);
    ledger.send(fixture.device, .2, 0); assert.equal((await start()).status, 409); ledger.stop(fixture.device);
    fixture.select(); assert.equal((await start()).status, 409); fixture.manager.cancel(source.sourceId);
    const first = await start(); assert.equal(first.status, 200); assert.equal(first.body.durationMs, 800); assert.ok(first.body.speed <= .15);
    assert.equal((await start()).status, 409); assert.throws(() => fixture.manager.select(source.sourceId, .5, .5), error => error.statusCode === 409);
    assert.equal((await post('stop', { operationId: randomUUID() })).status, 404);
    await delay(90); assert.equal(fixture.device.log.at(-1).type, 'move');
    fixture.client.connected = false; await delay(70); assert.equal(fixture.device.log.at(-1).type, 'stop');
    fixture.client.connected = true;
    const second = await start(); assert.equal(second.status, 200);
    fixture.manager.operatorOverride('cam4'); assert.equal(fixture.device.log.at(-1).type, 'stop');
    assert.equal((await post('stop', { operationId: second.body.operationId })).status, 404);
    const third = await start(); assert.equal(third.status, 200);
    await delay(850); assert.equal(fixture.device.log.at(-1).type, 'stop', 'deadline independent of CLI');
    const fourth = await start(); assert.equal(fourth.status, 200);
    fixture.device.stop = () => { throw new Error('synthetic stop failure'); };
    assert.equal((await post('stop', { operationId: fourth.body.operationId })).status, 503);
    fixture.device.stop = () => fixture.device.log.push({ type: 'stop' });
    assert.equal((await start()).status, 409, 'failed physical stop leaves motion ownership fail-closed');
    ledger.stop(fixture.device);
    assert.equal((await start()).status, 200, 'exception still releases timer and reservation');
    fixture.manager.cancel(source.sourceId); const atCancel = fixture.device.log.length;
    await delay(100); assert.equal(fixture.device.log.length, atCancel, 'Cancel must never replay a calibration pump');
  } finally { cleanup(); fixture.manager.stop(); await new Promise(resolve => server.close(resolve)); }
});
test('calibration CLI reads actual HTTP JPEG pixels through bundled Python and SIGINT stops the owned backend pulse', async (t) => {
  const express = require('express'), path = require('node:path'), { spawn, spawnSync } = require('node:child_process');
  const { config, source, FakeClient, until } = require('./helpers.cjs');
  const { MotionLedger } = load('tracking/motionLedger'), { TrackingManager } = load('tracking/trackingManager');
  const { VirtualDjiBridge } = load('testing/virtualDjiBridge'), { DjiBridgeDevice } = load('devices/djiBridgeDevice');
  const { installTrackingCalibrationRoutes } = load('ui/trackingCalibrationRoutes'), { installTrackingRoutes } = load('ui/trackingRoutes');
  const cwd = path.resolve(__dirname, '../..'), python = path.join(cwd, 'dist/tracking-runtime/python/bin/python3');
  const generated = spawnSync(python, ['-I', '-B', '-c', `import io,json,base64
from PIL import Image
out=[]
for shift in range(32):
 im=Image.new('L',(160,90)); im.putdata([(((x-shift)%160)*31+y*17+(((x-shift)%160)*y%5)*20)%256 for y in range(90) for x in range(160)])
 buf=io.BytesIO(); im.save(buf,format='JPEG',quality=95); out.append(base64.b64encode(buf.getvalue()).decode())
print(json.dumps(out))`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(generated.status, 0, 'Bundled Pillow generates in-memory synthetic JPEG fixtures');
  const jpegs = JSON.parse(generated.stdout).map(value => Buffer.from(value, 'base64'));
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20 }), port = await bridge.start();
  const device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam4', 'Calibration fixture');
  let lastStopAt = 0;
  const normalStop = device.stop.bind(device);
  device.stop = () => { lastStopAt = Date.now(); normalStop(); };
  const ledger = new MotionLedger(), client = new FakeClient(), devices = new Map([['cam4', device]]);
  const manager = new TrackingManager({ config, sources: [source], devices, client, ledger });
  const app = express(); app.use(express.json());
  const appConfig = { tracking: { ...config, sources: [source] }, cameras: [{ id: 'cam4', deviceKey: 'rig-one' }] };
  let starts = 0, frames = 0, loseVideo = false, videoLostAt = 0, stopRequests = 0;
  app.use((req, res, next) => {
    if (req.path.endsWith('/calibration/start')) res.once('finish', () => { if (res.statusCode === 200) starts++; });
    if (req.path.endsWith('/calibration/stop')) stopRequests++;
    next();
  });
  installTrackingRoutes(app, appConfig, () => ({ manager, ledger, client }));
  const cleanup = installTrackingCalibrationRoutes(app, appConfig, devices, () => ({ manager, ledger, client }));
  app.get('/api/sony/cameras/sony-one/live-view/frame', (_req, res) => { frames++; if (loseVideo && starts >= 3) { videoLostAt = Date.now(); res.sendStatus(503); return; } res.set('X-Frame-Captured-At', String(Date.now())).type('jpeg').send(jpegs[Math.round(bridge.yaw * 160 / 60) % jpegs.length]); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const children = [];
  const launch = () => {
    const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), path.join(cwd, 'scripts/tracking-calibrate.ts'), '--yes-move', '--backend-url', 'http://127.0.0.1:' + server.address().port, '--source', 'rig-one', '--trials', '1'], {
      cwd, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, exited };
  };
  try {
    device.connect(); await until(() => device.connected && device.gimbalAttached); manager.start();
    const first = launch(), result = await first.exited;
    assert.equal(result.code, 0, result.stderr); const report = JSON.parse(result.stdout);
    assert.equal(report.synthetic, false); assert.ok(report.medianDelayMs > 0); assert.ok(report.medianPixelsPerSecondPerUnit > 0); assert.ok(frames >= 3);
    assert.ok(bridge.log.some(line => line.startsWith('moveVelocity'))); assert.equal(ledger.isMoving(device), false);
    const second = launch(); await until(() => starts === 2); second.child.kill('SIGINT');
    const aborted = await second.exited; assert.equal(aborted.code, 1); await until(() => !ledger.isMoving(device));
    const stopAt = bridge.log.length; await delay(200); assert.ok(!bridge.log.slice(stopAt).some(line => line.startsWith('moveVelocity') && !line.includes('pan=0')));
    const previousStops = stopRequests;
    loseVideo = true; const third = launch();
    await until(() => videoLostAt > 0 && lastStopAt >= videoLostAt && stopRequests > previousStops);
    assert.equal(ledger.isMoving(device), false);
    assert.ok(lastStopAt - videoLostAt < 600, 'video loss physically requests stop before independent 800ms deadline');
    const videoLost = await third.exited; assert.equal(videoLost.code, 1); assert.match(videoLost.stderr, /frame unavailable/);
    t.diagnostic(JSON.stringify({ videoLossToDeviceStopMs: lastStopAt - videoLostAt, videoLossToCliExitMs: Date.now() - videoLostAt }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    cleanup(); manager.stop(); device.close(); await bridge.stop(); await new Promise(resolve => server.close(resolve));
  }
});
