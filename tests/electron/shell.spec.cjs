const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createShell, childEnvironment, isReadyEnvelope, statusText, terminateUtility } = require('../../electron/main.cjs');

test('shell accepts only the exact #41 ready envelope tied to its child', () => {
  const child = { pid: 4321 };
  assert.equal(isReadyEnvelope({ type: 'ready', protocol: 1, port: 8080, pid: 4321 }, child), true);
  assert.equal(isReadyEnvelope({ type: 'ready', protocol: 1, port: 8080, pid: 5 }, child), false);
  assert.equal(isReadyEnvelope({ type: 'ready', protocol: 2, port: 8080, pid: 4321 }, child), false);
});

test('shell environment is allowlisted and no-controller is opt-in', () => {
  const saved = process.env.CAMCONTROL_NO_CONTROLLER;
  delete process.env.CAMCONTROL_NO_CONTROLLER;
  assert.deepEqual(childEnvironment('/tmp/home', '/tmp/resources'), {
    CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: '/tmp/home', CAMCONTROL_RESOURCES: '/tmp/resources',
  });
  process.env.CAMCONTROL_NO_CONTROLLER = '1';
  assert.equal(childEnvironment('/tmp/home', '/tmp/resources').CAMCONTROL_NO_CONTROLLER, '1');
  if (saved === undefined) delete process.env.CAMCONTROL_NO_CONTROLLER;
  else process.env.CAMCONTROL_NO_CONTROLLER = saved;
});

test('restart status is fixed and never incorporates child output', () => {
  assert.match(statusText('restarting'), /motion is not replayed/i);
  assert.equal(statusText('secret=do-not-display'), statusText('failed'));
});

test('denied shared ownership cannot be bypassed by backend start or setup import IPC', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-shell-denied-'));
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, getPath: () => home, quit() {} });
  const webContents = new EventEmitter();
  webContents.mainFrame = { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../../electron/manual/setup.html')).href };
  webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  webContents.setWindowOpenHandler = () => {};
  const window = { webContents, show() {}, focus() {}, isDestroyed: () => false, loadFile: async () => {}, loadURL: async () => {} };
  const handlers = new Map();
  let forks = 0, choosers = 0;
  const shell = createShell({
    app, BrowserWindow: function () { return window; },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    powerSaveBlocker: { start: () => 1, isStarted: () => true, stop() {} },
    utilityProcess: { fork: () => { forks++; throw new Error('must never fork without ownership'); } },
    dialog: { showOpenDialog: async () => { choosers++; throw new Error('must not open import'); } },
  }, { defaults: path.resolve(__dirname, '../../resources/defaults'), acquireOwnership: async () => { throw new Error('occupied'); } });
  shell.start();
  await new Promise(resolve => setImmediate(resolve));
  shell.startBackend();
  const message = await handlers.get('fps:import')({ sender: webContents, senderFrame: webContents.mainFrame });
  assert.match(message, /Close the other CamControl/);
  assert.equal(forks, 0);
  assert.equal(choosers, 0);
});

test('timed-out utility escalates only its owned child and does not resolve before actual exit', async () => {
  const child = new EventEmitter();
  child.pid = 55555;
  child.postMessage = () => {};
  let terms = 0, forced = 0, complete = false;
  child.kill = () => { terms++; };
  const scheduled = [];
  const timers = {
    setTimeout(fn, delay) { const timer = { fn, delay }; scheduled.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
  const stopped = terminateUtility(child, { timers, timeoutMs: 5, forceKill: (pid, signal) => {
    assert.equal(pid, child.pid); assert.equal(signal, 'SIGKILL'); forced++;
  } }).then(() => { complete = true; });
  scheduled.find(timer => timer.delay === 5).fn();
  scheduled.find(timer => timer.delay === 500).fn();
  await Promise.resolve();
  assert.equal(terms, 1); assert.equal(forced, 1); assert.equal(complete, false);
  child.emit('exit', 1);
  await stopped;
  assert.equal(complete, true);
});

test('fake Electron runtime bounds crash restart and reaps only its owned child on quit', async () => {
  class Child extends EventEmitter {
    constructor(pid) { super(); this.pid = pid; this.messages = []; this.kills = 0; }
    postMessage(message) { this.messages.push(message); }
    kill() { this.kills += 1; }
  }
  const scheduled = [];
  const timers = {
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; scheduled.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    setInterval(fn, delay) { const timer = { fn, delay, cleared: false }; return timer; },
    clearInterval(timer) { timer.cleared = true; },
    run(delay) { for (const timer of scheduled.filter(t => t.delay === delay && !t.cleared)) { timer.cleared = true; timer.fn(); } },
  };
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-shell-test-'));
  app.getPath = () => home;
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; };
  const webContents = new EventEmitter();
  webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const window = { webContents, show() {}, focus() {}, isDestroyed: () => false, loadFile: async () => {}, loadURL: async () => {} };
  const children = [];
  const electron = {
    app,
    BrowserWindow: function BrowserWindow() { return window; },
    ipcMain: { handle() {} },
    powerSaveBlocker: { start: () => 7, isStarted: () => true, stop: id => { assert.equal(id, 7); } },
    utilityProcess: { fork: () => { const child = new Child(100 + children.length); children.push(child); return child; } },
  };
  webContents.setWindowOpenHandler = () => {};
  const shell = createShell(electron, { timers, resources: '/tmp/resources', defaults: path.resolve(__dirname, '../../resources/defaults'), backend: '/tmp/backend.cjs', acquireOwnership: async () => ({ release: async () => {} }) });
  shell.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 1);
  children[0].emit('exit', 1);
  timers.run(500);
  assert.equal(children.length, 2, 'one crash creates one bounded restart');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  app.emit('before-quit', event);
  assert.equal(event.prevented, true);
  // Quit first navigates away from the polling dashboard. Wait for that
  // promise chain before inspecting the shutdown envelope.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(children[1].messages, [{ type: 'shutdown', protocol: 1 }]);
  children[1].emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children[1].kills, 0, 'a graceful owned exit is never force-killed');
  assert.equal(app.quitCalls, 1);
});
