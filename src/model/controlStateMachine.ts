import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { NormalizedInput } from '../input/normalizers';
import { EdgeState, createEdgeState, risingEdge, triggerRisingEdge } from '../input/edgeTriggers';
import { CameraSelector } from './cameraSelector';
import { PresetManager } from './presetManager';
import { SpeedManager } from './speedManager';
import { cutControlledCameraLive, autoTransitionControlledCamera, toggleLowerThirds } from '../atem/switcherActions';
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

export class ControlStateMachine {
  private edgeState: EdgeState = createEdgeState();
  private lastInput: NormalizedInput | null = null;
  private cameraSelector: CameraSelector;
  private presetManager: PresetManager;
  private speedManager: SpeedManager;
  private wasMovingPT = false;
  private wasMovingZoom = false;
  private activityLog: ActivityLog | null;

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

  updateInput(input: NormalizedInput): void {
    this.lastInput = input;
  }

  tick(): void {
    const input = this.lastInput;
    if (!input) return;

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

    const currentDevice = this.devices.get(this.state.controlledCamera);
    if (currentDevice) {
      if (movingPT && !this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Start');
      }
      if (!movingPT && this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Stop');
        currentDevice.stop();
      }
      if (movingPT) {
        currentDevice.setPanTilt(this.getEffectiveSpeed(rightX), this.getEffectiveSpeed(-rightY));
      }

      if (movingZoom && !this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Start');
      }
      if (!movingZoom && this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Stop');
        currentDevice.setZoom(0);
      }
      if (movingZoom) {
        currentDevice.setZoom(this.getEffectiveSpeed(-leftY));
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

    // RB — auto transition, or LB+RB → recenter on gimbal devices
    if (risingEdge('RB', input.buttons['RB'] ?? false, this.edgeState)) {
      const lbHeldForRb = input.buttons['LB'] ?? false;
      const currentDeviceForRb = this.devices.get(this.state.controlledCamera);
      if (lbHeldForRb && currentDeviceForRb?.recenter) {
        this.activityLog?.setContext(device, 'LB + RB', 'Recenter');
        currentDeviceForRb.recenter().catch(err => {
          logger.error({ err }, 'recenter error');
        });
      } else {
        this.activityLog?.setContext(device, INPUT_LABELS['RB'], 'Auto Transition');
        autoTransitionControlledCamera(this.atem, this.state, this.config.cameras).catch(err => {
          logger.error({ err }, 'auto transition error');
        });
      }
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
      emergencyStopAll(this.state, this.config, this.atem, this.devices).catch(err => {
        logger.error({ err }, 'emergency stop error');
      });
    }
  }

  private getEffectiveSpeed(raw: number): number {
    const activeMultiplier = this.config.speeds.presets[this.state.speedPreset].multiplier;
    let speed = applyCurve(raw) * activeMultiplier;
    if (this.state.precisionMode) speed *= 0.25;
    if (this.state.sprintMode) speed *= 1.75;
    return clamp(speed, -1, 1);
  }
}
