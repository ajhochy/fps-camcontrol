import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
// The `yaml` package (not js-yaml) is used here on purpose: its Document API
// round-trips comments, which is what keeps devices.yaml's hand-written
// documentation alive across a UI save. See writeDevicesYaml().
import * as YAML from 'yaml';
import { z } from 'zod';

// The string forms of JavaScript's nullish values. A UI that interpolates an
// absent field into a text input produces the literal string "undefined", which
// is a perfectly good non-empty string and so used to pass validation and get
// written to disk as a camera's IP address (issue #18). No real config contains
// these, so reject them at the schema boundary.
const PLACEHOLDER_HOST = /^(undefined|null|nan|none)$/i;

/** A hostname or IP as typed by a human or produced by a form. */
const HostString = z.string().trim().refine(
  (v) => v.length > 0 && !PLACEHOLDER_HOST.test(v),
  { message: 'must be a real hostname or IP address (got an empty value or a placeholder like "undefined")' },
);

// An ATEM input number, or "this camera's video is not wired to the switcher".
// `null` is accepted as an explicit "not wired" because JSON.stringify drops
// undefined properties entirely, leaving a client no way to say "clear this".
// Both null and absent resolve to undefined = control-only.
const OptionalInputId = z.union([z.number(), z.null()])
  .transform((v) => (v === null ? undefined : v))
  .optional();

const BridgeSchema = z.object({
  host: HostString,
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
  inputId: OptionalInputId,
  viscaIp: HostString.optional(),
  viscaPort: z.number().default(52381),
  cameraAddress: z.number().min(0).max(7).default(1),
  // Per-camera speed multiplier. 1.0 = same speed as the global preset; raise
  // above 1 for slower cameras (V-BOT) so they keep up with faster BirdDogs.
  speedScale: z.number().min(0.1).max(5).default(1.0),
  bridge: BridgeSchema.optional(),
  // Key of the Sony camera device (protocol: sony) mounted on this rig, if any.
  camera: z.string().optional(),
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
  ip: HostString,
  defaultTransition: z.enum(['cut', 'auto']),
  meIndex: z.number().default(0),
});

const SonySchema = z.object({
  enabled: z.boolean().default(true),
  apiUrl: z.string().url().default('http://127.0.0.1:8181'),
  executable: z.string().optional(),
  stateFile: z.string().min(1).optional(),
});

// An entry in the device inventory: a piece of hardware that exists, described
// once, independent of which camera slot (if any) currently uses it. Deliberately
// has no `id` or `inputId` — those belong to the slot a profile puts it in.
const InventoryDeviceSchema = z.object({
  label: z.string(),
  // `sony` is a camera (not a controller): it is referenced from a rig's `camera:` and can never be a rig's `device:`.
  protocol: z.enum(['visca', 'dji-bridge', 'sony']).default('visca'),
  cameraType: z.enum(['vbot', 'birddog', 'generic']).default('generic'),
  viscaIp: HostString.optional(),
  viscaPort: z.number().default(52381),
  cameraAddress: z.number().min(0).max(7).default(1),
  speedScale: z.number().min(0.1).max(5).default(1.0),
  bridge: BridgeSchema.optional(),
  // The camera id the Sony sidecar reports (a MAC address). Optional so a rig can be set up before its camera is first seen.
  sonyCameraId: z.string().regex(/^[A-Za-z0-9:-]{1,128}$/, 'sonyCameraId must be a camera id such as 9C:50:D1:AC:7B:72').optional(),
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
  inputId: OptionalInputId,
  // Key of the Sony camera device mounted on this rig (optional; BirdDog rigs have a built-in camera and take none).
  camera: z.string().optional(),
});

const ProfileSchema = z.object({
  label: z.string().optional(),
  slots: z.array(SlotSchema).min(1).max(8),
});

/**
 * Cross-checks between the device inventory and the rigs (profile slots) that use it.
 * Shared by config load and by profile saves so the rules cannot drift:
 *  - a rig's `device` must be a controller, never a Sony camera;
 *  - a rig's `camera` must be a Sony camera device, and BirdDog rigs (built-in camera) take none;
 *  - a Sony camera can be on only one rig per profile;
 *  - two Sony devices cannot claim the same physical camera id.
 */
export function collectRigIssues(
  devices: Record<string, InventoryDevice>,
  profiles: Record<string, Profile>,
): { message: string; path: (string | number)[] }[] {
  const issues: { message: string; path: (string | number)[] }[] = [];
  const claimed = new Map<string, string>();
  for (const [key, device] of Object.entries(devices)) {
    if (device.protocol !== 'sony' || !device.sonyCameraId) continue;
    const id = device.sonyCameraId.toUpperCase();
    const other = claimed.get(id);
    if (other) {
      issues.push({ message: `Sony devices "${other}" and "${key}" both use camera id ${device.sonyCameraId}`, path: ['devices', key, 'sonyCameraId'] });
    } else {
      claimed.set(id, key);
    }
  }
  for (const [name, profile] of Object.entries(profiles)) {
    const used = new Map<string, number>();
    profile.slots.forEach((slot, i) => {
      const where = ['profiles', name, 'slots', i] as (string | number)[];
      const controller = devices[slot.device];
      if (controller?.protocol === 'sony') {
        issues.push({ message: `profile "${name}" rig ${i + 1}: "${slot.device}" is a Sony camera, not a controller`, path: [...where, 'device'] });
      }
      if (slot.camera === undefined) return;
      const camera = devices[slot.camera];
      if (!camera) {
        issues.push({ message: `profile "${name}" rig ${i + 1}: camera "${slot.camera}" is not in the device inventory`, path: [...where, 'camera'] });
      } else if (camera.protocol !== 'sony') {
        issues.push({ message: `profile "${name}" rig ${i + 1}: camera "${slot.camera}" is not a Sony camera device`, path: [...where, 'camera'] });
      }
      if (controller?.cameraType === 'birddog') {
        issues.push({ message: `profile "${name}" rig ${i + 1}: "${slot.device}" is a BirdDog with a built-in camera and takes no Sony camera`, path: [...where, 'camera'] });
      }
      const previous = used.get(slot.camera);
      if (previous !== undefined) {
        issues.push({ message: `profile "${name}": camera "${slot.camera}" is on both rig ${previous + 1} and rig ${i + 1}`, path: [...where, 'camera'] });
      } else {
        used.set(slot.camera, i);
      }
    });
  }
  return issues;
}

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
  sony: SonySchema.optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.profiles && cfg.devices) {
    for (const issue of collectRigIssues(cfg.devices, cfg.profiles)) ctx.addIssue({ code: 'custom', ...issue });
  }
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

/** Runtime-only Sony settings; approval data stays in its separate state file. */
export interface SonyRuntimeConfig {
  enabled: boolean;
  apiUrl: string;
  executable?: string;
  stateFile: string;
}

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
  sony?: SonyRuntimeConfig;
}

function parseSonyEnabled(value: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('SONY_ENABLED must be true, false, 1, or 0');
}

function resolveSonyConfig(raw: z.infer<typeof SonySchema> | undefined, devicesPath: string): SonyRuntimeConfig {
  const yaml = SonySchema.parse(raw ?? {});
  const enabled = process.env.SONY_ENABLED === undefined ? yaml.enabled : parseSonyEnabled(process.env.SONY_ENABLED);
  const apiUrl = process.env.SONY_API_URL ?? yaml.apiUrl;
  const executable = process.env.SONY_SERVER_EXECUTABLE ?? yaml.executable;
  if (executable !== undefined && !path.isAbsolute(executable)) {
    throw new Error('Sony executable must be an absolute path');
  }
  const stateFile = process.env.SONY_STATE_FILE ?? yaml.stateFile ?? 'sony-cameras.json';
  return {
    enabled,
    apiUrl,
    executable,
    stateFile: path.isAbsolute(stateFile) ? stateFile : path.resolve(path.dirname(devicesPath), stateFile),
  };
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
    if (dev.protocol === 'sony') throw new Error(`device "${slot.device}" in profile slot ${i + 1} is a Sony camera, not a controller`);
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
      camera: slot.camera,
    });
  });
}

export function loadConfig(): AppConfig {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');

  const devicesRaw = YAML.parse(fs.readFileSync(devicesPath, 'utf8'));
  const devices = DevicesSchema.parse(devicesRaw);

  // Normalize graphics: support legacy lowerThirds key
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );

  const speedsRaw = JSON.parse(fs.readFileSync(speedsPath, 'utf8'));
  const speeds = SpeedPresetsSchema.parse(speedsRaw);

  let mappings: MappingConfig;
  try {
    const mappingsRaw = YAML.parse(fs.readFileSync(mappingsPath, 'utf8')) ?? {};
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
    sony: resolveSonyConfig(devices.sony, devicesPath),
  };
}

/**
 * One camera slot as a client sent it — only the fields that client actually
 * carried. Kept alongside the validated cameras so the writer can tell
 * "change this to X" (key present) from "leave this alone" (key absent).
 */
export type CameraPatch = Record<string, unknown>;

export interface ValidatedDevicesConfig extends Pick<AppConfig, 'atem' | 'cameras' | 'graphics'> {
  /** Raw per-slot payloads, index-aligned with `cameras`. Absent for whole-file payloads. */
  cameraPatches?: CameraPatch[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Take the validated values, but only for the keys the client actually sent.
 * Keeps schema defaults for fields nobody edited out of the hand-written file.
 */
function carriedKeys(validated: Record<string, unknown>, sent: unknown): Record<string, unknown> {
  if (!isPlainObject(sent)) return { ...validated };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(validated)) {
    if (Object.prototype.hasOwnProperty.call(sent, key) && sent[key] !== undefined) out[key] = validated[key];
  }
  return out;
}

/** Copy of `obj` without keys whose value is undefined (null is kept: it means "clear"). */
function definedEntries(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Fill in what a camera-slot payload did not say, from the inventory device that
 * currently fills that slot.
 *
 * The Device Config tab edits the *resolved* camera list, so its payload is a
 * flat list of slots with no notion of `protocol` or `bridge`. Before this, an
 * omitted `protocol` fell through to the schema default `visca`, which turned
 * every DJI gimbal into a VISCA camera on save (issue #18). Hydrating from the
 * inventory first means an omitted field keeps the device's current value, and
 * only fields the client actually sent can change anything.
 */
function hydrateCameraPatches(patches: CameraPatch[]): Record<string, unknown>[] {
  const existing = readDevicesYaml();
  const inventory = existing.devices as Record<string, Record<string, unknown>> | undefined;
  const profiles = existing.profiles as Record<string, { slots?: { device?: string; inputId?: number }[] }> | undefined;
  const activeProfile = existing.activeProfile as string | undefined;
  const slots = (activeProfile && profiles?.[activeProfile]?.slots) || [];

  return patches.map((patch, i) => {
    const sent = definedEntries(isPlainObject(patch) ? patch : {});
    const slot = slots[i];
    const device = slot?.device ? inventory?.[slot.device] : undefined;
    if (!device) return { id: `cam${i + 1}`, ...sent };
    // A partial bridge (the UI sends host + port) must not wipe the fields it
    // does not render, e.g. gimbalModel / safetyTimeoutMs / rollEnabled.
    if (isPlainObject(sent.bridge) && isPlainObject(device.bridge)) {
      sent.bridge = { ...device.bridge, ...definedEntries(sent.bridge) };
    }
    return { id: `cam${i + 1}`, inputId: slot.inputId, ...device, ...sent };
  });
}

export function validateDevicesConfig(raw: unknown): ValidatedDevicesConfig {
  const body = isPlainObject(raw) ? raw : {};
  const sentCameras = Array.isArray(body.cameras) ? (body.cameras as CameraPatch[]) : undefined;
  // A whole-file payload carries its own profiles; per-slot patches only make
  // sense for the flat camera list the Device Config tab sends.
  const isSlotPayload = !!sentCameras && !body.profiles;

  const devices = DevicesSchema.parse(
    isSlotPayload ? { ...body, cameras: hydrateCameraPatches(sentCameras!) } : body
  );
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );
  const cameras = devices.profiles && devices.activeProfile
    ? resolveProfile(devices.devices ?? {}, devices.profiles[devices.activeProfile])
    : devices.cameras ?? [];
  return {
    atem: devices.atem,
    cameras,
    graphics,
    cameraPatches: isSlotPayload ? sentCameras : undefined,
  };
}

/** A save was based on a version of devices.yaml that is no longer on disk (edited by hand, or by another save). */
export class ConfigConflictError extends Error {
  constructor() {
    super('devices.yaml changed on disk since this page loaded it; reload and try again');
    this.name = 'ConfigConflictError';
  }
}

/**
 * Replace `target` with `content` so a crash or power loss can never leave a
 * half-written file: write a temp file in the same directory, flush it to disk,
 * then rename over the target (an atomic replace on the same filesystem). The
 * original file's permissions are kept. `rename` is injectable so a test can
 * prove the old content survives a failure at the last step.
 */
export function writeFileAtomic(
  target: string,
  content: string,
  io: { rename?: (from: string, to: string) => void } = {},
): void {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let mode = 0o644;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: default mode */ }
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    (io.rename ?? fs.renameSync)(temp, target);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(temp); } catch { /* temp never created or already gone */ }
    throw error;
  }
}

/**
 * Short fingerprint of devices.yaml as it is on disk right now. Read endpoints
 * hand it to the page; a save that sends it back is refused when the file has
 * changed in between (hand edit, another save, a profile switch).
 */
export function devicesFileVersion(): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(devicesConfigPath())).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

function devicesConfigPath(): string {
  return process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
}

/** The parsed devices.yaml as it is on disk now (empty object when missing or unreadable). */
export function readDevicesFile(): Record<string, unknown> {
  return readDevicesYaml();
}

function readDevicesYaml(): Record<string, unknown> {
  try {
    return (YAML.parse(fs.readFileSync(devicesConfigPath(), 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Merge `value` into the YAML document at `path`, touching as few nodes as
 * possible: unchanged scalars are left exactly as written, and maps/sequences
 * are walked key-by-key instead of being replaced.
 *
 * That is what preserves comments. In the `yaml` document model a comment
 * belongs to a node (`commentBefore` on the key of a map entry, `comment` for a
 * trailing one), so anything that survives the merge keeps its documentation.
 */
function applyToDocument(doc: YAML.Document, nodePath: (string | number)[], value: unknown): void {
  const node: unknown = nodePath.length === 0 ? doc.contents : doc.getIn(nodePath, true);

  if (value === undefined) {
    if (nodePath.length) doc.deleteIn(nodePath);
    return;
  }

  if (isPlainObject(value) && YAML.isMap(node)) {
    for (const [key, child] of Object.entries(value)) applyToDocument(doc, [...nodePath, key], child);
    const keys = node.items.map((item) => (YAML.isScalar(item.key) ? String(item.key.value) : String(item.key)));
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) doc.deleteIn([...nodePath, key]);
    }
    return;
  }

  if (Array.isArray(value) && YAML.isSeq(node)) {
    for (let i = 0; i < value.length; i++) applyToDocument(doc, [...nodePath, i], value[i]);
    // Trim surplus entries from the end so the surviving indices keep their nodes.
    for (let i = node.items.length - 1; i >= value.length; i--) doc.deleteIn([...nodePath, i]);
    return;
  }

  if (YAML.isScalar(node) && node.value === value) return; // unchanged: leave the node alone
  if (nodePath.length === 0) return; // root shape change is handled by the caller
  doc.setIn(nodePath, stripUndefined(value));
}

/** Deep copy with undefined-valued keys removed, so they are not emitted as null. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

/**
 * Write devices.yaml by merging into the file's existing YAML document rather
 * than re-serializing it from scratch.
 *
 * devices.yaml is the main hand-edited config, and its comments carry things
 * the data cannot say: the slot-to-hotkey mapping (1=X, 2=A, 3=B, 4=Y), why the
 * gimbals share one Pi on three ports, and why a slot deliberately has no
 * inputId. A dump()-style write erases all of that on the first UI save
 * (issue #14), because comments are not part of the parsed value at all.
 */
/** Write devices.yaml through the comment-preserving merge; refuses with ConfigConflictError if `expectedVersion` is stale. */
export function writeDevicesFile(data: Record<string, unknown>, expectedVersion?: string): void {
  writeDevicesYaml(data, expectedVersion);
}

function writeDevicesYaml(data: Record<string, unknown>, expectedVersion?: string): void {
  const devicesPath = devicesConfigPath();
  // Checked here, right before the merge re-reads the file, so nothing can slip in between.
  if (expectedVersion !== undefined && expectedVersion !== devicesFileVersion()) throw new ConfigConflictError();
  let doc: YAML.Document | null = null;
  try {
    doc = YAML.parseDocument(fs.readFileSync(devicesPath, 'utf8'));
  } catch {
    doc = null;
  }
  // No parsable mapping to merge into (missing or empty file): nothing to preserve.
  if (!doc || !YAML.isMap(doc.contents)) {
    writeFileAtomic(devicesPath, YAML.stringify(stripUndefined(data), { lineWidth: 120 }));
    return;
  }
  applyToDocument(doc, [], data);
  writeFileAtomic(devicesPath, doc.toString({ lineWidth: 120 }));
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
export function saveProfiles(profiles: Record<string, Profile>, expectedVersion?: string): void {
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
  const rigIssues = collectRigIssues(inventory as Record<string, InventoryDevice>, profiles);
  if (rigIssues.length) throw new Error(rigIssues[0].message);
  existing.profiles = profiles;
  // If the active profile was deleted, fall back to one that still exists so the
  // next load doesn't fail validation.
  const active = existing.activeProfile as string | undefined;
  if (active && !profiles[active]) existing.activeProfile = Object.keys(profiles)[0];
  writeDevicesYaml(existing, expectedVersion);
}

export function saveDevicesConfig(config: ValidatedDevicesConfig, expectedVersion?: string): void {
  // Merge into the existing file rather than replacing it. `cameras` is derived
  // from the active profile, so a blind write of {atem, cameras, graphics} would
  // delete the whole `devices:` inventory and every profile.
  const existing = readDevicesYaml();

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

      // Write back only the fields the client actually sent. A client with no
      // concept of protocol/bridge (the Device Config tab) must not be able to
      // convert a DJI gimbal into a VISCA camera by omission — that is what
      // made one Save destroy all three gimbals (issue #18). No patch list
      // means the caller vouches for the whole camera.
      const patch = config.cameraPatches?.[i];
      const carries = (key: string): boolean =>
        !patch || (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined);

      if (carries('label')) dev.label = cam.label;
      if (carries('protocol')) dev.protocol = cam.protocol;
      if (carries('cameraType')) dev.cameraType = cam.cameraType;
      if (carries('cameraAddress')) dev.cameraAddress = cam.cameraAddress;
      if (carries('speedScale')) dev.speedScale = cam.speedScale;
      if (carries('viscaIp') && cam.viscaIp !== undefined) dev.viscaIp = cam.viscaIp;
      if (carries('viscaPort')) dev.viscaPort = cam.viscaPort;
      // Same rule one level down, so a form that shows only host and port does
      // not bury the file in schema defaults for the fields it never rendered.
      if (carries('bridge') && cam.bridge !== undefined) {
        const current = isPlainObject(dev.bridge) ? dev.bridge : {};
        dev.bridge = { ...current, ...carriedKeys(cam.bridge as unknown as Record<string, unknown>, patch?.bridge) };
      }

      // Wiring lives on the slot, not the device. Blank/null means "not wired to
      // the switcher": the key must be absent, never defaulted to an input, or
      // an unwired camera would silently become takeable to air.
      if (cam.inputId === undefined) delete slot.inputId;
      else slot.inputId = cam.inputId;
    });
    out.devices = inventory;
    out.profiles = profiles;
    delete out.cameras; // stays derived; keeping a stale copy would be misleading
  } else {
    out.cameras = config.cameras;
  }

  writeDevicesYaml(out, expectedVersion);
}

export function saveMappings(mappings: MappingConfig): void {
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');
  const header = '# Controller button mappings - managed by FPS CamControl UI\n';
  writeFileAtomic(mappingsPath, header + YAML.stringify(mappings));
}
