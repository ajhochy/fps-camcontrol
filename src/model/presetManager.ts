import fs from 'fs';
import { z } from 'zod';
import { AppState, CameraId, PresetSlot } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { MotionDevice, DevicePosition } from '../devices/motionDevice';
import { logger } from '../index';

const ViscaPositionSchema = z.object({
  kind: z.literal('visca'),
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
});

const GimbalPositionSchema = z.object({
  kind: z.literal('gimbal'),
  yaw: z.number(),
  pitch: z.number(),
  roll: z.number(),
  zoom: z.number().optional(),
});

const PositionSchema = z.union([ViscaPositionSchema, GimbalPositionSchema]).nullable();
const PresetsDataSchema = z.record(z.string(), z.record(z.string(), PositionSchema));

type PresetData = z.infer<typeof PresetsDataSchema>;

// Legacy preset slots had shape {pan,tilt,zoom} without a kind discriminator.
// Migrate them to {kind:'visca', ...} on first load.
function migrateLegacy(raw: unknown): PresetData {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: PresetData = {};
  for (const [camId, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof slots !== 'object' || slots === null) continue;
    out[camId] = {};
    for (const [slot, pos] of Object.entries(slots as Record<string, unknown>)) {
      if (pos === null || pos === undefined) {
        out[camId][slot] = null;
        continue;
      }
      if (typeof pos !== 'object') {
        out[camId][slot] = null;
        continue;
      }
      const p = pos as Record<string, unknown>;
      if (p.kind === 'visca' || p.kind === 'gimbal') {
        out[camId][slot] = p as unknown as z.infer<typeof PositionSchema>;
      } else if (typeof p.pan === 'number' && typeof p.tilt === 'number' && typeof p.zoom === 'number') {
        out[camId][slot] = { kind: 'visca', pan: p.pan, tilt: p.tilt, zoom: p.zoom };
      } else {
        out[camId][slot] = null;
      }
    }
  }
  return out;
}

export class PresetManager {
  private presetsFile: string;
  private data: PresetData;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private devices: Map<CameraId, MotionDevice>
  ) {
    this.presetsFile = process.env.PRESETS_FILE ?? 'config/presets.json';
    this.data = this.loadPresets();
  }

  private loadPresets(): PresetData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.presetsFile, 'utf8'));
      const migrated = migrateLegacy(raw);
      return PresetsDataSchema.parse(migrated);
    } catch {
      const empty: PresetData = {};
      for (const cam of this.config.cameras) {
        empty[cam.id] = { A: null, B: null, X: null, Y: null };
      }
      return empty;
    }
  }

  private savePresets(): void {
    fs.writeFileSync(this.presetsFile, JSON.stringify(this.data, null, 2));
  }

  async recallPreset(cameraId: CameraId, slot: PresetSlot): Promise<void> {
    const pos = this.data[cameraId]?.[slot];
    if (!pos) {
      logger.debug({ cameraId, slot }, 'preset slot empty, ignoring');
      return;
    }
    const device = this.devices.get(cameraId);
    if (!device) return;
    try {
      await device.moveTo(pos);
    } catch (err) {
      logger.error({ err, cameraId, slot }, 'preset recall error');
      return;
    }
    this.state.lastPresetNotification = `${cameraId} → ${slot}`;
    logger.info({ cameraId, slot }, 'preset recalled');
  }

  async savePreset(cameraId: CameraId, slot: PresetSlot): Promise<void> {
    const device = this.devices.get(cameraId);
    if (!device) throw new Error(`No motion device for camera ${cameraId}`);

    let pos: DevicePosition;
    try {
      pos = await device.getPosition();
    } catch (err) {
      const msg = 'Save failed — could not read camera position';
      this.state.lastPresetNotification = msg;
      logger.error({ err, cameraId, slot }, msg);
      throw new Error(msg);
    }

    if (!this.data[cameraId]) this.data[cameraId] = { A: null, B: null, X: null, Y: null };
    this.data[cameraId][slot] = pos;
    this.savePresets();
    this.state.lastPresetNotification = `Saved ${cameraId} → ${slot}`;
    logger.info({ cameraId, slot, pos }, 'preset saved');
  }

  clearPreset(cameraId: CameraId, slot: PresetSlot): void {
    if (this.data[cameraId]) {
      this.data[cameraId][slot] = null;
      this.savePresets();
      logger.info({ cameraId, slot }, 'preset cleared');
    }
  }

  getData(): PresetData {
    return this.data;
  }
}
