import assert from 'assert';
import { parseClientMessage, TokenBucket, WindowCounter, MAX_PAYLOAD_BYTES } from '../input/remoteFrame';

/** Validation of what a remote client may send (input/remoteFrame.ts). Run: node dist/testing/remoteFrameTest.js */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const frame = (o: Record<string, unknown>): string => JSON.stringify({ t: 'in', s: 5, a: [0, 0, 0.5, 0], tr: [0, 0], b: 0, ...o });
const bad = (name: string, raw: string, seq = 0): void => check(name, !parseClientMessage(raw, seq).ok);

const good = parseClientMessage(frame({}), 4);
check('a valid frame parses', good.ok && good.msg.t === 'in' && good.msg.s === 5 && good.msg.a[2] === 0.5);
check('values are clamped', (() => { const r = parseClientMessage(frame({ a: [9, -9, 1.5, -1.5], tr: [-3, 7] }), 0); return r.ok && r.msg.t === 'in' && r.msg.a.join() === '1,-1,1,-1' && r.msg.tr.join() === '0,1'; })());
bad('NaN (not valid JSON) is rejected', '{"t":"in","s":1,"a":[NaN,0,0,0],"tr":[0,0],"b":0}');
bad('1e999 (Infinity once parsed) is rejected', '{"t":"in","s":1,"a":[1e999,0,0,0],"tr":[0,0],"b":0}');
bad('string axes rejected', frame({ a: ['0', 0, 0, 0] }));
bad('null axes rejected', frame({ a: [null, 0, 0, 0] }));
bad('wrong axes length rejected', frame({ a: [0, 0, 0] }));
bad('wrong triggers length rejected', frame({ tr: [0, 0, 0] }));
bad('axes that are not an array rejected', frame({ a: 'abcd' }));
bad('buttons above 0xFFFF rejected (bit 16, Guide)', frame({ b: 0x10000 }));
bad('negative buttons rejected', frame({ b: -1 }));
bad('fractional buttons rejected', frame({ b: 1.5 }));
check('buttons 0xFFFF is allowed', parseClientMessage(frame({ b: 0xffff }), 0).ok);
bad('a non-integer sequence rejected', frame({ s: 1.5 }));
bad('a missing sequence rejected', frame({ s: undefined }));
bad('a repeated sequence is dropped', frame({ s: 5 }), 5);
bad('an older sequence is dropped', frame({ s: 3 }), 5);
check('a newer sequence is accepted', parseClientMessage(frame({ s: 6 }), 5).ok);
bad('an oversized payload is rejected', frame({ pad: 'x'.repeat(MAX_PAYLOAD_BYTES) }));
bad('an unknown type is rejected', JSON.stringify({ t: 'reboot' }));
bad('a missing type is rejected', JSON.stringify({ s: 1 }));
bad('non-JSON is rejected', 'hello');
bad('a JSON array is rejected', '[1,2]');
bad('JSON null is rejected', 'null');
check('a Buffer payload parses too', parseClientMessage(Buffer.from(frame({})), 0).ok);

check('claim / release / idle / stop parse', ['claim', 'release', 'idle', 'stop'].every((t) => { const r = parseClientMessage(JSON.stringify({ t }), 0); return r.ok && r.msg.t === t; }));
check('ping needs a finite ts', parseClientMessage('{"t":"ping","ts":12}', 0).ok && !parseClientMessage('{"t":"ping","ts":"x"}', 0).ok);
check('hello cleans the name and keeps the pin', (() => {
  const raw = JSON.stringify({ t: 'hello', v: 1, name: '  Front\u0000 iPad\n'.padEnd(60, 'z'), pin: '1234', pad: { id: 'Xbox', mapping: 'standard' } });
  const r = parseClientMessage(raw, 0);
  return r.ok && r.msg.t === 'hello' && r.msg.name.length === 40 && !/[\x00\n]/.test(r.msg.name) && r.msg.pin === '1234' && r.msg.pad?.mapping === 'standard';
})());
bad('hello with the wrong version rejected', JSON.stringify({ t: 'hello', v: 2 }));
bad('hello with a non-string pin rejected', JSON.stringify({ t: 'hello', v: 1, pin: 1234 }));

// token bucket: 60/s, burst 20
let clock = 1000;
const bucket = new TokenBucket(60, 20, () => clock);
let allowed = 0;
for (let i = 0; i < 100; i++) if (bucket.take()) allowed++;
check('a burst of 100 at one instant lets only 20 through', allowed === 20);
clock += 1000;
allowed = 0;
for (let i = 0; i < 100; i++) if (bucket.take()) allowed++;
check('after a second the bucket has refilled to the burst (20)', allowed === 20);
clock += 100000;
const steady = new TokenBucket(60, 20, () => clock);
allowed = 0;
for (let i = 0; i < 300; i++) { clock += 1000 / 30; if (steady.take()) allowed++; }
check('a steady 30 Hz stream is never dropped', allowed === 300);
allowed = 0;
for (let i = 0; i < 600; i++) { clock += 1000 / 120; if (steady.take()) allowed++; }
check('a steady 120 Hz flood is held to about 60/s', allowed >= 290 && allowed <= 330);

const counter = new WindowCounter(5000, () => clock);
for (let i = 0; i < 4; i++) counter.add();
check('the window counter counts', counter.count() === 4);
clock += 5001;
check('and forgets after the window', counter.count() === 0);

console.log(`remoteFrame: ${passed} checks passed`);
