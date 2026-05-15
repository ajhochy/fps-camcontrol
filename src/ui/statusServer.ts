import express from 'express';
import { Atem } from 'atem-connection';
import { AppState } from '../app/state';
import { AppConfig, validateDevicesConfig, saveDevicesConfig } from '../config/configLoader';
import { AtemClient } from '../atem/atemClient';
import { PresetManager } from '../model/presetManager';
import { logger } from '../index';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager,
  atemClient: AtemClient
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

  app.post('/api/config', (req, res) => {
    try {
      const validated = validateDevicesConfig(req.body);
      saveDevicesConfig(validated);
      Object.assign(config, validated);
      logger.info('config saved and hot-reloaded');
      res.json({ ok: true });
    } catch (err: any) {
      logger.warn({ err }, 'config save failed validation');
      res.status(400).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  app.get('/api/inputs', (_req, res) => {
    if (!atemClient.connected) {
      res.json({ connected: false, inputs: [] });
      return;
    }
    res.json({ connected: true, inputs: atemClient.getAvailableInputs() });
  });

  app.post('/api/test/atem', async (req, res) => {
    const ip: string = req.body?.ip ?? config.atem.ip;
    const testAtem = new Atem();
    let resolved = false;
    const finish = (ok: boolean, msg: string) => {
      if (resolved) return;
      resolved = true;
      try { testAtem.disconnect(); } catch { /* ignore */ }
      res.json({ ok, message: msg });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), 4000);
    testAtem.on('connected', () => { clearTimeout(timer); finish(true, 'connected'); });
    testAtem.on('error', (err: unknown) => { clearTimeout(timer); finish(false, String(err)); });
    testAtem.connect(ip);
  });

  app.post('/api/test/visca', (req, res) => {
    const { ip, port = 52381 } = req.body ?? {};
    if (!ip) { res.status(400).json({ ok: false, message: 'ip required' }); return; }
    import('dgram').then(dgram => {
      const sock = dgram.createSocket('udp4');
      let resolved = false;
      const finish = (ok: boolean, msg: string) => {
        if (resolved) return;
        resolved = true;
        try { sock.close(); } catch { /* ignore */ }
        res.json({ ok, message: msg });
      };
      const timer = setTimeout(() => finish(false, 'no response (timeout)'), 2000);
      sock.on('message', () => { clearTimeout(timer); finish(true, 'responded'); });
      sock.on('error', (err) => { clearTimeout(timer); finish(false, err.message); });
      // VISCA IF_CLEAR — safe probe command
      const cmd = Buffer.from([0x81, 0x01, 0x00, 0x01, 0xff]);
      sock.bind(0, () => {
        sock.send(cmd, 0, cmd.length, Number(port), ip);
      });
    });
  });

  app.get('/api/presets', (_req, res) => {
    res.json(presetManager.getData());
  });

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
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: monospace; background: #111; color: #eee; padding: 20px; max-width: 960px; margin: 0 auto; }
  h1 { color: #0af; margin-bottom: 10px; }
  h2 { margin: 0 0 12px; color: #aaa; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; }
  h3 { color: #7af; font-size: 0.9rem; margin: 0 0 10px; }
  .panel { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
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
  td { padding: 4px 8px; border-bottom: 1px solid #222; }
  td:first-child { color: #888; }
  .config-section { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid #2a2a2a; }
  .config-section:last-of-type { border-bottom: none; margin-bottom: 4px; }
  .field-row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; flex-wrap: wrap; }
  .field-row label { color: #999; font-size: 0.82rem; min-width: 130px; }
  input[type=text], input[type=number], select {
    background: #222; color: #eee; border: 1px solid #444; border-radius: 3px;
    padding: 4px 7px; font-family: monospace; font-size: 0.85rem; min-width: 160px;
  }
  input[type=number] { min-width: 70px; }
  input[type=radio] { accent-color: #0af; }
  input[type=radio] + label { color: #ccc; margin-left: 4px; min-width: 0; }
  .radio-group { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .radio-group .option { display: flex; align-items: center; gap: 4px; }
  .btn { background: #1e3a5f; color: #7af; border: 1px solid #2a5a9f; border-radius: 4px;
    padding: 5px 12px; font-family: monospace; font-size: 0.82rem; cursor: pointer; }
  .btn:hover { background: #2a4a7f; }
  .btn.danger { background: #4a1a1a; color: #f88; border-color: #7a2a2a; }
  .btn.danger:hover { background: #5a2020; }
  .btn.success { background: #1a4a1a; color: #4f4; border-color: #2a7a2a; }
  .test-result { font-size: 0.8rem; margin-left: 6px; }
  .test-result.ok { color: #4f4; }
  .test-result.err { color: #f44; }
  .camera-card { background: #1f1f1f; border: 1px solid #333; border-radius: 5px; padding: 12px; margin-bottom: 10px; }
  .camera-card h4 { margin: 0 0 8px; color: #aaf; font-size: 0.85rem; }
  .save-bar { margin-top: 14px; display: flex; align-items: center; gap: 12px; }
  .toast { font-size: 0.85rem; padding: 4px 10px; border-radius: 4px; }
  .toast.ok { background: #1a4a1a; color: #4f4; }
  .toast.err { background: #4a1a1a; color: #f88; }
  .note { font-size: 0.75rem; color: #666; margin-top: 4px; }
  details > summary { cursor: pointer; color: #7af; font-size: 0.85rem; user-select: none; }
  details[open] > summary { margin-bottom: 12px; }
</style>
</head>
<body>
<h1>FPS CamControl</h1>

<div class="panel">
  <h2>Live Status</h2>
  <div id="status-content">Loading&hellip;</div>
</div>

<div class="panel">
  <h2>Settings</h2>

  <!-- ATEM -->
  <div class="config-section">
    <h3>ATEM Switcher</h3>
    <div class="field-row">
      <label>IP Address</label>
      <input type="text" id="atem-ip" placeholder="192.168.50.10">
      <button class="btn" onclick="testAtem()">Test Connection</button>
      <span id="atem-test-result" class="test-result"></span>
    </div>
    <div class="field-row">
      <label>Default Transition</label>
      <select id="atem-transition">
        <option value="cut">Cut</option>
        <option value="auto">Auto</option>
      </select>
    </div>
    <div class="field-row">
      <label>ME Index</label>
      <input type="number" id="atem-me" min="0" max="3" value="0">
    </div>
  </div>

  <!-- Graphics / Lower Thirds -->
  <div class="config-section">
    <h3>Graphics / Lower Thirds</h3>
    <div class="field-row">
      <label>Key Type</label>
      <div class="radio-group">
        <div class="option"><input type="radio" name="gfx-type" id="gfx-dsk" value="dsk"><label for="gfx-dsk">DSK</label></div>
        <div class="option"><input type="radio" name="gfx-type" id="gfx-usk" value="usk"><label for="gfx-usk">USK (Upstream)</label></div>
        <div class="option"><input type="radio" name="gfx-type" id="gfx-auto" value="auto"><label for="gfx-auto">Auto</label></div>
      </div>
    </div>
    <p class="note">DSK is a hardware downstream keyer. USK (Upstream Key) is used when graphics come from a computer (e.g. ProPresenter) through the ATEM. If unsure, try DSK first.</p>
    <div id="dsk-fields" class="field-row">
      <label>DSK Index</label>
      <input type="number" id="gfx-dsk-index" min="0" max="3" value="0">
    </div>
    <div id="usk-fields" class="field-row" style="display:none">
      <label>USK Index</label>
      <input type="number" id="gfx-usk-index" min="0" max="3" value="0">
    </div>
  </div>

  <!-- Cameras -->
  <div class="config-section">
    <h3>Cameras</h3>
    <div id="cameras-list"></div>
    <button class="btn" style="margin-top:8px" onclick="addCamera()">+ Add Camera</button>
  </div>

  <div class="save-bar">
    <button class="btn success" onclick="saveConfig()">Save All Settings</button>
    <span id="save-toast" class="toast" style="display:none"></span>
  </div>
</div>

<script>
// ---- State ----
let availableInputs = [];
let cameraIdCounter = 0;

// ---- Boot ----
async function init() {
  const [cfg, inp] = await Promise.all([
    fetch('/api/config').then(r => r.json()).catch(() => null),
    fetch('/api/inputs').then(r => r.json()).catch(() => ({ connected: false, inputs: [] })),
  ]);
  availableInputs = inp.inputs || [];
  if (cfg) populateForm(cfg);
  refresh();
}

setInterval(refresh, 1000);

// ---- Status ----
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

function camLabel(cams, id) { return (cams.find(x => x.id === id) || {}).label || id; }

function renderStatus(s, c) {
  const cams = c.cameras || [];
  const controlled = '<span class="badge controlled">CONTROLLED: ' + camLabel(cams, s.controlledCamera) + '</span>';
  const program = '<span class="badge live">PGM: ' + camLabel(cams, s.programCamera) + '</span>';
  const preview = '<span class="badge preview">PVW: ' + camLabel(cams, s.previewCamera) + '</span>';
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

// ---- Config form population ----
function populateForm(cfg) {
  document.getElementById('atem-ip').value = cfg.atem.ip || '';
  document.getElementById('atem-transition').value = cfg.atem.defaultTransition || 'cut';
  document.getElementById('atem-me').value = cfg.atem.meIndex ?? 0;

  const gfxType = cfg.graphics?.type || 'dsk';
  document.querySelector('input[name="gfx-type"][value="' + gfxType + '"]').checked = true;
  document.getElementById('gfx-dsk-index').value = cfg.graphics?.dskIndex ?? 0;
  document.getElementById('gfx-usk-index').value = cfg.graphics?.uskIndex ?? 0;
  updateGfxVisibility(gfxType);

  const list = document.getElementById('cameras-list');
  list.innerHTML = '';
  (cfg.cameras || []).forEach(cam => addCameraCard(cam));

  // Wire radio change
  document.querySelectorAll('input[name="gfx-type"]').forEach(r =>
    r.addEventListener('change', e => updateGfxVisibility(e.target.value))
  );
}

function updateGfxVisibility(type) {
  document.getElementById('dsk-fields').style.display = (type === 'dsk' || type === 'auto') ? 'flex' : 'none';
  document.getElementById('usk-fields').style.display = (type === 'usk') ? 'flex' : 'none';
}

// ---- Camera cards ----
function addCameraCard(cam) {
  const id = cam ? cam.id : ('cam' + (++cameraIdCounter + 100));
  const card = document.createElement('div');
  card.className = 'camera-card';
  card.id = 'card-' + id;

  const inputOptions = availableInputs.length
    ? '<select data-field="inputId">' +
        availableInputs.map(i => '<option value="' + i.id + '"' + (cam && cam.inputId === i.id ? ' selected' : '') + '>' + i.longName + ' (' + i.id + ')</option>').join('') +
      '</select>'
    : '<input type="number" data-field="inputId" value="' + (cam ? cam.inputId : 1) + '" min="1" max="9999">';

  card.innerHTML = [
    '<div class="field-row"><label>Camera ID</label><input type="text" data-field="id" value="' + (cam ? esc(cam.id) : id) + '"></div>',
    '<div class="field-row"><label>Label</label><input type="text" data-field="label" value="' + (cam ? esc(cam.label) : '') + '"></div>',
    '<div class="field-row"><label>Camera Type</label><select data-field="cameraType">',
      '<option value="generic"' + (cam && cam.cameraType === 'generic' ? ' selected' : '') + '>Generic</option>',
      '<option value="vbot"' + (cam && cam.cameraType === 'vbot' ? ' selected' : '') + '>V-BOT (Sony)</option>',
      '<option value="birddog"' + (cam && cam.cameraType === 'birddog' ? ' selected' : '') + '>BirdDog</option>',
    '</select></div>',
    '<div class="field-row"><label>ATEM Input</label>' + inputOptions + '</div>',
    '<div class="field-row"><label>VISCA IP</label><input type="text" data-field="viscaIp" value="' + (cam ? esc(cam.viscaIp) : '') + '"><input type="number" data-field="viscaPort" value="' + (cam ? cam.viscaPort : 52381) + '" min="1" max="65535" style="min-width:90px"></div>',
    '<div class="field-row">',
      '<button class="btn" onclick="testVisca(this)">Test VISCA</button>',
      '<span class="test-result" style="margin-left:6px"></span>',
      '<button class="btn danger" style="margin-left:auto" onclick="removeCamera(this)">Remove</button>',
    '</div>',
  ].join('');

  document.getElementById('cameras-list').appendChild(card);
}

function addCamera() { addCameraCard(null); }

function removeCamera(btn) {
  const card = btn.closest('.camera-card');
  const id = card.querySelector('[data-field="id"]').value;
  if (confirm('Remove camera "' + id + '"?')) card.remove();
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ---- ATEM test ----
async function testAtem() {
  const ip = document.getElementById('atem-ip').value.trim();
  const el = document.getElementById('atem-test-result');
  el.textContent = '…testing…'; el.className = 'test-result';
  try {
    const r = await fetch('/api/test/atem', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ip }) });
    const data = await r.json();
    el.textContent = data.ok ? '✓ Connected' : '✗ ' + data.message;
    el.className = 'test-result ' + (data.ok ? 'ok' : 'err');
  } catch(e) { el.textContent = '✗ request failed'; el.className = 'test-result err'; }
}

// ---- VISCA test ----
async function testVisca(btn) {
  const card = btn.closest('.camera-card');
  const ip = card.querySelector('[data-field="viscaIp"]').value.trim();
  const port = card.querySelector('[data-field="viscaPort"]').value;
  const el = btn.nextElementSibling;
  el.textContent = '…probing…'; el.className = 'test-result';
  try {
    const r = await fetch('/api/test/visca', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ip, port: Number(port) }) });
    const data = await r.json();
    el.textContent = data.ok ? '✓ ' + data.message : '✗ ' + data.message;
    el.className = 'test-result ' + (data.ok ? 'ok' : 'err');
  } catch(e) { el.textContent = '✗ request failed'; el.className = 'test-result err'; }
}

// ---- Save config ----
async function saveConfig() {
  const toast = document.getElementById('save-toast');

  const gfxType = document.querySelector('input[name="gfx-type"]:checked')?.value || 'dsk';

  const cameras = Array.from(document.querySelectorAll('.camera-card')).map(card => ({
    id: card.querySelector('[data-field="id"]').value.trim(),
    label: card.querySelector('[data-field="label"]').value.trim(),
    cameraType: card.querySelector('[data-field="cameraType"]').value,
    inputId: Number(card.querySelector('[data-field="inputId"]').value),
    viscaIp: card.querySelector('[data-field="viscaIp"]').value.trim(),
    viscaPort: Number(card.querySelector('[data-field="viscaPort"]').value),
  }));

  const payload = {
    atem: {
      ip: document.getElementById('atem-ip').value.trim(),
      defaultTransition: document.getElementById('atem-transition').value,
      meIndex: Number(document.getElementById('atem-me').value),
    },
    graphics: {
      type: gfxType,
      dskIndex: Number(document.getElementById('gfx-dsk-index').value),
      uskIndex: Number(document.getElementById('gfx-usk-index').value),
      meIndex: Number(document.getElementById('atem-me').value),
    },
    cameras,
  };

  try {
    const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const data = await r.json();
    toast.textContent = data.ok ? '✓ Saved' : '✗ ' + data.error;
    toast.className = 'toast ' + (data.ok ? 'ok' : 'err');
    toast.style.display = 'inline-block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
  } catch(e) {
    toast.textContent = '✗ request failed';
    toast.className = 'toast err';
    toast.style.display = 'inline-block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
  }
}

init();
</script>
</body>
</html>`;
}
