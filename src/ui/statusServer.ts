import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { AppState, CameraId } from '../app/state';
import { AppConfig, MappingConfig, saveMappings, validateDevicesConfig, saveDevicesConfig } from '../config/configLoader';
import { PresetManager } from '../model/presetManager';
import { ActivityLog } from '../app/activityLog';
import { ViscaClient } from '../visca/viscaClient';
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
  viscaClients: Map<CameraId, ViscaClient>
): express.Express {
  const app = express();
  app.use(express.json());

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
  // Returns all HID devices that match known profiles, plus unrecognized gamepad-like devices
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
            connected: true,
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

      // Reconcile VISCA clients
      const oldIds = new Set(viscaClients.keys());
      const newIds = new Set(parsed.cameras.map(c => c.id as CameraId));

      // Remove deleted cameras
      for (const id of oldIds) {
        if (!newIds.has(id)) {
          viscaClients.get(id)?.close();
          viscaClients.delete(id);
          delete state.cameraConnected[id];
        }
      }

      // Add or update cameras
      for (const cam of parsed.cameras) {
        const id = cam.id as CameraId;
        const existing = viscaClients.get(id);
        const oldCam = config.cameras.find(c => c.id === cam.id);
        const changed = !existing || !oldCam ||
          oldCam.viscaIp !== cam.viscaIp ||
          oldCam.viscaPort !== cam.viscaPort ||
          oldCam.cameraType !== cam.cameraType;

        if (changed) {
          existing?.close();
          const client = new ViscaClient(cam.id, cam.viscaIp, cam.viscaPort, cam.cameraType);
          client.setActivityLog(activityLog, cam.label);
          client.on('connected', () => { state.cameraConnected[id] = true; });
          client.on('disconnected', () => { state.cameraConnected[id] = false; });
          viscaClients.set(id, client);
          client.connect();
        } else if (existing && oldCam && oldCam.label !== cam.label) {
          existing.setActivityLog(activityLog, cam.label);
        }
      }

      // Update cameras array in config
      config.cameras = parsed.cameras;

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
  const wss = new WebSocketServer({ server, path: '/ws/controller-input' });

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
  const wssActivity = new WebSocketServer({ server, path: '/ws/activity' });

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
<style>
  body { font-family: monospace; background: #111; color: #eee; padding: 20px; }
  h1 { color: #0af; margin-bottom: 10px; }
  .panel { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  .panel h2 { margin: 0 0 12px; color: #aaa; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .badge { padding: 4px 10px; border-radius: 4px; font-size: 0.9rem; background: #222; }
  .badge.live { background: #c00; color: #fff; }
  .badge.preview { background: #060; color: #fff; }
  .badge.controlled { background: #005a9e; color: #fff; }
  .badge.ok { background: #1a4a1a; color: #4f4; }
  .badge.err { background: #4a1a1a; color: #f44; }
  .badge.on { background: #665500; color: #ffa; }
  .section { margin-top: 8px; }
  .label { font-size: 0.75rem; color: #666; margin-bottom: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td { padding: 4px 8px; border-bottom: 1px solid #222; }
  td:first-child { color: #888; }
  .section-header { font-size: 0.78rem; color: #888; text-transform: uppercase; letter-spacing: 1px; margin: 14px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  .badge.active { background: #004080; color: #7af; border: 1px solid #0af; }
  .badge.conn-usb { background: #1a2a1a; color: #8f8; border: 1px solid #4a4; font-size: 0.75rem; }
  .badge.conn-bt { background: #1a1a3a; color: #88f; border: 1px solid #44a; font-size: 0.75rem; }
  .btn { padding: 3px 10px; border-radius: 3px; border: 1px solid #444; background: #222; color: #ccc; cursor: pointer; font-size: 0.8rem; font-family: monospace; }
  .btn:hover { background: #333; }
  .btn.listening { background: #330000; border-color: #f44; color: #f44; animation: pulse 0.8s infinite; }
  .btn.danger { border-color: #800; color: #f44; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
  .mapping-table td { padding: 5px 8px; }
  .mapping-table td:first-child { color: #aaa; min-width: 160px; }
  .mapping-table td:nth-child(2) { color: #7af; min-width: 120px; font-weight: bold; }
  details > summary { cursor: pointer; color: #888; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  details > summary:hover { color: #ccc; }
  .hex-stream { font-size: 0.75rem; color: #5a5; background: #0a0a0a; padding: 8px; border-radius: 4px; overflow-x: auto; white-space: nowrap; min-height: 2em; }
  .cfg-input { background: #0d0d0d; border: 1px solid #333; color: #eee; padding: 3px 6px; border-radius: 3px; font-family: monospace; font-size: 0.82rem; width: 100%; box-sizing: border-box; }
  .cfg-input:focus { outline: none; border-color: #0af; }
  .activity-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .activity-table th { text-align: left; color: #666; padding: 4px 8px; border-bottom: 1px solid #333; font-size: 0.72rem; text-transform: uppercase; }
  .activity-table td { padding: 3px 8px; border-bottom: 1px solid #1f1f1f; vertical-align: top; }
  .activity-table td.msg { font-family: monospace; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-visca { background: #0a1828; }
  .row-atem  { background: #1e1206; }
  .row-sys   { background: #111; color: #888; }
  .log-wrap  { height: 320px; overflow-y: auto; }
  .log-meta  { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .btn-sm    { padding: 2px 10px; font-size: 0.78rem; background: #222; border: 1px solid #444; color: #ccc; cursor: pointer; border-radius: 3px; }
  .btn-sm:hover { background: #333; }
</style>
</head>
<body>
<h1>FPS CamControl</h1>

<div class="panel">
  <h2>Live Status</h2>
  <div id="status-content">Loading&hellip;</div>
</div>

<div class="panel" id="controllers-panel">
  <h2>Controllers</h2>
  <div id="controllers-content">Loading&hellip;</div>
</div>

<div class="panel" id="device-config-panel">
  <div class="log-meta">
    <h2 style="margin:0">Device Config</h2>
    <span id="config-save-status" style="font-size:0.8rem;color:#888"></span>
  </div>
  <div id="device-config-content">Loading&hellip;</div>
</div>

<div class="panel">
  <div class="log-meta">
    <h2 style="margin:0">Activity Log</h2>
    <button class="btn-sm" onclick="clearActivityLog()">Clear</button>
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

<script>
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

function renderStatus(s, c) {
  const cams = c.cameras || [];
  const camLabel = id => (cams.find(x => x.id === id) || {}).label || id;

  const controlled = '<span class="badge controlled">CONTROLLED: ' + camLabel(s.controlledCamera) + '</span>';
  const program = '<span class="badge live">PGM: ' + camLabel(s.programCamera) + '</span>';
  const preview = '<span class="badge preview">PVW: ' + camLabel(s.previewCamera) + '</span>';
  const atem = '<span class="badge ' + (s.atemConnected ? 'ok' : 'err') + '">ATEM ' + (s.atemConnected ? 'OK' : 'DISCONNECTED') + '</span>';
  const ctrl = '<span class="badge ' + (s.controllerConnected ? 'ok' : 'err') + '">CONTROLLER ' + (s.controllerConnected ? 'OK' : 'DISCONNECTED') + '</span>';

  const camStatus = cams.map(cam => {
    const ok = s.cameraConnected && s.cameraConnected[cam.id];
    return '<span class="badge ' + (ok ? 'ok' : 'err') + '">' + cam.label + ' ' + (ok ? 'OK' : 'DISCONNECTED') + '</span>';
  }).join(' ');

  const speed = c.speeds && c.speeds.presets && c.speeds.presets[s.speedPreset]
    ? c.speeds.presets[s.speedPreset].name : 'Unknown';
  const speedBadge = '<span class="badge">Speed: ' + speed + '</span>';
  const precision = s.precisionMode ? '<span class="badge on">PRECISION</span>' : '';
  const sprint = s.sprintMode ? '<span class="badge on">SPRINT</span>' : '';
  const lt = s.lowerThirdsActive ? '<span class="badge on">LOWER THIRDS ON</span>' : '<span class="badge">Lower Thirds Off</span>';

  document.getElementById('status-content').innerHTML =
    '<div class="row">' + program + preview + controlled + '</div>' +
    '<div class="row section">' + atem + ctrl + '</div>' +
    '<div class="row section">' + camStatus + '</div>' +
    '<div class="row section">' + speedBadge + precision + sprint + lt + '</div>' +
    (s.lastPresetNotification ? '<div class="section"><span class="badge on">Preset: ' + s.lastPresetNotification + '</span></div>' : '');

}

setInterval(refresh, 1000);
setInterval(refreshControllers, 2000);
setInterval(refreshDeviceConfig, 5000);
refresh();
refreshControllers();
refreshDeviceConfig();

// ---- Device Config Editor ----
var deviceConfigData = null;

async function refreshDeviceConfig() {
  if (document.getElementById('device-config-panel').dataset.editing === 'true') return;
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
  html += '<tr><td style="color:#888;width:140px">IP Address</td><td><input class="cfg-input" id="atem-ip" value="' + esc(c.atem.ip) + '"></td></tr>';
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
  document.getElementById('device-config-panel').dataset.editing = 'false';
  // Mark as editing when any input changes
  el.addEventListener('input', function() {
    document.getElementById('device-config-panel').dataset.editing = 'true';
  }, { once: true });
}

function cameraRowHtml(cam, idx) {
  var id = 'cam-' + idx;
  return '<div class="cam-row" id="' + id + '" style="border:1px solid #2a2a2a;border-radius:4px;padding:8px;margin-bottom:6px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<span style="color:#7af;font-size:0.8rem">Camera ' + (idx+1) + '</span>' +
    '<button class="btn-sm" style="color:#f44;border-color:#800" data-rowid="' + id + '" onclick="removeCameraRow(this.dataset.rowid)">Remove</button>' +
    '</div>' +
    '<table style="width:100%"><tbody>' +
    '<tr><td style="color:#888;width:110px">ID</td><td><input class="cfg-input" name="cam-id" value="' + esc(cam.id) + '"></td></tr>' +
    '<tr><td style="color:#888">Label</td><td><input class="cfg-input" name="cam-label" value="' + esc(cam.label) + '"></td></tr>' +
    '<tr><td style="color:#888">Type</td><td><select class="cfg-input" name="cam-type"><option value="generic"' + (cam.cameraType==='generic'?' selected':'') + '>generic</option><option value="birddog"' + (cam.cameraType==='birddog'?' selected':'') + '>birddog</option><option value="vbot"' + (cam.cameraType==='vbot'?' selected':'') + '>vbot</option></select></td></tr>' +
    '<tr><td style="color:#888">VISCA IP</td><td><input class="cfg-input" name="cam-ip" value="' + esc(cam.viscaIp) + '"></td></tr>' +
    '<tr><td style="color:#888">VISCA Port</td><td><input class="cfg-input" name="cam-port" type="number" min="1" max="65535" value="' + cam.viscaPort + '"></td></tr>' +
    '<tr><td style="color:#888">ATEM Input</td><td><input class="cfg-input" name="cam-input" type="number" min="1" value="' + cam.inputId + '"></td></tr>' +
    '</tbody></table></div>';
}

var newCamCounter = 0;
function addCameraRow() {
  document.getElementById('device-config-panel').dataset.editing = 'true';
  newCamCounter++;
  var idx = document.getElementById('cameras-editor').children.length;
  var blank = { id: 'cam' + (idx+1), label: 'Camera ' + (idx+1), cameraType: 'generic', viscaIp: '192.168.50.', viscaPort: 52381, inputId: idx+1 };
  var div = document.createElement('div');
  div.innerHTML = cameraRowHtml(blank, idx);
  document.getElementById('cameras-editor').appendChild(div.firstChild);
}

function removeCameraRow(id) {
  document.getElementById('device-config-panel').dataset.editing = 'true';
  var el = document.getElementById(id);
  if (el) el.remove();
  // Re-label remaining rows
  var rows = document.getElementById('cameras-editor').children;
  for (var i = 0; i < rows.length; i++) {
    var hdr = rows[i].querySelector('span');
    if (hdr) hdr.textContent = 'Camera ' + (i+1);
  }
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
    cameras.push({
      id: r.querySelector('[name="cam-id"]').value.trim(),
      label: r.querySelector('[name="cam-label"]').value.trim(),
      cameraType: r.querySelector('[name="cam-type"]').value,
      viscaIp: r.querySelector('[name="cam-ip"]').value.trim(),
      viscaPort: parseInt(r.querySelector('[name="cam-port"]').value, 10) || 52381,
      inputId: parseInt(r.querySelector('[name="cam-input"]').value, 10) || 1,
    });
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
      document.getElementById('device-config-panel').dataset.editing = 'false';
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
  zoom: 'Zoom',
  cameraSelectLeft: 'Camera Select Left',
  cameraSelectRight: 'Camera Select Right',
  takeLive: 'Take Live (Cut)',
  autoTransition: 'Auto Transition',
  precisionMode: 'Precision Mode (hold)',
  sprintMode: 'Sprint Mode (hold)',
  presetA: 'Recall Preset A',
  presetB: 'Recall Preset B',
  presetX: 'Recall Preset X',
  presetY: 'Recall Preset Y',
  presetSave: 'Preset Save modifier',
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
  html += '<div class="section-header">Connected Controllers</div>';
  if (!controllers || controllers.length === 0) {
    html += '<div style="color:#666;font-size:0.85rem">No controllers detected</div>';
  } else {
    html += '<div class="row" style="flex-direction:column;gap:6px">';
    for (var ci = 0; ci < controllers.length; ci++) {
      var c = controllers[ci];
      var isActive = active.connected && active.profileName === c.profileName;
      var connType = c.connectionType || 'usb';
      var connBadge = connType === 'bluetooth'
        ? '<span class="badge conn-bt">&#x1F535; Bluetooth</span>'
        : '<span class="badge conn-usb">&#x1F50C; USB</span>';
      html += '<div style="display:flex;align-items:center;gap:10px">';
      html += '<span class="badge' + (isActive ? ' active' : '') + '">' + esc(c.label) + '</span>';
      html += connBadge;
      if (isActive) html += '<span style="color:#7af;font-size:0.8rem">&#9679; Active</span>';
      html += '</div>';
    }
    html += '</div>';
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
  html += '<details style="margin-top:14px" id="hid-debug-details">';
  html += '<summary>Raw HID Debug</summary>';
  html += '<div class="hex-stream" id="hid-hex">Waiting for controller data&hellip;</div>';
  html += '</details>';

  document.getElementById('controllers-content').innerHTML = html;

  // Wire up HID debug toggle
  var details = document.getElementById('hid-debug-details');
  details.addEventListener('toggle', function() {
    hidDebugEnabled = details.open;
    if (hidDebugEnabled) connectControllerWS();
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function startRemap(action) {
  if (remappingAction === action) {
    remappingAction = null;
    disconnectControllerWS();
    refreshControllers();
    return;
  }
  remappingAction = action;
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

  if (data.normalized && data.normalized.buttons) {
    var btnKeys = Object.keys(data.normalized.buttons);
    for (var bi = 0; bi < btnKeys.length; bi++) {
      var btn = btnKeys[bi];
      if (data.normalized.buttons[btn] === true) {
        assignRemap(action, btn);
        return;
      }
    }
  }
  if (data.normalized && data.normalized.triggers) {
    var trgKeys = Object.keys(data.normalized.triggers);
    for (var ti = 0; ti < trgKeys.length; ti++) {
      var trg = trgKeys[ti];
      if (data.normalized.triggers[trg] > 0.5) {
        assignRemap(action, trg);
        return;
      }
    }
  }
  if (data.normalized && data.normalized.axes) {
    var axisKeys = Object.keys(data.normalized.axes);
    for (var xi = 0; xi < axisKeys.length; xi++) {
      var axis = axisKeys[xi];
      if (Math.abs(data.normalized.axes[axis]) > 0.75) {
        assignRemap(action, axis);
        return;
      }
    }
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
  panTilt:'rightStick', zoom:'leftStickY', cameraSelectLeft:'leftStickLeft',
  cameraSelectRight:'leftStickRight', takeLive:'rightTrigger', autoTransition:'RB',
  precisionMode:'leftTrigger', sprintMode:'LS', presetA:'A', presetB:'B',
  presetX:'X', presetY:'Y', presetSave:'LB', speedUp:'dpadUp', speedDown:'dpadDown',
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

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  activityWs = new WebSocket(proto + '//' + location.host + '/ws/activity');

  activityWs.onmessage = function(evt) {
    var msg = JSON.parse(evt.data);
    if (msg.type === 'snapshot') {
      var tbody = document.getElementById('activity-log-body');
      if (tbody) tbody.innerHTML = '';
      for (var i = 0; i < msg.entries.length; i++) appendActivityEntry(msg.entries[i]);
    } else if (msg.type === 'entry') {
      appendActivityEntry(msg.entry);
    }
  };

  activityWs.onerror = function() {
    setTimeout(function pollActivity() {
      fetch('/api/activity').then(function(r) { return r.json(); }).then(function(data) {
        var tbody = document.getElementById('activity-log-body');
        if (tbody) tbody.innerHTML = '';
        for (var i = 0; i < data.entries.length; i++) appendActivityEntry(data.entries[i]);
        setTimeout(pollActivity, 2000);
      }).catch(function() { setTimeout(pollActivity, 2000); });
    }, 2000);
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
