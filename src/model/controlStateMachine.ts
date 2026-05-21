import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { NormalizedInput } from '../input/normalizers';
import { EdgeState, createEdgeState, risingEdge, triggerRisingEdge } from '../input/edgeTriggers';
import { CameraSelector } from './cameraSelector';
import { PresetManager } from './presetManager';
import { SpeedManager } from './speedManager';
import { cutControlledCameraLive, autoTransitionControlledCamera, toggleLowerThirds } from '../atem/switcherActions';
import { panTilt, zoom, stopPTZ } from '../visca/ptzActions';
import { applyCurve, applyDeadzone, clamp } from '../visca/speedCurves';
import { emergencyStopAll } from '../safety/emergencyStop';
import { ActivityLog } from '../app/activityLog';
import { logger } from '../index';

const RT_THRESHOLD = 0.5;
const LT_THRESHOLD = 0.3;

const INPUT_LABELS: Record<string, string> = {
  rightStick: 'Right Stick',
  leftStickY: 'Left Stick Y',
  leftStickX: 'Left Stick X',
  rightTrigger: 'Right Trigger',
  RB: 'RB Button',
  A: 'A Button',
  B: 'B Button',
  X: 'X Button',
  Y: 'Y Button',
  dpadUp: 'D-pad Up',
  dpadDown: 'D-pad Down',
  dpadLeft: 'D-pad Left',
  dpadRight: 'D-pad Right',
  back: 'Back Button',
};

const INPUT_STALE_MS = 250;
// PTZ throttling: VISCA cameras process commands sequentially. Sending fresh
// pan/tilt frames every 16ms (60Hz) overflows the camera's input queue and
// causes the eventual stop to wait behind ~60 queued moves — felt as ~1s
// release latency. We send a new frame only when the encoded speed/direction
// bytes change, with a heartbeat every PTZ_HEARTBEAT_MS to keep the camera
// moving (some firmwares auto-stop after ~500ms of silence).
const PTZ_HEARTBEAT_MS = 250;

interface LastSent {
  pan: number; tilt: number; ts: number;
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
  private lastPanTilt: Map<CameraId, LastSent> = new Map();
  private lastZoom: Map<CameraId, { speed: number; ts: number }> = new Map();
  private activityLog: ActivityLog | null;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private atem: AtemClient,
    private viscaClients: Map<CameraId, ViscaClient>,
    activityLog: ActivityLog | null = null
  ) {
    this.activityLog = activityLog;
    this.cameraSelector = new CameraSelector(state, config.cameras, atem, viscaClients);
    this.presetManager = new PresetManager(state, config, viscaClients);
    this.speedManager = new SpeedManager(state, config);
  }

  updateInput(input: NormalizedInput): void {
    this.lastInput = input;
    this.lastInputTs = Date.now();
  }

  tick(): void {
    const input = this.lastInput;
    if (!input) return;

    // Safety: if controller isn't reporting fresh data, force-stop any in-flight PTZ
    // motion and skip the rest of the tick. Prevents stale axis values from being
    // re-sent at 60Hz when the HID device closes or hangs.
    const stale = !this.state.controllerConnected || Date.now() - this.lastInputTs > INPUT_STALE_MS;
    if (stale) {
      if (this.wasMovingPT || this.wasMovingZoom) {
        const currentClient = this.viscaClients.get(this.state.controlledCamera);
        if (currentClient) {
          stopPTZ(currentClient);
          zoom(currentClient, 0);
        }
        this.wasMovingPT = false;
        this.wasMovingZoom = false;
      }
      return;
    }

    const device = this.state.activeControllerProfile ?? 'Unknown';

    this.state.precisionMode = (input.triggers['leftTrigger'] ?? 0) >= LT_THRESHOLD;
    this.state.sprintMode = input.buttons['LS'] ?? false;

    // Camera selector — left stick X flick
    const leftX = applyDeadzone(input.axes['leftStickX'] ?? 0);
    const prevCamera = this.state.controlledCamera;
    this.cameraSelector.handleLeftStickX(leftX);
    if (this.state.controlledCamera !== prevCamera) {
      const camLabel = this.config.cameras.find(c => c.id === this.state.controlledCamera)?.label ?? this.state.controlledCamera;
      this.activityLog?.setContext(device, INPUT_LABELS['leftStickX'], `Cam → ${camLabel}`);
      this.activityLog?.addSystemEntry(`Cam → ${camLabel}`, '—');
    }

    // PTZ — right stick + left stick Y
    const rightX = applyDeadzone(input.axes['rightStickX'] ?? 0);
    const rightY = applyDeadzone(input.axes['rightStickY'] ?? 0);
    const leftY = applyDeadzone(input.axes['leftStickY'] ?? 0);
    const movingPT = rightX !== 0 || rightY !== 0;
    const movingZoom = leftY !== 0;

    const currentClient = this.viscaClients.get(this.state.controlledCamera);
    if (currentClient) {
      const camId = this.state.controlledCamera;
      const now = Date.now();

      if (movingPT && !this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Start');
      }
      if (!movingPT && this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Stop');
        stopPTZ(currentClient);
        this.lastPanTilt.delete(camId);
      }
      if (movingPT) {
        // Throttle: only resend panTilt when the *normalized* speed/direction
        // delta crosses a meaningful threshold or the heartbeat interval expired.
        const newPan = this.getEffectiveSpeed(rightX);
        const newTilt = this.getEffectiveSpeed(-rightY);
        const last = this.lastPanTilt.get(camId);
        const changed = !last
          || Math.abs(newPan - last.pan) > 0.05
          || Math.abs(newTilt - last.tilt) > 0.05
          || Math.sign(newPan) !== Math.sign(last.pan)
          || Math.sign(newTilt) !== Math.sign(last.tilt);
        const stale = last && now - last.ts >= PTZ_HEARTBEAT_MS;
        if (changed || stale) {
          panTilt(currentClient, newPan, newTilt);
          this.lastPanTilt.set(camId, { pan: newPan, tilt: newTilt, ts: now });
        }
      }

      if (movingZoom && !this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Start');
      }
      if (!movingZoom && this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Stop');
        zoom(currentClient, 0);
        this.lastZoom.delete(camId);
      }
      if (movingZoom) {
        const newZoom = this.getEffectiveSpeed(-leftY);
        const last = this.lastZoom.get(camId);
        const changed = !last
          || Math.abs(newZoom - last.speed) > 0.05
          || Math.sign(newZoom) !== Math.sign(last.speed);
        const stale = last && now - last.ts >= PTZ_HEARTBEAT_MS;
        if (changed || stale) {
          zoom(currentClient, newZoom);
          this.lastZoom.set(camId, { speed: newZoom, ts: now });
        }
      }
    }

    this.wasMovingPT = movingPT;
    this.wasMovingZoom = movingZoom;

    // RT — cut live (rising edge on trigger crossing threshold)
    if (triggerRisingEdge('rightTrigger', input.triggers['rightTrigger'] ?? 0, RT_THRESHOLD, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['rightTrigger'], 'Cut Live');
      cutControlledCameraLive(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'cut live error');
      });
    }

    // RB — auto transition
    if (risingEdge('RB', input.buttons['RB'] ?? false, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['RB'], 'Auto Transition');
      autoTransitionControlledCamera(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'auto transition error');
      });
    }

    // LB modifier — preset save/recall
    const lbHeld = input.buttons['LB'] ?? false;
    for (const slot of ['A', 'B', 'X', 'Y'] as PresetSlot[]) {
      const pressed = risingEdge(slot, input.buttons[slot] ?? false, this.edgeState);
      if (pressed) {
        if (lbHeld) {
          this.activityLog?.setContext(device, `LB + ${slot}`, `Preset ${slot} Save`);
          this.presetManager.savePreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset save error');
          });
        } else {
          this.activityLog?.setContext(device, `${slot} ${INPUT_LABELS[slot]}`, `Preset ${slot} Recall`);
          this.presetManager.recallPreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset recall error');
          });
        }
      }
    }

    // Speed presets — D-pad up/down
    if (risingEdge('dpadUp', input.buttons['dpadUp'] ?? false, this.edgeState)) {
      this.speedManager.increment();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(device, INPUT_LABELS['dpadUp'], 'Speed Up');
      this.activityLog?.addSystemEntry('Speed Up', `Speed → ${name}`);
    }
    if (risingEdge('dpadDown', input.buttons['dpadDown'] ?? false, this.edgeState)) {
      this.speedManager.decrement();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(device, INPUT_LABELS['dpadDown'], 'Speed Down');
      this.activityLog?.addSystemEntry('Speed Down', `Speed → ${name}`);
    }

    // Lower thirds — D-pad left or right
    const ltToggle =
      risingEdge('dpadLeft', input.buttons['dpadLeft'] ?? false, this.edgeState) ||
      risingEdge('dpadRight', input.buttons['dpadRight'] ?? false, this.edgeState);
    if (ltToggle) {
      const newState = !this.state.lowerThirdsActive;
      this.activityLog?.setContext(device, 'D-pad Left/Right', `Lower Thirds ${newState ? 'ON' : 'OFF'}`);
      toggleLowerThirds(this.atem, this.state, this.config).catch(err => {
        logger.error({ err }, 'lower thirds toggle error');
      });
    }

    // Emergency stop — back button
    if (risingEdge('back', input.buttons['back'] ?? false, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['back'], 'Emergency Stop');
      this.activityLog?.addSystemEntry('Emergency Stop', 'All cameras stopped, PTZ halted');
      emergencyStopAll(this.state, this.config, this.atem, this.viscaClients).catch(err => {
        logger.error({ err }, 'emergency stop error');
      });
    }
  }

  private getEffectiveSpeed(raw: number): number {
    const activeMultiplier = this.config.speeds.presets[this.state.speedPreset].multiplier;
    const cam = this.config.cameras.find(c => c.id === this.state.controlledCamera);
    const camScale = cam?.speedScale ?? 1.0;
    let speed = applyCurve(raw) * activeMultiplier * camScale;
    if (this.state.precisionMode) speed *= 0.25;
    if (this.state.sprintMode) speed *= 1.75;
    return clamp(speed, -1, 1);
  }
}
