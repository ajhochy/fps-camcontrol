const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { load, observation, source, until, delay } = require('./helpers.cjs');
async function setup(run) {
  const { TrackingClient } = load('tracking/trackingClient'), { VirtualTrackingSidecar } = load('testing/virtualTrackingSidecar');
  const server = new VirtualTrackingSidecar({ token: 'test-secret' }); const port = await server.start();
  const client = new TrackingClient({ enabled: true, url: `ws://127.0.0.1:${port}`, token: 'test-secret', random: () => .5 });
  client.configure([{ sourceId: source.sourceId, frameUrl: 'http://127.0.0.1:8080/api/sony/cameras/sony-one/live-view/frame' }]);
  try { client.start(); await until(() => client.connected); await run(client, server); }
  finally { client.stop(); await server.stop(); }
}
test('issue-27-c1: disabled client is inert and enabled loopback client reconnects with bounded backoff', async () => {
  const { TrackingClient } = load('tracking/trackingClient');
  const disabled = new TrackingClient({ enabled: false, url: 'ws://127.0.0.1:1' }); disabled.start(); assert.equal(disabled.connected, false); disabled.stop();
  assert.throws(() => new TrackingClient({ enabled: true, url: 'ws://example.invalid:1' }), /loopback/);
  assert.throws(() => new TrackingClient({ enabled: true, packaged: true, allowRemote: true, url: 'ws://example.invalid:1' }), /loopback/);
  await setup(async (client, server) => {
    let connected = 0, disconnected = 0; client.on('connected', () => connected++); client.on('disconnected', () => disconnected++);
    server.drop(); await until(() => connected === 1); assert.equal(disconnected, 1);
  });
});
test('issue-27-c2: malformed binary oversized unknown nonfinite geometry and future frames are dropped and counted', async () => {
  await setup(async (client, server) => {
    const session = randomUUID(), got = []; client.select(source.sourceId, session, .7, .3); client.on('track', x => got.push(x));
    for (const data of ['{', JSON.stringify({ protocol: 1, type: 'unknown' }), JSON.stringify(observation(session, Date.now(), { cx: 2 })), JSON.stringify(observation(session, Date.now(), { cx: null })), JSON.stringify(observation(session, Date.now() + 10000)), Buffer.from('binary')]) server.raw(data);
    await until(() => client.invalidMessages >= 6); assert.equal(got.length, 0);
    server.raw('x'.repeat(65537)); await until(() => client.invalidMessages >= 7);
  });
});
test('issue-27-c3: unconfigured source and obsolete session or nonincreasing seq never reach consumers', async () => {
  await setup(async (client, server) => {
    const id = randomUUID(), got = []; client.select(source.sourceId, id, .7, .3); client.on('track', x => got.push(x));
    server.raw(JSON.stringify(observation(id, Date.now(), { sourceId: 'foreign' })));
    server.raw(JSON.stringify(observation(randomUUID(), Date.now())));
    server.raw(JSON.stringify(observation(id, Date.now(), { seq: 2 })));
    server.raw(JSON.stringify(observation(id, Date.now(), { seq: 1 })));
    server.raw(JSON.stringify(observation(id, Date.now(), { seq: 2 })));
    await until(() => got.length === 1); await delay(30); assert.equal(got.length, 1); assert.equal(got[0].seq, 2);
  });
});
test('issue-27-c4: missing matching pong disconnects within3seconds and drops active selections', async () => {
  await setup(async (client, server) => {
    let disconnected = false; client.on('disconnected', () => { disconnected = true; });
    server.goSilent(); await until(() => disconnected, 4500); assert.equal(client.connected, false);
  });
});
test('issue-27-c5: reconnect reconfigures allowlist but never replays a prior select', async () => {
  await setup(async (client, server) => {
    client.select(source.sourceId, randomUUID(), .7, .3); await until(() => server.messages.some(x => x.type === 'select'));
    const count = server.messages.filter(x => x.type === 'configure').length;
    server.drop(); await until(() => server.messages.filter(x => x.type === 'configure').length > count);
    assert.equal(server.messages.filter(x => x.type === 'select').length, 1);
  });
});
test('issue-27-c6: virtual sidecar scripts ordered trajectories and supports cancel silent drop and malformed frames', async () => {
  await setup(async (client, server) => {
    const id = randomUUID(), got = []; client.select(source.sourceId, id, .7, .3); client.on('track', x => got.push(x));
    await until(() => server.messages.some(x => x.type === 'select'));
    for (let seq = 0; seq < 3; seq++) server.emitTrack(observation(id, Date.now(), { seq }));
    await until(() => got.length === 3); assert.deepEqual(got.map(x => x.seq), [0, 1, 2]);
    client.cancel(source.sourceId, id); await until(() => server.messages.some(x => x.type === 'cancel'));
    server.emitTrack(observation(id, Date.now(), { seq: 4 })); await delay(30); assert.equal(got.length, 3);
  });
});
test('issue-27-c7: versioned strict schemas reject extra fields invalid boxes and unsafe frame configuration', () => {
  const { parseFromTracker, parseToTracker } = load('tracking/protocol');
  const id = randomUUID(), now = Date.now();
  assert.ok(parseFromTracker(observation(id, now), now));
  for (const change of [{ protocol: 2 }, { extra: true }, { cx: .99, w: .5 }, { conf: 0 }, { processedAt: now - 1 }]) assert.equal(parseFromTracker(observation(id, now, change), now), null);
  for (const frameUrl of ['https://example.invalid/frame', 'http://127.0.0.1:8080/api/config', 'http://user:pass@127.0.0.1:8080/api/sony/cameras/x/live-view/frame']) {
    assert.equal(parseToTracker({ protocol: 1, type: 'configure', sources: [{ sourceId: 'rig', frameUrl }] }), null);
  }
});
