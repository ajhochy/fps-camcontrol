// Regression: aggregates alone lose exact boundary outliers and clock correlation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.match(fs.readFileSync(require.resolve('../electron/probe/utility.cjs'),'utf8'), /module\.exports.*createTelemetry/, 'collector is absent; do not start the HID utility when testing');
const { createTelemetry } = require('../electron/probe/utility.cjs');
assert.equal(typeof createTelemetry, 'function', 'telemetry collector must be available without HID/runtime startup');
const c = createTelemetry({ wallMs:10000, monotonicMs:100, versions:{node:'test', electron:'test', modules:'149', token:'PRIVATE'}, osRelease:'test' });
const runtime = {cpuUserUs:10, cpuSystemUs:2, elu:{idle:100,active:50,utilization:1/3}, rssBytes:1024, path:'PRIVATE', env:'PRIVATE'};
c.tick(249.5, 10149.5, runtime);
c.tick(399.5, 10299.5, runtime);
c.tick(649.5, 10549.5, runtime);
c.gc({startTime:400,duration:5,kind:1,flags:0,token:'PRIVATE'});
let e = c.snapshot('complete');
assert.equal(e.protocol,1);
assert.equal(e.outliers.length,2);
assert.equal(e.outliers[0].gapMs,150);
assert.equal(e.outliers[0].missed250,false);
assert.equal(e.outliers[1].gapMs,250);
assert.equal(e.outliers[1].missed250,true);
assert.equal(e.outliers[0].previousMonotonicMs,249.5);
assert.equal(e.outliers[1].wallMs,10549.5);
assert.equal(e.outliers[1].clockDifferenceMs,0);
assert.equal(e.gc[0].wallEstimateMs,10300);
assert.deepEqual(e.outliers[0].runtime,{cpuUserUs:10,cpuSystemUs:2,elu:runtime.elu,rssBytes:1024});
assert.deepEqual(e.versions,{node:'test',electron:'test',abi:'149'});
assert.ok(!JSON.stringify(e).includes('PRIVATE'));
// Regression: retained events grow without bound, or silently lose drop accounting.
for(let i=0;i<1000;i++) { c.tick(899.5+i*250,10799.5+i*250,runtime); c.gc({startTime:700+i,duration:1,kind:1,flags:0}); }
e=c.snapshot('partial');
assert.equal(e.status,'partial');
assert.equal(e.outliers.length,128);
assert.equal(e.droppedOutliers,874);
assert.equal(e.gc.length,128);
assert.equal(e.droppedGc,873);
assert.ok(Buffer.byteLength(JSON.stringify(e))<131072);
assert.throws(()=>c.tick(NaN,100,runtime),/finite/);
assert.throws(()=>c.gc({startTime:Infinity,duration:1}),/finite/);
const unavailable=createTelemetry({wallMs:1000,monotonicMs:0,versions:{node:'test',electron:'test',modules:'149'},osRelease:'test'});
unavailable.tick(150,1200,{});
const u=unavailable.snapshot('complete');
assert.equal(u.outliers[0].clockDifferenceMs,50,'wall clock change must not become monotonic timer lateness');
assert.deepEqual(u.lastRuntime,{cpuUserUs:null,cpuSystemUs:null,elu:null,rssBytes:null});
for(const row of [...e.outliers,...e.gc]) for(const [key,value] of Object.entries(row)) if(typeof value==='number') assert.ok(Number.isFinite(value),key);
// Regression: diagnostic mode repoints last-run or invokes the foundation timing gate.
const runner=fs.readFileSync(require.resolve('./run-electron-probe.cjs'),'utf8');
assert.match(runner,/--diagnostic/);
assert.match(runner,/diagnostic-evidence-/);
const main=fs.readFileSync(require.resolve('../electron/probe/main.cjs'),'utf8');
assert.match(main,/renameSync/);
assert.match(main,/partial/);
// Regression: loosening the foundation gate turns either retained failed soak green.
for(const file of ['idle-evidence-1790827780092.json','idle-evidence-1790868869293.json']) {
  const replay=require('node:child_process').spawnSync(process.execPath,[require.resolve('./test-electron-foundation.cjs'),require('node:path').resolve(__dirname,'../dist/electron-probe',file)],{encoding:'utf8'});
  assert.equal(replay.status,1);
  assert.match(replay.stderr,/AssertionError/);
  assert.match(replay.stderr,/test-electron-foundation\.cjs:40/);
}
if(process.argv[2]) {
  const d=JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(d.diagnosticOnly,true);
  assert.match(d.artifactSha256,/^[a-f0-9]{64}$/);
  assert.equal(d.utility.telemetry.protocol,1);
  assert.equal(d.utility.telemetry.status,'complete');
  const t=d.utility.telemetry;
  assert.deepEqual(t.versions,{node:d.utility.node,electron:d.utility.electron,abi:d.utility.abi});
  assert.ok(Number.isFinite(t.anchor.wallMs)&&Number.isFinite(t.anchor.monotonicMs));
  assert.match(t.clockBases,/Date.now.*performance.now.*GC/);
  assert.ok(t.outliers.length<=128&&t.gc.length<=128);
  assert.ok(Number.isFinite(t.lastRuntime.cpuUserUs)&&Number.isFinite(t.lastRuntime.cpuSystemUs));
  assert.ok(Number.isFinite(t.lastRuntime.rssBytes));
  for(const row of t.gc) assert.ok(Number.isFinite(row.monotonicMs)&&Number.isFinite(row.wallEstimateMs)&&Number.isFinite(row.durationMs));
  for(const row of t.outliers) {
    assert.ok(row.gapMs>=150);
    assert.equal(row.missed250,row.gapMs>=250);
    for(const key of ['monotonicMs','previousMonotonicMs','wallMs','clockDifferenceMs']) assert.ok(Number.isFinite(row[key]));
  }
  assert.equal(t.outliers.length+t.droppedOutliers,d.utility.timing.missed150);
  const partialFile=process.argv[2].replace('diagnostic-evidence-','diagnostic-crash-evidence-')+'.partial.json';
  const partial=JSON.parse(fs.readFileSync(partialFile));
  assert.equal(partial.status,'partial');
  assert.equal(partial.telemetry.status,'partial');
  assert.equal(partial.telemetry.protocol,1);
  assert.ok(d.utility.timing.durationMs>=1000 && d.utility.timing.durationMs<61000);
  assert.equal(d.quitChildExited,true);
  assert.equal(d.hermetic.ownedUtilityExited,true);
  assert.equal(d.crash.ownedUtilityExited,true);
  assert.equal(d.crash.partialTelemetry,true);
  assert.equal(d.renderer.sandboxed,true);
  assert.equal(d.utility.openedDevices,0);
  assert.ok(!/nativePaths|tempHome|"app"|"dmg"|PRIVATE/.test(JSON.stringify(d)));
  assert.ok(Buffer.byteLength(JSON.stringify(d))<=262144);
}
console.log('electron-probe-telemetry-v1 PASS: instrumentation only, not timing acceptance');
