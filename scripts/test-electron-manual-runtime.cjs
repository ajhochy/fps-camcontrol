// Real mounted-DMG consumption. No fake backend/page; optional Sony lifecycle
// checks use explicitly owned, disposable loopback helpers (never real hardware).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--dmg' && path.isAbsolute(arguments_[1])), 'usage: --dmg /absolute/installer.dmg');
const dmg = arguments_[1] || path.join(root, 'release/manual/FPS CamControl-manual-0.1.0-arm64.dmg');
const evidenceRoot = path.join(root, 'docs/ai/runs/electron-manual-evidence');
const evidence = path.join(evidenceRoot, 'runtime-' + new Date().toISOString().replace(/[:.]/g, '-'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fps manual runtime '));
const mount = path.join(temporary, 'Mounted DMG'), cwd = path.join(temporary, 'random cwd spaces'), home = path.join(temporary, 'fresh HOME');
for (const directory of [mount, cwd, home, evidence]) fs.mkdirSync(directory, { recursive: true });
const executable = path.join(mount, 'FPS CamControl.app/Contents/MacOS/FPS CamControl');
const report = { criteria: {}, screenshots: [], consoleErrors: [], networkErrors: [], appErrors: [],
  evidenceBoundary: 'Developer host fresh HOME/minimal PATH, not clean OS/TCC/hardware/Gatekeeper/notarization.' };
let desktop, externalFixture, mounted = false;
const env = { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', CAMCONTROL_NO_CONTROLLER: '1' };
async function launch() {
  desktop = await _electron.launch({ executablePath: executable, cwd, env, timeout: 30000 });
  const page = await desktop.firstWindow();
  page.on('pageerror', error => report.appErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => report.networkErrors.push({ url: request.url().replace(/\?.*$/, ''), error: request.failure()?.errorText }));
  if (page.url().startsWith('file:') && await page.getByRole('button', { name: 'Open dashboard' }).count()) {
    await until(() => page.evaluate(() => window.fpsShell.status().then(value => value === 'ready')));
    await page.getByRole('button', { name: 'Open dashboard' }).click();
  }
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 20000 });
  await page.getByText('FPS CamControl', { exact: true }).first().waitFor();
  return page;
}
const api = (page, route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
  const response = await fetch(route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}, { route, method, body });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  assert.fail('Timed out awaiting actual runtime state');
}
async function gone(pid, timeout = 16000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  assert.fail('owned process survived bounded cleanup: ' + pid);
}
async function backendPid() {
  return desktop.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'FPS CamControl Backend')?.pid);
}
async function setup() {
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Setup / Import…').click());
  const page = desktop.windows()[0];
  await page.getByRole('button', { name: 'Import devices YAML…' }).waitFor();
  return page;
}
async function importChoice(page, selected, response) {
  await desktop.evaluate(({ dialog }, choice) => {
    dialog.showOpenDialog = async () => choice.selected;
    dialog.showMessageBox = async () => ({ response: choice.response });
  }, { selected, response });
  await page.getByRole('button', { name: 'Import devices YAML…' }).click();
}
(async () => {
  assert.ok(fs.existsSync(dmg), 'c1/c10: final candidate DMG must exist');
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'pipe' }); mounted = true;
  const start = Date.now();
  let page = await launch();
  report.startupMs = Date.now() - start;
  report.url = page.url();
  const runtime = await desktop.evaluate(({ app, BrowserWindow }) => ({
    versions: { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules },
    userData: app.getPath('userData'), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    metrics: app.getAppMetrics().map(({ pid, type, name }) => ({ pid, type, name })),
  }));
  assert.ok(runtime.userData.startsWith(home + path.sep), 'c7: app must not read/write the actual account home');
  assert.equal(runtime.preferences.sandbox, true); assert.equal(runtime.preferences.contextIsolation, true); assert.equal(runtime.preferences.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  report.runtime = { versions: runtime.versions, userData: runtime.userData, sandbox: true, contextIsolation: true, nodeIntegration: false };
  assert.ok(report.startupMs < 10000, 'c5: readiness may not wait for ATEM timeout');
  const config = await api(page, '/api/config');
  assert.equal(config.status, 200); assert.deepEqual(config.body.cameras, []); assert.equal(config.body.atem.ip, '127.0.0.1');
  await page.getByText('Not configured', { exact: true }).nth(2).waitFor();
  assert.equal(await page.getByText('Not configured', { exact: true }).count(), 3, 'c8: empty hardware does not claim a nonexistent camera is live');
  assert.equal((await api(page, '/api/sony/status')).body.sidecar.state, 'disabled');
  // Actual Electron utility with a blocked JS loop cannot process shutdown or
  // SIGTERM handlers. The production terminator must force-kill and await exit.
  const hungFixture = path.join(temporary, 'hung-utility.cjs');
  fs.writeFileSync(hungFixture, "process.parentPort.postMessage({ready:true}); for (;;) {}\n");
  const hungPid = await desktop.evaluate(async ({ app, utilityProcess }, fixture) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { terminateUtility } = load('./electron/main.cjs');
    const owned = utilityProcess.fork(fixture, [], { stdio: 'ignore', env: {} });
    await new Promise(resolve => owned.once('message', resolve));
    const pid = owned.pid;
    await terminateUtility(owned, { timeoutMs: 50 });
    return pid;
  }, hungFixture);
  await gone(hungPid);
  report.hungUtility = 'PASS actual blocked-loop utility force-terminated and exit awaited';
  for (const asset of ['/ui/rigs/rigs.js', '/ui/rigs/rigsModel.js', '/ui/rigs/rigs.css', '/docs/sony-sidecar-setup']) {
    assert.equal(await page.evaluate(async route => (await fetch(route)).status, asset), 200, `c2/c10: ${asset}`);
  }
  // Read-only HID enumeration loads the real Electron addon; no HID handle is opened.
  assert.equal((await api(page, '/api/controllers')).status, 200, 'c2: actual utility backend loads native HID');
  const anonymous = await fetch(new URL('/api/config', page.url())); assert.equal(anonymous.status, 403);
  const cookies = await page.context().cookies(page.url());
  const cookie = cookies.find(cookie => cookie.name === 'fps-session'); assert.ok(cookie.httpOnly);
  const denied = await fetch(new URL('/api/config', page.url()), { headers: { Cookie: `fps-session=${cookie.value}`, Origin: 'https://example.invalid' } });
  assert.equal(denied.status, 403, 'c6: cross-origin requests rejected even with cookie');
  await page.evaluate(() => { window.open('https://example.invalid'); });
  assert.equal(desktop.windows().length, 1, 'c6: popup denied');
  await page.evaluate(() => { location.href = 'https://example.invalid'; });
  assert.equal(page.url(), report.url, 'c6: external navigation denied');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, 'c10: keyboard reaches existing controls');
  const screenshot = path.join(evidence, 'mounted-dmg-dashboard.png'); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push({ path: screenshot, sha256: hash(screenshot) });
  const patch = await api(page, '/api/atem', 'PATCH', { defaultTransition: 'cut', expectedVersion: config.body.version });
  assert.equal(patch.status, 200, 'c7: actual API mutation');
  assert.equal((await api(page, '/api/config')).body.atem.defaultTransition, 'cut', 'c7: next consumer sees saved edit');
  const saved = path.join(runtime.userData, 'config/devices.yaml'), beforeRestart = hash(saved);
  const backend = runtime.metrics.find(metric => metric.type === 'Utility' && metric.name === 'FPS CamControl Backend');
  assert.ok(backend?.pid, 'c9: owned utility backend present');
  // A real competing executable uses the same single-instance identity.
  const competitor = spawn(executable, [], { cwd, env, stdio: 'ignore' });
  await Promise.race([new Promise(resolve => competitor.once('exit', resolve)), delay(8000).then(() => { competitor.kill(); assert.fail('second instance did not exit'); })]);
  assert.equal(await backendPid(), backend.pid, 'c4: second instance did not replace backend');
  await desktop.close(); desktop = null;
  await gone(backend.pid);
  page = await launch();
  assert.equal((await api(page, '/api/config')).body.atem.defaultTransition, 'cut', 'c7: new runtime consumes persisted edit');
  assert.equal(hash(saved), beforeRestart, 'c7: second launch does not reseed over user edits');
  const restartShot = path.join(evidence, 'mounted-dmg-restart.png'); await page.screenshot({ path: restartShot, fullPage: true }); report.screenshots.push({ path: restartShot, sha256: hash(restartShot) });
  // Native chooser responses are injected; the actual UI, import validator,
  // disk writes, utility process and next consumer are production code.
  page = await setup();
  await importChoice(page, { canceled: true, filePaths: [] }, 0);
  await page.getByRole('status').filter({ hasText: 'Import canceled' }).waitFor();
  assert.equal(hash(saved), beforeRestart, 'c8: chooser cancel preserves configuration');
  const invalid = path.join(temporary, 'invalid.yaml');
  fs.writeFileSync(invalid, 'atem: {ip: 127.0.0.1, defaultTransition: auto}\ncameras: [{id: cam1}]\n');
  await importChoice(page, { canceled: false, filePaths: [invalid] }, 1);
  await page.getByRole('status').filter({ hasText: 'Invalid devices configuration' }).waitFor();
  assert.equal(hash(saved), beforeRestart, 'c8: invalid import cannot hydrate incomplete cameras');
  const imported = path.join(temporary, 'offline import.yaml');
  fs.writeFileSync(imported, 'atem: {ip: 127.0.0.1, defaultTransition: auto}\ncameras: []\nsony: {enabled: true, apiUrl: "http://127.0.0.1:8181", stateFile: "/private/forbidden", executable: "/private/forbidden"}\n');
  await importChoice(page, { canceled: false, filePaths: [imported] }, 0);
  await page.getByRole('status').filter({ hasText: 'Import canceled' }).waitFor();
  assert.equal(hash(saved), beforeRestart, 'c8: explicit replacement consent is required');
  await importChoice(page, { canceled: false, filePaths: [imported] }, 1);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const afterImport = await api(page, '/api/config');
  assert.equal(afterImport.body.atem.defaultTransition, 'auto');
  assert.equal((await api(page, '/api/sony/status')).body.sidecar.state, 'disabled');
  assert.ok(fs.readdirSync(path.dirname(saved)).filter(name => name.endsWith('.backup')).some(name => hash(path.join(path.dirname(saved), name)) === beforeRestart), 'c8: backup preserves replaced document');
  assert.ok(!fs.readFileSync(saved, 'utf8').includes('/private/forbidden'), 'c8: imported executable and approval path removed');
  const deniedIpc = await page.evaluate(async () => {
    try { await window.fpsDesktop.importConfig(); return false; } catch { return true; }
  });
  assert.equal(deniedIpc, true, 'c6: dashboard cannot invoke setup import IPC');
  assert.deepEqual(report.appErrors, [], 'c10: no page JS errors before fault injection');
  assert.deepEqual(report.consoleErrors, [], 'c10: no browser console errors before fault injection');
  assert.deepEqual(report.networkErrors, [], 'c10: no failed UI requests before fault injection');
  // Actual utility crash recovers paused; another crash cannot loop indefinitely.
  const crashedBackend = await backendPid();
  process.kill(crashedBackend, 'SIGKILL');
  await page.getByRole('alert').filter({ hasText: 'service recovered with controls paused' }).waitFor({ timeout: 20000 });
  const recoveredBackend = await backendPid();
  assert.ok(recoveredBackend && recoveredBackend !== crashedBackend);
  process.kill(recoveredBackend, 'SIGKILL');
  await page.getByRole('alert').filter({ hasText: 'unavailable' }).waitFor();
  await delay(1200);
  assert.equal(await backendPid(), undefined, 'c9: restart bound reached without replay');
  await page.getByRole('button', { name: 'Restart controls' }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const beforeSleep = await backendPid();
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByRole('alert').filter({ hasText: 'stopped for sleep' }).waitFor({ timeout: 16000 });
  await gone(beforeSleep);
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await delay(1200);
  assert.equal(await backendPid(), undefined, 'c9: wake never resumes controls automatically');
  await page.getByRole('button', { name: 'Restart controls' }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  const beforeForceQuit = await backendPid();
  const desktopProcess = desktop.process();
  desktopProcess.kill('SIGKILL'); desktop = null;
  await gone(beforeForceQuit);
  report.injectedFaultObservations = { appErrors: report.appErrors.splice(0), consoleErrors: report.consoleErrors.splice(0), networkErrors: report.networkErrors.splice(0) };
  page = await launch();
  assert.equal((await api(page, '/api/config')).body.atem.defaultTransition, 'auto', 'c7: force-quit relaunch consumes imported configuration');
  assert.deepEqual(report.appErrors, [], 'c10: no page JS errors');
  assert.deepEqual(report.consoleErrors, [], 'c10: no browser console errors');
  assert.deepEqual(report.networkErrors, [], 'c10: no failed UI requests');
  await desktop.close(); desktop = null;
  // Disposable loopback sidecars run using the shipped Electron Node runtime.
  // They contain no Sony SDK/camera data and prove owned vs adopted cleanup.
  const helperSource = path.join(temporary, 'sidecar-fixture.cjs');
  const helperReceipt = path.join(temporary, 'sidecar-fixture.json');
  fs.writeFileSync(helperSource, `
    const fs = require('node:fs'), http = require('node:http');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/server/status'
        ? { success: true, server: { version: 'fixture', sdkVersion: 'fixture' } }
        : { success: true, cameras: [] }));
    });
    process.on('SIGTERM', () => {});
    server.listen(port, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(helperReceipt)}, JSON.stringify({ pid: process.pid, port: server.address().port, electron: process.versions.electron })));
  `);
  const helperExecutable = path.join(temporary, 'owned-sidecar');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(helperExecutable, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + quote(executable) + ' ' + quote(helperSource) + ' "$@"\n', { mode: 0o700 });
  const reservation = require('node:net').createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const helperPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const writeSonyConfig = owned => fs.writeFileSync(saved, 'atem: {ip: 127.0.0.1, defaultTransition: auto}\ncameras: []\nsony:\n  enabled: true\n  apiUrl: http://127.0.0.1:' + helperPort + '\n' + (owned ? '  executable: ' + JSON.stringify(helperExecutable) + '\n' : ''));
  const awaitSony = async (page, mode) => {
    await until(async () => {
      const status = (await api(page, '/api/sony/status')).body;
      return status.sidecar.state === 'healthy' && status.sidecar.mode === mode;
    });
    const receipt = JSON.parse(fs.readFileSync(helperReceipt, 'utf8'));
    assert.equal(receipt.electron, runtime.versions.electron, 'helper runs bundled Node, never system Node');
    return receipt.pid;
  };
  writeSonyConfig(true);
  page = await launch();
  const ownedBeforeBackendCrash = await awaitSony(page, 'managed');
  process.kill(await backendPid(), 'SIGKILL');
  await page.getByRole('alert').filter({ hasText: 'service recovered with controls paused' }).waitFor({ timeout: 20000 });
  assert.equal(JSON.parse(fs.readFileSync(helperReceipt, 'utf8')).pid, ownedBeforeBackendCrash,
    'c9: paused recovery does not launch a replacement hardware helper');
  // Restart immediately, without waiting for the old helper to finish its TERM
  // grace. The guardian-held lease must prevent adoption of that dying owner.
  await page.getByRole('button', { name: 'Restart controls' }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  await until(async () => {
    const status = (await api(page, '/api/sony/status')).body.sidecar;
    assert.notEqual(status.mode, 'external', 'c9: immediate restart cannot adopt a dying owned helper');
    return status.state === 'healthy' && status.mode === 'managed';
  });
  const ownedAfterExplicitRestart = await awaitSony(page, 'managed');
  assert.notEqual(ownedAfterExplicitRestart, ownedBeforeBackendCrash);
  await gone(ownedBeforeBackendCrash);
  await desktop.close(); desktop = null;
  await gone(ownedAfterExplicitRestart);
  page = await launch();
  const ownedBeforeParentCrash = await awaitSony(page, 'managed');
  const utilityBeforeParentCrash = await backendPid();
  desktop.process().kill('SIGKILL'); desktop = null;
  await gone(utilityBeforeParentCrash);
  await gone(ownedBeforeParentCrash);
  // Adopt a separately launched fixture and prove ordinary quit never kills it.
  externalFixture = spawn(executable, [helperSource, '--port', String(helperPort)], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  writeSonyConfig(false);
  page = await launch();
  const externalPid = await awaitSony(page, 'external');
  assert.equal(externalPid, externalFixture.pid);
  await desktop.close(); desktop = null;
  assert.doesNotThrow(() => process.kill(externalPid, 0), 'adopted user-owned sidecar survives app quit');
  externalFixture.kill('SIGKILL');
  await gone(externalPid); externalFixture = null;
  report.sonyOwnership = 'PASS actual bundled-node guardian cleans managed fixture after backend and desktop SIGKILL; adopted external fixture survives normal quit';
  report.criteria = { c2: 'PASS runtime resources/native HID/no external tools', c4: 'PASS real second instance exits without replacing backend', c5: 'PASS offline ephemeral ready', c6: 'PASS sandbox/auth/popup/navigation/setup IPC guard', c7: 'PASS fresh HOME/API save/read/restart', c8: 'PASS cancel/invalid/consent/backup/import next consumer (native chooser response injected)', c9: 'PASS normal quit/actual child crash/bounded paused recovery/desktop SIGKILL; simulated power events stop without wake replay, physical motion pending', c10: 'PASS mounted DMG/dashboard/assets/keyboard/console/network/restart' };
  report.dmg = { path: dmg, bytes: fs.statSync(dmg).size, sha256: hash(dmg) };
  console.log('PASS actual mounted DMG dashboard, runtime isolation, API, native HID, persistence and quit checks');
})().catch(async error => {
  report.failure = error.message;
  if (desktop) {
    const page = desktop.windows()[0];
    if (page && !page.isClosed()) {
      const screenshot = path.join(evidence, 'mounted-dmg-startup-failure.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      report.screenshots.push({ path: screenshot, sha256: hash(screenshot), state: 'FAILED startup, not dashboard evidence' });
    }
  }
  console.error(`FAIL actual packaged runtime: ${error.message}`); process.exitCode = 1;
}).finally(async () => {
  if (desktop) await desktop.close().catch(() => {});
  if (externalFixture) externalFixture.kill('SIGKILL');
  fs.writeFileSync(path.join(evidence, 'runtime.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(evidenceRoot, 'latest-runtime.json'), JSON.stringify({ evidence: path.join(evidence, 'runtime.json') }, null, 2));
  if (mounted) { try { execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' }); } catch { console.error('Owned DMG detach pending'); process.exitCode = 1; } }
});
