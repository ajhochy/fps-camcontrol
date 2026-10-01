import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInitialState } from '../app/state';
import { rigHealth, sonyHealth, HealthTracker } from '../app/health';

/** Device health verdicts and the health log (app/health.ts). Run: npx ts-node src/testing/healthTest.ts */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const st = createInitialState({} as never);
const visca = { id: 'cam1', label: 'V-BOT', protocol: 'visca' };
const gimbal = { id: 'cam2', label: 'Center', protocol: 'dji-bridge' };

st.cameraConnected.cam1 = true;
check('a VISCA camera not yet checked is Check, not Ready', rigHealth(st, visca).level === 'check');
st.cameraAnswering.cam1 = true; st.cameraLastReplyAt.cam1 = Date.now() - 4000;
check('a VISCA camera that answered is Ready and says when', (() => { const h = rigHealth(st, visca); return h.level === 'ready' && h.text === 'Answering' && /4 s ago/.test(h.hint); })());
st.cameraAnswering.cam1 = false; st.viscaRepliesHeard = true;
check('a VISCA camera that stopped answering is Down, with what to check', (() => { const h = rigHealth(st, visca); return h.level === 'down' && /power|network/.test(h.hint); })());
st.viscaRepliesHeard = false;
check('when replies cannot be heard it is Check, not a false Down', rigHealth(st, visca).level === 'check');

check('a gimbal whose Pi is unreachable is Down: Bridge Offline (and mentions PoE)', (() => { const h = rigHealth(st, gimbal); return h.level === 'down' && h.text === 'Bridge Offline' && /PoE/.test(h.hint); })());
st.cameraBridgeReachable.cam2 = true; st.cameraGimbalAttached.cam2 = false;
check('bridge up, gimbal not found: Gimbal Off', rigHealth(st, gimbal).text === 'Gimbal Off');
st.cameraGimbalAttached.cam2 = true; st.cameraConnected.cam2 = true;
check('a linked gimbal is Ready', rigHealth(st, gimbal).level === 'ready');
st.cameraGimbalResponding.cam2 = false;
check('a linked gimbal that ignored the stick is Down: Asleep / Not Moving, with how to wake it', (() => { const h = rigHealth(st, gimbal); return h.level === 'down' && /Asleep/.test(h.text) && /power button/.test(h.hint); })());
st.cameraGimbalAsleep.cam2 = true;
check('a gimbal that reports it is asleep is Down: Asleep, before anyone pushes the stick', rigHealth(st, gimbal).text === 'Asleep');
delete st.cameraGimbalAsleep.cam2;
delete st.cameraGimbalResponding.cam2;
st.cameraGimbalSignal.cam2 = { rating: 'weak', drops10m: 2, corruptPct: 0, summary: '2 Bluetooth drops in 10 min' };
check('a weak signal is Check', rigHealth(st, gimbal).level === 'check' && rigHealth(st, gimbal).text === 'Weak Signal');

check('Sony: service off', sonyHealth(undefined, false, true).text === 'Sony Service Off');
check('Sony: a connected camera is Ready and shows its battery', (() => { const h = sonyHealth({ state: 'connected', battery: { percent: 64 } }, true, true); return h.level === 'ready' && /64%/.test(h.text); })());
check('Sony: battery under 25% is Check, under 15% is Down', sonyHealth({ state: 'connected', battery: { percent: 19 } }, true, true).level === 'check' && sonyHealth({ state: 'connected', battery: { percent: 9 } }, true, true).level === 'down');
check('Sony: a camera gone from the network is Off or Asleep', (() => { const h = sonyHealth({ state: 'disconnected', message: 'Camera not found or powered off' }, true, true); return h.level === 'down' && h.text === 'Off or Asleep' && /power save|overheated/.test(h.hint); })());
check('Sony: a refused connection says so', sonyHealth({ state: 'error', message: 'Camera connection failed' }, true, true).text === 'Refused / Failed');
check('Sony: reconnecting is Check', sonyHealth({ state: 'connecting' }, true, true).level === 'check');
check('Sony: a hot camera is Check, an overheating one Down', sonyHealth({ state: 'connected', overheat: { state: 'pre' } }, true, true).text === 'Getting Hot' && sonyHealth({ state: 'connected', overheat: { state: 'over' } }, true, true).level === 'down');
check('Sony: a camera that dropped while hot is flagged as an overheat shutdown', sonyHealth({ state: 'disconnected', message: 'Camera not found', overheat: { state: 'over' } }, true, true).text === 'Shut Down: Overheated?');

// ---- the tracker and its log
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-health-'));
const file = path.join(dir, 'health-events.jsonl');
let clock = Date.parse('2026-10-01T14:00:00Z');
const tracker = new HealthTracker(file, () => new Date(clock));
const ready = { level: 'ready' as const, text: 'Gimbal Linked', hint: '' };
check('a first reading that is fine is not an event', tracker.update([{ key: 'rig:cam2', label: 'Center', health: ready }]).length === 0);
clock += 1000;
check('the same state again is not an event, even if the hint changes', tracker.update([{ key: 'rig:cam2', label: 'Center', health: { ...ready, hint: 'x' } }]).length === 0);
clock += 60000;
const asleep = tracker.update([{ key: 'rig:cam2', label: 'Center', health: { level: 'down', text: 'Asleep / Not Moving', hint: 'press power' } }]);
check('a change is an event with the time, from and to', asleep.length === 1 && asleep[0].from === 'ready' && asleep[0].to === 'down' && asleep[0].at === '2026-10-01T14:01:01.000Z');
check('the snapshot says since when', tracker.snapshot()['rig:cam2'].since === '2026-10-01T14:01:01.000Z');
const firstBad = new HealthTracker(null).update([{ key: 'camera:cam3', label: 'Far Right camera', health: { level: 'down', text: 'Off or Asleep', hint: '' } }]);
check('a problem present at start is recorded', firstBad.length === 1 && firstBad[0].from === null);
check('events are written to the log file', fs.readFileSync(file, 'utf8').trim().split('\n').length === 1);
const reloaded = new HealthTracker(file);
check('the log survives a restart', reloaded.recent()[0].text === 'Asleep / Not Moving');
fs.rmSync(dir, { recursive: true, force: true });

console.log(`health: ${passed} checks passed`);
