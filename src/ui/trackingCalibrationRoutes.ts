import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config/configLoader';
import type { MotionDevice } from '../devices/motionDevice';
import type { TrackingHooks } from '../app/trackingHooks';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { beginCalibrationPulse } from '../tracking/calibration';
import { TrackingError } from '../tracking/trackingManager';

const startBody = z.object({ sourceId: z.string().min(1).max(128), yesMove: z.literal(true) }).strict();
const stopBody = z.object({ operationId: z.string().uuid() }).strict();
/** Registered behind the existing embedded HTTP session/origin boundary. */
export function installTrackingCalibrationRoutes(app: Express, config: AppConfig, devices: Map<string, MotionDevice>, getHooks: () => TrackingHooks | undefined) {
  let operation: { id: string; pulse: ReturnType<typeof beginCalibrationPulse> } | undefined;
  app.post('/api/tracking/calibration/start', (req, res) => {
    const body = startBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Explicit calibration consent and source are required' }); return; }
    const hooks = getHooks(), source = resolveTrackingSources(config).find(item => item.sourceId === body.data.sourceId);
    if (!source) { res.status(404).json({ error: 'Unknown tracking source' }); return; }
    const device = source.cameraId ? devices.get(source.cameraId) : undefined;
    if (!config.tracking?.enabled || !hooks || !hooks.client?.connected || !device || operation) { res.status(409).json({ error: 'Calibration unavailable or busy' }); return; }
    let release: (() => void) | undefined;
    let pulse: ReturnType<typeof beginCalibrationPulse> | undefined;
    const id = randomUUID();
    try {
      release = hooks.manager.acquireCalibration(source.sourceId, () => pulse?.stop());
      pulse = beginCalibrationPulse(device, hooks.ledger, { durationMs: 800, speed: .1, healthy: () => !!getHooks()?.client?.connected,
        onStop: () => { release?.(); if (operation?.id === id) operation = undefined; } });
      if (pulse.stopped) { release(); res.status(409).json({ error: 'Calibration could not start safely' }); return; }
      operation = { id, pulse };
      res.json({ operationId: id, startedAt: pulse.startedAt, endsAt: pulse.endsAt, durationMs: pulse.durationMs, speed: pulse.speed });
    } catch (error) {
      pulse?.stop(); release?.();
      res.status(error instanceof TrackingError ? error.statusCode : 409).json({ error: 'Calibration unavailable or busy' });
    }
  });
  app.post('/api/tracking/calibration/stop', (req, res) => {
    const body = stopBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Invalid calibration operation' }); return; }
    // An expired/other operation can never stop a new motion owner.
    if (!operation || body.data.operationId !== operation.id) { res.status(404).json({ error: 'Calibration operation not active' }); return; }
    const owned = operation; owned.pulse.stop();
    if (owned.pulse.stopFailed) res.status(503).json({ error: 'Device stop could not be confirmed' });
    else res.json({ ok: true });
  });
  return () => operation?.pulse.stop();
}
