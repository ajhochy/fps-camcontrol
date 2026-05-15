import fs from 'fs';
import { AppState, CameraId, PresetSlot } from '../app/state';
import { CameraConfig, AppConfig } from '../config/configLoader';
import { ViscaClient } from '../visca/viscaClient';
import { gotoAbsolutePosition, PTZPosition } from '../visca/ptzActions';
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
    // We can't reliably read back position from UDP without full response parsing.
    // For now, save a dummy position that the user must edit or implement query parsing.
    // In a full implementation, send VISCA inquiries and parse the responses.
    logger.warn({ cameraId, slot }, 'preset save: position query not yet implemented; saving placeholder');
    if (!this.data[cameraId]) this.data[cameraId] = { A: null, B: null, X: null, Y: null };
    this.data[cameraId][slot] = { pan: 0, tilt: 0, zoom: 0 };
    this.savePresets();
    this.state.lastPresetNotification = `Saved ${cameraId} → ${slot}`;
    logger.info({ cameraId, slot }, 'preset saved (placeholder)');
  }

  getData(): PresetData {
    return this.data;
  }
}
