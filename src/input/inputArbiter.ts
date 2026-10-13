import { NormalizedInput } from './normalizers';

/**
 * Who is driving: the controller at the desk ('local') or an iPad ('remote').
 *
 * Rules (docs/ai/decisions.md, "desk always wins"):
 * - Local owns by default, and takes over from a remote the moment the desk controller is touched. The desk
 *   operator sees program video directly and is the safety fallback, so a stray iPad nudge must never steal
 *   a shot (and last-active-wins would let it).
 * - A remote must claim explicitly, and only when remote control is enabled, no other remote owns, and the
 *   desk controller has been idle for CLAIM_QUIET_MS.
 * - Every owner change goes through machine.switchSource(): the camera is stopped immediately and the edge
 *   state is seeded with whatever the new source is already holding, so a held button never fires.
 * - A remote that goes silent for DEAD_MAN_MS loses ownership. (The machine has already stopped the camera
 *   after 250 ms without input; this releases the seat.)
 *
 * Pure: the clock is injectable and the machine is an interface, so every path is unit-tested.
 */
export type InputOwner = 'local' | 'remote';
export type ClaimDenial = 'disabled' | 'desk-active' | 'other-remote';
export type OwnerChangeReason =
  | 'claim' | 'release' | 'desk-override' | 'idle' | 'disconnect' | 'timeout' | 'disabled' | 'stop' | 'taken-back';

export interface ArbiterMachine {
  updateInput(input: NormalizedInput, sourceLabel?: string): void;
  switchSource(seed: NormalizedInput | null): void;
}

export interface OwnerChange {
  owner: InputOwner;
  ownerId: string | null;
  ownerName: string | null;
  reason: OwnerChangeReason;
  /** The session that held the seat before this change (so it can be told it lost it). */
  previousId: string | null;
}

export const CLAIM_QUIET_MS = 1500;
export const DEAD_MAN_MS = 1000;
// "Active" desk input: more than a nudge, so resting-stick noise or a bump doesn't count.
const ACTIVE_AXIS = 0.3;
const ACTIVE_TRIGGER = 0.15;

/** Is the controller being used (any button down, a stick pushed, a trigger pulled)? */
export function isActiveInput(input: NormalizedInput): boolean {
  if (Object.values(input.buttons).some(Boolean)) return true;
  if (Object.values(input.axes).some((v) => Math.abs(v) > ACTIVE_AXIS)) return true;
  return Object.values(input.triggers).some((v) => v > ACTIVE_TRIGGER);
}

export class InputArbiter {
  private _owner: InputOwner = 'local';
  private _ownerId: string | null = null;
  private _ownerName: string | null = null;
  private _enabled = false;
  private lastLocalActiveAt = -Infinity;
  private lastRemoteFrameAt = 0;
  private listener: ((e: OwnerChange) => void) | null = null;

  constructor(
    private machine: ArbiterMachine,
    private now: () => number = Date.now,
    private claimQuietMs = CLAIM_QUIET_MS,
    private deadManMs = DEAD_MAN_MS,
  ) {}

  get owner(): InputOwner { return this._owner; }
  get ownerId(): string | null { return this._ownerId; }
  get ownerName(): string | null { return this._ownerName; }
  get enabled(): boolean { return this._enabled; }
  /** Milliseconds since the owning remote last sent a frame; null when no remote owns. */
  get lastRemoteFrameAgoMs(): number | null { return this._owner === 'remote' ? this.now() - this.lastRemoteFrameAt : null; }

  onOwnerChange(fn: (e: OwnerChange) => void): void { this.listener = fn; }

  /**
   * The machine's "is the source that is driving still there?" check. A remote owner exists only while its
   * socket does (the hub revokes on close), so for it this is true; for the desk it is the HID link.
   */
  sourceConnected(localConnected: boolean): boolean {
    return this._owner === 'remote' ? true : localConnected;
  }

  /** A frame from the desk controller. Always noted; forwarded to the machine only while local owns. */
  fromLocal(input: NormalizedInput, sourceLabel?: string): void {
    const active = isActiveInput(input);
    if (active) this.lastLocalActiveAt = this.now();
    if (this._owner === 'remote') {
      if (!active) return; // a quiet desk pad doesn't interrupt the iPad
      this.change('local', null, null, 'desk-override', input);
    }
    this.machine.updateInput(input, sourceLabel);
  }

  /** A validated frame from a remote session. Applied only if that session owns. Returns whether it was. */
  fromRemote(sessionId: string, input: NormalizedInput, sourceLabel?: string): boolean {
    if (this._owner !== 'remote' || this._ownerId !== sessionId) return false;
    this.lastRemoteFrameAt = this.now();
    this.machine.updateInput(input, sourceLabel);
    return true;
  }

  /** A remote asks for the seat. `seed` is what its pad is holding right now (so held buttons don't fire). */
  claim(sessionId: string, name: string, seed: NormalizedInput | null): { ok: true } | { ok: false; reason: ClaimDenial } {
    if (!this._enabled) return { ok: false, reason: 'disabled' };
    if (this._owner === 'remote' && this._ownerId !== sessionId) return { ok: false, reason: 'other-remote' };
    if (this._owner === 'remote') return { ok: true }; // already the owner
    if (this.now() - this.lastLocalActiveAt < this.claimQuietMs) return { ok: false, reason: 'desk-active' };
    this.lastRemoteFrameAt = this.now();
    this.change('remote', sessionId, name, 'claim', seed);
    return { ok: true };
  }

  /** The owning remote hands the seat back (button, idle, hidden page, socket closed). Ignored from anyone else. */
  release(sessionId: string, reason: OwnerChangeReason = 'release'): boolean {
    if (this._owner !== 'remote' || this._ownerId !== sessionId) return false;
    this.change('local', null, null, reason, null);
    return true;
  }

  /** The desk (or STOP, or a disable) takes the seat back regardless of who holds it. */
  revoke(reason: OwnerChangeReason): boolean {
    if (this._owner !== 'remote') return false;
    this.change('local', null, null, reason, null);
    return true;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this.revoke('disabled');
  }

  /** Dead-man check; run it on a short timer (the hub does, every 100 ms). */
  tick(): void {
    if (this._owner === 'remote' && this.now() - this.lastRemoteFrameAt > this.deadManMs) this.revoke('timeout');
  }

  private change(owner: InputOwner, ownerId: string | null, ownerName: string | null, reason: OwnerChangeReason, seed: NormalizedInput | null): void {
    const previousId = this._ownerId;
    this._owner = owner;
    this._ownerId = ownerId;
    this._ownerName = ownerName;
    // Stop first, seed the edge state, then tell the world: nothing may be left moving across the handover.
    this.machine.switchSource(seed);
    this.listener?.({ owner, ownerId, ownerName, reason, previousId });
  }
}
