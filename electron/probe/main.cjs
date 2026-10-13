// ponytail: non-shipping feasibility shell; no backend imports or hardware opens.
const { app, BrowserWindow, utilityProcess, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const outputArg = process.argv.find(a => a.startsWith('--probe-output='));
const durationArg = process.argv.find(a => a.startsWith('--duration-ms='));
if (!outputArg || !durationArg) app.exit(2);
const output = outputArg?.slice('--probe-output='.length);
const duration = Number(durationArg?.slice('--duration-ms='.length));
if (!Number.isFinite(duration) || duration < 1000 || duration > 3600000) app.exit(2);
app.setPath('userData', path.join(app.getPath('appData'), 'com.ajhochhalter.fpscamcontrol.probe'));
app.commandLine.appendSwitch('disable-breakpad');
let child;
let evidence;
// Atomic promotion leaves either the previous checkpoint or a complete JSON after a crash.
function writeEvidence(file, value) {
  const json=JSON.stringify(value,null,2);
  if(Buffer.byteLength(json)>262144) throw new Error('PROBE_OUTPUT_CAP');
  fs.writeFileSync(file+'.tmp',json,{mode:0o600});
  fs.renameSync(file+'.tmp',file);
}
app.whenReady().then(async () => {
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  const win = new BrowserWindow({ width: 600, height: 300, show: true,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  await win.loadFile(path.join(__dirname, 'probe.html'));
  const renderer = await win.webContents.executeJavaScript('({requireType:typeof require,processType:typeof process})');
  evidence = { packaged: app.isPackaged, arch: process.arch, abi: process.versions.modules,
    electron: process.versions.electron, node: process.versions.node,
    renderer: { ...renderer, sandboxed: win.webContents.getLastWebPreferences().sandbox,
      nodeIntegration: win.webContents.getLastWebPreferences().nodeIntegration,
      contextIsolation: win.webContents.getLastWebPreferences().contextIsolation } };
  child = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [String(duration)], {
    serviceName: 'FPS native HID feasibility', stdio: 'pipe',
    env: { ...process.env, CAMCONTROL_NO_CONTROLLER: '1' } });
  child.on('spawn', () => {
    evidence.childPid = child.pid;
    fs.writeFileSync(output + '.started', JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
  });
  child.on('message', message => {
    if (message.type === 'telemetry') writeEvidence(output+'.partial.json',{protocol:1,status:'partial',telemetry:message.telemetry});
    if (message.type === 'result') {
      evidence.utility = message.result;
      if(process.argv.includes('--diagnostic')) delete evidence.utility.nativePaths;
      child.postMessage({type:'shutdown'});
    }
    if (message.type === 'error') { writeEvidence(output, { ...evidence, failure: message.code }); app.exit(1); }
  });
  child.on('exit', code => {
    evidence.quitChildExited = code === 0;
    writeEvidence(output, evidence);
    powerSaveBlocker.stop(blocker);
    app.exit(code === 0 && evidence.utility ? 0 : 1);
  });
}).catch(() => app.exit(1));
app.on('before-quit', () => child?.kill());
