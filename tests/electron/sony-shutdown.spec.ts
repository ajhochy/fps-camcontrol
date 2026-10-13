import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SonyManager, SonyChildProcess } from '../../src/sony/sonyManager';
import { SonyStateStore } from '../../src/sony/sonyStateStore';

test('managed shutdown does not report completion until the guardian exits after SIGKILL', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-shutdown-'));
  const child = new EventEmitter() as EventEmitter & SonyChildProcess;
  const kills: string[] = [];
  child.kill = signal => { kills.push(signal); return true; };
  const timers: { fn: () => void; ms: number; cleared?: boolean }[] = [];
  let spawned = false;
  const manager = new SonyManager({
    enabled: true, apiUrl: 'http://127.0.0.1:8181', executable: process.execPath, stateFile: path.join(home, 'sony.json'),
  }, new SonyStateStore(path.join(home, 'sony.json')), {
    spawn: () => { spawned = true; return child; },
    fetch: async url => {
      if (!spawned) throw new Error('not running');
      return new Response(JSON.stringify(url.endsWith('/api/server/status')
        ? { success: true, server: { version: 'fixture', sdkVersion: 'fixture' } }
        : { success: true, cameras: [] }), { headers: { 'Content-Type': 'application/json' } });
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { (timer as { cleared?: boolean }).cleared = true; },
  });
  manager.start(); await manager.whenIdle();
  let finished = false;
  const stop = manager.stop().then(() => { finished = true; });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  await tick();
  const runLast = (ms: number) => {
    const timer = timers.filter(timer => timer.ms === ms && !timer.cleared).at(-1);
    assert.ok(timer); timer.cleared = true; timer.fn();
  };
  runLast(3000); await tick();
  assert.deepEqual(kills, ['SIGTERM']);
  runLast(2000); await tick();
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(finished, false, 'queueing force-kill is not confirmation of exit');
  child.emit('exit', 0);
  await stop;
  assert.equal(finished, true);
});

test('embedded replacement cannot probe or adopt a helper while its guardian owns the Sony lease', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-owner-'));
  const home = path.join(appData, 'FPS CamControl');
  fs.mkdirSync(home);
  const root = path.resolve(__dirname, '../..');
  const lease = await require('../../electron/production-lock.cjs').acquire(appData, 'sony');
  const previous = { CAMCONTROL_EMBEDDED: process.env.CAMCONTROL_EMBEDDED, CAMCONTROL_HOME: process.env.CAMCONTROL_HOME, CAMCONTROL_RESOURCES: process.env.CAMCONTROL_RESOURCES };
  Object.assign(process.env, { CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: home, CAMCONTROL_RESOURCES: root });
  let requests = 0, spawns = 0;
  const manager = new SonyManager({ enabled: true, apiUrl: 'http://127.0.0.1:8181', stateFile: path.join(home, 'sony.json') },
    new SonyStateStore(path.join(home, 'sony.json')), {
      fetch: async () => { requests++; return new Response(JSON.stringify({ success: true, server: { version: 'fixture', sdkVersion: 'fixture' }, cameras: [] })); },
      spawn: () => { spawns++; throw new Error('must not spawn'); },
      setTimeout: () => ({}), clearTimeout: () => {},
    });
  try {
    manager.start(); await manager.whenIdle();
    assert.equal(requests, 0); assert.equal(spawns, 0);
    assert.equal(manager.getStatus().sidecar.state, 'starting');
    assert.notEqual(manager.getStatus().sidecar.mode, 'external');
    await lease.release();
    manager.retryService(); await manager.whenIdle();
    assert.equal(manager.getStatus().sidecar.mode, 'external');
    assert.equal(manager.getStatus().sidecar.state, 'healthy');
  } finally {
    await manager.stop(); await lease.release();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('retrying a healthy managed Sony service keeps ownership until exit before acquiring a replacement lease', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-retry-'));
  const home = path.join(appData, 'FPS CamControl'); fs.mkdirSync(home);
  const previous = { CAMCONTROL_EMBEDDED: process.env.CAMCONTROL_EMBEDDED, CAMCONTROL_HOME: process.env.CAMCONTROL_HOME, CAMCONTROL_RESOURCES: process.env.CAMCONTROL_RESOURCES };
  Object.assign(process.env, { CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: home, CAMCONTROL_RESOURCES: path.resolve(__dirname, '../..') });
  const children: Array<EventEmitter & SonyChildProcess> = [];
  let active = false, probes = 0;
  const manager = new SonyManager({ enabled: true, apiUrl: 'http://127.0.0.1:8181', executable: process.execPath, stateFile: path.join(home, 'sony.json') },
    new SonyStateStore(path.join(home, 'sony.json')), {
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & SonyChildProcess;
        child.kill = () => true; child.on('exit', () => { active = false; });
        children.push(child); active = true; return child;
      },
      fetch: async url => {
        if (url.endsWith('/api/server/status')) { probes++; if (!active) throw new Error('not running'); }
        return new Response(JSON.stringify({ success: true, server: { version: 'fixture', sdkVersion: 'fixture' }, cameras: [] }));
      },
    });
  let lease: { release(): Promise<void> } | undefined;
  try {
    manager.start(); await manager.whenIdle();
    lease = await require('../../electron/production-lock.cjs').acquire(appData, 'sony');
    assert.ok(lease);
    const priorProbes = probes;
    manager.retryService();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(manager.getStatus().sidecar.owned, true, 'retry must retain current child ownership');
    assert.equal(probes, priorProbes, 'retry cannot health-probe its own stopping guardian');
    assert.equal(children.length, 1);
    await lease.release(); children[0].emit('exit', 0);
    await manager.whenIdle();
    assert.equal(children.length, 2);
    assert.equal(manager.getStatus().sidecar.mode, 'managed');
    assert.equal(manager.getStatus().sidecar.owned, true);
    manager.retryService();
    const stopped = manager.stop(); children[1].emit('exit', 0); await stopped;
    await manager.whenIdle();
    assert.equal(children.length, 2, 'app shutdown cancels a pending retry rather than spawning after stop');
  } finally {
    await lease?.release();
    if (active) { const stopped = manager.stop(); children.at(-1)?.emit('exit', 0); await stopped; }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
