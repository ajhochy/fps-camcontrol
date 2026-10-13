import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TrackingClient } from '../tracking/trackingClient';
import { TrackingManager } from '../tracking/trackingManager';
import { TrackingSchema } from '../tracking/configSchema';
import { DjiBridgeDevice } from '../devices/djiBridgeDevice';
import { VirtualDjiBridge } from './virtualDjiBridge';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await wait(20); }
  throw new Error('Owned tracking integration timed out');
}
export async function runTrackingIntegration(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const python = process.env.TRACKING_TEST_PYTHON || path.join(root, 'dist/tracking-runtime/python/bin/python3');
  assert.ok(fs.existsSync(python), 'UNVERIFIED: actual bundled Python runtime required');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fps tracking integration '));
  const backend = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const backendOrigin = 'http://127.0.0.1:' + address.port;
  const token = randomBytes(32).toString('hex');
  const child = spawn(python, ['-I', '-B', path.join(root, 'tracker-sidecar/main.py'), '--source', 'mock', '--port', '0', '--trajectory', 'sine'], {
    cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', TRACKER_WS_TOKEN: token,
      TRACKER_FRAME_TOKEN: randomBytes(32).toString('hex'), TRACKER_BACKEND_ORIGIN: backendOrigin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let ready: { type: string; protocol: number; port: number; pid: number } | undefined, exited = false, protocolError = false, buffer = '';
  child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; }); child.stdin.on('error', () => {}); child.stderr.resume();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => {
    buffer += part;
    if (buffer.length > 4096) { protocolError = true; return; }
    const newline = buffer.indexOf('\n'); if (newline < 0) return;
    try {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (ready || Object.keys(value).sort().join(',') !== 'pid,port,protocol,type' || value.type !== 'ready' || value.protocol !== 1 || value.pid !== child.pid || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) protocolError = true;
      else ready = value;
    } catch { protocolError = true; }
  });
  const heartbeat = setInterval(() => { if (!exited) child.stdin.write('heartbeat\n'); }, 500);
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20 });
  let device: DjiBridgeDevice | undefined, client: TrackingClient | undefined, manager: TrackingManager | undefined;
  try {
    await until(() => !!ready || exited || protocolError);
    assert.ok(ready && !exited && !protocolError, 'Actual Python mock reports exact ready protocol');
    const port = await bridge.start();
    device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam4', 'Synthetic rig');
    device.connect(); await until(() => !!device?.connected && !!device?.gimbalAttached);
    client = new TrackingClient({ enabled: true, packaged: true, url: `ws://127.0.0.1:${ready.port}`, token, backendOrigin });
    const source = { sourceId: 'rig-one', device: 'rig-one', sonyCameraId: 'AA:BB', cameraId: 'cam4', invertPan: false, invertTilt: false };
    client.configure([{ sourceId: source.sourceId, frameUrl: `${backendOrigin}/api/sony/cameras/AA%3ABB/live-view/frame` }]);
    manager = new TrackingManager({ config: TrackingSchema.parse({ enabled: true }), sources: [source], devices: new Map([['cam4', device]]), client });
    manager.start(); await until(() => !!client?.connected);
    manager.select(source.sourceId, .7, .4);
    await until(() => bridge.log.filter(line => line.startsWith('moveVelocity ')).length >= 4);
    const status = manager.getStatus()[source.sourceId]; assert.equal(status.state, 'tracking'); assert.ok(status.observation && status.observation.seq > 0);
    assert.equal(client.invalidMessages, 0); assert.ok(!bridge.log.includes('safety-stop'));
    manager.operatorOverride('cam4');
    const stoppedCount = bridge.log.filter(line => line.startsWith('moveVelocity ')).length;
    await wait(250); assert.equal(bridge.log.filter(line => line.startsWith('moveVelocity ')).length, stoppedCount);
    manager.resume(source.sourceId); await until(() => bridge.log.filter(line => line.startsWith('moveVelocity ')).length > stoppedCount);
    child.kill('SIGKILL'); await until(() => exited);
    await until(() => manager?.getStatus()[source.sourceId].sessionId === null);
    await until(() => bridge.velPan === 0 && bridge.velTilt === 0);
    const afterCrash = bridge.log.filter(line => line.startsWith('moveVelocity ')).length;
    await wait(600); assert.equal(bridge.log.filter(line => line.startsWith('moveVelocity ')).length, afterCrash);
    assert.equal(manager.getStatus()[source.sourceId].state, 'sidecar_offline');
    console.log('PASS issue-29-c5: real TS to Python to virtual bridge (authenticated mock, commands, override/resume, crash stop/no replay)');
  } finally {
    manager?.stop(); client?.stop(); device?.close(); clearInterval(heartbeat);
    if (!exited) { child.stdin.end(); child.kill('SIGTERM'); try { await until(() => exited, 4000); } catch { child.kill('SIGKILL'); await until(() => exited, 2000); } }
    if (bridge.port) await bridge.stop();
    await new Promise<void>(resolve => backend.close(() => resolve()));
  }
}
if (require.main === module) runTrackingIntegration().catch(error => { console.error(error instanceof Error ? error.message : 'Tracking integration failed'); process.exitCode = 1; });
