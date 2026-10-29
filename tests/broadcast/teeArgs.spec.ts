import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teeSessionArgs } from '../../src/broadcast/teeArgs';
import { niceFfmpeg } from '../../src/broadcast/mediaProcess';

const base = { width: 640, height: 360, fps: 30, seconds: 10, recordingPath: '/tmp/x/rec.mp4', publishUrl: 'rtmp://127.0.0.1:19351/live/s1' };
const tee = (args: string[]) => args[args.indexOf('-f', args.indexOf('-map')) + 1] === 'tee' ? args[args.length - 1] : '';

// Contract: static single-process tee with recording slave first, publisher behind a fifo that drops instead of blocking.
test('tee session: recording first, publisher fifo drops on overflow and restarts at a keyframe', () => {
  const spec = tee(teeSessionArgs(base));
  assert.ok(spec.startsWith('[f=mp4:movflags=+frag_keyframe+hybrid_fragmented:flush_packets=1:frag_duration=500000:onfail=ignore]/tmp/x/rec.mp4|'));
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

// #68: one configured video delay, applied before the encoder so the MP4 and the publisher share it; exact rational arithmetic.
import { captureTeeArgs, videoDelayFilter, videoDelaySeconds, MP4_MOVFLAGS } from '../../src/broadcast/teeArgs';
const cap = { recordingPath: '/tmp/x/rec.mp4', publishUrl: 'rtmp://127.0.0.1:19353/live/s1' };
test('video delay: exact rationals at 30/1, 30000/1001 and 60000/1001, 0-15 frames only', () => {
  assert.deepEqual(videoDelaySeconds('30/1', 3), [3, 30]);
  assert.deepEqual(videoDelaySeconds('30000/1001', 15), [15015, 30000]);   // 0.5005 s
  assert.deepEqual(videoDelaySeconds('60000/1001', 3), [3003, 60000]);     // 50.05 ms
  assert.equal(videoDelayFilter('30000/1001', 3, 'setpts'), 'setpts=PTS+(3*1001/30000)/TB');
  assert.equal(videoDelayFilter('60000/1001', 1, 'setpts'), 'setpts=PTS+(1*1001/60000)/TB');
  assert.equal(videoDelayFilter('30/1', 0), '');
  assert.equal(videoDelayFilter('30/1', 15), 'tpad=start=15:start_mode=add:color=black');
  assert.throws(() => videoDelayFilter('30/1', 16), /0-15/); assert.throws(() => videoDelayFilter('30/1', 1.5), /0-15/); assert.throws(() => videoDelayFilter('30', 1), /rational/);
});
test('capture session: the delay is one filter in front of the single encoder (both tee slaves inherit it); faststart is refused', () => {
  const args = captureTeeArgs({ ...cap, videoDelayFrames: 3 });
  assert.equal(args[args.indexOf('-vf') + 1], 'fps=30/1,tpad=start=3:start_mode=add:color=black');
  assert.equal(args.filter(a => a === '-c:v').length, 1, 'one encoder');
  assert.equal(captureTeeArgs(cap)[captureTeeArgs(cap).indexOf('-vf') + 1], 'fps=30/1');
  assert.ok(args[args.length - 1].includes(`movflags=${MP4_MOVFLAGS}`));
  assert.throws(() => captureTeeArgs({ ...cap, recordingMovflags: '+frag_keyframe+faststart' }), /faststart/);
  assert.throws(() => captureTeeArgs({ ...cap, recordingExtra: ['a=b:c'] }), /key=value/);
});
