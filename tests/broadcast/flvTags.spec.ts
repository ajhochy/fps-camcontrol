import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { FlvTagReader } from '../../src/broadcast/flvTags';

function tag(type: number, ts: number, data: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header[0] = type; header.writeUIntBE(data.length, 1, 3); header.writeUIntBE(ts & 0xffffff, 4, 3); header[7] = (ts >>> 24) & 0xff;
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(11 + data.length);
  return Buffer.concat([header, data, trailer]);
}
const flvHeader = Buffer.concat([Buffer.from('FLV'), Buffer.from([1, 5, 0, 0, 0, 9]), Buffer.alloc(4)]);

test('FLV reader classifies key/inter/config/EOS tags across arbitrary chunking and hashes the access unit', () => {
  const nal = Buffer.from([1, 2, 3, 4, 5, 6]);
  const stream = Buffer.concat([flvHeader,
    tag(9, 0, Buffer.from([0x17, 0, 0, 0, 0, 0xaa])),              // AVC sequence header
    tag(9, 21, Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), nal])), // key frame
    tag(9, 54, Buffer.concat([Buffer.from([0x27, 1, 0, 0, 0]), nal])), // inter frame
    tag(8, 23, Buffer.from([0xaf, 1, 9, 9])),                       // AAC raw
    tag(9, 88, Buffer.from([0x27, 2, 0, 0, 0]))]);                  // end of sequence
  const reader = new FlvTagReader();
  for (let i = 0; i < stream.length; i += 7) reader.push(stream.subarray(i, i + 7), i);
  assert.ok(reader.headerSeen);
  const media = reader.tags.filter(t => !t.config);
  assert.deepEqual(media.map(t => [t.kind, t.ts, t.key]), [['video', 21, true], ['video', 54, false], ['audio', 23, false]]);
  assert.equal(media[0].md5, createHash('md5').update(nal).digest('hex'));
  assert.equal(reader.tags.filter(t => t.config).length, 2);
});

test('FLV reader rejects non-FLV input', () => {
  assert.throws(() => new FlvTagReader().push(Buffer.alloc(32, 1), 0), /Not an FLV/);
});
