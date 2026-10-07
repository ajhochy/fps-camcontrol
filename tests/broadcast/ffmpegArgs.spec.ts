import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Regression: buffered hybrid MP4 remains an 88-byte header after SIGKILL.
test('S1 MP4 explicitly flushes output while retaining hybrid EOF finalization', () => {
  const { remuxArgs } = require('../../src/broadcast/ffmpegArgs');
  const args: string[] = remuxArgs('recording.mp4', 'mp4');
  assert.ok(args.indexOf('-flush_packets') > args.indexOf('-i'));
  assert.equal(args[args.indexOf('-flush_packets') + 1], '1');
  assert.equal(args[args.indexOf('-movflags') + 1], '+frag_keyframe+hybrid_fragmented');
  assert.ok(!remuxArgs('output.flv', 'flv').includes('-flush_packets'));
});

// Regression: encoder defaults silently enable B frames or alter the production rate.
test('S1 encode preserves rational rate, stereo 48k, offset and random access', () => {
  const source = path.resolve(__dirname, '../../src/broadcast/ffmpegArgs.ts');
  assert.ok(existsSync(source), 'S1 encoder argument builder is not implemented');
  const { syntheticEncodeArgs } = require(source);
  for (const fps of ['25/1', '30000/1001', '30/1', '60000/1001', '60/1']) {
    const args: string[] = syntheticEncodeArgs({ width: 1280, height: 720, fps, delayFrames: 15, seconds: 12 });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(value('-c:v'), 'h264_videotoolbox');
    assert.equal(value('-bf'), '0');
    assert.equal(value('-pix_fmt'), 'yuv420p');
    assert.equal(value('-ar'), '48000');
    assert.equal(value('-ac'), '2');
    assert.equal(value('-f'), 'lavfi');
    assert.ok(args.join(' ').includes(fps));
    assert.ok(args.join(' ').includes('setpts='));
    assert.ok(args.includes('mpegts'));
  }
});
