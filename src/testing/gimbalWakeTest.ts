import assert from 'assert';
import pino from 'pino';

/**
 * Wake gimbal (bridge 0.5.0+ "wake"): the device sends it only when the bridge advertises it, and the app marks the
 * gimbal awake only when the gimbal itself says so (or moves) — an acked wake is not proof.
 * Run: node dist/testing/gimbalWakeTest.js
 */
// Stand in for ../index (which would start the whole app) so only the device and a virtual bridge run.
const indexPath = require.resolve('../index');
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { logger: pino({ level: 'silent' }) } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VirtualDjiBridge } = require('./virtualDjiBridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DjiBridgeDevice } = require('../devices/djiBridgeDevice');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createInitialState, trackDeviceLinkState } = require('../app/state');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rigHealth } = require('../app/health');

let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rig = (id: string) => ({ id, label: 'Test gimbal', protocol: 'dji-bridge' });

async function rigUp(opts: Record<string, unknown>, id: string) {
  const bridge = new VirtualDjiBridge({ statusIntervalMs: 150, ...opts });
  const port = await bridge.start();
  const device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, id, 'Test gimbal');
  const state = createInitialState({} as never);
  trackDeviceLinkState(state, id, device);
  device.connect();
  await wait(500);
  return { bridge, device, state };
}

async function main(): Promise<void> {
  // ---- a bridge that can wake
  {
    const { bridge, device, state } = await rigUp({}, 'cam5');
    try {
      check('a bridge advertising wake gives the device the wake capability', device.capabilities.wake === true);
      check('the app state records that this gimbal can be woken', state.cameraGimbalCanWake.cam5 === true);
      bridge.reportSleep = true; bridge.asleep = true;
      await wait(400);
      check('an asleep gimbal is shown Asleep', state.cameraGimbalAsleep.cam5 === true && rigHealth(state, rig('cam5')).text === 'Asleep');
      await device.wake();
      check('device.wake() sends exactly one wake to the bridge', bridge.wakes === 1);
      await wait(400);
      check('after the gimbal reports awake the app shows it awake', state.cameraGimbalAsleep.cam5 === false && device.reportedAsleep === false && rigHealth(state, rig('cam5')).level === 'ready');
    } finally {
      device.close();
      await bridge.stop();
    }
  }

  // ---- a wake that is acked but the gimbal stays asleep: the app must not fake it
  {
    const { bridge, device, state } = await rigUp({}, 'cam6');
    try {
      bridge.reportSleep = true; bridge.asleep = true; bridge.wakeWorks = false;
      await wait(400);
      await device.wake();
      await wait(500);
      check('an acked wake alone does not mark the gimbal awake', bridge.wakes === 1 && state.cameraGimbalAsleep.cam6 === true && rigHealth(state, rig('cam6')).text === 'Asleep');
    } finally {
      device.close();
      await bridge.stop();
    }
  }

  // ---- an older bridge (no "wake" capability)
  {
    const { bridge, device, state } = await rigUp({ capabilities: ['velocity', 'position', 'moveTo'] }, 'cam4');
    try {
      check('a bridge without wake gives no wake capability', device.capabilities.wake === false && !('cam4' in state.cameraGimbalCanWake));
      let error: unknown = null;
      try { await device.wake(); } catch (e) { error = e; }
      check('device.wake() refuses on a bridge without wake and says it needs updating', error instanceof Error && /update the Pi bridge/.test(error.message));
      check('nothing was sent to the older bridge', bridge.wakes === 0);
    } finally {
      device.close();
      await bridge.stop();
    }
  }
  console.log(`gimbal wake: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
