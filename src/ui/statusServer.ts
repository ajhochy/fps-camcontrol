import express from 'express';
import { AppState } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { PresetManager } from '../model/presetManager';
import { createStatusRouter } from './routes/status';
import { createConfigRouter } from './routes/config';
import { createPresetsRouter } from './routes/presets';
import { logger } from '../index';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager
): express.Express {
  const app = express();
  app.use(express.json());

  app.use('/api/status', createStatusRouter(state));
  app.use('/api/config', createConfigRouter(config));
  app.use('/api/presets', createPresetsRouter(presetManager));

  app.get('/', (_req, res) => {
    res.send(statusHtml());
  });

  return app;
}

export function startStatusServer(
  app: express.Express,
  port = 8080
): void {
  app.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'status UI running');
  });
}

function statusHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FPS CamControl</title>
<style>
  body { font-family: monospace; background: #111; color: #eee; padding: 20px; max-width: 960px; margin: 0 auto; }
  h1 { color: #0af; margin-bottom: 10px; }
  .panel { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  .panel h2 { margin: 0 0 12px; color: #aaa; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
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
  td, th { padding: 6px 8px; border-bottom: 1px solid #222; text-align: left; }
  th { color: #666; font-weight: normal; font-size: 0.75rem; text-transform: uppercase; }
  td:first-child { color: #888; }
  input[type=text], input[type=number] { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 3px 6px; font-family: monospace; font-size: 0.85rem; width: 100%; box-sizing: border-box; }
  button { background: #005a9e; color: #fff; border: none; border-radius: 3px; padding: 5px 12px; cursor: pointer; font-family: monospace; font-size: 0.85rem; margin-top: 6px; }
  button:hover { background: #0070c4; }
  button.danger { background: #7a1212; }
  button.danger:hover { background: #a01818; }
  .tab-bar { display: flex; gap: 2px; margin-bottom: 16px; }
  .tab { padding: 6px 16px; border-radius: 4px 4px 0 0; cursor: pointer; background: #222; color: #aaa; border: 1px solid #333; border-bottom: none; }
  .tab.active { background: #1a1a1a; color: #eee; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .msg { color: #4f4; font-size: 0.8rem; margin-top: 4px; min-height: 1em; }
  .preset-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 4px; }
  .preset-slot { background: #222; border-radius: 4px; padding: 6px 8px; font-size: 0.8rem; }
  .preset-slot .slot-name { color: #aaa; font-size: 0.7rem; }
  .preset-slot .slot-val { color: #ccc; }
  .preset-slot button { margin-top: 4px; width: 100%; padding: 2px; font-size: 0.75rem; }
  select { background: #222; color: #eee; border: 1px solid #444; border-radius: 3px; padding: 3px 6px; font-family: monospace; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>FPS CamControl</h1>

<div class="tab-bar">
  <div class="tab active" onclick="switchTab('live')">Live Status</div>
  <div class="tab" onclick="switchTab('config')">Config</div>
  <div class="tab" onclick="switchTab('presets')">Presets</div>
</div>

<div id="tab-live" class="tab-content active">
  <div class="panel">
    <h2>Live Status</h2>
    <div id="status-content">Loading&hellip;</div>
  </div>
</div>

<div id="tab-config" class="tab-content">
  <div class="panel">
    <h2>Camera Labels / IPs / Input IDs</h2>
    <div id="cam-edit-form">Loading&hellip;</div>
    <button onclick="saveCameras()">Save Cameras</button>
    <div class="msg" id="cam-msg"></div>
  </div>

  <div class="panel">
    <h2>Speed Presets</h2>
    <div id="speed-edit-form">Loading&hellip;</div>
    <button onclick="saveSpeeds()">Save Speeds</button>
    <div class="msg" id="speed-msg"></div>
  </div>

  <div class="panel">
    <h2>ATEM Default Transition</h2>
    <select id="atem-transition">
      <option value="cut">Cut</option>
      <option value="auto">Auto</option>
    </select>
    <button onclick="saveAtem()">Save</button>
    <div class="msg" id="atem-msg"></div>
  </div>
</div>

<div id="tab-presets" class="tab-content">
  <div class="panel">
    <h2>Shot Zone Presets</h2>
    <div id="presets-content">Loading&hellip;</div>
  </div>
</div>

<script>
let _config = null;
let _presets = null;

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}

async function refresh() {
  try {
    const [status, config] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
    ]);
    _config = config;
    renderStatus(status, config);
    renderConfigForms(config);
  } catch(e) {
    document.getElementById('status-content').textContent = 'Error fetching status';
  }
  try {
    const presets = await fetch('/api/presets').then(r => r.json());
    _presets = presets;
    renderPresets(presets, _config);
  } catch(e) {}
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

function renderConfigForms(c) {
  const cams = c.cameras || [];
  const camHtml = '<table><tr><th>ID</th><th>Label</th><th>Visca IP</th><th>Visca Port</th><th>Input ID</th></tr>' +
    cams.map(cam =>
      '<tr>' +
      '<td>' + cam.id + '</td>' +
      '<td><input type="text" id="cam_label_' + cam.id + '" value="' + esc(cam.label) + '"></td>' +
      '<td><input type="text" id="cam_ip_' + cam.id + '" value="' + esc(cam.viscaIp) + '"></td>' +
      '<td><input type="number" id="cam_port_' + cam.id + '" value="' + cam.viscaPort + '" style="width:80px"></td>' +
      '<td><input type="number" id="cam_input_' + cam.id + '" value="' + cam.inputId + '" style="width:60px"></td>' +
      '</tr>'
    ).join('') + '</table>';
  document.getElementById('cam-edit-form').innerHTML = camHtml;

  const speeds = (c.speeds && c.speeds.presets) || [];
  const speedHtml = '<table><tr><th>#</th><th>Name</th><th>Multiplier</th></tr>' +
    speeds.map((sp, i) =>
      '<tr>' +
      '<td>' + i + '</td>' +
      '<td><input type="text" id="sp_name_' + i + '" value="' + esc(sp.name) + '"></td>' +
      '<td><input type="number" id="sp_mul_' + i + '" value="' + sp.multiplier + '" step="0.05" style="width:80px"></td>' +
      '</tr>'
    ).join('') + '</table>';
  document.getElementById('speed-edit-form').innerHTML = speedHtml;

  const sel = document.getElementById('atem-transition');
  if (c.atem && sel) sel.value = c.atem.defaultTransition || 'cut';
}

function renderPresets(presets, config) {
  const cams = (config && config.cameras) || [];
  const slots = ['A', 'B', 'X', 'Y'];
  let html = '';
  for (const cam of cams) {
    html += '<div class="section"><strong>' + cam.label + ' (' + cam.id + ')</strong><div class="preset-grid">';
    for (const slot of slots) {
      const pos = presets[cam.id] && presets[cam.id][slot];
      const valStr = pos ? 'P:' + pos.pan + ' T:' + pos.tilt + ' Z:' + pos.zoom : '—';
      html += '<div class="preset-slot">' +
        '<div class="slot-name">' + slot + '</div>' +
        '<div class="slot-val">' + valStr + '</div>' +
        (pos ? '<button class="danger" onclick="clearPreset(\'' + cam.id + '\',\'' + slot + '\')">Clear</button>' : '') +
        '</div>';
    }
    html += '</div></div>';
  }
  document.getElementById('presets-content').innerHTML = html || 'No preset data';
}

async function saveCameras() {
  const cams = (_config && _config.cameras) || [];
  const updates = cams.map(cam => ({
    id: cam.id,
    label: document.getElementById('cam_label_' + cam.id).value,
    viscaIp: document.getElementById('cam_ip_' + cam.id).value,
    viscaPort: parseInt(document.getElementById('cam_port_' + cam.id).value, 10),
    inputId: parseInt(document.getElementById('cam_input_' + cam.id).value, 10),
  }));
  try {
    const r = await fetch('/api/config/cameras', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates) });
    const j = await r.json();
    document.getElementById('cam-msg').textContent = j.ok ? 'Saved.' : ('Error: ' + j.error);
    if (j.ok) { _config.cameras = j.cameras; setTimeout(() => document.getElementById('cam-msg').textContent = '', 3000); }
  } catch(e) { document.getElementById('cam-msg').textContent = 'Request failed'; }
}

async function saveSpeeds() {
  const speeds = (_config && _config.speeds && _config.speeds.presets) || [];
  const presets = speeds.map((_, i) => ({
    name: document.getElementById('sp_name_' + i).value,
    multiplier: parseFloat(document.getElementById('sp_mul_' + i).value),
  }));
  try {
    const r = await fetch('/api/config/speeds', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ presets }) });
    const j = await r.json();
    document.getElementById('speed-msg').textContent = j.ok ? 'Saved.' : ('Error: ' + j.error);
    if (j.ok) { setTimeout(() => document.getElementById('speed-msg').textContent = '', 3000); }
  } catch(e) { document.getElementById('speed-msg').textContent = 'Request failed'; }
}

async function saveAtem() {
  const val = document.getElementById('atem-transition').value;
  try {
    const r = await fetch('/api/config/atem', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ defaultTransition: val }) });
    const j = await r.json();
    document.getElementById('atem-msg').textContent = j.ok ? 'Saved.' : ('Error: ' + j.error);
    if (j.ok) { setTimeout(() => document.getElementById('atem-msg').textContent = '', 3000); }
  } catch(e) { document.getElementById('atem-msg').textContent = 'Request failed'; }
}

async function clearPreset(cameraId, slot) {
  try {
    await fetch('/api/presets/' + cameraId + '/' + slot, { method: 'DELETE' });
    const presets = await fetch('/api/presets').then(r => r.json());
    _presets = presets;
    renderPresets(presets, _config);
  } catch(e) {}
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

setInterval(refresh, 1000);
refresh();
</script>
</body>
</html>`;
}
