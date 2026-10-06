import type { MotionDevice } from '../devices/motionDevice';
import { MotionLedger } from './motionLedger';

export interface CalibrationFrame { width: number; height: number; pixels: Uint8Array; capturedAt: number }
export interface CalibrationTrial { delayMs: number | null; pixelsPerSecond: number | null; speed: number; width: number; pixelsPerSecondPerUnit?: number; degreesPerSecond?: number; degreesPerSecondPerUnit?: number }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function validateFrame(frame: CalibrationFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 32 || frame.width > 320 || frame.height < 8 || frame.height > 180 ||
    frame.pixels.length !== frame.width * frame.height || !Number.isFinite(frame.capturedAt)) throw new Error('Invalid calibration pixels');
}
/** Spatial grayscale registration. JPEG encoding/metadata never enters it. */
export function estimateHorizontalDisplacement(first: CalibrationFrame, next: CalibrationFrame): { pixels: number; error: number; texture: number } {
  validateFrame(first); validateFrame(next);
  if (first.width !== next.width || first.height !== next.height) throw new Error('Calibration frame dimensions changed');
  const limit = Math.min(24, Math.floor(first.width / 4));
  let best = Infinity, displacement = 0, texture = 0, count = 0;
  for (let y = 0; y < first.height; y += 2) for (let x = limit; x < first.width - limit; x++) {
    texture += Math.abs(first.pixels[y * first.width + x] - first.pixels[y * first.width + x - 1]); count++;
  }
  for (let shift = -limit; shift <= limit; shift++) {
    let error = 0;
    for (let y = 0; y < first.height; y += 2) for (let x = limit; x < first.width - limit; x++) error += Math.abs(first.pixels[y * first.width + x] - next.pixels[y * next.width + x + shift]);
    error /= count;
    if (error < best || (error === best && Math.abs(shift) < Math.abs(displacement))) { best = error; displacement = shift; }
  }
  return { pixels: texture / count < 2 ? 0 : displacement, error: best, texture: texture / count };
}
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export function summarizeTrials(trials: CalibrationTrial[]) {
  const delays = trials.flatMap(t => t.delayMs === null ? [] : [t.delayMs]);
  const rates = trials.flatMap(t => t.pixelsPerSecond === null ? [] : [t.pixelsPerSecond]);
  const medianDelayMs = median(delays), medianPixelsPerSecond = median(rates);
  const delaySpreadMs = delays.length ? Math.max(...delays) - Math.min(...delays) : null;
  const rateSpread = rates.length ? Math.max(...rates) - Math.min(...rates) : null;
  const unreliable = delays.length !== trials.length || !medianPixelsPerSecond || delaySpreadMs === null || delaySpreadMs > Math.max(100, (medianDelayMs ?? 0) * .5) || (rateSpread ?? Infinity) > Math.abs(medianPixelsPerSecond) * .5;
  return { trials, medianDelayMs, medianPixelsPerSecond, medianPixelsPerSecondPerUnit: median(trials.flatMap(t => t.pixelsPerSecond === null ? [] : [t.pixelsPerSecond / t.speed])), delaySpreadMs, pixelRateSpread: rateSpread,
    units: 'processed pixels/second', reliability: unreliable ? 'unreliable rig' : 'consistent synthetic/observed trials',
    recommendedConfig: { pipelineDelayMs: Math.round(medianDelayMs ?? 300), kp: 1.2, kd: .12, maxSpeed: .15 },
    guidance: 'Recommendations are a starting point only; verify physical gain and safety before use. Pixels are not angles without calibrated horizontal field of view.' };
}
export function beginCalibrationPulse(device: MotionDevice, ledger: MotionLedger, options: { speed?: number; durationMs?: number; now?: () => number; onStop?: () => void; healthy?: () => boolean } = {}) {
  const speed = options.speed ?? .1, durationMs = options.durationMs ?? 800, now = options.now ?? Date.now;
  if (!Number.isFinite(speed) || speed <= 0 || speed > .15 || !Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 1000) throw new Error('Calibration command exceeds safety cap');
  if (!device.connected || device.gimbalAttached === false || device.protocol !== 'dji-bridge') throw new Error('Calibration requires a connected gimbal');
  const startedAt = now(), endsAt = startedAt + durationMs;
  let stopped = false, stopFailed = false, pump: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true; if (pump) clearInterval(pump); if (deadline) clearTimeout(deadline);
    try { ledger.stop(device); } catch { stopFailed = true; }
    finally { try { options.onStop?.(); } catch { stopFailed = true; } }
  };
  const send = () => {
    if (stopped) return;
    if (now() >= endsAt || !device.connected || device.gimbalAttached === false || (options.healthy && !options.healthy())) { stop(); return; }
    try { ledger.send(device, speed, 0, now()); } catch { stop(); }
  };
  deadline = setTimeout(stop, durationMs); pump = setInterval(send, 50); send();
  return { stop, startedAt, endsAt, speed, durationMs, get stopped() { return stopped; }, get stopFailed() { return stopFailed; } };
}
/** Analyze frames relative to the command; duplicate receipt timestamps ignored. */
export function analyzeCalibrationFrames(frames: CalibrationFrame[], startedAt: number, speed: number, horizontalFovDegrees?: number): CalibrationTrial {
  if (!frames.length) throw new Error('Calibration requires a baseline frame');
  const baseline = frames[0]; validateFrame(baseline);
  let delayMs: number | null = null;
  const points: { at: number; pixels: number }[] = [];
  for (const frame of frames.slice(1)) {
    if (frame.capturedAt <= startedAt || frame.capturedAt <= (points.at(-1)?.at ?? -Infinity)) continue;
    const displacement = estimateHorizontalDisplacement(baseline, frame);
    if (Math.abs(displacement.pixels) >= 1 && displacement.texture >= 2 && displacement.error < 40) {
      delayMs ??= frame.capturedAt - startedAt; points.push({ at: frame.capturedAt, pixels: displacement.pixels });
    }
  }
  // Include quantized plateaus: dropping unchanged frames biases slow motion up
  // toward one pixel per capture interval. Fit displacement over elapsed time.
  let pixelsPerSecond: number | null = null;
  if (points.length >= 3 && points.at(-1)!.at - points[0].at >= 100) {
    const meanAt = points.reduce((sum, point) => sum + point.at - points[0].at, 0) / points.length;
    const meanPixels = points.reduce((sum, point) => sum + point.pixels, 0) / points.length;
    const numerator = points.reduce((sum, point) => sum + (point.at - points[0].at - meanAt) * (point.pixels - meanPixels), 0);
    const denominator = points.reduce((sum, point) => sum + (point.at - points[0].at - meanAt) ** 2, 0);
    const rate = Math.abs(numerator / denominator) * 1000;
    if (Number.isFinite(rate) && rate > 0) pixelsPerSecond = rate;
  }
  return { delayMs, pixelsPerSecond, speed, width: baseline.width,
    ...(pixelsPerSecond !== null ? { pixelsPerSecondPerUnit: pixelsPerSecond / speed } : {}),
    ...(horizontalFovDegrees !== undefined && pixelsPerSecond !== null ? { degreesPerSecond: pixelsPerSecond / baseline.width * horizontalFovDegrees,
      degreesPerSecondPerUnit: pixelsPerSecond / baseline.width * horizontalFovDegrees / speed } : {}) };
}
export interface CalibrationOptions {
  device: MotionDevice; yesMove: boolean; trackingConnected: boolean; capture: (signal?: AbortSignal) => Promise<CalibrationFrame>;
  trials?: number; durationMs?: number; speed?: number; horizontalFovDegrees?: number; signal?: AbortSignal;
  now?: () => number; sleep?: (ms: number) => Promise<void>; ledger?: MotionLedger;
}
export async function calibrate(options: CalibrationOptions) {
  const { device, capture, signal } = options, count = options.trials ?? 3, now = options.now ?? Date.now, sleep = options.sleep ?? wait;
  if (!options.yesMove || !options.trackingConnected || !device.connected || device.gimbalAttached === false) throw new Error('Explicit movement consent and healthy tracking/gimbal required');
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Calibration trials must be1–10');
  if (options.horizontalFovDegrees !== undefined && (!Number.isFinite(options.horizontalFovDegrees) || options.horizontalFovDegrees <= 0 || options.horizontalFovDegrees >= 180)) throw new Error('Invalid calibrated field of view');
  const ledger = options.ledger ?? new MotionLedger(), trials: CalibrationTrial[] = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new Error('Calibration canceled');
    let pulse: ReturnType<typeof beginCalibrationPulse> | undefined;
    const local = new AbortController();
    const cancel = () => { pulse?.stop(); local.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const captureBounded = async (): Promise<CalibrationFrame | null> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      try { return await Promise.race([capture(local.signal), new Promise<null>(resolve => { timeout = setTimeout(() => { local.abort(); resolve(null); }, 2000); }),
        new Promise<null>(resolve => { aborted = () => resolve(null); local.signal.addEventListener('abort', aborted, { once: true }); })]); }
      finally { if (timeout) clearTimeout(timeout); if (aborted) local.signal.removeEventListener('abort', aborted); }
    };
    try {
      const baseline = await captureBounded(); if (!baseline) throw new Error('Calibration baseline unavailable'); validateFrame(baseline);
      if (signal?.aborted) throw new Error('Calibration canceled');
      pulse = beginCalibrationPulse(device, ledger, { speed: options.speed, durationMs: options.durationMs, now, onStop: () => local.abort() });
      const frames = [baseline];
      while (now() < pulse.endsAt && !pulse.stopped && !signal?.aborted) {
        await sleep(50);
        if (now() >= pulse.endsAt || pulse.stopped) break;
        ledger.send(device, pulse.speed, 0, now());
        const frame = await captureBounded(); if (!frame) break; frames.push(frame);
      }
      if (signal?.aborted) throw new Error('Calibration canceled');
      trials.push(analyzeCalibrationFrames(frames, pulse.startedAt, pulse.speed, options.horizontalFovDegrees));
    } finally { pulse?.stop(); ledger.stop(device); signal?.removeEventListener('abort', cancel); local.abort(); }
    if (i < count - 1) await sleep(100);
  }
  return summarizeTrials(trials);
}
export async function runDryCalibration({ trials = 3, durationMs = 800 } = {}) {
  // Load virtual networking only for explicit dry-run, never in the pure parser.
  const { VirtualDjiBridge } = await import('../testing/virtualDjiBridge');
  const { DjiBridgeDevice } = await import('../devices/djiBridgeDevice');
  const bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 20 });
  const port = await bridge.start();
  const device = new DjiBridgeDevice({ host: '127.0.0.1', port, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'calibration-virtual', 'Synthetic calibration');
  const history: { at: number; pixels: number }[] = [];
  try {
    device.connect(); const deadline = Date.now() + 5000;
    while (!device.connected || !device.gimbalAttached) { if (Date.now() > deadline) throw new Error('Virtual calibration device unavailable'); await wait(10); }
    const report = await calibrate({ device, yesMove: true, trackingConnected: true, trials, durationMs, capture: async () => {
      const now = Date.now(); history.push({ at: now, pixels: bridge.yaw * 160 / 60 });
      const sample = [...history].reverse().find(item => item.at <= now - 120) ?? history[0];
      const shift = Math.round(sample.pixels), width = 160, height = 90, pixels = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const column = (x - shift + width * 100) % width; pixels[y * width + x] = (column * 31 + y * 17 + column * y % 5 * 20) % 256; }
      return { width, height, pixels, capturedAt: now };
    } });
    return { ...report, synthetic: true, virtualCommandCount: bridge.log.filter(line => line.startsWith('moveVelocity')).length };
  } finally { device.close(); await bridge.stop(); }
}
