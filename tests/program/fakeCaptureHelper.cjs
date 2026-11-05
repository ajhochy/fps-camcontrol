// Scripted stand-in for `camcontrol-capture --serve` (tests only). argv[2] is a JSON plan:
//   { exitAfterMs?, exitCode?, errorCode?, silentAfterMs?, signalLocked?=true, deviceOk?=true, signalLostAfterMs?, deviceLostAfterMs?, ignoreAttach?, silent? }
// Speaks the same stderr JSON lines and stdin attach/detach protocol; writes a few bytes to each attached FIFO.
const fs = require('node:fs');
const plan = JSON.parse(process.argv[2] || '{}');
const t0 = Date.now();
const emit = o => process.stderr.write(JSON.stringify({ t_ms: Date.now() - t0, ...o }) + '\n');
const consumers = new Map();
let silent = plan.silent === true;
if (plan.signalLostAfterMs !== undefined) setTimeout(() => { plan.signalLocked = false; }, plan.signalLostAfterMs);
if (plan.deviceLostAfterMs !== undefined) setTimeout(() => { plan.deviceOk = false; }, plan.deviceLostAfterMs);

const status = setInterval(() => {
  if (silent) return;
  emit({ type: 'status', state: 'running', mode: '1080p30', width: 1920, height: 1080, fps_nominal: 30, fps: 30, signal_locked: plan.signalLocked !== false, device_ok: plan.deviceOk !== false,
    audio_present: false, frames_in: 30, frames_out: 30, filler_frames: plan.signalLocked === false ? 30 : 0, dropped_backpressure: 0, dropped_late: 0, audio_resyncs: 0, audio_dropped: 0,
    queue_depth: 0, queue_cap: 12, blocked_ms: 0, max_block_ms: 0, bytes_out: 0,
    consumers: [...consumers.keys()].map(id => ({ id, frames_out: 30, dropped_backpressure: 0, dropped_units: 0, queue_depth: 0, blocked_ms: 0, max_block_ms: 0, bytes_out: 10 })) });
}, 50);
const writer = setInterval(() => { for (const [id, fd] of consumers) { try { fs.writeSync(fd, 'x'); } catch { consumers.delete(id); try { fs.closeSync(fd); } catch {} emit({ type: 'event', event: 'consumer-detached', id, reason: 'closed' }); } } }, 50);

function openFifo(path, tries = 0) {
  try { return fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENXIO' && tries < 100) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); return openFifo(path, tries + 1); } throw e; }
}
let buf = '';
process.stdin.on('data', d => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const a = /^attach (\S+) (\S+)$/.exec(line), dt = /^detach (\S+)$/.exec(line);
    if (a && plan.ignoreAttach) continue;   // never opens the FIFO and never replies
    if (a) { try { consumers.set(a[1], openFifo(a[2])); emit({ type: 'event', event: 'consumer-attached', id: a[1] }); } catch (e) { emit({ type: 'event', event: 'consumer-attach-failed', id: a[1], reason: e.code }); } }
    if (dt) { const fd = consumers.get(dt[1]); consumers.delete(dt[1]); if (fd !== undefined) fs.closeSync(fd); emit({ type: 'event', event: 'consumer-detached', id: dt[1], reason: 'detached' }); }
  }
});
process.stdin.on('end', () => { emit({ type: 'event', event: 'control-closed' }); finish(0); });
function finish(code) { clearInterval(status); clearInterval(writer); for (const fd of consumers.values()) try { fs.closeSync(fd); } catch {} emit({ type: 'exit', code, frames_in: 0, frames_out: 0, filler_frames: 0, dropped_backpressure: 0, dropped_late: 0, bytes_out: 0 }); process.exit(code); }
if (plan.errorCode) { emit({ type: 'error', code: plan.errorCode, message: plan.errorCode, exit: plan.exitCode ?? 4 }); finish(plan.exitCode ?? 4); }
if (plan.exitAfterMs !== undefined) setTimeout(() => { if (plan.exitCode === 5) emit({ type: 'error', code: 'format-changed', message: 'format changed', exit: 5 }); finish(plan.exitCode ?? 1); }, plan.exitAfterMs);
if (plan.silentAfterMs !== undefined) setTimeout(() => { silent = true; }, plan.silentAfterMs);
