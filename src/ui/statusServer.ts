import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { AppState, CameraId, trackDeviceLinkState, clearCameraLinkState } from '../app/state';
// NOTE: "profile" is overloaded in this codebase — profileDetector deals with
// *controller* profiles (Xbox, Wii U Pro). Camera environment profiles are
// aliased here as CameraProfile to keep the two apart.
import {
  AppConfig, MappingConfig, saveMappings, validateDevicesConfig, saveDevicesConfig,
  resolveProfile, saveActiveProfile, saveProfiles, CameraConfig,
  devicesFileVersion, ConfigConflictError, loadConfig, readDevicesFile, writeDevicesFile, devicesConfigFile,
  type Profile as CameraProfile,
} from '../config/configLoader';
import { buildRigs, describeRigDelete } from '../config/rigs';
import { applyRigPatch, applyAtemPatch, applySaveProfile, applySaveProfileAs, renameProfile, deleteProfile, validateWhole, createRig, removeRig, rigPositionOf, createSonyDevice, patchSonyDevice, deleteSonyDevice, RigEditError } from '../config/rigEdit';
import { presetSlotsSet } from '../model/presetShift';
import { clearWorkingProfile, describeChanges, saveWorkingProfile, slotsEqual, workingProfilePath, WorkingProfile, WorkingSlot } from '../config/workingProfile';
import { PresetManager } from '../model/presetManager';
import { ActivityLog } from '../app/activityLog';
import { ViscaDevice } from '../devices/viscaDevice';
import { MotionDevice } from '../devices/motionDevice';
import { createMotionDevice } from '../devices/deviceFactory';
import { AtemClient } from '../atem/atemClient';
import { loadProfiles, detectConnectionType } from '../input/profileDetector';
import { eventBus, AppEvent } from '../app/eventBus';
import { logger } from '../index';
import { SonyManager, SonyRetryableError, SonyUpstreamError } from '../sony/sonyManager';
import { getResourcePath } from '../config/paths';
import { trackingFor, TrackingHooks } from '../app/trackingHooks';
import { installTrackingRoutes, trackingSnapshot } from './trackingRoutes';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { installTrackingCalibrationRoutes } from './trackingCalibrationRoutes';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager,
  activityLog: ActivityLog,
  atem: AtemClient,
  devices: Map<CameraId, MotionDevice>,
  sonyManager?: SonyManager,
  getTracking: () => TrackingHooks | undefined = () => trackingFor(state),
  access?: { frameToken: string },
): express.Express {
  const app = express();
  if (process.env.CAMCONTROL_EMBEDDED) app.use((req, res, next) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const expectedFrameToken = access?.frameToken;
    const given = req.headers.authorization?.replace(/^Bearer /, '');
    const expectedBytes = Buffer.from(expectedFrameToken ?? '');
    const givenBytes = Buffer.from(given ?? '');
    const frameOnly = expectedBytes.length > 0 && givenBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(givenBytes, expectedBytes) && req.method === 'GET' && !req.headers.origin &&
      req.headers.host === `127.0.0.1:${req.socket.localPort}` &&
      (config.tracking?.sources ?? []).some(source => req.url === `/api/sony/cameras/${encodeURIComponent(source.sonyCameraId)}/live-view/frame`);
    if (frameOnly) { next(); return; }
    const cookie = (req.headers.cookie ?? '').split(';').map(v => v.trim());
    if (!process.env.CAMCONTROL_SESSION || req.headers.host !== `127.0.0.1:${req.socket.localPort}` ||
        !cookie.includes(`fps-session=${process.env.CAMCONTROL_SESSION}`) ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)) {
      res.status(403).json({ error: 'Desktop session required' }); return;
    }
    next();
  });
  app.use(express.json());
  installTrackingRoutes(app, config, getTracking);
  installTrackingCalibrationRoutes(app, config, devices, getTracking);
  // The rigs screen is plain JS/CSS files (not part of the page template) so they can be syntax-checked and
  // tested on their own. dist/ui and src/ui are both two levels below the repo root.
  app.use('/ui', express.static(path.join(__dirname, '../../ui'), { index: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); } }));

  const sonyProperties = new Set(['aperture', 'shutter-speed', 'iso', 'white-balance', 'focus-mode', 'focus-area']);
  const sony = (res: express.Response): SonyManager | null => {
    if (sonyManager) return sonyManager;
    res.status(503).json({ error: 'Sony service is not configured' }); return null;
  };
  const sonyError = (res: express.Response, error: unknown): void => {
    if (error instanceof SonyRetryableError) { res.set('Retry-After', String(error.retryAfter)).status(503).json({ error: 'Sony camera is busy; retry shortly' }); return; }
    if (error instanceof SonyUpstreamError) { res.status(error.statusCode).json({ error: error.message }); return; }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Sony request' });
  };
  const sonyId = (req: express.Request, res: express.Response): string | null => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9:-]{1,128}$/.test(id)) { res.status(400).json({ error: 'Invalid Sony camera ID' }); return null; }
    return id;
  };
  // A Sony device in devices.yaml (protocol: sony) names the physical camera it is bound to; the dashboard shows that name.
  const sonyNames = (): Map<string, { key: string; label: string }> => {
    const names = new Map<string, { key: string; label: string }>();
    for (const [key, device] of Object.entries(config.devices ?? {})) {
      if (device.protocol === 'sony' && device.sonyCameraId) names.set(device.sonyCameraId.toUpperCase(), { key, label: device.label });
    }
    return names;
  };
  const named = <T extends { id: string }>(cameras: T[]): (T & { name?: string; deviceKey?: string })[] => {
    const names = sonyNames();
    return cameras.map(camera => {
      const match = names.get(camera.id.toUpperCase());
      return match ? { ...camera, name: match.label, deviceKey: match.key } : camera;
    });
  };
  const cameraList = (manager: SonyManager) => named(manager.getStatus().cameras).map(camera => ({ ...camera, connected: camera.state === 'connected', status: camera.state }));
  app.get('/api/sony/status', (_req, res) => { const manager = sony(res); if (manager) { const status = manager.getStatus(); res.json({ ...status, cameras: named(status.cameras) }); } });
  app.get('/api/sony/cameras', (_req, res) => { const manager = sony(res); if (manager) res.json({ cameras: cameraList(manager) }); });
  app.post('/api/sony/cameras/discover', async (_req, res) => { const manager = sony(res); if (!manager) return; try { await manager.discover(); res.json({ cameras: cameraList(manager) }); } catch (error) { sonyError(res, error); } });
  app.post('/api/sony/service/retry', (_req, res) => { const manager = sony(res); if (!manager) return; manager.retryService(); res.json({ ok: true }); });
  app.post('/api/sony/cameras/:id/connect', async (req, res) => { const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return; try { await manager.connect(id, false); res.json(cameraList(manager).find(camera => camera.id === id) ?? { id, connected: true }); } catch (error) { sonyError(res, error); } });
  app.post('/api/sony/cameras/:id/retry', async (req, res) => { const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return; try { await manager.retryCamera(id); res.json({ ok: true }); } catch (error) { sonyError(res, error); } });
  app.delete('/api/sony/cameras/:id/approval', async (req, res) => { const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return; try { await manager.forget(id); res.json({ ok: true }); } catch (error) { sonyError(res, error); } });
  app.get('/api/sony/cameras/:id/properties', (req, res) => {
    const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return;
    void manager.properties(id).then(body => res.json(body)).catch(error => sonyError(res, error));
  });
  app.put('/api/sony/cameras/:id/properties/:name', (req, res) => {
    const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return;
    if (!sonyProperties.has(req.params.name)) { res.status(400).json({ error: 'Unsupported Sony property' }); return; }
    const value = req.body?.value;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      res.status(400).json({ error: 'Property value must be a finite scalar' }); return;
    }
    void manager.property(id, req.params.name, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then(body => res.json(body)).catch(error => sonyError(res, error));
  });
  app.post('/api/sony/cameras/:id/live-view/start', (req, res) => {
    const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return;
    void manager.liveViewStart(id).then(body => res.json(body)).catch(error => sonyError(res, error));
  });
  app.get('/api/sony/cameras/:id/live-view/frame', (req, res) => {
    const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return;
    void manager.liveViewFrame(id).then(frame => res.set('X-Frame-Captured-At', String(frame.capturedAt)).set('Cache-Control', 'no-store').type(frame.contentType).send(frame.body)).catch(error => sonyError(res, error));
  });
  app.post('/api/sony/cameras/:id/touch', (req, res) => {
    const manager = sony(res); const id = sonyId(req, res); if (!manager || !id) return;
    const x = req.body?.normalized?.x;
    const y = req.body?.normalized?.y;
    if (![x, y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
      res.status(400).json({ error: 'Touch coordinates must be finite and normalized' }); return;
    }
    void manager.touch(id, { x, y }).then(body => res.json(body)).catch(error => sonyError(res, error));
  });

  // GET /api/status
  // `cameraConnected` answers only "can this camera be moved?". For cameras
  // behind a Pi bridge, `cameraBridgeReachable` and `cameraGimbalAttached` say
  // WHICH stage is down, because the remedies differ (fix the Pi/network vs.
  // switch the gimbal on). Both maps omit direct-link cameras (VISCA) entirely:
  // a missing key means "no second stage", not "broken".
  app.get('/api/status', (_req, res) => {
    res.json({ ...state, tracking: trackingSnapshot(config, getTracking()) });
  });

  // The version of devices.yaml the page was looking at when it saved. Absent for older clients: no check.
  const expectedVersionOf = (body: unknown): string | undefined => {
    const version = (body as { expectedVersion?: unknown } | undefined)?.expectedVersion;
    return typeof version === 'string' ? version : undefined;
  };

  app.get('/api/config', (_req, res) => {
    res.json({
      cameras: config.cameras,
      atem: config.atem,
      graphics: config.graphics,
      speeds: config.speeds,
      version: devicesFileVersion(),
    });
  });

  // The rig view of the running config: one entry per camera position plus the ATEM, profile list,
  // Sony devices and Sony camera status. Also returned by every rig edit so the page can redraw from it.
  const savedSlots = (): WorkingSlot[] => (config.activeProfile ? config.profiles?.[config.activeProfile]?.slots ?? [] : []) as WorkingSlot[];
  // The profile being edited: whether it has unsaved rig changes, and exactly what they are.
  const profileBody = () => {
    const modified = !!config.working && !slotsEqual(config.working.slots, savedSlots());
    return {
      active: config.activeProfile ?? null,
      modified,
      changes: modified ? describeChanges(savedSlots(), config.working!.slots, (config.devices ?? {}) as Record<string, { label?: string }>) : [],
      notice: config.workingNotice ?? null,
    };
  };
  const rigsBody = () => {
    const sony = sonyManager ? sonyManager.getStatus() : null;
    return { ...buildRigs(config, state, devicesFileVersion(), sony ? sony.cameras : []), profile: profileBody(), atemConnected: atem ? atem.connected : null, programInput: atem && atem.connected ? atem.getProgramInput() ?? null : null, sony };
  };
  app.get('/api/rigs', (_req, res) => { res.json(rigsBody()); });

  // ---- rig edits. Hardware records (name, addresses, bound Sony camera) are shared by every profile and
  // are saved immediately. Each edit is validated as a whole file first, written through the
  // comment-preserving writer, re-read from disk, and applied to the running cameras.
  const workingFile = (): string => workingProfilePath(devicesConfigFile());
  const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  // devices.yaml as parsed, but with the active profile's rigs replaced by the working copy (what is running now).
  const effectiveRaw = (): Record<string, any> => {
    const raw = readDevicesFile() as Record<string, any>;
    if (config.working && raw.activeProfile && raw.profiles?.[raw.activeProfile]) raw.profiles[raw.activeProfile].slots = cloneJson(config.working.slots);
    return raw;
  };
  // After rigs move or go, the rig under control may no longer exist (or its position changed): point control at one that does.
  const keepControlValid = (): void => {
    const still = config.cameras.findIndex((camera) => camera.id === state.controlledCamera);
    if (still >= 0) { state.cameraIndex = still; return; }
    const target = config.cameras.find((camera) => camera.inputId !== undefined) ?? config.cameras[0];
    if (target) { state.controlledCamera = target.id as CameraId; state.cameraIndex = config.cameras.indexOf(target); state.previewCamera = target.id as CameraId; }
  };
  const restoreWorkingPresets = (): void => {
    const snapshot = config.working?.presetsAtStart;
    if (snapshot) presetManager.replaceAll(snapshot as never);
  };
  const dropWorking = (): void => { clearWorkingProfile(workingFile()); config.working = undefined; config.workingNotice = undefined; };
  /**
   * Apply an edit. Hardware changes (names, addresses, Sony devices, the ATEM) are written to devices.yaml at once.
   * With `wiring: true` the edit may also change rigs (ATEM input, Sony camera, adding and removing): those
   * changes go into the working copy, applied to the running app and saved for restarts, while the profile in
   * devices.yaml stays exactly as saved until the operator saves. `ends` says the edit is a Save, Save as or
   * Revert, which finishes the working copy.
   */
  const commitConfigEdit = (
    expectedVersion: string | undefined,
    edit: (raw: Record<string, any>) => Record<string, any>,
    options: { wiring?: boolean; endsWorking?: boolean } = {},
  ): void => {
    const current = readDevicesFile() as Record<string, any>;
    const active: string | undefined = current.activeProfile;
    const diskSlots: WorkingSlot[] | undefined = active ? cloneJson(current.profiles?.[active]?.slots) : undefined;
    let next: Record<string, any>;
    let nextSlots: WorkingSlot[] | undefined;
    if (options.wiring && active && diskSlots) {
      const withWorking = cloneJson(current);
      withWorking.profiles[active].slots = config.working ? cloneJson(config.working.slots) : cloneJson(diskSlots);
      const edited = edit(withWorking);
      nextSlots = cloneJson(edited.profiles[active].slots as WorkingSlot[]);
      next = cloneJson(edited);
      next.profiles[active].slots = cloneJson(diskSlots);
      validateWhole(next); // the saved profile must still be valid with this hardware change
    } else {
      next = edit(current);
    }
    writeDevicesFile(next, expectedVersion);
    if (options.endsWorking) {
      clearWorkingProfile(workingFile());
      config.working = undefined;
    } else if (nextSlots && active && diskSlots) {
      if (slotsEqual(nextSlots, diskSlots)) { clearWorkingProfile(workingFile()); config.working = undefined; }
      else {
        const now = new Date().toISOString();
        const started = config.working && config.working.base === active ? config.working : undefined;
        const working: WorkingProfile = {
          version: 1, base: active, baseSlots: started ? started.baseSlots : diskSlots, slots: nextSlots,
          presetsAtStart: started ? started.presetsAtStart : cloneJson(presetManager.getData() as Record<string, unknown>),
          startedAt: started ? started.startedAt : now, updatedAt: now,
        };
        saveWorkingProfile(workingFile(), working);
        config.working = working;
      }
    }
    const fresh = loadConfig();
    config.devices = fresh.devices;
    config.profiles = fresh.profiles;
    config.activeProfile = fresh.activeProfile;
    config.working = fresh.working;
    config.workingNotice = fresh.workingNotice;
    config.tracking = fresh.tracking;
    reconcileCameras(fresh.cameras);
  };
  const splitVersion = (body: unknown): { expectedVersion: string | undefined; change: unknown } => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { expectedVersion: undefined, change: body };
    const { expectedVersion, ...change } = body as Record<string, unknown>;
    return { expectedVersion: typeof expectedVersion === 'string' ? expectedVersion : undefined, change };
  };
  const editFailed = (res: express.Response, err: unknown): void => {
    if (err instanceof ConfigConflictError) { res.status(409).json({ ok: false, conflict: true, error: err.message }); return; }
    if (err instanceof RigEditError) { res.status(err.status).json({ ok: false, error: err.message }); return; }
    logger.error({ err }, 'rig edit failed');
    res.status(500).json({ ok: false, error: 'the change could not be saved' });
  };
  const deviceKeyOf = (req: express.Request, res: express.Response): string | null => {
    const key = req.params.key;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) { res.status(400).json({ ok: false, error: 'invalid device key' }); return null; }
    return key;
  };

  app.patch('/api/rigs/:key', (req, res) => {
    const key = deviceKeyOf(req, res); if (!key) return;
    const { expectedVersion, change } = splitVersion(req.body);
    try { commitConfigEdit(expectedVersion, (raw) => applyRigPatch(raw, key, change), { wiring: true }); res.json({ ok: true, ...rigsBody() }); } catch (err) { editFailed(res, err); }
  });
  // The ATEM connection and graphics keyer. A changed address reconnects the switcher, as the classic Device Config does.
  app.patch('/api/atem', (req, res) => {
    const { expectedVersion, change } = splitVersion(req.body);
    try {
      const before = config.atem.ip;
      commitConfigEdit(expectedVersion, (raw) => applyAtemPatch(raw, change));
      const fresh = loadConfig();
      config.atem = fresh.atem;
      config.graphics = fresh.graphics;
      if (fresh.atem.ip !== before && atem) {
        atem.disconnect();
        atem.connect().catch(err => logger.warn({ err }, 'ATEM reconnect after config change failed'));
      }
      res.json({ ok: true, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });

  // ---- profiles and the working copy. Save writes the working copy into the active profile; Save as writes it as
  // a NEW profile (made active) and leaves the original exactly as it was saved; Revert drops it (and restores the
  // presets, which are keyed by rig position). Nothing here is needed while there are no unsaved changes.
  const needsWorking = (res: express.Response): boolean => {
    if (config.working) return true;
    res.status(409).json({ ok: false, error: 'There are no unsaved changes.' });
    return false;
  };
  app.post('/api/profiles/save', (req, res) => {
    if (!needsWorking(res)) return;
    const slots = config.working!.slots as unknown as Record<string, any>[];
    const { expectedVersion } = splitVersion(req.body);
    try { commitConfigEdit(expectedVersion, (raw) => applySaveProfile(raw, slots), { endsWorking: true }); res.json({ ok: true, ...rigsBody() }); } catch (err) { editFailed(res, err); }
  });
  app.post('/api/profiles/save-as', (req, res) => {
    if (!needsWorking(res)) return;
    const slots = config.working!.slots as unknown as Record<string, any>[];
    const { expectedVersion, change } = splitVersion(req.body);
    try {
      let key = '';
      commitConfigEdit(expectedVersion, (raw) => { const made = applySaveProfileAs(raw, (change as { label?: unknown } | undefined)?.label, slots); key = made.key; return made.raw; }, { endsWorking: true });
      res.status(201).json({ ok: true, key, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });
  app.post('/api/profiles/revert', (_req, res) => {
    if (!needsWorking(res)) return;
    try {
      restoreWorkingPresets();
      dropWorking();
      const fresh = loadConfig();
      config.devices = fresh.devices; config.profiles = fresh.profiles; config.activeProfile = fresh.activeProfile;
      config.tracking = fresh.tracking;
      reconcileCameras(fresh.cameras);
      keepControlValid();
      res.json({ ok: true, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });
  const profileKeyOf = (req: express.Request, res: express.Response): string | null => {
    const key = req.params.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) { res.status(400).json({ ok: false, error: 'invalid profile name' }); return null; }
    return key;
  };
  app.patch('/api/profiles/:name', (req, res) => {
    const key = profileKeyOf(req, res); if (!key) return;
    const { expectedVersion, change } = splitVersion(req.body);
    try { commitConfigEdit(expectedVersion, (raw) => renameProfile(raw, key, (change as { label?: unknown } | undefined)?.label)); res.json({ ok: true, ...rigsBody() }); } catch (err) { editFailed(res, err); }
  });
  app.delete('/api/profiles/:name', (req, res) => {
    const key = profileKeyOf(req, res); if (!key) return;
    const { expectedVersion } = splitVersion(req.body);
    try { commitConfigEdit(expectedVersion, (raw) => deleteProfile(raw, key)); res.json({ ok: true, ...rigsBody() }); } catch (err) { editFailed(res, err); }
  });

  // Add a rig at the end of the active profile: an existing controller ({deviceKey}) or new hardware
  // ({label, controller, visca|gimbal}), with an optional ATEM input and Sony camera.
  app.post('/api/rigs', (req, res) => {
    const { expectedVersion, change } = splitVersion(req.body);
    try {
      let result = { key: '', position: 0 };
      commitConfigEdit(expectedVersion, (raw) => { const made = createRig(raw, change); result = { key: made.key, position: made.position }; return made.raw; }, { wiring: true });
      res.status(201).json({ ok: true, ...result, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });

  // Remove a rig. Later rigs move up a position (new camera id and hotkey), so the request must say
  // `confirm: true`; without it the answer (409) describes exactly what would change and nothing is touched.
  app.delete('/api/rigs/:key', (req, res) => {
    const key = deviceKeyOf(req, res); if (!key) return;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const expectedVersion = typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined;
    try {
      const position = rigPositionOf(effectiveRaw(), key, body.position);
      const totalBefore = config.cameras.length;
      const impact = describeRigDelete(buildRigs(config, state, devicesFileVersion()), presetManager.getData(), config.mappings as unknown as Record<string, unknown>, position, presetSlotsSet);
      if (body.confirm !== true) {
        res.status(409).json({ ok: false, confirmationRequired: true, error: 'Removing this rig moves the rigs after it up one position. Confirm to continue.', impact });
        return;
      }
      if (body.deleteDevice === true) {
        res.status(409).json({ ok: false, error: 'The hardware entry can only be deleted after the profile has been saved without this rig.' });
        return;
      }
      commitConfigEdit(expectedVersion, (raw) => removeRig(raw, key, { position }).raw, { wiring: true });
      presetManager.removeRigSlot(position, totalBefore);
      keepControlValid();
      res.json({ ok: true, removed: impact, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });

  app.post('/api/sony-devices', (req, res) => {
    const { expectedVersion, change } = splitVersion(req.body);
    try {
      let created = '';
      commitConfigEdit(expectedVersion, (raw) => { const result = createSonyDevice(raw, change); created = result.key; return result.raw; });
      res.status(201).json({ ok: true, key: created, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });
  app.patch('/api/sony-devices/:key', (req, res) => {
    const key = deviceKeyOf(req, res); if (!key) return;
    const { expectedVersion, change } = splitVersion(req.body);
    try { commitConfigEdit(expectedVersion, (raw) => patchSonyDevice(raw, key, change)); res.json({ ok: true, ...rigsBody() }); } catch (err) { editFailed(res, err); }
  });
  app.delete('/api/sony-devices/:key', (req, res) => {
    const key = deviceKeyOf(req, res); if (!key) return;
    const { expectedVersion } = splitVersion(req.body);
    try {
      if (config.working && config.working.slots.some((slot) => slot.camera === key)) {
        res.status(409).json({ ok: false, error: 'This camera is on a rig in your unsaved changes; save or revert them first.' });
        return;
      }
      commitConfigEdit(expectedVersion, (raw) => deleteSonyDevice(raw, key));
      res.json({ ok: true, ...rigsBody() });
    } catch (err) { editFailed(res, err); }
  });

  app.get('/api/presets', (_req, res) => {
    res.json(presetManager.getData());
  });

  // GET /api/controllers
  // Returns all HID devices that match known profiles, plus unrecognized gamepad-like devices.
  // `detected` means the OS enumerates it; `connected` means the app is actually
  // receiving HID packets from it. Those are different things — a pad can be
  // detected while delivering no data (e.g. denied macOS Input Monitoring), and
  // reporting that as connected made this tab contradict the home screen.
  app.get('/api/controllers', (_req, res) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const HID = require('node-hid');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devices: any[] = HID.devices();
      const profilesDir = process.env.PROFILES_DIR ?? getResourcePath('controller-profiles');
      const profiles = loadProfiles(profilesDir);

      // Filter for gamepad/joystick-like devices (usagePage 1 = Generic Desktop, usage 4 = Joystick, 5 = Gamepad)
      // Also include any device that matches a known profile regardless of usage
      const seen = new Set<string>();
      const result = devices
        .filter(dev => {
          const matchesProfile = profiles.some(p =>
            p.vendorIds.includes(dev.vendorId) && p.productIds.includes(dev.productId)
          );
          const isGamepad = dev.usagePage === 1 && (dev.usage === 4 || dev.usage === 5);
          return matchesProfile || isGamepad;
        })
        .map(dev => {
          const profile = profiles.find(p =>
            p.vendorIds.includes(dev.vendorId) && p.productIds.includes(dev.productId)
          ) ?? null;
          return {
            id: `${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`,
            label: dev.product || 'Unknown Device',
            profileName: profile?.name ?? 'unknown',
            vendorId: dev.vendorId,
            productId: dev.productId,
            detected: true,
            connected:
              state.controllerConnected &&
              profile !== null &&
              profile.name === state.activeControllerProfile,
            connectionType: detectConnectionType(dev),
          };
        })
        .filter(entry => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });

      res.json(result);
    } catch (err) {
      logger.error({ err }, 'HID enumeration failed');
      res.status(500).json({ error: 'Failed to enumerate HID devices', details: String(err) });
    }
  });

  // GET /api/controllers/active
  app.get('/api/controllers/active', (_req, res) => {
    res.json({
      connected: state.controllerConnected,
      profileName: state.activeControllerProfile ?? null,
      connectionType: state.activeConnectionType ?? null,
      statusDetail: state.controllerStatusDetail ?? null,
    });
  });

  // GET /api/mappings
  app.get('/api/mappings', (_req, res) => {
    res.json(config.mappings);
  });

  // POST /api/mappings
  app.post('/api/mappings', (req, res) => {
    try {
      const body = req.body as { mappings: MappingConfig };
      if (!body || !body.mappings) {
        res.status(400).json({ ok: false, error: 'Missing mappings in body' });
        return;
      }
      saveMappings(body.mappings);
      config.mappings = body.mappings;
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to save mappings');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /api/controllers/active
  app.post('/api/controllers/active', (_req, res) => {
    res.json({ ok: true, message: 'Controller switching requires restart' });
  });

  /**
   * Bring the live MotionDevice map in line with a new camera list, reusing
   * devices whose connection details are unchanged. Shared by the Device Config
   * save and by profile switching, so both take the same, tested path.
   */
  function reconcileCameras(newCameras: AppConfig['cameras']): void {
    const tracking = getTracking();
    tracking?.manager.invalidateAll('binding_changed');
    const oldIds = new Set(devices.keys());
    const newIds = new Set(newCameras.map(c => c.id as CameraId));

    // Remove cameras the new list no longer has.
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        devices.get(id)?.close();
        devices.delete(id);
        clearCameraLinkState(state, id);
      }
    }

    // Add or rebuild cameras via the factory (VISCA or DJI bridge).
    for (const cam of newCameras) {
      const id = cam.id as CameraId;
      const existing = devices.get(id);
      const oldCam = config.cameras.find(c => c.id === cam.id);
      const changed = !existing || !oldCam ||
        oldCam.protocol !== cam.protocol ||
        oldCam.viscaIp !== cam.viscaIp ||
        oldCam.viscaPort !== cam.viscaPort ||
        oldCam.cameraType !== cam.cameraType ||
        oldCam.cameraAddress !== cam.cameraAddress ||
        JSON.stringify(oldCam.bridge) !== JSON.stringify(cam.bridge);

      if (changed) {
        existing?.close();
        const device = createMotionDevice(cam, activityLog);
        trackDeviceLinkState(state, id, device);
        devices.set(id, device);
        device.connect();
      } else if (existing && existing instanceof ViscaDevice && oldCam && oldCam.label !== cam.label) {
        existing.setActivityLog(activityLog, cam.label);
      }
    }

    // Mutate the existing cameras array in place rather than reassigning, so
    // anything that captured a reference at startup (e.g. CameraSelector)
    // sees the new entries without being rebuilt.
    config.cameras.length = 0;
    for (const cam of newCameras) config.cameras.push(cam);
    if (tracking && config.tracking) {
      tracking.refreshSources?.();
      tracking.manager.reconcile(config.tracking, resolveTrackingSources(config), devices);
    }
  }

  // GET /api/profiles — inventory + profile definitions + which one is active.
  app.get('/api/profiles', (_req, res) => {
    res.json({
      activeProfile: config.activeProfile ?? null,
      profiles: config.profiles ?? {},
      devices: config.devices ?? {},
      version: devicesFileVersion(),
    });
  });

  // POST /api/profiles/active — switch environments live.
  app.post('/api/profiles/active', (req, res) => {
    try {
      const name = (req.body as { profile?: string })?.profile;
      if (!name) { res.status(400).json({ ok: false, error: 'missing "profile"' }); return; }
      const profile = config.profiles?.[name];
      if (!profile) {
        res.status(400).json({ ok: false, error: `unknown profile "${name}"` });
        return;
      }
      // Unsaved rig changes are never dropped silently: the caller must save them or say `discard: true`.
      if (config.working) {
        if ((req.body as { discard?: boolean })?.discard !== true) {
          res.status(409).json({ ok: false, unsavedChanges: true, changes: profileBody().changes, error: 'This profile has unsaved rig changes.' });
          return;
        }
        restoreWorkingPresets();
        dropWorking();
      }

      const newCameras = resolveProfile(config.devices ?? {}, profile);
      saveActiveProfile(name);
      config.activeProfile = name;
      reconcileCameras(newCameras);

      // Point control at a camera that exists in the new profile. Prefer one
      // whose video is actually wired so we never arm a dead input.
      const target = newCameras.find(c => c.inputId !== undefined) ?? newCameras[0];
      if (target) {
        state.controlledCamera = target.id as CameraId;
        state.cameraIndex = newCameras.indexOf(target);
        if (target.inputId !== undefined) {
          state.previewCamera = target.id as CameraId;
          atem.changePreviewInput(target.inputId).catch(err =>
            logger.warn({ err }, 'failed to set ATEM preview after profile switch'));
        }
      }

      logger.info({ profile: name, cameras: newCameras.map(c => c.label) }, 'active profile switched');
      activityLog?.addSystemEntry(`Profile → ${name}`, newCameras.map(c => c.label).join(', '));
      res.json({ ok: true, activeProfile: name, cameras: newCameras });
    } catch (err) {
      logger.error({ err }, 'profile switch failed');
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  // POST /api/profiles — save slot assignments for one or more profiles.
  app.post('/api/profiles', (req, res) => {
    try {
      const body = req.body as { profiles?: Record<string, CameraProfile> };
      if (!body?.profiles) { res.status(400).json({ ok: false, error: 'missing "profiles"' }); return; }
      if (config.working) { res.status(409).json({ ok: false, unsavedChanges: true, error: 'There are unsaved rig changes: save or revert them on the Rigs screen first.' }); return; }
      saveProfiles(body.profiles, expectedVersionOf(req.body));
      config.profiles = body.profiles;

      // If the profile being edited is the live one, apply the edit immediately.
      const active = config.activeProfile;
      if (active && body.profiles[active]) {
        reconcileCameras(resolveProfile(config.devices ?? {}, body.profiles[active]));
      }
      res.json({ ok: true, version: devicesFileVersion() });
    } catch (err) {
      if (err instanceof ConfigConflictError) { res.status(409).json({ ok: false, conflict: true, error: err.message }); return; }
      logger.error({ err }, 'profile save failed');
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/config', (req, res) => {
    try {
      const parsed = validateDevicesConfig(req.body);

      // Detect ATEM IP change before mutating config
      const atemIpChanged = parsed.atem.ip !== config.atem.ip;

      if (config.working) { res.status(409).json({ ok: false, unsavedChanges: true, error: 'There are unsaved rig changes: save or revert them on the Rigs screen first.' }); return; }
      // Save to disk (refused with 409 if devices.yaml changed since the page loaded it)
      saveDevicesConfig(parsed, expectedVersionOf(req.body));

      // Update in-memory config
      config.atem = parsed.atem;
      config.graphics = parsed.graphics;

      reconcileCameras(parsed.cameras);

      // Reconnect ATEM if IP changed
      if (atemIpChanged) {
        atem.disconnect();
        atem.connect().catch(err => logger.warn({ err }, 'ATEM reconnect after config change failed'));
      }

      res.json({ ok: true, version: devicesFileVersion() });
    } catch (err) {
      if (err instanceof ConfigConflictError) { res.status(409).json({ ok: false, conflict: true, error: err.message }); return; }
      logger.error({ err }, 'config save failed');
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/reconnect/atem', (_req, res) => {
    atem.disconnect();
    atem.connect().catch(err => logger.warn({ err }, 'manual ATEM reconnect failed'));
    res.json({ ok: true });
  });

  app.post('/api/reconnect/camera/:id', (req, res) => {
    const device = devices.get(req.params.id as CameraId);
    if (!device) { res.status(404).json({ error: 'unknown camera' }); return; }
    getTracking()?.manager.invalidateCamera(req.params.id, 'device_reconnect');
    device.close();
    device.connect();
    res.json({ ok: true });
  });

  app.get('/api/activity', (_req, res) => {
    res.json({ entries: activityLog.getAll() });
  });

  app.delete('/api/activity', (_req, res) => {
    activityLog.clear();
    res.json({ ok: true });
  });

  app.get('/docs/sony-sidecar-setup', (_req, res) => {
    res.type('text/plain').sendFile(getResourcePath('docs/sony-sidecar-setup.md'));
  });

  app.get('/', (_req, res) => {
    res.send(statusHtml());
  });

  return app;
}

export function startStatusServer(
  app: express.Express,
  activityLog: ActivityLog,
  port = 8080
): http.Server {
  const server = http.createServer(app);
  // Use noServer mode and route upgrades by path manually. Attaching two
  // WebSocketServer instances to the same http.Server via `{ server, path }`
  // causes each instance's auto-installed upgrade listener to reject the
  // other's path with 400 (abortHandshake), since shouldHandle() runs before
  // any siblings get a look.
  const wss = new WebSocketServer({ noServer: true });

  const clients = new Set<WebSocket>();
  let lastBroadcast = 0;

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const broadcastController = (event: AppEvent) => {
    if (event.type !== 'rawHidData') return;
    if (clients.size === 0) return;
    const now = Date.now();
    if (now - lastBroadcast < 100) return; // 10Hz throttle
    lastBroadcast = now;

    const payload = JSON.stringify({
      raw: Array.from(event.raw).map((b: number) => b.toString(16).padStart(2, '0')),
      normalized: event.normalized,
      ts: now,
    });

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };
  eventBus.on('controllerData', broadcastController);

  const activityClients = new Set<WebSocket>();
  const wssActivity = new WebSocketServer({ noServer: true });

  wssActivity.on('connection', (ws) => {
    activityClients.add(ws);
    ws.on('close', () => activityClients.delete(ws));
    ws.on('error', () => activityClients.delete(ws));
    const current = activityLog.getAll();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', entries: current }));
  });

  const broadcastActivity = (entry: unknown) => {
    const payload = JSON.stringify({ type: 'entry', entry });
    for (const ws of activityClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };
  activityLog.on('entry', broadcastActivity);

  const closeStreams = () => {
    for (const ws of [...clients, ...activityClients]) ws.terminate();
    wss.close();
    wssActivity.close();
    eventBus.removeListener('controllerData', broadcastController);
    activityLog.removeListener('entry', broadcastActivity);
  };
  server.once('shutdown', closeStreams);
  server.once('close', closeStreams);

  server.on('upgrade', (request, socket, head) => {
    if (process.env.CAMCONTROL_EMBEDDED && (
      !process.env.CAMCONTROL_SESSION ||
      request.headers.host !== `127.0.0.1:${request.socket.localPort}` ||
      request.headers.origin !== `http://127.0.0.1:${request.socket.localPort}` ||
      !(request.headers.cookie ?? '').split(';').map(v => v.trim()).includes(`fps-session=${process.env.CAMCONTROL_SESSION}`))) {
      socket.destroy(); return;
    }
    const url = request.url ?? '';
    const pathname = url.split('?')[0];
    if (pathname === '/ws/controller-input') {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    } else if (pathname === '/ws/activity') {
      wssActivity.handleUpgrade(request, socket, head, (ws) => wssActivity.emit('connection', ws, request));
    } else {
      socket.destroy();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    logger.info({ port: address && typeof address !== 'string' ? address.port : port }, 'status UI running');
  });

  return server;
}

/** Resolve only after the kernel has assigned the requested status port. */
export function waitForListening(server: http.Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function statusHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0e10">
<script>
  try {
    if (localStorage.getItem('fps-theme') === 'light') document.documentElement.dataset.theme = 'light';
  } catch (_) {}
</script>
<title>FPS CamControl</title>
<link rel="stylesheet" href="/ui/rigs/rigs.css">
<link rel="stylesheet" href="/ui/tracking/tracking.css">
<style>
  :root {
    --bg:        oklch(0.11 0.008 235);
    --surface:   oklch(0.155 0.008 235);
    --surface-2: oklch(0.205 0.009 235);
    --border:    oklch(0.27 0.010 235);
    --text:      oklch(0.88 0.006 235);
    --text-2:    oklch(0.52 0.012 235);
    --amber:     oklch(0.76 0.14 73);
    --blue:      oklch(0.66 0.13 240);
    --live-bg:   oklch(0.28 0.16 22);
    --live-text: oklch(0.90 0.08 20);
    --pvw-bg:    oklch(0.24 0.13 145);
    --pvw-text:  oklch(0.82 0.10 140);
    --ok-bg:     oklch(0.22 0.09 145);
    --ok-text:   oklch(0.72 0.12 140);
    --err-bg:    oklch(0.24 0.13 22);
    --err-text:  oklch(0.78 0.14 20);
    --warn-bg:   oklch(0.26 0.11 73);
    --warn-text: oklch(0.85 0.13 73);
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: 'Nunito Sans', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 0 24px 40px;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  /* Header */
  .app-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 16px 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .app-title {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    font-size: 1.4rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text);
    margin: 0;
  }
  .app-title span { color: var(--amber); }
  .app-subtitle {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  /* Status bar — hardware indicator strip */
  .status-bar {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .s-tile {
    display: flex;
    flex-direction: column;
    padding: 5px 12px 6px;
    border: 1px solid transparent;
    border-radius: 2px;
    min-width: 100px;
  }
  .s-tile__label {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.65;
    line-height: 1;
    margin-bottom: 3px;
  }
  .s-tile__value {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1.2;
  }
  .s-tile--live    { background: var(--live-bg);  border-color: oklch(0.40 0.18 22);   color: var(--live-text); }
  .s-tile--pvw     { background: var(--pvw-bg);   border-color: oklch(0.36 0.14 145);  color: var(--pvw-text); }
  .s-tile--ctrl    { background: oklch(0.22 0.10 240); border-color: oklch(0.36 0.14 240); color: oklch(0.82 0.10 240); }
  .s-tile--ok      { background: var(--ok-bg);    border-color: oklch(0.34 0.10 145);  color: var(--ok-text); }
  .s-tile--err     { background: var(--err-bg);   border-color: oklch(0.38 0.14 22);   color: var(--err-text); }
  .s-tile--neutral { background: var(--surface);  border-color: var(--border);          color: var(--text); }

  /* Tab bar */
  .tab-bar {
    display: flex;
    gap: 1px;
    padding-top: 10px;
    margin-bottom: 0;
  }
  .tab-btn {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 8px 22px;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    color: var(--text-2);
    cursor: pointer;
    border-radius: 2px 2px 0 0;
    margin-bottom: -1px;
    transition: color 0.1s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active {
    background: var(--surface);
    border-color: var(--border);
    color: var(--amber);
    box-shadow: inset 0 2px 0 var(--amber);
  }

  /* Panels */
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 2px 2px 2px;
    padding: 20px 24px;
  }
  .panel h2 {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-2);
    margin: 0 0 16px;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Camera status grid */
  .cam-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    margin-bottom: 16px;
  }
  .cam-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cam-card__header { display: flex; align-items: center; gap: 8px; }
  .cam-card__led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .cam-card__name {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 600;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
  }
  .cam-card__status {
    font-size: 0.68rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding-left: 16px;
  }
  .cam-card--ok .cam-card__led    { background: var(--ok-text); box-shadow: 0 0 5px var(--ok-text); }
  .cam-card--ok .cam-card__status { color: var(--ok-text); }
  .cam-card--err .cam-card__led   { background: var(--err-text); box-shadow: 0 0 5px var(--err-text); }
  .cam-card--err .cam-card__status{ color: var(--err-text); }
  /* Amber, not red: the camera is unusable either way, but the remedy differs
     (switch the gimbal on) and it is not the network's fault. */
  .cam-card--warn .cam-card__led   { background: var(--warn-text); box-shadow: 0 0 5px var(--warn-text); }
  .cam-card--warn .cam-card__status{ color: var(--warn-text); }
  .cam-card__hint {
    font-size: 0.64rem;
    letter-spacing: 0.04em;
    color: var(--text-2);
    padding-left: 16px;
  }

  /* Mode chips */
  .mode-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .mode-chip {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .mode-chip--on    { background: var(--warn-bg); border-color: oklch(0.38 0.12 73); color: var(--warn-text); }
  .mode-chip--speed { background: var(--surface-2); border-color: var(--blue); color: var(--blue); }

  /* Section headers */
  .section-header {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--amber);
    margin: 20px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .section-header:first-child { margin-top: 0; }

  /* Tables */
  table { border-collapse: collapse; width: 100%; font-size: 0.84rem; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  td:first-child {
    color: var(--text-2);
    font-family: 'Rajdhani', sans-serif;
    font-weight: 500;
    letter-spacing: 0.04em;
  }

  /* Forms */
  .cfg-input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 5px 8px;
    border-radius: 2px;
    font-family: 'Nunito Sans', sans-serif;
    font-size: 0.82rem;
    width: 100%;
    outline: none;
    transition: border-color 0.1s;
  }
  .cfg-input:focus { border-color: var(--amber); }

  /* Buttons */
  .btn {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 6px 16px;
    border-radius: 2px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
  }
  .btn:hover { border-color: var(--amber); color: var(--amber); }
  .btn.listening { border-color: var(--err-text); color: var(--err-text); animation: pulse 0.8s infinite; }
  .btn.danger { border-color: oklch(0.50 0.16 22); color: var(--err-text); }
  .btn-sm {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 2px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
  }
  .btn-sm:hover { border-color: var(--amber); color: var(--amber); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* Activity log */
  .log-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .filter-bar { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .filter-label {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-2);
    margin-right: 4px;
  }
  .filter-sep { width: 1px; height: 14px; background: var(--border); margin: 0 3px; }
  .filter-btn {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 2px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
  }
  .filter-btn:hover { color: var(--text); border-color: oklch(0.40 0.010 235); }
  .filter-btn.active { background: oklch(0.20 0.10 240); border-color: var(--blue); color: var(--blue); }

  .log-wrap {
    height: 440px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .log-wrap::-webkit-scrollbar { width: 6px; }
  .log-wrap::-webkit-scrollbar-track { background: var(--bg); }
  .log-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .activity-table { width: 100%; border-collapse: collapse; font-size: 0.77rem; }
  .activity-table th {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.63rem;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    text-align: left;
    color: var(--text-2);
    padding: 7px 8px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface);
    z-index: 1;
  }
  .activity-table td { padding: 3px 8px; border-bottom: 1px solid oklch(0.155 0.008 235); vertical-align: top; }
  .activity-table td.msg {
    font-family: ui-monospace, 'Cascadia Code', monospace;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.73rem;
  }
  .row-visca { background: oklch(0.155 0.014 240); }
  .row-atem  { background: oklch(0.155 0.010 73); }
  .row-dji   { background: #16132a; }
  .row-sys   { background: var(--surface); color: var(--text-2); }

  /* Controller mapping */
  .mapping-table td { padding: 5px 8px; }
  .mapping-table td:first-child { color: var(--text); min-width: 180px; font-family: 'Nunito Sans', sans-serif; font-size: 0.84rem; }
  .mapping-table td:nth-child(2) { color: var(--amber); min-width: 130px; font-family: 'Rajdhani', sans-serif; font-weight: 600; letter-spacing: 0.05em; }

  /* Controller list badges */
  /* Author display rules (e.g. .badge) would otherwise beat the [hidden] attribute. */
  [hidden] { display:none !important; }
  .badge {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    display: inline-block;
  }
  .badge.active-ctrl { background: oklch(0.22 0.10 240); border-color: var(--blue); color: var(--blue); }
  .badge.conn-usb { background: var(--ok-bg); border-color: oklch(0.34 0.10 145); color: var(--ok-text); }
  .badge.conn-bt  { background: oklch(0.22 0.10 260); border-color: oklch(0.36 0.12 260); color: oklch(0.78 0.12 260); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .ctrl-active-tag {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--amber);
  }

  /* Misc */
  .hex-stream {
    font-family: ui-monospace, monospace;
    font-size: 0.71rem;
    color: oklch(0.60 0.10 145);
    background: var(--bg);
    padding: 10px 12px;
    border-radius: 2px;
    border: 1px solid var(--border);
    overflow-x: auto;
    white-space: nowrap;
    min-height: 2.5em;
  }
  details > summary {
    cursor: pointer;
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-2);
    margin-bottom: 8px;
    user-select: none;
  }
  details > summary:hover { color: var(--text); }
  .cam-row {
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 12px;
    margin-bottom: 8px;
    background: var(--surface-2);
  }
  .sony-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-top:12px; min-width:0; }
  .sony-widget { border:1px solid var(--border-strong); background:var(--surface-2); padding:8px; min-width:0; }
  .sony-widget__head { display:flex; justify-content:space-between; gap:8px; margin-bottom:6px; }
  .sony-widget__id { overflow-wrap:anywhere; }
  .sony-preview { position:relative; aspect-ratio:16 / 9; background:#000; overflow:hidden; }
  .sony-preview img { width:100%; height:100%; object-fit:contain; display:block; }
  .sony-preview-loading::after { content:'Live preview loading…'; position:absolute; inset:50% auto auto 50%; transform:translate(-50%,-50%); color:var(--text-2); white-space:nowrap; }
  .sony-preview-stale::after { content:'STALE'; position:absolute; top:8px; right:8px; padding:3px 6px; background:var(--warn-bg); color:var(--warn-text); }
  .sony-crosshair { position:absolute; width:18px; height:18px; border:2px solid var(--amber); border-radius:50%; transform:translate(-50%,-50%); pointer-events:none; display:none; }
  .sony-controls { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:10px; }
  .sony-controls label { display:grid; gap:3px; color:var(--text-2); font-size:.72rem; }
  .sony-touch-controls { display:flex; flex-wrap:wrap; align-items:end; gap:8px; margin-top:10px; }
  .sony-touch-controls label { width:90px; color:var(--text-2); }
  .sony-widget select, .sony-widget input, .sony-widget button { min-height:44px; }
  .sony-widget select:disabled { opacity:.55; cursor:not-allowed; }
  @media (max-width:1100px) { .sony-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:700px) { .sony-grid { grid-template-columns:1fr; } }
  @media (max-width:319px) {
    .sony-controls { grid-template-columns:1fr; }
    .sony-widget__head { flex-direction:column; }
    .sony-touch-controls { display:grid; grid-template-columns:1fr; min-width:0; }
    .sony-touch-controls label { width:auto; min-width:0; }
  }

  /* Appearance setting */
  .appearance-setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 12px 0 18px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }
  .appearance-setting__copy { display: grid; gap: 3px; }
  .appearance-setting__label { color: var(--text); font-weight: 650; }
  .appearance-setting__hint { color: var(--text-2); font-size: .74rem; }
  .theme-switch {
    position: relative;
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
  }
  .theme-switch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .theme-switch__track {
    display: block;
    width: 100%;
    height: 24px;
    border: 1px solid var(--border-strong);
    background: var(--surface-3);
  }
  .theme-switch__track::after {
    content: "";
    display: block;
    width: 16px;
    height: 16px;
    margin: 3px;
    background: var(--text-2);
    transition: transform .12s ease-out, background-color .12s ease-out;
  }
  .theme-switch input:checked + .theme-switch__track { border-color: #775a29; background: #1c1810; }
  .theme-switch input:checked + .theme-switch__track::after { transform: translateX(20px); background: var(--amber); }
  .theme-switch input:focus-visible + .theme-switch__track { outline: 2px solid var(--amber); outline-offset: 3px; }

  /* Broadcast console pass — local-first, dense, and legible under pressure. */
  :root {
    color-scheme: dark;
    --bg: #0b0e10;
    --surface: #11161a;
    --surface-2: #171d21;
    --surface-3: #1d252a;
    --border: #2a343a;
    --border-strong: #3b474e;
    --text: #edf1f2;
    --text-2: #93a0a7;
    --amber: #ffb547;
    --blue: #55a7ff;
    --live-bg: #3a1418;
    --live-text: #ff8a91;
    --pvw-bg: #12301f;
    --pvw-text: #78dfa1;
    --ok-bg: #14291e;
    --ok-text: #74d69a;
    --err-bg: #34171a;
    --err-text: #ff8a91;
    --warn-bg: #332713;
    --warn-text: #ffc66d;
    --label-font: "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif;
    --body-font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #e8edef;
    --surface: #ffffff;
    --surface-2: #f3f6f7;
    --surface-3: #e3e9eb;
    --border: #cbd4d8;
    --border-strong: #a8b5bb;
    --text: #172126;
    --text-2: #53636b;
    --amber: #9b5b00;
    --blue: #0869b5;
    --live-bg: #fbe8e9;
    --live-text: #a5222b;
    --pvw-bg: #e3f4e9;
    --pvw-text: #17683a;
    --ok-bg: #e3f4e9;
    --ok-text: #17683a;
    --err-bg: #fbe8e9;
    --err-text: #a5222b;
    --warn-bg: #f8ecd7;
    --warn-text: #855000;
  }
  html { background: var(--bg); scroll-behavior: smooth; }
  body {
    min-height: 100vh;
    padding: 0 28px 48px;
    font-family: var(--body-font);
    font-size: 0.875rem;
    line-height: 1.45;
    background:
      linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
      var(--bg);
    background-size: 100% 32px;
  }
  button, input, select { font: inherit; }
  .skip-link {
    position: fixed; top: 8px; left: 8px; z-index: 20;
    transform: translateY(-150%); padding: 8px 12px;
    background: var(--amber); color: #161006; font-weight: 700;
  }
  .skip-link:focus { transform: translateY(0); }
  .app-shell { width: min(1440px, 100%); margin: 0 auto; }
  .app-header {
    min-height: 72px; align-items: center; justify-content: space-between;
    padding: 14px 0; border-bottom-color: var(--border-strong);
  }
  .brand-lockup { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .brand-mark {
    display: grid; place-items: center; width: 38px; height: 38px;
    border: 1px solid #775a29; color: var(--amber); background: #1c1810;
    font: 800 0.7rem/1 var(--label-font); letter-spacing: .1em;
  }
  .app-title {
    font-family: var(--label-font); font-size: 1.25rem; line-height: 1;
    letter-spacing: .12em;
  }
  .app-subtitle { display: block; margin-top: 5px; font-family: var(--label-font); }
  .header-meta { display: flex; align-items: center; gap: 18px; }
  .sync-state { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: .72rem; }
  .sync-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok-text); }
  .clock {
    min-width: 72px; color: var(--text); font: 600 .85rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .04em; text-align: right;
  }
  .status-bar {
    display: grid; grid-template-columns: repeat(3, minmax(170px, 1fr)) minmax(210px, .8fr);
    gap: 8px; padding: 14px 0; border-bottom: 0;
  }
  .signal-card, .health-stack {
    min-height: 86px; border: 1px solid var(--border-strong); background: var(--surface);
  }
  .signal-card { position: relative; overflow: hidden; padding: 12px 14px 13px 18px; }
  .signal-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: currentColor; }
  .signal-card--live { color: var(--live-text); background: linear-gradient(90deg, #321418, var(--surface) 58%); }
  .signal-card--pvw { color: var(--pvw-text); background: linear-gradient(90deg, #11291c, var(--surface) 58%); }
  .signal-card--ctrl { color: var(--blue); background: linear-gradient(90deg, #10253a, var(--surface) 58%); }
  :root[data-theme="light"] body { background-image: linear-gradient(rgba(23,33,38,.035) 1px, transparent 1px); }
  :root[data-theme="light"] .brand-mark { border-color: #c48a34; background: #fff4df; }
  :root[data-theme="light"] .tab-bar { background: #dde4e7; }
  :root[data-theme="light"] .signal-card--live { background: linear-gradient(90deg, var(--live-bg), var(--surface) 58%); }
  :root[data-theme="light"] .signal-card--pvw { background: linear-gradient(90deg, var(--pvw-bg), var(--surface) 58%); }
  :root[data-theme="light"] .signal-card--ctrl { background: linear-gradient(90deg, #e2effb, var(--surface) 58%); }
  :root[data-theme="light"] .row-visca { background: #eef5fb; }
  :root[data-theme="light"] .row-atem { background: #faf4e8; }
  :root[data-theme="light"] .row-dji { background: #f2effb; }
  .signal-card__label, .health-label, .cam-card__index {
    display: block; color: currentColor; opacity: .78;
    font: 700 .62rem/1 var(--label-font); letter-spacing: .16em; text-transform: uppercase;
  }
  .signal-card__value {
    display: block; margin-top: 10px; color: var(--text);
    font: 700 1.25rem/1.1 var(--label-font); letter-spacing: .035em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .signal-card__detail { display: block; margin-top: 6px; color: var(--text-2); font-size: .68rem; }
  .health-stack { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); }
  .health-item { padding: 13px 12px; background: var(--surface); min-width: 0; }
  .health-value { display: flex; align-items: center; gap: 7px; margin-top: 9px; color: var(--text); font-weight: 650; font-size: .74rem; }
  .health-value::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
  .health-item--ok .health-value { color: var(--ok-text); }
  .health-item--err .health-value { color: var(--err-text); }
  .tab-bar {
    gap: 0; padding-top: 0; border: 1px solid var(--border); background: #0e1214;
    overflow-x: auto; scrollbar-width: thin;
  }
  .tab-btn {
    flex: 0 0 auto; min-height: 44px; padding: 0 22px; margin: 0;
    border: 0; border-right: 1px solid var(--border); border-radius: 0;
    font-family: var(--label-font); transition: none;
  }
  .tab-btn.active { border-color: var(--border); box-shadow: inset 0 -3px 0 var(--amber); }
  .tab-btn:hover { background: var(--surface-2); }
  :focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  .tab-btn:focus-visible { outline-offset: -3px; }
  .panel {
    border-top: 0; border-radius: 0; padding: 22px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.015);
  }
  .panel-heading {
    display: flex; align-items: end; justify-content: space-between; gap: 16px;
    margin-bottom: 14px;
  }
  .panel-heading h2 { margin: 0; color: var(--text); font-size: .78rem; }
  .panel-kicker { color: var(--text-2); font-size: .72rem; }
  .cam-grid { grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 8px; }
  .cam-card {
    min-height: 136px; padding: 13px 14px; gap: 0; border-color: var(--border-strong);
    background: var(--surface-2); position: relative;
  }
  .cam-card::after { content: ""; position: absolute; inset: auto 0 0; height: 3px; background: var(--border); }
  .cam-card--program::after { background: var(--live-text); }
  .cam-card--preview::after { background: var(--pvw-text); }
  .cam-card--controlled { box-shadow: inset 0 0 0 1px var(--blue); }
  .cam-card__meta { display: flex; justify-content: space-between; gap: 8px; }
  .cam-card__status { display: flex; align-items: center; gap: 6px; padding: 0; font-size: .65rem; }
  .cam-card__status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .cam-card__name { margin-top: 18px; font-family: var(--label-font); font-size: 1.04rem; }
  .cam-card__roles { min-height: 22px; display: flex; flex-wrap: wrap; gap: 4px; margin-top: 12px; }
  .role-tag {
    padding: 3px 6px; border: 1px solid currentColor; font: 700 .62rem/1 var(--label-font);
    letter-spacing: .1em; text-transform: uppercase;
  }
  .role-tag--program { color: var(--live-text); }
  .role-tag--preview { color: var(--pvw-text); }
  .role-tag--control { color: var(--blue); }
  .role-tag--standby { color: var(--text-2); border-color: var(--border); }
  .mode-row { border-top: 1px solid var(--border); padding-top: 14px; }
  .mode-chip { min-height: 27px; display: inline-flex; align-items: center; border-radius: 0; }
  .cfg-input { min-height: 36px; border-radius: 0; font-family: var(--body-font); }
  .cfg-input:hover { border-color: var(--border-strong); }
  .cfg-input:focus { outline: 2px solid var(--amber); outline-offset: -2px; border-color: var(--amber); }
  .btn, .btn-sm, .filter-btn { min-height: 36px; border-radius: 0; font-family: var(--label-font); }
  .btn-sm, .filter-btn { min-height: 30px; }
  .btn:disabled, .btn-sm:disabled { opacity: .45; cursor: not-allowed; }
  .log-wrap { border-radius: 0; }
  .empty-state, .error-state { padding: 28px; border: 1px dashed var(--border-strong); color: var(--text-2); text-align: center; }
  .error-state { color: var(--err-text); }
  .loading-state { color: var(--text-2); padding: 24px 0; }
  @media (max-width: 980px) {
    .status-bar { grid-template-columns: repeat(3, 1fr); }
    .health-stack { grid-column: 1 / -1; min-height: 68px; }
    .cam-grid { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
  }
  @media (max-width: 640px) {
    body { padding: 0 12px 28px; }
    .app-header { min-height: 64px; }
    .brand-mark { display: none; }
    .app-subtitle, .sync-state { display: none; }
    .header-meta { gap: 8px; }
    .status-bar { grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 0; }
    .signal-card { min-height: 78px; padding: 11px 11px 11px 15px; }
    .signal-card--ctrl { grid-column: 1 / -1; }
    .signal-card__value { font-size: 1.05rem; margin-top: 8px; }
    .health-stack { grid-column: 1 / -1; }
    .tab-btn { flex: 1 0 auto; padding-inline: 14px; }
    .panel { padding: 14px 12px; }
    .cam-grid { grid-template-columns: 1fr 1fr; gap: 6px; }
    .cam-card { min-height: 124px; padding: 11px; }
    .cam-card__name { margin-top: 15px; }
    .log-meta { align-items: flex-start; gap: 10px; flex-direction: column; }
    .log-wrap { height: 58vh; overflow: auto; }
    .activity-table { min-width: 760px; }
    table:not(.activity-table) { display: block; overflow-x: auto; }
  }
  @media (max-width: 390px) {
    .cam-grid { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-shell">
<header class="app-header">
  <div class="brand-lockup">
    <span class="brand-mark" aria-hidden="true">FPS</span>
    <div>
      <h1 class="app-title"><span>FPS</span> CamControl</h1>
      <span class="app-subtitle">Production Camera Controller</span>
    </div>
  </div>
  <div class="header-meta" aria-label="System clock and update status">
    <span class="sync-state"><span class="sync-dot" aria-hidden="true"></span><span id="sync-label">Monitoring</span></span>
    <time class="clock" id="system-clock"></time>
  </div>
</header>

<div class="status-bar" id="status-bar" aria-live="polite" aria-label="Live production status"></div>

<div class="tab-bar" role="tablist" aria-label="CamControl sections">
  <button class="tab-btn active" id="tab-btn-status" role="tab" aria-selected="true" aria-controls="tab-status" onclick="switchTab('status',this)">Status</button>
  <button class="tab-btn" id="tab-btn-log" role="tab" aria-selected="false" aria-controls="tab-log" onclick="switchTab('log',this)">Activity Log</button>
  <button class="tab-btn" id="tab-btn-rigs" role="tab" aria-selected="false" aria-controls="tab-rigs" onclick="switchTab('rigs',this)">Device Config</button>
  <button class="tab-btn" id="tab-btn-profiles" role="tab" aria-selected="false" aria-controls="tab-profiles" onclick="switchTab('profiles',this)">Profiles (classic)</button>
  <button class="tab-btn" id="tab-btn-controllers" role="tab" aria-selected="false" aria-controls="tab-controllers" onclick="switchTab('controllers',this)">Controllers</button>
</div>

<main id="main-content">
<div class="panel tab-panel active" id="tab-status" role="tabpanel" aria-labelledby="tab-btn-status">
  <div class="panel-heading"><div><h2>Camera Network</h2><span class="panel-kicker">Signal roles and device health</span></div></div>
  <div id="status-content"><div class="loading-state">Reading production state…</div></div>
  <section id="sony-cameras" aria-label="Connected Sony cameras"><div class="section-header">Sony Cameras</div><div id="sony-dashboard-status" aria-live="polite"></div><div class="sony-grid" id="sony-grid-root"></div></section>
</div>

<div class="panel tab-panel" id="tab-log" role="tabpanel" aria-labelledby="tab-btn-log" hidden>
  <div class="log-meta">
    <div class="filter-bar">
      <span class="filter-label">Filter</span>
      <button class="filter-btn active" data-filter="ALL" onclick="setLogFilter('ALL',this)">All</button>
      <button class="filter-btn" data-filter="VISCA" onclick="setLogFilter('VISCA',this)">VISCA</button>
      <button class="filter-btn" data-filter="DJI-BRIDGE" onclick="setLogFilter('DJI-BRIDGE',this)">DJI</button>
      <button class="filter-btn" data-filter="ATEM" onclick="setLogFilter('ATEM',this)">ATEM</button>
      <button class="filter-btn" data-filter="System" onclick="setLogFilter('System',this)">System</button>
      <div class="filter-sep"></div>
      <button class="filter-btn" id="filter-hide-probe" onclick="toggleHideProbe(this)">Hide Probes</button>
    </div>
    <button class="btn-sm" onclick="clearActivityLog()">Clear Log</button>
  </div>
  <div class="log-wrap" id="activity-log-wrap">
    <table class="activity-table">
      <thead><tr>
        <th>Time</th><th>Device</th><th>Input</th><th>Command</th>
        <th>Proto</th><th>Message</th><th>Target</th><th>IP</th>
      </tr></thead>
      <tbody id="activity-log-body"></tbody>
    </table>
  </div>
</div>

<div class="panel tab-panel" id="tab-rigs" role="tabpanel" aria-labelledby="tab-btn-rigs" hidden>
  <div class="appearance-setting">
    <div class="appearance-setting__copy">
      <span class="appearance-setting__label" id="dark-mode-label">Dark mode</span>
      <span class="appearance-setting__hint">Use the low-light control-room palette.</span>
    </div>
    <label class="theme-switch">
      <input id="dark-mode-toggle" type="checkbox" role="switch" aria-labelledby="dark-mode-label" checked>
      <span class="theme-switch__track" aria-hidden="true"></span>
    </label>
  </div>
  <div id="rigs-root"></div>
</div>
<div class="panel tab-panel" id="tab-profiles" role="tabpanel" aria-labelledby="tab-btn-profiles" data-editing="false" hidden>
  <div class="log-meta">
    <h2 style="margin:0">Environment Profiles</h2>
    <span id="profiles-save-status" style="font-size:0.78rem;color:var(--text-2)"></span>
  </div>
  <p class="rigs-info" style="margin:6px 0 10px;color:var(--text-2)">Profiles are now managed in <strong>Device Config</strong> (the profile bar at the top of its list). This older screen remains only for reordering rigs and changing which device fills a rig.</p>
  <div id="profiles-content">Loading&hellip;</div>
</div>

<div class="panel tab-panel" id="tab-controllers" role="tabpanel" aria-labelledby="tab-btn-controllers" hidden>
  <div id="controllers-content">Loading&hellip;</div>
</div>
</main>
</div>

<script src="/ui/rigs/rigsModel.js" defer></script>
<script src="/ui/rigs/rigs.js" defer></script>
<script src="/ui/tracking/tracking.js" defer></script>
<script>
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.classList.remove('active');
    p.hidden = true;
  });
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  var panel = document.getElementById('tab-' + name);
  panel.classList.add('active');
  panel.hidden = false;
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
}

document.querySelector('.tab-bar').addEventListener('keydown', function(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  var tabs = Array.from(document.querySelectorAll('.tab-btn'));
  var current = tabs.indexOf(document.activeElement);
  var next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

var darkModeToggle = document.getElementById('dark-mode-toggle');
darkModeToggle.checked = document.documentElement.dataset.theme !== 'light';
document.querySelector('meta[name="theme-color"]').content = darkModeToggle.checked ? '#0b0e10' : '#e8edef';
darkModeToggle.addEventListener('change', function() {
  var theme = darkModeToggle.checked ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0b0e10' : '#e8edef';
  try { localStorage.setItem('fps-theme', theme); } catch (_) {}
});

function updateClock() {
  var el = document.getElementById('system-clock');
  if (el) {
    var now = new Date();
    el.dateTime = now.toISOString();
    el.textContent = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
updateClock();
setInterval(updateClock, 1000);

async function refresh() {
  try {
    const [status, config] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
    ]);
    renderStatus(status, config);
    document.getElementById('sync-label').textContent = 'Monitoring';
    document.querySelector('.sync-dot').style.background = 'var(--ok-text)';
  } catch(e) {
    document.getElementById('status-content').innerHTML = '<div class="error-state" role="alert">Status unavailable. CamControl will retry automatically.</div>';
    document.getElementById('sync-label').textContent = 'Status offline';
    document.querySelector('.sync-dot').style.background = 'var(--err-text)';
  }
}

function signalCard(label, value, cls, detail) {
  return '<section class="signal-card signal-card--' + cls + '">' +
    '<span class="signal-card__label">' + label + '</span>' +
    '<strong class="signal-card__value">' + esc(value) + '</strong>' +
    '<span class="signal-card__detail">' + detail + '</span>' +
  '</section>';
}

function healthItem(label, value, ok) {
  return '<div class="health-item health-item--' + (ok ? 'ok' : 'err') + '">' +
    '<span class="health-label">' + label + '</span>' +
    '<span class="health-value">' + esc(value) + '</span>' +
  '</div>';
}

// Turn the three camera-keyed maps in /api/status into one label per camera.
// A camera reached through a Pi bridge has two things that can be broken and
// they need different remedies, so "Disconnected" alone is not good enough:
// a missing bridge means fix the network or the Pi, a missing gimbal means go
// switch it on. Cameras with no entry in cameraGimbalAttached (VISCA) have no
// second stage at all and keep the plain connected/disconnected wording.
function cameraLinkState(s, id) {
  const attachedMap = s.cameraGimbalAttached || {};
  const connected = !!(s.cameraConnected && s.cameraConnected[id]);
  if (!Object.prototype.hasOwnProperty.call(attachedMap, id)) {
    return { cls: connected ? 'ok' : 'err', text: connected ? 'Connected' : 'Disconnected', hint: '' };
  }
  const bridgeUp = !!(s.cameraBridgeReachable && s.cameraBridgeReachable[id]);
  if (!bridgeUp) {
    return { cls: 'err', text: 'Bridge Offline', hint: 'Cannot reach the Pi bridge' };
  }
  if (!attachedMap[id]) {
    return { cls: 'warn', text: 'Gimbal Off', hint: 'Bridge up, no gimbal attached' };
  }
  return { cls: 'ok', text: 'Connected', hint: '' };
}

function renderStatus(s, c) {
  const cams = c.cameras || [];
  const camLabel = id => cams.length ? ((cams.find(x => x.id === id) || {}).label || id) : 'Not configured';
  const hint = text => cams.length ? text : 'Add a camera in Device Config';

  document.getElementById('status-bar').innerHTML =
    signalCard('Program / Live', camLabel(s.programCamera), 'live', hint('Currently on air')) +
    signalCard('Preview / Next', camLabel(s.previewCamera), 'pvw', hint('Ready for transition')) +
    signalCard('PTZ Control', camLabel(s.controlledCamera), 'ctrl', hint('Receiving camera input')) +
    '<section class="health-stack" aria-label="Connection health">' +
      healthItem('ATEM', s.atemConnected ? 'Online' : 'Offline', s.atemConnected) +
      healthItem('Controller', s.controllerConnected ? (s.activeControllerProfile || 'Online') : 'Offline', s.controllerConnected) +
    '</section>';

  const speed = c.speeds && c.speeds.presets && c.speeds.presets[s.speedPreset]
    ? c.speeds.presets[s.speedPreset].name : 'Unknown';

  let camGrid = '<div class="cam-grid">';
  for (var i = 0; i < cams.length; i++) {
    const cam = cams[i];
    const ok = s.cameraConnected && s.cameraConnected[cam.id];
    const isProgram = s.programCamera === cam.id;
    const isPreview = s.previewCamera === cam.id;
    const isControlled = s.controlledCamera === cam.id;
    const cardClasses = [
      'cam-card', ok ? 'cam-card--ok' : 'cam-card--err',
      isProgram ? 'cam-card--program' : '',
      isPreview ? 'cam-card--preview' : '',
      isControlled ? 'cam-card--controlled' : '',
    ].filter(Boolean).join(' ');
    const roles = [
      isProgram ? '<span class="role-tag role-tag--program">Program</span>' : '',
      isPreview ? '<span class="role-tag role-tag--preview">Preview</span>' : '',
      isControlled ? '<span class="role-tag role-tag--control">Control</span>' : '',
    ].filter(Boolean).join('') || '<span class="role-tag role-tag--standby">Standby</span>';
    const link = cameraLinkState(s, cam.id);
    camGrid +=
      '<div class="' + cardClasses + '">' +
        '<div class="cam-card__meta"><span class="cam-card__index">CAM ' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="cam-card__status">' + (ok ? 'Online' : 'Offline') + '</span></div>' +
        '<span class="cam-card__name">' + esc(cam.label) + '</span>' +
        '<span class="cam-card__status">' + esc(link.text) + '</span>' +
        (link.hint ? '<span class="cam-card__hint">' + esc(link.hint) + '</span>' : '') +
        '<div class="cam-card__roles">' + roles + '</div>' +
      '</div>';
  }
  camGrid += '</div>';
  if (cams.length === 0) camGrid = '<div class="empty-state">No cameras configured. Add a camera in Device Config.</div>';

  const modes = [
    '<span class="mode-chip mode-chip--speed">Speed: ' + esc(speed) + '</span>',
    s.precisionMode ? '<span class="mode-chip mode-chip--on">Precision</span>' : '',
    s.sprintMode    ? '<span class="mode-chip mode-chip--on">Sprint</span>' : '',
    s.lowerThirdsActive ? '<span class="mode-chip mode-chip--on">Lower Thirds</span>' : '',
    s.lastPresetNotification ? '<span class="mode-chip mode-chip--on">Preset: ' + esc(s.lastPresetNotification) + '</span>' : '',
  ].filter(Boolean).join('');

  document.getElementById('status-content').innerHTML = camGrid + '<div class="mode-row">' + modes + '</div>';
}

// ---- Sony dashboard (all browser traffic remains on /api/sony/*) ----
var SONY_PROPERTIES = ['aperture','shutter-speed','iso','white-balance','focus-mode','focus-area'];
var sonyWidgets = {};
var sonyDiscovered = [];
var sonySidecar = null;

async function refreshSony() {
  try {
    var data = await fetch('/api/sony/status').then(function(r) { if (!r.ok) throw new Error(); return r.json(); });
    sonySidecar = data.sidecar || null;
    sonyDiscovered = data.cameras || [];
    sonyDashboardStatus('');
    renderSonyCameras(sonyDiscovered.filter(function(camera) { return camera.state === 'connected' || camera.connected; }));
  } catch (_) {
    sonySidecar = null;
    sonyDiscovered = [];
    sonyDashboardStatus('Sony camera service unavailable. Existing controls are unaffected.', true);
    renderSonyCameras([]);
  }
}

function renderSonyCameras(cameras) {
  var root = document.getElementById('sony-grid-root');
  var liveIds = {};
  cameras.forEach(function(camera) { liveIds[camera.id] = true; });
  Object.keys(sonyWidgets).forEach(function(id) {
    if (!liveIds[id]) {
      var state = sonyWidgets[id]; state.active = false;
      if (state.timer) clearTimeout(state.timer);
      if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
      if (state.article) state.article.remove();
      delete sonyWidgets[id];
    }
  });
  cameras.forEach(function(camera) {
    var created = !sonyWidgets[camera.id];
    if (created) {
      sonyWidgets[camera.id] = { active:true, confirmed:{}, delay:125, frameUrl:null, loadingProperties:false, previewAnnouncementState:'loading' };
      var holder = document.createElement('div'); holder.innerHTML = sonyWidgetHtml(camera); var article = holder.firstChild; root.appendChild(article); sonyWidgets[camera.id].article = article;
      loadSonyProperties(camera.id);
    } else updateSonyWidget(camera);
    startSonyPreview(camera.id);
  });
  if (window.fpsTracking) window.fpsTracking.renderWidgets();
}

function sonyDashboardStatus(message, error) {
  var element = document.getElementById('sony-dashboard-status');
  element.className = error ? 'error-state' : ''; element.textContent = message;
}

function updateSonyWidget(camera) {
  var article = sonyWidgets[camera.id] && sonyWidgets[camera.id].article; if (!article) return;
  article.querySelector('.sony-widget__title').textContent = camera.name || camera.model || 'Sony camera';
  article.querySelector('.sony-widget__transport').textContent = camera.connectionType || 'Unknown transport';
  article.querySelector('.sony-widget__connection').textContent = camera.status || 'Connected';
  article.querySelector('.sony-preview img').alt = 'Live preview from ' + (camera.name || camera.model || camera.id);
}

function sonyWidgetHtml(camera) {
  var key = camera.id.replace(/:/g, '-');
  var controls = SONY_PROPERTIES.map(function(name) {
    return '<label>' + esc(name.replace(/-/g, ' ')) + '<select class="cfg-input" id="sony-' + esc(key) + '-' + name + '" data-id="' + esc(camera.id) + '" data-property="' + name + '" disabled onchange="saveSonyProperty(this)"><option>Unavailable</option></select></label>';
  }).join('');
  return '<article class="sony-widget" data-camera-id="' + esc(camera.id) + '" aria-labelledby="sony-heading-' + esc(key) + '">' +
    '<div class="sony-widget__head"><div><h3 class="sony-widget__title" id="sony-heading-' + esc(key) + '">' + esc(camera.name || camera.model || 'Sony camera') + '</h3><small class="sony-widget__id">' + esc(camera.id) + '</small></div><div><span class="sony-widget__transport">' + esc(camera.connectionType || 'Unknown transport') + '</span><br><span class="sony-widget__connection" style="color:var(--ok-text)">' + esc(camera.status || 'Connected') + '</span></div></div>' +
    '<div class="sony-preview sony-preview-loading" id="sony-preview-' + esc(key) + '" role="region" aria-labelledby="sony-heading-' + esc(key) + '"><img alt="Live preview from ' + esc(camera.model || camera.id) + '" data-id="' + esc(camera.id) + '"><span class="sony-crosshair" aria-hidden="true"></span></div>' +
    '<div class="sony-controls">' + controls + '</div>' +
    '<div class="sony-touch-controls"><label>X (0–1)<input class="cfg-input" id="sony-x-' + esc(key) + '" type="number" min="0" max="1" step="0.01" value="0.5"></label><label>Y (0–1)<input class="cfg-input" id="sony-y-' + esc(key) + '" type="number" min="0" max="1" step="0.01" value="0.5"></label><button class="btn-sm" data-id="' + esc(camera.id) + '" onclick="applySonyTouchInputs(this.dataset.id)">Apply touch point</button></div>' +
    '<p>Camera Touch Function determines focus vs tracking.</p><div id="sony-status-' + esc(key) + '" aria-live="polite">Live preview loading. Loading camera controls…</div></article>';
}

// Quick retries while a camera settles, then a slow poll for as long as the widget exists (camera connected).
function retrySonyProperties(id, state, message) {
  state.propertyRetries = (state.propertyRetries || 0) + 1;
  var delay = state.propertyRetries <= 6 ? 2000 * state.propertyRetries : 15000;
  setTimeout(function() { if (sonyWidgets[id] === state && state.active) loadSonyProperties(id); }, delay);
  sonyStatus(id, message);
}

async function loadSonyProperties(id) {
  var state = sonyWidgets[id]; if (!state || state.loadingProperties) return;
  state.loadingProperties = true;
  try {
    var response = await fetch('/api/sony/cameras/' + id + '/properties');
    if (!response.ok) throw new Error('Properties unavailable');
    var body = await response.json();
    if (sonyWidgets[id] !== state || !state.active) return;
    var properties = (body.data && body.data.properties) || body.properties || {};
    var incomplete = false;
    SONY_PROPERTIES.forEach(function(name) {
      var property = properties[name];
      var select = document.getElementById('sony-' + id.replace(/:/g, '-') + '-' + name);
      if (!select) return;
      if (!property || !Array.isArray(property.available_values)) { incomplete = true; select.innerHTML = '<option>Unavailable</option>'; select.disabled = true; return; }
      state.confirmed[name] = property.current_value;
      // Read-only on this camera/lens (e.g. aperture set by a lens ring): show the value, greyed out.
      if (property.available_values.length === 0 && property.current_formatted != null) {
        select.innerHTML = '<option>' + esc(property.current_formatted) + ' (read-only)</option>';
        select.disabled = true; select.title = 'Read-only: set on the camera or lens';
        return;
      }
      select.title = property.writable === true ? '' : 'Read-only: set on the camera or lens';
      select.innerHTML = property.available_values.map(function(item) { return '<option value="' + esc(JSON.stringify(item.value)) + '"' + (typeof item.hex_value === 'string' ? ' data-hex="' + esc(item.hex_value) + '"' : '') + '>' + esc(item.formatted != null ? item.formatted : item.value) + '</option>'; }).join('');
      select.value = JSON.stringify(property.current_value);
      select.disabled = property.writable !== true || property.available_values.length === 0;
    });
    // A camera that just (re)connected may not report every setting yet; keep asking while it stays connected.
    if (incomplete) retrySonyProperties(id, state, 'Waiting for camera settings\u2026');
    else { state.propertyRetries = 0; sonyStatus(id, 'Controls confirmed.'); }
  } catch (error) {
    // A request that failed or timed out (the service is busy connecting other cameras) must not leave the
    // dropdowns on "Unavailable" until the page is reloaded.
    retrySonyProperties(id, state, 'Could not read camera settings yet; retrying\u2026');
  }
  finally { if (sonyWidgets[id] === state) state.loadingProperties = false; }
}

async function saveSonyProperty(select) {
  var id = select.dataset.id, name = select.dataset.property, state = sonyWidgets[id];
  if (!state || select.disabled) return;
  select.disabled = true;
  try {
    // The Sony API takes the camera's hex value as a string; raw numbers are rejected.
    var chosen = select.options[select.selectedIndex];
    var sendValue = chosen && chosen.dataset.hex ? chosen.dataset.hex : JSON.parse(select.value);
    var response;
    for (var attempt = 0; attempt < 4; attempt++) {
      response = await fetch('/api/sony/cameras/' + id + '/properties/' + name, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ value:sendValue }) });
      // 503 means the camera is handling another action; wait briefly and try again.
      if (response.status !== 503) break;
      await new Promise(function(resolve) { setTimeout(resolve, 400 * (attempt + 1)); });
    }
    if (!response.ok) {
      var detail = ''; try { detail = (await response.json()).error || ''; } catch (_) {}
      throw new Error('HTTP ' + response.status + (detail ? ' ' + detail : ''));
    }
    await loadSonyProperties(id);
    sonyStatus(id, name.replace(/-/g, ' ') + ' saved.');
  } catch (error) {
    select.value = JSON.stringify(state.confirmed[name]);
    select.disabled = false;
    sonyStatus(id, name.replace(/-/g, ' ') + ' save failed (' + (error && error.message ? error.message : 'unknown error') + '); restored confirmed value.', true);
  }
}

async function startSonyPreview(id) {
  var state = sonyWidgets[id]; if (!state || state.polling) return;
  state.polling = true;
  try {
    var response = await fetch('/api/sony/cameras/' + id + '/live-view/start', { method:'POST' });
    if (!response.ok) throw new Error('Live preview failed to start');
  } catch (_) { state.polling = false; var preview=document.getElementById('sony-preview-'+id.replace(/:/g,'-')); if(preview){preview.classList.remove('sony-preview-loading');preview.classList.add('sony-preview-stale');} sonyStatus(id, 'Live preview failed to start.', true); return; }
  pollSonyFrame(id);
}

async function pollSonyFrame(id) {
  var state = sonyWidgets[id]; if (!state || !state.active) return;
  if (document.hidden) { state.timer = setTimeout(function() { pollSonyFrame(id); }, 500); return; }
  var preview = document.getElementById('sony-preview-' + id.replace(/:/g, '-'));
  var image = preview && preview.querySelector('img');
  try {
    var response = await fetch('/api/sony/cameras/' + id + '/live-view/frame', { cache:'no-store' });
    if (!response.ok) throw new Error();
    var nextUrl = URL.createObjectURL(await response.blob());
    if (sonyWidgets[id] !== state || !state.active) { URL.revokeObjectURL(nextUrl); return; }
    var previousUrl = state.frameUrl;
    state.frameUrl = nextUrl; image.src = nextUrl;
    image.onload = function() { if (previousUrl) URL.revokeObjectURL(previousUrl); };
    preview.classList.remove('sony-preview-loading', 'sony-preview-stale'); state.delay = 125;
    if (state.previewAnnouncementState === 'loading') sonyStatus(id, 'Live preview ready.');
    else if (state.previewAnnouncementState === 'stale') sonyStatus(id, 'Live preview recovered.');
    state.previewAnnouncementState = 'ready';
  } catch (_) { if (preview) { preview.classList.remove('sony-preview-loading'); preview.classList.add('sony-preview-stale'); } if (state.previewAnnouncementState !== 'stale') sonyStatus(id, 'Live preview stale.', true); state.previewAnnouncementState = 'stale'; state.delay = Math.min(Math.max(state.delay * 2, 250), 4000); }
  if (sonyWidgets[id] === state && state.active) state.timer = setTimeout(function() { pollSonyFrame(id); }, state.delay);
}

function sonyContainedPoint(image, clientX, clientY) {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  var rect = image.getBoundingClientRect(), imageRatio = image.naturalWidth / image.naturalHeight, boxRatio = rect.width / rect.height;
  var width = boxRatio > imageRatio ? rect.height * imageRatio : rect.width;
  var height = boxRatio > imageRatio ? rect.height : rect.width / imageRatio;
  var left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
  return { x:(clientX-left)/width, y:(clientY-top)/height, px:clientX-rect.left, py:clientY-rect.top };
}

document.getElementById('sony-cameras').addEventListener('pointerup', function(event) {
  if (event.target.tagName !== 'IMG') return;
  var point = sonyContainedPoint(event.target, event.clientX, event.clientY);
  if (!point) return;
  showSonyPoint(event.target.dataset.id, point);
  sendSonyTouch(event.target.dataset.id, point.x, point.y);
});

function showSonyPoint(id, point) {
  var key = id.replace(/:/g, '-'), crosshair = document.querySelector('#sony-preview-' + key + ' .sony-crosshair');
  crosshair.style.left = point.px + 'px'; crosshair.style.top = point.py + 'px'; crosshair.style.display = 'block';
  document.getElementById('sony-x-' + key).value = point.x.toFixed(3); document.getElementById('sony-y-' + key).value = point.y.toFixed(3);
}
function applySonyTouchInputs(id) {
  var key=id.replace(/:/g, '-'), x=Number(document.getElementById('sony-x-'+key).value), y=Number(document.getElementById('sony-y-'+key).value);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x<0 || x>1 || y<0 || y>1) { sonyStatus(id, 'Touch X and Y must be between 0 and 1.', true); return; }
  sendSonyTouch(id, x, y);
}
async function sendSonyTouch(id, x, y) {
  try { var response=await fetch('/api/sony/cameras/'+id+'/touch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({normalized:{x:x,y:y}})}); if(!response.ok) throw new Error(); sonyStatus(id,'Touch point applied at '+x.toFixed(3)+', '+y.toFixed(3)+'.'); }
  catch (_) { sonyStatus(id,'Touch point failed.',true); }
}
function sonyStatus(id, message, error) { var el=document.getElementById('sony-status-'+id.replace(/:/g,'-')); if(el){el.textContent=message;el.style.color=error?'var(--err-text)':'var(--text-2)';} }

setInterval(refresh, 1000);
setInterval(refreshControllers, 2000);
setInterval(refreshSony, 5000);
// ---- Environment profiles ----
var HOTKEY_FOR_SLOT = ['X', 'A', 'B', 'Y'];
var profilesData = null;

async function refreshProfiles() {
  // Don't clobber in-progress edits under the 5s poll.
  if (document.getElementById('tab-profiles').dataset.editing === 'true') return;
  try {
    var data = await fetch('/api/profiles').then(function(r) { return r.json(); });
    profilesData = data;
    renderProfiles(data);
  } catch(e) { /* ignore */ }
}

function markProfilesEditing() {
  document.getElementById('tab-profiles').dataset.editing = 'true';
}

function discardProfileEdits() {
  document.getElementById('tab-profiles').dataset.editing = 'false';
  document.getElementById('profiles-save-status').textContent = '';
  refreshProfiles();
}

function renderProfiles(d) {
  var names = Object.keys(d.profiles || {});
  var devKeys = Object.keys(d.devices || {});
  if (!names.length) {
    document.getElementById('profiles-content').innerHTML =
      '<p style="color:var(--text-2)">No profiles defined. Add a <code>profiles:</code> block to config/devices.yaml.</p>';
    return;
  }

  var html = '';
  html += '<p style="color:var(--text-2);font-size:0.82rem;margin:0 0 10px">' +
    'A profile decides which device fills each camera slot. Slot order is the face-button order ' +
    '(1=X, 2=A, 3=B, 4=Y). Leave <em>ATEM Input</em> blank when a camera&#39;s video is not wired to the ' +
    'switcher: motion still works, but it cannot be taken live.</p>';

  for (var n = 0; n < names.length; n++) {
    var name = names[n];
    var p = d.profiles[name];
    var isActive = (name === d.activeProfile);

    html += '<div class="section-header" style="display:flex;align-items:center;gap:8px">' +
      '<span>' + esc(name) + '</span>' +
      (isActive
        ? '<span class="s-tile s-tile--live" style="padding:1px 6px;font-size:0.7rem">ACTIVE</span>'
        : '<button class="btn-sm" data-profile="' + esc(name) + '" onclick="loadProfile(this.dataset.profile,this)">Load</button>') +
      (p.label ? '<span style="color:var(--text-2);font-weight:400;font-size:0.78rem">' + esc(p.label) + '</span>' : '') +
      '</div>';

    html += '<table style="width:100%;margin-bottom:10px" data-profile="' + esc(name) + '"><tbody>';
    html += '<tr style="color:#888;font-size:0.75rem"><td style="width:90px">Slot</td><td>Device</td><td style="width:130px">ATEM Input</td></tr>';
    for (var i = 0; i < 4; i++) {
      var slot = (p.slots && p.slots[i]) ? p.slots[i] : null;
      html += '<tr class="slot-row">';
      html += '<td style="color:var(--text-2)">cam' + (i+1) + ' / <strong>' + HOTKEY_FOR_SLOT[i] + '</strong></td>';
      html += '<td><select class="cfg-input" name="slot-device" onchange="markProfilesEditing()" style="width:100%">';
      html += '<option value=""' + (!slot ? ' selected' : '') + '>&mdash; empty &mdash;</option>';
      for (var k = 0; k < devKeys.length; k++) {
        var dk = devKeys[k];
        var dl = (d.devices[dk] && d.devices[dk].label) ? d.devices[dk].label : dk;
        html += '<option value="' + esc(dk) + '"' + (slot && slot.device === dk ? ' selected' : '') + '>' + esc(dl) + '</option>';
      }
      html += '</select></td>';
      var iv = (slot && slot.inputId != null) ? slot.inputId : '';
      html += '<td><input class="cfg-input" name="slot-input" type="number" min="1" placeholder="not wired" oninput="markProfilesEditing()" value="' + iv + '" style="width:100%"></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  html += '<div style="display:flex;gap:8px;margin-top:6px">' +
    '<button class="btn" onclick="saveProfileSlots(this)">Save Profiles</button>' +
    '<button class="btn" onclick="discardProfileEdits()">Discard Changes</button>' +
    '</div>';

  document.getElementById('profiles-content').innerHTML = html;
}

async function loadProfile(name, btn) {
  if (!confirm('Switch the active profile to "' + name + '"? This reconnects cameras and changes what the X/A/B/Y buttons select.')) return;
  var old = btn.textContent;
  btn.textContent = 'Loading...';
  btn.disabled = true;
  try {
    var r = await fetch('/api/profiles/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: name }),
    }).then(function(x) { return x.json(); });
    if (!r.ok) throw new Error(r.error || 'switch failed');
    document.getElementById('profiles-save-status').textContent = 'Switched to ' + name;
    document.getElementById('tab-profiles').dataset.editing = 'false';
    await refreshProfiles();
  } catch(e) {
    alert('Could not switch profile: ' + e.message);
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function saveProfileSlots(btn) {
  var out = {};
  var tables = document.querySelectorAll('#profiles-content table[data-profile]');
  for (var t = 0; t < tables.length; t++) {
    var name = tables[t].getAttribute('data-profile');
    var existing = (profilesData && profilesData.profiles[name]) ? profilesData.profiles[name] : {};
    var rows = tables[t].querySelectorAll('tr.slot-row');
    var slots = [];
    for (var i = 0; i < rows.length; i++) {
      var dev = rows[i].querySelector('[name="slot-device"]').value;
      if (!dev) continue;  // empty slot: omit entirely
      var raw = rows[i].querySelector('[name="slot-input"]').value.trim();
      var slot = { device: dev };
      // Blank stays blank — do NOT default to an input, or an unwired camera
      // would silently become takeable to air.
      if (raw !== '') {
        var num = parseInt(raw, 10);
        if (!isNaN(num) && num > 0) slot.inputId = num;
      }
      slots.push(slot);
    }
    if (!slots.length) { alert('Profile "' + name + '" needs at least one slot.'); return; }
    out[name] = { label: existing.label, slots: slots };
  }

  btn.disabled = true;
  var st = document.getElementById('profiles-save-status');
  st.textContent = 'Saving...';
  try {
    var r = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: out, expectedVersion: profilesData ? profilesData.version : undefined }),
    }).then(function(x) { return x.json(); });
    if (r.conflict) { document.getElementById('tab-profiles').dataset.editing = 'false'; await refreshProfiles(); }
    if (!r.ok) throw new Error(r.error || 'save failed');
    st.textContent = 'Saved';
    document.getElementById('tab-profiles').dataset.editing = 'false';
    await refreshProfiles();
  } catch(e) {
    st.textContent = '';
    alert('Could not save profiles: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

refreshProfiles();
setInterval(refreshProfiles, 5000);
refresh();
refreshControllers();
refreshSony();

// ---- Controllers Tab ----
var remappingAction = null;
var wsController = null;
var hidDebugEnabled = false;

var ACTION_LABELS = {
  panTilt: 'Pan / Tilt',
  zoomIn: 'Zoom In (RT, hold)',
  zoomOut: 'Zoom Out (LT, hold)',
  cameraSelectLeft: 'Camera Select Left',
  cameraSelectRight: 'Camera Select Right',
  autoTransition: 'Take Live (Auto Transition)',
  precisionMode: 'Precision Mode (hold)',
  selectCam1: 'Select Camera 1 → standby',
  selectCam2: 'Select Camera 2 → standby',
  selectCam3: 'Select Camera 3 → standby',
  selectCam4: 'Select Camera 4 → standby',
  speedUp: 'Speed Up',
  speedDown: 'Speed Down',
  lowerThirds: 'Lower Thirds Toggle',
  emergencyStop: 'Emergency Stop',
};

async function refreshControllers() {
  try {
    var results = await Promise.all([
      fetch('/api/controllers').then(function(r) { return r.json(); }),
      fetch('/api/controllers/active').then(function(r) { return r.json(); }),
      fetch('/api/mappings').then(function(r) { return r.json(); }),
    ]);
    renderControllers(results[0], results[1], results[2]);
  } catch(e) {
    document.getElementById('controllers-content').textContent = 'Error loading controllers';
  }
}

function renderControllers(controllers, active, mappings) {
  var html = '';

  // --- Connected Controllers ---
  html += '<div class="section-header">Detected Controllers</div>';
  if (!controllers || controllers.length === 0) {
    html += '<div style="color:#666;font-size:0.85rem">No controllers detected</div>';
  } else {
    html += '<div class="row" style="flex-direction:column;gap:6px">';
    for (var ci = 0; ci < controllers.length; ci++) {
      var c = controllers[ci];
      var isActive = active.connected && active.profileName === c.profileName;
      var connType = c.connectionType || 'usb';
      var connBadge = connType === 'bluetooth'
        ? '<span class="badge conn-bt">BT</span>'
        : '<span class="badge conn-usb">USB</span>';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0">';
      html += '<span class="badge' + (isActive ? ' active-ctrl' : '') + '">' + esc(c.label) + '</span>';
      html += connBadge;
      // Detected by the OS is not the same as delivering data. Say which it is,
      // so this tab agrees with the home-screen Controller tile.
      if (isActive) {
        html += '<span class="ctrl-active-tag">Active</span>';
      } else {
        html += '<span style="color:#888;font-size:0.75rem">Detected — no input data</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    // A detected-but-silent pad is the confusing case: say why, not just that.
    if (!active.connected && active.statusDetail) {
      html += '<div style="margin-top:6px;color:#e0a030;font-size:0.8rem;line-height:1.35">'
        + esc(active.statusDetail) + '</div>';
    }
  }

  // --- Button Mappings ---
  html += '<div class="section-header">Button Mappings</div>';
  html += '<table class="mapping-table"><tbody>';
  var actionKeys = Object.keys(ACTION_LABELS);
  for (var ai = 0; ai < actionKeys.length; ai++) {
    var action = actionKeys[ai];
    var label = ACTION_LABELS[action];
    var assignment = mappings[action] || '—';
    var isListening = remappingAction === action;
    html += '<tr>';
    html += '<td>' + label + '</td>';
    html += '<td id="map-val-' + action + '">' + esc(assignment) + '</td>';
    html += '<td><button class="btn' + (isListening ? ' listening' : '') + '" data-action="' + action + '" onclick="startRemap(this.dataset.action)">' + (isListening ? 'Listening…' : 'Remap') + '</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';

  // --- Profile Management ---
  html += '<div class="section-header">Profile Management</div>';
  html += '<div class="row" style="gap:8px">';
  html += '<button class="btn" onclick="saveMappingsUI()">Save Profile</button>';
  html += '<button class="btn" onclick="resetMappings()">Reset to Default</button>';
  html += '<button class="btn" onclick="exportMappings()">Export YAML</button>';
  html += '</div>';

  // --- Raw HID Debug ---
  html += '<details style="margin-top:14px" id="hid-debug-details"' + (hidDebugEnabled ? ' open' : '') + '>';
  html += '<summary>Raw HID Debug</summary>';
  html += '<div class="hex-stream" id="hid-hex">Waiting for controller data&hellip;</div>';
  html += '</details>';

  document.getElementById('controllers-content').innerHTML = html;

  // Wire up HID debug toggle
  var details = document.getElementById('hid-debug-details');
  details.addEventListener('toggle', function() {
    hidDebugEnabled = details.open;
    if (hidDebugEnabled) connectControllerWS();
    else disconnectControllerWS();
  });
}

function esc(s) {
  // An absent value renders as nothing. Stringifying it instead put the literal
  // text "undefined" into config inputs, which then got saved as a camera IP
  // address and made three DJI gimbals unreachable.
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function startRemap(action) {
  if (remappingAction === action) {
    remappingAction = null;
    disconnectControllerWS();
    refreshControllers();
    return;
  }
  remappingAction = action;
  // Reset capture state so we only respond to fresh input.
  window._remapSawClean = false;
  window._remapState = { counts: {}, armed: null };
  connectControllerWS();
  refreshControllers();
}

function connectControllerWS() {
  if (wsController && wsController.readyState <= 1) return;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsController = new WebSocket(proto + '//' + location.host + '/ws/controller-input');
  wsController.onmessage = handleControllerMessage;
  wsController.onerror = function() { wsController = null; };
  wsController.onclose = function() { wsController = null; };
}

function disconnectControllerWS() {
  if (!remappingAction && !hidDebugEnabled) {
    if (wsController) { wsController.close(); wsController = null; }
  }
}

function handleControllerMessage(evt) {
  var data;
  try { data = JSON.parse(evt.data); } catch(e) { return; }

  if (hidDebugEnabled && data.raw) {
    var hexStr = data.raw.map(function(b, i) { return 'Byte ' + i + ': 0x' + b; }).join(' | ');
    var hexEl = document.getElementById('hid-hex');
    if (hexEl) hexEl.textContent = hexStr;
  }

  if (!remappingAction) return;
  var action = remappingAction;

  var btns = (data.normalized && data.normalized.buttons) || {};
  var trgs = (data.normalized && data.normalized.triggers) || {};
  var axs  = (data.normalized && data.normalized.axes) || {};

  // Require ONE clean frame (everything at rest) before we'll accept any input.
  // Without this, a button held when Remap was clicked snaps onto the remap.
  if (!window._remapSawClean) {
    var anyPressed = Object.keys(btns).some(function(k) { return btns[k] === true; })
                  || Object.keys(trgs).some(function(k) { return trgs[k] > 0.3; })
                  || Object.keys(axs).some(function(k) { return Math.abs(axs[k]) > 0.5; });
    if (!anyPressed) window._remapSawClean = true;
    return;
  }

  // Per-input counter model: each candidate input has its own count. Active
  // this frame → count up (capped). Inactive this frame → count down (floored
  // at 0). First input to reach HOLD_FRAMES arms. When it returns to inactive,
  // we commit. A noisy hat-switch glitch (1 frame active, 1 frame inactive)
  // gains and loses count equally and never arms — but a steady physical hold
  // accumulates monotonically and wins.
  //
  // Controller WS broadcasts at ~10Hz, so HOLD_FRAMES = 10 ≈ 1 second hold.
  var HOLD_FRAMES = 10;
  var COUNT_CAP = HOLD_FRAMES + 5;
  if (!window._remapState) window._remapState = { counts: {}, armed: null };
  var rs = window._remapState;

  // Build the set of inputs that are currently engaged.
  var activeNames = {};
  Object.keys(btns).forEach(function(k) { if (btns[k] === true) activeNames[k] = true; });
  Object.keys(trgs).forEach(function(k) { if (trgs[k] > 0.6) activeNames[k] = true; });
  Object.keys(axs).forEach(function(k) { if (Math.abs(axs[k]) > 0.8) activeNames[k] = true; });

  // Increment counts for active inputs, decrement for inactive ones.
  Object.keys(activeNames).forEach(function(name) {
    rs.counts[name] = Math.min(COUNT_CAP, (rs.counts[name] || 0) + 1);
  });
  Object.keys(rs.counts).forEach(function(name) {
    if (!activeNames[name]) rs.counts[name] = Math.max(0, rs.counts[name] - 1);
  });

  // Arm the first input to reach the threshold (only if not already armed).
  if (!rs.armed) {
    var armedName = null;
    Object.keys(rs.counts).forEach(function(name) {
      if (rs.counts[name] >= HOLD_FRAMES && !armedName) armedName = name;
    });
    if (armedName) rs.armed = armedName;
  }

  // If armed, watch for the armed input to RELEASE (no longer active), then commit.
  if (rs.armed && !activeNames[rs.armed]) {
    var name = rs.armed;
    window._remapState = { counts: {}, armed: null };
    assignRemap(action, name);
  }
}

function assignRemap(action, input) {
  remappingAction = null;
  disconnectControllerWS();
  var el = document.getElementById('map-val-' + action);
  if (el) el.textContent = input;
  if (!window._pendingMappings) window._pendingMappings = {};
  window._pendingMappings[action] = input;
  refreshControllers();
}

async function saveMappingsUI() {
  var mappings = {};
  var actionKeys = Object.keys(ACTION_LABELS);
  for (var i = 0; i < actionKeys.length; i++) {
    var action = actionKeys[i];
    var el = document.getElementById('map-val-' + action);
    if (el) mappings[action] = el.textContent;
  }
  try {
    var r = await fetch('/api/mappings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ mappings: mappings }),
    });
    var j = await r.json();
    if (j.ok) alert('Mappings saved!');
    else alert('Save failed: ' + JSON.stringify(j));
  } catch(e) {
    alert('Save error: ' + e);
  }
}

var DEFAULT_MAPPINGS = {
  panTilt:'rightStick', zoomIn:'rightTrigger', zoomOut:'leftTrigger',
  cameraSelectLeft:'leftStickLeft', cameraSelectRight:'leftStickRight',
  autoTransition:'RB', precisionMode:'LS', selectCam1:'X', selectCam2:'A',
  selectCam3:'B', selectCam4:'Y', speedUp:'dpadUp', speedDown:'dpadDown',
  lowerThirds:'dpadLeft', emergencyStop:'back'
};

async function resetMappings() {
  if (!confirm('Reset all mappings to defaults?')) return;
  try {
    var r = await fetch('/api/mappings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ mappings: DEFAULT_MAPPINGS }),
    });
    var j = await r.json();
    if (j.ok) { window._pendingMappings = {}; refreshControllers(); }
  } catch(e) {
    alert('Reset error: ' + e);
  }
}

function exportMappings() {
  var mappings = {};
  var actionKeys = Object.keys(ACTION_LABELS);
  for (var i = 0; i < actionKeys.length; i++) {
    var action = actionKeys[i];
    var el = document.getElementById('map-val-' + action);
    if (el) mappings[action] = el.textContent;
  }
  var lines = ['# Controller button mappings - managed by FPS CamControl UI'];
  var keys = Object.keys(mappings);
  for (var k = 0; k < keys.length; k++) {
    lines.push(keys[k] + ': ' + mappings[keys[k]]);
  }
  var blob = new Blob([lines.join('\\n')], {type:'text/yaml'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'controller-mappings.yaml';
  a.click();
}

// ---- Activity Log ----
var activityWs = null;
var activityAutoScroll = true;
var logFilter = 'ALL';
var hideProbes = false;

function setLogFilter(f, btn) {
  logFilter = f;
  var btns = document.querySelectorAll('.filter-btn[data-filter]');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  btn.classList.add('active');
  applyLogFilter();
}

function toggleHideProbe(btn) {
  hideProbes = !hideProbes;
  btn.classList.toggle('active', hideProbes);
  applyLogFilter();
}

function rowVisible(tr) {
  var proto = tr.dataset.proto;
  var isProbe = tr.dataset.probe === '1';
  if (hideProbes && isProbe) return false;
  if (logFilter !== 'ALL' && proto !== logFilter) return false;
  return true;
}

function applyLogFilter() {
  var rows = document.getElementById('activity-log-body').rows;
  for (var i = 0; i < rows.length; i++) {
    rows[i].style.display = rowVisible(rows[i]) ? '' : 'none';
  }
  if (activityAutoScroll) {
    var wrap = document.getElementById('activity-log-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

function fmtTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function activityRowClass(proto) {
  if (proto === 'VISCA') return 'row-visca';
  if (proto === 'ATEM') return 'row-atem';
  if (proto === 'DJI-BRIDGE') return 'row-dji';
  return 'row-sys';
}

function appendActivityEntry(entry) {
  var tbody = document.getElementById('activity-log-body');
  if (!tbody) return;
  var tr = document.createElement('tr');
  tr.className = activityRowClass(entry.protocol);
  tr.dataset.proto = entry.protocol;
  tr.dataset.probe = (entry.device === 'unknown' && entry.input === '—') ? '1' : '0';
  var msg = entry.message || '—';
  tr.innerHTML =
    '<td>' + fmtTime(entry.ts) + '</td>' +
    '<td>' + esc(entry.device) + '</td>' +
    '<td>' + esc(entry.input) + '</td>' +
    '<td>' + esc(entry.command) + '</td>' +
    '<td>' + esc(entry.protocol) + '</td>' +
    '<td class="msg" title="' + esc(msg) + '">' + esc(msg) + '</td>' +
    '<td>' + esc(entry.targetName) + '</td>' +
    '<td>' + esc(entry.targetIp) + '</td>';
  tr.style.display = rowVisible(tr) ? '' : 'none';
  if (entry.ts > lastSeenTs) lastSeenTs = entry.ts;
  tbody.appendChild(tr);
  while (tbody.rows.length > 500) tbody.deleteRow(0);
  if (activityAutoScroll) {
    var wrap = document.getElementById('activity-log-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

function initActivityLog() {
  var wrap = document.getElementById('activity-log-wrap');
  if (wrap) {
    wrap.addEventListener('scroll', function() {
      activityAutoScroll = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 10;
    });
  }
  connectActivityWs();
}

var lastSeenTs = 0;
var activityReconnectTimer = null;

function connectActivityWs() {
  if (activityReconnectTimer) { clearTimeout(activityReconnectTimer); activityReconnectTimer = null; }
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  activityWs = new WebSocket(proto + '//' + location.host + '/ws/activity');

  activityWs.onmessage = function(evt) {
    var msg = JSON.parse(evt.data);
    if (msg.type === 'snapshot') {
      for (var i = 0; i < msg.entries.length; i++) {
        if (msg.entries[i].ts > lastSeenTs) appendActivityEntry(msg.entries[i]);
      }
    } else if (msg.type === 'entry') {
      appendActivityEntry(msg.entry);
    }
  };

  activityWs.onclose = function() {
    activityWs = null;
    activityReconnectTimer = setTimeout(connectActivityWs, 3000);
  };

  activityWs.onerror = function() {
    // onclose will fire after onerror and handle reconnect
  };
}

function clearActivityLog() {
  fetch('/api/activity', { method: 'DELETE' }).then(function() {
    var tbody = document.getElementById('activity-log-body');
    if (tbody) tbody.innerHTML = '';
  });
}

initActivityLog();
</script>
</body>
</html>`;
}
