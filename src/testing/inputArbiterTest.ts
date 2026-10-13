import assert from 'assert';
import { InputArbiter, ArbiterMachine, OwnerChange, isActiveInput, CLAIM_QUIET_MS, DEAD_MAN_MS } from '../input/inputArbiter';
import { standardFrameToInput, neutralInput } from '../input/browserGamepad';
import { NormalizedInput } from '../input/normalizers';

/** Local/remote input arbitration (input/inputArbiter.ts). Run: node dist/testing/inputArbiterTest.js */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

class FakeMachine implements ArbiterMachine {
  inputs: Array<{ input: NormalizedInput; label?: string }> = [];
  switches: Array<NormalizedInput | null> = [];
  updateInput(input: NormalizedInput, label?: string): void { this.inputs.push({ input, label }); }
  switchSource(seed: NormalizedInput | null): void { this.switches.push(seed); }
}

const stick = (x: number): NormalizedInput => standardFrameToInput({ a: [0, 0, x, 0], tr: [0, 0], b: 0 });
const pressed = (bit: number): NormalizedInput => standardFrameToInput({ a: [0, 0, 0, 0], tr: [0, 0], b: 1 << bit });

function setup() {
  let clock = 100000;
  const machine = new FakeMachine();
  const arbiter = new InputArbiter(machine, () => clock);
  const changes: OwnerChange[] = [];
  arbiter.onOwnerChange((e) => changes.push(e));
  return { machine, arbiter, changes, advance: (ms: number) => { clock += ms; } };
}

check('a neutral pad is not active', !isActiveInput(neutralInput()));
check('a small stick wobble is not active, a push is', !isActiveInput(stick(0.25)) && isActiveInput(stick(0.4)));
check('any button is active', isActiveInput(pressed(9)));
check('a trigger pull is active, a graze is not', isActiveInput(standardFrameToInput({ a: [0, 0, 0, 0], tr: [0, 0.4], b: 0 })) && !isActiveInput(standardFrameToInput({ a: [0, 0, 0, 0], tr: [0, 0.1], b: 0 })));

// ---- defaults
{
  const { arbiter, machine } = setup();
  check('the desk owns by default', arbiter.owner === 'local');
  arbiter.fromLocal(stick(0.8), 'Xbox');
  check('local frames reach the machine, with the label', machine.inputs.length === 1 && machine.inputs[0].label === 'Xbox');
  check('remote frames from nobody are dropped', !arbiter.fromRemote('s1', stick(0.8)) && machine.inputs.length === 1);
  check('remote control is off by default: a claim is refused', (() => { const r = arbiter.claim('s1', 'iPad', null); return !r.ok && r.reason === 'disabled'; })());
  check('sourceConnected follows the HID link while the desk owns', arbiter.sourceConnected(true) && !arbiter.sourceConnected(false));
}

// ---- claim rules
{
  const { arbiter, advance, changes, machine } = setup();
  arbiter.setEnabled(true);
  arbiter.fromLocal(pressed(0));
  advance(CLAIM_QUIET_MS - 100);
  check('a claim is refused while the desk was active under 1500 ms ago', (() => { const r = arbiter.claim('s1', 'iPad', null); return !r.ok && r.reason === 'desk-active'; })());
  check('a refused claim changes nothing and does not stop anything', arbiter.owner === 'local' && machine.switches.length === 0 && changes.length === 0);
  advance(200);
  check('a claim after the desk went quiet is granted', arbiter.claim('s1', 'Front iPad', null).ok && arbiter.owner === 'remote' && arbiter.ownerName === 'Front iPad');
  check('the grant switches the source (stopping the camera)', machine.switches.length === 1 && changes[0].reason === 'claim');
  check('a second remote is refused', (() => { const r = arbiter.claim('s2', 'Other', null); return !r.ok && r.reason === 'other-remote'; })());
  check('the owner claiming again is a harmless yes', arbiter.claim('s1', 'Front iPad', null).ok && machine.switches.length === 1);
  check('the remote now counts as a connected source whatever the HID link says', arbiter.sourceConnected(false));
}

// ---- remote frames
{
  const { arbiter, machine, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  arbiter.claim('s1', 'iPad', null);
  check('the owner s frames reach the machine, labelled', arbiter.fromRemote('s1', stick(0.8), 'iPad: iPad') && machine.inputs.length === 1 && machine.inputs[0].label === 'iPad: iPad');
  check('another session s frames are discarded', !arbiter.fromRemote('s2', stick(0.8)) && machine.inputs.length === 1);
  arbiter.fromLocal(neutralInput());
  check('a quiet desk pad does not interrupt the iPad nor reach the machine', arbiter.owner === 'remote' && machine.inputs.length === 1);
}

// ---- desk override
{
  const { arbiter, machine, changes, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  arbiter.claim('s1', 'iPad', null);
  const before = machine.switches.length;
  arbiter.fromLocal(stick(0.9), 'Xbox');
  check('an active desk frame takes over immediately', arbiter.owner === 'local' && changes[changes.length - 1].reason === 'desk-override' && changes[changes.length - 1].previousId === 's1');
  check('and switches the source (stop) before the desk frame is applied', machine.switches.length === before + 1 && machine.inputs[machine.inputs.length - 1].label === 'Xbox');
  check('the seed for the desk is the frame that took over (held buttons will not fire)', machine.switches[machine.switches.length - 1] !== null);
  check('the iPad s frames are ignored until it claims again', !arbiter.fromRemote('s1', stick(0.8)));
  check('the iPad cannot reclaim while the desk is active', (() => { const r = arbiter.claim('s1', 'iPad', null); return !r.ok && r.reason === 'desk-active'; })());
  advance(CLAIM_QUIET_MS + 10);
  check('but can once the desk is quiet', arbiter.claim('s1', 'iPad', null).ok);
}

// ---- every way the seat is lost stops the camera and returns to the desk
for (const [name, act] of [
  ['release', (a: InputArbiter) => a.release('s1')],
  ['idle (page hidden)', (a: InputArbiter) => a.release('s1', 'idle')],
  ['socket close', (a: InputArbiter) => a.release('s1', 'disconnect')],
  ['remote control disabled', (a: InputArbiter) => a.setEnabled(false)],
  ['STOP', (a: InputArbiter) => a.revoke('stop')],
  ['desk Take back', (a: InputArbiter) => a.revoke('taken-back')],
] as Array<[string, (a: InputArbiter) => void]>) {
  const { arbiter, machine, changes, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  arbiter.claim('s1', 'iPad', null);
  const before = machine.switches.length;
  act(arbiter);
  check(`${name}: back to the desk`, arbiter.owner === 'local' && arbiter.ownerId === null);
  check(`${name}: the source is switched (camera stopped) at once`, machine.switches.length === before + 1 && machine.switches[before] === null);
  check(`${name}: listeners are told`, changes[changes.length - 1].owner === 'local' && changes[changes.length - 1].previousId === 's1');
}
{
  const { arbiter, machine, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  arbiter.claim('s1', 'iPad', null);
  check('release from a session that does not own is ignored', !arbiter.release('s2') && arbiter.owner === 'remote');
  check('revoke when the desk already owns is a no-op', (() => { arbiter.release('s1'); const n = machine.switches.length; arbiter.revoke('stop'); return machine.switches.length === n; })());
}

// ---- dead-man
{
  const { arbiter, machine, changes, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  arbiter.claim('s1', 'iPad', null);
  advance(DEAD_MAN_MS - 100);
  arbiter.tick();
  check('a remote quiet for under 1000 ms keeps the seat', arbiter.owner === 'remote');
  arbiter.fromRemote('s1', stick(0.5));
  advance(DEAD_MAN_MS - 100);
  arbiter.tick();
  check('a frame resets the dead-man clock', arbiter.owner === 'remote' && (arbiter.lastRemoteFrameAgoMs ?? 0) < DEAD_MAN_MS);
  advance(200);
  const before = machine.switches.length;
  arbiter.tick();
  check('1000 ms of silence revokes the seat and stops the camera', arbiter.owner === 'local' && machine.switches.length === before + 1 && changes[changes.length - 1].reason === 'timeout');
  check('lastRemoteFrameAgoMs is null when the desk owns', arbiter.lastRemoteFrameAgoMs === null);
}

// ---- seeded edge state
{
  const { arbiter, machine, advance } = setup();
  arbiter.setEnabled(true);
  advance(5000);
  const heldA = pressed(0);
  arbiter.claim('s1', 'iPad', heldA);
  check('the claim seed is the pad s held buttons, so a held A does not read as a new press', machine.switches[0] === heldA && machine.switches[0]!.buttons.A === true);
}

console.log(`inputArbiter: ${passed} checks passed`);
