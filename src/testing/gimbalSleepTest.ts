import assert from 'assert';
import pino from 'pino';

/**
 * Sleep gimbal (bridge 0.7.0+ "sleep"): the device sends it only when the bridge advertises it, the app shows the
 * gimbal asleep only when the gimbal says so, and sleepRefusal() blocks it while the rig is on program, tracked
 * or being driven.
 * Run: node dist/testing/gimbalSleepTest.js
 */
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sleepRefusal, DRIVEN_WITHIN_MS } = require('../app/gimbalSleep');

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
  // ---- a bridge that can sleep, then wake
  {
    const { bridge, device, state } = await rigUp({}, 'cam5');
    try {
      bridge.reportSleep = true;
      await wait(300);
      check('a bridge advertising sleep gives the device the sleep capability', device.capabilities.sleep === true && state.cameraGimbalCanSleep.cam5 === true);
      check('an awake gimbal is not shown asleep', state.cameraGimbalAsleep.cam5 === false);
      await device.sleep();
      check('device.sleep() sends exactly one sleep to the bridge', bridge.sleeps === 1);
      await wait(400);
      check('once the gimbal reports asleep the tile shows Asleep', state.cameraGimbalAsleep.cam5 === true && rigHealth(state, rig('cam5')).text === 'Asleep');
      await device.wake();
      await wait(400);
      check('wake restores it', state.cameraGimbalAsleep.cam5 === false && rigHealth(state, rig('cam5')).level === 'ready');
    } finally {
      device.close();
      await bridge.stop();
    }
  }

  // ---- an older bridge (no "sleep" capability)
  {
    const { bridge, device, state } = await rigUp({ capabilities: ['velocity', 'position', 'moveTo', 'wake'] }, 'cam4');
    try {
      check('a bridge without sleep gives no sleep capability', device.capabilities.sleep === false && !('cam4' in state.cameraGimbalCanSleep));
      let error: unknown = null;
      try { await device.sleep(); } catch (e) { error = e; }
      check('device.sleep() says to update the bridge to 0.7.0', error instanceof Error && /Update the Pi bridge to 0\.7\.0 to use Sleep/.test(error.message));
      check('nothing was sent to the older bridge', bridge.sleeps === 0);
    } finally {
      device.close();
      await bridge.stop();
    }
  }

  // ---- being driven is tracked by the device
  {
    const { bridge, device } = await rigUp({}, 'cam3');
    try {
      check('a fresh device has not been driven', device.recentlyDriven(DRIVEN_WITHIN_MS) === false);
      device.setPanTilt(0, 0);
      check('a zero velocity does not count as driving', device.recentlyDriven(DRIVEN_WITHIN_MS) === false);
      device.setPanTilt(0.4, 0);
      check('a non-zero velocity counts as driving', device.recentlyDriven(DRIVEN_WITHIN_MS) === true);
      check('driving is only recent for a while', device.recentlyDriven(DRIVEN_WITHIN_MS, Date.now() + DRIVEN_WITHIN_MS + 50) === false);
      device.stop();
    } finally {
      device.close();
      await bridge.stop();
    }
  }

  // ---- the safety refusals (pure)
  {
    const device = (driven: boolean) => ({ recentlyDriven: () => driven }) as any;
    const tracking = (sessions: any[], moving = false) => ({ manager: { getStatus: () => Object.fromEntries(sessions.map((s, i) => [`src${i}`, s])) }, ledger: { isMoving: () => moving } }) as any;
    const state = (programCamera: string) => ({ programCamera }) as any;
    check('a rig on program is refused', /PROGRAM/.test(sleepRefusal('cam4', { state: state('cam4'), device: device(false) }) ?? ''));
    check('a rig not on program, idle, untracked may sleep', sleepRefusal('cam4', { state: state('cam2'), device: device(false) }) === null);
    check('an active tracking session on the rig refuses', /tracking/.test(sleepRefusal('cam4', { state: state('cam2'), device: device(false), tracking: tracking([{ cameraId: 'cam4', sessionId: 'abc' }]) }) ?? ''));
    check('a tracking session on another rig does not', sleepRefusal('cam4', { state: state('cam2'), device: device(false), tracking: tracking([{ cameraId: 'cam1', sessionId: 'abc' }]) }) === null);
    check('a tracking source with no session does not', sleepRefusal('cam4', { state: state('cam2'), device: device(false), tracking: tracking([{ cameraId: 'cam4', sessionId: null }]) }) === null);
    check('the motion ledger saying it moves refuses', /driven/.test(sleepRefusal('cam4', { state: state('cam2'), device: device(false), tracking: tracking([], true) }) ?? ''));
    check('recent stick or preset motion refuses', /driven/.test(sleepRefusal('cam4', { state: state('cam2'), device: device(true) }) ?? ''));
    check('program wins over everything else', /PROGRAM/.test(sleepRefusal('cam4', { state: state('cam4'), device: device(true), tracking: tracking([{ cameraId: 'cam4', sessionId: 'x' }], true) }) ?? ''));
  }
  console.log(`gimbal sleep: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
