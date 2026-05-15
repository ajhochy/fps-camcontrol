import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const CameraSchema = z.object({
  id: z.string(),
  label: z.string(),
  cameraType: z.enum(['vbot', 'birddog', 'generic']).default('generic'),
  inputId: z.number(),
  viscaIp: z.string(),
  viscaPort: z.number().default(52381),
});

const GraphicsSchema = z.object({
  type: z.enum(['dsk', 'usk', 'auto']).default('dsk'),
  dskIndex: z.number().default(0),
  uskIndex: z.number().default(0),
  meIndex: z.number().default(0),
});

const AtemSchema = z.object({
  ip: z.string(),
  defaultTransition: z.enum(['cut', 'auto']),
  meIndex: z.number().default(0),
});

const DevicesSchema = z.object({
  atem: AtemSchema,
  cameras: z.array(CameraSchema),
  graphics: GraphicsSchema,
});

const SpeedPresetsSchema = z.object({
  presets: z.array(z.object({
    name: z.string(),
    multiplier: z.number(),
  })),
  activePreset: z.number(),
});

export type CameraConfig = z.infer<typeof CameraSchema>;
export type GraphicsConfig = z.infer<typeof GraphicsSchema>;

export interface AppConfig {
  atem: { ip: string; defaultTransition: string; meIndex: number };
  cameras: CameraConfig[];
  graphics: GraphicsConfig;
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

export function validateDevicesConfig(raw: unknown): Pick<AppConfig, 'atem' | 'cameras' | 'graphics'> {
  return DevicesSchema.parse(raw);
}

export function saveDevicesConfig(config: Pick<AppConfig, 'atem' | 'cameras' | 'graphics'>): void {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  fs.writeFileSync(devicesPath, yaml.dump({ atem: config.atem, cameras: config.cameras, graphics: config.graphics }, { lineWidth: 120 }), 'utf8');
}
