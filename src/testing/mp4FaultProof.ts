// Issue #67 (S04) proof harness: hybrid-fragmented MP4 close and crash recovery on the capture path (helper -> ONE FFmpeg tee).
//   node dist/testing/mp4FaultProof.js --scenario <name> [--real] [--seconds N] [--kill-at S] [--movflags F] [--extra k=v,k=v|none] [--json FILE] [--keep]
// scenarios: graceful | kill-ffmpeg | kill-helper | write-fault (--write N --mode before|partial|after) | write-failure | finalize-scale (--minutes M)
// --real uses the DeckLink card (refuses if Wirecast runs; <= 30 s); otherwise the helper's --synthetic --synthetic-impulse path.
// Developer runtime only. Local 127.0.0.1 RTMP sink only. Media is deleted unless --keep.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DecklinkCapture, CaptureHelperOptions, defaultHelperPath } from '../broadcast/decklinkCapture';
import { LocalRtmpSink } from '../broadcast/localRtmpSink';
import { runMedia } from '../broadcast/mediaProcess';
import { frameCounters } from '../broadcast/mediaAnalysis';
import { recoverMp4, scanMp4, sha256 } from '../broadcast/mp4Recovery';
import { ffmpeg, ffprobe } from '../broadcast/runtimeProbe';
import { CaptureTeeSession } from '../broadcast/teeArgs';

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function arg(name: string, def?: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const root = path.resolve(__dirname, '../..');
const interposer = () => { // build the developer-only write-fault interposer into the temp dir on demand
  const out = path.join(os.tmpdir(), 'camcontrol-interpose-write.dylib');
  execFileSync('/usr/bin/clang', ['-dynamiclib', '-O1', '-o', out, path.join(root, 'scripts/mp4-fault/interpose-write.c')]); return out;
};
const avcheckBin = () => { // AVFoundation (the QuickTime engine) playability probe, compiled once into the temp dir
  const out = process.env.AVCHECK_BIN || path.join(os.tmpdir(), 'camcontrol-avcheck');
  if (!existsSync(out)) execFileSync('/usr/bin/swiftc', ['-O', path.join(root, 'scripts/mp4-fault/avcheck.swift'), '-o', out], { stdio: 'ignore' }); return out;
};
export function avfoundation(file: string): any { try { return JSON.parse(execFileSync(avcheckBin(), [file]).toString()); } catch (e: any) { return { playable: false, error: String(e.message).slice(0, 120) }; } }

/** Everything we can say about one finished/interrupted recording, from bytes + decode. Recovery output goes next to the original, never over it. */
export async function analyzeRecording(mp4: string, opts: { counters: boolean; expectedFrames?: number }) {
  const bytes = readFileSync(mp4); const sha = await sha256(mp4); const scan = scanMp4(bytes);
  const recovered = mp4.replace(/\.mp4$/, '.recovered.mp4');
  const recovery = await recoverMp4(mp4, recovered);
  const usable = recovery.status === 'RECOVERED' ? recovered : recovery.status === 'NOT_NEEDED' ? mp4 : undefined;
  let content: any = null;
  if (usable) {
    const streams = JSON.parse((await runMedia(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration,start_time', '-show_entries', 'format=duration', '-of', 'json', usable], 300000)).stdout.toString());
    const v = streams.streams.find((s: any) => s.codec_type === 'video'), a = streams.streams.find((s: any) => s.codec_type === 'audio');
    const dec = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', usable, '-f', 'null', '-'], 300000).then(r => r.stderr.trim(), e => String(e.message).slice(0, 200));
    let counters: any = null;
    if (opts.counters) {
      const c = await frameCounters(usable); let gaps = 0, dup = 0, maxGap = 0;
      // The MP4 muxer starts every stream at the most negative timestamp (AAC priming, -1024 samples), so video starts 21.3 ms late and the first picture
      // is held for ~54.7 ms: a single repeat of frame 0 at the start is the common-origin shift, not a dropped/duplicated capture frame.
      const startRepeat = c.length > 1 && c[1].n === c[0].n;
      for (let i = startRepeat ? 2 : 1; i < c.length; i++) { const d = c[i].n - c[i - 1].n; if (d === 0) dup++; else if (d !== 1) { gaps++; maxGap = Math.max(maxGap, d - 1); } }
      counters = { frames: c.length, first: c[0]?.n, last: c[c.length - 1]?.n, startRepeatOfFrame0: startRepeat, gaps, duplicates: dup, maxMissingRun: maxGap, sequential: gaps === 0 && dup === 0 && c[0]?.n === 0 };
    }
    content = { video: v && { codec: v.codec_name, frames: Number(v.nb_read_frames), startS: Number(v.start_time) }, audio: a && { codec: a.codec_name, frames: Number(a.nb_read_frames), startS: Number(a.start_time) },
      formatDurationS: round(Number(streams.format.duration)), decodeErrors: dec, counters, avfoundation: avfoundation(usable) };
  }
  const { scan: _s, ...recoverySummary } = recovery as any;
  const originalBytes = (await sha256(mp4)) === sha;
  return { file: path.basename(mp4), bytes: bytes.length, scan: { state: scan.state, moovCount: scan.moovCount, fragments: scan.fragments.length, initialMoovSamples: scan.initialMoovSamples, fragmentSamples: scan.fragmentSamples, completeSamples: scan.completeSamples, finalMoovSamples: scan.finalMoovSamples,
      completePrefixBytes: scan.completePrefixBytes, trailing: scan.trailing, atoms: scan.atoms.length > 14 ? [...scan.atoms.slice(0, 6).map(a => a.type), `...${scan.atoms.length - 8} more`, ...scan.atoms.slice(-2).map(a => a.type)] : scan.atoms.map(a => a.type) },
    originalAvfoundation: avfoundation(mp4), recovery: recoverySummary, usable: usable ? path.basename(usable) : null, content, originalSha256Unchanged: originalBytes };
}

type Action = { atS: number; kind: 'none' | 'sigterm-helper' | 'sigkill-ffmpeg' | 'sigkill-helper' | 'sigint-ffmpeg' };
type SessionSpec = { real: boolean; seconds: number; action: Action; dir: string; session?: Partial<CaptureTeeSession>; ffmpegEnv?: NodeJS.ProcessEnv; fileSizeLimitBlocks?: number; port?: number };
export async function runSession(spec: SessionSpec) {
  mkdirSync(spec.dir, { recursive: true });
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const sink = new LocalRtmpSink(ffmpeg, spec.dir, spec.port ?? Number(process.env.BROADCAST_TEST_RTMP_PORT || '19353'), now); await sink.up();
  const mp4 = path.join(spec.dir, 'recording.mp4');
  const helperOptions: CaptureHelperOptions = spec.real ? { channels: 2, sampleBits: 32, durationSec: spec.seconds } : { synthetic: true, syntheticImpulse: true, syntheticMode: '1080p30', channels: 2, sampleBits: 32, durationSec: spec.seconds };
  const progress: { atS: number; frame: number; mediaS: number }[] = []; let pending = ''; const faultLines: string[] = [];
  let spawnedAt = 0;
  const cap = new DecklinkCapture({ ffmpeg, helperOptions, session: { recordingPath: mp4, publishUrl: sink.url, rwTimeoutMicros: 3_000_000, ...spec.session }, deadlineMs: (spec.seconds + 60) * 1000, ffmpegEnv: spec.ffmpegEnv,
    ffmpegWrapper: spec.fileSizeLimitBlocks ? (bin, args) => ({ binary: '/bin/sh', args: ['-c', `trap '' XFSZ; ulimit -f ${spec.fileSizeLimitBlocks}; exec nice -n 15 "$0" "$@"`, bin, ...args] }) : undefined,
    onFfmpegStderr: (chunk: Buffer) => { pending += chunk.toString(); const parts = pending.split(/[\r\n]/); pending = parts.pop()!.slice(-2000);
      for (const l of parts) if (/Slave|tee|muxer|No space|too large|File size|write|rror/i.test(l) && !/^frame=/.test(l) && faultLines.length < 25) faultLines.push(l.slice(0, 200));
      for (const l of parts) { const m = /^frame=\s*(\d+).*\btime=(\d+):(\d+):([\d.]+)/.exec(l); if (m) progress.push({ atS: (now() - spawnedAt) / 1000, frame: Number(m[1]), mediaS: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) }); } } });
  spawnedAt = now(); cap.start();
  const marks: Record<string, number> = {};
  const timer = spec.action.kind === 'none' ? undefined : setTimeout(() => {
    marks.actionAtS = (now() - spawnedAt) / 1000;
    if (spec.action.kind === 'sigterm-helper') cap.signalHelper('SIGTERM'); else if (spec.action.kind === 'sigkill-ffmpeg') cap.signalFfmpeg('SIGKILL');
    else if (spec.action.kind === 'sigkill-helper') cap.signalHelper('SIGKILL'); else cap.signalFfmpeg('SIGINT');
  }, spec.action.atS * 1000);
  const result = await cap.wait(); if (timer) clearTimeout(timer);
  const wallS = (now() - spawnedAt) / 1000;
  const ffExit = ((cap.ffmpegExitedAt ?? performance.now()) - t0 - spawnedAt) / 1000, heExit = ((cap.helperExitedAt ?? performance.now()) - t0 - spawnedAt) / 1000;
  await sleep(1200); await sink.close().catch(() => {});
  const last = [...progress].reverse().find(p => marks.actionAtS === undefined || p.atS <= marks.actionAtS);
  const status = [...result.lines].reverse().find(l => l.type === 'status') as any;
  const exitLine = result.lines.find(l => l.type === 'exit') as any;
  return { mp4, wallS: round(wallS, 2), action: spec.action, actionAtS: marks.actionAtS === undefined ? null : round(marks.actionAtS, 3),
    helperExitCode: result.helperCode, helperSignal: result.helperSignal, ffmpegExitCode: result.ffmpegCode, helperExitAtS: round(heExit, 3), ffmpegExitAtS: round(ffExit, 3),
    helperExitMsAfterAction: marks.actionAtS === undefined ? null : round((heExit - marks.actionAtS) * 1000, 0), ffmpegExitMsAfterAction: marks.actionAtS === undefined ? null : round((ffExit - marks.actionAtS) * 1000, 0),
    ffmpegMsAfterHelperExit: round((ffExit - heExit) * 1000, 0), lastProgressBeforeAction: last ?? null, helperFramesOut: exitLine?.frames_out ?? status?.frames_out ?? null, helperLastStatus: status ?? null,
    flv: { segments: sink.segments.length, bytes: sink.segments.reduce((n, s) => n + s.bytes, 0), videoTags: sink.segments.reduce((n, s) => n + s.reader.tags.filter(t => t.kind === 'video' && !t.config).length, 0), audioTags: sink.segments.reduce((n, s) => n + s.reader.tags.filter(t => t.kind === 'audio' && !t.config).length, 0) },
    ffmpegFaultLines: faultLines, ffmpegStderrTail: result.ffmpegStderr.split('\n').filter(l => l.trim() && !/^frame=/.test(l)).slice(-6) };
}

/** Finalization cost vs recording length: sample-table-equivalent recordings (tiny frames, real 30 fps video + 48 kHz AAC sample counts) stopped with SIGINT at media time M;
 *  measures SIGINT -> exit (trailer, final moov, header patch). File BYTES are small here by design; bytes do not enter the close path (no remux), see the write trace. */
async function finalizeScale(minutes: number, dir: string, session: Partial<CaptureTeeSession>, big = false) {
  mkdirSync(dir, { recursive: true }); const mp4 = path.join(dir, 'long.mp4'); const log = path.join(dir, 'writes.log');
  const tee = `[f=mp4:movflags=${session.recordingMovflags ?? '+frag_keyframe+hybrid_fragmented'}:flush_packets=1:onfail=ignore]${mp4}`;
  const args = ['-hide_banner', '-nostdin', '-v', 'info', '-stats_period', '1', '-f', 'lavfi', '-i', big ? 'testsrc2=s=1280x720:r=30' : 'color=c=gray:s=64x64:r=30', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.1', '-t', String(minutes * 60 + 600),
    ...(big ? ['-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-b:v', '6000k', '-pix_fmt', 'yuv420p'] : ['-c:v', 'libx264', '-preset', 'ultrafast']), '-g', '60', '-bf', '0', '-c:a', 'aac', '-b:a', '64k', '-map', '0:v', '-map', '1:a', '-flags', '+global_header', '-f', 'tee', tee];
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DYLD_INSERT_LIBRARIES: interposer(), FAULT_LOG: log } });
  try { os.setPriority(child.pid!, 15); } catch { /* ignore */ }
  let sentAt = 0, lastMedia = 0, pending = '';
  const exited = new Promise<void>(r => child.once('close', () => r()));
  child.stderr.on('data', (c: Buffer) => { pending += c.toString(); const parts = pending.split(/[\r\n]/); pending = parts.pop()!;
    for (const l of parts) { const m = /^frame=.*\btime=(\d+):(\d+):([\d.]+)/.exec(l); if (m) { lastMedia = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]); if (!sentAt && lastMedia >= minutes * 60) { sentAt = performance.now(); child.kill('SIGINT'); } } } });
  const t0 = performance.now(); await exited; const exitAt = performance.now();
  const trace = readFileSync(log, 'utf8').trim().split('\n').map(l => { const [seq, kind, off, len, t] = l.split(' '); return { seq: Number(seq), kind, offset: Number(off), len: Number(len), t: Number(t) }; });
  const a = await analyzeRecording(mp4, { counters: false });
  const bytes = statSync(mp4).size; const sc = scanMp4(readFileSync(mp4));
  const last = trace[trace.length - 1], tail = trace.slice(-4);
  const seek = await runMedia(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(Math.max(0, minutes * 60 - 30)), '-i', mp4, '-t', '5', '-f', 'null', '-'], 120000).then(r => ({ ok: true, err: r.stderr.trim() }), e => ({ ok: false, err: String(e.message).slice(0, 120) }));
  return { minutes, sigintToExitMs: round(exitAt - sentAt, 0), runWallS: round((exitAt - t0) / 1000, 1), mediaSecondsAtSigint: lastMedia, fileBytes: bytes, finalMoovBytes: sc.atoms.filter(x => x.type === 'moov').map(x => x.end - x.start).pop(),
    writeCount: trace.length, finalWrites: tail.map(w => ({ seq: w.seq, offset: w.offset, len: w.len })), lastWriteOffset: last.offset, seekNearEnd: seek, analysis: a };
}
function guardReal() {
  let w = ''; try { w = execFileSync('/usr/bin/pgrep', ['-il', 'wirecast']).toString().trim(); } catch { /* not running */ }
  if (w) throw new Error(`BLOCKED: Wirecast is running (${w}); not touching the capture card`);
  if (!existsSync(defaultHelperPath())) throw new Error(`capture helper not built: ${defaultHelperPath()}`);
}
const base = (name: string) => path.join(arg('--out') ?? mkdtempSync(path.join(os.tmpdir(), 'mp4fault-')), name);

async function main() {
  const scenario = arg('--scenario')!; const real = process.argv.includes('--real');
  if (!scenario) throw new Error('--scenario required');
  if (real) guardReal();
  const seconds = Number(arg('--seconds', real ? '20' : '14')); if (!(seconds > 0 && seconds <= (real ? 30 : 60))) throw new Error('--seconds out of range');
  const killAt = Number(arg('--kill-at', String(Math.round(seconds * 0.6 * 10) / 10)));
  const dir = base(`${scenario}-${real ? 'real' : 'syn'}-${Date.now() % 100000}`);
  const movflags = arg('--movflags'); const extra = arg('--extra') === 'none' ? [] : arg('--extra')?.split(',').filter(Boolean);   // 'none' = no extra muxer options (the pre-#67 2 s-fragment mode)
  const session: Partial<CaptureTeeSession> = { ...(movflags ? { recordingMovflags: movflags } : {}), ...(extra ? { recordingExtra: extra } : {}) };
  let run: any, analysis: any, extraInfo: any = {};
  if (scenario === 'graceful') run = await runSession({ real, seconds: 120, action: { atS: seconds, kind: 'sigterm-helper' }, dir, session });
  else if (scenario === 'kill-ffmpeg') run = await runSession({ real, seconds: seconds + 10, action: { atS: killAt, kind: 'sigkill-ffmpeg' }, dir, session });
  else if (scenario === 'kill-helper') run = await runSession({ real, seconds: seconds + 10, action: { atS: killAt, kind: 'sigkill-helper' }, dir, session });
  else if (scenario === 'write-fault') {
    const log = path.join(dir, 'writes.log'); mkdirSync(dir, { recursive: true });
    const env: NodeJS.ProcessEnv = { DYLD_INSERT_LIBRARIES: interposer(), FAULT_LOG: log, ...(arg('--write') ? { FAULT_KILL_AT: arg('--write')!, FAULT_MODE: arg('--mode', 'after')! } : {}), ...(process.argv.includes('--on-patch') ? { FAULT_KILL_ON_PATCH: '1', FAULT_MODE: arg('--mode', 'before')! } : {}) };
    run = await runSession({ real, seconds, action: { atS: 0, kind: 'none' }, dir, session, ffmpegEnv: env });
    extraInfo = { writeTrace: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => { const [seq, kind, off, len, t] = l.split(' '); return { seq: Number(seq), kind, offset: Number(off), len: Number(len), t: Number(t) }; }) : [] };
    const tr = extraInfo.writeTrace; if (tr.length) { const t0 = tr[0].t; extraInfo.writeTrace = tr.map((w: any) => ({ ...w, t: round(w.t - t0, 3) })).slice(-8); extraInfo.writeCount = tr.length; }
  } else if (scenario === 'write-failure') {
    const limit = Number(arg('--limit-blocks', '12000')); // 512-byte blocks (~6.1 MB): the recording hits EFBIG mid-run while the stream continues
    run = await runSession({ real, seconds, action: { atS: 0, kind: 'none' }, dir, session, fileSizeLimitBlocks: limit });
    extraInfo = { fileSizeLimitBytes: limit * 512, recordingBytes: statSync(run.mp4).size };
  } else if (scenario === 'finalize-scale') {
    const out = await finalizeScale(Number(arg('--minutes', '30')), dir, session, process.argv.includes('--big'));
    const j = arg('--json'); if (j) writeFileSync(j, JSON.stringify({ scenario, kind: 'synthetic-sample-equivalent', at: new Date().toISOString(), ...out }, null, 2) + '\n');
    console.log(JSON.stringify(out, null, 2)); if (!process.argv.includes('--keep')) rmSync(arg('--out') ? dir : path.dirname(dir), { recursive: true, force: true }); return;
  } else throw new Error(`unknown scenario ${scenario}`);
  if (existsSync(run.mp4)) analysis = await analyzeRecording(run.mp4, { counters: !real });
  // Media-time accounting for the interrupted cases
  const accounting = analysis?.content && run.lastProgressBeforeAction ? (() => {
    const p = run.lastProgressBeforeAction, rec = analysis.content.video.frames;
    return { recoveredVideoFrames: rec, ffmpegFramesEncodedAtLastProgress: p.frame, ffmpegMediaSecondsAtLastProgress: p.mediaS, recoveredDurationS: analysis.content.formatDurationS,
      recoveredPctOfEncodedAtLastProgress: round(100 * rec / p.frame, 1), lostSecondsVsLastProgress: round(p.mediaS - analysis.content.formatDurationS, 2), wallSecondsAtKill: run.actionAtS, playableDurationVsWall: round(analysis.content.formatDurationS - (run.actionAtS ?? 0), 2) };
  })() : null;
  const report = { scenario, kind: real ? 'real-hardware' : 'synthetic', at: new Date().toISOString(), movflags: movflags ?? 'default', extra: extra ?? [], ...extraInfo, run: { ...run, mp4: path.basename(run.mp4) }, analysis, accounting };
  const j = arg('--json'); if (j) writeFileSync(j, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!process.argv.includes('--keep')) rmSync(arg('--out') ? dir : path.dirname(dir), { recursive: true, force: true });
}
if (require.main === module) main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
