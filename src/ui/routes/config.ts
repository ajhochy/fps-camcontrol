import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { AppConfig } from '../../config/configLoader';
import { logger } from '../../index';

const CameraUpdateSchema = z.array(z.object({
  id: z.string(),
  label: z.string().optional(),
  inputId: z.number().optional(),
  viscaIp: z.string().optional(),
  viscaPort: z.number().optional(),
}));

const SpeedUpdateSchema = z.object({
  presets: z.array(z.object({ name: z.string(), multiplier: z.number() })),
});

const AtemUpdateSchema = z.object({
  defaultTransition: z.enum(['cut', 'auto']),
});

function persistDevices(config: AppConfig): void {
  const devicesPath = process.env.DEVICES_CONFIG ?? path.join(process.cwd(), 'config/devices.yaml');
  const raw = { atem: config.atem, cameras: config.cameras, lowerThirds: config.lowerThirds };
  fs.writeFileSync(devicesPath, yaml.dump(raw));
}

function persistSpeeds(config: AppConfig): void {
  const speedsPath = process.env.SPEEDS_FILE ?? path.join(process.cwd(), 'config/speeds.json');
  fs.writeFileSync(speedsPath, JSON.stringify({ presets: config.speeds.presets, activePreset: config.speeds.activePreset }, null, 2));
}

export function createConfigRouter(config: AppConfig): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      cameras: config.cameras,
      atem: config.atem,
      lowerThirds: config.lowerThirds,
      speeds: config.speeds,
    });
  });

  router.post('/cameras', (req, res) => {
    const result = CameraUpdateSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.message });
      return;
    }
    for (const update of result.data) {
      const cam = config.cameras.find(c => c.id === update.id);
      if (!cam) continue;
      if (update.label !== undefined) cam.label = update.label;
      if (update.inputId !== undefined) cam.inputId = update.inputId;
      if (update.viscaIp !== undefined) cam.viscaIp = update.viscaIp;
      if (update.viscaPort !== undefined) cam.viscaPort = update.viscaPort;
    }
    persistDevices(config);
    logger.info('camera config updated and saved');
    res.json({ ok: true, cameras: config.cameras });
  });

  router.post('/speeds', (req, res) => {
    const result = SpeedUpdateSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.message });
      return;
    }
    config.speeds.presets = result.data.presets;
    persistSpeeds(config);
    logger.info('speed config updated and saved');
    res.json({ ok: true, speeds: config.speeds });
  });

  router.post('/atem', (req, res) => {
    const result = AtemUpdateSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.message });
      return;
    }
    config.atem.defaultTransition = result.data.defaultTransition;
    persistDevices(config);
    logger.info('ATEM config updated and saved');
    res.json({ ok: true, atem: config.atem });
  });

  return router;
}
