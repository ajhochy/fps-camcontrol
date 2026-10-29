import assert from 'node:assert/strict';
import { runMedia } from './mediaProcess';
import { frameRate } from './ffmpegArgs';

export async function probeOffset(ffmpeg: string, file: string, fps: string, delayFrames: number) {
  // Separate filters avoid an audio/video timestamp projection pretending to prove content.
  const flashes: number[] = [], bursts: number[] = [];
  const collect = (pattern: RegExp, values: number[]) => {
    let pending = '';
    return (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/[\r\n]/); pending = lines.pop()!.slice(-1024);
      for (const line of lines) for (const match of line.matchAll(pattern)) values.push(Number(match[1]));
    };
  };
  const video = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-i', file, '-an', '-vf', 'blackdetect=d=0.001:pix_th=0.1', '-f', 'null', '-'], 120000, collect(/black_end:([\d.]+)/g, flashes));
  const audio = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-i', file, '-vn', '-af', 'silencedetect=n=-35dB:d=0.01:mono=1', '-f', 'null', '-'], 120000, collect(/channel: 0 \| silence_end: ([\d.]+)/g, bursts));
  // Synthetic sessions end on black. blackdetect also reports black_end at EOF, not a flash.
  flashes.pop();
  assert.ok(flashes.length >= 3 && bursts.length >= 3, `Insufficient content events: ${JSON.stringify({ flashes, bursts, audio: audio.stderr })}`);
  const expected = delayFrames / frameRate(fps);
  // Expected maximum delay is 0.6s < half the 2s period: unique pairing, not modulo-period equality.
  const pairs = flashes.map(flash => {
    const candidates = bursts.filter(burst => Math.abs(flash - burst - expected) < 0.8);
    assert.equal(candidates.length, 1, 'Ambiguous/missing periodic content pairing');
    return { flash, burst: candidates[0], offset: flash - candidates[0] };
  });
  const selected = [pairs[0], pairs[Math.floor(pairs.length / 2)], pairs[pairs.length - 1]];
  for (const pair of selected) assert.ok(Math.abs(pair.offset - expected) <= 1 / frameRate(fps), `Content offset ${pair.offset}, expected ${expected} at ${pair.flash}`);
  return { expected, pairs: selected, videoPid: video.pid, audioPid: audio.pid };
}
