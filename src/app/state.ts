export type CameraId = string;
export type PresetSlot = 'A' | 'B' | 'X' | 'Y';

export interface PresetSaveProgress {
  cameraId: string;
  slot: PresetSlot;
  framesHeld: number;
}

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
  cameraConnected: Record<string, boolean>;
  controllerConnected: boolean;
  lastPresetNotification: string | null;
  presetSaveProgress: PresetSaveProgress | null;
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
  cameraConnected: {},
  controllerConnected: false,
  lastPresetNotification: null,
  presetSaveProgress: null,
};
