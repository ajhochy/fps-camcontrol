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
import { logger } from '../index';

const RT_THRESHOLD = 0.5;
const LT_THRESHOLD = 0.3;

export class ControlStateMachine {
  private edgeState: EdgeState = createEdgeState();
  private lastInput: NormalizedInput | null = null;
  private cameraSelector: CameraSelector;
  private presetManager: PresetManager;
  private speedManager: SpeedManager;

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

  updateInput(input: NormalizedInput): void {
    this.lastInput = input;
  }

  tick(): void {
    const input = this.lastInput;
    if (!input) return;

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

    const currentClient = this.viscaClients.get(this.state.controlledCamera);
    if (currentClient) {
      panTilt(currentClient, this.getEffectiveSpeed(rightX), this.getEffectiveSpeed(-rightY));
      zoom(currentClient, this.getEffectiveSpeed(-leftY));
    }

    // RT — cut live (rising edge on trigger crossing threshold)
    if (triggerRisingEdge('rightTrigger', input.triggers['rightTrigger'] ?? 0, RT_THRESHOLD, this.edgeState)) {
      cutControlledCameraLive(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'cut live error');
      });
    }

    // RB — auto transition
    if (risingEdge('RB', input.buttons['RB'] ?? false, this.edgeState)) {
      autoTransitionControlledCamera(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'auto transition error');
      });
    }

    // LB modifier — preset save
    const lbHeld = input.buttons['LB'] ?? false;

    // Preset recall / save — A/B/X/Y
    for (const slot of ['A', 'B', 'X', 'Y'] as PresetSlot[]) {
      const pressed = risingEdge(slot, input.buttons[slot] ?? false, this.edgeState);
      if (pressed) {
        if (lbHeld) {
          this.presetManager.savePreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset save error');
          });
        } else {
          this.presetManager.recallPreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset recall error');
          });
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
      toggleLowerThirds(this.atem, this.state, this.config).catch(err => {
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
