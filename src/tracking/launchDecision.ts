import fs from 'node:fs';
import path from 'node:path';

export type TrackingLaunch =
  | { mode: 'off' }
  | { mode: 'developer' }
  | { mode: 'owned'; paths?: { python: string; script: string; model: string } }
  | { mode: 'unavailable'; reason: string };

export interface LaunchInputs {
  enabled: boolean;
  paused: boolean;
  env: Record<string, string | undefined>;
  /** Repository root (parent of dist/ and tracker-sidecar/); only used when not packaged. */
  repoRoot: string;
  isFile?: (file: string) => boolean;
}

/**
 * Who owns the vision helper.
 *  - packaged (CAMCONTROL_EMBEDDED=1): always the app's own helper, when this build includes tracking.
 *  - TRACKER_WS_TOKEN set: developer mode, connect to tracking.sidecarUrl (a human started the helper).
 *  - otherwise: the app launches and owns the helper from <repo>/dist/tracking-runtime.
 * A missing runtime is reported, never thrown: the app still starts.
 */
export function decideTrackingLaunch(input: LaunchInputs): TrackingLaunch {
  if (!input.enabled || input.paused) return { mode: 'off' };
  if (input.env.CAMCONTROL_EMBEDDED === '1') {
    return input.env.CAMCONTROL_TRACKING_AVAILABLE === '1' ? { mode: 'owned' }
      : { mode: 'unavailable', reason: 'tracking is not included in this app build' };
  }
  if (input.env.TRACKER_WS_TOKEN) return { mode: 'developer' };
  const isFile = input.isFile ?? ((file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  const runtime = path.join(input.repoRoot, 'dist/tracking-runtime');
  const paths = {
    python: path.join(runtime, 'python/bin/python3'),
    script: path.join(input.repoRoot, 'tracker-sidecar/main.py'),
    model: path.join(runtime, 'models/object_detection_yolox_2022nov.onnx'),
  };
  if (!isFile(paths.python) || !isFile(paths.model)) return { mode: 'unavailable', reason: 'tracking runtime is not staged (run: node scripts/stage-tracking-runtime.cjs)' };
  if (!isFile(paths.script)) return { mode: 'unavailable', reason: 'tracker-sidecar/main.py is missing' };
  return { mode: 'owned', paths };
}

/** Restart delays for a helper that dies; capped so a broken runtime cannot spin. */
export function helperRestartDelay(attempt: number): number {
  return [1000, 2000, 5000, 10000, 30000][Math.min(Math.max(attempt, 0), 4)];
}
