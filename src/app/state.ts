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
  /**
   * Can this camera actually be moved? The single yes/no the operator cares
   * about. For a gimbal this requires BOTH that its Pi bridge is reachable AND
   * that a gimbal is attached to it — reporting a reachable bridge as a
   * connected camera is what made a dead gimbal show green (issue #16).
   */
  cameraConnected: Record<string, boolean>;
  /**
   * Detail for cameras reached through a two-stage link (app → Pi bridge →
   * gimbal). Absent for direct-link cameras (VISCA), where `cameraConnected`
   * already says everything — so a missing key means "not applicable", not
   * "broken", and the three VISCA cameras stay unaffected.
   *
   * Both are kept because they need different remedies: an unreachable bridge
   * means fix the network or the Pi; a detached gimbal means switch it on.
   */
  cameraBridgeReachable: Record<string, boolean>;
  cameraGimbalAttached: Record<string, boolean>;
  /** The gimbal model a DJI bridge named in its handshake, by camera id; absent for VISCA or before one. */
  cameraGimbalModel: Record<string, string>;
  controllerConnected: boolean;
  activeControllerProfile: string | null;
  activeConnectionType: 'usb' | 'bluetooth' | null;
  // Why a detected controller is not delivering input, if that is the case.
  controllerStatusDetail: string | null;
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
  cameraBridgeReachable: {},
  cameraGimbalAttached: {},
  cameraGimbalModel: {},
  controllerConnected: false,
  activeControllerProfile: null,
  activeConnectionType: null,
  controllerStatusDetail: null,
  lastPresetNotification: null,
  presetSaveProgress: null,
};

/**
 * A fresh state with its own camera maps.
 *
 * `{ ...defaultState }` is a shallow copy, so every state built that way shared
 * one `cameraConnected` object with the module-level default — writes leaked
 * between instances (and between smoke tests). Use this instead.
 */
export function createInitialState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...defaultState,
    cameraConnected: {},
    cameraBridgeReachable: {},
    cameraGimbalAttached: {},
    cameraGimbalModel: {},
    ...overrides,
  };
}

/**
 * Fold one device's link stages into the flat, camera-keyed maps that
 * `/api/status` and the UI read. The only place that decides what "connected"
 * means, so the startup wiring, the profile/config reconciler and the watchdog
 * cannot drift apart.
 *
 * `gimbalAttached === undefined` marks a direct-link device (VISCA): the detail
 * keys are cleared and `cameraConnected` is just the transport state, exactly as
 * before. For a two-stage device both stages are recorded and `cameraConnected`
 * is their AND.
 *
 * Keys are camera ids, not device ids, because the same physical gimbal occupies
 * different slots in different profiles — hence the deletes, so a stale detail
 * key can never outlive a profile switch.
 */
export function applyDeviceLinkState(
  state: AppState,
  cameraId: string,
  link: { connected: boolean; gimbalAttached?: boolean; reportedGimbalModel?: string | null }
): void {
  if (typeof link.reportedGimbalModel === 'string') state.cameraGimbalModel[cameraId] = link.reportedGimbalModel;
  else delete state.cameraGimbalModel[cameraId];
  if (link.gimbalAttached === undefined) {
    delete state.cameraBridgeReachable[cameraId];
    delete state.cameraGimbalAttached[cameraId];
    state.cameraConnected[cameraId] = link.connected;
    return;
  }
  state.cameraBridgeReachable[cameraId] = link.connected;
  state.cameraGimbalAttached[cameraId] = link.gimbalAttached;
  state.cameraConnected[cameraId] = link.connected && link.gimbalAttached;
}

/**
 * Minimal shape `trackDeviceLinkState` needs. Declared structurally rather than
 * importing MotionDevice so this module stays free of a dependency on the device
 * layer.
 */
interface LinkStateSource {
  readonly connected: boolean;
  readonly gimbalAttached?: boolean;
  readonly reportedGimbalModel?: string | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Subscribe a camera slot to every event that can change its link state, and
 * seed it immediately.
 *
 * Each handler re-reads the device rather than asserting a hardcoded true/false,
 * so no ordering of `connected` / `gimbalAttached` / `gimbalDetached` can leave
 * the published state disagreeing with the device.
 */
export function trackDeviceLinkState(
  state: AppState,
  cameraId: string,
  device: LinkStateSource
): void {
  const sync = () => applyDeviceLinkState(state, cameraId, device);
  device.on('connected', sync);
  device.on('disconnected', sync);
  device.on('gimbalAttached', sync);
  device.on('gimbalDetached', sync);
  sync();
}

/** Drop every trace of a camera that no longer exists in the active profile. */
export function clearCameraLinkState(state: AppState, cameraId: string): void {
  delete state.cameraConnected[cameraId];
  delete state.cameraBridgeReachable[cameraId];
  delete state.cameraGimbalAttached[cameraId];
  delete state.cameraGimbalModel[cameraId];
}
