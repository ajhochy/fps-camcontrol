import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseBoxes, recoverMp4, scanMp4 } from '../../src/broadcast/mp4Recovery';

// Synthetic byte-level hybrid-fragmented MP4s (the box layout FFmpeg writes with +frag_keyframe+hybrid_fragmented, observed in the #67 write trace).
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]); };
const tkhd = (id: number) => box('tkhd', Buffer.concat([u32(0), u32(0), u32(0), u32(id)]));              // version0: track id at payload+12
const hdlr = (kind: string) => box('hdlr', Buffer.concat([u32(0), u32(0), Buffer.from(kind, 'ascii')]));  // handler at payload+8
const stsz = (n: number) => box('stsz', Buffer.concat([u32(0), u32(0), u32(n)]));                       // count at payload+8
const trak = (id: number, kind: string, samples: number) => box('trak', tkhd(id), box('mdia', hdlr(kind), box('minf', box('stbl', stsz(samples)))));
const moov = (v: number, a: number) => box('moov', trak(1, 'vide', v), trak(2, 'soun', a));
const moof = (v: number, a: number) => box('moof', box('traf', box('tfhd', Buffer.concat([u32(0), u32(1)])), box('trun', Buffer.concat([u32(0), u32(v)]))), box('traf', box('tfhd', Buffer.concat([u32(0), u32(2)])), box('trun', Buffer.concat([u32(0), u32(a)]))));
const mdat = (n: number) => box('mdat', Buffer.alloc(n, 7));
const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
const placeholder = Buffer.concat([box('free'), box('free', Buffer.alloc(36))]);

test('open hybrid file: initial moov indexes the first GOP, complete fragments follow, a torn trailing fragment is reported not counted', () => {
  const open = Buffer.concat([ftyp, placeholder, moov(60, 94), mdat(500), moof(60, 94), mdat(400), moof(60, 95)]);
  const torn = Buffer.concat([open, mdat(1000).subarray(0, 300)]);
  const s = scanMp4(torn);
  assert.equal(s.state, 'fragmented-open');
  assert.deepEqual(s.completeSamples, { vide: 120, soun: 188 });
  assert.equal(s.fragments.length, 1);
  assert.ok(s.completePrefixBytes < torn.length && s.trailing && s.trailing.bytes === torn.length - s.completePrefixBytes);
  assert.match(s.trailing!.note, /incomplete mdat|trailing/);
});

test('header/initialization only (no complete first GOP) has nothing recoverable', () => {
  const s = scanMp4(Buffer.concat([ftyp, placeholder]));
  assert.equal(s.state, 'no-media');
  assert.deepEqual(s.completeSamples, { vide: 0, soun: 0 });
  const half = scanMp4(Buffer.concat([ftyp, placeholder, moov(60, 94), mdat(500).subarray(0, 100)]));
  assert.equal(half.state, 'no-media', 'initial moov whose mdat is torn indexes samples that are not persisted');
  assert.deepEqual(half.completeSamples, { vide: 0, soun: 0 });
});

test('graceful close (moov last) and the kill between "final moov written" and "header patched" are told apart', () => {
  const closed = Buffer.concat([ftyp, box('free'), mdat(2000), moov(300, 470)]);
  assert.equal(scanMp4(closed).state, 'closed');
  const unpatched = Buffer.concat([ftyp, placeholder, moov(60, 94), mdat(500), moof(60, 94), mdat(400), moov(300, 470)]);
  const u = scanMp4(unpatched);
  assert.equal(u.state, 'closed-header-unpatched');
  assert.deepEqual(u.completeSamples, { vide: 120, soun: 188 }, 'recovery uses only the complete fragment prefix, never the trailing duplicate moov');
});

test('box parser: open-ended and over-long boxes stop the scan instead of throwing', () => {
  const b = Buffer.concat([ftyp, Buffer.concat([u32(0), Buffer.from('mdat'), Buffer.alloc(20)])]);
  const r = parseBoxes(b); assert.equal(r.boxes.length, 1); assert.equal(r.torn?.type, 'mdat');
  assert.equal(parseBoxes(Buffer.concat([ftyp, u32(99999), Buffer.from('moof')])).torn?.declared, 99999);
});

test('recovery refuses to overwrite and never targets the original', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mp4rec-spec-'));
  try {
    const original = path.join(dir, 'orig.mp4'); writeFileSync(original, Buffer.concat([ftyp, placeholder]));
    await assert.rejects(recoverMp4(original, original), /must differ/);
    const existing = path.join(dir, 'there.mp4'); writeFileSync(existing, 'x');
    await assert.rejects(recoverMp4(original, existing), /refusing to overwrite/);
    const result = await recoverMp4(original, path.join(dir, 'new.mp4'));
    assert.equal(result.status, 'NO_RECOVERABLE_MEDIA');
    assert.equal(existsSync(path.join(dir, 'new.mp4')), false, 'no empty file is manufactured when nothing is recoverable');
    assert.equal(readFileSync(original).length, ftyp.length + placeholder.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
