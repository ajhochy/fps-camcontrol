// Issue #68 (S05) proof harness: video content delay and A/V offset through the capture -> ONE FFmpeg -> tee (MP4 + fifo/FLV) path.
//   node dist/testing/delayProof.js --delay N [--mode tpad|setpts] [--mode-name 1080p30|1080p2997] [--seconds S] [--reconnect] [--json FILE] [--keep]
//   node dist/testing/delayProof.js --real --delay N [--seconds S] [--json FILE]     (physical card; refuses if Wirecast runs; <= 30 s; characterizes, cannot prove lip-sync)
// Synthetic source: helper --synthetic-impulse = a white flash frame and a 5 ms 1 kHz click at the SAME stream time every 2 s + a burnt-in frame counter.
// Offsets are measured from DECODED content (flash frame time vs click time, per event), in the MP4 and in the FLV a local 127.0.0.1 sink received.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DecklinkCapture, CaptureHelperOptions, defaultHelperPath } from '../broadcast/decklinkCapture';
import { LocalRtmpSink } from '../broadcast/localRtmpSink';
import { audioPcm, channelStats, clickTimes, flashTimes, frameCounters, videoLuma } from '../broadcast/mediaAnalysis';
import { runMedia } from '../broadcast/mediaProcess';
import { ffmpeg, ffprobe } from '../broadcast/runtimeProbe';
import { VideoDelayMode, videoDelaySeconds } from '../broadcast/teeArgs';

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function arg(name: string, def?: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

/** Pair each flash with the nearest click (events are 2 s apart, delays <= 0.5 s: unambiguous) and report flash-minus-click in ms. */
export function pairEvents(flashes: number[], clicks: number[], fps: number) {
  const pairs = flashes.flatMap(f => { const c = clicks.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return Number.isFinite(c) && Math.abs(c - f) < 0.9 ? [{ flashS: round(f), clickS: round(c), offsetMs: round((f - c) * 1000, 2) }] : []; });
  const off = pairs.map(p => p.offsetMs);
  return { events: pairs.length, pairs, meanMs: off.length ? round(off.reduce((a, b) => a + b, 0) / off.length, 2) : null, minMs: off.length ? Math.min(...off) : null, maxMs: off.length ? Math.max(...off) : null,
    spreadMs: off.length ? round(Math.max(...off) - Math.min(...off), 2) : null, frameMs: round(1000 / fps, 3) };
}
function slope(pairs: { flashS: number; offsetMs: number }[]) {
  const n = pairs.length; if (n < 4) return null; const xs = pairs.map(p => p.flashS), ys = pairs.map(p => p.offsetMs);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const b = sxy / sxx; const resid = ys.reduce((a, y, i) => a + (y - (my + b * (xs[i] - mx))) ** 2, 0); const se = Math.sqrt(resid / (n - 2) / sxx);
  return { msPerSecond: round(b, 5), standardErrorMsPerSecond: round(se, 5), spanS: round(xs[n - 1] - xs[0], 1), extrapolatedMsPerHour: round(b * 3600, 1), extrapolatedMsPerHour_2se: round(2 * se * 3600, 1) };
}
async function analyzeFile(file: string, fps: number, expectedMs: number, withCounters: boolean) {
  const luma = await videoLuma(file), pcm = await audioPcm(file);
  const flashes = flashTimes(luma).map(f => f.pts), clicks = clickTimes(pcm);
  const paired = pairEvents(flashes, clicks, fps);
  const counters = withCounters ? await frameCounters(file) : null;
  const flashCounters = counters ? flashTimes(luma).map(f => counters[f.index]?.n) : null;
  // Origin handling: where the container starts each stream (decoded timeline, -copyts).
  const streams = JSON.parse((await runMedia(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file])).stdout.toString()).streams;
  return { ...paired, expectedMs, errorVsExpectedMs: paired.meanMs === null ? null : round(paired.meanMs - expectedMs, 2), maxAbsErrorFrames: paired.events ? round(Math.max(...paired.pairs.map(p => Math.abs(p.offsetMs - expectedMs))) / paired.frameMs, 3) : null,
    videoFrames: luma.length, audioSeconds: round(pcm.left.length / pcm.rate, 3), flashSourceFrames: flashCounters, clicksSeen: clicks.length, flashesSeen: flashes.length,
    streamStartS: Object.fromEntries(streams.map((s: any) => [s.codec_type, Number(s.start_time)])), drift: slope(paired.pairs), audio: channelStats(pcm) };
}

export type DelayRun = { delayFrames: number; mode: VideoDelayMode; modeName: string; fpsRational: string; seconds: number; reconnect: boolean; real: boolean; dir: string; port?: number };
export async function runDelayCase(o: DelayRun) {
  mkdirSync(o.dir, { recursive: true });
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const sink = new LocalRtmpSink(ffmpeg, o.dir, o.port ?? Number(process.env.BROADCAST_TEST_RTMP_PORT || '19353'), now); await sink.up();
  const mp4 = path.join(o.dir, 'recording.mp4');
  const helperOptions: CaptureHelperOptions = o.real ? { channels: 2, sampleBits: 32, durationSec: o.seconds } : { synthetic: true, syntheticImpulse: true, syntheticMode: o.modeName, channels: 2, sampleBits: 32, durationSec: o.seconds };
  const impulses: { n: number; ptsNs: number; helperMs: number; arrivedMs: number }[] = [];
  const cap = new DecklinkCapture({ ffmpeg, helperOptions, session: { recordingPath: mp4, publishUrl: sink.url, rwTimeoutMicros: 3_000_000, fps: o.fpsRational, videoDelayFrames: o.delayFrames, videoDelayMode: o.mode }, deadlineMs: (o.seconds + 60) * 1000 });
  cap.on('line', (l: any) => { if (l.type === 'event' && l.event === 'impulse') impulses.push({ n: l.n, ptsNs: l.pts_ns, helperMs: l.t_ms, arrivedMs: now() }); });
  const spawnedAt = now(); cap.start();
  const timers: NodeJS.Timeout[] = [];
  const faults: { at: number; action: string }[] = [];
  if (o.reconnect) { timers.push(setTimeout(() => { faults.push({ at: now() - spawnedAt, action: 'sink down' }); void sink.kill(); }, (o.seconds * 0.35) * 1000)); timers.push(setTimeout(() => { faults.push({ at: now() - spawnedAt, action: 'sink up' }); void sink.up(); }, (o.seconds * 0.55) * 1000)); }
  const result = await cap.wait(); timers.forEach(clearTimeout);
  await sleep(1500); await sink.close().catch(() => {});
  const [num, den] = o.fpsRational.split('/').map(Number); const fps = num / den;
  const [dn, dd] = videoDelaySeconds(o.fpsRational, o.delayFrames); const expectedMs = (dn / dd) * 1000;
  const out: any = { delayFrames: o.delayFrames, mode: o.mode, fps: o.fpsRational, expectedDelayExact: `${dn}/${dd} s`, expectedMs: round(expectedMs, 4), real: o.real, seconds: o.seconds, helperExit: result.helperCode, ffmpegExit: result.ffmpegCode, faults };
  out.mp4 = await analyzeFile(mp4, fps, expectedMs, !o.real);
  out.flv = [];
  for (const seg of sink.segments) if (seg.bytes > 20000) {
    const a = await analyzeFile(seg.file, fps, expectedMs, false);
    // Capture-to-sink latency of each flash: helper emitted the impulse (Node saw the JSON line) -> the FLV video tag of that frame reached the local sink.
    const lat: number[] = seg.index > 0 ? [] : a.pairs.map((p: any) => { const tag = seg.reader.tags.find((t: any) => t.kind === 'video' && !t.config && Math.abs(t.ts - p.flashS * 1000) < 1.5); const imp = impulses.reduce((b, x) => (Math.abs(x.ptsNs / 1e9 + (expectedMs + 21.3) / 1000 - p.flashS) < Math.abs(b.ptsNs / 1e9 + (expectedMs + 21.3) / 1000 - p.flashS) ? x : b), impulses[0]); return tag && imp ? round(tag.wall - imp.arrivedMs, 1) : null; }).filter((x: any): x is number => x !== null);
    out.flv.push({ segment: seg.index, bytes: seg.bytes, connectedAtS: seg.connectedAt === undefined ? null : round((seg.connectedAt - spawnedAt) / 1000, 2), ...a, flashToSinkLatencyMs: lat.length ? { n: lat.length, perEvent: lat, firstEventExcluded: lat.length > 1 ? (() => { const st = lat.slice(1); return { n: st.length, min: Math.min(...st), median: [...st].sort((x, y) => x - y)[Math.floor(st.length / 2)], max: Math.max(...st) }; })() : null } : null });
  }
  out.lastStatus = [...result.lines].reverse().find(l => l.type === 'status') ?? null;
  return out;
}

function guardReal() {
  let w = ''; try { w = execFileSync('/usr/bin/pgrep', ['-il', 'wirecast']).toString().trim(); } catch { /* not running */ }
  if (w) throw new Error(`BLOCKED: Wirecast is running (${w}); not touching the capture card`);
  if (!existsSync(defaultHelperPath())) throw new Error(`capture helper not built: ${defaultHelperPath()}`);
}
async function main() {
  const real = process.argv.includes('--real'); if (real) guardReal();
  const modeName = arg('--mode-name', '1080p30')!; const fpsRational = modeName === '1080p2997' ? '30000/1001' : '30/1';
  const seconds = Number(arg('--seconds', real ? '20' : '16')); if (!(seconds > 0 && seconds <= (real ? 30 : 60))) throw new Error('--seconds out of range');
  const dir = path.join(arg('--out') ?? mkdtempSync(path.join(os.tmpdir(), 'delay-')), `d${arg('--delay', '0')}-${arg('--mode', 'tpad')}-${modeName}-${Date.now() % 100000}`);
  const report = await runDelayCase({ delayFrames: Number(arg('--delay', '0')), mode: arg('--mode', 'tpad') as VideoDelayMode, modeName, fpsRational, seconds, reconnect: process.argv.includes('--reconnect'), real, dir });
  const j = arg('--json'); if (j) writeFileSync(j, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2) + '\n');
  const brief = (x: any) => ({ events: x.events, meanMs: x.meanMs, errorVsExpectedMs: x.errorVsExpectedMs, minMs: x.minMs, maxMs: x.maxMs, maxAbsErrorFrames: x.maxAbsErrorFrames });
  console.log(JSON.stringify({ delay: report.delayFrames, mode: report.mode, fps: report.fps, expectedMs: report.expectedMs, mp4: brief(report.mp4), flv: report.flv.map((f: any) => ({ segment: f.segment, ...brief(f), latency: f.flashToSinkLatencyMs?.firstEventExcluded ?? null })) }, null, 2));
  if (!process.argv.includes('--keep')) rmSync(arg('--out') ? dir : path.dirname(dir), { recursive: true, force: true });
}
if (require.main === module) main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
