import { EventEmitter } from 'events';
import HID from 'node-hid';
import { logger } from '../index';
import { throttledLog } from '../app/logThrottle';
import { GamepadDevice } from './gamepad';
import { ControllerProfile, findConnectedController } from './profileDetector';

// Detection used to run exactly once, at startup. A controller that woke up or
// paired *after* the app booted was never picked up — no GamepadDevice existed,
// so GamepadDevice's own reconnect timer had nothing to retry, and the home
// screen stayed "Not Connected" while the OS (and the Controller tab, which
// only enumerates HID) happily reported the pad as present.
//
// The supervisor closes that gap: it re-runs profile detection on an interval
// whenever no controller is attached, and drops the attached one once it stops
// enumerating so a different pad can take over.

const DEFAULT_POLL_MS = 2000;

// A Bluetooth pad can briefly vanish from HID.devices() between polls; require
// two consecutive misses before tearing down a working GamepadDevice.
const MISSED_POLLS_BEFORE_DETACH = 2;

export interface DetectedController {
  device: HID.Device;
  profile: ControllerProfile;
  connectionType: 'usb' | 'bluetooth';
}

// The subset of GamepadDevice the supervisor drives, so the smoke suite can
// substitute a virtual pad without real HID.
export interface OpenFailure {
  kind: 'openDenied' | 'noData';
  err: unknown;
}

export interface SupervisedGamepad {
  on(event: 'connected' | 'disconnected', listener: () => void): this;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'openFailed', listener: (failure: OpenFailure) => void): this;
  open(): void;
  close(): void;
}

// A pad can be enumerated by the OS yet refuse to hand over data. Silently
// retrying looks identical to "no controller", so translate the failure into
// something the operator can act on.
export function explainOpenFailure(
  failure: OpenFailure,
  connectionType: 'usb' | 'bluetooth'
): string {
  if (failure.kind === 'noData') {
    return 'Controller is open but has not sent any input yet. Move a stick — many pads send nothing while idle. If it stays like this, grant Input Monitoring to this app in System Settings ▸ Privacy & Security.';
  }
  const shared = 'Another app may already have the controller open exclusively (Bitfocus Companion and similar surface tools do this), or Input Monitoring is denied in System Settings ▸ Privacy & Security.';
  if (connectionType === 'bluetooth') {
    return `Could not open the Bluetooth controller. ${shared} Connecting it with a USB cable also bypasses most Bluetooth HID contention.`;
  }
  return `Could not open the controller. ${shared}`;
}

export interface SupervisorDeps {
  detect: (profiles: ControllerProfile[]) => DetectedController | null;
  enumerate: () => HID.Device[];
  createGamepad: (vendorId: number, productId: number, path?: string) => SupervisedGamepad;
}

const realDeps: SupervisorDeps = {
  detect: findConnectedController,
  enumerate: () => HID.devices(),
  createGamepad: (vendorId, productId, path) => new GamepadDevice(vendorId, productId, path),
};

interface Attached {
  gamepad: SupervisedGamepad;
  profile: ControllerProfile;
  connectionType: 'usb' | 'bluetooth';
  vendorId: number;
  productId: number;
}

export class ControllerSupervisor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private attached: Attached | null = null;
  private missedPolls = 0;
  private deps: SupervisorDeps;
  // Human-readable reason the attached pad is not delivering input, if any.
  statusDetail: string | null = null;

  constructor(
    private profiles: ControllerProfile[],
    private pollMs: number = DEFAULT_POLL_MS,
    deps: Partial<SupervisorDeps> = {}
  ) {
    super();
    this.deps = { ...realDeps, ...deps };
  }

  // Runs one detection pass immediately, then keeps watching.
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.attached) {
      this.attached.gamepad.close();
      this.attached = null;
    }
  }

  isAttached(): boolean {
    return this.attached !== null;
  }

  get activeProfile(): ControllerProfile | null {
    return this.attached?.profile ?? null;
  }

  // Exposed for tests; production drives this from the interval.
  poll(): void {
    if (this.attached) {
      this.checkStillEnumerated();
      return;
    }

    const found = this.deps.detect(this.profiles);
    if (!found) return;

    logger.info(
      { profile: found.profile.name, connectionType: found.connectionType },
      'controller detected, attaching'
    );

    const gamepad = this.deps.createGamepad(
      found.device.vendorId,
      found.device.productId,
      found.device.path
    );
    gamepad.on('connected', () => {
      this.statusDetail = null;
      this.emit('connected');
    });
    gamepad.on('disconnected', () => this.emit('disconnected'));
    gamepad.on('data', (data: Buffer) => this.emit('data', data));
    gamepad.on('openFailed', (failure: OpenFailure) => {
      this.statusDetail = explainOpenFailure(failure, found.connectionType);
      this.emit('statusDetail', this.statusDetail);
    });

    this.attached = {
      gamepad,
      profile: found.profile,
      connectionType: found.connectionType,
      vendorId: found.device.vendorId,
      productId: found.device.productId,
    };
    this.missedPolls = 0;

    this.emit('attached', { profile: found.profile, connectionType: found.connectionType });
    gamepad.open();
  }

  private checkStillEnumerated(): void {
    const a = this.attached;
    if (!a) return;

    let present: boolean;
    try {
      present = this.deps
        .enumerate()
        .some(d => d.vendorId === a.vendorId && d.productId === a.productId);
    } catch (err) {
      // Enumeration itself failed; don't tear down a possibly-working device.
      throttledLog.warn(
        'supervisor-enumerate-fail', 30000, { err },
        'HID enumeration failed during controller poll'
      );
      return;
    }

    if (present) {
      this.missedPolls = 0;
      return;
    }

    this.missedPolls++;
    if (this.missedPolls < MISSED_POLLS_BEFORE_DETACH) return;

    logger.warn(
      { profile: a.profile.name, vendorId: a.vendorId, productId: a.productId },
      'controller no longer enumerated, detaching'
    );
    a.gamepad.close();
    this.attached = null;
    this.missedPolls = 0;
    this.statusDetail = null;
    this.emit('detached');
  }
}
