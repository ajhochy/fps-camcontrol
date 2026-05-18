import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const BridgeSchema = z.object({
  host: z.string(),
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
  inputId: z.number(),
  viscaIp: z.string().optional(),
  viscaPort: z.number().default(52381),
  bridge: BridgeSchema.optional(),
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
});

const AtemSchema = z.object({
  ip: z.string(),
  defaultTransition: z.enum(['cut', 'auto']),
  meIndex: z.number().default(0),
});

const DevicesSchema = z.object({
  atem: AtemSchema,
  cameras: z.array(CameraSchema),
  graphics: GraphicsSchema.optional(),
  lowerThirds: z.object({ type: z.string(), dskIndex: z.number() }).optional(),
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
export type GraphicsConfig = z.infer<typeof GraphicsSchema>;
export type MappingConfig = z.infer<typeof MappingSchema>;

export interface AppConfig {
  atem: { ip: string; defaultTransition: string; meIndex: number };
  cameras: CameraConfig[];
  graphics: GraphicsConfig;
  speeds: z.infer<typeof SpeedPresetsSchema>;
  mappings: MappingConfig;
}

export function loadConfig(): AppConfig {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');

  const devicesRaw = yaml.load(fs.readFileSync(devicesPath, 'utf8'));
  const devices = DevicesSchema.parse(devicesRaw);

  // Normalize graphics: support legacy lowerThirds key
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );

  const speedsRaw = JSON.parse(fs.readFileSync(speedsPath, 'utf8'));
  const speeds = SpeedPresetsSchema.parse(speedsRaw);

  let mappings: MappingConfig;
  try {
    const mappingsRaw = yaml.load(fs.readFileSync(mappingsPath, 'utf8')) ?? {};
    mappings = MappingSchema.parse(mappingsRaw);
  } catch {
    mappings = MappingSchema.parse({});
  }

  return { atem: devices.atem, cameras: devices.cameras, graphics, speeds, mappings };
}

export function validateDevicesConfig(raw: unknown): Pick<AppConfig, 'atem' | 'cameras' | 'graphics'> {
  const devices = DevicesSchema.parse(raw);
  const graphics = GraphicsSchema.parse(
    devices.graphics ?? { type: devices.lowerThirds?.type ?? 'dsk', dskIndex: devices.lowerThirds?.dskIndex ?? 0 }
  );
  return { atem: devices.atem, cameras: devices.cameras, graphics };
}

export function saveDevicesConfig(config: Pick<AppConfig, 'atem' | 'cameras' | 'graphics'>): void {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  fs.writeFileSync(devicesPath, yaml.dump({ atem: config.atem, cameras: config.cameras, graphics: config.graphics }, { lineWidth: 120 }), 'utf8');
}

export function saveMappings(mappings: MappingConfig): void {
  const mappingsPath = process.env.MAPPINGS_FILE ?? path.join(process.cwd(), 'config/mappings.yaml');
  const header = '# Controller button mappings - managed by FPS CamControl UI\n';
  fs.writeFileSync(mappingsPath, header + yaml.dump(mappings), 'utf8');
}
