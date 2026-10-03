import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { analyzeCalibrationFrames, runDryCalibration, summarizeTrials, type CalibrationFrame, type CalibrationTrial } from '../src/tracking/calibration';

const root = path.resolve(__dirname, '..');
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class CalibrationError extends Error {}
function fail(message: string): never { throw new CalibrationError(message); }
/** Isolated helper accepts bounded JPEG on stdin, returns grayscale pixels only. */
export function decodeJpeg(jpeg: Buffer, capturedAt: number, python: string, signal?: AbortSignal): Promise<CalibrationFrame> {
  if (signal?.aborted || jpeg.length > 2 * 1024 * 1024) return Promise.reject(new Error('Calibration frame unavailable'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', path.join(root, 'tracker-sidecar/calibration_frame.py')], {
      cwd: root, env: { PATH: '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = []; let length = 0, settled = false;
    const finish = (error?: Error, frame?: CalibrationFrame) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(frame!);
    };
    const cancel = () => finish(new Error('Calibration frame unavailable'));
    const timer = setTimeout(cancel, 2000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', cancel); child.stdin.on('error', cancel); child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 65536) cancel(); else chunks.push(chunk); });
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) return cancel();
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value.width !== 160 || value.height !== 90 || !Array.isArray(value.pixels) || value.pixels.length !== 14400 ||
          value.pixels.some((n: unknown) => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)) return cancel();
        finish(undefined, { width: 160, height: 90, pixels: Uint8Array.from(value.pixels), capturedAt });
      } catch { cancel(); }
    });
    child.stdin.end(jpeg);
  });
}
export async function runCli(args: string[], externalSignal?: AbortSignal) {
  if (args.length === 1 && args[0] === '--help') return {
    description: 'Developer calibration tool; use a running tracking backend with an idle connected gimbal and active Sony live view. No configuration is written.',
    dryRun: 'node -r ts-node/register/transpile-only scripts/tracking-calibrate.ts --dry-run --trials 3',
    realRun: 'node -r ts-node/register/transpile-only scripts/tracking-calibrate.ts --yes-move --backend-url http://127.0.0.1:PORT --source DEVICE',
    options: ['--trials 1..10 (default 3)', '--horizontal-fov-degrees DEGREES (optional calibrated horizontal field of view)', '--python /absolute/path/to/verified/python (default bundled runtime)'],
    authentication: 'For an embedded backend supply its session token through FPS_CALIBRATION_SESSION; never put it in a command argument.',
    safety: 'Real movement needs --yes-move. Backend owns a fixed 0.1 pan command and 800 ms stop deadline. Ctrl-C requests an immediate stop. Physical calibration remains operator-supervised.',
  };
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry-run', '--yes-move'].includes(arg)) { if (flags.has(arg)) fail('Duplicate calibration flag'); flags.add(arg); }
    else if (['--backend-url', '--source', '--trials', '--horizontal-fov-degrees', '--python'].includes(arg)) {
      if (values.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) fail('Invalid calibration option'); values.set(arg, args[++i]);
    } else fail('Unknown calibration option');
  }
  const trials = Number(values.get('--trials') ?? 3), fov = values.has('--horizontal-fov-degrees') ? Number(values.get('--horizontal-fov-degrees')) : undefined;
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) fail('Calibration trials must be 1–10');
  if (fov !== undefined && (!Number.isFinite(fov) || fov <= 0 || fov >= 180)) fail('Invalid calibrated horizontal field of view');
  if (flags.has('--dry-run')) return runDryCalibration({ trials });
  if (!flags.has('--yes-move')) fail('Real calibration requires explicit --yes-move');
  let url: URL;
  try { url = new URL(values.get('--backend-url') ?? ''); } catch { fail('Specify an exact loopback --backend-url'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Calibration requires an exact loopback backend origin');
  const sourceId = values.get('--source'); if (!sourceId || sourceId.length > 128) fail('Specify a tracking --source');
  const python = values.get('--python') ?? path.join(root, 'dist/tracking-runtime/python/bin/python3');
  if (!path.isAbsolute(python) || !existsSync(python)) fail('Verified bundled calibration Python is unavailable');
  const session = process.env.FPS_CALIBRATION_SESSION;
  if (session && !/^[A-Za-z0-9_-]{16,256}$/.test(session)) fail('Invalid calibration session credential');
  const local = new AbortController();
  const abort = () => local.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) local.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const request = async (route: string, body?: object, stopping = false): Promise<Response> => {
    const timeout = AbortSignal.timeout(2000);
    const signal = stopping ? timeout : AbortSignal.any([local.signal, timeout]);
    try { return await fetch(url.origin + route, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Origin: url.origin, ...(session ? { Cookie: 'fps-session=' + session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { return fail('Calibration backend request failed'); }
  };
  let active: string | undefined;
  const stop = async () => {
    if (!active) return;
    const operationId = active; active = undefined;
    const response = await request('/api/tracking/calibration/stop', { operationId }, true);
    if (!response.ok && response.status !== 404) fail('Calibration backend could not confirm stop');
  };
  try {
    const statusResponse = await request('/api/tracking/status');
    if (!statusResponse.ok) fail('Calibration tracking status unavailable');
    const status = await statusResponse.json() as { enabled?: boolean; sidecar?: { state?: string }; sources?: { sourceId: string; sonyCameraId: string; cameraId: string | null }[] };
    const source = status.sources?.find(item => item.sourceId === sourceId);
    if (!status.enabled || status.sidecar?.state !== 'connected' || !source?.cameraId || !source.sonyCameraId) fail('Calibration requires connected tracking and a bound gimbal');
    const capture = async (): Promise<CalibrationFrame> => {
      const response = await request('/api/sony/cameras/' + encodeURIComponent(source.sonyCameraId) + '/live-view/frame');
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('image/jpeg')) fail('Calibration live-view frame unavailable');
      const capturedAt = Number(response.headers.get('X-Frame-Captured-At'));
      if (!Number.isInteger(capturedAt) || capturedAt <= 0 || Date.now() - capturedAt >= 500 || capturedAt > Date.now() + 50) fail('Calibration live-view frame is stale');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2 * 1024 * 1024) fail('Calibration frame exceeds limit'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      return decodeJpeg(Buffer.concat(chunks), capturedAt, python, local.signal);
    };
    const measurements: CalibrationTrial[] = [];
    for (let i = 0; i < trials; i++) {
      const frames = [await capture()];
      if (local.signal.aborted) fail('Calibration canceled');
      const response = await request('/api/tracking/calibration/start', { sourceId, yesMove: true });
      if (!response.ok) fail('Calibration start refused: tracking or manual motion may be active');
      const pulse = await response.json() as { operationId: string; startedAt: number; endsAt: number; durationMs: number; speed: number };
      if (!/^[0-9a-f-]{36}$/.test(pulse.operationId) || !Number.isFinite(pulse.startedAt) || pulse.durationMs > 1000 || pulse.durationMs <= 0 || pulse.endsAt !== pulse.startedAt + pulse.durationMs || !Number.isFinite(pulse.speed) || pulse.speed <= 0 || pulse.speed > .15) fail('Invalid calibration operation');
      active = pulse.operationId;
      try {
        while (Date.now() < pulse.endsAt && !local.signal.aborted) { frames.push(await capture()); await wait(30); }
        if (local.signal.aborted) fail('Calibration canceled');
        measurements.push(analyzeCalibrationFrames(frames, pulse.startedAt, pulse.speed, fov));
      } finally { await stop(); }
      if (i < trials - 1) await wait(300);
    }
    return { ...summarizeTrials(measurements), synthetic: false, timing: 'Sony HTTP receipt timestamps; includes capture and transport latency', ...(fov !== undefined ? { horizontalFovDegrees: fov } : {}) };
  } finally {
    try { await stop(); } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); externalSignal?.removeEventListener('abort', abort); }
  }
}
if (require.main === module) void runCli(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
  console.error(error instanceof CalibrationError ? error.message : 'Calibration failed'); process.exitCode = 1;
});
