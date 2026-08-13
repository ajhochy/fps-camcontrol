import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { AppState, CameraId, trackDeviceLinkState, clearCameraLinkState } from '../app/state';
// NOTE: "profile" is overloaded in this codebase — profileDetector deals with
// *controller* profiles (Xbox, Wii U Pro). Camera environment profiles are
// aliased here as CameraProfile to keep the two apart.
import {
  AppConfig, MappingConfig, saveMappings, validateDevicesConfig, saveDevicesConfig,
  resolveProfile, saveActiveProfile, saveProfiles, CameraConfig,
  type Profile as CameraProfile,
} from '../config/configLoader';
import { PresetManager } from '../model/presetManager';
import { ActivityLog } from '../app/activityLog';
import { ViscaDevice } from '../devices/viscaDevice';
import { MotionDevice } from '../devices/motionDevice';
import { createMotionDevice } from '../devices/deviceFactory';
import { AtemClient } from '../atem/atemClient';
import { loadProfiles, detectConnectionType } from '../input/profileDetector';
import { eventBus } from '../app/eventBus';
import { logger } from '../index';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager,
  activityLog: ActivityLog,
  atem: AtemClient,
  devices: Map<CameraId, MotionDevice>
): express.Express {
  const app = express();
  app.use(express.json());

  // GET /api/status
  // `cameraConnected` answers only "can this camera be moved?". For cameras
  // behind a Pi bridge, `cameraBridgeReachable` and `cameraGimbalAttached` say
  // WHICH stage is down, because the remedies differ (fix the Pi/network vs.
  // switch the gimbal on). Both maps omit direct-link cameras (VISCA) entirely:
  // a missing key means "no second stage", not "broken".
  app.get('/api/status', (_req, res) => {
    res.json(state);
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      cameras: config.cameras,
      atem: config.atem,
      graphics: config.graphics,
      speeds: config.speeds,
    });
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
      const profilesDir = process.env.PROFILES_DIR ?? path.join(process.cwd(), 'controller-profiles');
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
  }

  // GET /api/profiles — inventory + profile definitions + which one is active.
  app.get('/api/profiles', (_req, res) => {
    res.json({
      activeProfile: config.activeProfile ?? null,
      profiles: config.profiles ?? {},
      devices: config.devices ?? {},
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
      saveProfiles(body.profiles);
      config.profiles = body.profiles;

      // If the profile being edited is the live one, apply the edit immediately.
      const active = config.activeProfile;
      if (active && body.profiles[active]) {
        reconcileCameras(resolveProfile(config.devices ?? {}, body.profiles[active]));
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'profile save failed');
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/config', (req, res) => {
    try {
      const parsed = validateDevicesConfig(req.body);

      // Detect ATEM IP change before mutating config
      const atemIpChanged = parsed.atem.ip !== config.atem.ip;

      // Save to disk
      saveDevicesConfig(parsed);

      // Update in-memory config
      config.atem = parsed.atem;
      config.graphics = parsed.graphics;

      reconcileCameras(parsed.cameras);

      // Reconnect ATEM if IP changed
      if (atemIpChanged) {
        atem.disconnect();
        atem.connect().catch(err => logger.warn({ err }, 'ATEM reconnect after config change failed'));
      }

      res.json({ ok: true });
    } catch (err) {
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

  eventBus.on('controllerData', (event) => {
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
  });

  const activityClients = new Set<WebSocket>();
  const wssActivity = new WebSocketServer({ noServer: true });

  wssActivity.on('connection', (ws) => {
    activityClients.add(ws);
    ws.on('close', () => activityClients.delete(ws));
    ws.on('error', () => activityClients.delete(ws));
    const current = activityLog.getAll();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', entries: current }));
  });

  activityLog.on('entry', (entry) => {
    const payload = JSON.stringify({ type: 'entry', entry });
    for (const ws of activityClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  server.on('upgrade', (request, socket, head) => {
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
    logger.info({ port }, 'status UI running');
  });

  return server;
}

function statusHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FPS CamControl</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Nunito+Sans:opsz,wght@6..12,300;6..12,400;6..12,600&display=swap" rel="stylesheet">
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
  .row-sys   { background: var(--surface); color: var(--text-2); }

  /* Controller mapping */
  .mapping-table td { padding: 5px 8px; }
  .mapping-table td:first-child { color: var(--text); min-width: 180px; font-family: 'Nunito Sans', sans-serif; font-size: 0.84rem; }
  .mapping-table td:nth-child(2) { color: var(--amber); min-width: 130px; font-family: 'Rajdhani', sans-serif; font-weight: 600; letter-spacing: 0.05em; }

  /* Controller list badges */
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
</style>
</head>
<body>
<header class="app-header">
  <h1 class="app-title"><span>FPS</span> CamControl</h1>
  <span class="app-subtitle">Production Camera Controller</span>
</header>

<div class="status-bar" id="status-bar"></div>

<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('status',this)">Status</button>
  <button class="tab-btn" onclick="switchTab('log',this)">Activity Log</button>
  <button class="tab-btn" onclick="switchTab('config',this)">Device Config</button>
  <button class="tab-btn" onclick="switchTab('profiles',this)">Profiles</button>
  <button class="tab-btn" onclick="switchTab('controllers',this)">Controllers</button>
</div>

<div class="panel tab-panel active" id="tab-status">
  <div id="status-content"></div>
</div>

<div class="panel tab-panel" id="tab-log">
  <div class="log-meta">
    <div class="filter-bar">
      <span class="filter-label">Filter</span>
      <button class="filter-btn active" data-filter="ALL" onclick="setLogFilter('ALL',this)">All</button>
      <button class="filter-btn" data-filter="VISCA" onclick="setLogFilter('VISCA',this)">VISCA</button>
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

<div class="panel tab-panel" id="tab-config" data-editing="false">
  <div class="log-meta">
    <h2 style="margin:0">Device Config</h2>
    <span id="config-save-status" style="font-size:0.78rem;color:var(--text-2)"></span>
  </div>
  <div id="device-config-content">Loading&hellip;</div>
</div>

<div class="panel tab-panel" id="tab-profiles" data-editing="false">
  <div class="log-meta">
    <h2 style="margin:0">Environment Profiles</h2>
    <span id="profiles-save-status" style="font-size:0.78rem;color:var(--text-2)"></span>
  </div>
  <div id="profiles-content">Loading&hellip;</div>
</div>

<div class="panel tab-panel" id="tab-controllers">
  <div id="controllers-content">Loading&hellip;</div>
</div>

<script>
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

async function refresh() {
  try {
    const [status, config] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
    ]);
    renderStatus(status, config);
  } catch(e) {
    document.getElementById('status-content').textContent = 'Error fetching status';
  }
}

function cam(id, label) {
  return '<span class="badge">' + (label || id) + '</span>';
}

function tile(label, value, cls) {
  return '<div class="s-tile s-tile--' + cls + '"><span class="s-tile__label">' + label + '</span><span class="s-tile__value">' + esc(value) + '</span></div>';
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
  const camLabel = id => (cams.find(x => x.id === id) || {}).label || id;

  document.getElementById('status-bar').innerHTML =
    tile('Program',    camLabel(s.programCamera),    'live') +
    tile('Preview',    camLabel(s.previewCamera),    'pvw') +
    tile('Controlled', camLabel(s.controlledCamera), 'ctrl') +
    tile('ATEM',       s.atemConnected ? 'Connected' : 'Disconnected', s.atemConnected ? 'ok' : 'err') +
    tile('Controller', s.controllerConnected ? (s.activeControllerProfile || 'Connected') : 'Not Connected', s.controllerConnected ? 'ok' : 'err');

  const speed = c.speeds && c.speeds.presets && c.speeds.presets[s.speedPreset]
    ? c.speeds.presets[s.speedPreset].name : 'Unknown';

  let camGrid = '<div class="cam-grid">';
  for (var i = 0; i < cams.length; i++) {
    const cam = cams[i];
    const link = cameraLinkState(s, cam.id);
    camGrid +=
      '<div class="cam-card cam-card--' + link.cls + '">' +
        '<div class="cam-card__header"><span class="cam-card__led"></span><span class="cam-card__name">' + esc(cam.label) + '</span></div>' +
        '<span class="cam-card__status">' + esc(link.text) + '</span>' +
        (link.hint ? '<span class="cam-card__hint">' + esc(link.hint) + '</span>' : '') +
      '</div>';
  }
  camGrid += '</div>';

  const modes = [
    '<span class="mode-chip mode-chip--speed">Speed: ' + esc(speed) + '</span>',
    s.precisionMode ? '<span class="mode-chip mode-chip--on">Precision</span>' : '',
    s.sprintMode    ? '<span class="mode-chip mode-chip--on">Sprint</span>' : '',
    s.lowerThirdsActive ? '<span class="mode-chip mode-chip--on">Lower Thirds</span>' : '',
    s.lastPresetNotification ? '<span class="mode-chip mode-chip--on">Preset: ' + esc(s.lastPresetNotification) + '</span>' : '',
  ].filter(Boolean).join('');

  document.getElementById('status-content').innerHTML = camGrid + '<div class="mode-row">' + modes + '</div>';
}

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
      body: JSON.stringify({ profiles: out }),
    }).then(function(x) { return x.json(); });
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
setInterval(refresh, 1000);
setInterval(refreshControllers, 2000);
setInterval(refreshDeviceConfig, 5000);
setInterval(refreshProfiles, 5000);
refresh();
refreshControllers();
refreshDeviceConfig();

// ---- Device Config Editor ----
var deviceConfigData = null;

async function refreshDeviceConfig() {
  if (document.getElementById('tab-config').dataset.editing === 'true') return;
  try {
    var data = await fetch('/api/config').then(function(r) { return r.json(); });
    deviceConfigData = data;
    renderDeviceConfig(data);
  } catch(e) { /* ignore */ }
}

function renderDeviceConfig(c) {
  var html = '';

  // ATEM
  html += '<div class="section-header">ATEM Switcher</div>';
  html += '<table style="width:100%;margin-bottom:8px"><tbody>';
  html += '<tr><td style="color:#888;width:140px">IP Address</td><td style="display:flex;gap:6px"><input class="cfg-input" id="atem-ip" value="' + esc(c.atem.ip) + '" style="flex:1"><button class="btn-sm" onclick="reconnectAtem(this)">Reconnect</button></td></tr>';
  html += '<tr><td style="color:#888">Transition</td><td><select class="cfg-input" id="atem-transition"><option value="cut"' + (c.atem.defaultTransition==='cut'?' selected':'') + '>Cut</option><option value="auto"' + (c.atem.defaultTransition==='auto'?' selected':'') + '>Auto</option></select></td></tr>';
  html += '<tr><td style="color:#888">M/E Index</td><td><input class="cfg-input" id="atem-me" type="number" min="0" max="3" value="' + c.atem.meIndex + '"></td></tr>';
  html += '</tbody></table>';

  // Graphics
  html += '<div class="section-header">Graphics / Lower Thirds</div>';
  html += '<table style="width:100%;margin-bottom:8px"><tbody>';
  html += '<tr><td style="color:#888;width:140px">Type</td><td><select class="cfg-input" id="gfx-type"><option value="dsk"' + (c.graphics.type==='dsk'?' selected':'') + '>DSK</option><option value="usk"' + (c.graphics.type==='usk'?' selected':'') + '>USK</option><option value="auto"' + (c.graphics.type==='auto'?' selected':'') + '>Auto</option></select></td></tr>';
  html += '<tr><td style="color:#888">DSK Index</td><td><input class="cfg-input" id="gfx-dsk" type="number" min="0" max="3" value="' + c.graphics.dskIndex + '"></td></tr>';
  html += '<tr><td style="color:#888">USK Index</td><td><input class="cfg-input" id="gfx-usk" type="number" min="0" max="3" value="' + c.graphics.uskIndex + '"></td></tr>';
  html += '<tr><td style="color:#888">M/E Index</td><td><input class="cfg-input" id="gfx-me" type="number" min="0" max="3" value="' + c.graphics.meIndex + '"></td></tr>';
  html += '</tbody></table>';

  // Cameras
  html += '<div class="section-header" style="display:flex;justify-content:space-between;align-items:center">';
  html += '<span>Cameras</span>';
  html += '<button class="btn-sm" onclick="addCameraRow()">+ Add Camera</button>';
  html += '</div>';
  html += '<div id="cameras-editor">';
  for (var i = 0; i < c.cameras.length; i++) {
    html += cameraRowHtml(c.cameras[i], i);
  }
  html += '</div>';

  html += '<div style="margin-top:14px;display:flex;gap:8px;align-items:center">';
  html += '<button class="btn" onclick="saveDeviceConfig()">Save &amp; Apply</button>';
  html += '<button class="btn" onclick="refreshDeviceConfig()">Revert</button>';
  html += '</div>';

  var el = document.getElementById('device-config-content');
  el.innerHTML = html;
  document.getElementById('tab-config').dataset.editing = 'false';
  // Mark as editing when any input changes
  el.addEventListener('input', function() {
    document.getElementById('tab-config').dataset.editing = 'true';
  }, { once: true });
}

// A camera row renders the transport the camera actually uses. Rendering every
// camera as VISCA is what destroyed the gimbals: a DJI camera has no viscaIp, so
// the field showed the string "undefined" and saved it back as a real IP, while
// the payload silently dropped protocol and bridge.
function cameraRowHtml(cam, idx) {
  var id = 'cam-' + idx;
  var isBridge = cam.protocol === 'dji-bridge';
  var proto = isBridge ? 'dji-bridge' : 'visca';
  var bridge = cam.bridge || {};

  // Fields the form does not render still have to survive a save, so they ride
  // along on the row as data attributes (never as backticks or template
  // interpolation, which collapse when this page is built).
  var attrs = ' data-protocol="' + proto + '" data-camera-type="' + esc(cam.cameraType || 'generic') + '"';
  if (isBridge) {
    attrs += ' data-bridge-model="' + esc(bridge.gimbalModel) + '"' +
      ' data-bridge-timeout="' + (bridge.safetyTimeoutMs != null ? bridge.safetyTimeoutMs : 250) + '"' +
      ' data-bridge-roll="' + (bridge.rollEnabled ? 'true' : 'false') + '"';
  }

  var badge = isBridge
    ? '<span class="badge" style="background:#3a2a00;color:#fb0">DJI BRIDGE</span>'
    : '<span class="badge" style="background:#00263a;color:#7af">VISCA</span>';

  var rows =
    '<tr><td style="color:#888;width:110px">ID</td><td><input class="cfg-input" name="cam-id" value="' + esc(cam.id) + '"></td></tr>' +
    '<tr><td style="color:#888">Label</td><td><input class="cfg-input" name="cam-label" value="' + esc(cam.label) + '"></td></tr>';

  if (isBridge) {
    rows +=
      '<tr><td style="color:#888">Bridge Host</td><td style="display:flex;gap:6px"><input class="cfg-input" name="cam-bridge-host" value="' + esc(bridge.host) + '" style="flex:1" title="Host running the Pi bridge process for this gimbal."><button class="btn-sm" data-rowid="' + id + '" onclick="reconnectCamera(this.dataset.rowid)">Reconnect</button></td></tr>' +
      '<tr><td style="color:#888">Bridge Port</td><td><input class="cfg-input" name="cam-bridge-port" type="number" min="1" max="65535" value="' + (bridge.port != null ? bridge.port : 7878) + '" title="Each gimbal has its own bridge instance on its own port: that port is how commands reach the right gimbal."></td></tr>' +
      '<tr><td style="color:#888">Gimbal</td><td style="color:#888">' + esc(bridge.gimbalModel || 'DJI gimbal') + (bridge.rollEnabled ? ' &middot; roll enabled' : ' &middot; roll disabled') + '</td></tr>';
  } else {
    rows +=
      '<tr><td style="color:#888">Type</td><td><select class="cfg-input" name="cam-type"><option value="generic"' + (cam.cameraType==='generic'?' selected':'') + '>generic</option><option value="birddog"' + (cam.cameraType==='birddog'?' selected':'') + '>birddog</option><option value="vbot"' + (cam.cameraType==='vbot'?' selected':'') + '>vbot</option></select></td></tr>' +
      '<tr><td style="color:#888">VISCA IP</td><td style="display:flex;gap:6px"><input class="cfg-input" name="cam-ip" value="' + esc(cam.viscaIp) + '" style="flex:1"><button class="btn-sm" data-rowid="' + id + '" onclick="reconnectCamera(this.dataset.rowid)">Reconnect</button></td></tr>' +
      '<tr><td style="color:#888">VISCA Port</td><td><input class="cfg-input" name="cam-port" type="number" min="1" max="65535" value="' + (cam.viscaPort != null ? cam.viscaPort : 52381) + '"></td></tr>' +
      '<tr><td style="color:#888">Camera Addr</td><td><input class="cfg-input" name="cam-addr" type="number" min="0" max="7" value="' + (cam.cameraAddress != null ? cam.cameraAddress : 1) + '" title="VISCA bus address (Camera ID in Companion). Default 1."></td></tr>';
  }

  rows +=
    '<tr><td style="color:#888">Speed Scale</td><td><input class="cfg-input" name="cam-speed" type="number" min="0.1" max="5" step="0.1" value="' + (cam.speedScale != null ? cam.speedScale : 1.0) + '" title="Per-camera speed multiplier. 1.0 = same as global preset; >1 = faster (use for slow cams like V-BOT)."></td></tr>' +
    '<tr><td style="color:#888">ATEM Input</td><td><input class="cfg-input" name="cam-input" type="number" min="1" placeholder="not wired" title="Leave blank if this camera video is not connected to the switcher: motion still works, but it cannot be taken live." value="' + (cam.inputId != null ? cam.inputId : '') + '"></td></tr>';

  return '<div class="cam-row" id="' + id + '"' + attrs + ' style="border:1px solid #2a2a2a;border-radius:4px;padding:8px;margin-bottom:6px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<span style="color:#7af;font-size:0.8rem">Camera ' + (idx+1) + '</span>' +
    '<span style="display:flex;gap:6px;align-items:center">' + badge +
    '<button class="btn-sm" style="color:#f44;border-color:#800" data-rowid="' + id + '" onclick="removeCameraRow(this.dataset.rowid)">Remove</button>' +
    '</span>' +
    '</div>' +
    '<table style="width:100%"><tbody>' + rows + '</tbody></table></div>';
}

var newCamCounter = 0;
function addCameraRow() {
  document.getElementById('tab-config').dataset.editing = 'true';
  newCamCounter++;
  var idx = document.getElementById('cameras-editor').children.length;
  var blank = { id: 'cam' + (idx+1), label: 'Camera ' + (idx+1), protocol: 'visca', cameraType: 'generic', viscaIp: '192.168.50.', viscaPort: 52381, cameraAddress: 1, speedScale: 1.0, inputId: idx+1 };
  var div = document.createElement('div');
  div.innerHTML = cameraRowHtml(blank, idx);
  document.getElementById('cameras-editor').appendChild(div.firstChild);
}

function removeCameraRow(id) {
  document.getElementById('tab-config').dataset.editing = 'true';
  var el = document.getElementById(id);
  if (el) el.remove();
  // Re-label remaining rows
  var rows = document.getElementById('cameras-editor').children;
  for (var i = 0; i < rows.length; i++) {
    var hdr = rows[i].querySelector('span');
    if (hdr) hdr.textContent = 'Camera ' + (i+1);
  }
}

function reconnectAtem(btn) {
  btn.disabled = true;
  btn.textContent = '...';
  fetch('/api/reconnect/atem', { method: 'POST' }).then(function() {
    btn.textContent = 'Reconnect';
    btn.disabled = false;
  });
}

function reconnectCamera(id) {
  var btn = document.querySelector('[data-rowid="' + id + '"]');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  fetch('/api/reconnect/camera/' + encodeURIComponent(id), { method: 'POST' }).then(function() {
    if (btn) { btn.textContent = 'Reconnect'; btn.disabled = false; }
  });
}

async function saveDeviceConfig() {
  var atem = {
    ip: document.getElementById('atem-ip').value.trim(),
    defaultTransition: document.getElementById('atem-transition').value,
    meIndex: parseInt(document.getElementById('atem-me').value, 10) || 0,
  };
  var graphics = {
    type: document.getElementById('gfx-type').value,
    dskIndex: parseInt(document.getElementById('gfx-dsk').value, 10) || 0,
    uskIndex: parseInt(document.getElementById('gfx-usk').value, 10) || 0,
    meIndex: parseInt(document.getElementById('gfx-me').value, 10) || 0,
  };
  var cameras = [];
  var rows = document.getElementById('cameras-editor').children;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var speedInput = r.querySelector('[name="cam-speed"]');
    var speedVal = speedInput ? parseFloat(speedInput.value) : 1.0;
    if (isNaN(speedVal) || speedVal < 0.1 || speedVal > 5) speedVal = 1.0;

    // Blank means "not wired to the switcher". Send an explicit null, not
    // undefined (JSON.stringify would drop the key and the server could not
    // tell "clear this" from "leave it alone"), and never default to input 1 —
    // that would silently make an unwired camera takeable to air.
    var inputRaw = r.querySelector('[name="cam-input"]').value.trim();
    var inputVal = null;
    if (inputRaw !== '') {
      var parsedInput = parseInt(inputRaw, 10);
      if (!isNaN(parsedInput) && parsedInput > 0) inputVal = parsedInput;
    }

    // The protocol comes from the row, not from a guess: a payload that omitted
    // it used to be defaulted to VISCA server-side, which converted every DJI
    // gimbal into an unreachable VISCA camera on save.
    var cam = {
      id: r.querySelector('[name="cam-id"]').value.trim(),
      label: r.querySelector('[name="cam-label"]').value.trim(),
      protocol: r.dataset.protocol === 'dji-bridge' ? 'dji-bridge' : 'visca',
      cameraType: r.dataset.cameraType || 'generic',
      speedScale: speedVal,
      inputId: inputVal,
    };

    if (cam.protocol === 'dji-bridge') {
      var bridge = {
        host: r.querySelector('[name="cam-bridge-host"]').value.trim(),
        port: parseInt(r.querySelector('[name="cam-bridge-port"]').value, 10) || 7878,
        rollEnabled: r.dataset.bridgeRoll === 'true',
      };
      if (r.dataset.bridgeModel) bridge.gimbalModel = r.dataset.bridgeModel;
      var timeout = parseInt(r.dataset.bridgeTimeout, 10);
      if (!isNaN(timeout)) bridge.safetyTimeoutMs = timeout;
      cam.bridge = bridge;
    } else {
      var typeSelect = r.querySelector('[name="cam-type"]');
      if (typeSelect) cam.cameraType = typeSelect.value;
      var addrInput = r.querySelector('[name="cam-addr"]');
      var addrVal = addrInput ? parseInt(addrInput.value, 10) : 1;
      if (isNaN(addrVal) || addrVal < 0 || addrVal > 7) addrVal = 1;
      cam.viscaIp = r.querySelector('[name="cam-ip"]').value.trim();
      cam.viscaPort = parseInt(r.querySelector('[name="cam-port"]').value, 10) || 52381;
      cam.cameraAddress = addrVal;
    }
    cameras.push(cam);
  }
  var statusEl = document.getElementById('config-save-status');
  statusEl.textContent = 'Saving…';
  statusEl.style.color = '#888';
  try {
    var r = await fetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ atem: atem, cameras: cameras, graphics: graphics }),
    });
    var j = await r.json();
    if (j.ok) {
      statusEl.textContent = 'Saved & applied ✓';
      statusEl.style.color = '#4f4';
      document.getElementById('tab-config').dataset.editing = 'false';
      setTimeout(function() { statusEl.textContent = ''; }, 3000);
    } else {
      statusEl.textContent = 'Error: ' + j.error;
      statusEl.style.color = '#f44';
    }
  } catch(e) {
    statusEl.textContent = 'Save failed: ' + e;
    statusEl.style.color = '#f44';
  }
}

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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
