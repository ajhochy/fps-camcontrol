import { Router } from 'express';
import { AppState } from '../../app/state';

export function createStatusRouter(state: AppState): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(state);
  });

  return router;
}
