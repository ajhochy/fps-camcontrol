import type { Express, Request, Response } from 'express';
import { loadConfig, type AppConfig } from '../config/configLoader';
import type { AppState } from '../app/state';
import { SessionError } from '../broadcast/outputSession';
import { CAPTURE_LOCKED_FIELDS, changedFields, ProgramCaptureConfig, ProgramCaptureSchema, SESSION_LOCKED_FIELDS, StreamingConfig, validateStreaming } from '../broadcast/streamingConfig';
import { programCaptureFor } from '../program/programCaptureRuntime';

/**
 * Program capture and output session administration (#69, #70). Writes are accepted only from this Mac (loopback) and
 * never from the iPad page (X-Remote): broadcast settings are not remote controls. While a session runs, every write
 * that would change what it produces is refused with the fields named; camera controls are untouched by this.
 */
const SESSION_HTTP: Record<SessionError['code'], number> = { 'disabled': 409, 'already-running': 409, 'capture-not-running': 409, 'no-folder': 409, 'folder-unusable': 409, 'no-runtime': 503, 'stream-unavailable': 501 };
function localOnly(req: Request, res: Response): boolean {
  const ip = req.socket.remoteAddress ?? '';
  if (req.get('x-remote') === '1' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) { res.status(403).json({ error: 'Streaming settings and sessions can only be changed on this Mac' }); return false; }
  return true;
}
export function lockedBySession(state: AppState): boolean { return !!programCaptureFor(state)?.sessions.running(); }

export function installStreamingRoutes(app: Express, config: AppConfig, state: AppState,
  save: (edit: (raw: Record<string, any>) => Record<string, any>) => void): void {
  const view = () => {
    const rt = programCaptureFor(state);
    return { streaming: config.streaming, programCapture: config.programCapture, capture: rt?.capture.status() ?? null, session: rt?.sessions.status() ?? null };
  };
  app.get('/api/streaming', (_req, res) => res.json(view()));

  app.put('/api/streaming/config', (req, res) => {
    if (!localOnly(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'Expected a JSON object', errors: [] }); return; }
    const current = config.streaming!;
    const result = validateStreaming({ ...current, ...req.body });
    if (!result.ok) { res.status(400).json({ error: 'Invalid streaming settings', errors: result.errors }); return; }
    const locked = lockedBySession(state) ? changedFields<StreamingConfig>(current, result.value, SESSION_LOCKED_FIELDS) : [];
    if (locked.length) { res.status(409).json({ error: 'A session is running: stop it before changing these settings', fields: locked }); return; }
    try { save(raw => ({ ...raw, streaming: result.value })); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'The settings could not be saved' }); return; }
    config.streaming = loadConfig().streaming;
    res.json(view());
  });

  app.put('/api/streaming/capture', async (req, res) => {
    if (!localOnly(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'Expected a JSON object', errors: [] }); return; }
    const current = config.programCapture!;
    const parsed = ProgramCaptureSchema.safeParse({ ...current, ...req.body });
    if (!parsed.success) { res.status(400).json({ error: 'Invalid program capture settings', errors: parsed.error.issues.map(i => ({ field: i.path.join('.') || (i as { keys?: string[] }).keys?.join(', ') || '', message: i.message })) }); return; }
    const changed = changedFields<ProgramCaptureConfig>(current, parsed.data, CAPTURE_LOCKED_FIELDS);
    if (changed.length && lockedBySession(state)) { res.status(409).json({ error: 'A session is running: stop it before changing the capture source', fields: changed }); return; }
    try { save(raw => ({ ...raw, programCapture: parsed.data })); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'The settings could not be saved' }); return; }
    config.programCapture = loadConfig().programCapture;
    // Applied now (the capture restarts), or with the next capture start while a session runs (queue/stall tuning only).
    const rt = programCaptureFor(state);
    const differs = JSON.stringify(current) !== JSON.stringify(config.programCapture);
    let applied = !differs;
    if (rt && differs && !lockedBySession(state)) {
      try { await rt.applyCapture(config.programCapture!); applied = true; }
      catch (error) { res.status(500).json({ ...view(), applied: false, error: error instanceof Error ? error.message : 'Program capture could not restart' }); return; }
    }
    res.json({ ...view(), applied });
  });

  app.post('/api/streaming/session', (req, res) => {
    if (!localOnly(req, res)) return;
    const rt = programCaptureFor(state);
    if (!rt) { res.status(503).json({ error: 'Program capture is not available in this app instance' }); return; }
    try { res.status(201).json(rt.sessions.start(config.streaming!, typeof req.body?.mode === 'string' ? req.body.mode : 'record')); }
    catch (error) {
      if (error instanceof SessionError) { res.status(SESSION_HTTP[error.code]).json({ error: error.message, code: error.code }); return; }
      res.status(400).json({ error: error instanceof Error ? error.message : 'The session could not start' });
    }
  });

  app.post('/api/streaming/session/stop', async (req, res) => {
    if (!localOnly(req, res)) return;
    const rt = programCaptureFor(state);
    if (!rt?.sessions.status()) { res.status(409).json({ error: 'No session' }); return; }
    res.json(await rt.sessions.stop());
  });
}
