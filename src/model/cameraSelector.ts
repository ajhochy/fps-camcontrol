import { AppState, CameraId } from '../app/state';
import { CameraConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { ViscaClient } from '../visca/viscaClient';
import { stopPTZ } from '../visca/ptzActions';
import { logger } from '../index';

const FLICK_THRESHOLD = 0.75;
const FLICK_NEUTRAL = 0.25;

export class CameraSelector {
  private stickReadyForSelection = true;

  constructor(
    private state: AppState,
    private cameras: CameraConfig[],
    private atem: AtemClient,
    private viscaClients: Map<CameraId, ViscaClient>
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

  private selectCamera(newIndex: number): void {
    const clamped = Math.max(0, Math.min(this.cameras.length - 1, newIndex));
    if (clamped === this.state.cameraIndex) return;

    // Stop old camera
    const oldClient = this.viscaClients.get(this.state.controlledCamera);
    if (oldClient) stopPTZ(oldClient);

    this.state.cameraIndex = clamped;
    this.state.controlledCamera = this.cameras[clamped].id as CameraId;
    this.state.previewCamera = this.state.controlledCamera;

    this.atem.changePreviewInput(this.cameras[clamped].inputId).catch(err => {
      logger.warn({ err }, 'failed to update ATEM preview after camera select');
    });

    logger.info({ camera: this.state.controlledCamera }, 'controlled camera changed');
  }
}
