import type { TrackingControlConfig } from './types';
// Deliberately independent of transports and clocks. The manager supplies time.
export interface TrackingObservation { cx: number; cy: number; w: number; h: number; conf: number; frameTs: number; state?: string }
export interface ControlOutput { pan: number; tilt: number; state: 'tracking'|'holding'|'idle' }
/** Held framing starts to give way to centre above this share of full tracking speed, and fully at YIELD_FULL. */
const YIELD_FROM = 0.12;
const YIELD_FULL = 0.45;
/** Seconds to ease from centre back to the held framing once the subject slows. */
const FRAMING_RETURN_S = 2;
/** The closest a held framing may sit to the picture edge (in picture widths/heights). */
const FRAMING_EDGE = 0.28;
export class TrackingController {
  private framing = [.5, .5];
  private framingYield = 0;
  private yieldAt: number | null = null;
  private lastPan = 0;
  private lastTilt = 0;
  private filtered = [0, 0];
  private derivative = [0, 0];
  private active = [false, false];
  private frameTs: number | null = null;
  private lostAt: number | null = null;
  constructor(private readonly config: TrackingControlConfig) {}
  /** The operator's cap (the Track speed slider); the config object is this controller's own copy. */
  setMaxSpeed(value: number): void { (this.config as { maxSpeed: number }).maxSpeed = value; }
  /** Session-local composition; changing it discards derivative and smoothing history. */
  setFraming(cx: number, cy: number): void {
    if (![cx, cy].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError('Invalid framing center');
    // Keep room for the camera's lag between a held subject and the picture edge.
    const clamp = (value: number) => Math.min(1 - FRAMING_EDGE, Math.max(FRAMING_EDGE, value));
    this.framing = [clamp(cx), clamp(cy)]; this.reset();
  }
  reset(): void { this.framingYield = 0; this.yieldAt = null; this.lastPan = 0; this.lastTilt = 0; this.filtered = [0, 0]; this.derivative = [0, 0]; this.active = [false, false]; this.frameTs = null; this.lostAt = null; }
  update(observation: TrackingObservation | null, now: number): ControlOutput {
    const v = observation;
    const valid = v && [v.cx, v.cy, v.w, v.h, v.conf, v.frameTs, now].every(Number.isFinite) && v.conf > 0 && v.conf <= 1 &&
      // The box may run past the picture edge (a subject leaving frame is exactly when to keep chasing); its centre may not.
      v.w > 0 && v.h > 0 && v.w <= 1.5 && v.h <= 1.5 && v.cx >= 0 && v.cx <= 1 && v.cy >= 0 && v.cy <= 1 &&
      v.frameTs >= 0 && v.frameTs <= now + 50 && (!v.state || v.state === 'tracking');
    if (!valid || now - v.frameTs >= 700) {
      this.lostAt ??= now; this.active = [false, false];
      return { pan: 0, tilt: 0, state: now - this.lostAt < this.config.lostHoldMs ? 'holding' : 'idle' };
    }
    this.lostAt = null;
    // Held framing gives way to centre while the subject is moving (the camera always trails a moving subject, and an
    // off-centre target leaves no room on the near side), then eases back as they settle: lead room, like an operator.
    // The yield follows how hard the camera was last driven: it gives way at once, and comes back slowly (no hunting).
    const drive = Math.hypot(this.lastPan, this.lastTilt) / Math.max(1e-6, this.config.maxSpeed);
    const wanted = Math.min(1, Math.max(0, (drive - YIELD_FROM) / (YIELD_FULL - YIELD_FROM)));
    const since = this.yieldAt === null ? 0 : Math.max(0, now - this.yieldAt) / 1000;
    this.yieldAt = now;
    this.framingYield = wanted >= this.framingYield ? wanted : Math.max(wanted, this.framingYield - since / FRAMING_RETURN_S);
    const target = [.5 + (this.framing[0] - .5) * (1 - this.framingYield), .5 + (this.framing[1] - .5) * (1 - this.framingYield)];
    const error = [v.cx - target[0], target[1] - v.cy];
    if (this.frameTs === null || v.frameTs > this.frameTs) {
      const dt = this.frameTs === null ? 0 : (v.frameTs - this.frameTs) / 1000;
      for (let axis = 0; axis < 2; axis++) {
        const previous = this.filtered[axis];
        const alpha = dt ? 1 - Math.exp(-dt / .10) : 1;
        this.filtered[axis] += alpha * (error[axis] - this.filtered[axis]);
        const slope = dt ? (this.filtered[axis] - previous) / dt : 0;
        this.derivative[axis] = .5 * this.derivative[axis] + .5 * slope;
      }
      this.frameTs = v.frameTs;
    }
    const age = Math.max(0, now - v.frameTs);
    const gain = this.config.kp / (1 + (age + this.config.pipelineDelayMs) / 500);
    const staleScale = age <= 400 ? 1 : Math.max(0, (700 - age) / 300);
    const axisOutput = (axis: number) => {
      const magnitude = Math.abs(error[axis]);
      if (magnitude <= this.config.deadzone) this.active[axis] = false;
      else if (magnitude > this.config.deadzone * 1.15) this.active[axis] = true;
      if (!this.active[axis]) return 0;
      // Positive error means move toward the target. A declining error adds
      // negative derivative damping, not anticipatory acceleration.
      const raw = gain * this.filtered[axis] + this.config.kd * this.derivative[axis];
      const directed = Math.sign(error[axis]) * Math.max(0, Math.sign(error[axis]) * raw);
      const result = Math.max(-this.config.maxSpeed, Math.min(this.config.maxSpeed, directed * staleScale));
      return Number.isFinite(result) ? result : 0;
    };
    const panOut = axisOutput(0), tiltOut = axisOutput(1);
    this.lastPan = panOut; this.lastTilt = tiltOut;
    const pan = panOut * (this.config.invertPan ? -1 : 1), tilt = tiltOut * (this.config.invertTilt ? -1 : 1);
    return { pan: pan || 0, tilt: tilt || 0, state: 'tracking' };
  }
}
