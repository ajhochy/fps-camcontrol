// Issue #66 proof harness: static single-process FFmpeg `tee` + `fifo` with fault injection.
// Synthetic lavfi sources only; local 127.0.0.1 RTMP sink only; short (<= 60 s) serial runs under nice(1).
//   node dist/testing/broadcastTeeProof.js [--scenario <name>|--all] [--summary <path.json>] [--keep]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, existsSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MediaProcess, niceFfmpeg, runMedia, stopOwned } from '../broadcast/mediaProcess';
import { teeSessionArgs, TeeSession } from '../broadcast/teeArgs';
import { LocalRtmpSink, SinkOptions, SinkSegment } from '../broadcast/localRtmpSink';
import { FlvTag } from '../broadcast/flvTags';

const ffmpeg = process.env.BROADCAST_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ffprobe = process.env.BROADCAST_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe');
const FPS = 30, FRAME_MS = 1000 / FPS;
const PORT = Number(process.env.BROADCAST_TEST_RTMP_PORT || '19351');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- analysis helpers ----------
async function packetTimes(file: string, kind: 'v' | 'a'): Promise<number[]> {
  const r = await runMedia(ffprobe, ['-v', 'error', '-select_streams', `${kind}:0`, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], 60000);
  return r.stdout.toString().split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
}
function gaps(times: number[]) { const d = times.slice(1).map((t, i) => t - times[i]); return { max: d.length ? Math.max(...d) : 0, count: d.length }; }
async function decodeErrors(file: string): Promise<number> {
  const child = new MediaProcess(...(Object.values(niceFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'])) as [string, string[]]), 120000, true);
  child.child.stdin.end(); const r = await child.done;
  return r.stderr.split('\n').filter(l => l.trim()).length;
}
// Goertzel magnitude of `hz` in a window of float samples.
function goertzel(x: Float32Array, hz: number, rate = 48000): number {
  const w = 2 * Math.PI * hz / rate, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) * 2 / x.length;
}
export async function channelProof(file: string, left = 440, right = 1000) {
  const child = new MediaProcess(...(Object.values(niceFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'])) as [string, string[]]), 120000, true);
  child.child.stdin.end(); const r = await child.done;
  const samples = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const window = 4800, frames = Math.floor(samples.length / 2 / window); // 100 ms
  let intact = 0, silent = 0, swapped = 0, leak = 0, minL = Infinity, minR = Infinity;
  for (let w = 0; w < frames; w++) {
    const L = new Float32Array(window), R = new Float32Array(window);
    for (let i = 0; i < window; i++) { L[i] = samples[(w * window + i) * 2]; R[i] = samples[(w * window + i) * 2 + 1]; }
    const l1 = goertzel(L, left), l2 = goertzel(L, right), r1 = goertzel(R, left), r2 = goertzel(R, right);
    if (Math.max(l1, l2, r1, r2) < 0.05) { silent++; continue; }
    if (l1 > 0.6 && r2 > 0.6 && l2 < 0.05 && r1 < 0.05) { intact++; minL = Math.min(minL, l1); minR = Math.min(minR, r2); }
    else if (l2 > 0.6 && r1 > 0.6) swapped++; else leak++;
  }
  return { windows100ms: frames, intact, silent, swapped, mixedOrDamaged: leak, minLeftAmplitude440: intact ? round(minL, 3) : null, minRightAmplitude1000: intact ? round(minR, 3) : null, pass: frames > 0 && intact === frames - silent && swapped === 0 && leak === 0 && intact > 0 };
}
function tagStats(tags: FlvTag[], wallBase: number) {
  const media = tags.filter(t => t.kind !== 'script' && !t.config);
  const video = media.filter(t => t.kind === 'video'), audio = media.filter(t => t.kind === 'audio');
  const vts = video.map(t => t.ts);
  const jumps: { atTs: number; gapMs: number; nextIsKey: boolean }[] = [];
  for (let i = 1; i < video.length; i++) if (video[i].ts - video[i - 1].ts > 3 * FRAME_MS) jumps.push({ atTs: video[i - 1].ts, gapMs: video[i].ts - video[i - 1].ts, nextIsKey: video[i].key });
  // Simulated decoder: after a gap only a key frame restores decodability.
  let broken = false, undecodable = 0;
  video.forEach((t, i) => { if (i > 0 && t.ts - video[i - 1].ts > 3 * FRAME_MS) broken = true; if (t.key) broken = false; else if (broken) undecodable++; });
  return { video: video.length, audio: audio.length, firstVideoIsKey: video.length ? video[0].key : null, tsFirstMs: vts.length ? vts[0] : null, tsLastMs: vts.length ? vts[vts.length - 1] : null,
    jumps, undecodableVideoFramesAfterGaps: undecodable, firstArrivalMs: media.length ? round(media[0].wall - wallBase) : null };
}
type RecPacket = { pts: number; key: boolean; hash: string };
async function recordingVideo(file: string): Promise<RecPacket[]> {
  const r = await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_data_hash', 'md5', '-show_entries', 'packet=pts_time,flags,data_hash', '-of', 'csv=p=0', file], 60000);
  return r.stdout.toString().split('\n').filter(Boolean).map(l => { const [pts, flags, hash] = l.split(','); return { pts: Number(pts), key: flags.startsWith('K'), hash: hash.replace('MD5:', '') }; }).sort((a, b) => a.pts - b.pts);
}
// Map every received video frame back to the recorded frame (same encoded packet); frames the receiver never got are the drops.
function matchSegment(rec: RecPacket[], seg: SinkSegment | SinkSegment[], base: number) {
  const byHash = new Map(rec.map((p, i) => [p.hash, i]));
  const segs = Array.isArray(seg) ? seg : [seg];
  const got = segs.flatMap(sg => sg.reader.tags).filter(t => t.kind === 'video' && !t.config).map(t => ({ idx: byHash.get(t.md5!) ?? -1, wall: t.wall, key: t.key }));
  const runs: { fromFrame: number; toFrame: number; startsWithKey: boolean; frames: number }[] = [];
  for (const g of got) {
    if (g.idx < 0) continue;
    const last = runs[runs.length - 1];
    if (last && g.idx === last.toFrame + 1) { last.toFrame = g.idx; last.frames++; } else runs.push({ fromFrame: g.idx, toFrame: g.idx, startsWithKey: rec[g.idx].key, frames: 1 });
  }
  let undecodable = 0; // frames inside a run that starts without a key frame, until the next key frame
  for (const run of runs) if (!run.startsWithKey) for (let i = run.fromFrame; i <= run.toFrame && !rec[i].key; i++) undecodable++;
  const dropped = runs.slice(1).map((r, i) => ({ afterFrame: runs[i].toFrame, frames: r.fromFrame - runs[i].toFrame - 1, seconds: round((rec[r.fromFrame].pts - rec[runs[i].toFrame].pts) , 2) })).filter(d => d.frames > 0);
  return { got, runs, dropped, unmatched: got.filter(g => g.idx < 0).length, undecodableFramesAfterDrops: undecodable };
}
async function readBoxes(file: string): Promise<string[]> {
  const { readFile } = await import('node:fs/promises'); const b = await readFile(file); const out: string[] = []; let o = 0;
  while (o + 8 <= b.length) { const size = b.readUInt32BE(o); out.push(b.toString('ascii', o + 4, o + 8)); if (size < 8) break; o += size; }
  return out.length > 12 ? [...out.slice(0, 6), `... ${out.length - 8} more`, ...out.slice(-2)] : out;
}
// Intervals between the fifo's recovery attempts while the endpoint was down (FFmpeg exposes a fixed interval, no backoff).
function retryCadence(lines: { at: number; line: string }[]) {
  const t = lines.filter(l => /Recovery failed/.test(l.line)).map(l => l.at);
  const d = t.slice(1).map((x, i) => round(x - t[i], 2));
  return { failedAttempts: t.length, firstAtS: t[0], intervalsS: d.length ? { min: Math.min(...d), median: median(d), max: Math.max(...d) } : null };
}
function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

// ---------- session runner ----------
type Fault = { at: number; action: 'killSink' | 'restartSink' | 'stall' | 'resume' };
type Options = { sinkOptions?: SinkOptions; name: string; session: Partial<TeeSession> & { seconds: number }; faults?: Fault[]; sink?: boolean; recordingFd?: boolean; recordingPath?: string; fileSizeLimitBlocks?: number; };
async function runSession(root: string, opt: Options) {
  const dir = path.join(root, opt.name); mkdirSync(dir, { recursive: true });
  const recordingPath = opt.recordingPath ?? path.join(dir, 'recording.mp4');
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const sink = new LocalRtmpSink(ffmpeg, dir, PORT, now, opt.sinkOptions);
  const hasSink = opt.sink !== false;
  if (hasSink) await sink.up();
  // Optional: the supervisor (this process) opens the recording itself (O_CREAT|O_EXCL: never overwrite) and hands FFmpeg the descriptor.
  const recordingFd = opt.recordingFd ? openSync(recordingPath, 'wx+') : undefined;
  const session: TeeSession = { width: 640, height: 360, fps: FPS, recordingPath: recordingFd === undefined ? recordingPath : '/dev/fd/3', publishUrl: sink.url, ...opt.session };
  const wrapped = niceFfmpeg(ffmpeg, teeSessionArgs(session), { fileSizeLimitBlocks: opt.fileSizeLimitBlocks });
  const lines: { at: number; line: string }[] = [];
  const progress: { at: number; mediaS: number }[] = [];
  let pending = '';
  const spawnedAt = now();
  const proc = new MediaProcess(wrapped.binary, wrapped.args, (opt.session.seconds + 30) * 1000, false, (chunk: Buffer) => {
    pending += chunk.toString(); const parts = pending.split(/[\r\n]/); pending = parts.pop()!.slice(-2000);
    for (const line of parts) {
      const m = /^frame=.*\btime=(\d+):(\d+):([\d.]+)/.exec(line);
      if (m) progress.push({ at: (now() - spawnedAt) / 1000, mediaS: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) });
    }
    for (const line of parts) if (/fifo|tee|rtmp|ecover|rror|ail|drop|ull|overflow|Slave|muxing|Connection/i.test(line) && !/^frame=/.test(line) && lines.length < 400) lines.push({ at: round((now() - spawnedAt) / 1000, 2), line: line.slice(0, 220) });
  }, recordingFd === undefined ? [] : [recordingFd]);
  proc.child.stdin.end();
  const rss: { at: number; kb: number }[] = [];
  const sample = setInterval(() => { try { const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(proc.child.pid)]).toString().trim()); rss.push({ at: round((now() - spawnedAt) / 1000), kb }); } catch { /* exited */ } }, 1000);
  const faultLog: { plannedAt: number; actualAt: number; action: string; doneAt?: number }[] = [];
  const timers = (opt.faults ?? []).map(f => setTimeout(async () => {
    const entry = { plannedAt: f.at, actualAt: round((now() - spawnedAt) / 1000, 2), action: f.action } as any; faultLog.push(entry);
    if (f.action === 'killSink') await sink.kill(); else if (f.action === 'restartSink') await sink.up(); else if (f.action === 'stall') sink.stall(); else sink.resume();
    entry.doneAt = round((now() - spawnedAt) / 1000, 2);
  }, f.at * 1000));
  let exit: Awaited<typeof proc.done>;
  try { exit = await proc.done; } finally { timers.forEach(clearTimeout); clearInterval(sample); if (recordingFd !== undefined) closeSync(recordingFd); }
  const wallSeconds = (now() - spawnedAt) / 1000;
  await sleep(1500); // let the last received tags drain through the sink
  await sink.close().catch(() => {});
  // Encoder progress: longest interval in which wall time advanced more than media time = encoder/tee blocked (back-pressure).
  let maxBlockedS = 0;
  for (let i = 1; i < progress.length; i++) maxBlockedS = Math.max(maxBlockedS, (progress[i].at - progress[i - 1].at) - (progress[i].mediaS - progress[i - 1].mediaS));
  const finalLagS = progress.length ? progress[progress.length - 1].at - progress[progress.length - 1].mediaS : 0;
  return { encoderBackpressure: { maxBlockedS: round(maxBlockedS, 2), finalWallMinusMediaS: round(finalLagS, 2), statsSamples: progress.length }, dir, recordingPath, session, exit: { code: exit.code, signal: exit.signal }, wallSeconds: round(wallSeconds, 2), spawnedAt, sink, lines, rss, faultLog, now, sinkEvents: sink.events.map(e => ({ at: round((e.at - spawnedAt) / 1000, 2), event: e.event })) };
}
// Worst-case content of a full fifo queue for the recorded stream: max bytes and max media span over any N consecutive packets (video+audio interleaved).
async function queueWindows(file: string, sizes: number[]) {
  const r = await runMedia(ffprobe, ['-v', 'error', '-show_entries', 'packet=dts_time,size', '-of', 'csv=p=0', file], 60000);
  const pk = r.stdout.toString().split('\n').filter(Boolean).map(l => { const [t, sz] = l.split(','); return { t: Number(t), sz: Number(sz) }; }).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const out: Record<string, { maxBytes: number; maxSpanMs: number }> = {};
  for (const n of sizes) {
    let maxBytes = 0, maxSpan = 0, sum = 0;
    for (let i = 0; i < pk.length; i++) { sum += pk[i].sz; if (i >= n) sum -= pk[i - n].sz; if (i >= n - 1) { maxBytes = Math.max(maxBytes, sum); maxSpan = Math.max(maxSpan, pk[i].t - pk[i - n + 1].t); } }
    out[`queue_size=${n}`] = { maxBytes, maxSpanMs: round(maxSpan * 1000) };
  }
  return out;
}
async function recordingReport(file: string, wallSeconds: number, seconds: number) {
  if (!existsSync(file)) return { exists: false };
  const v = await packetTimes(file, 'v'), a = await packetTimes(file, 'a');
  const errors = await decodeErrors(file);
  const vg = gaps(v), ag = gaps(a);
  return { exists: true, bytes: statSync(file).size, videoFrames: v.length, expectedVideoFrames: seconds * FPS, audioPackets: a.length, videoSpanS: round(v.length ? v[v.length - 1] - v[0] + 1 / FPS : 0, 3),
    maxVideoGapMs: round(vg.max * 1000, 1), videoGapsOver2Frames: v.slice(1).filter((t, i) => t - v[i] > 2 / FPS).length,
    maxAudioGapMs: round(ag.max * 1000, 1), audioGapsOver3Packets: a.slice(1).filter((t, i) => t - a[i] > 3 * 1024 / 48000).length,
    decodeErrorLines: errors, wallSeconds };
}
function segmentReport(seg: SinkSegment, base: number) {
  return { index: seg.index, bytes: seg.bytes, connectedAtS: seg.connectedAt === undefined ? null : round((seg.connectedAt - base) / 1000, 2), firstTagAtS: seg.firstTagAt === undefined ? null : round((seg.firstTagAt - base) / 1000, 2), closedAtS: seg.closedAt === undefined ? null : round((seg.closedAt - base) / 1000, 2), ...tagStats(seg.reader.tags, base) };
}
// Steady-state delivery offset (arrival wall minus media ts) from the first segment's early tags; age(tag) = offset(tag) - steady.
function ageProfile(sink: LocalRtmpSink, base: number, steadyUntilS = 7, steadyFromS = 3) {
  const all = sink.segments.flatMap(s => s.reader.tags.filter(t => t.kind !== 'script' && !t.config).map(t => ({ ...t, seg: s.index })));
  const early = all.filter(t => t.seg === 0 && (t.wall - base) / 1000 < steadyUntilS && (t.wall - base) / 1000 >= steadyFromS && t.kind === 'video');
  const steady = median(early.map(t => t.wall - base - t.ts));
  return { steadyOffsetMs: round(steady), age: (t: { wall: number; ts: number }) => t.wall - base - t.ts - steady, all };
}

// Age of each received video frame on arrival = arrival wall - recorded pts, relative to the steady-state offset (receiver probing excluded by steadyFrom).
function matchedAge(rec: RecPacket[], sink: LocalRtmpSink, base: number, steadyFromS: number, steadyUntilS: number) {
  // Later segments subtract the receiver's own probe latency (connect -> first tag, measured on segment 0) so only publisher-side staleness remains.
  const first = sink.segments[0], probeMs = first?.connectedAt !== undefined && first.firstTagAt !== undefined ? first.firstTagAt - first.connectedAt : 0;
  const rows = sink.segments.flatMap(seg => matchSegment(rec, seg, base).got.filter(g => g.idx >= 0).map(g => ({ idx: g.idx, seg: seg.index, wall: g.wall, offset: g.wall - base - rec[g.idx].pts * 1000 - (seg.index > 0 ? probeMs : 0) })));
  const steady = median(rows.filter(x => x.seg === 0 && (x.wall - base) / 1000 >= steadyFromS && (x.wall - base) / 1000 <= steadyUntilS).map(x => x.offset));
  return rows.map(x => ({ idx: x.idx, seg: x.seg, wall: x.wall, ageMs: x.offset - steady }));
}

// ---------- scenarios ----------
type Result = Record<string, any>;
const scenarios: Record<string, (root: string, ...rest: any[]) => Promise<Result>> = {
  // 1. baseline + 3. channel content: both outputs, distinct L/R tones.
  async baseline(root) {
    const seconds = 14, r = await runSession(root, { name: 'baseline', session: { seconds } });
    const rec = await recordingReport(r.recordingPath, r.wallSeconds, seconds);
    const base = r.spawnedAt, seg = r.sink.segments[0];
    const rx = segmentReport(seg, base);
    const age = ageProfile(r.sink, base, 14); const ages = age.all.filter(t => (t.wall - base) / 1000 >= 3).map(t => age.age(t));
    const channels = { mp4: await channelProof(r.recordingPath), flv: await channelProof(seg.file) };
    const flvDecodeErrors = await decodeErrors(seg.file);
    return { exit: r.exit, recording: rec, received: rx, flvDecodeErrorLines: flvDecodeErrors, channels, deliveryJitterMs: { steadyOffsetMs: age.steadyOffsetMs, maxAboveSteady: round(Math.max(...ages)), minBelowSteady: round(Math.min(...ages)) },
      pass: r.exit.code === 0 && rec.exists === true && rec.videoFrames === seconds * FPS && rx.video >= seconds * FPS - 2 && rx.audio > 0 && channels.mp4.pass && channels.flv.pass && flvDecodeErrors === 0 && rec.decodeErrorLines === 0 };
  },
  // 1/2. publisher disconnect and reconnect (endpoint down ~7.8 s) while recording continues.
  async reconnect(root, name = 'reconnect', restartAt = 15) {
    const seconds = 34, killAt = 8;
    const r = await runSession(root, { name, session: { seconds, recoveryWaitSeconds: 1 }, faults: [{ at: killAt, action: 'killSink' }, { at: restartAt, action: 'restartSink' }] });
    const base = r.spawnedAt, rec = await recordingReport(r.recordingPath, r.wallSeconds, seconds);
    const recV = await recordingVideo(r.recordingPath);
    const segs = r.sink.segments.map(s => segmentReport(s, base));
    const age = matchedAge(recV, r.sink, base, 3, killAt - 1);
    const second = r.sink.segments[1], first = r.sink.segments[0];
    // Reference instant = the moment the endpoint restart was requested (receiver start-up adds <= ~0.25 s).
    const sinkReadyAt = r.faultLog.find(f => f.action === 'restartSink')?.actualAt ?? NaN;
    const probeLatencyS = first?.firstTagAt !== undefined && first.connectedAt !== undefined ? (first.firstTagAt - first.connectedAt) / 1000 : 0;
    const connectedAt = second?.connectedAt === undefined ? NaN : (second.connectedAt - base) / 1000;
    const m0 = matchSegment(recV, first, base), m1 = second ? matchSegment(recV, second, base) : undefined;
    const firstKeyWall = second?.reader.tags.find(t => t.key)?.wall ?? NaN;
    const firstFrame = m1?.runs[0]?.fromFrame ?? -1;
    const channels = second ? await channelProof(second.file) : null;
    const decode = second ? await decodeErrors(second.file) : -1;
    const maxAgeSettled = Math.max(...age.filter(a => a.seg === 1).map(a => a.ageMs));
    const lastFirstSeg = m0.runs[m0.runs.length - 1]?.toFrame ?? -1;
    return { exit: r.exit, killedAtS: r.faultLog[0]?.actualAt, sinkRestartedAtS: sinkReadyAt, recording: rec, segments: segs,
      firstSegmentLastRecordedFrame: lastFirstSeg, firstSegmentFrameRuns: m0.runs.length,
      publisherRecovery: { restartRequestToReconnectS: round(connectedAt - sinkReadyAt, 2), restartRequestToFirstKeyframeArrivedS: round((firstKeyWall - base) / 1000 - sinkReadyAt, 2), receiverProbeLatencyS: round(probeLatencyS, 2), restartRequestToFirstKeyframeExclReceiverProbeS: round((firstKeyWall - base) / 1000 - sinkReadyAt - probeLatencyS, 2),
        retryCadence: retryCadence(r.lines),
        reconnectedStreamStartsAtRecordingFrame: firstFrame, reconnectedStreamStartsAtRecordingS: round(recV[firstFrame]?.pts, 2), reconnectInstantS: round(connectedAt, 2),
        startsAtKeyFrame: m1?.runs[0]?.startsWithKey, runsInReconnectedSegment: m1?.runs.length, framesLostInsideReconnectedSegment: m1?.dropped.reduce((n, d) => n + d.frames, 0),
        outageMediaSkippedS: round(recV[firstFrame]?.pts - recV[lastFirstSeg]?.pts, 2), maxFrameAgeMsOnArrivalExclReceiverProbe: round(maxAgeSettled), decodeErrorLinesInReconnectedSegment: decode,
        timestampsRestartAtZeroOnReconnect: segs[1]?.tsFirstMs === 0 },
      channelsAfterReconnect: channels, stderrExcerpt: r.lines.slice(0, 40), faultLog: r.faultLog, sinkEvents: r.sinkEvents,
      pass: r.exit.code === 0 && rec.exists === true && rec.videoFrames === seconds * FPS && rec.videoGapsOver2Frames === 0 && rec.audioGapsOver3Packets === 0 && rec.decodeErrorLines === 0
        && segs.length === 2 && m1?.runs[0]?.startsWithKey === true && m1.runs.length === 1 && decode === 0 && maxAgeSettled < 1000
        && recV[firstFrame]?.pts >= connectedAt - 1 && (channels?.pass ?? false) };
  },
  // 4. stalled (connected, not reading) publisher with a given fifo queue; recording must keep going; memory bounded.
  async stall(root, name = 'stall', extra: Partial<TeeSession> = {}, sinkOptions: SinkOptions = {}, stallAt = 6, resumeAt = 18, seconds = 30) {
    const r = await runSession(root, { name, sinkOptions, session: { seconds, ...extra }, faults: [{ at: stallAt, action: 'stall' }, { at: resumeAt, action: 'resume' }] });
    const base = r.spawnedAt, rec = await recordingReport(r.recordingPath, r.wallSeconds, seconds);
    const recV = await recordingVideo(r.recordingPath);
    const seg = r.sink.segments[0], segStats = segmentReport(seg, base);
    const m = matchSegment(recV, r.sink.segments, base);
    const allSegs = r.sink.segments.map(x => segmentReport(x, base));
    const age = matchedAge(recV, r.sink, base, 3, stallAt - 1);
    const firstRunEnd = m.runs[0]?.toFrame ?? 0;
    const after = age.filter(a => a.wall >= base + resumeAt * 1000);
    const lateAges = after.filter(a => (a.wall - base) / 1000 >= resumeAt + 0.5).map(a => a.ageMs);
    const rssKb = r.rss.map(s => s.kb); const rssAtStall = rssKb[Math.max(0, stallAt - 1)] ?? rssKb[0], rssMax = Math.max(...rssKb);
    const expectedVideo = seconds * FPS;
    const decode = (await Promise.all(r.sink.segments.map(x => decodeErrors(x.file)))).reduce((a, b) => a + b, 0);
    return { exit: r.exit, params: { ...extra, ...sinkOptions }, sinkSegments: r.sink.segments.length, stallAtS: stallAt, resumeAtS: resumeAt, recording: rec, encoderBackpressure: r.encoderBackpressure, received: segStats, allSegments: allSegs.length > 1 ? allSegs.map(x => ({ index: x.index, connectedAtS: x.connectedAtS, firstTagAtS: x.firstTagAtS, video: x.video, firstVideoIsKey: x.firstVideoIsKey })) : undefined,
      receivedVideoVsEncoded: { encoded: expectedVideo, received: m.got.length, notDelivered: expectedVideo - m.got.length },
      fullQueueWorstCase: await queueWindows(r.recordingPath, [30, 60, 240]), dropRuns: m.dropped, runs: m.runs.length, firstRunAfterDropStartsWithKey: m.runs.slice(1).map(x => x.startsWithKey), undecodableFramesAfterDrops: m.undecodableFramesAfterDrops,
      ageMsOnArrival: { maxAfterResume: round(Math.max(...after.map(a => a.ageMs))), maxAfterResumePlus0_5s: lateAges.length ? round(Math.max(...lateAges)) : null, framesOlderThan1sAfterResume: after.filter(a => a.ageMs > 1000).length,
        // Frames before the first drop gap were already in kernel socket buffers when the fifo filled; frames after it passed through the fifo queue/thread.
        staleFramesAfterFirstDropGap: after.filter(a => a.idx > firstRunEnd && a.ageMs > 1000).length, maxAgeMsAfterFirstDropGap: round(Math.max(0, ...after.filter(a => a.idx > firstRunEnd).map(a => a.ageMs))) },
      rssKbAtStall: rssAtStall, rssKbAtResume: rssKb[Math.min(rssKb.length - 1, resumeAt)], rssKbAtEnd: rssKb[rssKb.length - 1], rssKbMax: rssMax, rssGrowthKbStallToEnd: rssKb[rssKb.length - 1] - rssAtStall, rss: r.rss.filter((_, i) => i % 3 === 0), flvDecodeErrorLines: decode,
      stderrExcerpt: r.lines.filter(l => /overflow|full|drop|rror/i.test(l.line)).slice(0, 10).concat(r.lines.filter(l => !/overflow|full|drop|rror/i.test(l.line)).slice(0, 8)), faultLog: r.faultLog, sinkEvents: r.sinkEvents,
      // Drop variants must never block the encoder/recorder and must resume at key frames with at most one stale frame (the packet the fifo thread was blocked on).
      // The no-drop variant is a NEGATIVE CONTROL: it passes only if it demonstrably back-pressures the whole session.
      encoderBlockedAsExpected: extra.dropOnOverflow === false ? r.encoderBackpressure.finalWallMinusMediaS > 3 : r.encoderBackpressure.maxBlockedS < 0.5 && r.encoderBackpressure.finalWallMinusMediaS < 0.5,
      pass: rec.exists === true && (rec as any).videoFrames === expectedVideo && (rec as any).videoGapsOver2Frames === 0 && (rec as any).decodeErrorLines === 0 && r.exit.code === 0
        && (extra.dropOnOverflow === false ? r.encoderBackpressure.finalWallMinusMediaS > 3
          : r.encoderBackpressure.maxBlockedS < 0.5 && r.encoderBackpressure.finalWallMinusMediaS < 0.5 && m.undecodableFramesAfterDrops === 0
            && m.runs.slice(1).every(x => x.startsWithKey) && after.filter(a => a.idx > firstRunEnd && a.ageMs > 1000).length <= 2) };
  },
  // 2a. initial recording failure must prevent publishing.
  async initialRecordingFailure(root) {
    const out: Result = {};
    for (const onfail of ['abort', 'ignore'] as const) {
      const missing = path.join(root, 'no-such-dir', 'recording.mp4');
      const r = await runSession(root, { name: `initial-fail-${onfail}`, session: { seconds: 6, recordingOnFail: onfail }, recordingPath: missing });
      const tags = r.sink.segments.flatMap(s => s.reader.tags).filter(t => t.kind !== 'script');
      out[onfail] = { exit: r.exit, publisherConnections: r.sink.connections, mediaTagsReceived: tags.length, recordingExists: existsSync(missing), wallSeconds: r.wallSeconds, stderrExcerpt: r.lines.slice(0, 6) };
    }
    out.pass = out.abort.exit.code !== 0 && out.abort.publisherConnections === 0 && out.abort.mediaTagsReceived === 0;
    return out;
  },
  // 2a'. Supervisor-owned recording descriptor: open failures happen in the supervisor, before FFmpeg (and the publisher) exist.
  async recordingViaInheritedFd(root) {
    const seconds = 8, r = await runSession(root, { name: 'fd-recording', session: { seconds }, recordingFd: true });
    const rec = await recordingReport(r.recordingPath, r.wallSeconds, seconds);
    const mp4 = await readBoxes(r.recordingPath);
    // Supervisor-side refusal cases: nothing is spawned, nothing connects.
    const refusals: Record<string, string> = {};
    for (const [label, target] of [['missingDirectory', path.join(root, 'no-such-dir', 'x.mp4')], ['existingFile', r.recordingPath]] as const) {
      try { closeSync(openSync(target, 'wx+')); refusals[label] = 'OPENED (unexpected)'; } catch (e: any) { refusals[label] = e.code; }
    }
    const channels = await channelProof(r.recordingPath);
    return { exit: r.exit, recording: rec, topLevelBoxes: mp4, supervisorRefusals: refusals, received: segmentReport(r.sink.segments[0], r.spawnedAt), channels,
      pass: r.exit.code === 0 && rec.exists === true && (rec as any).videoFrames === seconds * FPS && (rec as any).decodeErrorLines === 0 && refusals.missingDirectory === 'ENOENT' && refusals.existingFile === 'EEXIST' && channels.pass };
  },
  // 2b. recording write failure mid-session: stream must survive (onfail=ignore) -- and show what abort would do.
  async recordingFailureMidSession(root) {
    const out: Result = {};
    for (const onfail of ['ignore', 'abort'] as const) {
      const seconds = 18;
      const r = await runSession(root, { name: `midfail-${onfail}`, session: { seconds, recordingOnFail: onfail }, fileSizeLimitBlocks: 2500 });
      const base = r.spawnedAt, seg = r.sink.segments[0], rx = segmentReport(seg, base);
      const rec = await recordingReport(r.recordingPath, r.wallSeconds, seconds);
      out[onfail] = { exit: r.exit, wallSeconds: r.wallSeconds, recording: rec, received: rx, receivedSpanS: round(((rx.tsLastMs ?? 0) - (rx.tsFirstMs ?? 0)) / 1000, 2), stderrExcerpt: r.lines.filter(l => /rror|ail|ignor|Slave|muxing/i.test(l.line)).slice(0, 8) };
    }
    const ig = out.ignore;
    out.pass = ig.exit.code === 0 && ig.receivedSpanS >= 17 && (ig.recording.videoFrames ?? 0) < 18 * FPS * 0.9;
    return out;
  },
};
const STALL_SWEEP: [string, Partial<TeeSession>, SinkOptions][] = [
  ['stall-q60-drop', { queueSize: 60 }, {}],
  ['stall-q30-drop', { queueSize: 30 }, {}],
  ['stall-q240-drop', { queueSize: 240 }, {}],
  ['stall-q60-nodrop', { queueSize: 60, dropOnOverflow: false }, {}],
  ['stall-q60-rwtimeout3s', { queueSize: 60, rwTimeoutMicros: 3_000_000 }, { autoRelisten: true }],
];

async function main() {
  const args = process.argv.slice(2);
  const arg = (f: string) => args.includes(f) ? args[args.indexOf(f) + 1] : undefined;
  if (args.includes('--list')) { console.log(Object.keys(scenarios).concat(['stall-sweep', 'reconnect-late-phase']).join('\n')); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), 'camcontrol-tee-proof-'));
  const names = args.includes('--all') ? ['baseline', 'reconnect', 'reconnect-late-phase', 'stall-sweep', 'initialRecordingFailure', 'recordingViaInheritedFd', 'recordingFailureMidSession'] : [arg('--scenario') || 'baseline'];
  const summary: Result = { generated: new Date().toISOString(), runtime: { ffmpeg: 'developer Homebrew FFmpeg 8.1.2 (not the pinned product runtime; #65 open)', host: `${os.platform()} ${os.arch()}` }, synthetic: true, source: '640x360@30 testsrc2 + L=440Hz/R=1000Hz stereo, h264_videotoolbox 2.5 Mbps, AAC 128k', results: {} };
  try {
    for (const name of names) {
      const started = Date.now();
      if (name === 'reconnect-late-phase') summary.results[name] = await scenarios.reconnect(root, name, 16.9);
      else if (name === 'stall-sweep') {
        summary.results[name] = {};
        for (const [label, extra, sinkOptions] of STALL_SWEEP) summary.results[name][label] = await scenarios.stall(root, label, extra, sinkOptions);
      } else { assert.ok(scenarios[name], `Unknown scenario ${name}`); summary.results[name] = await scenarios[name](root); }
      summary.results[name].elapsedS = round((Date.now() - started) / 1000);
      summary.results[name].pass = name === 'stall-sweep' ? Object.values(summary.results[name]).every((v: any) => typeof v !== 'object' || v.pass === true) : summary.results[name].pass;
      console.log(`${name}: ${JSON.stringify(summary.results[name], (k, v) => k === 'rss' || k === 'stderrExcerpt' || k === 'sinkEvents' || k === 'faultLog' ? undefined : v).slice(0, 4000)}`);
      await stopOwned();
    }
  } finally {
    await stopOwned();
    summary.overallPass = Object.values(summary.results).length > 0 && Object.values(summary.results).every((v: any) => v.pass === true);
    const out = arg('--summary');
    if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(path.resolve(out), JSON.stringify(summary, null, 2).split(root).join('<tmp>') + '\n'); }
    if (args.includes('--keep')) console.log(`media kept in ${root}`); else rmSync(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
