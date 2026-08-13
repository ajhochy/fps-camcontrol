import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const BridgeSchema = z.object({
  host: z.string(),
  port: z.number().default(7878),
  gimbalModel: z.string().optional(),
  safetyTimeoutMs: z.number().default(250),
  reconnectBackoffMs: z.array(z.number()).default([1000, 2000, 5000, 15000]),
  rollEnabled: z.boolean().default(false),
});

const CameraSchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: z.enum(['visca', 'dji-bridge']).default('visca'),
  cameraType: z.enum(['vbot', 'birddog', 'generic']).default('generic'),
  // Omit when the camera's video is not wired to the switcher yet: the app will
  // still drive its motion, but will not move the ATEM preview bus to it and
  // will refuse to take it live (taking an unwired input cuts black to air).
  inputId: z.number().optional(),
  viscaIp: z.string().optional(),
  viscaPort: z.number().default(52381),
  cameraAddress: z.number().min(0).max(7).default(1),
  // Per-camera speed multiplier. 1.0 = same speed as the global preset; raise
  // above 1 for slower cameras (V-BOT) so they keep up with faster BirdDogs.
  speedScale: z.number().min(0.1).max(5).default(1.0),
  bridge: BridgeSchema.optional(),
}).superRefine((cam, ctx) => {
  if (cam.protocol === 'visca' && !cam.viscaIp) {
    ctx.addIssue({ code: 'custom', message: `camera ${cam.id}: viscaIp required when protocol=visca`, path: ['viscaIp'] });
  }
  if (cam.protocol === 'dji-bridge' && !cam.bridge) {
    ctx.addIssue({ code: 'custom', message: `camera ${cam.id}: bridge required when protocol=dji-bridge`, path: ['bridge'] });
  }
});

const GraphicsSchema = z.object({
  type: z.enum(['dsk', 'usk', 'auto']).default('dsk'),
  dskIndex: z.number().default(0),
  uskIndex: z.number().default(0),
  meIndex: z.number().default(0),
  // Fade duration (in frames) for the KEY on/off auto-transition. ~15 frames
  // is a smooth half-second fade at 30fps. Set to 0 for an instant hard cut.
  fadeFrames: z.number().min(0).max(250).default(15),
});

const AtemSchema = z.object({
  ip: z.string(),
  defaultTransition: z.enum(['cut', 'auto']),
  meIndex: z.number().default(0),
});

// An entry in the device inventory: a piece of hardware that exists, described
// once, independent of which camera slot (if any) currently uses it. Deliberately
// has no `id` or `inputId` — those belong to the slot a profile puts it in.
const InventoryDeviceSchema = z.object({
  label: z.string(),
  protocol: z.enum(['visca', 'dji-bridge']).default('visca'),
  cameraType: z.enum(['vbot', 'birddog', 'generic']).default('generic'),
  viscaIp: z.string().optional(),
  viscaPort: z.number().default(52381),
  cameraAddress: z.number().min(0).max(7).default(1),
  speedScale: z.number().min(0.1).max(5).default(1.0),
  bridge: BridgeSchema.optional(),
}).superRefine((dev, ctx) => {
  if (dev.protocol === 'visca' && !dev.viscaIp) {
    ctx.addIssue({ code: 'custom', message: `device ${dev.label}: viscaIp required when protocol=visca`, path: ['viscaIp'] });
  }
  if (dev.protocol === 'dji-bridge' && !dev.bridge) {
    ctx.addIssue({ code: 'custom', message: `device ${dev.label}: bridge required when protocol=dji-bridge`, path: ['bridge'] });
  }
});

// One camera slot in a profile: which inventory device fills it, and which ATEM
// input that device's video arrives on. Slot order defines cam1..camN, which is
// what the face-button hotkeys (X/A/B/Y) and the left-stick selector address.
const SlotSchema = z.object({
  device: z.string(),
  // Optional: a slot whose camera is not wired to the switcher is control-only
  // (motion works, switching does not). See CameraSchema.inputId.
  inputId: z.number().optional(),
});

const ProfileSchema = z.object({
  label: z.string().optional(),
  slots: z.array(SlotSchema).min(1).max(8),
});

const DevicesSchema = z.object({
  atem: AtemSchema,
  // Legacy/direct form: an explicit camera list. Still supported so existing
  // configs keep working; profiles resolve into exactly this shape.
  cameras: z.array(CameraSchema).optional(),
  devices: z.record(z.string(), InventoryDeviceSchema).optional(),
  profiles: z.record(z.string(), ProfileSchema).optional(),
  activeProfile: z.string().optional(),
  graphics: GraphicsSchema.optional(),
  lowerThirds: z.object({ type: z.string(), dskIndex: z.number() }).optional(),
}).superRefine((cfg, ctx) => {
  const hasProfiles = !!cfg.profiles && !!cfg.activeProfile;
  if (!hasProfiles && !cfg.cameras) {
    ctx.addIssue({
      code: 'custom',
      message: 'config must define either `cameras:` or `devices:` + `profiles:` + `activeProfile:`',
      path: ['cameras'],
    });
    return;
  }
  if (!hasProfiles) return;

  const profile = cfg.profiles![cfg.activeProfile!];
  if (!profile) {
    ctx.addIssue({
      code: 'custom',
      message: `activeProfile "${cfg.activeProfile}" is not defined in profiles (have: ${Object.keys(cfg.profiles!).join(', ')})`,
      path: ['activeProfile'],
    });
    return;
  }
  // Every slot must reference a device that actually exists in the inventory,
  // otherwise the profile silently resolves to a camera that can't connect.
  profile.slots.forEach((slot, i) => {
    if (!cfg.devices || !cfg.devices[slot.device]) {
      ctx.addIssue({
        code: 'custom',
        message: `profile "${cfg.activeProfile}" slot ${i + 1} references unknown device "${slot.device}" (have: ${Object.keys(cfg.devices ?? {}).join(', ')})`,
        path: ['profiles', cfg.activeProfile!, 'slots', i, 'device'],
      });
    }
  });
});

const SpeedPresetsSchema = z.object({
  presets: z.array(z.object({
    name: z.string(),
    multiplier: z.number(),
  })),
  activePreset: z.number(),
});

const MappingSchema = z.object({
  panTilt: z.string().default('rightStick'),
  zoomIn: z.string().default('rightTrigger'),
  zoomOut: z.string().default('leftTrigger'),
  cameraSelectLeft: z.string().default('leftStickLeft'),
  cameraSelectRight: z.string().default('leftStickRight'),
  autoTransition: z.string().default('RB'),
  precisionMode: z.string().default('LS'),
  selectCam1: z.string().default('X'),
  selectCam2: z.string().default('A'),
  selectCam3: z.string().default('B'),
  selectCam4: z.string().default('Y'),
  speedUp: z.string().default('dpadUp'),
  speedDown: z.string().default('dpadDown'),
  lowerThirds: z.string().default('dpadLeft'),
  emergencyStop: z.string().default('back'),
});

export type CameraConfig = z.infer<typeof CameraSchema>;
export type GraphicsConfig = z.infer<typeof GraphicsSchema>;
export type MappingConfig = z.infer<typeof MappingSchema>;
export type InventoryDevice = z.infer<typeof InventoryDeviceSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export interface AppConfig {
  atem: { ip: string; defaultTransition: string; meIndex: number };
  /** The resolved camera slots (cam1..camN) the whole app operates on. */
  cameras: CameraConfig[];
  graphics: GraphicsConfig;
  speeds: z.infer<typeof SpeedPresetsSchema>;
  mappings: MappingConfig;
  /** Inventory of all known hardware, whether or not a slot currently uses it. */
  devices?: Record<string, InventoryDevice>;
  profiles?: Record<string, Profile>;
  activeProfile?: string;
}

/**
 * Turn a profile's slots into the flat `cameras` list the rest of the app uses.
 *
 * Everything downstream (control state machine, camera selector, hotkeys, UI,
 * presets) reads `config.cameras`, so resolving here means profiles are purely a
 * config-authoring convenience and need no changes anywhere else. Slot order
 * defines cam1..camN and therefore the X/A/B/Y hotkey order.
 */
export function resolveProfile(
  devices: Record<string, InventoryDevice>,
  profile: Profile
): CameraConfig[] {
  return profile.slots.map((slot, i) => {
    const dev = devices[slot.device];
    if (!dev) throw new Error(`unknown device "${slot.device}" in profile slot ${i + 1}`);
    return CameraSchema.parse({
      id: `cam${i + 1}`,
      label: dev.label,
      protocol: dev.protocol,
      cameraType: dev.cameraType,
      inputId: slot.inputId,
      viscaIp: dev.viscaIp,
      viscaPort: dev.viscaPort,
      cameraAddress: dev.cameraAddress,
      speedScale: dev.speedScale,
      bridge: dev.bridge,
    });
  });
}

export function loadConfig(): AppConfig {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');

  const devicesRaw = yaml.load(fs.readFileSync(devicesPath, 'utf8'));
  const devices = DevicesSchema.parse(devicesRaw);

  // Normalize graphics: support legacy lowerThirds key
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );

  const speedsRaw = JSON.parse(fs.readFileSync(speedsPath, 'utf8'));
  const speeds = SpeedPresetsSchema.parse(speedsRaw);

  let mappings: MappingConfig;
  try {
    const mappingsRaw = yaml.load(fs.readFileSync(mappingsPath, 'utf8')) ?? {};
    mappings = MappingSchema.parse(mappingsRaw);
  } catch {
    mappings = MappingSchema.parse({});
  }

  // Profiles win when present; otherwise fall back to the explicit camera list.
  const cameras = devices.profiles && devices.activeProfile
    ? resolveProfile(devices.devices ?? {}, devices.profiles[devices.activeProfile])
    : devices.cameras ?? [];

  return {
    atem: devices.atem,
    cameras,
    graphics,
    speeds,
    mappings,
    devices: devices.devices,
    profiles: devices.profiles,
    activeProfile: devices.activeProfile,
  };
}

export function validateDevicesConfig(raw: unknown): Pick<AppConfig, 'atem' | 'cameras' | 'graphics'> {
  const devices = DevicesSchema.parse(raw);
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );
  const cameras = devices.profiles && devices.activeProfile
    ? resolveProfile(devices.devices ?? {}, devices.profiles[devices.activeProfile])
    : devices.cameras ?? [];
  return { atem: devices.atem, cameras, graphics };
}

function readDevicesYaml(): Record<string, unknown> {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  try {
    return (yaml.load(fs.readFileSync(devicesPath, 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function writeDevicesYaml(data: Record<string, unknown>): void {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  fs.writeFileSync(devicesPath, yaml.dump(data, { lineWidth: 120 }), 'utf8');
}

/** Persist which profile is active, leaving the rest of the file untouched. */
export function saveActiveProfile(profileName: string): void {
  const existing = readDevicesYaml();
  const profiles = existing.profiles as Record<string, unknown> | undefined;
  if (!profiles || !profiles[profileName]) {
    throw new Error(`unknown profile "${profileName}" (have: ${Object.keys(profiles ?? {}).join(', ') || 'none'})`);
  }
  existing.activeProfile = profileName;
  writeDevicesYaml(existing);
}

/** Persist profile slot definitions, validating them before touching the file. */
export function saveProfiles(profiles: Record<string, Profile>): void {
  const existing = readDevicesYaml();
  const inventory = (existing.devices ?? {}) as Record<string, unknown>;
  for (const [name, profile] of Object.entries(profiles)) {
    ProfileSchema.parse(profile);
    profile.slots.forEach((slot, i) => {
      if (!inventory[slot.device]) {
        throw new Error(`profile "${name}" slot ${i + 1}: unknown device "${slot.device}" (have: ${Object.keys(inventory).join(', ')})`);
      }
    });
  }
  existing.profiles = profiles;
  // If the active profile was deleted, fall back to one that still exists so the
  // next load doesn't fail validation.
  const active = existing.activeProfile as string | undefined;
  if (active && !profiles[active]) existing.activeProfile = Object.keys(profiles)[0];
  writeDevicesYaml(existing);
}

export function saveDevicesConfig(config: Pick<AppConfig, 'atem' | 'cameras' | 'graphics'>): void {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');

  // Merge into the existing file rather than replacing it. `cameras` is derived
  // from the active profile, so a blind write of {atem, cameras, graphics} would
  // delete the whole `devices:` inventory and every profile.
  let existing: Record<string, unknown> = {};
  try {
    existing = (yaml.load(fs.readFileSync(devicesPath, 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    existing = {};
  }

  const out: Record<string, unknown> = { ...existing, atem: config.atem, graphics: config.graphics };
  const profiles = existing.profiles as Record<string, z.infer<typeof ProfileSchema>> | undefined;
  const activeProfile = existing.activeProfile as string | undefined;
  const inventory = existing.devices as Record<string, Record<string, unknown>> | undefined;

  if (profiles && activeProfile && profiles[activeProfile] && inventory) {
    // Profile-driven: push each edited camera back onto the inventory device that
    // fills its slot (and the slot's ATEM input), so UI edits persist to the real
    // source of truth instead of being silently discarded on next load.
    const slots = profiles[activeProfile].slots;
    config.cameras.forEach((cam, i) => {
      const slot = slots[i];
      if (!slot) return;
      const dev = inventory[slot.device];
      if (!dev) return;
      dev.label = cam.label;
      dev.protocol = cam.protocol;
      dev.cameraType = cam.cameraType;
      dev.cameraAddress = cam.cameraAddress;
      dev.speedScale = cam.speedScale;
      if (cam.viscaIp !== undefined) dev.viscaIp = cam.viscaIp;
      dev.viscaPort = cam.viscaPort;
      if (cam.bridge !== undefined) dev.bridge = cam.bridge;
      slot.inputId = cam.inputId;
    });
    out.devices = inventory;
    out.profiles = profiles;
    delete out.cameras; // stays derived; keeping a stale copy would be misleading
  } else {
    out.cameras = config.cameras;
  }

  fs.writeFileSync(devicesPath, yaml.dump(out, { lineWidth: 120 }), 'utf8');
}

export function saveMappings(mappings: MappingConfig): void {
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');
  const header = '# Controller button mappings - managed by FPS CamControl UI\n';
  fs.writeFileSync(mappingsPath, header + yaml.dump(mappings), 'utf8');
}
