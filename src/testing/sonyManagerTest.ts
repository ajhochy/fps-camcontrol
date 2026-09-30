import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SonyStateStore, SonyCameraApproval } from '../sony/sonyStateStore';
import { SonyManager, SonyManagerDependencies, SonyChildProcess } from '../sony/sonyManager';

/**
 * Deterministic lifecycle checks. Every timer, process, clock, and HTTP call is
 * injected, so this suite uses no real timers, child processes, or network.
 *
 * Settling is never guessed from tick counts: `manager.whenIdle()` awaits the
 * manager's own tracked background work (including real state-store file I/O).
 */

const READY_POLL = 250;
const READY_LIMIT = 15000;
const checks: string[] = [];
const criteria = new Set<string>();

function record(name: string): void {
  const criterion = name.split(':')[0];
  assert.ok(/^c(?:[1-9]|1[0-4])$/.test(criterion), `check name must start with a criterion id: ${name}`);
  assert.ok(!checks.includes(name), `duplicate check name: ${name}`);
  checks.push(name);
  criteria.add(criterion);
}
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); record(name); };
const checkEqual = (name: string, actual: unknown, expected: unknown): void => {
  assert.deepStrictEqual(actual, expected, `FAILED ${name}`); record(name);
};
const checkThrows = (name: string, action: () => unknown, matcher: RegExp): void => {
  assert.throws(action, matcher, `FAILED ${name}`); record(name);
};
const checkRejects = async (name: string, work: Promise<unknown>, matcher: RegExp | ((error: any) => boolean)): Promise<void> => {
  await assert.rejects(work, matcher as any, `FAILED ${name}`); record(name);
};

type VirtualTimer = { at: number; delay: number; action: () => void; cancelled: boolean };

/** Virtual clock: nothing here schedules a real timer, so no handle can leak. */
class Clock {
  now = 0;
  scheduled: number[] = [];
  private timers = new Set<VirtualTimer>();
  private fired = 0;

  setTimeout = (action: () => void, delay: number): unknown => {
    const timer: VirtualTimer = { at: this.now + delay, delay, action, cancelled: false };
    this.timers.add(timer);
    this.scheduled.push(delay);
    return timer;
  };
  clearTimeout = (timer: unknown): void => {
    const value = timer as VirtualTimer;
    value.cancelled = true;
    this.timers.delete(value);
  };
  pending(): number { return this.timers.size; }
  /** Scheduled delays with the 250 ms readiness poll filtered out. */
  delays(): number[] { return this.scheduled.filter((delay) => delay !== READY_POLL); }

  private due(target: number): VirtualTimer | undefined {
    let best: VirtualTimer | undefined;
    for (const timer of this.timers) if (timer.at <= target && (!best || timer.at < best.at)) best = timer;
    return best;
  }

  /** Fires due timers in order while waiting for the manager's real async work. */
  async run(manager: SonyManager, milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    let idle = false;
    let token = 0;
    const arm = (): void => {
      const mine = ++token;
      idle = false;
      void manager.whenIdle().then(() => { if (mine === token) idle = true; });
    };
    arm();
    for (let spins = 0; spins < 500; spins++) {
      await new Promise((resolve) => setImmediate(resolve));
      const timer = this.due(target);
      if (timer) {
        assert.ok(++this.fired < 5000, 'runaway virtual timers');
        this.timers.delete(timer);
        this.now = timer.at;
        timer.action();
        arm();
        spins = 0;
        continue;
      }
      if (idle) break;
    }
    this.now = target;
    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Timer-only advance for phases outside tracked background work (shutdown).
   * Those phases await promise-resolved work only, so a bounded idle spin is
   * enough to let each deadline schedule its successor.
   */
  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (let empty = 0; empty < 25;) {
      await new Promise((resolve) => setImmediate(resolve));
      const timer = this.due(target);
      if (!timer) { empty++; continue; }
      empty = 0;
      assert.ok(++this.fired < 5000, 'runaway virtual timers');
      this.timers.delete(timer);
      this.now = timer.at;
      timer.action();
    }
    this.now = target;
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const healthy = (): Response => json(200, { success: true, server: { version: '3.0.0', sdkVersion: 'V2.02.00' }, cameras: 0 });

type FakeChild = SonyChildProcess & { killed: string[]; drained: boolean; exited: boolean; exit: () => void };
const fakeChild = (): FakeChild => {
  const listeners: Record<string, Array<() => void>> = {};
  const killed: string[] = [];
  let drainedOut = false;
  let drainedError = false;
  let exited = false;
  const child: FakeChild = {
    killed,
    get drained(): boolean { return drainedOut && drainedError; },
    get exited(): boolean { return exited; },
    stdout: { resume: () => { drainedOut = true; } },
    stderr: { resume: () => { drainedError = true; } },
    on: (event: string, listener: () => void) => { (listeners[event] ??= []).push(listener); return child; },
    kill: (signal: string) => { killed.push(signal); return true; },
    exit: () => { exited = true; for (const listener of listeners.exit ?? []) listener(); },
  };
  return child;
};

interface Harness {
  manager: SonyManager;
  clock: Clock;
  calls: string[];
  timeouts: number[];
  spawns: FakeChild[];
  spawnOptions: unknown[];
  spawnArgs: string[][];
  spawnCommands: string[];
}

/** Counts persistence calls so "only explicit connect writes" is observable. */
class SpyStore extends SonyStateStore {
  approvals = 0;
  approve(approval: SonyCameraApproval): Promise<void> {
    this.approvals++;
    return super.approve(approval);
  }
}

const build = (
  config: { enabled?: boolean; apiUrl?: string; executable?: string; stateFile: string },
  upstream: (url: string, init?: RequestInit) => Promise<Response> | Response,
  extra: Partial<SonyManagerDependencies> = {},
  store?: SonyStateStore,
): Harness => {
  const clock = new Clock();
  const calls: string[] = [];
  const timeouts: number[] = [];
  const spawns: FakeChild[] = [];
  const spawnOptions: unknown[] = [];
  const spawnArgs: string[][] = [];
  const spawnCommands: string[] = [];
  const manager = new SonyManager(
    { enabled: true, apiUrl: 'http://127.0.0.1:8181', ...config },
    store ?? new SonyStateStore(config.stateFile),
    {
      fetch: async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return upstream(url, init); },
      spawn: (command, args, options) => {
        spawnCommands.push(command); spawnArgs.push(args); spawnOptions.push(options);
        const child = fakeChild(); spawns.push(child); return child;
      },
      now: () => new Date(clock.now),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      timeoutSignal: (milliseconds) => { timeouts.push(milliseconds); return new AbortController().signal; },
      ...extra,
    },
  );
  return { manager, clock, calls, timeouts, spawns, spawnOptions, spawnArgs, spawnCommands };
};

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sony-manager-'));
  const file = (name: string): string => path.join(root, name);
  const executable = file('CameraWebApp');
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  const unreadable = file('NotExecutable');
  fs.writeFileSync(unreadable, '');
  fs.chmodSync(unreadable, 0o644);

  // -- c1: disabled Sony does no work and start stays nonblocking/idempotent ---
  const off = build({ enabled: false, stateFile: file('off.json') }, () => healthy());
  off.manager.start();
  off.manager.start();
  check('c1: disabled sidecar reports the disabled state', off.manager.getStatus().sidecar.state === 'disabled');
  check('c1: disabled sidecar never probes upstream', off.calls.length === 0);
  check('c1: disabled sidecar never spawns a process', off.spawns.length === 0);
  await off.manager.whenIdle();
  check('c1: disabled sidecar schedules no timers', off.clock.pending() === 0);
  await off.manager.stop();

  const boot = build({ stateFile: file('boot.json') }, () => healthy());
  boot.manager.start();
  check('c1: start returns before any upstream probe resolves', boot.calls.length === 0 && boot.manager.getStatus().sidecar.state === 'starting');
  boot.manager.start();
  await boot.manager.whenIdle();
  check('c1: repeated start does not boot twice', boot.calls.filter((call) => call.includes('/api/server/status')).length === 1);
  await boot.manager.stop();

  // -- c2: absent sidecar stays dormant at the approved 60 s interval ----------
  const absent = build({ stateFile: file('absent.json') }, () => json(503, {}));
  absent.manager.start();
  await absent.manager.whenIdle();
  check('c2: an unhealthy sidecar without an executable is absent', absent.manager.getStatus().sidecar.state === 'absent');
  checkEqual('c2: absent mode is reported', absent.manager.getStatus().sidecar.mode, 'absent');
  checkEqual('c2: health probes use the 1.5 s timeout', absent.timeouts[0], 1500);
  await absent.clock.run(absent.manager, 59999);
  checkEqual('c2: no dormant probe before 60 s', absent.calls.length, 1);
  await absent.clock.run(absent.manager, 1);
  checkEqual('c2: the dormant probe fires at 60 s', absent.calls.length, 2);
  checkEqual('c2: the dormant interval is exactly 60 s', absent.clock.delays(), [60000, 60000]);
  await absent.manager.stop();
  checkEqual('c2: stop cancels the dormant health timer', absent.clock.pending(), 0);

  // -- c3: a healthy existing endpoint is adopted and never stopped ------------
  const external = build({ stateFile: file('external.json') }, (url) => url.endsWith('/api/cameras') ? json(200, { cameras: [] }) : healthy());
  external.manager.start();
  await external.manager.whenIdle();
  const externalStatus = external.manager.getStatus();
  checkEqual('c3: a healthy endpoint is adopted as external', externalStatus.sidecar.mode, 'external');
  check('c3: an adopted sidecar is not owned', externalStatus.sidecar.owned === false && externalStatus.sidecar.state === 'healthy');
  checkEqual('c3: the adopted sidecar version is surfaced', [externalStatus.sidecar.version, externalStatus.sidecar.sdkVersion], ['3.0.0', 'V2.02.00']);
  await external.manager.stop();
  check('c3: an adopted sidecar is never asked to shut down', !external.calls.some((call) => call.includes('/shutdown')));
  check('c3: an adopted sidecar is never spawned or signalled', external.spawns.length === 0);

  // -- c4: managed launch is constrained ---------------------------------------
  let managedProbes = 0;
  const managed = build(
    { apiUrl: 'http://127.0.0.1:9191', executable, stateFile: file('managed.json') },
    (url) => url.endsWith('/api/server/status') ? (++managedProbes === 1 ? json(503, {}) : healthy())
      : url.endsWith('/api/cameras') ? json(200, { cameras: [] }) : json(200, {}),
  );
  managed.manager.start();
  await managed.clock.run(managed.manager, READY_POLL);
  checkEqual('c4: the configured absolute executable is launched', managed.spawnCommands, [executable]);
  checkEqual('c4: launch arguments are exactly the fixed port pair', managed.spawnArgs[0], ['--port', '9191']);
  checkEqual('c4: launch options pin cwd, shell, and pipes', managed.spawnOptions[0], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  check('c4: both child pipes are drained', (managed.spawns[0] as any).drained === true);
  checkEqual('c4: a managed sidecar reports managed/owned', [managed.manager.getStatus().sidecar.mode, managed.manager.getStatus().sidecar.owned], ['managed', true]);

  managed.spawns[0].exit();
  await managed.clock.run(managed.manager, 0);
  await managed.manager.stop();
  checkEqual('c9: stop cancels a pending restart timer', managed.clock.pending(), 0);

  const remote = build({ apiUrl: 'http://10.0.0.1:8181', executable, stateFile: file('remote.json') }, () => healthy());
  checkThrows('c4: a managed launch refuses a non-loopback apiUrl', () => remote.manager.start(), /loopback/);

  const notExecutable = build({ executable: unreadable, stateFile: file('perm.json') }, () => json(503, {}));
  notExecutable.manager.start();
  await notExecutable.clock.run(notExecutable.manager, READY_LIMIT);
  check('c4: a file without the executable bit is never launched', notExecutable.spawns.length === 0);
  checkEqual('c4: an unusable executable falls back to absent', notExecutable.manager.getStatus().sidecar.state, 'absent');
  await notExecutable.manager.stop();

  const relative = build({ executable: 'CameraWebApp', stateFile: file('relative.json') }, () => json(503, {}));
  relative.manager.start();
  await relative.clock.run(relative.manager, READY_LIMIT);
  check('c4: a relative executable path is never launched', relative.spawns.length === 0);
  await relative.manager.stop();

  // -- c5: readiness failure and the bounded, resettable crash budget ----------
  const crashy = build({ executable, stateFile: file('crashy.json') }, () => json(503, {}));
  crashy.manager.start();
  await crashy.clock.run(crashy.manager, 15000);
  checkEqual('c5: readiness failure terminates the owned child', crashy.spawns[0].killed, ['SIGTERM']);
  checkEqual('c5: readiness failure does not immediately relaunch', crashy.spawns.length, 1);
  for (const delay of [1000, 2000, 4000, 8000, 15000]) {
    await crashy.clock.run(crashy.manager, delay);
    await crashy.clock.run(crashy.manager, 15000);
  }
  checkEqual('c5: restart backoff follows 1/2/4/8/15 s', crashy.clock.delays(), [1000, 2000, 4000, 8000, 15000]);
  checkEqual('c5: the crash budget caps at five restarts', crashy.spawns.length, 6);
  checkEqual('c5: an exhausted budget parks in the crashed state', crashy.manager.getStatus().sidecar.state, 'crashed');
  await crashy.clock.run(crashy.manager, 300000);
  checkEqual('c5: a crashed sidecar performs no further launches', crashy.spawns.length, 6);
  crashy.manager.retryService();
  await crashy.clock.run(crashy.manager, 0);
  checkEqual('c5: manual retry resets the budget and boots again', crashy.spawns.length, 7);
  const crashyStop = crashy.manager.stop();
  await crashy.clock.advance(6000);
  await crashyStop;
  checkEqual('c5: stopping mid-boot leaves no live timers', crashy.clock.pending(), 0);

  const jittered = build({ executable, stateFile: file('jitter.json') }, () => json(503, {}), { random: () => 1 });
  jittered.manager.start();
  await jittered.clock.run(jittered.manager, 15000);
  checkEqual('c5: restart delays carry the approved +/-20% jitter', jittered.clock.delays(), [1200]);
  await jittered.manager.stop();

  // The fake sidecar is healthy only while one of its spawned children is alive.
  let flappingChildren: FakeChild[] = [];
  const flapping = build(
    { executable, stateFile: file('flap.json') },
    (url) => url.endsWith('/api/server/status')
      ? (flappingChildren.some((child) => !child.exited) ? healthy() : json(503, {}))
      : url.endsWith('/api/cameras') ? json(200, { cameras: [] }) : json(200, {}),
  );
  flappingChildren = flapping.spawns;
  flapping.manager.start();
  await flapping.clock.run(flapping.manager, 0);
  checkEqual('c5: a ready managed sidecar becomes healthy', flapping.manager.getStatus().sidecar.state, 'healthy');
  flapping.spawns[0].exit();
  await flapping.clock.run(flapping.manager, 0);
  checkEqual('c5: an unexpected exit schedules the first restart', flapping.clock.delays(), [1000]);
  await flapping.clock.run(flapping.manager, 1000);
  flapping.spawns[1].exit();
  await flapping.clock.run(flapping.manager, 0);
  checkEqual('c5: consecutive exits escalate the backoff', flapping.clock.delays(), [1000, 2000]);
  await flapping.clock.run(flapping.manager, 2000);
  await flapping.clock.run(flapping.manager, 300000);
  flapping.spawns[2].exit();
  await flapping.clock.run(flapping.manager, 0);
  checkEqual('c5: five healthy minutes reset the crash budget', flapping.clock.delays(), [1000, 2000, 1000]);
  await flapping.manager.stop();

  // -- c6: approvals are loaded, never invented, and only explicitly persisted --
  const stateFile = file('cameras.json');
  const store = new SpyStore(stateFile);
  const discovery: any[] = [{ id: 'AA:BB', model: 'ILCE-9M3', connectionType: 'USB', connected: false }];
  const approval = build({ stateFile }, (url) =>
    url.endsWith('/api/server/status') ? healthy()
      : url.endsWith('/api/cameras') ? json(200, { cameras: discovery })
        : json(200, { camera: { id: 'AA:BB', connected: true, model: 'ILCE-9M3', connectionType: 'USB' } }),
  {}, store);
  approval.manager.start();
  await approval.manager.whenIdle();
  checkEqual('c6: an unknown camera is discovered but unapproved', approval.manager.getStatus().cameras[0].state, 'discovered_unapproved');
  check('c6: discovery never connects an unapproved camera', !approval.calls.some((call) => call.includes('/connection')));
  await checkRejects('c6: automatic connect refuses an unapproved camera', approval.manager.connect('AA:BB', true), /approved/);
  check('c6: a refused automatic connect persists nothing', (await store.load()).length === 0 && store.approvals === 0);
  await approval.manager.connect('AA:BB');
  checkEqual('c6: an explicit successful connect persists approval', (await store.load()).map((camera) => camera.id), ['AA:BB']);
  checkEqual('c6: an explicit connect writes the approval exactly once', store.approvals, 1);
  checkEqual('c6: connect uses the 30 s upstream budget', approval.timeouts[approval.timeouts.length - 1], 30000);
  checkEqual('c6: a connected camera is reported connected', approval.manager.getStatus().cameras[0].state, 'connected');
  await approval.manager.stop();

  const resumeStore = new SpyStore(stateFile);
  const resumed = build({ stateFile }, (url) =>
    url.endsWith('/api/server/status') ? healthy()
      : url.endsWith('/api/cameras') ? json(200, { cameras: discovery })
        : json(200, { data: { camera: { id: 'AA:BB', connected: true } } }),
  {}, resumeStore);
  resumed.manager.start();
  await resumed.manager.whenIdle();
  check('c6: startup loads persisted approvals', resumed.manager.getStatus().cameras[0].approved === true);
  check('c6: an approved camera reconnects automatically', resumed.calls.some((call) => call.includes('/api/cameras/AA:BB/connection')));
  check('c6: automatic reconnect never writes to the approval store', resumeStore.approvals === 0 && (await store.load()).length === 1);
  checkEqual('c6: nested connection payloads normalize to connected', resumed.manager.getStatus().cameras[0].state, 'connected');
  await resumed.manager.stop();

  // -- c7: one shared discovery scheduler, burst backoff, and forget -----------
  let offlineDiscovery: any[] = [
    { id: 'AA:BB', model: 'ILCE-9M3', connected: false },
    { id: 'CC:DD', model: 'ILCE-7M4', connected: false },
  ];
  const burstFile = file('burst.json');
  const burstStore = new SonyStateStore(burstFile);
  await burstStore.approve({ id: 'AA:BB' });
  await burstStore.approve({ id: 'CC:DD' });
  const burst = build({ stateFile: burstFile }, (url) =>
    url.endsWith('/api/server/status') ? healthy()
      : url.endsWith('/api/cameras') ? json(200, { cameras: offlineDiscovery })
        : json(503, {}));
  burst.manager.start();
  await burst.manager.whenIdle();
  checkEqual('c7: two pending cameras share one discovery timer', burst.clock.pending(), 1);
  check('c7: a pending camera exposes its next retry time', typeof burst.manager.getStatus().cameras[0].nextRetryAt === 'string');
  for (const delay of [2000, 5000, 10000, 20000, 30000, 60000]) await burst.clock.run(burst.manager, delay);
  checkEqual('c7: discovery bursts at 2/5/10/20/30 s then 60 s', burst.clock.delays(), [2000, 5000, 10000, 20000, 30000, 60000, 60000]);
  const beforeReappearance = burst.clock.delays().length;
  offlineDiscovery = [];
  await burst.clock.run(burst.manager, 60000);
  checkEqual('c7: a camera missing from discovery is marked disconnected', burst.manager.getStatus().cameras[0].state, 'disconnected');
  offlineDiscovery = [{ id: 'AA:BB', model: 'ILCE-9M3', connected: false }];
  await burst.clock.run(burst.manager, 60000);
  checkEqual('c7: reappearance restarts a fresh burst', burst.clock.delays()[beforeReappearance + 1], 2000);
  const beforeForget = burst.calls.length;
  await burst.manager.forget('AA:BB');
  checkEqual('c7: forget removes the persisted approval', (await burstStore.load()).map((camera) => camera.id), ['CC:DD']);
  checkEqual('c7: the shared timer survives for other approved cameras', burst.clock.pending(), 1);
  await burst.manager.forget('CC:DD');
  checkEqual('c7: forgetting the last approved camera cancels discovery', burst.clock.pending(), 0);
  await burst.clock.run(burst.manager, 300000);
  checkEqual('c7: forget stops all future automatic work', burst.calls.length, beforeForget);
  check('c7: a forgotten camera stays visible but unapproved', burst.manager.getStatus().cameras[0].approved === false);
  const beforeRediscovery = burst.calls.filter((call) => call.includes('/connection')).length;
  await burst.manager.discover();
  await burst.manager.whenIdle();
  check('c7: a later discovery never revives a forgotten approval',
    burst.calls.filter((call) => call.includes('/connection')).length === beforeRediscovery
    && burst.manager.getStatus().cameras.every((camera) => camera.approved === false));
  await burst.manager.stop();

  // -- c8: one lane per camera, coalesced reads, typed backpressure ------------
  let releaseConnect!: () => void;
  const heldConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let propertyReads = 0;
  const lanes = build({ stateFile: file('lanes.json') }, async (url) => {
    if (url.endsWith('/api/server/status')) return healthy();
    if (url.endsWith('/api/cameras')) return json(200, { cameras: [] });
    if (url.includes('/connection')) { await heldConnect; return json(200, { camera: { connected: true } }); }
    if (url.includes('/properties/all')) { propertyReads++; await heldRead; return json(200, { properties: { iso: 100 } }); }
    return json(200, {});
  });
  lanes.manager.start();
  await lanes.manager.whenIdle();
  const connecting = lanes.manager.connect('AA:BB');
  await new Promise((resolve) => setImmediate(resolve));
  await checkRejects('c8: a read against a busy lane is retryable backpressure', lanes.manager.properties('AA:BB'), (error: any) => error.statusCode === 503 && error.retryAfter === 1);
  await checkRejects('c8: a second write against a busy lane is refused', lanes.manager.touch('AA:BB', { x: 0.5, y: 0.5 }), (error: any) => error.statusCode === 503);
  releaseConnect();
  await connecting;
  const firstRead = lanes.manager.properties('AA:BB');
  const secondRead = lanes.manager.properties('AA:BB');
  releaseRead();
  const [firstBody, secondBody] = await Promise.all([firstRead, secondRead]);
  checkEqual('c8: concurrent identical reads issue one upstream request', propertyReads, 1);
  check('c8: coalesced readers observe the same response', firstBody === secondBody);
  await lanes.manager.properties('AA:BB');
  checkEqual('c8: a settled lane accepts the next read', propertyReads, 2);
  checkEqual('c8: reads use the 5 s upstream budget', lanes.timeouts[lanes.timeouts.length - 1], 5000);
  await lanes.manager.stop();

  // -- c9: stop shuts down only owned children, on the approved deadlines ------
  let stubbornChildren: FakeChild[] = [];
  const stubborn = build(
    { executable, stateFile: file('stop.json') },
    (url) => url.endsWith('/api/server/status')
      ? (stubbornChildren.some((child) => !child.exited) ? healthy() : json(503, {}))
      : url.endsWith('/api/cameras') ? json(200, { cameras: [] }) : json(200, {}),
  );
  stubbornChildren = stubborn.spawns;
  stubborn.manager.start();
  await stubborn.clock.run(stubborn.manager, 0);
  const stopping = stubborn.manager.stop();
  await stubborn.clock.advance(0);
  check('c9: stop requests graceful sidecar shutdown', stubborn.calls.some((call) => call === `POST http://127.0.0.1:8181/api/server/shutdown`));
  checkEqual('c9: the shutdown request uses the 2 s budget', stubborn.timeouts[stubborn.timeouts.length - 1], 2000);
  checkEqual('c9: no signal is sent before the graceful wait elapses', stubborn.spawns[0].killed, []);
  await stubborn.clock.advance(3000);
  checkEqual('c9: SIGTERM follows the 3 s graceful wait', stubborn.spawns[0].killed, ['SIGTERM']);
  await stubborn.clock.advance(2000);
  checkEqual('c9: SIGKILL follows a further 2 s', stubborn.spawns[0].killed, ['SIGTERM', 'SIGKILL']);
  await stopping;
  await stubborn.manager.stop();
  checkEqual('c9: repeated stop makes no second shutdown request', stubborn.calls.filter((call) => call.includes('/shutdown')).length, 1);
  checkEqual('c9: stop leaves no live timers', stubborn.clock.pending(), 0);

  let obedientChildren: FakeChild[] = [];
  const obedient = build(
    { executable, stateFile: file('stop-ok.json') },
    (url) => url.endsWith('/api/server/status')
      ? (obedientChildren.some((child) => !child.exited) ? healthy() : json(503, {}))
      : url.endsWith('/api/cameras') ? json(200, { cameras: [] }) : json(200, {}),
  );
  obedientChildren = obedient.spawns;
  obedient.manager.start();
  await obedient.clock.run(obedient.manager, 0);
  const obedientStop = obedient.manager.stop();
  obedient.spawns[0].exit();
  await obedientStop;
  checkEqual('c9: a child that exits gracefully is never signalled', obedient.spawns[0].killed, []);
  checkEqual('c9: a graceful exit during stop triggers no restart', obedient.spawns.length, 1);

  // -- c10: safe identifiers and the proven upstream paths ---------------------
  const paths = build({ stateFile: file('paths.json') }, (url) =>
    url.endsWith('/api/server/status') ? healthy()
      : url.endsWith('/api/cameras') ? json(200, { cameras: [] })
        : url.includes('/live-view/frame') ? new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
          : json(200, { ok: true }));
  paths.manager.start();
  await paths.manager.whenIdle();
  checkEqual('c10: camera paths keep literal colons after encoding', paths.manager.cameraPath('AA:BB'), '/api/cameras/AA:BB');
  checkThrows('c10: unsafe camera identifiers are rejected', () => paths.manager.cameraPath('../etc/passwd'), /safe identifier/);
  checkThrows('c10: path traversal in an identifier is rejected', () => paths.manager.cameraPath('AA%2FBB'), /safe identifier/);
  await paths.manager.properties('AA:BB');
  check('c10: property reads use /properties/all', paths.calls.includes('GET http://127.0.0.1:8181/api/cameras/AA:BB/properties/all'));
  await paths.manager.property('AA:BB', 'iso', { method: 'PUT', body: JSON.stringify({ value: 100 }) });
  check('c10: named property writes use /properties/{name}', paths.calls.includes('PUT http://127.0.0.1:8181/api/cameras/AA:BB/properties/iso'));
  await checkRejects('c10: unsafe property names are rejected', Promise.resolve().then(() => paths.manager.property('AA:BB', '../secret')), /safe identifier/);
  await paths.manager.liveViewStart('AA:BB');
  check('c10: live view starts at /live-view/start', paths.calls.includes('POST http://127.0.0.1:8181/api/cameras/AA:BB/live-view/start'));
  const frame = await paths.manager.liveViewFrame('AA:BB');
  check('c10: live frames read /live-view/frame', paths.calls.includes('GET http://127.0.0.1:8181/api/cameras/AA:BB/live-view/frame'));
  check('c10: live frames stay binary', Buffer.isBuffer(frame.body) && frame.body.length === 3 && frame.contentType === 'image/jpeg');
  checkEqual('c10: live frames use the 3 s budget', paths.timeouts[paths.timeouts.length - 1], 3000);
  await paths.manager.touch('AA:BB', { x: 0.5, y: 0.25 });
  check('c10: touch actions use /actions/touch', paths.calls.includes('POST http://127.0.0.1:8181/api/cameras/AA:BB/actions/touch'));
  checkThrows('c10: unnormalized touch coordinates are rejected', () => paths.manager.touch('AA:BB', { x: 2, y: 0 }), /normalized/);
  await paths.manager.stop();

  // -- c11: pairing only from an exact injected allowlist ----------------------
  const pairing = build({ stateFile: file('pair.json') }, () => healthy(), { pairingCodes: [8449] });
  checkEqual('c11: an exact injected code classifies as pairing', pairing.manager.classifyConnectionFailure({ statusCode: 400, errorCode: 8449 }), 'needs_pairing');
  checkEqual('c11: a string code is not pairing', pairing.manager.classifyConnectionFailure({ statusCode: 400, errorCode: '8449' }), 'error');
  checkEqual('c11: an unlisted code is not pairing', pairing.manager.classifyConnectionFailure({ statusCode: 400, errorCode: 8450 }), 'error');
  checkEqual('c11: a refused connection is an ordinary outage', pairing.manager.classifyConnectionFailure(new Error('ECONNREFUSED')), 'disconnected');
  checkEqual('c11: a 503 sidecar outage is not pairing', pairing.manager.classifyConnectionFailure({ statusCode: 503 }), 'disconnected');
  const noAllowlist = build({ stateFile: file('nopair.json') }, () => healthy());
  checkEqual('c11: the default allowlist is empty', noAllowlist.manager.classifyConnectionFailure({ statusCode: 400, errorCode: 8449 }), 'error');

  // -- c12: curated status with no secrets or executable paths -----------------
  const secret = 'fingerprint de:ad:be:ef token=hunter2 at /opt/sony/CameraWebApp';
  let leakyChildren: FakeChild[] = [];
  const leaky = build({ apiUrl: 'http://127.0.0.1:9292', executable, stateFile: file('leak.json') }, (url) =>
    url.endsWith('/api/server/status')
      ? (leakyChildren.some((child) => !child.exited) ? healthy() : json(503, {}))
      : url.endsWith('/api/cameras') ? json(200, { cameras: [{ id: 'AA:BB', connected: false }] })
        : json(500, { error: secret, password: 'hunter2', data: { error_code: 8449, detail: secret } }));
  leakyChildren = leaky.spawns;
  leaky.manager.start();
  await leaky.clock.run(leaky.manager, 0);
  await assert.rejects(leaky.manager.connect('AA:BB'));
  const leakyStatus = JSON.stringify(leaky.manager.getStatus());
  check('c12: status omits the sidecar executable path', !leakyStatus.includes('CameraWebApp') && !leakyStatus.includes(executable));
  check('c12: status omits credentials and fingerprints', !/hunter2|fingerprint|de:ad:be:ef|password|token/i.test(leakyStatus));
  checkEqual('c12: a failed connect surfaces a curated message', leaky.manager.getStatus().cameras[0].message, 'Camera connection failed');
  check('c12: raw upstream bodies never reach status', !leakyStatus.includes(secret));
  check('c12: child output is never retained in status', !leakyStatus.includes('stdout') && !leakyStatus.includes('stderr'));
  const leakyStop = leaky.manager.stop();
  await leaky.clock.advance(6000);
  await leakyStop;
  checkEqual('c12: a curated shutdown leaves no live timers', leaky.clock.pending(), 0);

  // -- c13: a powered-off camera stops showing as connected --------------------
  const camA = 'AA:BB:CC:DD:EE:01';
  const camB = 'AA:BB:CC:DD:EE:02';
  const powered = new Set<string>([camA, camB]);
  const linked = new Set<string>();
  const linkUpstream = (url: string, init?: RequestInit): Response => {
    if (url.endsWith('/api/server/status')) return healthy();
    if (url.endsWith('/api/cameras')) {
      return json(200, { cameras: [camA, camB].filter((id) => powered.has(id)).map((id) => ({ id, model: 'ILCE-7SM3', connectionType: 'Network', connected: linked.has(id) })) });
    }
    const connection = url.match(/\/api\/cameras\/([^/]+)\/connection$/);
    if (connection) {
      const id = decodeURIComponent(connection[1]);
      if (init?.method === 'POST') { linked.add(id); return json(200, { success: true, camera: { connected: true, model: 'ILCE-7SM3', id } }); }
      return json(200, { success: true, camera: { connected: linked.has(id) && powered.has(id), model: '', id } });
    }
    return json(200, {});
  };
  const link = build({ stateFile: file('link.json') }, linkUpstream);
  link.manager.start();
  await link.manager.whenIdle();
  await link.manager.connect(camA, false);
  await link.manager.whenIdle();
  const stateOf = (id: string): string | undefined => link.manager.getStatus().cameras.find((camera) => camera.id === id)?.state;
  checkEqual('c13: an explicitly connected camera shows connected', stateOf(camA), 'connected');
  await link.clock.run(link.manager, 5000);
  check('c13: the link of a connected camera is re-checked every 5 s', link.calls.filter((call) => call === `GET http://127.0.0.1:8181/api/cameras/${camA}/connection`).length >= 1);
  checkEqual('c13: a camera that still answers stays connected', stateOf(camA), 'connected');
  check('c13: link checks use a short 2 s timeout', link.timeouts.includes(2000));
  powered.delete(camA);
  await link.clock.run(link.manager, 5000);
  checkEqual('c13: a camera that powers off stops showing connected', stateOf(camA), 'disconnected');
  checkEqual('c13: the lost link is explained to the operator', link.manager.getStatus().cameras.find((camera) => camera.id === camA)?.message, 'Camera stopped responding');
  linked.delete(camA);
  powered.add(camA);
  await link.clock.run(link.manager, 30000);
  checkEqual('c13: an approved camera reconnects by itself after power returns', stateOf(camA), 'connected');
  const afterReconnect = link.calls.length;
  await link.manager.stop();
  checkEqual('c13: stop cancels the link check timer', link.clock.pending(), 0);
  await link.clock.advance(20000);
  checkEqual('c13: no link checks run after stop', link.calls.length, afterReconnect);

  // -- c14: cameras are linked to the gimbal they are mounted on ---------------
  const gimbal = build({ stateFile: file('gimbal.json') }, linkUpstream);
  linked.clear(); powered.add(camA); powered.add(camB);
  gimbal.manager.start();
  await gimbal.manager.whenIdle();
  await gimbal.manager.connect(camA, false);
  await gimbal.manager.connect(camB, false);
  await gimbal.manager.whenIdle();
  const gimbalOf = (id: string): string | null | undefined => gimbal.manager.getStatus().cameras.find((camera) => camera.id === id)?.gimbalDevice;
  checkEqual('c14: a new camera has no gimbal link', gimbalOf(camA), null);
  await gimbal.manager.setGimbalLink(camA, 'rs3');
  checkEqual('c14: an approved camera can be linked to a gimbal', gimbalOf(camA), 'rs3');
  check('c14: the link is saved to the approval file', (await new SonyStateStore(file('gimbal.json')).load()).find((camera) => camera.id === camA)?.gimbalDevice === 'rs3');
  await gimbal.manager.setGimbalLink(camB, 'rs3');
  checkEqual('c14: a gimbal carries one camera, so linking it again moves it', [gimbalOf(camA), gimbalOf(camB)], [null, 'rs3']);
  await gimbal.manager.setGimbalLink(camB, null);
  checkEqual('c14: a link can be cleared', gimbalOf(camB), null);
  await gimbal.manager.setGimbalLink(camA, 'rs3pro-a');
  await gimbal.manager.connect(camA, false);
  checkEqual('c14: reconnecting a camera keeps its gimbal link', gimbalOf(camA), 'rs3pro-a');
  await checkRejects('c14: an unsafe gimbal key is refused', gimbal.manager.setGimbalLink(camA, '../etc'), /safe identifier/);
  await checkRejects('c14: an unapproved camera cannot be linked', gimbal.manager.setGimbalLink('AA:BB:CC:DD:EE:99', 'rs3'), /approved/);
  checkEqual('c14: a refused link leaves the existing link alone', gimbalOf(camA), 'rs3pro-a');
  await gimbal.manager.forget(camA);
  checkEqual('c14: forgetting a camera clears its gimbal link', (await new SonyStateStore(file('gimbal.json')).load()).find((camera) => camera.id === camA)?.gimbalDevice, undefined);
  await gimbal.manager.stop();

  const covered = [...criteria].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.strictEqual(covered.length, 14, `every criterion needs a check; covered: ${covered.join(',')}`);
  assert.strictEqual(new Set(checks).size, checks.length, 'check names must be unique');
  console.log(`sony manager: ${checks.length} checks passed across ${covered.length} criteria (${covered.join(' ')})`);
}

let completed = false;
// A stalled await drains the event loop and would otherwise exit 0 in silence.
process.on('exit', (code) => {
  if (completed || code !== 0) return;
  console.error(`sony manager: test exited before completing; last check: ${checks[checks.length - 1] ?? '(none)'}`);
  process.exitCode = 1;
});
main().then(() => { completed = true; }).catch((error) => { console.error(error); process.exitCode = 1; });
