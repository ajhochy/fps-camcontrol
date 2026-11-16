import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureService, CaptureServiceStatus, ConsumerEndReason } from '../program/captureService';
import { STREAMING_PROFILES, StreamingConfig } from './streamingConfig';
import { captureTeeArgs } from './teeArgs';

/**
 * Output sessions (issue #70). A session is one encoder FFmpeg attached to the shared program capture as a consumer
 * with `restart: 'never'`: it never opens the card, closing a preview or the iPad page cannot touch it, and when the
 * capture process or the device is lost the session ENDS (the MP4 is finalized from what arrived) and stays ended until
 * the operator starts a new one. Signal absence on a healthy capture is not a loss: filler (black + silence) keeps the
 * session's timeline running and the session reports a visible 'no-signal' warning.
 *
 * Mode today is Record only; Stream + record arrives with the YouTube milestone (#79–#83).
 */
export type SessionMode = 'record';
export type SessionState = 'starting' | 'running' | 'stopping' | 'ended';
export type SessionEndReason = 'stopped' | 'capture-lost' | 'device-lost' | 'format-changed' | 'stalled' | 'encoder-exited' | 'attach-failed' | 'service-stopped';
export interface SessionStatus {
  id: string; mode: SessionMode; state: SessionState; profile: string; videoBitrateKbps: number; videoDelayFrames: number;
  recordingPath: string; startedAt: string; endedAt?: string; endReason?: SessionEndReason; endDetail?: string;
  /** Live, while not ended: what the operator must see without the session stopping. */
  warning: 'no-signal' | null;
  encoderExit?: { code: number | null; signal: string | null };
}
export class SessionError extends Error { constructor(readonly code: 'disabled' | 'already-running' | 'capture-not-running' | 'no-folder' | 'folder-unusable' | 'no-runtime' | 'stream-unavailable', message: string) { super(message); } }

const END_REASON: Record<ConsumerEndReason, SessionEndReason> = {
  'removed': 'stopped', 'capture-lost': 'capture-lost', 'format-changed': 'format-changed', 'stalled': 'stalled',
  'consumer-exited': 'encoder-exited', 'attach-failed': 'attach-failed', 'service-stopped': 'service-stopped',
};

export interface OutputSessionsOptions {
  /** Absolute path of the FFmpeg runtime to use, or null when none is installed (sessions then refuse to start). */
  ffmpeg: () => string | null;
  now?: () => Date;
  log?: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
}

export class OutputSessions {
  private session?: SessionStatus;
  private seq = 0;
  private stopping?: Promise<SessionStatus>;

  constructor(private readonly capture: CaptureService, private readonly options: OutputSessionsOptions) {
    capture.on('consumer-ended', (id: string, reason: ConsumerEndReason, detail?: string) => {
      const s = this.session;
      // While a stop is in progress the capture service reports 'removed'; end() finishes with the real reason.
      if (s && s.id === id && s.state !== 'ended' && s.state !== 'stopping') this.finish(END_REASON[reason], detail, true);
    });
    capture.on('consumer-exit', (id: string, code: number | null, signal: string | null) => { if (this.session?.id === id) this.session.encoderExit = { code, signal }; });
    capture.on('status', (st: CaptureServiceStatus) => {
      const s = this.session;
      if (s && s.state === 'running' && st.device === 'disconnected') void this.end('device-lost', 'the capture device stopped responding');
      if (s && s.state === 'starting' && st.consumers.find(c => c.id === s.id)?.state === 'attached') s.state = 'running';
    });
  }

  /** A session is starting, running or finalizing: the settings that define it are locked (#69). */
  running(): boolean { return !!this.session && this.session.state !== 'ended'; }

  status(): SessionStatus | null {
    const s = this.session; if (!s) return null;
    const warning = s.state !== 'ended' && this.capture.status().signal === 'absent' ? 'no-signal' : null;
    return { ...s, warning };
  }

  start(cfg: StreamingConfig, mode: string = 'record'): SessionStatus {
    if (mode !== 'record') throw new SessionError('stream-unavailable', 'Stream + record arrives with the YouTube milestone; only Record only is available');
    if (!cfg.enabled) throw new SessionError('disabled', 'Streaming is switched off in the settings');
    if (this.running()) throw new SessionError('already-running', 'A session is already running');
    const cap = this.capture.status();
    if (!cap.enabled || cap.process !== 'running') throw new SessionError('capture-not-running', 'Program capture is not running');
    if (cap.device === 'disconnected' || cap.device === 'missing' || cap.device === 'busy') throw new SessionError('capture-not-running', `The capture device is ${cap.device}`);
    if (!cfg.recordingFolder) throw new SessionError('no-folder', 'Choose a recording folder first');
    try { if (!fs.statSync(cfg.recordingFolder).isDirectory()) throw new Error('not a folder'); fs.accessSync(cfg.recordingFolder, fs.constants.W_OK); }
    catch { throw new SessionError('folder-unusable', `The recording folder cannot be written: ${cfg.recordingFolder}`); }
    const ffmpeg = this.options.ffmpeg();
    if (!ffmpeg) throw new SessionError('no-runtime', 'The streaming FFmpeg runtime is not installed');

    const profile = STREAMING_PROFILES[cfg.profile];
    const now = (this.options.now ?? (() => new Date()))();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const recordingPath = uniquePath(path.join(cfg.recordingFolder, `FPS ${stamp}.mp4`));
    const id = `session-${++this.seq}`;
    const build = (input: string) => captureTeeArgs({ input, recordingPath, width: profile.width, height: profile.height, fps: profile.fps, videoBitrateK: cfg.videoBitrateKbps, videoDelayFrames: cfg.videoDelayFrames, recordingOnFail: 'abort' });
    build('/dev/null');   // validate every argument before anything starts
    this.session = { id, mode: 'record', state: 'starting', profile: cfg.profile, videoBitrateKbps: cfg.videoBitrateKbps, videoDelayFrames: cfg.videoDelayFrames, recordingPath, startedAt: now.toISOString(), warning: null };
    this.stopping = undefined;
    this.capture.addConsumer({ id, restart: 'never', spawn: input => spawn('/usr/bin/nice', ['-n', '5', ffmpeg, ...build(input)], { stdio: ['ignore', 'ignore', 'ignore'] }) });
    this.options.log?.('info', 'output session started', { id, recordingPath });
    return this.status()!;
  }

  /** Normal Stop: detach (the encoder sees end of stream and finalizes the MP4), then report. */
  stop(): Promise<SessionStatus> { return this.end('stopped'); }

  private end(reason: SessionEndReason, detail?: string): Promise<SessionStatus> {
    const s = this.session;
    if (!s) return Promise.reject(new Error('No session'));
    if (s.state === 'ended') return Promise.resolve(this.status()!);
    if (this.stopping) return this.stopping;
    s.state = 'stopping';
    this.stopping = (async () => {
      await this.capture.removeConsumer(s.id, 10_000);
      this.finish(reason, detail, false);
      return this.status()!;
    })();
    return this.stopping;
  }

  private finish(reason: SessionEndReason, detail: string | undefined, cleanup: boolean): void {
    const s = this.session!;
    if (s.state === 'ended') return;
    s.state = 'ended'; s.endReason = reason; s.endDetail = detail; s.endedAt = (this.options.now ?? (() => new Date()))().toISOString();
    this.options.log?.(reason === 'stopped' ? 'info' : 'warn', 'output session ended', { id: s.id, reason, detail });
    if (cleanup) void this.capture.removeConsumer(s.id);   // lets the encoder finish and forgets the consumer
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, -ext.length);
  for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}
