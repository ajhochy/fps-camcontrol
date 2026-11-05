import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CaptureService, ConsumerSpec } from '../../src/program/captureService';

const FAKE = path.join(__dirname, 'fakeCaptureHelper.cjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
/** One fake helper per spawn, scripted by plans[i] (the last plan repeats). */
function scripted(plans: object[]) {
  const spawned: string[][] = [];
  return { spawned, spawnHelper: (_bin: string, args: string[]): ChildProcess => {
    spawned.push(args);
    return spawn(process.execPath, [FAKE, JSON.stringify(plans[Math.min(spawned.length - 1, plans.length - 1)])], { stdio: ['pipe', 'ignore', 'pipe'] });
  } };
}
const reader = (id: string, restart: ConsumerSpec['restart'] = 'auto'): ConsumerSpec => ({ id, restart, spawn: fifo => spawn('/bin/sh', ['-c', 'exec cat "$0" >/dev/null', fifo], { stdio: 'ignore' }) });
const fast = { backoffMinMs: 50, backoffMaxMs: 400, staleMs: 600 };

test('capture service: attaches consumers, reports per-consumer stats, detaches cleanly and leaves no FIFOs', async () => {
  const fifoDir = mkdtempSync(path.join(os.tmpdir(), 'cs-unit-'));
  const h = scripted([{}]);
  const svc = new CaptureService({ ...fast, fifoDir, spawnHelper: h.spawnHelper });
  try {
    svc.start();
    assert.equal(statSync(fifoDir).mode & 0o777, 0o700, 'FIFO directory is private');
    svc.addConsumer(reader('monitor')); svc.addConsumer(reader('session-1', 'never'));
    await until('both attached', () => svc.status().consumers.every(c => c.state === 'attached'));
    await until('stats', () => svc.consumer('monitor')!.framesOut === 30);
    const st = svc.status();
    assert.equal(st.process, 'running'); assert.equal(st.signal, 'locked'); assert.equal(st.device, 'ok');
    assert.deepEqual(h.spawned[0].slice(0, 1), ['--serve']);
    assert.throws(() => svc.addConsumer(reader('monitor')), /already attached/);
    assert.throws(() => svc.addConsumer(reader('bad id!')), /consumer id/);
    await svc.removeConsumer('session-1');
    assert.equal(svc.consumer('session-1'), undefined);
    assert.equal(svc.status().consumers.length, 1);
  } finally { await svc.stop(); }
  assert.equal(svc.status().process, 'stopped');
  assert.deepEqual(readdirSync(fifoDir), [], 'every FIFO removed');
  rmSync(fifoDir, { recursive: true, force: true });
});

test('capture service: crash restarts with backoff; auto consumers re-attach, session consumers end and stay ended', async () => {
  const h = scripted([{ exitAfterMs: 400, exitCode: 1 }, { exitAfterMs: 400, exitCode: 1 }, {}]);
  const ended: string[] = [];
  const svc = new CaptureService({ ...fast, spawnHelper: h.spawnHelper });
  svc.on('consumer-ended', (id: string, reason: string) => ended.push(`${id}:${reason}`));
  try {
    svc.start(); svc.addConsumer(reader('monitor')); svc.addConsumer(reader('session-1', 'never'));
    await until('third helper', () => h.spawned.length === 3 && svc.status().process === 'running');
    await until('monitor back', () => svc.consumer('monitor')!.state === 'attached');
    const st = svc.status();
    assert.equal(st.restarts, 2); assert.equal(st.lastExit?.reason, 'exit 1');
    assert.equal(svc.consumer('monitor')!.attaches, 3, 'monitor re-attached after each restart');
    assert.equal(svc.consumer('session-1')!.state, 'ended'); assert.equal(svc.consumer('session-1')!.reason, 'capture-lost');
    assert.deepEqual(ended, ['session-1:capture-lost'], 'returning capture never restarts a session');
    assert.equal(st.consumersLost, 0, 'an expected exit after a helper restart is not a lost consumer');
  } finally { await svc.stop(); }
});

test('capture service: busy card and missing device are clear, non-fatal states that retry with growing backoff', async () => {
  const h = scripted([{ errorCode: 'device-busy', exitCode: 4 }, { errorCode: 'device-busy', exitCode: 4 }, { errorCode: 'no-device', exitCode: 3 }, {}]);
  const svc = new CaptureService({ ...fast, spawnHelper: h.spawnHelper });
  const seen = new Set<string>();
  svc.on('status', s => { seen.add(`${s.process}/${s.device}`); });
  try {
    svc.start();
    await until('busy seen', () => seen.has('restarting/busy'));
    await until('missing seen', () => seen.has('restarting/missing'));
    await until('recovered', () => h.spawned.length === 4 && svc.status().device === 'ok', 10_000);
    assert.equal(svc.status().restarts, 3);
  } finally { await svc.stop(); }
});

test('capture service: format change restarts at once; a wedged helper (no status) is killed and replaced; no signal is reported as absent', async () => {
  const h = scripted([{ exitAfterMs: 300, exitCode: 5 }, { silentAfterMs: 300 }, { signalLocked: false }]);
  const ended: string[] = [];
  const svc = new CaptureService({ ...fast, backoffMinMs: 2000, spawnHelper: h.spawnHelper });
  svc.on('consumer-ended', (id: string, reason: string) => ended.push(`${id}:${reason}`));
  try {
    svc.start(); svc.addConsumer(reader('session-1', 'never'));
    const t = Date.now();
    await until('second helper', () => h.spawned.length === 2, 1500);
    assert.ok(Date.now() - t < 1500, 'format change does not wait for the backoff');
    assert.deepEqual(ended, ['session-1:format-changed']);
    await until('stale kill + third helper', () => h.spawned.length === 3 && svc.status().process === 'running', 6000);
    await until('status from third', () => svc.status().signal === 'absent');
    assert.equal(svc.status().signal, 'absent');
  } finally { await svc.stop(); }
});

test('capture service: a consumer the helper never attaches is ended in time (a session does not sit in starting)', async () => {
  const h = scripted([{ ignoreAttach: true }]);
  const svc = new CaptureService({ ...fast, attachTimeoutMs: 400, spawnHelper: h.spawnHelper });
  try {
    svc.start(); svc.addConsumer(reader('session-1', 'never'));
    await until('ended', () => svc.consumer('session-1')?.state === 'ended', 3000);
    assert.equal(svc.consumer('session-1')!.reason, 'attach-failed');
  } finally { await svc.stop(); }
});

test('capture service: a helper that never prints a status line is killed and replaced', async () => {
  const h = scripted([{ silent: true }, {}]);
  const svc = new CaptureService({ ...fast, startupMs: 500, spawnHelper: h.spawnHelper });
  try {
    svc.start();
    await until('replaced', () => h.spawned.length === 2 && svc.status().signal === 'locked', 5000);
    assert.equal(svc.status().restarts, 1);
  } finally { await svc.stop(); }
});

test('capture service: stop() during restart() wins; nothing starts after it', async () => {
  const h = scripted([{}]);
  const svc = new CaptureService({ ...fast, spawnHelper: h.spawnHelper });
  svc.start(); await until('up', () => svc.status().process === 'running');
  const r = svc.restart(); const s = svc.stop();
  await Promise.all([r, s]); await sleep(200);
  assert.equal(svc.status().process, 'stopped'); assert.equal(h.spawned.length, 1);
});

test('capture service: stop() ends consumers and the helper even if it ignores stdin EOF', async () => {
  const svc = new CaptureService({ ...fast, spawnHelper: () => spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { stdio: ['pipe', 'ignore', 'pipe'] }) });
  svc.start(); await sleep(100);
  const t = Date.now(); await svc.stop(150);
  assert.ok(Date.now() - t < 2000, 'escalated to SIGKILL');
  assert.equal(svc.status().process, 'stopped');
});

// ---- the real synthetic helper and real FFmpeg consumers (skipped when the helper cannot be built or FFmpeg is absent)
const FFMPEG = process.env.BROADCAST_FFMPEG || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync);
const FFPROBE = FFMPEG && (process.env.BROADCAST_FFPROBE || path.join(path.dirname(FFMPEG), 'ffprobe'));
function buildHelper(): string | undefined {
  const dir = path.resolve(__dirname, '../../native/decklink-capture');
  try { execFileSync('make', ['-s', '-C', dir, 'BUILD=build-test'], { stdio: 'ignore' }); return path.join(dir, 'build-test/camcontrol-capture'); } catch { return undefined; }
}
const HELPER = buildHelper();
const frames = (file: string) => Number(execFileSync(FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).toString().trim());
const recorder = (id: string, out: string, restart: ConsumerSpec['restart']): ConsumerSpec =>
  ({ id, restart, spawn: fifo => spawn(FFMPEG!, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'matroska', '-i', fifo, '-c', 'copy', '-f', 'matroska', '-y', out], { stdio: 'ignore' }) });

test('capture service + real helper: two consumers, one stalled; attach/detach mid-run; helper crash restarts and re-attaches', { skip: !HELPER || !FFMPEG ? 'helper build or ffmpeg unavailable' : false, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-real-'));
  const svc = new CaptureService({ helper: HELPER, helperOptions: { synthetic: true, queueFrames: 12 }, stallMs: 1000, backoffMinMs: 200 });
  try {
    svc.start();
    svc.addConsumer(recorder('monitor', path.join(dir, 'monitor.mkv'), 'auto'));
    // A reader that opens its FIFO and never reads: the helper must drop it, and the monitor must not notice.
    svc.addConsumer({ id: 'stuck', restart: 'never', spawn: fifo => spawn('/bin/sh', ['-c', 'exec 4<"$0"; sleep 30', fifo], { stdio: 'ignore' }) });
    await until('stuck dropped', () => svc.consumer('stuck')?.reason === 'stalled', 10_000);
    await sleep(500);
    svc.addConsumer(recorder('late', path.join(dir, 'late.mkv'), 'never'));
    await until('late attached', () => svc.consumer('late')?.state === 'attached');
    await sleep(2000);
    await svc.removeConsumer('late');
    const late = frames(path.join(dir, 'late.mkv'));
    assert.ok(late >= 55 && late <= 75, `late consumer got ${late} frames in ~2 s`);
    const mon = svc.consumer('monitor')!;
    assert.equal(mon.droppedBackpressure, 0, 'the stalled consumer never backed up the monitor');
    // Crash the helper: the monitor re-attaches to the replacement; nothing is left half-open.
    const before = svc.status().restarts;
    execFileSync('pkill', ['-KILL', '-f', `${HELPER} --serve`]);
    await until('restarted', () => svc.status().restarts === before + 1 && svc.consumer('monitor')?.state === 'attached', 10_000);
    await sleep(1000);
    assert.ok(svc.consumer('monitor')!.framesOut > 20, 'frames flow to the re-attached monitor');
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
