const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const diagnostic=process.argv.includes('--diagnostic');
const requestedDuration=Number(process.argv.find(a=>a.startsWith('--duration-ms='))?.split('=')[1] || (diagnostic?55000:1800000));
assert.ok(Number.isFinite(requestedDuration) && requestedDuration>=1000 && requestedDuration<=(diagnostic?55000:3600000),'valid bounded duration');
const dmg = path.join(root, 'dist/electron-probe/FPS CamControl Probe-0.1.0-arm64.dmg');
const mount = fs.mkdtempSync(path.join(os.tmpdir(),'fps-probe-dmg-'));
const app = path.join(mount, 'FPS CamControl Probe.app');
const executable = path.join(app, 'Contents/MacOS/FPS CamControl Probe');
const runId = Date.now();
const duration = requestedDuration;
const artifactSha256=diagnostic?require('node:crypto').createHash('sha256').update(fs.readFileSync(dmg)).digest('hex'):null;
let crashEvidence;
let diagnosticDeadline;
const outputDir = path.join(root, 'dist/electron-probe');
const alive = pid => { try { process.kill(pid,0); return true; } catch { return false; } };
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function run(mode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-electron-probe-'));
  const home = path.join(temp,'empty home'); fs.mkdirSync(home);
  const cwd = path.join(temp,'random cwd'); fs.mkdirSync(cwd);
  const prefix=diagnostic?(mode==='idle'?'diagnostic-evidence-':'diagnostic-crash-evidence-'):`${mode}-evidence-`;
  const output = path.join(outputDir, `${prefix}${runId}.json`);
  if(diagnostic && !diagnosticDeadline) diagnosticDeadline=performance.now()+60000;
  const child = spawn(executable,[`--probe-output=${output}`,`--duration-ms=${mode==='idle'?duration:60000}`,...(diagnostic?['--diagnostic']:[])], {
    cwd, env: { HOME:home, PATH:'/usr/bin:/bin', TMPDIR:temp, CAMCONTROL_NO_CONTROLLER:'1' }, stdio:'ignore' });
  let ended = false;
  const exit = new Promise(resolve => {
    child.on('exit',(code,signal)=>{ended=true;resolve({code,signal});});
    child.on('error',()=>{ended=true;resolve({code:null,signal:null});});
  });
  const hardStop=diagnostic?setTimeout(()=>{if(!ended)child.kill('SIGKILL');},Math.max(0,diagnosticDeadline-performance.now())):null;
  try {
  const deadline = Date.now()+30000;
  while (!fs.existsSync(output+'.started') && !ended && Date.now()<deadline) await wait(100);
  if (!fs.existsSync(output+'.started')) { if (!ended) child.kill('SIGKILL'); await exit; }
  assert.ok(fs.existsSync(output+'.started'), `${mode}: packaged utility started`);
  const owned = JSON.parse(fs.readFileSync(output+'.started'));
  assert.equal(owned.parentPid,child.pid);
  if (mode === 'crash') {
    if(diagnostic) {
      const checkpointDeadline=Date.now()+5000;
      while(!fs.existsSync(output+'.partial.json')&&!ended&&Date.now()<checkpointDeadline) await wait(50);
      assert.equal(JSON.parse(fs.readFileSync(output+'.partial.json')).telemetry.status,'partial');
    }
    process.kill(child.pid,'SIGKILL');
  }
  const timeout = setTimeout(()=>child.kill('SIGKILL'), (mode==='idle'?duration:60000)+30000);
  const result = await exit; clearTimeout(timeout);
  const cleanupDeadline = Date.now()+10000;
  while (alive(owned.childPid) && Date.now()<cleanupDeadline) await wait(100);
  assert.equal(alive(owned.childPid),false, `${mode}: no owned utility orphan`);
  assert.equal(alive(owned.parentPid),false, `${mode}: parent exited`);
  const lifecycle = {mode, ...result, ...owned, ownedUtilityExited:true, emptyHome:true,
    minimalPath:'/usr/bin:/bin', randomCwd:true, tempHome:home, app, dmg, fromDmg:true};
  const safeLifecycle={mode,...result,...owned,ownedUtilityExited:true,emptyHome:true,minimalPath:'/usr/bin:/bin',randomCwd:true,fromDmg:true};
  if(diagnostic) {
    if(mode==='crash') crashEvidence={...safeLifecycle,partialTelemetry:true};
  } else fs.writeFileSync(path.join(outputDir,`${mode}-lifecycle.json`),JSON.stringify(lifecycle,null,2));
  if (mode === 'idle') {
    assert.equal(result.code,0,'packaged probe exits successfully');
    const evidence = JSON.parse(fs.readFileSync(output));
    if(diagnostic) {
      delete evidence.utility.nativePaths;
      evidence.diagnosticOnly=true; evidence.artifactSha256=artifactSha256;
      evidence.hermetic=safeLifecycle; evidence.crash=crashEvidence;
      const json=JSON.stringify(evidence,null,2);
      assert.ok(Buffer.byteLength(json)<=262144);
      fs.writeFileSync(output+'.tmp',json,{mode:0o600}); fs.renameSync(output+'.tmp',output);
      execFileSync(process.execPath,[path.join(root,'scripts/test-electron-probe-telemetry.cjs'),output],{stdio:'inherit'});
      console.log(`diagnostic evidence: ${path.basename(output)} (not foundation timing acceptance)`);
      return;
    }
    evidence.hermetic=lifecycle;
    evidence.crash=JSON.parse(fs.readFileSync(path.join(outputDir,'crash-lifecycle.json')));
    fs.writeFileSync(output,JSON.stringify(evidence,null,2));
    fs.writeFileSync(path.join(outputDir,'last-run.json'),JSON.stringify({evidence:output},null,2));
    execFileSync(process.execPath,[path.join(root,'scripts/test-electron-foundation.cjs'),output],{stdio:'inherit'});
  }
  console.log(`${mode}: owned parent and utility exited; hermetic developer-host check only`);
  } finally {
    clearTimeout(hardStop);
    if(!ended) { child.kill('SIGKILL'); await exit; }
    if(fs.existsSync(output+'.started')) {
      const owned=JSON.parse(fs.readFileSync(output+'.started'));
      const deadline=Date.now()+10000;
      while(alive(owned.childPid)&&Date.now()<deadline) await wait(100);
      assert.equal(alive(owned.childPid),false,'owned utility cleanup even on diagnostic failure');
    }
  }
}
(async()=> {
  execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg],{stdio:'inherit'});
  try { await run('crash'); await run('idle'); }
  finally { execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'inherit'}); }
})().catch(error=>{ console.error(error.message); process.exitCode=1; });
