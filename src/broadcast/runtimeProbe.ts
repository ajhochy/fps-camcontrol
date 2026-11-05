import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MediaProcess, runMedia, stopOwned } from './mediaProcess';
import { remuxArgs, rtmpUrl, syntheticEncodeArgs } from './ffmpegArgs';

export const ffmpeg = process.env.BROADCAST_FFMPEG || '/opt/homebrew/bin/ffmpeg';
export const ffprobe = process.env.BROADCAST_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe');
export async function probeFile(file: string) {
  const result = await runMedia(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(result.stdout.toString());
}
export async function decodeFile(file: string) {
  const result = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], 120000);
  assert.equal(result.stderr.trim(), '', `Decode errors: ${result.stderr}`); return result.pid;
}
export async function runtimeProbe(directory: string, seconds = 8) {
  await mkdir(directory, { recursive: true });
  const version = await runMedia(ffmpeg, ['-version']);
  const ts = path.join(directory, 'runtime.ts');
  const args = syntheticEncodeArgs({ width: 1280, height: 720, fps: '30000/1001', delayFrames: 3, seconds });
  args.splice(args.length - 1, 1, ts); args.push('-y');
  const encode = await runMedia(ffmpeg, args, (seconds + 15) * 1000);
  const streams = await probeFile(ts);
  assert.equal(streams.streams[0].codec_name, 'h264');
  assert.equal(streams.streams[1].codec_name, 'aac');
  assert.equal(streams.streams[1].sample_rate, '48000');
  assert.equal(streams.streams[1].channels, 2);
  const mp4 = path.join(directory, 'runtime.mp4');
  const recorder = new MediaProcess(ffmpeg, remuxArgs(mp4, 'mp4'), 30000);
  recorder.child.stdin.end(await readFile(ts));
  const recording = await recorder.done; assert.equal(recording.code, 0, recording.stderr);
  const flv = path.join(directory, 'received.flv');
  const listener = new MediaProcess(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'warning', '-listen', '1', '-timeout', '10', '-i', rtmpUrl(), '-c', 'copy', '-f', 'flv', '-y', flv], 30000);
  // Listener readiness cannot be tested with a TCP preflight: that consumes its single RTMP connection.
  await new Promise(resolve => setTimeout(resolve, 600));
  const publisher = new MediaProcess(ffmpeg, remuxArgs(rtmpUrl(), 'flv'), 30000);
  publisher.child.stdin.end(await readFile(ts));
  const published = await publisher.done; assert.equal(published.code, 0, published.stderr);
  const received = await listener.done; assert.equal(received.code, 0, received.stderr);
  await decodeFile(mp4); await decodeFile(flv);
  const evidence = { status: 'CAPABILITY_BUILT', developerOnly: true, packagedQualified: false, version: version.stdout.toString(), encode, recording, published, received, streams };
  await writeFile(path.join(directory, 'runtime-evidence.json'), JSON.stringify(evidence, null, 2));
  return { ts, mp4, flv, evidence };
}
export async function cleanupRuntime(): Promise<void> { await stopOwned(); }
