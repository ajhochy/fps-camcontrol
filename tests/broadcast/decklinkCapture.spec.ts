import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyCaptureLine, captureHelperArgs, CaptureLineParser, initialHealth, isStale, parseCaptureLine } from '../../src/broadcast/decklinkCapture';
import { captureTeeArgs, PROGRAM_PROFILE } from '../../src/broadcast/teeArgs';

const status = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'status', t_ms: 1000, state: 'running', mode: '1080p30', width: 1920, height: 1080, fps_nominal: 30, fps: 30, signal_locked: true, audio_present: false,
  frames_in: 30, frames_out: 30, filler_frames: 0, dropped_backpressure: 0, dropped_late: 0, audio_resyncs: 0, audio_dropped: 0, queue_depth: 0, queue_cap: 12, blocked_ms: 0, max_block_ms: 0, bytes_out: 1, ...over });
const rec = { recordingPath: '/tmp/x/rec.mp4', publishUrl: 'rtmp://127.0.0.1:19353/live/s1' };

test('status parser: partial chunks, noise, bounded lines', () => {
  const p = new CaptureLineParser(); const line = status();
  assert.deepEqual(p.push(line.slice(0, 40)), []);
  const out = p.push(line.slice(40) + '\nnot json\n{"type":"unknown"}\n{"type":"event","event":"signal","locked":false,"t_ms":5}\n');
  assert.equal(out.length, 2); assert.equal(out[0].type, 'status'); assert.equal(out[1].type, 'event');
  assert.equal(parseCaptureLine('{"type":"status"' + 'x'.repeat(20000)), null);
  assert.equal(new CaptureLineParser().push('x'.repeat(40000)).length, 0);
});

test('health: absent signal on a healthy process is signal-lost (not failed); errors and exits are explicit', () => {
  let h = initialHealth(); assert.equal(h.state, 'starting');
  h = applyCaptureLine(h, parseCaptureLine(status({ state: 'waiting-signal' }))!); assert.equal(h.state, 'waiting-signal');
  h = applyCaptureLine(h, parseCaptureLine(status())!, 10_000); assert.equal(h.state, 'running'); assert.equal(h.fps, 30);
  h = applyCaptureLine(h, parseCaptureLine(status({ signal_locked: false, filler_frames: 45 }))!, 11_000);
  assert.equal(h.state, 'signal-lost'); assert.equal(h.signalLocked, false); assert.equal(h.fillerFrames, 45);
  assert.equal(isStale(h, 11_000 + 4_000), false); assert.equal(isStale(h, 11_000 + 6_000), true);
  h = applyCaptureLine(h, parseCaptureLine(status({ device_ok: false }))!, 12_000); assert.equal(h.deviceOk, false);
  const busy = applyCaptureLine(initialHealth(), parseCaptureLine('{"type":"error","code":"device-busy","message":"busy","exit":4,"t_ms":3}')!);
  assert.deepEqual(busy.error, { code: 'device-busy', message: 'busy', exit: 4 }); assert.equal(busy.state, 'failed');
  assert.equal(applyCaptureLine(busy, { type: 'exit', code: 4, frames_in: 0, frames_out: 0, filler_frames: 0, dropped_backpressure: 0, dropped_late: 0, bytes_out: 0 }).state, 'failed');
  assert.equal(applyCaptureLine(h, { type: 'exit', code: 0, frames_in: 1, frames_out: 1, filler_frames: 0, dropped_backpressure: 0, dropped_late: 0, bytes_out: 0 }).state, 'stopped');
  assert.equal(isStale({ ...h, state: 'stopped' }, 1e12), false);
  assert.equal(applyCaptureLine(h, { type: 'event', event: 'started', t_ms: 1, interlaced: true, mode: '1080i5994', width: 1920, height: 1080 }).interlaced, true);
});

test('helper args are validated and never shell-interpolated', () => {
  assert.deepEqual(captureHelperArgs(), []);
  assert.deepEqual(captureHelperArgs({ device: 'UltraStudio Recorder 3G', mode: '1080p30', channels: 2, sampleBits: 32, queueFrames: 12, durationSec: 20 }),
    ['--device', 'UltraStudio Recorder 3G', '--mode', '1080p30', '--channels', '2', '--sample-bits', '32', '--queue-frames', '12', '--duration', '20']);
  assert.deepEqual(captureHelperArgs({ synthetic: true, syntheticMode: '1080p30', syntheticLoss: '2:1.5:nosignal' }), ['--synthetic', '--synthetic-mode', '1080p30', '--synthetic-loss', '2:1.5:nosignal']);
  assert.throws(() => captureHelperArgs({ device: 'a; rm -rf /' }), /unsupported characters/);
  assert.throws(() => captureHelperArgs({ channels: 4 as 2 }), /2, 8 or 16/);
  assert.throws(() => captureHelperArgs({ sampleBits: 24 as 16 }), /16 or 32/);
  assert.throws(() => captureHelperArgs({ queueFrames: 1 }), /queueFrames/);
  assert.throws(() => captureHelperArgs({ synthetic: true, syntheticLoss: 'x' }), /AT:FOR/);
});

test('capture session: ONE ffmpeg reads the helper stream on stdin, encodes once, tees MP4 slave 0 + isolated fifo publisher at 1080p30 (30/1)', () => {
  assert.equal(PROGRAM_PROFILE.fps, '30/1');
  const args = captureTeeArgs(rec);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 4), ['-f', 'matroska', '-i', 'pipe:0']);
  assert.equal(args.filter(a => a === '-i').length, 1, 'single input');
  assert.ok(!args.includes('-re') && !args.includes('lavfi'), 'capture is paced by the card, not by -re/lavfi');
  assert.equal(args[args.indexOf('-vf') + 1], 'fps=30/1');
  assert.equal(args[args.indexOf('-g') + 1], '60'); assert.equal(args[args.indexOf('-b:v') + 1], '6000k');
  assert.equal(args[args.indexOf('-colorspace') + 1], 'bt709'); assert.equal(args[args.indexOf('-color_range') + 1], 'tv');
  const spec = args[args.length - 1]; assert.equal(args[args.length - 2], 'tee');
  assert.ok(spec.startsWith('[f=mp4:movflags=+frag_keyframe+hybrid_fragmented:flush_packets=1:onfail=ignore]/tmp/x/rec.mp4|[f=fifo:fifo_format=flv:queue_size=60:drop_pkts_on_overflow=1:'));
  assert.ok(args.includes('aresample=async=1000:first_pts=0'));
  assert.ok(!args.join(' ').includes('30000/1001'), 'no 29.97 anywhere in the program profile');
  assert.equal(captureTeeArgs({ ...rec, fps: '30000/1001' })[captureTeeArgs({ ...rec, fps: '30000/1001' }).indexOf('-g') + 1], '60');
  assert.throws(() => captureTeeArgs({ ...rec, fps: '30' }), /qualified rational/);
  assert.throws(() => captureTeeArgs({ ...rec, fps: '60/1' }), /qualified rational/);
  assert.throws(() => captureTeeArgs({ ...rec, audioChannels: 8 }), /stereo/);
  assert.throws(() => captureTeeArgs({ ...rec, width: 3840, height: 2160 }), /1080p/);
  assert.throws(() => captureTeeArgs({ ...rec, publishUrl: 'rtmps://a.rtmps.youtube.com/live2/key' }), /local 127\.0\.0\.1/);
  assert.throws(() => captureTeeArgs({ ...rec, recordingPath: '/tmp/a|b.mp4' }), /reserved/);
  assert.throws(() => captureTeeArgs({ ...rec, videoBitrateK: 10 }), /videoBitrateK/);
});

// --- hardware-free end-to-end: real helper binary (synthetic producer) -> real ffmpeg -> MP4 + local RTMP sink ---
const ffmpegPath = process.env.BROADCAST_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const root = path.resolve(__dirname, '../..');
let helper: string | undefined; let buildDir: string | undefined;
function buildHelper(): string | undefined {
  if (helper) return helper;
  if (process.env.CAMCONTROL_CAPTURE_TEST_BIN && existsSync(process.env.CAMCONTROL_CAPTURE_TEST_BIN)) return (helper = process.env.CAMCONTROL_CAPTURE_TEST_BIN);
  if (spawnSync('clang++', ['--version']).status !== 0) return undefined;
  buildDir = mkdtempSync(path.join(os.tmpdir(), 'capture-build-'));
  execFileSync('make', ['-C', path.join(root, 'native/decklink-capture'), `BUILD=${buildDir}`, `${buildDir}/camcontrol-capture`], { stdio: 'ignore' });  // synthetic-only: no SDK needed
  return (helper = path.join(buildDir, 'camcontrol-capture'));
}
const e2e = (name: string, fn: (bin: string, runner: typeof import('../../src/testing/decklinkCaptureRun')) => Promise<void>) =>
  test(name, { skip: !existsSync(ffmpegPath) ? 'ffmpeg not installed' : false, timeout: 120_000 }, async t => {
    const bin = buildHelper(); if (!bin) return t.skip('no C++ compiler');
    await fn(bin, await import('../../src/testing/decklinkCaptureRun'));
  });

e2e('synthetic capture: helper -> one ffmpeg -> MP4 + FLV, 1080p30, frame count, monotonic timestamps, audio track', async (bin, { runCaptureSession }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-spec-'));
  try {
    const run = await runCaptureSession({ dir, seconds: 6, helper: bin, port: 19353, helperOptions: { synthetic: true, syntheticMode: '1080p30', channels: 2, sampleBits: 32 } });
    assert.equal(run.result.helperCode, 0); assert.equal(run.result.ffmpegCode, 0);
    const v = run.verification!;
    assert.equal(v.video!.width, 1920); assert.equal(v.video!.height, 1080); assert.equal(v.video!.r_frame_rate, '30/1'); assert.equal(v.video!.codec, 'h264');
    assert.ok(Math.abs(v.frameCountErrorPct) <= 2, `frame count ${v.frameCount}/${v.expectedFrames}`);
    assert.equal(v.decodeErrors, ''); assert.ok(v.mp4.timestamps.strictlyIncreasingDts && v.mp4.audioTimestamps.strictlyIncreasingDts);
    assert.equal(v.audio!.codec, 'aac'); assert.equal(v.audio!.channels, 2);
    assert.ok(v.flv!.connected && v.flv!.videoTsMonotonic && v.flv!.audioTsMonotonic && v.flv!.videoTags >= v.frameCount - 3, JSON.stringify(v.flv));
    assert.equal(run.result.health.state, 'stopped'); assert.equal(run.result.health.fillerFrames, 0);
    assert.ok(run.result.health.audioPresent && run.result.health.audioPackets && Math.abs((run.result.health.audioPeakDbfs ?? -999) + 6.02) < 0.5, 'synthetic tone is reported at about -6 dBFS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

e2e('synthetic signal loss keeps the MP4/stream timeline continuous (filler) and reports lost/regained', async (bin, { runCaptureSession }) => {
  for (const kind of ['stall', 'nosignal']) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-spec-'));
    try {
      const run = await runCaptureSession({ dir, seconds: 7, helper: bin, port: 19353, helperOptions: { synthetic: true, syntheticLoss: `2:2:${kind}` } });
      const v = run.verification!;
      assert.equal(run.result.helperCode, 0); assert.ok(Math.abs(v.frameCountErrorPct) <= 2, `${kind}: ${v.frameCount}/${v.expectedFrames}`);
      assert.equal(v.decodeErrors, ''); assert.ok(v.mp4.timestamps.strictlyIncreasingDts);
      assert.ok(v.mp4.timestamps.maxGapMs < 120, `${kind}: max video gap ${v.mp4.timestamps.maxGapMs} ms`);
      assert.ok(v.mp4.audioTimestamps.maxGapMs < 120 && v.audio!.lastDtsS > 6.5, `${kind}: audio continuity`);
      const signal = run.result.lines.filter(l => l.type === 'event' && l.event === 'signal').map(l => (l as { locked: boolean }).locked);
      assert.deepEqual(signal, [true, false, true], `${kind}: signal transitions`);
      assert.ok(run.result.health.fillerFrames >= 50, `${kind}: filler ${run.result.health.fillerFrames}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('synthetic-only helper build reports a JSON error (exit 3) for device operations', { skip: !existsSync(ffmpegPath) }, t => {
  const bin = buildHelper(); if (!bin) return t.skip('no C++ compiler');
  if (process.env.CAMCONTROL_CAPTURE_TEST_BIN) return t.skip('SDK build supplied');
  const r = spawnSync(bin, ['--list-devices'], { encoding: 'utf8' });
  assert.equal(r.status, 3); assert.equal(JSON.parse(r.stderr.trim().split('\n').pop()!).code, 'no-decklink');
});

test.after(() => { if (buildDir) rmSync(buildDir, { recursive: true, force: true }); });
