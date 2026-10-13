import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(__dirname, '../..');
const mainPath = path.join(repoRoot, 'electron/main.cjs');
const preloadPath = path.join(repoRoot, 'electron/preload.cjs');

function readMain(): string {
  assert.ok(fs.existsSync(mainPath), 'issue-42: electron/main.cjs must own the desktop shell');
  return fs.readFileSync(mainPath, 'utf8');
}

function readPreload(): string {
  assert.ok(fs.existsSync(preloadPath), 'issue-42: electron/preload.cjs must own the renderer bridge');
  return fs.readFileSync(preloadPath, 'utf8');
}

test('issue-42-c1: a second launch is forwarded to the existing application instance', () => {
  const source = readMain();
  assert.match(source, /requestSingleInstanceLock\s*\(/, 'the primary process must acquire Electron single-instance ownership');
  assert.match(source, /second-instance/, 'the primary process must handle a second launch');
  assert.match(source, /\.show\s*\(|\.focus\s*\(/, 'a second launch must bring the existing window forward');
});

test('issue-42-c2: the browser view is sandboxed and exposes only the preload bridge', () => {
  const source = readMain();
  const preload = readPreload();
  assert.match(source, /preload\s*:/, 'the window must load the dedicated preload');
  assert.match(source, /sandbox\s*:\s*true/, 'the renderer must use Electron sandboxing');
  assert.match(source, /contextIsolation\s*:\s*true/, 'the renderer must have context isolation');
  assert.match(source, /nodeIntegration\s*:\s*false/, 'the renderer must not have Node integration');
  assert.match(source, /setWindowOpenHandler[\s\S]*?deny/, 'renderer-created popups must be denied');
  assert.match(source, /will-navigate[\s\S]*?preventDefault/, 'navigation outside the shell-owned view must be blocked');
  assert.match(preload, /contextBridge\.exposeInMainWorld/, 'preload must expose a narrow context bridge');
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|on|once)\s*\(/, 'preload must not expose a generic message channel');
});

test('issue-42-c3: the supervised utility process publishes its actual ready URL using issue 41 protocol v1', () => {
  const source = readMain();
  assert.match(source, /utilityProcess\.fork\s*\(/, 'the backend must run as an owned Electron utility process');
  assert.match(source, /CAMCONTROL_EMBEDDED\s*:\s*['"]1['"]/, 'the child must use the issue 41 embedded lifecycle');
  assert.match(source, /type\s*===?\s*['"]ready['"]/, 'the parent must accept the issue 41 ready envelope');
  assert.match(source, /protocol\s*===?\s*1/, 'the parent must validate issue 41 protocol version 1');
  assert.match(source, /Number\.isInteger\s*\(\s*\w+\.port\s*\)/, 'ready must carry an actual integer bound port');
  assert.match(source, /pid\s*===?\s*\w+\.pid/, 'ready must be tied to the child process that sent it');
  assert.match(source, /127\.0\.0\.1[\s\S]{0,100}\.port|\.port[\s\S]{0,100}127\.0\.0\.1/, 'the origin must use the actual ready port on loopback');
  assert.match(source, /loadURL\s*\(/, 'the renderer must load the backend only after readiness');
  assert.match(source, /type\s*:\s*['"]shutdown['"][\s\S]*?protocol\s*:\s*1/, 'shutdown must use the issue 41 protocol v1 envelope');
});

test('issue-42-c4: child crashes restart only within a bound and report safe status to the operator', () => {
  const source = readMain();
  assert.match(source, /restart/i, 'unexpected child exit must have a restart path');
  assert.match(source, /max(?:imum)?Restarts|maxRestarts|restartLimit|restartBudget|restartCount/i, 'restart attempts must have an explicit finite bound');
  assert.match(source, /failure|status|alert/i, 'restart exhaustion or failure must be visible in the UI');
  assert.match(source, /secret|credential|token/i, 'the status path must identify and protect secret material');
  assert.match(source, /Motion (?:is not replayed|will not resume)|not replay/i, 'restart status must state that motion is not replayed');
});

test('issue-42-c5: quitting shuts down and reaps the shell-owned utility process', () => {
  const source = readMain();
  assert.match(source, /before-quit/, 'quit must be intercepted until child cleanup completes');
  assert.match(source, /type\s*:\s*['"]shutdown['"][\s\S]*?protocol\s*:\s*1/, 'quit cleanup must request graceful issue 41 shutdown');
  assert.match(source, /\.kill\s*\(/, 'quit cleanup must bound shutdown and kill only its owned child if needed');
  assert.match(source, /\.once\s*\(\s*['"]exit['"]|\.on\s*\(\s*['"]exit['"]/, 'quit must wait for the owned child exit');
  assert.match(source, /then\(stopBackend\)\.then[\s\S]{0,160}app\.quit\s*\(/, 'the app may quit only after owned cleanup succeeds');
});

test('issue-42-c6: the power save blocker is released when the shell stops', () => {
  const source = readMain();
  assert.match(source, /powerSaveBlocker\.start\s*\(/, 'the shell must start the requested power save blocker');
  assert.match(source, /powerSaveBlocker\.stop\s*\(/, 'the blocker must be stopped during lifecycle cleanup');
  assert.match(source, /isStarted\s*\(/, 'cleanup must release only a blocker that is still active');
});
