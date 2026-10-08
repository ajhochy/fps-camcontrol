const test = require('node:test'), assert = require('node:assert/strict');
const { load, config, source, observation, managerFixture, delay, until, FakeClient } = require('./helpers.cjs');
test('issue-26-c1: unresolvable source is unavailable and rebinding invalidates target before old device replacement', () => {
  const f = managerFixture({ sources: [{ ...source, cameraId: null }] });
  assert.equal(f.manager.getStatus()[source.sourceId].state, 'unavailable'); assert.throws(() => f.select(), error => error.statusCode === 409); assert.equal(f.client.selections.length, 0);
  f.manager.reconcile(config, [source], new Map([['cam4', f.device]])); f.select(); f.track(); f.manager.tick();
  f.manager.reconcile(config, [{ ...source, cameraId: null }], new Map());
  assert.equal(f.device.log.at(-1).type, 'stop'); assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null); f.manager.stop();
});
test('issue-26-c2: actual virtual DJI stream stays <=20Hz with heartbeat and shared manual handoff budget', async () => {
  const { TrackingManager } = load('tracking/trackingManager'), { MotionLedger } = load('tracking/motionLedger');
  const { VirtualDjiBridge } = load('testing/virtualDjiBridge'), { DjiBridgeDevice } = load('devices/djiBridgeDevice');
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20 });
  const port = await bridge.start(); const device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam4', 'Test');
  const client = new FakeClient(), ledger = new MotionLedger(), sends = [];
  const original = device.setPanTilt.bind(device); device.setPanTilt = (p, t) => { sends.push(performance.now()); original(p, t); };
  const manager = new TrackingManager({ config, sources: [source], devices: new Map([['cam4', device]]), client, ledger });
  try {
    device.connect(); await until(() => device.connected && device.gimbalAttached);
    manager.start(); manager.select(source.sourceId, .7, .3);
    for (let i = 0; i < 10; i++) { const now = Date.now(); client.emit('track', observation(manager.getStatus()[source.sourceId].sessionId, now, { seq: i })); await delay(100); }
    manager.operatorOverride('cam4'); ledger.send(device, -.2, 0, Date.now());
    assert.ok(sends.length > 4 && sends.length <= 21); assert.ok(sends.every((x, i) => !i || x - sends[i - 1] >= 45));
    assert.ok(sends.every((x, i) => !i || x - sends[i - 1] <= 200)); assert.ok(!bridge.log.includes('safety-stop'));
  } finally { manager.stop(); device.close(); await bridge.stop(); }
});
test('issue-26-c3: same-camera override stops exactly once; different camera unaffected; explicit fresh resume only', () => {
  const f = managerFixture(); f.select(); f.track(); f.manager.tick();
  f.manager.operatorOverride('cam1'); assert.equal(f.device.log.at(-1).type, 'move');
  f.manager.operatorOverride('cam4'); f.manager.operatorOverride('cam4');
  assert.equal(f.device.log.filter(x => x.type === 'stop').length, 1);
  f.setNow(10100); f.track({ seq: 1 }); f.manager.tick(); assert.equal(f.device.log.at(-1).type, 'stop');
  assert.equal(f.manager.getStatus()[source.sourceId].state, 'operator_override');
  f.manager.resume(source.sourceId); f.manager.tick(); assert.equal(f.device.log.at(-1).type, 'move'); f.manager.stop();
});
test('issue-26-c4: emergency stop invalidates every session before further observations can move', () => {
  const f = managerFixture(); const old = f.select(); f.track(); f.manager.tick(); f.manager.emergencyStop();
  assert.equal(f.device.log.at(-1).type, 'stop'); f.client.emit('track', observation(old, 10100, { seq: 1 })); f.setNow(10100); f.manager.tick();
  assert.equal(f.device.log.at(-1).type, 'stop'); assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null); f.manager.stop();
});
test('issue-26-c5: genuinely fresh frame deadline500ms stops; prediction cannot refresh; stale alone recovers', () => {
  const f = managerFixture(); f.select(); f.track(); f.manager.tick(); f.setNow(10500); f.track({ seq: 1, frameTs: 10000 }); f.manager.tick();
  assert.equal(f.manager.getStatus()[source.sourceId].state, 'stale'); assert.equal(f.device.log.at(-1).type, 'stop');
  f.setNow(10550); f.track({ seq: 2 }); f.manager.tick(); assert.equal(f.device.log.at(-1).type, 'move'); f.manager.stop();
});
test('issue-26-c6: bridge or gimbal loss invalidates session; reconnect never replays old selection', () => {
  for (const key of ['connected', 'gimbalAttached']) {
    const f = managerFixture(); const old = f.select(); f.track(); f.manager.tick(); f.device[key] = false; f.manager.tick();
    assert.equal(f.device.log.at(-1).type, 'stop'); assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null);
    f.device[key] = true; f.client.emit('track', observation(old, 10001, { seq: 1 })); f.manager.tick(); assert.equal(f.device.log.at(-1).type, 'stop'); f.manager.stop();
  }
});
test('issue-26-c7: shutdown stops motion before client teardown and never restarts automatically', () => {
  const f = managerFixture(); f.select(); f.track(); f.manager.tick(); f.client.stop = () => assert.equal(f.device.log.at(-1).type, 'stop');
  f.manager.stop(); f.setNow(11000); f.manager.tick(); assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null);
});
test('issue-26-c8: target lost stops immediately then holds before idle', () => {
  const f = managerFixture(); f.select(); f.track(); f.manager.tick(); f.setNow(10050); f.track({ seq: 1, state: 'lost', conf: 0 });
  assert.equal(f.device.log.at(-1).type, 'stop'); assert.equal(f.manager.getStatus()[source.sourceId].state, 'holding');
  f.setNow(13100); f.manager.tick(); assert.equal(f.manager.getStatus()[source.sourceId].state, 'idle'); assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null); f.manager.stop();
});
test('issue-26-c9: disabled config creates no timers or client connections', () => {
  const f = managerFixture({ config: { ...config, enabled: false } }); f.manager.tick(); assert.equal(f.intervals(), 0); assert.equal(f.client.starts, 0); assert.equal(f.device.log.length, 0); f.manager.stop();
});
test('issue-26-c10: each public transition emits status and AppState projection without mutable session references', () => {
  const f = managerFixture(); const events = []; f.manager.on('state', e => events.push(e));
  f.select(); f.track(); f.manager.tick(); f.manager.operatorOverride('cam4'); f.manager.cancel(source.sourceId);
  assert.ok(events.length >= 4); assert.ok(f.changes.length >= events.length);
  const status = f.manager.getStatus(); status[source.sourceId].state = 'tracking'; assert.notEqual(f.manager.getStatus()[source.sourceId].state, 'tracking'); f.manager.stop();
});

test('shared motion ledger enforces exact50ms floor across tracking stop and manual handoff', () => {
  const { MotionLedger } = load('tracking/motionLedger'), { FakeDevice } = require('./helpers.cjs');
  const ledger = new MotionLedger(), device = new FakeDevice(), sends = [];
  for (let now = 0; now < 1000; now++) {
    if (now === 25) ledger.stop(device);
    if (ledger.request(device, now % 2 ? -.3 : .3, 0, now, true)) sends.push(now);
  }
  assert.equal(sends.length, 20); assert.ok(sends.every((at, i) => !i || at - sends[i - 1] === 50));
  assert.equal(device.log.filter(x => x.type === 'stop').length, 1);
});

test('select rate limiter is source-owned and cancel always emits an uncapped stop', () => {
  const f = managerFixture(); f.select();
  assert.throws(() => f.select(), error => error.statusCode === 429);
  f.manager.cancel(source.sourceId); f.manager.cancel(source.sourceId);
  assert.equal(f.device.log.filter(x => x.type === 'stop').length, 2);
  f.setNow(10250); assert.doesNotThrow(() => f.select()); f.manager.stop();
});

test('session cannot be replayed after sidecar disconnect and future/malformed observations cannot move', () => {
  const f = managerFixture(); const id = f.select();
  f.track({ frameTs: 20000 }); f.manager.tick(); assert.equal(f.device.log.length, 0);
  f.track(); f.manager.tick(); f.client.emit('disconnected');
  assert.equal(f.device.log.at(-1).type, 'stop'); assert.equal(f.manager.getStatus()[source.sourceId].state, 'sidecar_offline');
  f.client.emit('track', observation(id, 10000, { seq: 1 })); f.manager.tick(); assert.equal(f.device.log.at(-1).type, 'stop'); f.manager.stop();
});

test('failed sidecar select cannot report success or leave an armed session', () => {
  const f = managerFixture(); f.client.select = () => false;
  assert.throws(() => f.select(), error => error.statusCode === 409);
  assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null);
  assert.equal(f.device.log.at(-1).type, 'stop'); f.manager.stop();
});

test('emergency invalidates target before a synchronous stop callback can re-enter the motion tick', () => {
  const f = managerFixture(); f.select(); f.track(); f.manager.tick(); f.setNow(10100);
  f.device.stop = () => { assert.equal(f.manager.getStatus()[source.sourceId].sessionId, null); f.manager.tick(); f.device.log.push({ type: 'stop' }); };
  f.manager.emergencyStop(); assert.equal(f.device.log.filter(x => x.type === 'move').length, 1); f.manager.stop();
});
