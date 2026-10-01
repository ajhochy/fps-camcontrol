import assert from 'assert';
import pino from 'pino';

/**
 * Regression: a DJI bridge client that reconnects while a socket is still open must not get stuck closing its own
 * good connections. Seen live on 2026-10-01 after the Pi rebooted: every rig re-opened its bridge once a second,
 * because the replaced socket's `close` event marked the new connection down and scheduled another reconnect.
 * Run: npx ts-node src/testing/djiReconnectTest.ts
 */
// Stand in for ../index (which would start the whole app) so only the device and a virtual bridge run.
const indexPath = require.resolve('../index');
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { logger: pino({ level: 'silent' }) } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VirtualDjiBridge } = require('./virtualDjiBridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DjiBridgeDevice } = require('../devices/djiBridgeDevice');

let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const bridge = new VirtualDjiBridge({ statusIntervalMs: 200 });
  const port = await bridge.start();
  const device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam9', 'Test gimbal');
  let disconnects = 0;
  device.on('disconnected', () => { disconnects++; });
  try {
    device.connect();
    await wait(500);
    check('the device connects', device.connected === true && bridge.sessionsOpened === 1);

    // Reconnect while the socket is open (what an overlapping reconnect does), then let it settle.
    device.connect();
    await wait(1500);
    check('a reconnect over an open socket ends with one connection, not a loop', bridge.sessionsOpened === 2);
    check('the new connection stays up', device.connected === true && device.gimbalAttached === true);
    check('the replaced socket closing does not mark the new connection down (one disconnect for the swap, no more)', disconnects === 1);

    // A real drop still reconnects.
    for (const ws of (bridge as any).connections) ws.terminate();
    await wait(800);
    check('a dropped connection still reconnects by itself', device.connected === true && bridge.sessionsOpened === 3 && disconnects === 2);
  } finally {
    device.close();
    await bridge.stop();
  }
  console.log(`dji reconnect: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
