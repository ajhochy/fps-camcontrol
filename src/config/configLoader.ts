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

const MappingSchema = z.object({
  panTilt: z.string().default('rightStick'),
  zoom: z.string().default('leftStickY'),
  cameraSelectLeft: z.string().default('leftStickLeft'),
  cameraSelectRight: z.string().default('leftStickRight'),
  takeLive: z.string().default('rightTrigger'),
  autoTransition: z.string().default('RB'),
  precisionMode: z.string().default('leftTrigger'),
  sprintMode: z.string().default('LS'),
  presetA: z.string().default('A'),
  presetB: z.string().default('B'),
  presetX: z.string().default('X'),
  presetY: z.string().default('Y'),
  presetSave: z.string().default('LB'),
  speedUp: z.string().default('dpadUp'),
  speedDown: z.string().default('dpadDown'),
  lowerThirds: z.string().default('dpadLeft'),
  emergencyStop: z.string().default('back'),
});

export type CameraConfig = z.infer<typeof CameraSchema>;
export type MappingConfig = z.infer<typeof MappingSchema>;

export interface AppConfig {
  atem: { ip: string; defaultTransition: string };
  cameras: CameraConfig[];
  lowerThirds: { type: string; dskIndex: number };
  speeds: z.infer<typeof SpeedPresetsSchema>;
  mappings: MappingConfig;
}

export function loadConfig(): AppConfig {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');

  const devicesRaw = yaml.load(fs.readFileSync(devicesPath, 'utf8'));
  const devices = DevicesSchema.parse(devicesRaw);

  const speedsRaw = JSON.parse(fs.readFileSync(speedsPath, 'utf8'));
  const speeds = SpeedPresetsSchema.parse(speedsRaw);

  let mappings: MappingConfig;
  try {
    const mappingsRaw = yaml.load(fs.readFileSync(mappingsPath, 'utf8')) ?? {};
    mappings = MappingSchema.parse(mappingsRaw);
  } catch {
    mappings = MappingSchema.parse({});
  }

  return { ...devices, speeds, mappings };
}

export function saveMappings(mappings: MappingConfig): void {
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');
  const header = '# Controller button mappings - managed by FPS CamControl UI\n';
  const content = header + yaml.dump(mappings);
  fs.writeFileSync(mappingsPath, content, 'utf8');
}
