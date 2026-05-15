import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { NormalizedInput } from '../input/normalizers';
import { EdgeState, createEdgeState, risingEdge, triggerRisingEdge } from '../input/edgeTriggers';
import { CameraSelector } from './cameraSelector';
import { PresetManager } from './presetManager';
import { SpeedManager } from './speedManager';
import { cutControlledCameraLive, autoTransitionControlledCamera } from '../atem/switcherActions';
import { panTilt, zoom } from '../visca/ptzActions';
import { applyCurve, applyDeadzone, clamp } from '../visca/speedCurves';
import { emergencyStopAll } from '../safety/emergencyStop';
import { GamepadDevice } from '../input/gamepad';
import { logger } from '../index';

const RT_THRESHOLD = 0.5;
const LT_THRESHOLD = 0.3;
const PTZ_DEADZONE = 0.02;
// 2 seconds at 60Hz: number of ticks LB+slot must be held before save fires
const PRESET_SAVE_HOLD_FRAMES = 120;

interface PresetSaveState {
  slot: PresetSlot;
  framesHeld: number;
}

export class ControlStateMachine {
  private edgeState: EdgeState = createEdgeState();
  private lastInput: NormalizedInput | null = null;
  private cameraSelector: CameraSelector;
  private presetManager: PresetManager;
  private speedManager: SpeedManager;

  // PTZ idle frame counter — resets to 0 when sticks are outside deadzone
  private ptzIdleFrames = 0;
  // True if any PTZ axis was active last tick (for one-shot stop command on return to idle)
  private wasMoving = false;
  // Tracks an in-progress LB+slot hold for preset save
  private presetSaveState: PresetSaveState | null = null;

  private gamepad?: GamepadDevice;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private atem: AtemClient,
    private viscaClients: Map<CameraId, ViscaClient>
  ) {
    this.cameraSelector = new CameraSelector(state, config.cameras, atem, viscaClients);
    this.presetManager = new PresetManager(state, config, viscaClients);
    this.speedManager = new SpeedManager(state, config);
  }

  setGamepad(gamepad: GamepadDevice): void {
    this.gamepad = gamepad;
  }

  updateInput(input: NormalizedInput): void {
    this.lastInput = input;
  }

  tick(): void {
    const input = this.lastInput;
    // Skip tick entirely when controller is not connected — prevents replaying stale input
    if (!input || !this.state.controllerConnected) return;

    // Update modal states
    this.state.precisionMode = (input.triggers['leftTrigger'] ?? 0) >= LT_THRESHOLD;
    this.state.sprintMode = input.buttons['LS'] ?? false;

    // Camera selector — left stick X flick
    const leftX = applyDeadzone(input.axes['leftStickX'] ?? 0);
    this.cameraSelector.handleLeftStickX(leftX);

    // PTZ — right stick + left stick Y
    const rightX = applyDeadzone(input.axes['rightStickX'] ?? 0);
    const rightY = applyDeadzone(input.axes['rightStickY'] ?? 0);
    const leftY = applyDeadzone(input.axes['leftStickY'] ?? 0);

    const isMoving =
      Math.abs(rightX) >= PTZ_DEADZONE ||
      Math.abs(rightY) >= PTZ_DEADZONE ||
      Math.abs(leftY) >= PTZ_DEADZONE;

    if (isMoving) {
      this.ptzIdleFrames = 0;
    } else {
      this.ptzIdleFrames++;
    }

    const currentClient = this.viscaClients.get(this.state.controlledCamera);
    // Only send PTZ commands when movement starts, is ongoing, or just stopped (one stop command)
    if (currentClient && (isMoving || this.wasMoving)) {
      const cam = this.config.cameras.find(c => c.id === this.state.controlledCamera);
      const camType = cam?.cameraType ?? 'generic';
      panTilt(currentClient, this.getEffectiveSpeed(rightX), this.getEffectiveSpeed(-rightY), camType);
      zoom(currentClient, this.getEffectiveSpeed(-leftY));
    }
    this.wasMoving = isMoving;

    // RT — cut live (rising edge on trigger crossing threshold)
    if (triggerRisingEdge('rightTrigger', input.triggers['rightTrigger'] ?? 0, RT_THRESHOLD, this.edgeState)) {
      if (this.ptzIdleFrames < 5) {
        logger.warn({ ptzIdleFrames: this.ptzIdleFrames }, 'cut fired while PTZ may still be moving');
      }
      cutControlledCameraLive(this.atem, this.state, this.config.cameras, this.config.atem.meIndex, this.gamepad).catch(err => {
        logger.error({ err }, 'cut live error');
      });
    }

    // RB — auto transition
    if (risingEdge('RB', input.buttons['RB'] ?? false, this.edgeState)) {
      if (this.ptzIdleFrames < 5) {
        logger.warn({ ptzIdleFrames: this.ptzIdleFrames }, 'auto-transition fired while PTZ may still be moving');
      }
      autoTransitionControlledCamera(this.atem, this.state, this.config.cameras, this.config.atem.meIndex, this.gamepad).catch(err => {
        logger.error({ err }, 'auto transition error');
      });
    }

    // LB modifier — used for preset save combo
    const lbHeld = input.buttons['LB'] ?? false;

    // Preset recall / save — A/B/X/Y
    // Save requires holding LB+slot for 2 seconds; recall is an immediate rising edge (no LB)
    for (const slot of ['A', 'B', 'X', 'Y'] as PresetSlot[]) {
      const slotHeld = input.buttons[slot] ?? false;
      const comboHeld = lbHeld && slotHeld;

      if (comboHeld) {
        if (this.presetSaveState?.slot === slot) {
          this.presetSaveState.framesHeld++;
          this.state.presetSaveProgress = {
            cameraId: this.state.controlledCamera,
            slot,
            framesHeld: this.presetSaveState.framesHeld,
          };
          if (this.presetSaveState.framesHeld >= PRESET_SAVE_HOLD_FRAMES) {
            this.presetSaveState = null;
            this.state.presetSaveProgress = null;
            this.presetManager.savePreset(this.state.controlledCamera, slot).catch(err => {
              logger.error({ err }, 'preset save error');
              this.state.lastPresetNotification = 'Save failed — could not read camera position';
            });
          }
        } else {
          this.presetSaveState = { slot, framesHeld: 1 };
          this.state.presetSaveProgress = {
            cameraId: this.state.controlledCamera,
            slot,
            framesHeld: 1,
          };
        }
      } else {
        if (this.presetSaveState?.slot === slot) {
          // Released early — cancel
          this.presetSaveState = null;
          this.state.presetSaveProgress = null;
        }
        // Recall on rising edge when LB is not held
        if (!lbHeld) {
          const pressed = risingEdge(slot, slotHeld, this.edgeState);
          if (pressed) {
            this.presetManager.recallPreset(this.state.controlledCamera, slot).catch(err => {
              logger.error({ err }, 'preset recall error');
            });
          }
        }
      }
    }

    // Speed presets — D-pad up/down
    if (risingEdge('dpadUp', input.buttons['dpadUp'] ?? false, this.edgeState)) {
      this.speedManager.increment();
    }
    if (risingEdge('dpadDown', input.buttons['dpadDown'] ?? false, this.edgeState)) {
      this.speedManager.decrement();
    }

    // Lower thirds — D-pad left or right
    const ltToggle =
      risingEdge('dpadLeft', input.buttons['dpadLeft'] ?? false, this.edgeState) ||
      risingEdge('dpadRight', input.buttons['dpadRight'] ?? false, this.edgeState);
    if (ltToggle) {
      const newState = !this.state.lowerThirdsActive;
      this.state.lowerThirdsActive = newState;
      this.atem.setDownstreamKeyOnAir(this.config.lowerThirds.dskIndex, newState).catch(err => {
        logger.error({ err }, 'lower thirds toggle error');
      });
    }

    // Emergency stop — back button
    if (risingEdge('back', input.buttons['back'] ?? false, this.edgeState)) {
      emergencyStopAll(this.state, this.config, this.atem, this.viscaClients).catch(err => {
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
