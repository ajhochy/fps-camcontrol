import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { VirtualVisca } from './virtualVisca';
import { ViscaDevice } from '../devices/viscaDevice';
import type { ViscaClient } from '../visca/viscaClient';
import { TrackingManager, TrackingError, TrackingPeer } from '../tracking/trackingManager';
import { TrackingSchema, collectTrackingIssues } from '../tracking/configSchema';
import { MotionLedger } from '../tracking/motionLedger';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { ViscaTrackingDriver, quantizeViscaVelocity, VISCA_DEADMAN_MS, VISCA_MIN_COMMAND } from '../tracking/viscaTrackingDriver';
import { registerTracking, unregisterTracking } from '../app/trackingHooks';
import { createInitialState } from '../app/state';
import { emergencyStopAll } from '../safety/emergencyStop';
import { ControlStateMachine } from '../model/controlStateMachine';
import type { AppConfig } from '../config/configLoader';
import type { AtemClient } from '../atem/atemClient';
import type { MotionDevice } from '../devices/motionDevice';

/** VISCA click-to-track: app-side dead-man, explicit stops on every end path, speed mapping, derivation, readiness, operator override. */
let passed = 0;
const check = (name: string, condition: unknown): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const STOP_PT = 'send([129,1,6,1,0,0,3,3,255])';
const isMove = (line: string): boolean => /^send\(\[129,1,6,1,(?!0,0,3,3)/.test(line);
const parseMove = (line: string) => { const n = line.replace(/[^0-9,]/g, '').split(',').map(Number); return { pan: n[4], tilt: n[5], panDir: n[6], tiltDir: n[7] }; };

/** Deterministic clock and timers: advance() runs every due interval in order, in 10 ms steps. */
class Scheduler {
  now = 1_000_000;
  timers: Array<{ id: number; fn: () => void; ms: number; next: number; paused: boolean; cleared: boolean }> = [];
  setInterval = (fn: () => void, ms: number): unknown => { const t = { id: this.timers.length, fn, ms, next: this.now + ms, paused: false, cleared: false }; this.timers.push(t); return t; };
  clearInterval = (handle: unknown): void => { (handle as { cleared: boolean }).cleared = true; };
  advance(total: number): void {
    for (let left = total; left > 0; left -= 10) {
      this.now += Math.min(10, left);
      for (const t of this.timers) if (!t.cleared && !t.paused && this.now >= t.next) { t.next += t.ms; t.fn(); }
    }
  }
}
class FakePeer extends EventEmitter implements TrackingPeer {
  connected = true; selects = 0; cancels = 0;
  start(): void {} stop(): void {}
  select(): boolean { this.selects++; return true; }
  cancel(): boolean { this.cancels++; return true; }
}

function harness(overrides: Record<string, unknown> = {}, answering: { value: boolean } = { value: true }) {
  const clock = new Scheduler();
  const vv = new VirtualVisca();
  const timed: Array<{ t: number; line: string }> = [];
  const raw = vv.sendPayload.bind(vv);
  vv.sendPayload = (payload: number[]) => { raw(payload); timed.push({ t: clock.now, line: vv.log[vv.log.length - 1] }); };
  const device = new ViscaDevice(vv as unknown as ViscaClient, 'cam1', 'V-BOT');
  const peer = new FakePeer();
  const ledger = new MotionLedger();
  const source = { sourceId: 'vbot', device: 'vbot', sonyCameraId: 'AA:BB', cameraId: 'cam1', invertPan: false, invertTilt: false };
  const manager = new TrackingManager({ config: TrackingSchema.parse({ enabled: true, ...overrides }), sources: [source], devices: new Map<string, MotionDevice>([['cam1', device]]), client: peer, ledger,
    now: () => clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, viscaAnswering: () => answering.value });
  manager.start();
  let seq = 0;
  const feed = (cx = .8, cy = .5, state: 'tracking' | 'lost' | 'locking' = 'tracking') => {
    const status = manager.getStatus().vbot;
    peer.emit('track', { protocol: 1, type: 'track', sourceId: 'vbot', sessionId: status.sessionId, seq: ++seq, state, cx: state === 'lost' ? 0 : cx, cy: state === 'lost' ? 0 : cy,
      w: state === 'lost' ? 0 : .1, h: state === 'lost' ? 0 : .2, conf: state === 'lost' ? 0 : 1, frameTs: clock.now, processedAt: clock.now });
  };
  const stops = () => timed.filter(x => x.line === STOP_PT);
  const moves = () => timed.filter(x => isMove(x.line));
  /** Selects a target and runs until the head is moving, with fresh observations arriving every 100 ms. */
  const driveUntilMoving = () => {
    manager.select('vbot', .5, .5);
    feed(); clock.advance(100); feed(); clock.advance(100); feed(); clock.advance(60);
    check('head is being driven', moves().length > 0);
  };
  return { clock, vv, device, peer, ledger, manager, feed, stops, moves, timed, source, driveUntilMoving, answering };
}

// ---- speed mapping and deadzone
{
  const q = quantizeViscaVelocity;
  check('full-scale request is capped to the VISCA cap (0.3 -> pan 7, tilt 6)', q(1, 1, 0.3).key === '7:6' && q(-1, -1, 0.3).key === '-7:-6');
  check('uncapped full scale reaches the VISCA ranges (pan 24, tilt 20)', q(1, -1).key === '24:-20');
  check('a tiny command is a stop, not a speed-1 creep', q(VISCA_MIN_COMMAND - 0.001, -0.02).key === '0:0' && q(0.02, 0).pan === 0);
  check('the smallest allowed command is the slowest step', q(VISCA_MIN_COMMAND, 0).key === '1:0');
  check('non-finite input is a stop', q(NaN, Infinity).key === '0:0');
  check('axes are zeroed independently', q(0.2, 0.01, 0.3).key === '5:0' && q(0.2, 0.01, 0.3).tilt === 0);
  check('viscaMaxSpeed defaults conservative', TrackingSchema.parse({}).viscaMaxSpeed === 0.3);
  check('viscaMaxSpeed is bounded', !TrackingSchema.safeParse({ viscaMaxSpeed: 0 }).success && !TrackingSchema.safeParse({ viscaMaxSpeed: 1.1 }).success);
}

// ---- driver in isolation: dedupe, keepalive, deadzone, dead-man
{
  const clock = new Scheduler();
  const vv = new VirtualVisca();
  const device = new ViscaDevice(vv as unknown as ViscaClient, 'cam1', 'V-BOT');
  const ledger = new MotionLedger();
  let deadman = 0;
  const driver = new ViscaTrackingDriver(device, ledger, { now: () => clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval }, 0.3, () => deadman++);
  for (let i = 0; i < 20; i++) { driver.drive(0.2, 0, clock.now); clock.advance(50); }
  const sent = vv.log.filter(isMove).length;
  check('an unchanged command is sent once then only as a ~200 ms keepalive (not 20 times)', sent >= 5 && sent <= 6);
  vv.log.length = 0;
  driver.drive(0.01, 0.01, clock.now);
  check('a sub-minimum command while moving sends an explicit stop', vv.log.includes(STOP_PT) && !driver.moving);
  vv.log.length = 0;
  driver.drive(0.03, 0, clock.now); driver.drive(0, 0.04, clock.now);
  check('a sub-minimum command while idle sends nothing', vv.log.filter(l => !l.includes('inquire')).length === 0 && !driver.moving);
  clock.advance(400);
  check('the stop repeat timer cleans up after itself', clock.timers.every(t => t.cleared));
  // dead-man in isolation: nobody calls drive() again
  vv.log.length = 0;
  driver.drive(0.2, 0, clock.now);
  const startedAt = clock.now;
  clock.advance(VISCA_DEADMAN_MS - 20);
  check('no dead-man stop before the gap elapses', !vv.log.includes(STOP_PT) && deadman === 0);
  clock.advance(100);
  check('the dead-man stops the head once the gap exceeds ~300 ms, with no tracking loop involved', vv.log.includes(STOP_PT) && deadman === 1 && !driver.moving && clock.now - startedAt < 450);
  clock.advance(600);
  check('the dead-man timer does not keep firing', deadman === 1);
}

// ---- tracking drives the head; the mapping honours the cap
{
  const h = harness();
  h.driveUntilMoving();
  const first = parseMove(h.moves()[0].line);
  check('a target to the right pans right, tilt held', first.panDir === 2 && first.tiltDir === 3 && first.pan >= 1 && first.pan <= 7);
  h.feed(.95, .15); h.clock.advance(300); h.feed(.95, .15); h.clock.advance(300);
  const parsed = h.moves().map(m => parseMove(m.line));
  check('speeds never exceed the VISCA cap (pan <= 7, tilt <= 6 at 0.3)', parsed.every(m => m.pan <= 7 && m.tilt <= 6));
  check('a target above and right pans right and tilts up (VISCA up=1)', parsed.some(m => m.panDir === 2 && m.tiltDir === 1));
  check('sends are rate limited (<= ~10/s)', h.moves().length < 14);
  check('no zoom stop was ever sent during tracking motion', !h.timed.some(x => x.line.startsWith('send([129,1,4,7')));
}
{
  const h = harness({ maxSpeed: 0.1 });
  h.manager.select('vbot', .5, .5); h.feed(.95, .5); h.clock.advance(200); h.feed(.95, .5); h.clock.advance(200);
  check('maxSpeed below viscaMaxSpeed wins (0.1 -> pan <= 2)', h.moves().length > 0 && h.moves().every(m => parseMove(m.line).pan <= 2));
}

// ---- dead-man through the manager: a stalled tracking loop still stops the head
{
  const h = harness();
  h.driveUntilMoving();
  const events: unknown[] = [];
  h.manager.on('deadman', e => events.push(e));
  h.clock.timers[0].paused = true; // freeze the manager's own 50 ms tick, as a stalled loop would
  const lastMove = h.timed[h.timed.length - 1].t;
  h.vv.log.length = 0; h.timed.length = 0;
  h.clock.advance(250);
  check('the head is not stopped while the gap is under 300 ms', h.stops().length === 0);
  h.clock.advance(120);
  const stop = h.stops()[0];
  check('a stalled loop: an explicit stop goes out after the >300 ms gap', !!stop && events.length === 1);
  check('the stop is pan/tilt only (zoom is left alone)', !h.timed.some(x => x.line.startsWith('send([129,1,4,7')));
  check('the stop landed within ~350 ms of the last fresh command', !!stop && stop.t - lastMove <= 400);
  h.clock.advance(400);
  check('the head gets exactly one repeat stop, then silence', h.stops().length === 2);
  check('status shows zero velocity', h.manager.getStatus().vbot.pan === 0);
}

// ---- stale video, lost target and idle observation stop the head
{
  const h = harness();
  h.driveUntilMoving(); h.vv.log.length = 0; h.timed.length = 0;
  h.clock.advance(520); // no new observation: video older than 500 ms
  check('stale video stops the head', h.stops().length >= 1 && h.manager.getStatus().vbot.state === 'stale');
}
{
  const h = harness();
  h.driveUntilMoving(); h.vv.log.length = 0; h.timed.length = 0;
  h.feed(0, 0, 'lost');
  check('target lost stops the head immediately', h.stops().length === 1 && h.manager.getStatus().vbot.state === 'holding');
  h.clock.advance(3100);
  check('after the hold the target is cleared and nothing moves', h.manager.getStatus().vbot.sessionId === null && h.moves().length === 0);
}

// ---- every end path sends a stop to the head
const endPaths: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
  ['cancel', h => h.manager.cancel('vbot')],
  ['operator override (stick moved)', h => h.manager.operatorOverride('cam1')],
  ['profile / source change (invalidateAll)', h => h.manager.invalidateAll('binding_changed')],
  ['device reconnect (invalidateCamera)', h => h.manager.invalidateCamera('cam1', 'device_reconnect')],
  ['helper disconnect event', h => { h.peer.connected = false; h.peer.emit('disconnected'); }],
  ['helper offline seen by the loop', h => { h.peer.connected = false; h.clock.advance(60); }],
  ['app shutdown (manager.stop)', h => h.manager.stop()],
  ['reconcile (profile edit)', h => h.manager.reconcile(TrackingSchema.parse({ enabled: true }), [], new Map())],
  ['head stops answering', (h) => { h.answering.value = false; h.clock.advance(60); }],
  ['reselect', h => { h.clock.advance(300); h.vv.log.length = 0; h.timed.length = 0; h.manager.select('vbot', .4, .4); }],
];
for (const [name, trigger] of endPaths) {
  const answering = { value: true };
  const h = harness({}, answering);
  h.driveUntilMoving(); h.vv.log.length = 0; h.timed.length = 0;
  trigger(h);
  check(`${name}: sends a VISCA stop`, h.stops().length >= 1);
  h.clock.advance(500);
  check(`${name}: the head is not driven again afterwards`, h.moves().length === 0);
}
{
  // emergency stop: the manager invalidates without stopping, the shared emergency path sends the stop for every device
  const h = harness();
  const state = createInitialState({ controlledCamera: 'cam1' });
  registerTracking(state, { manager: h.manager, ledger: h.ledger });
  h.driveUntilMoving(); h.vv.log.length = 0; h.timed.length = 0;
  emergencyStopAll(state, { cameras: [] } as unknown as AppConfig, {} as unknown as AtemClient, new Map<string, MotionDevice>([['cam1', h.device]])).catch(assertNever);
  check('emergency stop: sends a VISCA stop and ends the session', h.stops().length >= 1 && h.manager.getStatus().vbot.sessionId === null);
  h.clock.advance(500);
  check('emergency stop: dead-man timer is quiet afterwards and the head is not driven', h.moves().length === 0 && h.clock.timers.slice(1).every(t => t.cleared));
  unregisterTracking(state);
}
function assertNever(error: unknown): never { throw error; }

// ---- readiness: tracking needs the head to be answering
{
  const answering = { value: false };
  const h = harness({}, answering);
  const status = h.manager.getStatus().vbot;
  check('a VISCA head that is not answering is unavailable, with a reason', status.state === 'unavailable' && /not answering/.test(status.reason ?? ''));
  let error: unknown;
  try { h.manager.select('vbot', .5, .5); } catch (e) { error = e; }
  check('selecting on a silent head is refused (409), never driving blind', error instanceof TrackingError && error.statusCode === 409 && /not answering/.test(error.message) && h.peer.selects === 0);
  answering.value = true;
  check('answering again makes it available', h.manager.getStatus().vbot.state === 'idle');
  h.manager.select('vbot', .5, .5);
  check('and selectable', h.manager.getStatus().vbot.state === 'locking');
  const noHook = new TrackingManager({ config: TrackingSchema.parse({ enabled: true }), sources: [h.source], devices: new Map<string, MotionDevice>([['cam1', h.device]]), client: new FakePeer() });
  check('without a health source a VISCA head is never ready', noHook.getStatus().vbot.state === 'unavailable');
}

// ---- operator override through the real control path (gamepad frames; the iPad touch arrows arrive as the same frames)
{
  const h = harness();
  const state = createInitialState({ controlledCamera: 'cam1', programCamera: 'cam1', previewCamera: 'cam1', cameraIndex: 0, controllerConnected: true, speedPreset: 0 });
  registerTracking(state, { manager: h.manager, ledger: h.ledger });
  const config = {
    cameras: [{ id: 'cam1', label: 'V-BOT', protocol: 'visca', cameraType: 'vbot', inputId: 1, viscaIp: '127.0.0.1', viscaPort: 52381, cameraAddress: 1, speedScale: 1 }],
    speeds: { presets: [{ name: 'Fast', multiplier: 1 }], activePreset: 0 },
    mappings: { panTilt: 'rightStick', zoomIn: 'rightTrigger', zoomOut: 'leftTrigger', cameraSelectLeft: 'leftStickLeft', cameraSelectRight: 'leftStickRight', autoTransition: 'RB', precisionMode: 'LS',
      selectCam1: 'X', selectCam2: 'A', selectCam3: 'B', selectCam4: 'Y', speedUp: 'dpadUp', speedDown: 'dpadDown', lowerThirds: 'dpadLeft', emergencyStop: 'back', trackingToggle: 'RS' },
  } as unknown as AppConfig;
  const csm = new ControlStateMachine(state, config, {} as unknown as AtemClient, new Map<string, MotionDevice>([['cam1', h.device]]), null);
  h.driveUntilMoving(); h.vv.log.length = 0; h.timed.length = 0;
  csm.updateInput({ axes: { rightStickX: 0.9 }, buttons: {}, triggers: {} });
  csm.tick();
  const status = h.manager.getStatus().vbot;
  check('stick on the same VISCA camera pauses tracking as operator_override', status.state === 'operator_override' && status.reason === 'manual_input' && status.sessionId !== null);
  check('the head was stopped, then follows the stick', h.stops().length >= 1 && h.moves().length >= 1 && h.timed.findIndex(x => x.line === STOP_PT) < h.timed.findIndex(x => isMove(x.line)));
  h.timed.length = 0;
  h.clock.advance(400);
  check('the late repeat-stop does not interrupt the operator', h.stops().length === 0);
  check('tracking does not drive the head while overridden', h.moves().length === 0);
  csm.updateInput({ axes: {}, buttons: {}, triggers: {} });
  csm.tick();
  check('releasing the stick stops the head and does not resume tracking', h.stops().length >= 1 && h.manager.getStatus().vbot.state === 'operator_override');
  unregisterTracking(state);
}

// ---- source derivation
{
  const devices = { vbot: { protocol: 'visca' }, rs3: { protocol: 'dji-bridge' }, sonyV: { protocol: 'sony', sonyCameraId: '10:32:2C:7D:84:31' }, sonyG: { protocol: 'sony', sonyCameraId: 'AA:02' }, bird: { protocol: 'visca' } };
  const cam = (n: number, deviceKey: string, protocol: string, camera?: string) => ({ id: `cam${n}`, deviceKey, protocol, camera });
  const cfg = (cameras: ReturnType<typeof cam>[], tracking: unknown = {}) => ({ cameras, devices, tracking: TrackingSchema.parse({ enabled: true, ...(tracking as object) }) }) as unknown as AppConfig;
  const derived = resolveTrackingSources(cfg([cam(1, 'vbot', 'visca', 'sonyV')]));
  check('a VISCA rig with a bound Sony camera is a source', derived.length === 1 && derived[0].sourceId === 'vbot' && derived[0].sonyCameraId === '10:32:2C:7D:84:31' && derived[0].cameraId === 'cam1' && derived[0].auto === true);
  check('a VISCA rig without a Sony camera is not', resolveTrackingSources(cfg([cam(1, 'vbot', 'visca'), cam(2, 'bird', 'visca')])).length === 0);
  check('gimbals and VISCA heads derive together', resolveTrackingSources(cfg([cam(1, 'vbot', 'visca', 'sonyV'), cam(2, 'rs3', 'dji-bridge', 'sonyG')])).map(s => s.sourceId).join() === 'vbot,rs3');
  check('the same Sony camera is never derived onto a second rig', resolveTrackingSources(cfg([cam(1, 'vbot', 'visca', 'sonyV'), cam(2, 'bird', 'visca', 'sonyV')])).length === 1);
  check('a rig whose protocol disagrees with its device is not derived', resolveTrackingSources(cfg([cam(1, 'rs3', 'visca', 'sonyV')])).length === 0);
  check('autoSources:false still derives nothing', resolveTrackingSources(cfg([cam(1, 'vbot', 'visca', 'sonyV')], { autoSources: false })).length === 0);
  check('an explicit entry on a VISCA device validates and overrides', collectTrackingIssues(TrackingSchema.parse({ sources: [{ sonyCameraId: 'AA', device: 'vbot', invertTilt: true }] }), devices).length === 0
    && resolveTrackingSources(cfg([cam(1, 'vbot', 'visca', 'sonyV')], { sources: [{ sonyCameraId: 'AA', device: 'vbot', invertTilt: true }] }))[0].invertTilt === true);
  check('an explicit entry on a Sony device is still rejected', collectTrackingIssues(TrackingSchema.parse({ sources: [{ sonyCameraId: 'AA', device: 'sonyV' }] }), devices).length === 1);
}

// ---- calibration stays DJI-only
{
  const h = harness();
  let error: unknown;
  try { h.manager.acquireCalibration('vbot', () => undefined); } catch (e) { error = e; }
  check('calibration is refused for a VISCA source', error instanceof TrackingError && error.code === 'calibration_unavailable');
}

console.log(`trackingVisca: ${passed} checks passed`);
