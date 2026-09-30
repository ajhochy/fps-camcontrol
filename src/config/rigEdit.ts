import { z } from 'zod';
import { validateDevicesConfig } from './configLoader';

/**
 * Edits to rigs and Sony camera devices, as pure functions over the parsed
 * devices.yaml (docs/ai/plans/2026-09-30-device-config-rigs-ui.md, issues #4/#5).
 *
 * Nothing here reads or writes a file: each function takes the parsed config,
 * returns an edited copy, and refuses (RigEditError) before returning anything
 * that would not pass the same validation the file gets when it is loaded.
 * The caller writes the result through the comment-preserving writer, so a rig
 * edit can never erase a comment or change a device's protocol (issues #14, #18).
 *
 * Interim (until issue 9a): slot-level fields (`inputId`, `camera`) are written
 * straight into the active profile. Issue 9a redirects them into the working copy.
 */

type Raw = Record<string, any>;

export class RigEditError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'RigEditError';
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new RigEditError(message); };

const DEVICE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

function expectKeys(body: Raw, allowed: string[], what: string): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`${what}: "${key}" cannot be changed here`);
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return value as number;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') return fail(`${name} must be text`);
  const trimmed = (value as string).trim();
  if (!trimmed || trimmed.length > max) fail(`${name} must be 1 to ${max} characters`);
  return trimmed;
}

/** Turn whatever validation threw into one readable message. */
function readable(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => (issue.path.length && !issue.message.includes(String(issue.path[issue.path.length - 1])) ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** The edited config must be one the app would accept on load. */
function validated(next: Raw): Raw {
  try { validateDevicesConfig(next); } catch (error) { throw new RigEditError(readable(error)); }
  return next;
}

function setVisca(device: Raw, v: unknown): void {
  if (!isObject(v)) return fail('visca must be an object');
  expectKeys(v, ['host', 'port', 'address'], 'visca');
  if ('host' in v) device.viscaIp = text(v.host, 'camera address (IP)', 253);
  if ('port' in v) device.viscaPort = integer(v.port, 'port', 1, 65535);
  if ('address' in v) device.cameraAddress = integer(v.address, 'VISCA address', 0, 7);
}

function setGimbal(device: Raw, g: unknown): void {
  if (!isObject(g)) return fail('gimbal must be an object');
  expectKeys(g, ['host', 'port', 'gimbalModel', 'safetyTimeoutMs', 'rollEnabled', 'reconnectBackoffMs'], 'gimbal');
  const bridge: Raw = isObject(device.bridge) ? device.bridge : {};
  if ('host' in g) bridge.host = text(g.host, 'bridge host', 253);
  if ('port' in g) bridge.port = integer(g.port, 'port', 1, 65535);
  if ('gimbalModel' in g) { if (g.gimbalModel === null) delete bridge.gimbalModel; else bridge.gimbalModel = text(g.gimbalModel, 'gimbal model', 32); }
  if ('safetyTimeoutMs' in g) bridge.safetyTimeoutMs = integer(g.safetyTimeoutMs, 'safety stop timeout (ms)', 50, 2000);
  if ('rollEnabled' in g) { if (typeof g.rollEnabled !== 'boolean') fail('roll must be on or off'); bridge.rollEnabled = g.rollEnabled; }
  if ('reconnectBackoffMs' in g) {
    const b = g.reconnectBackoffMs;
    if (!Array.isArray(b) || b.length < 1 || b.length > 10 || b.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > 120000)) {
      fail('reconnect back-off must be 1 to 10 whole numbers of milliseconds, each 100 to 120000');
    }
    bridge.reconnectBackoffMs = b;
  }
  device.bridge = bridge;
}

export interface RigPatch {
  /** Hardware record, shared by every profile. */
  label?: string;
  speedScale?: number;
  visca?: { host?: string; port?: number; address?: number };
  gimbal?: { host?: string; port?: number; gimbalModel?: string | null; safetyTimeoutMs?: number; rollEnabled?: boolean; reconnectBackoffMs?: number[] };
  /** Wiring in the active profile: ATEM input (null = control-only) and the Sony camera device on this rig (null = none). */
  inputId?: number | null;
  camera?: string | null;
  /** 1-based rig position; only needed when the same device fills more than one rig. */
  position?: number;
}

export function applyRigPatch(current: Raw, deviceKey: string, patch: unknown): Raw {
  const raw = clone(current);
  const device = raw.devices?.[deviceKey];
  if (!isObject(device)) throw new RigEditError(`unknown device "${deviceKey}"`, 404);
  if (device.protocol === 'sony') fail('Sony cameras are edited with the Sony camera routes, not as rigs');
  if (!isObject(patch)) return fail('the change must be an object');
  expectKeys(patch, ['label', 'speedScale', 'visca', 'gimbal', 'inputId', 'camera', 'position'], 'rig');

  // ---- hardware record (shared by every profile)
  if ('label' in patch) device.label = text(patch.label, 'name', 64);
  if ('speedScale' in patch) {
    if (typeof patch.speedScale !== 'number' || !(patch.speedScale >= 0.1 && patch.speedScale <= 5)) fail('speed multiplier must be a number from 0.1 to 5');
    device.speedScale = patch.speedScale;
  }
  if ('visca' in patch) {
    if ((device.protocol ?? 'visca') !== 'visca') fail(`"${deviceKey}" is not a VISCA camera, so it has no VISCA connection settings`);
    setVisca(device, patch.visca);
  }
  if ('gimbal' in patch) {
    if (device.protocol !== 'dji-bridge') fail(`"${deviceKey}" is not a gimbal, so it has no bridge settings`);
    setGimbal(device, patch.gimbal);
  }

  // ---- wiring in the active profile
  if ('inputId' in patch || 'camera' in patch) {
    const active: string | undefined = raw.activeProfile;
    const slots: Raw[] | undefined = active ? raw.profiles?.[active]?.slots : undefined;
    if (!active || !Array.isArray(slots)) return fail('this config has no active profile, so wiring cannot be edited');
    const matches = slots.map((slot, i) => (slot.device === deviceKey ? i : -1)).filter((i) => i >= 0);
    if (!matches.length) fail(`"${deviceKey}" is not a rig in the active profile "${active}"`);
    let index = matches[0];
    if (matches.length > 1) {
      if (!('position' in patch)) fail(`"${deviceKey}" fills more than one rig; say which with position`);
      index = integer(patch.position, 'position', 1, slots.length) - 1;
      if (slots[index]?.device !== deviceKey) fail(`rig ${index + 1} is not "${deviceKey}"`);
    }
    const slot = slots[index];
    if ('inputId' in patch) {
      if (patch.inputId === null) delete slot.inputId;
      else {
        slot.inputId = integer(patch.inputId, 'ATEM input', 1, 99);
        const clash = slots.findIndex((other, i) => i !== index && other.inputId === slot.inputId);
        if (clash >= 0) fail(`ATEM input ${slot.inputId} is already used by rig ${clash + 1}`);
      }
    }
    if ('camera' in patch) {
      if (patch.camera === null) delete slot.camera;
      else slot.camera = text(patch.camera, 'camera', 64);
    }
  }
  return validated(raw);
}

// ------------------------------------------------------------ Sony devices

function slug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `sony-${base || 'camera'}`;
}

function cameraId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:-]{1,128}$/.test(value)) fail('camera id must look like 9C:50:D1:AC:7B:72');
  return (value as string).toUpperCase();
}

/** Add a Sony camera device. The key is made from the name and is unique. Returns the edited config and the key. */
export function createSonyDevice(current: Raw, input: unknown): { raw: Raw; key: string } {
  const raw = clone(current);
  if (!isObject(input)) return fail('the new camera must be an object');
  expectKeys(input, ['label', 'sonyCameraId'], 'camera');
  if (input.label === undefined) fail('a name is required');
  const label = text(input.label, 'name', 64);
  raw.devices = isObject(raw.devices) ? raw.devices : {};
  let key = slug(label);
  for (let n = 2; raw.devices[key]; n++) key = `${slug(label)}-${n}`;
  if (!DEVICE_KEY.test(key)) fail('could not make a key from that name');
  const device: Raw = { label, protocol: 'sony' };
  if (input.sonyCameraId !== undefined && input.sonyCameraId !== null) device.sonyCameraId = cameraId(input.sonyCameraId);
  raw.devices[key] = device;
  return { raw: validated(raw), key };
}

/** Rename a Sony camera device, or bind it to a physical camera (or unbind with null). */
export function patchSonyDevice(current: Raw, key: string, patch: unknown): Raw {
  const raw = clone(current);
  const device = raw.devices?.[key];
  if (!isObject(device) || device.protocol !== 'sony') throw new RigEditError(`unknown Sony camera "${key}"`, 404);
  if (!isObject(patch)) return fail('the change must be an object');
  expectKeys(patch, ['label', 'sonyCameraId'], 'camera');
  if ('label' in patch) device.label = text(patch.label, 'name', 64);
  if ('sonyCameraId' in patch) {
    if (patch.sonyCameraId === null) delete device.sonyCameraId;
    else device.sonyCameraId = cameraId(patch.sonyCameraId);
  }
  return validated(raw);
}

/** Remove a Sony camera device, unless a rig in any profile still uses it. */
export function deleteSonyDevice(current: Raw, key: string): Raw {
  const raw = clone(current);
  const device = raw.devices?.[key];
  if (!isObject(device) || device.protocol !== 'sony') throw new RigEditError(`unknown Sony camera "${key}"`, 404);
  const users: string[] = [];
  for (const [name, profile] of Object.entries<Raw>(raw.profiles ?? {})) {
    (profile.slots ?? []).forEach((slot: Raw, i: number) => { if (slot.camera === key) users.push(`${name} rig ${i + 1}`); });
  }
  if (users.length) throw new RigEditError(`"${device.label}" is still used by ${users.join(', ')}; take it off those rigs first`, 409);
  delete raw.devices[key];
  return validated(raw);
}

// ------------------------------------------------------------ add / remove rigs

function deviceSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rig';
}

function activeSlots(raw: Raw): { active: string; slots: Raw[] } {
  const active: string | undefined = raw.activeProfile;
  const slots: Raw[] | undefined = active ? raw.profiles?.[active]?.slots : undefined;
  if (!active || !Array.isArray(slots)) return fail('this config has no active profile, so rigs cannot be added or removed');
  return { active, slots };
}

/**
 * Add a rig to the end of the active profile (so no existing rig changes position). Either put an existing
 * controller from the inventory on a new rig (`deviceKey`), or describe new hardware (`label`, `controller`
 * and its connection). Returns the edited config, the device key and the new rig's 1-based position.
 */
export function createRig(current: Raw, input: unknown): { raw: Raw; key: string; position: number } {
  const raw = clone(current);
  if (!isObject(input)) return fail('the new rig must be an object');
  expectKeys(input, ['deviceKey', 'label', 'controller', 'visca', 'gimbal', 'speedScale', 'inputId', 'camera'], 'rig');
  const { slots } = activeSlots(raw);
  raw.devices = isObject(raw.devices) ? raw.devices : {};

  let key: string;
  if ('deviceKey' in input) {
    for (const field of ['label', 'controller', 'visca', 'gimbal', 'speedScale']) {
      if (field in input) fail(`an existing device is added as it is; "${field}" can be changed afterwards`);
    }
    key = text(input.deviceKey, 'device', 64);
    const existing = raw.devices[key];
    if (!isObject(existing)) throw new RigEditError(`unknown device "${key}"`, 404);
    if (existing.protocol === 'sony') fail('a Sony camera is not a controller; add it to a rig as its camera');
    if (slots.some((slot) => slot.device === key)) fail(`"${key}" is already a rig in the active profile`);
  } else {
    const controller = input.controller;
    if (!['vbot', 'birddog', 'gimbal', 'generic'].includes(controller as string)) fail('controller must be vbot, birddog, gimbal or generic');
    const label = text(input.label, 'name', 64);
    const device: Raw = { label };
    if (controller === 'gimbal') {
      if (!isObject(input.gimbal) || !('host' in input.gimbal)) fail('a gimbal needs its bridge host');
      device.protocol = 'dji-bridge';
      setGimbal(device, { port: 7878, ...(input.gimbal as Raw) });
      if ('visca' in input) fail('a gimbal has no VISCA settings');
    } else {
      if (!isObject(input.visca) || !('host' in input.visca)) fail('a camera needs its IP address');
      device.protocol = 'visca';
      device.cameraType = controller;
      setVisca(device, { port: 52381, address: 1, ...(input.visca as Raw) });
      if ('gimbal' in input) fail('only a gimbal has bridge settings');
    }
    if ('speedScale' in input) {
      if (typeof input.speedScale !== 'number' || !(input.speedScale >= 0.1 && input.speedScale <= 5)) fail('speed multiplier must be a number from 0.1 to 5');
      device.speedScale = input.speedScale;
    }
    key = deviceSlug(label);
    for (let n = 2; raw.devices[key]; n++) key = `${deviceSlug(label)}-${n}`;
    if (!DEVICE_KEY.test(key)) fail('could not make a key from that name');
    raw.devices[key] = device;
  }

  const slot: Raw = { device: key };
  if ('inputId' in input && input.inputId !== null) {
    slot.inputId = integer(input.inputId, 'ATEM input', 1, 99);
    const clash = slots.findIndex((other) => other.inputId === slot.inputId);
    if (clash >= 0) fail(`ATEM input ${slot.inputId} is already used by rig ${clash + 1}`);
  }
  if ('camera' in input && input.camera !== null) slot.camera = text(input.camera, 'camera', 64);
  slots.push(slot);
  return { raw: validated(raw), key, position: slots.length };
}

export interface RigRemoval { raw: Raw; position: number; deviceRemoved: boolean }

/** Which 1-based rig position `deviceKey` fills in the active profile (`position` picks one when it fills several). */
export function rigPositionOf(current: Raw, deviceKey: string, position?: unknown): number {
  const { active, slots } = activeSlots(current);
  const matches = slots.map((slot, i) => (slot.device === deviceKey ? i : -1)).filter((i) => i >= 0);
  if (!matches.length) throw new RigEditError(`"${deviceKey}" is not a rig in the active profile "${active}"`, 404);
  if (matches.length === 1) return matches[0] + 1;
  if (position === undefined) return fail(`"${deviceKey}" fills more than one rig; say which with position`);
  const index = integer(position, 'position', 1, slots.length) - 1;
  if (slots[index]?.device !== deviceKey) fail(`rig ${index + 1} is not "${deviceKey}"`);
  return index + 1;
}

/**
 * Remove a rig from the active profile. Later rigs move up one position (and so change id and hotkey); the caller
 * is responsible for shifting their presets. The hardware entry stays in the inventory unless `deleteDevice` is
 * set, which is refused while any other rig in any profile still uses it.
 */
export function removeRig(current: Raw, deviceKey: string, options: { position?: unknown; deleteDevice?: boolean } = {}): RigRemoval {
  const raw = clone(current);
  const position = rigPositionOf(raw, deviceKey, options.position);
  const { slots } = activeSlots(raw);
  if (slots.length <= 1) fail('a profile needs at least one rig');
  slots.splice(position - 1, 1);
  let deviceRemoved = false;
  if (options.deleteDevice) {
    const users: string[] = [];
    for (const [name, profile] of Object.entries<Raw>(raw.profiles ?? {})) {
      (profile.slots ?? []).forEach((slot: Raw, i: number) => { if (slot.device === deviceKey) users.push(`${name} rig ${i + 1}`); });
    }
    if (users.length) throw new RigEditError(`"${deviceKey}" is still used by ${users.join(', ')}; it was not deleted`, 409);
    delete raw.devices[deviceKey];
    deviceRemoved = true;
  }
  return { raw: validated(raw), position, deviceRemoved };
}

// ------------------------------------------------------------------- ATEM

/** Edit the ATEM connection (address, default transition, mix/effect) and the graphics keyer settings. */
export function applyAtemPatch(current: Raw, patch: unknown): Raw {
  const raw = clone(current);
  if (!isObject(patch)) return fail('the change must be an object');
  expectKeys(patch, ['ip', 'defaultTransition', 'meIndex', 'graphics'], 'ATEM');
  raw.atem = isObject(raw.atem) ? raw.atem : {};
  if ('ip' in patch) raw.atem.ip = text(patch.ip, 'ATEM address (IP)', 253);
  if ('defaultTransition' in patch) {
    if (patch.defaultTransition !== 'cut' && patch.defaultTransition !== 'auto') fail('default transition must be cut or auto');
    raw.atem.defaultTransition = patch.defaultTransition;
  }
  if ('meIndex' in patch) raw.atem.meIndex = integer(patch.meIndex, 'mix/effect index', 0, 3);
  if ('graphics' in patch) {
    const g = patch.graphics;
    if (!isObject(g)) return fail('graphics must be an object');
    expectKeys(g, ['type', 'dskIndex', 'uskIndex', 'meIndex', 'fadeFrames'], 'graphics');
    raw.graphics = isObject(raw.graphics) ? raw.graphics : {};
    if ('type' in g) {
      if (!['dsk', 'usk', 'auto'].includes(g.type as string)) fail('graphics keyer must be dsk, usk or auto');
      raw.graphics.type = g.type;
    }
    if ('dskIndex' in g) raw.graphics.dskIndex = integer(g.dskIndex, 'DSK index', 0, 3);
    if ('uskIndex' in g) raw.graphics.uskIndex = integer(g.uskIndex, 'USK index', 0, 3);
    if ('meIndex' in g) raw.graphics.meIndex = integer(g.meIndex, 'graphics mix/effect index', 0, 3);
    if ('fadeFrames' in g) raw.graphics.fadeFrames = integer(g.fadeFrames, 'key fade (frames)', 0, 250);
  }
  return validated(raw);
}

// ---------------------------------------------------------------- profiles

/** Validate a whole edited config the way the loader would; used by callers that assemble a config themselves. */
export function validateWhole(next: Raw): Raw {
  return validated(next);
}

function profileSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'profile';
}

/** Write `slots` into the active profile (Save). */
export function applySaveProfile(current: Raw, slots: Raw[]): Raw {
  const raw = clone(current);
  const active: string | undefined = raw.activeProfile;
  if (!active || !isObject(raw.profiles?.[active])) return fail('this config has no active profile to save into');
  raw.profiles[active].slots = clone(slots);
  return validated(raw);
}

/** Save `slots` as a new profile named `label`, and make it the active one. The profile you started from is left as it was. */
export function applySaveProfileAs(current: Raw, label: unknown, slots: Raw[]): { raw: Raw; key: string } {
  const raw = clone(current);
  const name = text(label, 'profile name', 64);
  if (!isObject(raw.profiles)) return fail('this config has no profiles to add to');
  const taken = Object.values<Raw>(raw.profiles).some((profile) => typeof profile.label === 'string' && profile.label.toLowerCase() === name.toLowerCase());
  if (taken) fail(`a profile named "${name}" already exists`);
  let key = profileSlug(name);
  for (let n = 2; raw.profiles[key]; n++) key = `${profileSlug(name)}-${n}`;
  raw.profiles[key] = { label: name, slots: clone(slots) };
  raw.activeProfile = key;
  return { raw: validated(raw), key };
}

/** Change a profile's display name. */
export function renameProfile(current: Raw, key: string, label: unknown): Raw {
  const raw = clone(current);
  if (!isObject(raw.profiles?.[key])) throw new RigEditError(`unknown profile "${key}"`, 404);
  const name = text(label, 'profile name', 64);
  const taken = Object.entries<Raw>(raw.profiles).some(([other, profile]) => other !== key && typeof profile.label === 'string' && profile.label.toLowerCase() === name.toLowerCase());
  if (taken) fail(`a profile named "${name}" already exists`);
  raw.profiles[key].label = name;
  return validated(raw);
}

/** Delete a profile. The active profile and the last profile cannot be deleted. */
export function deleteProfile(current: Raw, key: string): Raw {
  const raw = clone(current);
  if (!isObject(raw.profiles?.[key])) throw new RigEditError(`unknown profile "${key}"`, 404);
  if (raw.activeProfile === key) throw new RigEditError('Switch to another profile before deleting the active one', 409);
  if (Object.keys(raw.profiles).length <= 1) throw new RigEditError('The last profile cannot be deleted', 409);
  delete raw.profiles[key];
  return validated(raw);
}
