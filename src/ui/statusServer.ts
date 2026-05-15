import express from 'express';
import os from 'os';
import { AppState } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { PresetManager } from '../model/presetManager';
import { logger } from '../index';

function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

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
      lowerThirds: config.lowerThirds,
      speeds: config.speeds,
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
  app.listen(port, '0.0.0.0', () => {
    const lanIp = getLanIp();
    logger.info({ port }, 'status UI running');
    logger.info(`Status UI: http://${lanIp}:${port}`);
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
  .badge.warn { background: #553300; color: #fa8; }
  .section { margin-top: 8px; }
  .label { font-size: 0.75rem; color: #666; margin-bottom: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td { padding: 4px 8px; border-bottom: 1px solid #222; }
  td:first-child { color: #888; }
  .countdown { font-size: 1rem; letter-spacing: 2px; }
</style>
</head>
<body>
<h1>FPS CamControl</h1>

<div class="panel">
  <h2>Live Status</h2>
  <div id="status-content">Loading&hellip;</div>
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

  // Preset save countdown (P3-D)
  let presetHold = '';
  if (s.presetSaveProgress) {
    const p = s.presetSaveProgress;
    const pct = Math.min(100, Math.round((p.framesHeld / 120) * 100));
    const secs = ((120 - p.framesHeld) / 60).toFixed(1);
    const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
    presetHold = '<div class="section"><span class="badge warn countdown">Hold to save ' + p.slot + '... ' + secs + 's [' + bar + '] (release to cancel)</span></div>';
  }

  document.getElementById('status-content').innerHTML =
    '<div class="row">' + program + preview + controlled + '</div>' +
    '<div class="row section">' + atem + ctrl + '</div>' +
    '<div class="row section">' + camStatus + '</div>' +
    '<div class="row section">' + speedBadge + precision + sprint + lt + '</div>' +
    (s.lastPresetNotification ? '<div class="section"><span class="badge on">Preset: ' + s.lastPresetNotification + '</span></div>' : '') +
    presetHold;

  document.getElementById('config-content').innerHTML =
    '<table>' +
    cams.map(cam =>
      '<tr><td>' + cam.id + '</td><td>' + cam.label + '</td><td>' + cam.viscaIp + ':' + cam.viscaPort + '</td><td>Input ' + cam.inputId + '</td><td>' + (cam.cameraType || 'generic') + '</td></tr>'
    ).join('') +
    '</table>';
}

setInterval(refresh, 1000);
refresh();
</script>
</body>
</html>`;
}
