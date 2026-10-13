const { performance, PerformanceObserver } = require('node:perf_hooks');
function createTelemetry({wallMs, monotonicMs, versions, osRelease}) {
  const finite = value => { if (!Number.isFinite(value)) throw new Error('finite telemetry required'); return value; };
  const anchor = {wallMs:finite(wallMs),monotonicMs:finite(monotonicMs)};
  const outliers=[], gc=[];
  let previous=monotonicMs, droppedOutliers=0, droppedGc=0, lastRuntime=null;
  const runtime = r => ({cpuUserUs:Number.isFinite(r?.cpuUserUs)?r.cpuUserUs:null,
    cpuSystemUs:Number.isFinite(r?.cpuSystemUs)?r.cpuSystemUs:null,
    elu:r?.elu && ['idle','active','utilization'].every(k=>Number.isFinite(r.elu[k]))
      ? {idle:r.elu.idle,active:r.elu.active,utilization:r.elu.utilization}:null,
    rssBytes:Number.isFinite(r?.rssBytes)?r.rssBytes:null});
  return {
    tick(now, wall, r) {
      finite(now); finite(wall);
      const gapMs=now-previous;
      if(gapMs<0) throw new Error('monotonic telemetry regressed');
      lastRuntime=runtime(r);
      if(gapMs>=150) {
        const row={gapMs,missed250:gapMs>=250,previousMonotonicMs:previous,monotonicMs:now,wallMs:wall,
          clockDifferenceMs:(wall-anchor.wallMs)-(now-anchor.monotonicMs),runtime:lastRuntime};
        if(outliers.length<128) outliers.push(row); else droppedOutliers++;
      }
      previous=now;
    },
    gc(entry) {
      const startTime=finite(entry.startTime), durationMs=finite(entry.duration);
      const row={monotonicMs:startTime,durationMs,wallEstimateMs:anchor.wallMs+startTime-anchor.monotonicMs,
        kind:Number.isFinite(entry.kind)?entry.kind:null,flags:Number.isFinite(entry.flags)?entry.flags:null};
      if(gc.length<128) gc.push(row); else droppedGc++;
    },
    snapshot(status) {
      if(!['partial','complete'].includes(status)) throw new Error('invalid telemetry status');
      return {protocol:1,status,anchor,clockBases:'Date.now epoch ms; performance.now process-relative ms; GC uses performance timeline',
        versions:{node:versions.node,electron:versions.electron,abi:versions.modules},osRelease,
        limits:{outliers:128,gc:128},outliers:[...outliers],gc:[...gc],droppedOutliers,droppedGc,lastRuntime};
    }
  };
}
module.exports = {createTelemetry};
if (require.main === module) {
const durationMs = Number(process.argv[2]);
const parent = process.parentPort;
try {
  const hid = require('node-hid');
  // Enumeration only. Never instantiate HID/HIDAsync, and never persist device identifiers.
  const count = hid.devices().length;
  const path = require('node:path');
  const packageRoot = path.resolve(__dirname);
  const nativePaths = Object.keys(require.cache).filter(p=>p.endsWith('.node'))
    .map(p=>path.relative(packageRoot,p));
  const samples = [];
  const start = performance.now();
  const telemetry=createTelemetry({wallMs:Date.now(),monotonicMs:start,versions:process.versions,osRelease:require('node:os').release()});
  const observer=new PerformanceObserver(list=>{
    for(const entry of list.getEntries()) telemetry.gc({startTime:entry.startTime,duration:entry.duration,
      kind:entry.detail?.kind,flags:entry.detail?.flags});
  });
  if(PerformanceObserver.supportedEntryTypes.includes('gc')) observer.observe({entryTypes:['gc']});
  let previousCpu=process.cpuUsage(), previousElu=performance.eventLoopUtilization?.();
  let lastCheckpoint=start;
  parent.postMessage({type:'telemetry',telemetry:telemetry.snapshot('partial')});
  let previous = start;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu=process.cpuUsage(), elu=performance.eventLoopUtilization?.();
    telemetry.tick(now,Date.now(),{cpuUserUs:cpu.user-previousCpu.user,cpuSystemUs:cpu.system-previousCpu.system,
      elu:elu && performance.eventLoopUtilization(elu,previousElu),rssBytes:process.memoryUsage.rss()});
    previousCpu=cpu; previousElu=elu;
    // ponytail: full histogram remains unchanged; stop explicitly if its fixed cap is exhausted.
    if(samples.length>=240000) { clearInterval(timer); parent.postMessage({type:'error',code:'SAMPLE_CAP_EXHAUSTED'}); return; }
    samples.push(now - previous);
    previous = now;
    if(now-lastCheckpoint>=5000) { parent.postMessage({type:'telemetry',telemetry:telemetry.snapshot('partial')}); lastCheckpoint=now; }
    if (now - start >= durationMs) {
      clearInterval(timer);
      for(const entry of observer.takeRecords()) telemetry.gc({startTime:entry.startTime,duration:entry.duration,
        kind:entry.detail?.kind,flags:entry.detail?.flags});
      observer.disconnect();
      samples.sort((a,b) => a-b);
      const percentile = p => samples[Math.min(samples.length - 1, Math.ceil(samples.length*p)-1)];
      parent.postMessage({type:'result', result:{ hidLoaded:true, enumerated:true,
        deviceCount:count, openedDevices:0, nativePaths, arch:process.arch, abi:process.versions.modules,
        electron:process.versions.electron, node:process.versions.node, telemetry:telemetry.snapshot('complete'),
        timing:{durationMs:now-start, samples:samples.length, p50:percentile(.5),
          p95:percentile(.95), p99:percentile(.99), max:samples[samples.length-1],
          missed150:samples.filter(v => v >= 150).length, missed250:samples.filter(v => v >= 250).length} }});
    }
  }, 1000/60);
  parent.on('message', ({data}) => { if (data?.type === 'shutdown') { clearInterval(timer); process.exit(0); } });
  // Parent loss must not leave an owned utility alive, including SIGKILL of the app.
  const owner = process.ppid;
  setInterval(() => {
    try { process.kill(owner, 0); } catch { process.exit(0); }
    if (process.ppid !== owner) process.exit(0);
  }, 250).unref();
} catch {
  parent.postMessage({type:'error',code:'NATIVE_HID_LOAD_OR_ENUMERATION_FAILED'});
  process.exitCode = 1;
}
}
