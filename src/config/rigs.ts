import type { AppState } from '../app/state';
import type { AppConfig, CameraConfig } from './configLoader';

/**
 * The "rig" view of the running configuration (see docs/ai/plans/2026-09-30-device-config-rigs-ui.md).
 *
 * A rig is one camera position: a controller device (V-BOT, BirdDog or DJI
 * gimbal), the ATEM input its video arrives on, and its name. In devices.yaml a
 * rig is an entry in the active profile's `slots:` list; this module only
 * *reads* that into a shape the Device Config screen can render. It has no
 * side effects and touches no hardware, so it is tested without starting the app.
 */

export type RigController = 'vbot' | 'birddog' | 'gimbal' | 'generic';

export interface RigConnectionVisca { host: string | null; port: number; address: number }
export interface RigConnectionGimbal {
  host: string; port: number; gimbalModel: string | null; safetyTimeoutMs: number; rollEnabled: boolean;
}

export interface RigView {
  /** 1-based position in the active profile. Decides `id` and the selection hotkey. */
  position: number;
  /** `cam1..camN`: the id the rest of the app (presets, hotkeys, status) uses. */
  id: string;
  /** Inventory key in devices.yaml (e.g. `rs3`); null for a legacy flat `cameras:` config. */
  deviceKey: string | null;
  label: string;
  controller: RigController;
  protocol: CameraConfig['protocol'];
  cameraType: CameraConfig['cameraType'];
  /** Exactly one of these is set, following `protocol`. */
  visca: RigConnectionVisca | null;
  gimbal: RigConnectionGimbal | null;
  speedScale: number;
  /** ATEM input this rig's video arrives on; null = control-only (not wired to the switcher). */
  inputId: number | null;
  wired: boolean;
  /** Controller button that selects this rig (from mappings.yaml `selectCamN`), if one is mapped. */
  hotkey: string | null;
  /** BirdDog cameras have a camera built in, so they never take a separate Sony camera. */
  builtInCamera: boolean;
  /** Key of the Sony camera device (protocol: sony) mounted on this rig; null when none is assigned. */
  camera: string | null;
  /** The mounted camera's display name (the Sony device's label); null when none. */
  cameraLabel: string | null;
  /** Names of the profiles whose rigs include this device (edits to a device apply to all of them). */
  usedInProfiles: string[];
  /** Live link state; keys are present only when the app tracks them for this kind of camera. */
  live: { connected: boolean | null; bridgeReachable?: boolean; gimbalAttached?: boolean };
}

/** What the Sony service reports about one camera (a subset of SonyCameraStatus). */
export interface SonyCameraInfo { id: string; model?: string; state?: string; connectionType?: string }

export interface SonyDeviceView {
  /** Inventory key in devices.yaml. */
  key: string;
  /** The operator's name for this camera; shown wherever a camera is picked. */
  label: string;
  /** The physical camera it is bound to; null until the camera has been seen and bound. */
  sonyCameraId: string | null;
  /** What the Sony service says about the bound camera right now; null when unbound or not reported. */
  state: string | null;
  model: string | null;
  /** Rigs in the active profile that use this camera. */
  usedByRigs: { position: number; id: string; label: string }[];
  usedInProfiles: string[];
}

export interface RigsView {
  version: string;
  activeProfile: string | null;
  /** True for a flat `cameras:` config without profiles: rigs are shown read-only. */
  legacy: boolean;
  rigs: RigView[];
  atem: AppConfig['atem'];
  graphics: AppConfig['graphics'];
  profiles: { name: string; label: string | null; active: boolean; rigCount: number }[];
  /** Sony cameras described in the inventory, with the name the operator gave each. */
  sonyDevices: SonyDeviceView[];
  /** Cameras the Sony service has found that no Sony device is bound to yet (candidates to add or bind). */
  unboundCameras: SonyCameraInfo[];
}

function controllerOf(cam: CameraConfig): RigController {
  if (cam.protocol === 'dji-bridge') return 'gimbal';
  if (cam.cameraType === 'vbot') return 'vbot';
  if (cam.cameraType === 'birddog') return 'birddog';
  return 'generic';
}

export function buildRigs(
  config: AppConfig,
  state: AppState,
  version: string,
  sonyCameras: SonyCameraInfo[] = [],
): RigsView {
  const active = config.activeProfile && config.profiles?.[config.activeProfile] ? config.activeProfile : null;
  const slots = active ? config.profiles![active].slots : [];
  const inventory = config.devices ?? {};

  const rigs = config.cameras.map((cam, i): RigView => {
    const deviceKey = slots[i]?.device ?? null;
    const controller = controllerOf(cam);
    const usedInProfiles = deviceKey
      ? Object.entries(config.profiles ?? {})
        .filter(([, profile]) => profile.slots.some((slot) => slot.device === deviceKey))
        .map(([name]) => name)
      : [];
    const live: RigView['live'] = { connected: state.cameraConnected[cam.id] ?? null };
    if (cam.id in state.cameraBridgeReachable) live.bridgeReachable = state.cameraBridgeReachable[cam.id];
    if (cam.id in state.cameraGimbalAttached) live.gimbalAttached = state.cameraGimbalAttached[cam.id];

    return {
      position: i + 1,
      id: cam.id,
      deviceKey,
      label: cam.label,
      controller,
      protocol: cam.protocol,
      cameraType: cam.cameraType,
      visca: cam.protocol === 'visca'
        ? { host: cam.viscaIp ?? null, port: cam.viscaPort, address: cam.cameraAddress }
        : null,
      gimbal: cam.protocol === 'dji-bridge' && cam.bridge
        ? {
          host: cam.bridge.host, port: cam.bridge.port, gimbalModel: cam.bridge.gimbalModel ?? null,
          safetyTimeoutMs: cam.bridge.safetyTimeoutMs, rollEnabled: cam.bridge.rollEnabled,
        }
        : null,
      speedScale: cam.speedScale,
      inputId: cam.inputId ?? null,
      wired: cam.inputId !== undefined,
      hotkey: i < 4 ? ((config.mappings as Record<string, unknown>)[`selectCam${i + 1}`] as string | undefined) ?? null : null,
      builtInCamera: controller === 'birddog',
      camera: slots[i]?.camera ?? null,
      cameraLabel: slots[i]?.camera ? inventory[slots[i].camera!]?.label ?? null : null,
      usedInProfiles,
      live,
    };
  });

  const byId = new Map(sonyCameras.map((camera) => [camera.id.toUpperCase(), camera]));
  const boundIds = new Set<string>();
  const sonyDevices = Object.entries(inventory)
    .filter(([, device]) => device.protocol === 'sony')
    .map(([key, device]): SonyDeviceView => {
      const seen = device.sonyCameraId ? byId.get(device.sonyCameraId.toUpperCase()) : undefined;
      if (device.sonyCameraId) boundIds.add(device.sonyCameraId.toUpperCase());
      return {
        key,
        label: device.label,
        sonyCameraId: device.sonyCameraId ?? null,
        state: seen?.state ?? null,
        model: seen?.model ?? null,
        usedByRigs: rigs.filter((rig) => rig.camera === key).map((rig) => ({ position: rig.position, id: rig.id, label: rig.label })),
        usedInProfiles: Object.entries(config.profiles ?? {})
          .filter(([, profile]) => profile.slots.some((slot) => slot.camera === key))
          .map(([name]) => name),
      };
    });

  return {
    version,
    activeProfile: active,
    legacy: active === null,
    rigs,
    atem: config.atem,
    graphics: config.graphics,
    profiles: Object.entries(config.profiles ?? {}).map(([name, profile]) => ({
      name, label: profile.label ?? null, active: name === active, rigCount: profile.slots.length,
    })),
    sonyDevices,
    unboundCameras: sonyCameras.filter((camera) => !boundIds.has(camera.id.toUpperCase())),
  };
}

export interface RigDeleteImpact {
  position: number;
  id: string;
  label: string;
  deviceKey: string | null;
  /** Preset slots (e.g. A, X) that hold a saved position and are lost with the rig. */
  presetsLost: string[];
  /** Later rigs move up one position: their camera id and hotkey change, and their presets move with them. */
  shifted: { deviceKey: string | null; label: string; fromId: string; toId: string; fromHotkey: string | null; toHotkey: string | null; presetsMoved: string[] }[];
  /** Other profiles that use the same hardware. */
  usedInOtherProfiles: string[];
}

/** What removing the rig at `position` would change, for the confirmation shown before deleting. */
export function describeRigDelete(
  view: RigsView,
  presets: Record<string, Record<string, unknown>>,
  mappings: Record<string, unknown>,
  position: number,
  slotsSet: (entry: Record<string, unknown> | undefined) => string[],
): RigDeleteImpact {
  const rig = view.rigs[position - 1];
  const hotkeyAt = (p: number): string | null => (p <= 4 ? ((mappings[`selectCam${p}`] as string | undefined) ?? null) : null);
  return {
    position,
    id: rig.id,
    label: rig.label,
    deviceKey: rig.deviceKey,
    presetsLost: slotsSet(presets[rig.id]),
    shifted: view.rigs.slice(position).map((later) => ({
      deviceKey: later.deviceKey,
      label: later.label,
      fromId: later.id,
      toId: `cam${later.position - 1}`,
      fromHotkey: hotkeyAt(later.position),
      toHotkey: hotkeyAt(later.position - 1),
      presetsMoved: slotsSet(presets[later.id]),
    })),
    usedInOtherProfiles: rig.usedInProfiles.filter((name) => name !== view.activeProfile),
  };
}
