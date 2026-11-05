// Run + verify one capture session: helper -> one ffmpeg (tee: MP4 + fifo/FLV) -> local 127.0.0.1 RTMP sink.
//   node dist/testing/decklinkCaptureRun.js --synthetic [--seconds 10] [--loss AT:FOR[:nosignal]] [--out DIR] [--json FILE]
//   node dist/testing/decklinkCaptureRun.js --real     [--seconds 20] ...   (real card; refuses to run if Wirecast is running; max 30 s)
// Media is written under --out (default: a temp dir) and deleted unless --keep is passed. Nothing is ever streamed off-host.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DecklinkCapture, CaptureHelperOptions, CaptureResult, defaultHelperPath } from '../broadcast/decklinkCapture';
import { LocalRtmpSink } from '../broadcast/localRtmpSink';
import { runMedia } from '../broadcast/mediaProcess';
import { ffmpeg, ffprobe } from '../broadcast/runtimeProbe';

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
type Pkt = { pts: number; dts: number; dur: number };
async function packets(file: string, stream: 'v:0' | 'a:0'): Promise<Pkt[]> {
  const r = await runMedia(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'csv=p=0', file], 60000);
  return r.stdout.toString().split('\n').filter(Boolean).map(l => { const [pts, dts, dur] = l.split(',').map(Number); return { pts, dts, dur }; }).filter(p => Number.isFinite(p.dts));
}
function monotonic(p: Pkt[]) { let ok = true, maxGap = 0; for (let i = 1; i < p.length; i++) { if (!(p[i].dts > p[i - 1].dts)) ok = false; maxGap = Math.max(maxGap, p[i].dts - p[i - 1].dts); } return { strictlyIncreasingDts: ok, maxGapMs: round(maxGap * 1000, 1) }; }

export type Verification = Awaited<ReturnType<typeof verifyOutputs>>;
export async function verifyOutputs(mp4: string, sink: LocalRtmpSink | undefined, expectedFrames: number, expectedFps: string) {
  const probe = JSON.parse((await runMedia(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4])).stdout.toString());
  const video = probe.streams.find((s: any) => s.codec_type === 'video'), audio = probe.streams.find((s: any) => s.codec_type === 'audio');
  const decode = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', mp4, '-f', 'null', '-'], 120000).then(r => r.stderr.trim(), e => String(e.message));
  const vp = await packets(mp4, 'v:0'), ap = audio ? await packets(mp4, 'a:0') : [];
  const flv = sink?.segments[0]; const tags = flv?.reader.tags.filter(t => !t.config && t.kind !== 'script') ?? [];
  const vt = tags.filter(t => t.kind === 'video'), at = tags.filter(t => t.kind === 'audio');
  const tsMono = (a: typeof tags) => a.every((t, i) => i === 0 || t.ts >= a[i - 1].ts);
  return {
    video: video && { codec: video.codec_name, width: video.width, height: video.height, pix_fmt: video.pix_fmt, r_frame_rate: video.r_frame_rate, avg_frame_rate: video.avg_frame_rate, color_space: video.color_space, field_order: video.field_order },
    audio: audio ? { codec: audio.codec_name, channels: audio.channels, sample_rate: audio.sample_rate, packets: ap.length, lastDtsS: round(ap.length ? ap[ap.length - 1].dts : 0) } : null,
    frameCount: vp.length, expectedFrames, frameCountErrorPct: round(100 * (vp.length - expectedFrames) / expectedFrames, 2), expectedFps,
    mp4: { timestamps: monotonic(vp), firstPtsS: round(vp[0]?.pts ?? NaN), lastPtsS: round(vp[vp.length - 1]?.pts ?? NaN), audioTimestamps: monotonic(ap), formatDurationS: round(Number(probe.format.duration)), bytes: statSync(mp4).size },
    decodeErrors: decode,
    flv: flv ? { videoTags: vt.length, audioTags: at.length, videoTsMonotonic: tsMono(vt), audioTsMonotonic: tsMono(at), keyFrames: vt.filter(t => t.key).length, connected: flv.connectedAt !== undefined } : null,
  };
}

export type RunOptions = { dir: string; seconds: number; helperOptions: CaptureHelperOptions; port: number; expectedFps?: string; helper?: string };
export async function runCaptureSession(o: RunOptions) {
  mkdirSync(o.dir, { recursive: true });
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const sink = new LocalRtmpSink(ffmpeg, o.dir, o.port, now); await sink.up();
  const mp4 = path.join(o.dir, 'recording.mp4');
  const session = new DecklinkCapture({ ffmpeg, helper: o.helper, helperOptions: { ...o.helperOptions, durationSec: o.seconds }, session: { recordingPath: mp4, publishUrl: sink.url, rwTimeoutMicros: 3_000_000 }, deadlineMs: (o.seconds + 40) * 1000 });
  const started = now(); session.start();
  const result: CaptureResult = await session.wait();
  const wallSeconds = (now() - started) / 1000;
  await new Promise(r => setTimeout(r, 1500)); await sink.close().catch(() => {});
  const fps = o.expectedFps ?? '30/1'; const [n, d] = fps.split('/').map(Number);
  const verification = existsSync(mp4) && statSync(mp4).size > 0 ? await verifyOutputs(mp4, sink, Math.round(o.seconds * n / d), fps) : null;
  return { result, wallSeconds: round(wallSeconds, 2), verification, statuses: result.lines.filter(l => l.type !== 'status'), lastStatus: [...result.lines].reverse().find(l => l.type === 'status') ?? null, mp4 };
}

function arg(name: string, def?: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
async function main() {
  const real = process.argv.includes('--real'), synthetic = process.argv.includes('--synthetic');
  if (real === synthetic) throw new Error('pass exactly one of --real or --synthetic');
  const seconds = Number(arg('--seconds', real ? '20' : '10'));
  if (!(seconds > 0 && seconds <= (real ? 30 : 60))) throw new Error('--seconds out of range');
  if (real) { // hard safety gates for the physical card
    let wirecast = ''; try { wirecast = execFileSync('/usr/bin/pgrep', ['-il', 'wirecast']).toString().trim(); } catch { /* not running */ }
    if (wirecast) throw new Error(`BLOCKED: Wirecast is running (${wirecast}); not touching the capture card`);
  }
  if (!existsSync(defaultHelperPath())) throw new Error(`capture helper not built: ${defaultHelperPath()} (pnpm capture:build)`);
  const dir = arg('--out') ?? mkdtempSync(path.join(os.tmpdir(), 'decklink-capture-'));
  const loss = arg('--loss');
  const helperOptions: CaptureHelperOptions = real ? { channels: 2, sampleBits: 32 } : { synthetic: true, syntheticMode: '1080p30', channels: 2, sampleBits: 32, ...(loss ? { syntheticLoss: loss } : {}) };
  const run = await runCaptureSession({ dir, seconds, helperOptions, port: Number(process.env.BROADCAST_TEST_RTMP_PORT || '19353') });
  const report = { kind: real ? 'real-hardware' : 'synthetic', at: new Date().toISOString(), seconds, helperExit: run.result.helperCode, ffmpegExit: run.result.ffmpegCode, wallSeconds: run.wallSeconds,
    finalHealth: run.result.health, events: run.statuses, lastStatus: run.lastStatus, verification: run.verification, ffmpegStderrTail: run.result.ffmpegStderr.split('\n').slice(-6) };
  const json = arg('--json'); if (json) writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
}
if (require.main === module) main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
