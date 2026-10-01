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

  // ---- a linked gimbal that ignores moves (asleep) is noticed from the operator's own stick input
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createInitialState, trackDeviceLinkState } = require('../app/state');
  const sleepy = new VirtualDjiBridge({ statusIntervalMs: 200 });
  const sleepyPort = await sleepy.start();
  const gimbal = new DjiBridgeDevice({ host: '127.0.0.1', port: sleepyPort, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam8', 'Sleepy gimbal');
  const state = createInitialState({} as never);
  trackDeviceLinkState(state, 'cam8', gimbal);
  const push = async (pan: number, ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { gimbal.setPanTilt(pan, 0); await wait(100); }
    gimbal.stop();
  };
  try {
    gimbal.connect();
    await wait(500);
    check('an awake gimbal starts out counted as responding', gimbal.motionResponsive === true && state.cameraConnected.cam8 === true && !('cam8' in state.cameraGimbalResponding));
    sleepy.asleep = true;
    await push(0.05, 3500);
    check('a push too gentle to judge never marks it as not moving', gimbal.motionResponsive === true);
    await push(0.5, 3500);
    check('pushing an asleep gimbal for over 2.5 s marks it as not moving', gimbal.motionResponsive === false);
    check('the app then shows it as not connected and says why', state.cameraConnected.cam8 === false && state.cameraGimbalResponding.cam8 === false && state.cameraGimbalAttached.cam8 === true);
    sleepy.asleep = false;
    await push(0.5, 1500);
    check('once it moves again it is responding and connected', gimbal.motionResponsive === true && state.cameraConnected.cam8 === true && !('cam8' in state.cameraGimbalResponding));
    sleepy.asleep = true;
    await push(0.5, 1200);
    check('a short push is not long enough to judge', gimbal.motionResponsive === true);
  } finally {
    gimbal.close();
    await sleepy.stop();
  }
  // ---- Bluetooth signal: rated from what the bridge reports, shown instead of failing silently
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rateGimbalSignal } = require('../app/state');
  check('a clean link rates good', rateGimbalSignal({ drops10m: 0, framesLastMin: 60, corruptLastMin: 0, linkedForS: 10 }).rating === 'good');
  check('a single recovered drop is not a weak signal (e.g. a link released by hand)', (() => { const r = rateGimbalSignal({ drops10m: 1, framesLastMin: 60, corruptLastMin: 0, linkedForS: 10 }); return r.rating === 'good' && /recovered from 1 drop/.test(r.summary); })());
  check('two drops in 10 minutes rates weak and says so', (() => { const r = rateGimbalSignal({ drops10m: 2, framesLastMin: 60, corruptLastMin: 0, linkedForS: 10 }); return r.rating === 'weak' && /2 Bluetooth drops in 10 min/.test(r.summary); })());
  check('2% corrupt data rates weak', rateGimbalSignal({ drops10m: 0, framesLastMin: 100, corruptLastMin: 2, linkedForS: 10 }).rating === 'weak');
  check('four drops or 5% corrupt rates poor', rateGimbalSignal({ drops10m: 4, framesLastMin: 60, corruptLastMin: 0, linkedForS: 10 }).rating === 'poor' && rateGimbalSignal({ drops10m: 0, framesLastMin: 100, corruptLastMin: 6, linkedForS: 10 }).rating === 'poor');
  check('too few frames to judge corruption by is not called weak', rateGimbalSignal({ drops10m: 0, framesLastMin: 5, corruptLastMin: 2, linkedForS: 10 }).rating === 'good');
  check('an older bridge that reports nothing gets no rating', rateGimbalSignal(undefined) === null);

  const noisy = new VirtualDjiBridge({ statusIntervalMs: 150 });
  const noisyPort = await noisy.start();
  const g2 = new DjiBridgeDevice({ host: '127.0.0.1', port: noisyPort, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam7', 'Noisy gimbal');
  const s2 = createInitialState({} as never);
  trackDeviceLinkState(s2, 'cam7', g2);
  try {
    g2.connect();
    await wait(600);
    check('a healthy link is reported as good', s2.cameraGimbalSignal.cam7?.rating === 'good');
    noisy.link = { drops10m: 2, framesLastMin: 80, corruptLastMin: 3, linkedForS: 40 };
    await wait(500);
    check('the app picks up a weakening link from the bridge at once', s2.cameraGimbalSignal.cam7?.rating === 'weak' && /2 Bluetooth drops in 10 min/.test(s2.cameraGimbalSignal.cam7.summary) && /3\.8% of data arriving corrupt/.test(s2.cameraGimbalSignal.cam7.summary));
    noisy.link = { drops10m: 0, framesLastMin: 80, corruptLastMin: 0, linkedForS: 400 };
    await wait(500);
    check('and clears it when the link recovers', s2.cameraGimbalSignal.cam7?.rating === 'good');
    noisy.link = null;
    await wait(500);
    check('a bridge that stops reporting it leaves no stale rating', !('cam7' in s2.cameraGimbalSignal));
  } finally {
    g2.close();
    await noisy.stop();
  }
  console.log(`dji reconnect: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
