import { ChildProcess, spawn } from 'node:child_process';
import type { CaptureService } from './captureService';
import { MjpegSplitter, type ProgramFrame } from './programFeed';

/**
 * The always-on monitor encoder (issue #96): one 'auto' consumer of the shared program capture (#95) that turns the
 * card's frames into small JPEGs (about 10 fps, 960 px wide) for the PGM panes on the desk, iPad and phone. Only the
 * latest JPEG is kept. A frame is served only while the capture reports a locked signal and the JPEG is fresh, so a
 * lost signal or a stopped capture is said plainly instead of showing a frozen picture.
 */
export const MONITOR_ID = 'monitor';
const FRESH_MS = 1500;

export interface ProgramMonitorOptions {
  /** The FFmpeg to run (the pinned runtime), or null when none is installed. */
  ffmpeg: () => string | null;
  fps?: number;
  width?: number;
}

export class ProgramMonitor {
  private latest: ProgramFrame | null = null;
  private running = false;
  private noRuntime = false;
  /** JPEGs received since start (for rate checks). */
  private frames = 0;

  constructor(private readonly capture: CaptureService, private readonly options: ProgramMonitorOptions) {}

  get fps(): number { return this.options.fps ?? 10; }

  /** Attach to the capture (call after the capture service starts; it re-attaches across capture restarts by itself). */
  start(): void {
    if (this.capture.consumer(MONITOR_ID)) return;   // already attached (a capture restart() drops consumers; call again after it)
    const bin = this.options.ffmpeg();
    this.noRuntime = !bin;
    if (!bin) return;
    this.running = true;
    const width = this.options.width ?? 960;
    this.capture.addConsumer({
      id: MONITOR_ID, restart: 'auto',
      spawn: (input: string): ChildProcess => {
        const child = spawn('/usr/bin/nice', ['-n', '10', bin, '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'matroska', '-i', input,
          '-an', '-vf', `fps=${this.fps},scale=${width}:-2`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
        const splitter = new MjpegSplitter();
        child.stdout!.on('data', (chunk: Buffer) => {
          const frames = splitter.push(chunk);
          if (frames.length) { this.frames += frames.length; this.latest = { body: frames[frames.length - 1], type: 'image/jpeg', at: Date.now() }; }
        });
        return child;
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false; this.latest = null;
    await this.capture.removeConsumer(MONITOR_ID);
  }

  /** Why there is no picture right now, in words for the operator; null when a live picture is available. */
  reason(now = Date.now()): string | null {
    const st = this.capture.status();
    if (!st.enabled) return 'Program capture is off';
    if (this.noRuntime) return 'The streaming FFmpeg runtime is not installed, so there is no program preview';
    if (st.device === 'busy') return 'The capture card is in use by another app';
    if (st.device === 'missing') return 'No capture card found';
    if (st.device === 'disconnected') return 'The capture card stopped responding';
    if (st.process !== 'running') return 'Program capture is restarting';
    if (st.signal === 'absent') return 'No signal on the capture card';
    if (st.signal !== 'locked') return 'Waiting for the capture card';
    if (!this.latest) return 'Waiting for the first program picture';
    if (now - this.latest.at > FRESH_MS) return 'The program preview stopped updating';
    return null;
  }

  /** The current JPEG, or null (see reason()). Never a frame from before a signal loss. */
  frame(now = Date.now()): ProgramFrame | null { return this.reason(now) === null ? this.latest : null; }

  status(now = Date.now()): { running: boolean; lastFrameAgoMs: number | null; error: string | null; frames: number } {
    return { frames: this.frames, running: this.running && this.capture.consumer(MONITOR_ID)?.state === 'attached', lastFrameAgoMs: this.latest ? now - this.latest.at : null, error: this.reason(now) };
  }
}
