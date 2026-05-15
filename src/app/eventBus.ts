import { EventEmitter } from 'events';
import { CameraId, PresetSlot } from './state';

export type AppEvent =
  | { type: 'stateChanged' }
  | { type: 'cameraSwitched'; cameraId: CameraId }
  | { type: 'cutLive'; cameraId: CameraId }
  | { type: 'autoTransition'; cameraId: CameraId }
  | { type: 'presetRecalled'; cameraId: CameraId; slot: PresetSlot }
  | { type: 'presetSaved'; cameraId: CameraId; slot: PresetSlot }
  | { type: 'emergencyStop' }
  | { type: 'speedChanged'; presetIndex: number }
  | { type: 'lowerThirdsToggled'; active: boolean };

class TypedEventBus extends EventEmitter {
  emit(event: string, data?: AppEvent): boolean {
    return super.emit(event, data);
  }
  on(event: string, listener: (data: AppEvent) => void): this {
    return super.on(event, listener);
  }
}

export const eventBus = new TypedEventBus();
