import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MediaProcess } from './mediaProcess';
import { captureTeeArgs, CaptureTeeSession } from './teeArgs';

// Wrapper for the native capture helper (native/decklink-capture): helper stdout (Matroska with DeckLink stream-time PTS)
// is connected DIRECTLY to the stdin of the single session FFmpeg, so frames never pass through Node. Node only reads the
// helper's JSON status lines (stderr) and turns them into health.

export type CaptureLine =
  | { type: 'status'; t_ms: number; state: string; mode?: string; width?: number; height?: number; fps_nominal?: number; fps: number; signal_locked: boolean; audio_packets?: boolean; audio_peak_dbfs?: number; audio_present: boolean;
      frames_in: number; frames_out: number; filler_frames: number; dropped_backpressure: number; dropped_late: number; audio_resyncs: number; audio_dropped: number;
      queue_depth: number; queue_cap: number; blocked_ms: number; max_block_ms: number; bytes_out: number;
      device_ok?: boolean; device_signal_locked?: boolean; detected_mode?: string; source_age_ms?: number }
  | { type: 'event'; event: string; t_ms: number; [k: string]: unknown }
  | { type: 'error'; code: string; message: string; exit: number; t_ms: number; [k: string]: unknown }
  | { type: 'exit'; code: number; frames_in: number; frames_out: number; filler_frames: number; dropped_backpressure: number; dropped_late: number; bytes_out: number };

const MAX_LINE = 16 * 1024;
/** Bounded, chunk-safe JSON-line parser: tolerates partial chunks, ignores non-JSON noise, drops over-long lines. */
export class CaptureLineParser {
  private buffer = '';
  push(chunk: Buffer | string): CaptureLine[] {
    this.buffer += chunk.toString();
    const out: CaptureLine[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
      const parsed = parseCaptureLine(line); if (parsed) out.push(parsed);
    }
    if (this.buffer.length > MAX_LINE) this.buffer = '';
    return out;
  }
}
export function parseCaptureLine(line: string): CaptureLine | null {
  const text = line.trim();
  if (!text.startsWith('{') || text.length > MAX_LINE) return null;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && ['status', 'event', 'error', 'exit'].includes(value.type)) return value as CaptureLine;
  } catch { /* not a status line */ }
  return null;
}

export type CaptureState = 'starting' | 'waiting-signal' | 'running' | 'signal-lost' | 'failed' | 'stopped';
export type CaptureHealth = {
  state: CaptureState; signalLocked: boolean; deviceOk: boolean; mode?: string; width?: number; height?: number; fps: number; fpsNominal?: number;
  audioPresent: boolean; audioPackets: boolean; audioPeakDbfs?: number; fillerFrames: number; droppedBackpressure: number; droppedLate: number; queueDepth: number; blockedMs: number; maxBlockMs: number;
  framesIn: number; framesOut: number; bytesOut: number; sourceAgeMs?: number; lastStatusAt?: number; interlaced?: boolean;
  error?: { code: string; message: string; exit: number }; exitCode?: number;
};
export const initialHealth = (): CaptureHealth => ({ state: 'starting', signalLocked: false, deviceOk: true, fps: 0, audioPresent: false, audioPackets: false, fillerFrames: 0, droppedBackpressure: 0, droppedLate: 0,
  queueDepth: 0, blockedMs: 0, maxBlockMs: 0, framesIn: 0, framesOut: 0, bytesOut: 0 });

/** Pure reducer. A healthy process with no locked signal is 'signal-lost' (filler is flowing); only an error line or process exit is 'failed'. */
export function applyCaptureLine(h: CaptureHealth, line: CaptureLine, now = Date.now()): CaptureHealth {
  switch (line.type) {
    case 'status': {
      const running = line.state === 'running';
      return { ...h, state: h.state === 'failed' || h.state === 'stopped' ? h.state : !running ? 'waiting-signal' : line.signal_locked ? 'running' : 'signal-lost',
        signalLocked: line.signal_locked, deviceOk: line.device_ok ?? true, mode: line.mode ?? h.mode, width: line.width ?? h.width, height: line.height ?? h.height,
        fps: line.fps, fpsNominal: line.fps_nominal ?? h.fpsNominal, audioPresent: line.audio_present, audioPackets: line.audio_packets ?? line.audio_present, audioPeakDbfs: line.audio_peak_dbfs, fillerFrames: line.filler_frames,
        droppedBackpressure: line.dropped_backpressure, droppedLate: line.dropped_late, queueDepth: line.queue_depth, blockedMs: line.blocked_ms, maxBlockMs: line.max_block_ms,
        framesIn: line.frames_in, framesOut: line.frames_out, bytesOut: line.bytes_out, sourceAgeMs: line.source_age_ms, lastStatusAt: now };
    }
    case 'event':
      if (line.event === 'started') return { ...h, interlaced: line.interlaced === true, mode: String(line.mode ?? h.mode), width: Number(line.width ?? h.width), height: Number(line.height ?? h.height) };
      return h;
    case 'error': return { ...h, state: 'failed', error: { code: line.code, message: line.message, exit: line.exit } };
    case 'exit': return { ...h, state: h.state === 'failed' ? 'failed' : line.code === 0 ? 'stopped' : 'failed', exitCode: line.code, error: h.error ?? (line.code === 0 ? undefined : { code: 'exit', message: `capture helper exited ${line.code}`, exit: line.code }) };
  }
}
/** Healthy status lines arrive every second; no line for `maxAgeMs` means the helper is wedged (the supervisor decides what to do). */
export function isStale(h: CaptureHealth, now = Date.now(), maxAgeMs = 5000): boolean { return h.state !== 'failed' && h.state !== 'stopped' && h.lastStatusAt !== undefined && now - h.lastStatusAt > maxAgeMs; }

export type CaptureHelperOptions = {
  device?: string; mode?: string; detectTimeoutSec?: number; channels?: 2 | 8 | 16; sampleBits?: 16 | 32; queueFrames?: number; durationSec?: number;
  synthetic?: boolean; syntheticMode?: string; syntheticLoss?: string; statsIntervalMs?: number;
};
export function captureHelperArgs(o: CaptureHelperOptions = {}): string[] {
  const int = (n: unknown, lo: number, hi: number, what: string) => { if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} must be ${lo}-${hi}`); return String(n); };
  const safe = /^[\w .:-]+$/;
  const args: string[] = [];
  if (o.device !== undefined) { if (!safe.test(o.device)) throw new Error('device contains unsupported characters'); args.push('--device', o.device); }
  if (o.mode !== undefined) { if (!/^[\w]+$/.test(o.mode)) throw new Error('mode contains unsupported characters'); args.push('--mode', o.mode); }
  if (o.detectTimeoutSec !== undefined) args.push('--detect-timeout', int(o.detectTimeoutSec, 0, 60, 'detectTimeoutSec'));
  if (o.channels !== undefined) { if (![2, 8, 16].includes(o.channels)) throw new Error('channels must be 2, 8 or 16'); args.push('--channels', String(o.channels)); }
  if (o.sampleBits !== undefined) { if (![16, 32].includes(o.sampleBits)) throw new Error('sampleBits must be 16 or 32'); args.push('--sample-bits', String(o.sampleBits)); }
  if (o.queueFrames !== undefined) args.push('--queue-frames', int(o.queueFrames, 2, 120, 'queueFrames'));
  if (o.durationSec !== undefined) args.push('--duration', int(o.durationSec, 1, 86400, 'durationSec'));
  if (o.statsIntervalMs !== undefined) args.push('--stats-interval', int(o.statsIntervalMs, 100, 60000, 'statsIntervalMs'));
  if (o.synthetic) {
    args.push('--synthetic');
    if (o.syntheticMode !== undefined) { if (!/^[\w]+$/.test(o.syntheticMode)) throw new Error('syntheticMode contains unsupported characters'); args.push('--synthetic-mode', o.syntheticMode); }
    if (o.syntheticLoss !== undefined) { if (!/^\d+(\.\d+)?:\d+(\.\d+)?(:nosignal|:stall)?$/.test(o.syntheticLoss)) throw new Error('syntheticLoss must be AT:FOR[:nosignal|:stall]'); args.push('--synthetic-loss', o.syntheticLoss); }
  }
  return args;
}
export function defaultHelperPath(): string {
  return process.env.CAMCONTROL_CAPTURE_BIN || path.resolve(__dirname, '../../native/decklink-capture/build/camcontrol-capture');
}

export type CaptureSessionOptions = { ffmpeg: string; helper?: string; helperOptions?: CaptureHelperOptions; session: CaptureTeeSession; nice?: boolean; deadlineMs?: number };
export type CaptureResult = { ffmpegCode: number | null; helperCode: number | null; helperSignal: string | null; health: CaptureHealth; ffmpegStderr: string; lines: CaptureLine[] };

/** One helper piped into one tee/fifo ffmpeg. Emits 'line' (CaptureLine) and 'health' (CaptureHealth). */
export class DecklinkCapture extends EventEmitter {
  health: CaptureHealth = initialHealth();
  readonly lines: CaptureLine[] = [];
  private ffmpegProc?: MediaProcess; private helperProc?: ChildProcess;
  private helperDone?: Promise<{ code: number | null; signal: string | null }>;
  constructor(private options: CaptureSessionOptions) { super(); }

  start(): void {
    const o = this.options;
    const helperArgs = captureHelperArgs(o.helperOptions);
    const ffmpegArgs = captureTeeArgs(o.session);
    const nice = o.nice !== false;
    this.ffmpegProc = new MediaProcess(nice ? '/usr/bin/nice' : o.ffmpeg, nice ? ['-n', '15', o.ffmpeg, ...ffmpegArgs] : ffmpegArgs, o.deadlineMs ?? 3_600_000);
    const helper = o.helper ?? defaultHelperPath();
    // The helper's stdout IS the ffmpeg stdin socket: media bytes never enter Node.
    this.helperProc = spawn(nice ? '/usr/bin/nice' : helper, nice ? ['-n', '15', helper, ...helperArgs] : helperArgs, { stdio: ['ignore', this.ffmpegProc.child.stdin, 'pipe'] });
    this.ffmpegProc.child.stdin.destroy();  // drop Node's copy so ffmpeg sees EOF when the helper exits (destroy, not end: end() would shutdown the shared socket)
    const parser = new CaptureLineParser();
    this.helperProc.stderr!.on('data', (chunk: Buffer) => {
      for (const line of parser.push(chunk)) {
        this.lines.push(line); if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
        this.health = applyCaptureLine(this.health, line); this.emit('line', line); this.emit('health', this.health);
      }
    });
    this.helperDone = new Promise(resolve => {
      this.helperProc!.once('error', err => { this.health = applyCaptureLine(this.health, { type: 'error', code: 'spawn-failed', message: String(err), exit: -1, t_ms: 0 }); resolve({ code: -1, signal: null }); });
      this.helperProc!.once('close', (code, signal) => resolve({ code, signal }));
    });
  }
  /** Graceful stop: SIGTERM to the helper only; ffmpeg then sees EOF and finalizes the MP4 itself. */
  async stop(graceMs = 5000): Promise<CaptureResult> {
    if (this.helperProc && this.helperProc.exitCode === null) this.helperProc.kill('SIGTERM');
    const timer = setTimeout(() => { this.helperProc?.kill('SIGKILL'); }, graceMs);
    try { return await this.wait(); } finally { clearTimeout(timer); }
  }
  async wait(): Promise<CaptureResult> {
    const helper = await this.helperDone!; const ffmpeg = await this.ffmpegProc!.done;
    return { ffmpegCode: ffmpeg.code, helperCode: helper.code, helperSignal: helper.signal, health: this.health, ffmpegStderr: ffmpeg.stderr, lines: this.lines };
  }
}
