import fs from 'node:fs';
import type { AppState } from '../app/state';
import type { OutputSessions } from '../broadcast/outputSession';
import type { ProgramCaptureConfig } from '../broadcast/streamingConfig';
import { getResourcePath } from '../config/paths';
import type { CaptureService } from './captureService';

/** The running capture service and output sessions of one app instance (never serialized; status goes through AppState). */
export interface ProgramCaptureRuntime {
  capture: CaptureService;
  sessions: OutputSessions;
  /** Apply new programCapture settings: restart the service, or stop it when disabled. Refused while a session runs. */
  applyCapture(cfg: ProgramCaptureConfig): Promise<void>;
}
const runtimes = new WeakMap<AppState, ProgramCaptureRuntime>();
export function registerProgramCapture(state: AppState, runtime: ProgramCaptureRuntime): void { runtimes.set(state, runtime); }
export function programCaptureFor(state: AppState): ProgramCaptureRuntime | undefined { return runtimes.get(state); }

/**
 * The streaming FFmpeg (#65): the bundled Resources/ffmpeg-runtime/ffmpeg in an installed app, never PATH or Homebrew.
 * Developer runs may point BROADCAST_FFMPEG at a build; an installed app (CAMCONTROL_RESOURCES set) ignores it.
 */
export function resolveBroadcastFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.CAMCONTROL_RESOURCES && env.BROADCAST_FFMPEG) return env.BROADCAST_FFMPEG;
  const bundled = getResourcePath('ffmpeg-runtime/ffmpeg');
  try { fs.accessSync(bundled, fs.constants.X_OK); return bundled; } catch { return null; }
}
