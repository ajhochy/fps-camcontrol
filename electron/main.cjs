const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 12_000;
const MAX_RESTARTS = 2;

function terminateUtility(owned, { timers = global, timeoutMs = SHUTDOWN_TIMEOUT_MS, forceKill = process.kill } = {}) {
  return new Promise((resolve, reject) => {
    let exited = false, forceTimer, failureTimer;
    const finish = () => {
      if (exited) return;
      exited = true;
      timers.clearTimeout(graceTimer);
      if (forceTimer) timers.clearTimeout(forceTimer);
      if (failureTimer) timers.clearTimeout(failureTimer);
      resolve();
    };
    const graceTimer = timers.setTimeout(() => {
      if (exited) return;
      // Electron kill() sends SIGTERM; an unresponsive event loop needs a
      // separate escalation. Only this still-owned, unreaped child is eligible.
      owned.kill();
      forceTimer = timers.setTimeout(() => {
        if (exited) return;
        const pid = owned.pid;
        if (Number.isInteger(pid) && pid > 0) {
          try { forceKill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(new Error('Owned backend could not be stopped')); }
        }
        failureTimer = timers.setTimeout(() => {
          if (!exited) reject(new Error('Owned backend exit was not confirmed'));
        }, 2000);
      }, 500);
    }, timeoutMs);
    owned.once('exit', finish);
    try { owned.postMessage({ type: 'shutdown', protocol: 1 }); } catch { /* escalation remains bounded */ }
  });
}

function isReadyEnvelope(message, child) {
  return !!message && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).sort().join(',') === 'pid,port,protocol,type' &&
    message.type === 'ready' && message.protocol === 1 && message.pid === child.pid &&
    Number.isInteger(message.port) && message.port > 0 && message.port < 65_536;
}
function childEnvironment(home, resources) {
  // Never inherit launcher credentials, NODE_OPTIONS or arbitrary config paths.
  const env = { CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: home, CAMCONTROL_RESOURCES: resources };
  if (process.env.CAMCONTROL_NO_CONTROLLER === '1') env.CAMCONTROL_NO_CONTROLLER = '1';
  return env;
}
function statusText(kind) {
  return ({
    starting: 'Starting the local control service…',
    stopping: 'Stopping controls and closing the local service…',
    restarting: 'The local control service stopped. Restarting with controls paused; motion is not replayed.',
    paused: 'The service recovered with controls paused. Motion is not replayed. Choose Restart controls to reconnect.',
    sleep: 'Controls stopped for sleep. Choose Restart controls after waking. Motion will not resume automatically.',
    failed: 'The local control service is unavailable. Motion is not replayed. Quit or retry.',
    occupied: 'Camera control is already in use. Close the other CamControl app and relaunch.',
  })[kind] || 'The local control service is unavailable. Motion is not replayed. Quit or retry.';
}
function seed(home, defaults) {
  const config = path.join(home, 'config');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  for (const name of ['devices.yaml', 'speeds.json', 'mappings.yaml', 'presets.json']) {
    const temporary = path.join(config, '.' + name + '.' + crypto.randomUUID() + '.tmp');
    fs.writeFileSync(temporary, fs.readFileSync(path.join(defaults, name)), { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, path.join(config, name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { fs.unlinkSync(temporary); }
  }
}
function createShell(electron, options = {}) {
  const { app, BrowserWindow, ipcMain, powerSaveBlocker, utilityProcess, Menu, dialog, powerMonitor } = electron;
  const timers = options.timers || global;
  const resources = options.resources || (app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..'));
  const defaults = options.defaults || (app.isPackaged ? path.join(process.resourcesPath, 'defaults') : path.join(resources, 'resources/defaults'));
  const backend = options.backend || path.join(__dirname, 'manual/backend.cjs');
  const setupFile = path.join(__dirname, 'manual/setup.html');
  const statusFile = path.join(__dirname, 'status.html');
  const token = crypto.randomBytes(32).toString('hex');
  let window, child, blocker, readyTimer, restartTimer, heartbeat, origin, stopPromise, ownership;
  let quitting = false, suspended = false, restartCount = 0, importInProgress = false, hasConfig = false;

  function clearTimers() {
    if (readyTimer) timers.clearTimeout(readyTimer);
    if (restartTimer) timers.clearTimeout(restartTimer);
    if (heartbeat) timers.clearInterval(heartbeat);
    readyTimer = restartTimer = heartbeat = undefined;
  }
  async function showStatus(kind) {
    if (!window || window.isDestroyed?.()) return;
    await window.loadFile(statusFile, { query: { message: statusText(kind) } });
  }
  async function dashboard() {
    if (!origin) return 'Starting the backend…';
    if (suspended) { await showStatus('paused'); return 'Controls paused.'; }
    await window.loadURL(origin);
    return 'Dashboard ready.';
  }
  function focusWindow() { if (window && !window.isDestroyed?.()) { window.show(); window.focus(); } }
  function startBackend(paused = false) {
    if (quitting || child || !ownership) return;
    origin = undefined;
    const env = { ...childEnvironment(app.getPath('userData'), resources), CAMCONTROL_SESSION: token };
    if (options.tracking === true) env.CAMCONTROL_TRACKING_AVAILABLE = '1';
    if (paused) env.CAMCONTROL_INPUT_SUSPENDED = '1';
    const owned = utilityProcess.fork(backend, [], { serviceName: 'FPS CamControl Backend', stdio: 'ignore', env });
    child = owned;
    heartbeat = timers.setInterval(() => {
      if (child === owned) { try { owned.postMessage({ type: 'heartbeat', protocol: 1 }); } catch {} }
    }, 500);
    readyTimer = timers.setTimeout(() => {
      if (child !== owned || quitting) return;
      void stopBackend().then(() => showStatus('failed'));
    }, READY_TIMEOUT_MS);
    owned.on('message', async message => {
      if (child !== owned || origin || !isReadyEnvelope(message, owned)) return;
      timers.clearTimeout(readyTimer); readyTimer = undefined;
      origin = 'http://127.0.0.1:' + message.port;
      try {
        await window.webContents.session.cookies.set({ url: origin, name: 'fps-session', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
        if (child !== owned || quitting) return;
        if (paused) await showStatus('paused');
        else if (hasConfig) await dashboard();
      } catch { await stopBackend(); await showStatus('failed'); }
    });
    owned.once('exit', () => {
      if (child !== owned) return;
      child = undefined; origin = undefined; clearTimers();
      if (quitting) return;
      if (suspended) { void showStatus('failed'); return; }
      suspended = true; // A recovered process must never reopen input until explicit operator action.
      if (restartCount >= MAX_RESTARTS) { void showStatus('failed'); return; }
      restartCount += 1;
      void showStatus('restarting');
      restartTimer = timers.setTimeout(() => {
        restartTimer = undefined;
        if (!quitting && !child) startBackend(true);
      }, 500);
    });
  }
  async function stopBackend() {
    if (stopPromise) return stopPromise;
    clearTimers();
    const owned = child; child = undefined; origin = undefined;
    if (!owned) return;
    stopPromise = terminateUtility(owned, { timers });
    try { await stopPromise; }
    catch (error) { child = owned; throw error; }
    finally { stopPromise = undefined; }
  }
  function releasePowerBlocker() {
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    blocker = undefined;
  }
  function validSender(event, allowed) {
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      allowed.some(file => event.senderFrame.url.split('?')[0] === pathToFileURL(file).href);
  }
  async function restart() {
    if (!ownership) return 'Close the other CamControl app and relaunch.';
    await stopBackend();
    suspended = false; restartCount = 0; hasConfig = true;
    if (blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
    await showStatus('starting'); startBackend();
    return 'Starting the local service…';
  }
  async function importConfig() {
    if (!ownership) return 'Close the other CamControl app and relaunch before importing.';
    if (importInProgress) return 'An import is already in progress.';
    importInProgress = true;
    try {
      const selected = await dialog.showOpenDialog(window, { title: 'Import devices configuration', properties: ['openFile'], filters: [{ name: 'Devices YAML', extensions: ['yaml', 'yml'] }] });
      if (selected.canceled || selected.filePaths.length !== 1) return 'Import canceled. Configuration unchanged.';
      const file = selected.filePaths[0];
      let parsed, yaml, loader;
      try {
        if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) return 'Configuration is too large or not a file. Nothing changed.';
        yaml = require(path.join(resources, 'node_modules/yaml'));
        loader = require(path.join(resources, 'dist/config/configLoader.js'));
        parsed = loader.validateImportedDevicesConfig(yaml.parse(fs.readFileSync(file, 'utf8')));
      } catch { return 'Invalid devices configuration. Nothing changed.'; }
      const count = parsed.profiles ? Object.keys(parsed.profiles).length + ' profiles' : parsed.cameras.length + ' cameras';
      const choice = await dialog.showMessageBox(window, { type: 'warning', title: 'Replace devices configuration?',
        message: 'Import ' + count + '? A backup will be saved first. Sony remains disabled until explicitly configured. Unsaved rig wiring will also be backed up.',
        buttons: ['Cancel', 'Back up and replace'], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return 'Import canceled. Configuration unchanged.';
      await stopBackend();
      const config = path.join(app.getPath('userData'), 'config');
      const target = path.join(config, 'devices.yaml');
      const backup = '.' + crypto.randomUUID() + '.backup';
      try {
        fs.copyFileSync(target, target + backup, fs.constants.COPYFILE_EXCL);
        const working = path.join(config, 'working-profile.json');
        // The new document must never inherit unsaved rig wiring from the old document.
        if (fs.existsSync(working)) fs.renameSync(working, working + backup);
        loader.writeFileAtomic(target, yaml.stringify(parsed));
      } catch { await showStatus('failed'); return 'Import could not be saved. Backups are retained; restart to recover.'; }
      suspended = false; hasConfig = true; restartCount = 0; startBackend();
      return 'Imported configuration with backup. Starting dashboard…';
    } finally { importInProgress = false; }
  }
  async function boot() {
    const home = app.getPath('userData');
    hasConfig = fs.existsSync(path.join(home, 'config/devices.yaml'));
    seed(home, defaults);
    blocker = powerSaveBlocker.start('prevent-app-suspension');
    window = new BrowserWindow({ width: 1280, height: 900, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('render-process-gone', () => { suspended = true; void stopBackend(); });
    ipcMain.handle('fps:dashboard', (event, ...args) => {
      if (args.length || !validSender(event, [setupFile])) throw new Error('Invalid desktop request');
      hasConfig = true; return dashboard();
    });
    ipcMain.handle('fps:import', (event, ...args) => {
      if (args.length || !validSender(event, [setupFile])) throw new Error('Invalid desktop request');
      return importConfig();
    });
    ipcMain.handle('fps-shell:status', (event, ...args) => {
      if (args.length || !validSender(event, [statusFile, setupFile])) throw new Error('Invalid desktop request');
      return origin ? 'ready' : 'starting';
    });
    ipcMain.handle('fps-shell:restart', (event, ...args) => {
      if (args.length || !validSender(event, [statusFile])) throw new Error('Invalid desktop request');
      return restart();
    });
    if (Menu) Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'FPS CamControl', submenu: [{ role: 'about' }, { label: 'Setup / Import…', click: () => window.loadFile(setupFile) },
        { label: 'Restart controls…', click: restart }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    powerMonitor?.on('suspend', () => {
      suspended = true;
      void showStatus('stopping').then(stopBackend).then(() => { releasePowerBlocker(); return showStatus('sleep'); });
    });
    if (hasConfig) await showStatus('starting'); else await window.loadFile(setupFile);
    window.show();
    try { ownership = await (options.acquireOwnership || require('./production-lock.cjs').acquire)(app.getPath('appData')); }
    catch { releasePowerBlocker(); await showStatus('occupied'); return; }
    startBackend();
  }
  function start() {
    // macOS NSHomeDirectory ignores a launcher's HOME override. Resolve both
    // paths explicitly before singleton/Chromium startup, including test homes.
    if (process.platform === 'darwin' && app.setPath) {
      const appData = path.join(os.homedir(), 'Library/Application Support');
      fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
      app.setPath('appData', appData);
      app.setPath('userData', path.join(appData, options.userDataName || 'FPS CamControl'));
    }
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    app.on('second-instance', focusWindow);
    app.on('before-quit', event => {
      if (quitting) return;
      event.preventDefault(); quitting = true;
      void showStatus('stopping').then(stopBackend).then(async () => { releasePowerBlocker(); await ownership?.release(); app.quit(); })
        .catch(() => { quitting = false; void showStatus('failed'); });
    });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(boot).catch(async () => { await stopBackend(); await showStatus('failed'); releasePowerBlocker(); });
  }
  return { start, stopBackend, startBackend, getState: () => ({ child, origin, restartCount, quitting, suspended }) };
}
module.exports = { createShell, isReadyEnvelope, childEnvironment, statusText, seed, terminateUtility };
if (require.main === module) createShell(require('electron')).start();
