import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomicWrite';

/**
 * The working copy of the active profile (docs/ai/plans/2026-09-30-device-config-rigs-ui.md, D10-D12).
 *
 * Rig wiring edits (which device fills a rig, its order, its Sony camera, its ATEM input) go into a working copy
 * that is applied to the running app at once and saved in `working-profile.json` so it survives a restart. The
 * profile in devices.yaml is not touched until the operator saves. Hardware details (names, addresses, Sony
 * devices) are not part of it: they are shared by every profile and saved immediately.
 *
 * Pure apart from the small file helpers; it does not import the config loader (the loader imports this).
 */

export interface WorkingSlot { device: string; inputId?: number; camera?: string }

export interface WorkingProfile {
  version: 1;
  /** Key of the profile these edits started from. */
  base: string;
  /** That profile's rigs when the edits began, to describe what changed and to notice outside edits. */
  baseSlots: WorkingSlot[];
  /** The rigs now. */
  slots: WorkingSlot[];
  /** Presets when the edits began, so Revert can put them back (presets are keyed by rig position). */
  presetsAtStart: Record<string, unknown> | null;
  startedAt: string;
  updatedAt: string;
}

export interface WorkingLoad {
  working: WorkingProfile | null;
  /** Something the operator should be told about (an unusable draft set aside, an outside edit). */
  notice: string | null;
}

type Known = { profiles: Record<string, { slots: WorkingSlot[] }>; devices: Record<string, { protocol?: string; cameraType?: string }> };

export function workingProfilePath(devicesConfigPath: string): string {
  return process.env.WORKING_PROFILE_FILE ?? path.join(path.dirname(devicesConfigPath), 'working-profile.json');
}

export function slotsEqual(a: WorkingSlot[], b: WorkingSlot[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((slot, i) => slot.device === b[i].device && (slot.inputId ?? null) === (b[i].inputId ?? null) && (slot.camera ?? null) === (b[i].camera ?? null));
}

const plainSlots = (slots: WorkingSlot[]): WorkingSlot[] => slots.map((slot) => {
  const out: WorkingSlot = { device: slot.device };
  if (slot.inputId !== undefined && slot.inputId !== null) out.inputId = slot.inputId;
  if (slot.camera !== undefined && slot.camera !== null) out.camera = slot.camera;
  return out;
});

function shapeOk(value: unknown): value is WorkingProfile {
  const w = value as Partial<WorkingProfile> | null;
  const slotOk = (slot: unknown): boolean => {
    const s = slot as Partial<WorkingSlot> | null;
    return !!s && typeof s === 'object' && typeof s.device === 'string'
      && (s.inputId === undefined || (typeof s.inputId === 'number' && Number.isInteger(s.inputId)))
      && (s.camera === undefined || typeof s.camera === 'string');
  };
  return !!w && typeof w === 'object' && w.version === 1 && typeof w.base === 'string'
    && Array.isArray(w.baseSlots) && w.baseSlots.every(slotOk)
    && Array.isArray(w.slots) && w.slots.length >= 1 && w.slots.length <= 8 && w.slots.every(slotOk)
    && typeof w.startedAt === 'string' && typeof w.updatedAt === 'string';
}

/** Move an unusable draft aside (never delete the operator's edits). Returns the new name. */
export function setAside(file: string, now: () => Date): string {
  const aside = `${file}.orphaned-${now().toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(file, aside); } catch { /* nothing to move */ }
  return path.basename(aside);
}

/**
 * Read the working copy, if there is one and it still makes sense. A draft whose profile or devices no
 * longer exist, or that is not valid JSON, is set aside as `working-profile.json.orphaned-<time>` and reported.
 */
export function loadWorkingProfile(file: string, known: Known, now: () => Date = () => new Date()): WorkingLoad {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { working: null, notice: null }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!shapeOk(parsed)) {
    const name = setAside(file, now);
    return { working: null, notice: `Unsaved rig changes could not be read, so they were kept aside as ${name}.` };
  }
  const base = known.profiles[parsed.base];
  if (!base) {
    const name = setAside(file, now);
    return { working: null, notice: `Unsaved rig changes could not be restored because the profile "${parsed.base}" no longer exists; they were kept aside as ${name}.` };
  }
  const missing = parsed.slots.find((slot) => {
    const controller = known.devices[slot.device];
    if (!controller || controller.protocol === 'sony') return true;
    if (slot.camera === undefined) return false;
    const camera = known.devices[slot.camera];
    return !camera || camera.protocol !== 'sony' || controller.cameraType === 'birddog';
  });
  if (missing) {
    const name = setAside(file, now);
    return { working: null, notice: `Unsaved rig changes could not be restored because a device they use ("${missing.device}"${missing.camera ? ` / "${missing.camera}"` : ''}) is gone or no longer fits; they were kept aside as ${name}.` };
  }
  const working: WorkingProfile = { ...parsed, baseSlots: plainSlots(parsed.baseSlots), slots: plainSlots(parsed.slots) };
  const now2 = plainSlots(base.slots);
  const outside = !slotsEqual(working.baseSlots, now2);
  return {
    working,
    notice: outside ? `The saved profile "${parsed.base}" was changed outside this screen since these edits began; saving will replace it.` : null,
  };
}

export function saveWorkingProfile(file: string, working: WorkingProfile): void {
  writeFileAtomic(file, `${JSON.stringify({ ...working, baseSlots: plainSlots(working.baseSlots), slots: plainSlots(working.slots) }, null, 2)}\n`);
}

export function clearWorkingProfile(file: string): void {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// ------------------------------------------------------------ what changed

export type WorkingChange =
  | { kind: 'added'; label: string; position: number }
  | { kind: 'removed'; label: string; position: number }
  | { kind: 'moved'; label: string; from: number; to: number }
  | { kind: 'input'; label: string; from: number | null; to: number | null }
  | { kind: 'camera'; label: string; from: string | null; to: string | null };

/** What differs between the saved rigs and the working rigs, matched by device (not by position). */
export function describeChanges(
  baseSlots: WorkingSlot[],
  slots: WorkingSlot[],
  devices: Record<string, { label?: string }>,
): WorkingChange[] {
  const name = (key: string): string => devices[key]?.label ?? key;
  const tag = (list: WorkingSlot[]): Map<string, { slot: WorkingSlot; position: number }> => {
    const seen = new Map<string, number>();
    const out = new Map<string, { slot: WorkingSlot; position: number }>();
    list.forEach((slot, i) => {
      const nth = (seen.get(slot.device) ?? 0) + 1;
      seen.set(slot.device, nth);
      out.set(`${slot.device}#${nth}`, { slot, position: i + 1 });
    });
    return out;
  };
  const before = tag(baseSlots);
  const after = tag(slots);
  const changes: WorkingChange[] = [];
  for (const [key, old] of before) {
    const label = name(old.slot.device);
    const now = after.get(key);
    if (!now) { changes.push({ kind: 'removed', label, position: old.position }); continue; }
    if (now.position !== old.position) changes.push({ kind: 'moved', label, from: old.position, to: now.position });
    if ((old.slot.inputId ?? null) !== (now.slot.inputId ?? null)) changes.push({ kind: 'input', label, from: old.slot.inputId ?? null, to: now.slot.inputId ?? null });
    if ((old.slot.camera ?? null) !== (now.slot.camera ?? null)) {
      changes.push({ kind: 'camera', label, from: old.slot.camera ? name(old.slot.camera) : null, to: now.slot.camera ? name(now.slot.camera) : null });
    }
  }
  for (const [key, now] of after) if (!before.has(key)) changes.push({ kind: 'added', label: name(now.slot.device), position: now.position });
  return changes;
}
