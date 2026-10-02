export type CameraId = string;
export type PresetSlot = 'A' | 'B' | 'X' | 'Y';

export interface PresetSaveProgress {
  cameraId: string;
  slot: PresetSlot;
  framesHeld: number;
}

export interface RemoteControlStatus {
  enabled: boolean;
  owner: 'local' | 'remote';
  ownerName: string | null;
  /** Connected remote pages (the owner and any spectators). */
  sessions: number;
  /** How long ago the owning remote last sent a frame; null when the desk owns. */
  lastFrameAgoMs: number | null;
  /** The owning remote's last measured round trip. */
  rttMs: number | null;
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
  /** False when a linked gimbal ignored the operator's stick (asleep, unbalanced, motors off); absent otherwise. */
  cameraGimbalResponding: Record<string, boolean>;
  /** How a gimbal's Bluetooth link to its bridge is holding up (bridges >= 0.3.0); absent when not measured. */
  cameraGimbalSignal: Record<string, GimbalSignal>;
  /** A gimbal's own sleep report (bridges >= 0.4.0): true asleep, false awake; absent when not reported. */
  cameraGimbalAsleep: Record<string, boolean>;
  /** True when a gimbal's bridge can wake it (bridges >= 0.5.0 advertise "wake"); absent otherwise. */
  cameraGimbalCanWake: Record<string, boolean>;
  /** Which Bluetooth gimbal a DJI rig's bridge drives (bridges >= 0.6.0); absent for older bridges or while unreachable. */
  cameraGimbalBluetooth?: Record<string, GimbalBluetoothView>;
  /** VISCA cameras: did the last health check get a reply (true), get none (false); absent until checked. */
  cameraAnswering: Record<string, boolean>;
  /** VISCA cameras: when the camera last sent any reply (ms since epoch). */
  cameraLastReplyAt: Record<string, number>;
  /** Whether VISCA replies sent to port 52381 can be heard (the app holds that port); null before it binds. */
  viscaRepliesHeard: boolean | null;
  /** Per-rig health (motion side, and the Sony camera on it), recomputed every second; see app/health.ts. */
  health: { rigs: Record<string, unknown>; cameras: Record<string, unknown> } | null;
  /** Who is driving (desk controller or an iPad) and whether iPad control is switched on; see input/remoteControl.ts. */
  remoteControl: RemoteControlStatus;
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
  cameraGimbalResponding: {},
  cameraGimbalSignal: {},
  cameraGimbalAsleep: {},
  cameraGimbalCanWake: {},
  cameraAnswering: {},
  cameraLastReplyAt: {},
  viscaRepliesHeard: null,
  health: null,
  remoteControl: { enabled: false, owner: 'local', ownerName: null, sessions: 0, lastFrameAgoMs: null, rttMs: null },
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
    cameraGimbalResponding: {},
    cameraGimbalSignal: {},
    cameraGimbalAsleep: {},
    cameraGimbalCanWake: {},
    cameraAnswering: {},
    cameraLastReplyAt: {},
    viscaRepliesHeard: null,
    health: null,
    remoteControl: { ...defaultState.remoteControl },
    ...overrides,
  };
}

/** The raw Bluetooth link figures a bridge reports for its gimbal. */
export interface GimbalLinkHealth { drops10m: number; framesLastMin: number; corruptLastMin: number; linkedForS: number | null }
export interface GimbalBluetoothView { address: string | null; name: string | null; rssi: number | null; mode: 'auto' | 'fixed' | null; chosenBy: string | null; saved: boolean | null; connected: boolean | null; switching: boolean; error: string | null }
export interface GimbalSignal { rating: 'good' | 'weak' | 'poor'; drops10m: number; corruptPct: number | null; summary: string }

/**
 * Rate a gimbal's Bluetooth link from what its bridge reports. Corrupt frames are what a weak signal looks like
 * before the link drops; drops are the link actually failing. Thresholds live here (not on the Pi) so they can be
 * tuned without redeploying the bridge.
 */
export function rateGimbalSignal(link: GimbalLinkHealth | null | undefined): GimbalSignal | null {
  if (!link || typeof link.drops10m !== 'number') return null;
  const corruptPct = link.framesLastMin >= 20 ? Math.round((link.corruptLastMin / link.framesLastMin) * 1000) / 10 : null;
  // One drop that recovered (a gimbal power-cycled, a link released by hand) is not a weak signal; repeated drops are.
  const rating: GimbalSignal['rating'] = link.drops10m >= 4 || (corruptPct !== null && corruptPct >= 5) ? 'poor'
    : link.drops10m >= 2 || (corruptPct !== null && corruptPct >= 1) ? 'weak' : 'good';
  const parts: string[] = [];
  if (link.drops10m) parts.push(`${link.drops10m} Bluetooth drop${link.drops10m === 1 ? '' : 's'} in 10 min`);
  if (corruptPct !== null && corruptPct >= 1) parts.push(`${corruptPct}% of data arriving corrupt`);
  const summary = rating === 'good' ? (link.drops10m ? `Bluetooth link healthy (recovered from ${link.drops10m} drop in 10 min)` : 'Bluetooth link healthy') : parts.join(', ');
  return { rating, drops10m: link.drops10m, corruptPct, summary };
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
  link: { connected: boolean; gimbalAttached?: boolean; reportedGimbalModel?: string | null; motionResponsive?: boolean; linkHealth?: GimbalLinkHealth | null; reportedAsleep?: boolean | null; capabilities?: { wake?: boolean }; bluetoothGimbal?: GimbalBluetoothView | null }
): void {
  if (link.connected && typeof link.reportedAsleep === 'boolean') state.cameraGimbalAsleep[cameraId] = link.reportedAsleep;
  else delete state.cameraGimbalAsleep[cameraId];
  if (!state.cameraGimbalCanWake) state.cameraGimbalCanWake = {};
  if (link.connected && link.capabilities?.wake === true) state.cameraGimbalCanWake[cameraId] = true;
  else delete state.cameraGimbalCanWake[cameraId];
  if (!state.cameraGimbalBluetooth) state.cameraGimbalBluetooth = {};
  if (link.connected && link.bluetoothGimbal) state.cameraGimbalBluetooth[cameraId] = { ...link.bluetoothGimbal };
  else delete state.cameraGimbalBluetooth[cameraId];
  const signal = link.connected ? rateGimbalSignal(link.linkHealth) : null;
  if (signal) state.cameraGimbalSignal[cameraId] = signal;
  else delete state.cameraGimbalSignal[cameraId];
  if (typeof link.reportedGimbalModel === 'string') state.cameraGimbalModel[cameraId] = link.reportedGimbalModel;
  else delete state.cameraGimbalModel[cameraId];
  const notMoving = link.motionResponsive === false && link.connected && link.gimbalAttached === true;
  if (notMoving) state.cameraGimbalResponding[cameraId] = false;
  else delete state.cameraGimbalResponding[cameraId];
  if (link.gimbalAttached === undefined) {
    delete state.cameraBridgeReachable[cameraId];
    delete state.cameraGimbalAttached[cameraId];
    state.cameraConnected[cameraId] = link.connected;
    return;
  }
  state.cameraBridgeReachable[cameraId] = link.connected;
  state.cameraGimbalAttached[cameraId] = link.gimbalAttached;
  state.cameraConnected[cameraId] = link.connected && link.gimbalAttached && !notMoving;
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
  readonly motionResponsive?: boolean;
  readonly linkHealth?: GimbalLinkHealth | null;
  readonly reportedAsleep?: boolean | null;
  readonly capabilities?: { wake?: boolean };
  readonly bluetoothGimbal?: GimbalBluetoothView | null;
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
  device.on('gimbalResponsive', sync);
  device.on('gimbalUnresponsive', sync);
  device.on('linkHealth', sync);
  device.on('sleepReport', sync);
  device.on('bluetoothGimbal', sync);
  sync();
}

/** Drop every trace of a camera that no longer exists in the active profile. */
export function clearCameraLinkState(state: AppState, cameraId: string): void {
  delete state.cameraConnected[cameraId];
  delete state.cameraBridgeReachable[cameraId];
  delete state.cameraGimbalAttached[cameraId];
  delete state.cameraGimbalModel[cameraId];
  delete state.cameraGimbalResponding[cameraId];
  delete state.cameraGimbalSignal[cameraId];
  delete state.cameraGimbalAsleep[cameraId];
  if (state.cameraGimbalCanWake) delete state.cameraGimbalCanWake[cameraId];
  if (state.cameraGimbalBluetooth) delete state.cameraGimbalBluetooth[cameraId];
  delete state.cameraAnswering[cameraId];
  delete state.cameraLastReplyAt[cameraId];
}
