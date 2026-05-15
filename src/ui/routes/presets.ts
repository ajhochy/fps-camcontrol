import { Router } from 'express';
import { CameraId, PresetSlot } from '../../app/state';
import { PresetManager } from '../../model/presetManager';

export function createPresetsRouter(presetManager: PresetManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(presetManager.getData());
  });

  router.delete('/:cameraId/:slot', (req, res) => {
    const { cameraId, slot } = req.params;
    const validCameras: CameraId[] = ['cam1', 'cam2', 'cam3'];
    const validSlots: PresetSlot[] = ['A', 'B', 'X', 'Y'];
    if (!validCameras.includes(cameraId as CameraId) || !validSlots.includes(slot as PresetSlot)) {
      res.status(400).json({ error: 'invalid cameraId or slot' });
      return;
    }
    presetManager.clearPreset(cameraId as CameraId, slot as PresetSlot);
    res.json({ ok: true });
  });

  return router;
}
