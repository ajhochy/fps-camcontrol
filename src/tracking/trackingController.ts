import type { TrackingControlConfig } from './types';
// Deliberately independent of transports and clocks. The manager supplies time.
export interface TrackingObservation { cx: number; cy: number; w: number; h: number; conf: number; frameTs: number; state?: string }
export interface ControlOutput { pan: number; tilt: number; state: 'tracking'|'holding'|'idle' }
export class TrackingController {
  private filtered = [0, 0];
  private derivative = [0, 0];
  private active = [false, false];
  private frameTs: number | null = null;
  private lostAt: number | null = null;
  constructor(private readonly config: TrackingControlConfig) {}
  reset(): void { this.filtered = [0, 0]; this.derivative = [0, 0]; this.active = [false, false]; this.frameTs = null; this.lostAt = null; }
  update(observation: TrackingObservation | null, now: number): ControlOutput {
    const v = observation;
    const valid = v && [v.cx, v.cy, v.w, v.h, v.conf, v.frameTs, now].every(Number.isFinite) && v.conf > 0 && v.conf <= 1 &&
      v.w > 0 && v.h > 0 && v.cx - v.w / 2 >= 0 && v.cx + v.w / 2 <= 1 && v.cy - v.h / 2 >= 0 && v.cy + v.h / 2 <= 1 &&
      v.frameTs >= 0 && v.frameTs <= now + 50 && (!v.state || v.state === 'tracking');
    if (!valid || now - v.frameTs >= 700) {
      this.lostAt ??= now; this.active = [false, false];
      return { pan: 0, tilt: 0, state: now - this.lostAt < this.config.lostHoldMs ? 'holding' : 'idle' };
    }
    this.lostAt = null;
    const error = [v.cx - .5, .5 - v.cy];
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
    const pan = axisOutput(0) * (this.config.invertPan ? -1 : 1), tilt = axisOutput(1) * (this.config.invertTilt ? -1 : 1);
    return { pan: pan || 0, tilt: tilt || 0, state: 'tracking' };
  }
}
