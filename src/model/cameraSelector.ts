import { AppState, CameraId } from '../app/state';
import { CameraConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { MotionDevice } from '../devices/motionDevice';
import { logger } from '../index';
import { trackingFor } from '../app/trackingHooks';

const FLICK_THRESHOLD = 0.75;
const FLICK_NEUTRAL = 0.25;

export class CameraSelector {
  private stickReadyForSelection = true;

  constructor(
    private state: AppState,
    private cameras: CameraConfig[],
    private atem: AtemClient,
    private devices: Map<CameraId, MotionDevice>
  ) {}

  handleLeftStickX(x: number): void {
    if (!this.stickReadyForSelection) {
      if (Math.abs(x) < FLICK_NEUTRAL) this.stickReadyForSelection = true;
      return;
    }
    if (x > FLICK_THRESHOLD) {
      this.selectCamera(this.state.cameraIndex + 1);
      this.stickReadyForSelection = false;
    } else if (x < -FLICK_THRESHOLD) {
      this.selectCamera(this.state.cameraIndex - 1);
      this.stickReadyForSelection = false;
    }
  }

  /**
   * Directly arm a camera as standby by its index in the configured camera
   * list. Used by the face-button hotkeys (A/B/X/Y). Shares all the same
   * side effects as a left-stick flick: stops the outgoing camera's PTZ,
   * updates controlled/preview state, and moves the ATEM preview bus.
   */
  selectByIndex(index: number): void {
    this.selectCamera(index);
    this.stickReadyForSelection = true;
  }

  private selectCamera(newIndex: number): void {
    const clamped = Math.max(0, Math.min(this.cameras.length - 1, newIndex));
    if (clamped === this.state.cameraIndex) return;

    // Stop old camera
    const oldDevice = this.devices.get(this.state.controlledCamera);
    if (oldDevice) {
      const tracking = trackingFor(this.state);
      const autonomous = tracking && Object.values(tracking.manager.getStatus()).some(source =>
        source.cameraId === this.state.controlledCamera && source.sessionId && source.state !== 'operator_override');
      // Selecting a different manual camera does not revoke the other rig's
      // autonomous session. Manual outgoing motion retains its normal stop.
      if (!autonomous) {
        tracking?.manager.operatorOverride(this.state.controlledCamera);
        if (tracking) tracking.ledger.stop(oldDevice); else oldDevice.stop();
      }
    }

    const cam = this.cameras[clamped];
    this.state.cameraIndex = clamped;
    this.state.controlledCamera = cam.id as CameraId;

    if (cam.inputId === undefined) {
      // Control-only camera (video not wired to the switcher). Take control of
      // its motion, but leave the preview bus alone — moving it to a dead input
      // would arm black for the next take.
      logger.info({ camera: cam.id, label: cam.label }, 'controlled camera changed (control-only: no ATEM input)');
      return;
    }

    this.state.previewCamera = this.state.controlledCamera;
    this.atem.changePreviewInput(cam.inputId).catch(err => {
      logger.warn({ err }, 'failed to update ATEM preview after camera select');
    });

    logger.info({ camera: this.state.controlledCamera }, 'controlled camera changed');
  }
}
