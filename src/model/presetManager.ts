import fs from 'fs';
import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { ViscaClient } from '../visca/viscaClient';
import { gotoAbsolutePosition, queryPositionAsync, PTZPosition } from '../visca/ptzActions';
import { logger } from '../index';

interface PresetData {
  [cameraId: string]: {
    [slot: string]: PTZPosition | null;
  };
}

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
      return JSON.parse(fs.readFileSync(this.presetsFile, 'utf8'));
    } catch {
      // Build empty preset store dynamically from configured cameras
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
    const client = this.viscaClients.get(cameraId);
    if (!client) return;
    gotoAbsolutePosition(client, pos);
    this.state.lastPresetNotification = `${cameraId} → ${slot}`;
    logger.info({ cameraId, slot }, 'preset recalled');
  }

  async savePreset(cameraId: CameraId, slot: PresetSlot): Promise<void> {
    const client = this.viscaClients.get(cameraId);
    if (!client) throw new Error(`No VISCA client for camera ${cameraId}`);

    let pos: PTZPosition;
    try {
      pos = await queryPositionAsync(client);
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

  getData(): PresetData {
    return this.data;
  }
}
