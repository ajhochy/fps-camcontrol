import assert from 'assert';
import { EventEmitter } from 'events';
import { RemoteControlHub, RemoteSocket, RemoteRequest, originAllowed, pinMatches } from '../input/remoteControl';
import { InputArbiter, ArbiterMachine } from '../input/inputArbiter';
import { createInitialState } from '../app/state';
import { NormalizedInput } from '../input/normalizers';

/**
 * The remote hub with fake sockets and a fake clock: protocol, ownership, dead-man, ping timeout, PIN with
 * lockout, Origin check and the Tailscale label. Run: node dist/testing/remoteControlTest.js
 */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

class FakeSocket extends EventEmitter implements RemoteSocket {
  readyState = 1;
  sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string): void { this.closedWith = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate(): void { this.terminated = true; this.readyState = 3; this.emit('close'); }
  ping(): void { this.pings++; }
  say(obj: unknown): void { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  last(type: string): any { return [...this.sent].reverse().find((m) => m.t === type); }
}

class FakeMachine implements ArbiterMachine {
  inputs: NormalizedInput[] = [];
  switches = 0;
  updateInput(input: NormalizedInput): void { this.inputs.push(input); }
  switchSource(): void { this.switches++; }
}

function setup(opts: { pin?: string; enabled?: boolean } = {}) {
  let clock = 100000;
  const now = () => clock;
  const machine = new FakeMachine();
  const arbiter = new InputArbiter(machine, now);
  const state = createInitialState();
  const stops: string[] = [];
  const hub = new RemoteControlHub({
    state, config: { speeds: { presets: [{ name: 'Slow', multiplier: 0.2 }, { name: 'Normal', multiplier: 0.5 }], activePreset: 1 } } as never,
    arbiter, activityLog: null, emergencyStop: () => { stops.push('stop'); }, pin: opts.pin ?? null, now,
  });
  hub.setEnabled(opts.enabled ?? true);
  clock += 5000;
  const connect = (req?: RemoteRequest): FakeSocket => { const ws = new FakeSocket(); hub.handleConnection(ws, req ?? { headers: {}, socket: { remoteAddress: '192.168.1.20' } }); return ws; };
  return { hub, arbiter, machine, state, stops, connect, advance: (ms: number) => { clock += ms; }, now };
}
let seq = 0;
const move = (ws: FakeSocket, x = 0.8): void => ws.say({ t: 'in', s: ++seq, a: [0, 0, x, 0], tr: [0, 0], b: 0 });

// ---- origin and helpers
check('no Origin (not a browser) is allowed', originAllowed({ headers: { host: 'mac:8080' } }));
check('a same-host Origin is allowed', originAllowed({ headers: { origin: 'http://mac:8080', host: 'mac:8080' } }));
check('Origin comparison ignores case', originAllowed({ headers: { origin: 'https://Mac.ts.net', host: 'mac.ts.net' } }));
check('a page from another site is refused', !originAllowed({ headers: { origin: 'http://evil.example', host: 'mac:8080' } }));
check('a same-host Origin on another port is refused', !originAllowed({ headers: { origin: 'http://mac:9999', host: 'mac:8080' } }));
check('a garbage Origin is refused', !originAllowed({ headers: { origin: 'not a url', host: 'mac:8080' } }));
check('pinMatches is exact', pinMatches('1234', '1234') && !pinMatches('1235', '1234') && !pinMatches('', '1234') && !pinMatches(null, '1234'));

// ---- the basic conversation
{
  const { connect, arbiter, state, machine } = setup();
  const ws = connect();
  ws.say({ t: 'hello', v: 1, name: 'Front iPad' });
  check('hello is answered with a welcome (enabled, no PIN needed, desk owns)', (() => { const w = ws.last('welcome'); return w && w.enabled === true && w.needsPin === false && w.owner === 'local' && typeof w.session === 'string'; })());
  check('the session shows in the status', state.remoteControl.sessions === 1);
  ws.say({ t: 'ping', ts: 42 });
  check('ping is answered with pong', ws.last('pong')?.ts === 42);
  ws.say({ t: 'claim' });
  check('claim is granted and the owner message says "you"', arbiter.owner === 'remote' && ws.last('owner')?.you === true && ws.last('owner')?.owner === 'remote');
  check('the status names the owner', state.remoteControl.owner === 'remote' && /Front iPad/.test(state.remoteControl.ownerName ?? ''));
  move(ws);
  check('owner frames reach the machine as a normalized input', machine.inputs.length === 1 && machine.inputs[0].axes.rightStickX === 0.8);
  ws.say({ t: 'in', s: 1, a: [0, 0, 1, 0], tr: [0, 0], b: 0 });
  check('a stale sequence number is dropped, not applied', machine.inputs.length === 1);
  const spectator = connect();
  spectator.say({ t: 'hello', v: 1, name: 'Spectator' });
  check('a second page is told the iPad owns', spectator.last('welcome')?.owner === 'remote');
  spectator.say({ t: 'claim' });
  check('and is refused a claim: other-remote', spectator.last('denied')?.reason === 'other-remote');
  move(spectator);
  check('spectator frames are not applied', machine.inputs.length === 1);
  ws.say({ t: 'release' });
  check('release hands the seat back and tells both pages', arbiter.owner === 'local' && ws.last('owner')?.you === false && spectator.last('owner')?.owner === 'local');
}

// ---- every way out stops the camera at once
for (const [name, act] of [
  ['the socket closing', (c: { ws: FakeSocket }) => c.ws.close()],
  ['an idle message', (c: { ws: FakeSocket }) => c.ws.say({ t: 'idle' })],
  ['a release', (c: { ws: FakeSocket }) => c.ws.say({ t: 'release' })],
  ['a socket error', (c: { ws: FakeSocket }) => c.ws.emit('error', new Error('boom'))],
] as Array<[string, (c: { ws: FakeSocket }) => void]>) {
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  ws.say({ t: 'claim' });
  const before = env.machine.switches;
  act({ ws });
  check(`${name}: the machine is switched (camera stopped) and the desk owns`, env.machine.switches === before + 1 && env.arbiter.owner === 'local');
  check(`${name}: the status is back to the desk`, env.state.remoteControl.owner === 'local');
}
{
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  ws.say({ t: 'claim' });
  ws.say({ t: 'stop' });
  check('STOP from the page stops every camera and releases the seat', env.stops.length === 1 && env.arbiter.owner === 'local');
  const before = env.stops.length;
  const stranger = env.connect();
  stranger.say({ t: 'stop' });
  check('STOP before hello is ignored (a page must introduce itself)', env.stops.length === before);
}
{
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  ws.say({ t: 'claim' });
  move(ws);
  env.advance(900); env.hub.tick();
  check('900 ms of silence keeps the seat', env.arbiter.owner === 'remote');
  env.advance(200); env.hub.tick();
  check('1100 ms of silence (dead-man) drops it and stops the camera', env.arbiter.owner === 'local' && ws.last('owner')?.reason === 'timeout');
  check('the status follows', env.state.remoteControl.owner === 'local' && env.state.remoteControl.lastFrameAgoMs === null);
}
{
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  ws.say({ t: 'claim' });
  env.advance(1000); env.hub.pingAll();
  check('a live socket is pinged each second', ws.pings === 1 && !ws.terminated);
  ws.emit('pong'); move(ws);
  env.advance(1000); move(ws); env.hub.pingAll();
  env.advance(500); move(ws); env.hub.pingAll();
  env.hub.tick();
  check('answering pongs keeps it alive and measures the round trip', !ws.terminated && env.state.remoteControl.rttMs !== null);
  env.advance(3000); env.hub.pingAll();
  check('no pong for 2.5 s: the half-open socket is terminated and the seat released', ws.terminated && env.arbiter.owner === 'local' && env.state.remoteControl.sessions === 0);
}
{
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  ws.say({ t: 'claim' });
  env.hub.setEnabled(false);
  check('switching remote control off releases the seat and tells the page', env.arbiter.owner === 'local' && ws.last('owner')?.enabled === false && env.state.remoteControl.enabled === false);
  ws.say({ t: 'claim' });
  check('a claim while off is denied: disabled', ws.last('denied')?.reason === 'disabled');
  env.hub.setEnabled(true);
  env.advance(2000);
  ws.say({ t: 'claim' });
  check('and works again once it is switched back on', env.arbiter.owner === 'remote');
  check('Take back from the desk releases it', env.hub.takeBack() && env.arbiter.owner === 'local' && ws.last('owner')?.reason === 'taken-back');
}

// ---- abuse
{
  const env = setup();
  const ws = env.connect();
  ws.say({ t: 'hello', v: 1, name: 'x' });
  for (let i = 0; i < 25; i++) ws.emit('message', Buffer.from('junk'));
  check('more than 20 invalid messages closes the socket with 1008', ws.closedWith?.code === 1008);
  const flood = setup();
  const f = flood.connect();
  f.say({ t: 'hello', v: 1, name: 'x' });
  f.say({ t: 'claim' });
  let s2 = 0;
  for (let i = 0; i < 2000; i++) f.say({ t: 'in', s: ++s2, a: [0, 0, 0.5, 0], tr: [0, 0], b: 0 });
  check('a flood of valid frames at one instant is mostly dropped (burst 20), not applied', flood.machine.inputs.length <= 21);
  check('and a sustained flood gets the socket closed (1008)', f.closedWith?.code === 1008);
  const big = setup().connect();
  big.emit('message', Buffer.from('x'.repeat(600)));
  check('an oversized message counts as invalid, not a crash', big.closedWith === null);
}

// ---- Origin
{
  const env = setup();
  const evil = env.connect({ headers: { origin: 'http://evil.example', host: 'mac:8080' }, socket: { remoteAddress: '192.168.1.99' } });
  check('a cross-site page is closed at once (1008) and gets no session', evil.closedWith?.code === 1008 && env.state.remoteControl.sessions === 0);
}

// ---- PIN
{
  const env = setup({ pin: '4821' });
  const a = env.connect();
  a.say({ t: 'hello', v: 1, name: 'x' });
  check('with a PIN configured the welcome asks for it', a.last('welcome')?.needsPin === true && !a.last('denied'));
  a.say({ t: 'claim' });
  check('a claim before the PIN is denied: pin', a.last('denied')?.reason === 'pin' && env.arbiter.owner === 'local');
  a.say({ t: 'hello', v: 1, name: 'x', pin: '0000' });
  check('a wrong PIN is denied and still asks', a.last('denied')?.reason === 'pin' && a.last('welcome')?.needsPin === true);
  a.say({ t: 'hello', v: 1, name: 'x', pin: '4821' });
  check('the right PIN unlocks', a.last('welcome')?.needsPin === false);
  a.say({ t: 'claim' });
  check('and then a claim works', env.arbiter.owner === 'remote');
}
{
  const env = setup({ pin: '4821' });
  const addr = { headers: {}, socket: { remoteAddress: '192.168.1.50' } };
  const a = env.connect(addr);
  for (let i = 0; i < 5; i++) a.say({ t: 'hello', v: 1, name: 'x', pin: String(1000 + i) });
  check('the 5th wrong PIN reports a lockout', a.last('denied')?.locked === true);
  a.say({ t: 'hello', v: 1, name: 'x', pin: '4821' });
  check('while locked out even the right PIN is refused', a.last('denied')?.locked === true && a.last('welcome')?.needsPin === true);
  const other = env.connect({ headers: {}, socket: { remoteAddress: '192.168.1.51' } });
  other.say({ t: 'hello', v: 1, name: 'x', pin: '4821' });
  check('another peer is not locked out', other.last('welcome')?.needsPin === false);
  env.advance(61000);
  const later = env.connect(addr);
  later.say({ t: 'hello', v: 1, name: 'x', pin: '4821' });
  check('after a minute the lockout ends', later.last('welcome')?.needsPin === false);
}

// ---- Tailscale label
{
  const env = setup();
  const viaServe = env.connect({ headers: { 'tailscale-user-login': 'aj@example.com' }, socket: { remoteAddress: '127.0.0.1' } });
  viaServe.say({ t: 'hello', v: 1, name: 'Stage iPad' });
  viaServe.say({ t: 'claim' });
  check('through tailscale serve (loopback) the login labels the owner', /Stage iPad \(aj@example\.com\)/.test(env.state.remoteControl.ownerName ?? ''));
  const env2 = setup();
  const spoof = env2.connect({ headers: { 'tailscale-user-login': 'boss@example.com' }, socket: { remoteAddress: '192.168.1.77' } });
  spoof.say({ t: 'hello', v: 1, name: 'Sneaky' });
  spoof.say({ t: 'claim' });
  check('the same header from a LAN address is ignored (it could be spoofed)', !/boss@/.test(env2.state.remoteControl.ownerName ?? '') && /Sneaky/.test(env2.state.remoteControl.ownerName ?? ''));
}

console.log(`remoteControl: ${passed} checks passed`);
