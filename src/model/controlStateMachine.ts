import { AppState, CameraId, PresetSlot } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { NormalizedInput } from '../input/normalizers';
import { EdgeState, createEdgeState, risingEdge } from '../input/edgeTriggers';
import { CameraSelector } from './cameraSelector';
import { PresetManager } from './presetManager';
import { SpeedManager } from './speedManager';
import { autoTransitionControlledCamera, toggleLowerThirds } from '../atem/switcherActions';
import { applyCurve, applyDeadzone, clamp } from '../visca/speedCurves';
import { emergencyStopAll } from '../safety/emergencyStop';
import { ActivityLog } from '../app/activityLog';
import { logger } from '../index';
import { trackingFor } from '../app/trackingHooks';

const TRIGGER_DEADZONE = 0.05;
const FACE_CAMERA_BUTTONS = ['X', 'A', 'B', 'Y'] as const;
const INPUT_STALE_MS = 250;
const PTZ_HEARTBEAT_MS = 250;
// A gimbal's motion commands leave the Pi as Bluetooth LE writes, and a BLE link
// sustains roughly 20-30 writes/sec. The 60Hz control loop used to send one per
// tick — gimbals skipped throttling entirely — which overran the radio's buffer
// and dropped the link after a few seconds of holding the stick. Observed as
// 46 link drops/hour on the weaker-signal gimbal and none while idle.
const GIMBAL_MIN_SEND_MS = 50;    // ceiling of ~20 commands/sec per gimbal
// Must stay clear of the bridge's 250ms safety watchdog: if commands stop
// arriving for that long the gimbal is auto-stopped, so too slow a heartbeat
// would make a held stick stutter to a halt.
const GIMBAL_HEARTBEAT_MS = 150;

/**
 * Whether a motion frame should go out on this tick.
 *
 * The control loop runs at 60Hz, but neither transport wants 60 commands/sec:
 * VISCA cameras queue them up (which made stops lag ~1.2s), and a gimbal's BLE
 * link drops outright once its buffer overruns. Both are therefore rate-limited;
 * gimbals additionally get a hard floor between sends because BLE is the tighter
 * pipe. A stop is never routed through here — a dropped stop is a camera that
 * keeps moving.
 *
 * Returns true for the first frame, then on a meaningful change, then on a
 * heartbeat so held motion keeps being refreshed.
 */
export function shouldSendMotion(
  protocol: string,
  changed: boolean,
  lastSentAt: number | undefined,
  now: number
): boolean {
  if (lastSentAt === undefined) return true;
  const since = now - lastSentAt;
  const isGimbal = protocol !== 'visca';
  // Hard rate cap: never exceed ~20 writes/sec on a BLE link, however fast the
  // stick is moving. 50ms of latency on a stick change is imperceptible.
  if (isGimbal && since < GIMBAL_MIN_SEND_MS) return false;
  return changed || since >= (isGimbal ? GIMBAL_HEARTBEAT_MS : PTZ_HEARTBEAT_MS);
}

const INPUT_LABELS: Record<string, string> = {
  rightStick: 'Right Stick',
  leftStickX: 'Left Stick X',
  rightTrigger: 'Right Trigger',
  RB: 'RB Button',
  A: 'A Button',
  B: 'B Button',
  X: 'X Button',
  Y: 'Y Button',
  dpadUp: 'D-pad Up',
  dpadDown: 'D-pad Down',
  back: 'Back Button',
};

interface LastSent {
  pan: number;
  tilt: number;
  ts: number;
}

export class ControlStateMachine {
  private edgeState: EdgeState = createEdgeState();
  private lastInput: NormalizedInput | null = null;
  private lastInputTs = 0;
  private cameraSelector: CameraSelector;
  private presetManager: PresetManager;
  private speedManager: SpeedManager;
  private wasMovingPT = false;
  private wasMovingZoom = false;
  private lastPanTilt = new Map<CameraId, LastSent>();
  private lastZoom = new Map<CameraId, { speed: number; ts: number }>();
  private activityLog: ActivityLog | null;
  // Who is driving, for the activity log ('iPad: Front'); null = the desk controller's profile name.
  private sourceLabel: string | null = null;
  // Is the source that is driving still there? Defaults to the HID controller; the input arbiter swaps in
  // one that also knows about a remote (iPad) owner.
  private sourceConnected: () => boolean = () => this.state.controllerConnected;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private atem: AtemClient,
    private devices: Map<CameraId, MotionDevice>,
    activityLog: ActivityLog | null = null
  ) {
    this.activityLog = activityLog;
    this.cameraSelector = new CameraSelector(state, config.cameras, atem, devices);
    this.presetManager = new PresetManager(state, config, devices);
    this.speedManager = new SpeedManager(state, config);
  }

  updateInput(input: NormalizedInput, sourceLabel?: string): void {
    this.lastInput = input;
    this.lastInputTs = Date.now();
    this.sourceLabel = sourceLabel ?? null;
  }

  setSourceConnected(fn: () => boolean): void {
    this.sourceConnected = fn;
  }

  /**
   * The input source changed (desk <-> iPad). Stop whatever is moving right now (a stop is never rate-limited),
   * forget the old source's last frame, and seed the edge state with the buttons the new source is already
   * holding so a held button can't fire a rising edge (select a camera, auto-transition) on the handover.
   */
  switchSource(seed: NormalizedInput | null): void {
    if (this.wasMovingPT || this.wasMovingZoom) {
      const device = this.devices.get(this.state.controlledCamera);
      if (device) {
        // Same shared motion ledger as every other manual stop when tracking is present (PR #58).
        const tracking = trackingFor(this.state);
        if (tracking) tracking.ledger.stop(device); else device.stop();
        device.setZoom(0);
      }
    }
    this.wasMovingPT = false;
    this.wasMovingZoom = false;
    this.lastPanTilt.clear();
    this.lastZoom.clear();
    this.lastInput = null;
    this.lastInputTs = 0;
    this.sourceLabel = null;
    this.edgeState.prevButtons = { ...(seed?.buttons ?? {}) };
  }

  tick(): void {
    const input = this.lastInput;
    if (!input) return;

    const currentDevice = this.devices.get(this.state.controlledCamera);
    if (!this.sourceConnected() || Date.now() - this.lastInputTs > INPUT_STALE_MS) {
      if (currentDevice && (this.wasMovingPT || this.wasMovingZoom)) {
        const tracking = trackingFor(this.state);
        if (tracking) tracking.ledger.stop(currentDevice); else currentDevice.stop();
        currentDevice.setZoom(0);
      }
      this.wasMovingPT = false;
      this.wasMovingZoom = false;
      this.lastPanTilt.clear();
      this.lastZoom.clear();
      return;
    }

    const controller = this.sourceLabel ?? this.state.activeControllerProfile ?? 'Unknown';
    this.state.precisionMode = input.buttons['LS'] ?? false;
    this.state.sprintMode = false;

    const leftX = applyDeadzone(input.axes['leftStickX'] ?? 0);
    const previousCamera = this.state.controlledCamera;
    this.cameraSelector.handleLeftStickX(leftX);
    if (this.state.controlledCamera !== previousCamera) {
      const label = this.config.cameras.find(c => c.id === this.state.controlledCamera)?.label ?? this.state.controlledCamera;
      this.activityLog?.setContext(controller, INPUT_LABELS.leftStickX, `Cam → ${label}`);
      this.activityLog?.addSystemEntry(`Cam → ${label}`, '—');
    }

    const device = this.devices.get(this.state.controlledCamera);
    const rightX = applyDeadzone(input.axes.rightStickX ?? 0);
    const rightY = applyDeadzone(input.axes.rightStickY ?? 0);
    const rightTrigger = input.triggers.rightTrigger ?? 0;
    const leftTrigger = input.triggers.leftTrigger ?? 0;
    const zoomAxis = (rightTrigger > TRIGGER_DEADZONE ? rightTrigger : 0)
      - (leftTrigger > TRIGGER_DEADZONE ? leftTrigger : 0);
    const movingPT = rightX !== 0 || rightY !== 0;
    const movingZoom = zoomAxis !== 0;

    if (device) {
      const cameraId = this.state.controlledCamera;
      const now = Date.now();

      if (movingPT && !this.wasMovingPT) {
        this.activityLog?.setContext(controller, INPUT_LABELS.rightStick, 'Pan/Tilt Start');
      } else if (!movingPT && this.wasMovingPT) {
        this.activityLog?.setContext(controller, INPUT_LABELS.rightStick, 'Pan/Tilt Stop');
        const tracking = trackingFor(this.state);
        const autonomous = tracking && Object.values(tracking.manager.getStatus()).some(source =>
          source.cameraId === cameraId && source.sessionId && source.state !== 'operator_override');
        if (!autonomous) { if (tracking) tracking.ledger.stop(device); else device.stop(); }
        this.lastPanTilt.delete(cameraId);
      }
      if (movingPT) {
        trackingFor(this.state)?.manager.operatorOverride(cameraId);
        const pan = this.getEffectiveSpeed(rightX);
        const tilt = this.getEffectiveSpeed(-rightY);
        const last = this.lastPanTilt.get(cameraId);
        const changed = !last || Math.abs(pan - last.pan) > 0.05 || Math.abs(tilt - last.tilt) > 0.05
          || Math.sign(pan) !== Math.sign(last.pan) || Math.sign(tilt) !== Math.sign(last.tilt);
        const tracking = trackingFor(this.state);
        if (tracking ? tracking.ledger.send(device, pan, tilt, now, changed) : shouldSendMotion(device.protocol, changed, last?.ts, now)) {
          if (!tracking) device.setPanTilt(pan, tilt);
          this.lastPanTilt.set(cameraId, { pan, tilt, ts: now });
        }
      }

      if (movingZoom && !this.wasMovingZoom) {
        this.activityLog?.setContext(controller, zoomAxis > 0 ? 'Right Trigger' : 'Left Trigger', zoomAxis > 0 ? 'Zoom In' : 'Zoom Out');
      } else if (!movingZoom && this.wasMovingZoom) {
        this.activityLog?.setContext(controller, 'Triggers', 'Zoom Stop');
        device.setZoom(0);
        this.lastZoom.delete(cameraId);
      }
      if (movingZoom) {
        const speed = this.getEffectiveSpeed(zoomAxis);
        const last = this.lastZoom.get(cameraId);
        const changed = !last || Math.abs(speed - last.speed) > 0.05 || Math.sign(speed) !== Math.sign(last.speed);
        if (shouldSendMotion(device.protocol, changed, last?.ts, now)) {
          device.setZoom(speed);
          this.lastZoom.set(cameraId, { speed, ts: now });
        }
      }
    }

    this.wasMovingPT = movingPT;
    this.wasMovingZoom = movingZoom;

    if (risingEdge('RB', input.buttons.RB ?? false, this.edgeState)) {
      const recenterDevice = this.devices.get(this.state.controlledCamera);
      if (input.buttons.LB && recenterDevice?.recenter) {
        trackingFor(this.state)?.manager.operatorOverride(this.state.controlledCamera);
        this.activityLog?.setContext(controller, 'LB + RB', 'Recenter');
        recenterDevice.recenter().catch(err => logger.error({ err }, 'recenter error'));
      } else {
        this.activityLog?.setContext(controller, INPUT_LABELS.RB, 'Auto Transition');
        autoTransitionControlledCamera(this.atem, this.state, this.config.cameras, this.devices)
          .catch(err => logger.error({ err }, 'auto transition error'));
      }
    }

    FACE_CAMERA_BUTTONS.forEach((button, index) => {
      if (!risingEdge(button, input.buttons[button] ?? false, this.edgeState)) return;
      if (input.buttons.LB) {
        const slot = button as PresetSlot;
        this.activityLog?.setContext(controller, `LB + ${slot}`, `Preset ${slot} Save`);
        this.presetManager.savePreset(this.state.controlledCamera, slot)
          .catch(err => logger.error({ err }, 'preset save error'));
        return;
      }
      if (index >= this.config.cameras.length) return;
      const before = this.state.controlledCamera;
      this.cameraSelector.selectByIndex(index);
      if (this.state.controlledCamera !== before) {
        const label = this.config.cameras[index].label;
        this.activityLog?.setContext(controller, INPUT_LABELS[button], `Cam → ${label}`);
        this.activityLog?.addSystemEntry(`Cam → ${label}`, '—');
      }
    });

    if (risingEdge('dpadUp', input.buttons.dpadUp ?? false, this.edgeState)) {
      this.speedManager.increment();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(controller, INPUT_LABELS.dpadUp, 'Speed Up');
      this.activityLog?.addSystemEntry('Speed Up', `Speed → ${name}`);
    }
    if (risingEdge('dpadDown', input.buttons.dpadDown ?? false, this.edgeState)) {
      this.speedManager.decrement();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(controller, INPUT_LABELS.dpadDown, 'Speed Down');
      this.activityLog?.addSystemEntry('Speed Down', `Speed → ${name}`);
    }

    const toggleKey = risingEdge('dpadLeft', input.buttons.dpadLeft ?? false, this.edgeState)
      || risingEdge('dpadRight', input.buttons.dpadRight ?? false, this.edgeState);
    if (toggleKey) {
      this.activityLog?.setContext(controller, 'D-pad Left/Right', `Lower Thirds ${this.state.lowerThirdsActive ? 'OFF' : 'ON'}`);
      toggleLowerThirds(this.atem, this.state, this.config)
        .catch(err => logger.error({ err }, 'lower thirds toggle error'));
    }

    const trackingToggle = this.config.mappings.trackingToggle ?? 'RS';
    if (risingEdge(trackingToggle, input.buttons[trackingToggle] ?? false, this.edgeState)) {
      const manager = trackingFor(this.state)?.manager;
      const session = manager && Object.values(manager.getStatus()).find(source => source.cameraId === this.state.controlledCamera && source.sessionId);
      if (manager && session) {
        this.activityLog?.setContext(controller, trackingToggle, 'Tracking');
        if (session.state === 'operator_override') {
          try { manager.resume(session.sourceId); this.activityLog?.addSystemEntry('Tracking resumed', 'Explicit controller action'); }
          catch { this.activityLog?.addSystemEntry('Tracking unavailable', 'Select a fresh target'); }
        } else { manager.cancel(session.sourceId); this.activityLog?.addSystemEntry('Tracking canceled', 'Gimbal stopped'); }
      }
    }

    if (risingEdge('back', input.buttons.back ?? false, this.edgeState)) {
      this.activityLog?.setContext(controller, INPUT_LABELS.back, 'Emergency Stop');
      this.activityLog?.addSystemEntry('Emergency Stop', 'All cameras stopped, PTZ halted');
      emergencyStopAll(this.state, this.config, this.atem, this.devices)
        .catch(err => logger.error({ err }, 'emergency stop error'));
    }
  }

  private getEffectiveSpeed(raw: number): number {
    const multiplier = this.config.speeds.presets[this.state.speedPreset].multiplier;
    const cameraScale = this.config.cameras.find(c => c.id === this.state.controlledCamera)?.speedScale ?? 1;
    let speed = applyCurve(raw) * multiplier * cameraScale;
    if (this.state.precisionMode) speed *= 0.25;
    return clamp(speed, -1, 1);
  }
}
