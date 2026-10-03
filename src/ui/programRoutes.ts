import type { Express } from 'express';
import { z } from 'zod';
import { loadConfig, type AppConfig } from '../config/configLoader';
import { PROGRAM_DEFAULTS, ProgramFeed, type ProgramConfig } from '../program/programFeed';
import type { AppState } from '../app/state';

const putBody = z.object({
  enabled: z.boolean().optional(),
  input: z.string().min(1).max(200).nullable().optional(),
  kind: z.enum(['avfoundation', 'decklink']).nullable().optional(),
}).strict();

/** A feed for this app: the real ffmpeg one, or (CAMCONTROL_FAKE_PROGRAM=1, the interactive sandbox) a synthesised frame. */
export function programFeedFor(config: AppConfig, state: AppState): ProgramFeed {
  const fake = process.env.CAMCONTROL_FAKE_PROGRAM === '1' ? () => ({
    cameraLabel: config.cameras.find(c => c.id === state.programCamera)?.label ?? String(state.programCamera ?? ''),
    lowerThird: state.lowerThirdsActive,
  }) : undefined;
  return new ProgramFeed(config.program ?? PROGRAM_DEFAULTS, fake);
}

/**
 * The live program feed (docs/program-feed.md). `saveProgram` writes devices.yaml's `program:` block. iPad writes
 * (X-Remote: 1) are refused while remote control is off at the desk, like its Sony writes.
 */
export function installProgramRoutes(app: Express, config: AppConfig, feed: ProgramFeed, saveProgram: (program: ProgramConfig) => void, remoteEnabled: () => boolean): void {
  app.get('/api/program/status', (_req, res) => res.json(feed.status()));
  app.get('/api/program/devices', (_req, res) => { void feed.devices().then(devices => res.json({ devices })).catch(() => res.json({ devices: [] })); });
  app.get('/api/program/formats', (_req, res) => { void feed.formats().then(formats => res.json({ formats })).catch(() => res.json({ formats: [] })); });
  app.get('/api/program/frame', (_req, res) => {
    if (!(config.program ?? PROGRAM_DEFAULTS).enabled) { res.status(409).json({ error: 'The program feed is off' }); return; }
    void feed.frame().then(frame => {
      if (!frame) { res.status(503).json({ error: feed.status().error ?? 'No program picture yet' }); return; }
      res.set({ 'Content-Type': frame.type, 'Cache-Control': 'no-store' }).send(frame.body);
    });
  });
  app.put('/api/program', (req, res) => {
    if (req.get('x-remote') === '1' && !remoteEnabled()) { res.status(403).json({ error: 'Remote control is off' }); return; }
    const body = putBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Invalid program feed settings' }); return; }
    const next = { ...(config.program ?? PROGRAM_DEFAULTS), ...body.data };
    try { saveProgram(next); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'The program feed settings could not be saved' }); return; }
    config.program = loadConfig().program;
    feed.configure(config.program ?? PROGRAM_DEFAULTS);
    res.json(feed.status());
  });
}
