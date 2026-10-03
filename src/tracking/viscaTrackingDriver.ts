import type { MotionDevice } from '../devices/motionDevice';
import type { MotionLedger } from './motionLedger';
import { toPanSpeed, toTiltSpeed } from '../visca/ptzActions';

/**
 * Drives one VISCA head for tracking, safely.
 *
 * The DJI Pi bridge has its own 250 ms dead-man: it stops the gimbal when commands stop. A VISCA head does not: it keeps
 * moving at the last commanded speed until it receives a stop. So this driver owns an app-side dead-man: while the head is
 * being driven, an independent timer (not the tracking tick) sends an explicit stop whenever no fresh velocity has arrived
 * for DEADMAN_MS. A stalled tracking loop, a helper that went quiet or a lost observation therefore still stops the head.
 *
 * It also discretises the velocity the way the head will (pan 1-24, tilt 1-20), treats anything under MIN_COMMAND as a stop
 * (never a speed-1 creep), sends only when the discrete command changes (at most every MIN_CHANGE_MS) and re-sends it every
 * KEEPALIVE_MS. VISCA needs no refresh; the resend only recovers a lost UDP datagram within 200 ms, at the same order of
 * rate as the manual-control heartbeat. A stop is never rate-limited and is repeated once (STOP_REPEAT_MS) in case the first
 * datagram is lost - unless something else (an operator) has started moving the head in the meantime.
 */
export const VISCA_DEADMAN_MS = 300;
export const VISCA_CHECK_MS = 50;
export const VISCA_KEEPALIVE_MS = 200;
export const VISCA_MIN_CHANGE_MS = 100;
export const VISCA_STOP_REPEAT_MS = 120;
/** Normalized velocity below which an axis is stopped rather than driven at the slowest step (~1/24 of full pan). */
export const VISCA_MIN_COMMAND = 0.05;

export interface ViscaCommand { pan: number; tilt: number; key: string }
/** Clamp to +/-cap, zero anything under the minimum command, and name the resulting discrete command. */
export function quantizeViscaVelocity(pan: number, tilt: number, cap = 1): ViscaCommand {
  const axis = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    const clamped = Math.max(-cap, Math.min(cap, value));
    return Math.abs(clamped) < VISCA_MIN_COMMAND ? 0 : clamped;
  };
  const p = axis(pan), t = axis(tilt);
  const key = `${p === 0 ? 0 : Math.sign(p) * toPanSpeed(p)}:${t === 0 ? 0 : Math.sign(t) * toTiltSpeed(t)}`;
  return { pan: p, tilt: t, key };
}

export interface ViscaDriverTimers {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (timer: unknown) => void;
}

export class ViscaTrackingDriver {
  private lastDriveAt = 0;
  private lastSentAt = 0;
  private lastKey = '0:0';
  private _moving = false;
  private timer: unknown;
  private repeatAt: number | null = null;

  constructor(
    private readonly device: MotionDevice,
    private readonly ledger: MotionLedger,
    private readonly timers: ViscaDriverTimers,
    private cap: number,
    private readonly onDeadman?: () => void,
  ) {}

  get moving(): boolean { return this._moving; }
  setCap(value: number): void { this.cap = value; }

  /** Feed a fresh velocity (-1..1 normalized). Returns true while the head is being moved. */
  drive(pan: number, tilt: number, now = this.timers.now()): boolean {
    const command = quantizeViscaVelocity(pan, tilt, this.cap);
    if (command.key === '0:0') {
      if (this._moving) this.stop();
      return false;
    }
    this.lastDriveAt = now;
    this.repeatAt = null;
    const changed = command.key !== this.lastKey;
    const due = !this._moving
      || (changed && now - this.lastSentAt >= VISCA_MIN_CHANGE_MS)
      || (!changed && now - this.lastSentAt >= VISCA_KEEPALIVE_MS);
    if (due) {
      this.device.setPanTilt(command.pan, command.tilt);
      this.ledger.note(this.device, now, command.pan, command.tilt);
      this.lastKey = command.key; this.lastSentAt = now;
    }
    this._moving = true;
    this.arm();
    return true;
  }

  /** Explicit stop, sent immediately (never rate-limited), then repeated once. */
  stop(): void {
    const now = this.timers.now();
    this.markStopped(now);
    try { this.sendStop(); } finally { this.ledger.note(this.device, now, 0, 0); }
  }

  /** The stop is being sent by someone else right now (emergency stop): only forget the motion and arm the repeat. */
  release(): void { this.markStopped(this.timers.now()); }

  /** Cancel timers without sending anything. */
  dispose(): void { this.disarm(); this._moving = false; this.repeatAt = null; }

  private markStopped(now: number): void {
    this._moving = false; this.lastKey = '0:0';
    this.repeatAt = now + VISCA_STOP_REPEAT_MS;
    this.arm();
  }
  private sendStop(): void { if (this.device.stopPanTilt) this.device.stopPanTilt(); else this.device.stop(); }
  private arm(): void {
    if (this.timer === undefined) this.timer = this.timers.setInterval(() => this.check(), VISCA_CHECK_MS);
  }
  private disarm(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
  /** Runs on its own timer. Must never throw: an exception on a timer would take the process down. */
  private check(): void {
    try {
      const now = this.timers.now();
      if (this._moving) {
        if (now - this.lastDriveAt > VISCA_DEADMAN_MS) {
          this.stop();
          try { this.onDeadman?.(); } catch { /* the stop already went out */ }
        }
        return;
      }
      if (this.repeatAt !== null && now >= this.repeatAt) {
        this.repeatAt = null;
        // Skip when an operator (or anything else) has moved the head since: a late stop would interrupt them.
        if (!this.ledger.isMoving(this.device)) this.sendStop();
      }
      if (this.repeatAt === null) this.disarm();
    } catch { /* a failed repeat must not stop the timer from being cleaned up */ this.repeatAt = null; this.disarm(); }
  }
}
