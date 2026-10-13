import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createStatusServer, startStatusServer, waitForListening } from '../../src/ui/statusServer';
import { createInitialState } from '../../src/app/state';
import { ActivityLog } from '../../src/app/activityLog';

test('desktop HTTP and WebSocket sessions reject missing credentials, forged hosts and cross-origin callers', async () => {
  const saved = { embedded: process.env.CAMCONTROL_EMBEDDED, token: process.env.CAMCONTROL_SESSION };
  process.env.CAMCONTROL_EMBEDDED = '1';
  process.env.CAMCONTROL_SESSION = 'fixture-only-session-token';
  const activity = new ActivityLog();
  const config: any = { cameras: [], atem: { ip: '127.0.0.1', defaultTransition: 'cut', meIndex: 0 }, mappings: {},
    graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 },
    speeds: { presets: [{ name: 'Normal', multiplier: 1 }], activePreset: 0 } };
  const app = createStatusServer(createInitialState(), config, undefined as any, activity, undefined as any, new Map());
  const server = startStatusServer(app, activity, 0);
  const sockets = new Set<WebSocket>();
  try {
    await waitForListening(server);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const host = `127.0.0.1:${address.port}`;
    const origin = `http://${host}`;
    const cookie = 'fps-session=fixture-only-session-token';
    const request = (headers: Record<string, string> = {}, method = 'GET', route = '/api/status') => new Promise<number>((resolve, reject) => {
      const req = http.request(origin + route, { method, headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(await request(), 403);
    assert.equal(await request({ Cookie: 'fps-session=wrong' }), 403);
    assert.equal(await request({ Cookie: cookie, Host: 'attacker.invalid' }), 403);
    assert.equal(await request({ Cookie: cookie, Origin: 'https://attacker.invalid' }), 403);
    assert.equal(await request({ Cookie: cookie, Origin: 'null' }), 403);
    assert.equal(await request({ Cookie: cookie }), 200);
    assert.equal(await request({ Cookie: cookie }, 'POST', '/not-a-mutation'), 403);
    assert.equal(await request({ Cookie: cookie, Origin: origin }, 'POST', '/not-a-mutation'), 404);

    const connects = (headers: Record<string, string>) => new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}/ws/activity`, { headers, handshakeTimeout: 1500 });
      sockets.add(ws);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket test deadline')); }, 2000);
      const finish = (open: boolean) => { clearTimeout(timer); ws.terminate(); resolve(open); };
      ws.once('open', () => finish(true));
      ws.once('error', () => finish(false));
    });
    assert.equal(await connects({ Origin: origin }), false);
    assert.equal(await connects({ Cookie: cookie }), false);
    assert.equal(await connects({ Cookie: cookie, Origin: 'https://attacker.invalid' }), false);
    assert.equal(await connects({ Cookie: cookie, Origin: origin, Host: 'attacker.invalid' }), false);
    assert.equal(await connects({ Cookie: cookie, Origin: origin }), true);
    delete process.env.CAMCONTROL_SESSION;
    assert.equal(await request({ Cookie: 'fps-session=undefined' }), 403);
    assert.equal(await connects({ Cookie: 'fps-session=undefined', Origin: origin }), false,
      'An unconfigured desktop session must never authorize a WebSocket');
  } finally {
    for (const socket of sockets) socket.terminate();
    server.emit('shutdown'); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of [['CAMCONTROL_EMBEDDED', saved.embedded], ['CAMCONTROL_SESSION', saved.token]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
