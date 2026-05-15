import fs from 'fs';
import { z } from 'zod';
import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { ViscaClient } from '../visca/viscaClient';
import { gotoAbsolutePosition, PTZPosition, inquirePanTilt, inquireZoom } from '../visca/ptzActions';
import { logger } from '../index';

const PTZPositionSchema = z.object({
  pan: z.number(),
  tilt: z.number(),
  zoom: z.number(),
}).nullable();

const PresetsDataSchema = z.record(z.string(), z.record(z.string(), PTZPositionSchema));

type PresetData = z.infer<typeof PresetsDataSchema>;

export class PresetManager {
  private presetsFile: string;
  private data: PresetData;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private viscaClients: Map<CameraId, ViscaClient>
  ) {
    this.presetsFile = process.env.PRESETS_FILE ?? 'config/presets.json';
    this.data = this.loadPresets();
  }

  private loadPresets(): PresetData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.presetsFile, 'utf8'));
      return PresetsDataSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) {
        logger.warn({ err: err.message }, 'presets.json failed Zod validation, using empty presets');
      }
      return { cam1: { A: null, B: null, X: null, Y: null }, cam2: { A: null, B: null, X: null, Y: null }, cam3: { A: null, B: null, X: null, Y: null } };
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
    const client = this.viscaClients.get(cameraId);
    if (!client) return;
    gotoAbsolutePosition(client, pos);
    this.state.lastPresetNotification = `${cameraId} → ${slot}`;
    logger.info({ cameraId, slot }, 'preset recalled');
  }

  async savePreset(cameraId: CameraId, slot: PresetSlot): Promise<void> {
    const client = this.viscaClients.get(cameraId);
    if (!client) {
      logger.warn({ cameraId, slot }, 'no VISCA client for camera, cannot save preset');
      return;
    }
    try {
      const [ptResult, zoomVal] = await Promise.all([
        inquirePanTilt(client),
        inquireZoom(client),
      ]);
      if (!this.data[cameraId]) this.data[cameraId] = { A: null, B: null, X: null, Y: null };
      this.data[cameraId][slot] = { pan: ptResult.pan, tilt: ptResult.tilt, zoom: zoomVal };
      this.savePresets();
      this.state.lastPresetNotification = `Saved ${cameraId} → ${slot}`;
      logger.info({ cameraId, slot, position: this.data[cameraId][slot] }, 'preset saved');
    } catch (err) {
      logger.error({ err, cameraId, slot }, 'preset save failed: could not query camera position');
      throw err;
    }
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
