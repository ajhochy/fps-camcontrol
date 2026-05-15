export type CameraId = 'cam1' | 'cam2' | 'cam3';
export type PresetSlot = 'A' | 'B' | 'X' | 'Y';

export interface AppState {
  controlledCamera: CameraId;
  programCamera: CameraId;
  previewCamera: CameraId;
  cameraIndex: number;
  speedPreset: number;
  precisionMode: boolean;
  sprintMode: boolean;
  lowerThirdsActive: boolean;
  atemConnected: boolean;
  cameraConnected: Record<CameraId, boolean>;
  controllerConnected: boolean;
  activeControllerProfile: string | null;
  activeConnectionType: 'usb' | 'bluetooth' | null;
  lastPresetNotification: string | null;
}

export const defaultState: AppState = {
  controlledCamera: 'cam2',
  programCamera: 'cam2',
  previewCamera: 'cam2',
  cameraIndex: 1,
  speedPreset: 1,
  precisionMode: false,
  sprintMode: false,
  lowerThirdsActive: false,
  atemConnected: false,
  cameraConnected: { cam1: false, cam2: false, cam3: false },
  controllerConnected: false,
  activeControllerProfile: null,
  activeConnectionType: null,
  lastPresetNotification: null,
};
