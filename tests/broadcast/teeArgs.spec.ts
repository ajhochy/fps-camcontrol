import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teeSessionArgs } from '../../src/broadcast/teeArgs';
import { niceFfmpeg } from '../../src/broadcast/mediaProcess';

const base = { width: 640, height: 360, fps: 30, seconds: 10, recordingPath: '/tmp/x/rec.mp4', publishUrl: 'rtmp://127.0.0.1:19351/live/s1' };
const tee = (args: string[]) => args[args.indexOf('-f', args.indexOf('-map')) + 1] === 'tee' ? args[args.length - 1] : '';

// Contract: static single-process tee with recording slave first, publisher behind a fifo that drops instead of blocking.
test('tee session: recording first, publisher fifo drops on overflow and restarts at a keyframe', () => {
  const spec = tee(teeSessionArgs(base));
  assert.ok(spec.startsWith('[f=mp4:movflags=+frag_keyframe+hybrid_fragmented:flush_packets=1:onfail=ignore]/tmp/x/rec.mp4|'));
  const publisher = spec.slice(spec.indexOf('|') + 1);
  for (const option of ['f=fifo', 'fifo_format=flv', 'queue_size=60', 'drop_pkts_on_overflow=1', 'attempt_recovery=1', 'recover_any_error=1', 'restart_with_keyframe=1', 'onfail=ignore']) assert.ok(publisher.includes(option), option);
  assert.ok(!spec.includes('faststart'));
});

test('tee session: network failure may never abort the recording writer, and blocking publisher queues are refused', () => {
  const spec = tee(teeSessionArgs({ ...base, dropOnOverflow: true, queueSize: 30, rwTimeoutMicros: 3_000_000 }));
  assert.ok(spec.includes('queue_size=30') && spec.includes('format_opts=rw_timeout\\=3000000'));
  assert.ok(tee(teeSessionArgs({ ...base, dropOnOverflow: false })).includes('drop_pkts_on_overflow=0'), 'negative-control variant must stay explicit');
});

test('tee session: only local publishers, bounded proof sizes and escaped paths', () => {
  assert.throws(() => teeSessionArgs({ ...base, publishUrl: 'rtmps://a.rtmps.youtube.com/live2/key' }), /local 127\.0\.0\.1/);
  assert.throws(() => teeSessionArgs({ ...base, publishUrl: 'rtmp://example.com:1935/live/s1' }), /local 127\.0\.0\.1/);
  assert.throws(() => teeSessionArgs({ ...base, width: 1920, height: 1080 }), /720p/);
  assert.throws(() => teeSessionArgs({ ...base, seconds: 3600 }), /90 s/);
  assert.throws(() => teeSessionArgs({ ...base, recordingPath: '/tmp/a|b.mp4' }), /reserved/);
  const args = teeSessionArgs(base);
  assert.equal(args[args.indexOf('-b:v') + 1], '2500k');
  assert.ok(args.includes('aevalsrc=sin(2*PI*440*t)|sin(2*PI*1000*t):s=48000'), 'distinct L/R tones');
});

test('proof children run under nice, optionally with a file-size limit that surfaces as a write error', () => {
  assert.deepEqual(niceFfmpeg('/x/ffmpeg', ['-i', 'a']), { binary: '/usr/bin/nice', args: ['-n', '15', '/x/ffmpeg', '-i', 'a'] });
  const limited = niceFfmpeg('/x/ffmpeg', ['-i', 'a'], { fileSizeLimitBlocks: 100 });
  assert.equal(limited.binary, '/bin/sh');
  assert.ok(limited.args[1].includes("trap '' XFSZ") && limited.args[1].includes('ulimit -f 100'));
});
