import type { MotionDevice } from '../devices/motionDevice';
import { shouldSendMotion } from '../model/controlStateMachine';
/** One ledger shared by manual and tracking paths, keyed by physical object. */
export class MotionLedger {
  private sent = new WeakMap<MotionDevice, { at: number; pan: number; tilt: number }>();
  send(device: MotionDevice, pan: number, tilt: number, now = Date.now(), changed?: boolean): boolean {
    if (![pan, tilt, now].every(Number.isFinite)) return false;
    const previous = this.sent.get(device);
    changed ??= !previous || Math.abs(pan - previous.pan) > .001 || Math.abs(tilt - previous.tilt) > .001;
    if (!shouldSendMotion(device.protocol, changed, previous?.at, now)) return false;
    device.setPanTilt(pan, tilt); this.note(device, now, pan, tilt); return true;
  }
  request(device: MotionDevice, pan: number, tilt: number, now = Date.now(), changed?: boolean): boolean { return this.send(device, pan, tilt, now, changed); }
  note(device: MotionDevice, now: number, pan = 0, tilt = 0): void { this.sent.set(device, { at: now, pan, tilt }); }
  isMoving(device: MotionDevice): boolean { const sent = this.sent.get(device); return !!sent && (sent.pan !== 0 || sent.tilt !== 0); }
  stop(device: MotionDevice): void {
    device.stop();
    const previous = this.sent.get(device);
    if (previous) this.sent.set(device, { ...previous, pan: 0, tilt: 0 });
  }
}
