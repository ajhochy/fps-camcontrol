import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { AppState } from '../app/state';
import { AppConfig, MappingConfig, saveMappings } from '../config/configLoader';
import { PresetManager } from '../model/presetManager';
import { loadProfiles, detectConnectionType } from '../input/profileDetector';
import { eventBus } from '../app/eventBus';
import { logger } from '../index';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager
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

  app.get('/', (_req, res) => {
    res.send(statusHtml());
  });

  return app;
}

export function startStatusServer(
  app: express.Express,
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

<div class="panel">
  <h2>Camera Config</h2>
  <div id="config-content">Loading&hellip;</div>
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

  document.getElementById('config-content').innerHTML =
    '<table>' +
    cams.map(cam =>
      '<tr><td>' + cam.id + '</td><td>' + cam.label + '</td><td>' + cam.viscaIp + ':' + cam.viscaPort + '</td><td>Input ' + cam.inputId + '</td></tr>'
    ).join('') +
    '</table>';
}

setInterval(refresh, 1000);
setInterval(refreshControllers, 2000);
refresh();
refreshControllers();

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
      html += '<span style="color:#666;font-size:0.8rem">' + esc(c.profileName) + '</span>';
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
    html += '<td><button class="btn' + (isListening ? ' listening' : '') + '" onclick="startRemap(\'' + action + '\')">' + (isListening ? 'Listening…' : 'Remap') + '</button></td>';
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
  var blob = new Blob([lines.join('\n')], {type:'text/yaml'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'controller-mappings.yaml';
  a.click();
}
</script>
</body>
</html>`;
}
