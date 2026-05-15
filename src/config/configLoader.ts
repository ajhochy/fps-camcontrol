import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const CameraSchema = z.object({
  id: z.string(),
  label: z.string(),
  inputId: z.number(),
  viscaIp: z.string(),
  viscaPort: z.number(),
});

const DevicesSchema = z.object({
  atem: z.object({
    ip: z.string(),
    defaultTransition: z.enum(['cut', 'auto']),
  }),
  cameras: z.array(CameraSchema),
  lowerThirds: z.object({
    type: z.string(),
    dskIndex: z.number(),
  }),
});

const SpeedPresetsSchema = z.object({
  presets: z.array(z.object({
    name: z.string(),
    multiplier: z.number(),
  })),
  activePreset: z.number(),
});

export type CameraConfig = z.infer<typeof CameraSchema>;

export interface AppConfig {
  atem: { ip: string; defaultTransition: string };
  cameras: CameraConfig[];
  lowerThirds: { type: string; dskIndex: number };
  speeds: z.infer<typeof SpeedPresetsSchema>;
}

export function loadConfig(): AppConfig {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');

  const devicesRaw = yaml.load(fs.readFileSync(devicesPath, 'utf8'));
  const devices = DevicesSchema.parse(devicesRaw);

  const speedsRaw = JSON.parse(fs.readFileSync(speedsPath, 'utf8'));
  const speeds = SpeedPresetsSchema.parse(speedsRaw);

  return { ...devices, speeds };
}
