#!/usr/bin/env node
'use strict';
// Consume an explicit, read-only mounted installer. Only disposable loopback
// hardware fixtures and a new HOME are used; no production-only test switches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  assert.fail('Actual tracking runtime deadline: ' + label);
}
async function gone(pid, timeout = 12000) {
  assert.ok(Number.isInteger(pid) && pid > 1, 'Only an observed owned PID may be inspected');
  await until(() => {
    try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'owned process exit ' + pid, timeout);
}
function pythonChildren(backend, resources) {
  // Read process names, never argument lists or environments carrying secrets.
  return findPythonChildren(backend, resources,
    execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }));
}
function findPythonChildren(backend, resources, snapshot) {
  const interpreter = fs.realpathSync(path.join(resources, 'python/bin/python3'));
  return snapshot
    .split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .filter(row => {
      if (Number(row[2]) !== backend) return false;
      try { return fs.realpathSync(row[3]) === interpreter; } catch { return false; }
    })
    .map(row => Number(row[1]));
}
function isExpectedRecoveryBackpressure(item) {
  if (!['restart-after-backend-crash', 'restart-after-sleep', 'relaunch-after-helper-crash', 'relaunch-after-parent-crash'].includes(item.phase) ||
    item.status !== 503 || !/^[1-9]\d*$/.test(item.retryAfter || '') || item.error !== 'Sony camera is busy; retry shortly') return false;
  try {
    const url = new URL(item.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password &&
      ['/api/sony/cameras/AA:BB/properties', '/api/sony/cameras/AA:BB/live-view/start', '/api/sony/cameras/AA:BB/live-view/frame'].includes(decodeURIComponent(url.pathname));
  } catch { return false; }
}
function isExpectedInjectedDisconnect(item, origins) {
  if (item.method !== 'GET' || !['injected-backend-crash', 'injected-sleep', 'injected-parent-crash', 'normal-quit'].includes(item.phase) ||
    !/^net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|ABORTED)$/.test(item.error || '')) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && origins.has(item.phase + ' ' + url.origin) &&
      ['/api/status', '/api/controllers', '/api/sony/status', '/api/tracking/status', '/api/sony/cameras/AA:BB/live-view/frame'].includes(decodeURIComponent(url.pathname));
  } catch { return false; }
}
function fixtureConfig(bridgePort, sonyPort) {
  return {
    atem: { ip: '127.0.0.1', defaultTransition: 'cut' },
    devices: {
      rig: { label: 'Synthetic gimbal', protocol: 'dji-bridge', bridge: { host: '127.0.0.1', port: bridgePort } },
      camera: { label: 'Synthetic camera', protocol: 'sony', sonyCameraId: 'AA:BB' },
    },
    profiles: { fixture: { label: 'Disposable runtime fixture', slots: [{ device: 'rig', camera: 'camera' }] } },
    activeProfile: 'fixture',
    sony: { enabled: true, apiUrl: 'http://127.0.0.1:' + sonyPort },
    tracking: { enabled: true, sources: [{ device: 'rig', sonyCameraId: 'AA:BB' }] },
  };
}
async function sonyFixture(jpeg) {
  let connected = false, frames = 0;
  const server = http.createServer((request, response) => {
    const route = decodeURIComponent((request.url || '').split('?')[0]);
    response.setHeader('Cache-Control', 'no-store');
    if (route === '/api/cameras/AA:BB/live-view/frame') {
      frames++;
      response.writeHead(200, { 'Content-Type': 'image/jpeg' }); response.end(jpeg); return;
    }
    let body;
    const camera = () => ({ id: 'AA:BB', model: 'Synthetic camera', connectionType: 'Network', connected });
    if (route === '/api/server/status') body = { success: true, server: { version: 'fixture', sdkVersion: 'fixture' } };
    else if (route === '/api/cameras') body = { success: true, cameras: [camera()] };
    else if (route === '/api/cameras/AA:BB/connection') {
      if (request.method === 'POST') connected = true;
      if (request.method === 'DELETE') connected = false;
      body = { success: true, camera: camera(), data: { mode: 'remote' } };
    } else if (route === '/api/cameras/AA:BB/fingerprint') body = { success: true, data: { ssh_supported: false } };
    else if (route === '/api/cameras/AA:BB/properties/all') body = { success: true, camera: camera(), data: { properties: {} } };
    else if (route === '/api/cameras/AA:BB/live-view/start') body = { success: true };
    else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, frames: () => frames };
}
function runRuntimeProof(app, evidence) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'test-tracking-sidecar-runtime.cjs'), '--app', app, '--evidence', evidence], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    const consume = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) child.kill('SIGKILL'); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Packaged Python proof could not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Packaged Python network-denied inference/protocol proof failed; no private diagnostics emitted'));
      else resolve(JSON.parse(fs.readFileSync(evidence, 'utf8')));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--dmg' && path.isAbsolute(args[1]), 'usage: --dmg /absolute/tracking-installer.dmg');
  const dmg = args[1]; assert.ok(fs.statSync(dmg).isFile());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fps tracking mounted runtime '));
  const mount = path.join(temporary, 'Mounted DMG'), home = path.join(temporary, 'fresh HOME'), cwd = path.join(temporary, 'random cwd spaces');
  const evidence = path.join(root, 'docs/ai/runs/electron-tracking-evidence', 'runtime-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const directory of [mount, home, cwd, evidence]) fs.mkdirSync(directory, { recursive: true });
  const app = path.join(mount, 'FPS CamControl Tracking.app'), resources = path.join(app, 'Contents/Resources');
  const executable = path.join(app, 'Contents/MacOS/FPS CamControl Tracking');
  const env = { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', CAMCONTROL_NO_CONTROLLER: '1' };
  const report = { testedAt: new Date().toISOString(), status: 'RUNNING', dmg: { path: dmg, bytes: fs.statSync(dmg).size, sha256: hash(dmg) },
    criteria: {}, screenshots: [], appErrors: [], consoleErrors: [], consoleErrorDetails: [], httpErrors: [], networkErrors: [],
    boundary: 'Exact mounted DMG on developer host, fresh HOME/minimal PATH, real packaged live helper and generated image loopback fixtures. Not clean OS/TCC, camera accuracy, physical hardware or soak acceptance.' };
  let mounted = false, desktop, bridge, sony, currentBackend, currentHelper, currentPage;
  let phase = 'offline-first-launch';
  const responseCaptures = [];
  const disconnectedOrigins = new Set();
  function recordBackendExit(page, nextPhase) {
    phase = nextPhase;
    if (page?.url().startsWith('http://127.0.0.1:')) disconnectedOrigins.add(phase + ' ' + new URL(page.url()).origin);
  }
  const observedPids = new Set();
  const api = (page, route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
    const response = await fetch(route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { route, method, body });
  const backendPid = () => desktop.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'FPS CamControl Backend')?.pid);
  async function launch() {
    desktop = await _electron.launch({ executablePath: executable, cwd, env, timeout: 30000 });
    const page = await desktop.firstWindow(); currentPage = page;
    page.on('pageerror', error => report.appErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') {
      report.consoleErrors.push(message.text());
      report.consoleErrorDetails.push({ phase, text: message.text(), location: { ...message.location(), url: message.location().url.replace(/\?.*$/, '') } });
    } });
    page.on('response', response => { if (response.status() >= 400) {
      const item = { phase, status: response.status(), url: response.url().replace(/\?.*$/, ''), retryAfter: response.headers()['retry-after'] };
      report.httpErrors.push(item);
      responseCaptures.push(response.json().then(body => { item.error = typeof body.error === 'string' ? body.error.slice(0, 256) : null; }).catch(() => { item.error = null; }));
    } });
    page.on('requestfailed', request => report.networkErrors.push({ phase, method: request.method(), url: request.url().replace(/\?.*$/, ''), error: request.failure()?.errorText }));
    if (page.url().startsWith('file:') && await page.getByRole('button', { name: 'Open dashboard' }).count()) {
      await until(() => page.evaluate(() => window.fpsShell.status().then(value => value === 'ready')), 'setup ready');
      await page.getByRole('button', { name: 'Open dashboard' }).click();
    }
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 30000 });
    currentBackend = await backendPid(); assert.ok(currentBackend); observedPids.add(currentBackend);
    return page;
  }
  async function awaitHelper(page) {
    await until(async () => (await api(page, '/api/tracking/status')).body.sidecar.state === 'connected', 'actual live helper connected', 60000);
    const children = pythonChildren(currentBackend, resources); assert.equal(children.length, 1, 'Exactly one Python belongs to the actual backend');
    currentHelper = children[0]; observedPids.add(currentHelper); return currentHelper;
  }
  async function awaitPreview(page) {
    const preview = page.locator('.sony-widget[data-camera-id="AA:BB"] .sony-preview img');
    await preview.waitFor({ timeout: 15000 });
    await until(() => preview.evaluate(image => image.naturalWidth === 640 && !image.parentElement.classList.contains('sony-preview-stale') && !image.parentElement.classList.contains('sony-preview-loading')), 'actual preview recovers after explicit restart', 20000);
  }
  async function close() {
    const backend = currentBackend, helper = currentHelper;
    if (desktop) { recordBackendExit(currentPage, 'normal-quit'); await desktop.close(); desktop = null; }
    if (backend) await gone(backend);
    if (helper) await gone(helper);
    currentBackend = currentHelper = undefined;
  }
  function stoppedMotion(label) {
    assert.equal(bridge.velPan, 0, label + ': pan is zero'); assert.equal(bridge.velTilt, 0, label + ': tilt is zero');
  }
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'pipe' }); mounted = true;
    report.appAsarSha256 = hash(path.join(resources, 'app.asar'));
    for (const file of ['backend/docs/tracking.md', 'backend/docs/electron.md', 'runtime-manifest.json']) assert.ok(fs.statSync(path.join(resources, file)).isFile());
    const started = Date.now(); let page = await launch(); report.startupMs = Date.now() - started;
    const runtime = await desktop.evaluate(({ app: electronApp, BrowserWindow }) => ({ userData: electronApp.getPath('userData'), versions: process.versions,
      preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
    assert.ok(runtime.userData.startsWith(home + path.sep)); assert.ok(runtime.userData.endsWith('FPS CamControl Tracking'));
    assert.equal(runtime.preferences.sandbox, true); assert.equal(runtime.preferences.contextIsolation, true); assert.equal(runtime.preferences.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    report.runtime = { versions: runtime.versions, separateUserData: true, sandbox: true, contextIsolation: true, nodeIntegration: false };
    assert.equal((await api(page, '/api/tracking/status')).body.enabled, false);
    await delay(1000); assert.deepEqual(pythonChildren(currentBackend, resources), [], 'Default disabled tracking never starts Python');
    report.criteria.defaultDisabledNoHelper = 'PASS';
    assert.equal((await fetch(new URL('/api/tracking/status', page.url()))).status, 403, 'No anonymous tracking API');
    assert.equal((await api(page, '/api/controllers')).status, 200, 'Actual packaged HID addon can enumerate without opening hardware');
    await close();
    report.packagedPython = await runRuntimeProof(app, path.join(evidence, 'bundled-python-proof.json'));
    report.criteria.packagedNetworkDeniedModelAndProtocol = 'PASS';
    // Generate a non-photographic RGB test image in memory using shipped Pillow.
    // There is no recorded camera data, face imagery or persisted frame file.
    const jpeg = execFileSync(path.join(resources, 'python/bin/python3'), ['-I', '-B', '-c',
      'import sys;from PIL import Image,ImageDraw;i=Image.new("RGB",(640,480),(23,29,33));d=ImageDraw.Draw(i);d.rectangle((180,120,460,360),fill=(50,90,120));i.save(sys.stdout.buffer,format="JPEG")'], { cwd, env, maxBuffer: 1024 * 1024 });
    require('ts-node/register/transpile-only');
    const { VirtualDjiBridge } = require('../src/testing/virtualDjiBridge');
    bridge = new VirtualDjiBridge({ port: 0, statusIntervalMs: 50 }); const bridgePort = await bridge.start();
    sony = await sonyFixture(jpeg);
    const saved = path.join(runtime.userData, 'config/devices.yaml');
    assert.ok(saved.startsWith(home + path.sep));
    fs.writeFileSync(saved, require('yaml').stringify(fixtureConfig(bridgePort, sony.port)));
    phase = 'configured-first-launch'; page = await launch(); await awaitHelper(page);
    assert.equal((await api(page, '/api/sony/cameras/discover', 'POST')).status, 200);
    assert.equal((await api(page, '/api/sony/cameras/AA%3ABB/connect', 'POST')).status, 200);
    await until(() => bridge.log.some(line => line.startsWith('hello ')), 'real backend connected to virtual gimbal');
    const widget = page.locator('.sony-widget[data-camera-id="AA:BB"]');
    await widget.waitFor({ timeout: 15000 });
    const preview = widget.locator('.sony-preview img');
    await until(() => preview.evaluate(image => image.naturalWidth === 640), 'actual packaged preview decoded generated JPEG');
    assert.equal(await widget.getByRole('button', { name: 'Focus (touch)', exact: true }).getAttribute('aria-pressed'), 'true');
    await widget.getByRole('button', { name: 'Track', exact: true }).click();
    const bounds = await preview.boundingBox(); assert.ok(bounds);
    const beforeFrames = sony.frames();
    const selectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tracking/select' && response.request().method() === 'POST');
    await preview.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    const selected = await selectedResponse;
    assert.equal(selected.status(), 200, 'Actual installed Track click reaches the real authenticated backend');
    const point = selected.request().postDataJSON();
    assert.equal(point.sourceId, 'rig'); assert.ok(Math.abs(point.x - .5) < .01 && Math.abs(point.y - .5) < .01);
    report.criteria.packagedClickToTrack = 'PASS';
    await until(() => sony.frames() > beforeFrames, 'live helper consumes synthetic Sony frame');
    await until(async () => {
      const source = (await api(page, '/api/tracking/status')).body.sources[0];
      return source.sessionId === null && source.state === 'idle';
    }, 'generated image has no selected person; live session stops safely');
    stoppedMotion('no detected person');
    assert.ok(!bridge.log.some(line => {
      if (!line.startsWith('moveVelocity ')) return false;
      const value = JSON.parse(line.slice('moveVelocity '.length)); return value.pan !== 0 || value.tilt !== 0;
    }), 'Generated no-person frames must not drive gimbal motion');
    // This full-app path proves safe idle, not a particular detector outcome.
    // The separate real live-helper protocol proof must distinguish no_target
    // from source_unavailable using the helper's actual messages and metrics.
    report.criteria.configuredLiveFrameIdleSafe = 'PASS'; report.syntheticFrameRequests = sony.frames();
    assert.deepEqual(report.appErrors, [], 'No page JS errors before fault injection');
    assert.deepEqual(report.consoleErrors, [], 'No console errors before fault injection');
    assert.deepEqual(report.networkErrors, [], 'No failed UI requests before fault injection');
    const screenshot = path.join(evidence, 'mounted-tracking-dashboard.png'); await page.screenshot({ path: screenshot, fullPage: true });
    report.screenshots.push({ path: screenshot, sha256: hash(screenshot) });
    phase = 'injected-helper-crash';
    const killedHelper = currentHelper; process.kill(killedHelper, 'SIGKILL'); await gone(killedHelper); currentHelper = undefined;
    await until(async () => (await api(page, '/api/tracking/status')).body.sidecar.state === 'offline', 'helper crash invalidates connection');
    await delay(1200); assert.deepEqual(pythonChildren(currentBackend, resources), [], 'No automatic helper restart'); stoppedMotion('helper crash');
    assert.equal((await api(page, '/api/tracking/status')).body.sources[0].sessionId, null);
    report.criteria.helperCrashNoReplay = 'PASS';
    await close(); phase = 'relaunch-after-helper-crash'; page = await launch(); await awaitHelper(page);
    const backendBeforeCrash = currentBackend, helperBeforeCrash = currentHelper;
    recordBackendExit(page, 'injected-backend-crash');
    process.kill(backendBeforeCrash, 'SIGKILL');
    await page.getByRole('alert').filter({ hasText: 'service recovered with controls paused' }).waitFor({ timeout: 20000 });
    await gone(helperBeforeCrash); await gone(backendBeforeCrash); currentHelper = undefined;
    currentBackend = await backendPid(); assert.ok(currentBackend && currentBackend !== backendBeforeCrash); observedPids.add(currentBackend);
    await delay(1200); assert.deepEqual(pythonChildren(currentBackend, resources), [], 'Paused recovery cannot launch a new tracking helper'); stoppedMotion('backend crash');
    report.criteria.backendCrashStopsHelperPausedRecovery = 'PASS';
    phase = 'restart-after-backend-crash';
    await page.getByRole('button', { name: 'Restart controls' }).click(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    currentBackend = await backendPid(); observedPids.add(currentBackend); await awaitHelper(page);
    assert.equal((await api(page, '/api/tracking/status')).body.sources[0].sessionId, null, 'Explicit restart never replays target');
    await awaitPreview(page);
    const sleepBackend = currentBackend, sleepHelper = currentHelper;
    recordBackendExit(page, 'injected-sleep');
    await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    await page.getByRole('alert').filter({ hasText: 'stopped for sleep' }).waitFor({ timeout: 16000 });
    await gone(sleepBackend); await gone(sleepHelper); currentBackend = currentHelper = undefined;
    await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('resume')); await delay(1200);
    assert.equal(await backendPid(), undefined, 'Wake never resumes tracking automatically'); stoppedMotion('sleep');
    report.criteria.sleepStopsHelperWakeInert = 'PASS';
    phase = 'restart-after-sleep';
    await page.getByRole('button', { name: 'Restart controls' }).click(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    currentBackend = await backendPid(); observedPids.add(currentBackend); await awaitHelper(page);
    await awaitPreview(page);
    const parentBackend = currentBackend, parentHelper = currentHelper;
    recordBackendExit(page, 'injected-parent-crash');
    desktop.process().kill('SIGKILL'); desktop = null;
    await gone(parentBackend); await gone(parentHelper); currentBackend = currentHelper = undefined; stoppedMotion('parent crash');
    report.criteria.parentCrashNoOrphans = 'PASS';
    phase = 'relaunch-after-parent-crash'; page = await launch(); await awaitHelper(page);
    await awaitPreview(page);
    assert.equal((await api(page, '/api/tracking/status')).body.sources[0].sessionId, null, 'Full relaunch requires a fresh target');
    phase = 'normal-quit'; await close(); stoppedMotion('normal quit'); report.criteria.normalQuitStopsOwnedHelper = 'PASS';
    report.injectedFaultObservations = { appErrors: [...report.appErrors], consoleErrors: [...report.consoleErrors], networkErrors: [...report.networkErrors] };
    await Promise.all(responseCaptures);
    assert.deepEqual(report.appErrors, [], 'No page JS errors after recovery and relaunch');
    report.expectedRecoveryResponses = report.httpErrors.filter(isExpectedRecoveryBackpressure);
    assert.deepEqual(report.httpErrors.filter(item => !isExpectedRecoveryBackpressure(item)), [], 'No unexpected HTTP errors after recovery and relaunch');
    report.expectedDisconnectOrigins = [...disconnectedOrigins];
    report.expectedInjectedDisconnects = report.networkErrors.filter(item => isExpectedInjectedDisconnect(item, disconnectedOrigins));
    report.unexpectedNetworkErrors = report.networkErrors.filter(item => !isExpectedInjectedDisconnect(item, disconnectedOrigins));
    report.unexpectedConsoleErrors = report.consoleErrorDetails.filter(item => !(item.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)' &&
      report.expectedRecoveryResponses.some(response => response.phase === item.phase && response.url === item.location.url)) &&
      !report.expectedInjectedDisconnects.some(request => request.phase === item.phase && request.url === item.location.url && item.text === 'Failed to load resource: ' + request.error));
    assert.deepEqual(report.unexpectedConsoleErrors, [], 'No unexpected console errors after recovery and relaunch');
    assert.deepEqual(report.unexpectedNetworkErrors, [], 'No unexpected failed UI requests after recovery and relaunch');
    report.criteria.uiErrorChecks = 'PASS: no JS or unexpected HTTP/console/transport errors; identified Sony busy retries and injected disconnects recover';
    for (const pid of observedPids) await gone(pid, 3000);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error.message;
    throw error;
  } finally {
    try { await close(); } catch { report.cleanupFailure = 'Owned application teardown failed'; }
    if (bridge) await bridge.stop();
    if (sony) { sony.server.closeAllConnections(); await new Promise(resolve => sony.server.close(resolve)); }
    if (mounted) {
      try { execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' }); }
      catch { report.cleanupFailure = 'Owned read-only mount did not detach'; }
    }
    if (report.cleanupFailure) { report.status = 'FAIL'; process.exitCode = 1; }
    fs.writeFileSync(path.join(evidence, 'runtime.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o444 });
    console.log(JSON.stringify({ evidence, status: report.status, criteria: report.criteria }));
  }
}
module.exports = { fixtureConfig, sonyFixture, pythonChildren, findPythonChildren, isExpectedRecoveryBackpressure, isExpectedInjectedDisconnect };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
