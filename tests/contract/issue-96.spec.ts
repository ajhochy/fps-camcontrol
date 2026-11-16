import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityLog } from '../../src/app/activityLog';
import { createInitialState } from '../../src/app/state';
import { OutputSessions } from '../../src/broadcast/outputSession';
import { CaptureService } from '../../src/program/captureService';
import { registerProgramCapture } from '../../src/program/programCaptureRuntime';
import { LEGACY_CARD_MESSAGE, legacyCardUnsupported, PROGRAM_DEFAULTS, ProgramFeed } from '../../src/program/programFeed';
import { ProgramMonitor } from '../../src/program/programMonitor';
import { createStatusServer } from '../../src/ui/statusServer';
import { ProgramCaptureSchema, StreamingSchema } from '../../src/broadcast/streamingConfig';

const FAKE_HELPER = path.join(__dirname, '../program/fakeCaptureHelper.cjs');
const FAKE_MONITOR = path.join(__dirname, '../program/fakeMonitorEncoder.cjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

async function server(plans: object[], opts: { captureEnabled?: boolean; ffmpeg?: string | null; backoffMinMs?: number } = {}, run: (f: { origin: string; capture: CaptureService; monitor: ProgramMonitor; status: () => Promise<any>; frame: () => Promise<Response> }) => Promise<void>) {
  const state = createInitialState();
  const config: any = { cameras: [], devices: {}, atem: { ip: '127.0.0.1' }, graphics: {}, mappings: {}, speeds: {}, program: { ...PROGRAM_DEFAULTS }, programCapture: ProgramCaptureSchema.parse({ enabled: opts.captureEnabled !== false }), streaming: StreamingSchema.parse({}) };
  let n = 0;
  const capture = new CaptureService({ backoffMinMs: opts.backoffMinMs ?? 100, spawnHelper: (): ChildProcess => spawn(process.execPath, [FAKE_HELPER, JSON.stringify(plans[Math.min(n++, plans.length - 1)])], { stdio: ['pipe', 'ignore', 'pipe'] }) });
  const monitor = new ProgramMonitor(capture, { ffmpeg: () => (opts.ffmpeg === undefined ? FAKE_MONITOR : opts.ffmpeg) });
  registerProgramCapture(state, { capture, monitor, sessions: new OutputSessions(capture, { ffmpeg: () => null }), applyCapture: async () => {} });
  if (opts.captureEnabled !== false) { capture.start(); monitor.start(); }
  const app = (createStatusServer as any)(state, config, undefined, new ActivityLog(), undefined, new Map());
  const srv = http.createServer(app); await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(srv.address() as any).port}`;
  try { await run({ origin, capture, monitor, status: () => fetch(origin + '/api/program/status').then(r => r.json()), frame: () => fetch(origin + '/api/program/frame') }); }
  finally { await capture.stop(); srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); }
}

test('issue-96-c1: with program capture on, the PGM feed is the shared capture\'s monitor: JPEG frames, status kind capture', () => server([{}], {}, async f => {
  await until('frames', async () => (await f.frame()).status === 200);
  const r = await f.frame();
  assert.equal(r.headers.get('content-type'), 'image/jpeg'); assert.equal(r.headers.get('cache-control'), 'no-store');
  const s = await f.status();
  assert.equal(s.enabled, true); assert.equal(s.kind, 'capture'); assert.equal(s.running, true); assert.equal(s.fps, 10); assert.equal(s.error, null);
  assert.equal(f.capture.status().consumers.filter(c => c.id === 'monitor').length, 1, 'one monitor consumer on the one capture');
}));

test('issue-96-c2: no signal and capture down are said plainly and no earlier frame is served', () => server([{ signalLostAfterMs: 1200, exitAfterMs: 2500, exitCode: 1 }, {}], { backoffMinMs: 1500 }, async f => {
  await until('frames', async () => (await f.frame()).status === 200);
  await until('no signal', async () => (await f.status()).error === 'No signal on the capture card');
  let r = await f.frame();
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'No signal on the capture card');
  await until('restarting', async () => (await f.status()).error === 'Program capture is restarting', 4000);
  r = await f.frame(); assert.equal(r.status, 503); assert.equal((await r.json()).error, 'Program capture is restarting');
  await until('back', async () => (await f.frame()).status === 200, 6000);
  assert.equal(f.capture.consumer('monitor')!.attaches >= 2, true, 'the monitor re-attached to the restarted capture');
}));

test('issue-96-c3: without the FFmpeg runtime the PGM view says why instead of waiting forever', () => server([{}], { ffmpeg: null }, async f => {
  await sleep(300);
  const r = await f.frame();
  assert.equal(r.status, 503); assert.match((await r.json()).error, /FFmpeg runtime is not installed/);
}));

test('issue-96-c4: with program capture off, today\'s behaviour is unchanged (feed off → 409; the legacy feed is used)', () => server([{}], { captureEnabled: false }, async f => {
  const s = await f.status();
  assert.equal(s.enabled, false); assert.notEqual(s.kind, 'capture');
  assert.equal((await f.frame()).status, 409);
}));

test('issue-96-c5: legacy FFmpeg paths to a Blackmagic card are marked unsupported on macOS 26', async () => {
  assert.equal(legacyCardUnsupported('25.5.0'), os.platform() === 'darwin');
  assert.equal(legacyCardUnsupported('24.6.0'), false);
  if (!legacyCardUnsupported()) return;   // the behaviour check below needs macOS 26
  for (const cfg of [{ input: 'UltraStudio Recorder 3G', kind: 'decklink' as const }, { input: 'Blackmagic Design', kind: 'avfoundation' as const }]) {
    const feed = new ProgramFeed({ ...PROGRAM_DEFAULTS, enabled: true, ...cfg }) as any;
    let spawned = 0;
    feed.devices = async () => [{ index: 0, name: cfg.input, kind: cfg.kind }];
    feed.hasDecklink = async () => true; feed.spawnCapture = () => { spawned++; };
    feed.frame().catch(() => null); await sleep(100); feed.stop();
    assert.equal(spawned, 0); assert.equal(feed.status().error, LEGACY_CARD_MESSAGE);
  }
  const usb = new ProgramFeed({ ...PROGRAM_DEFAULTS, enabled: true, input: 'Cam Link 4K', kind: 'avfoundation' }) as any; let used = 0;
  usb.devices = async () => [{ index: 1, name: 'Cam Link 4K', kind: 'avfoundation' }]; usb.spawnCapture = () => { used++; };
  usb.frame().catch(() => null); await sleep(100); usb.stop();
  assert.equal(used, 1, 'a USB capture stick still works');
});

// ---- the real synthetic helper and a real FFmpeg monitor (skipped without them)
const FFMPEG = process.env.BROADCAST_FFMPEG || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(fs.existsSync);
const FFPROBE = FFMPEG && (process.env.BROADCAST_FFPROBE || path.join(path.dirname(FFMPEG), 'ffprobe'));
function buildHelper(): string | undefined {
  const dir = path.resolve(__dirname, '../../native/decklink-capture');
  try { execFileSync('make', ['-s', '-C', dir, 'BUILD=build-test'], { stdio: 'ignore' }); return path.join(dir, 'build-test/camcontrol-capture'); } catch { return undefined; }
}
const HELPER = buildHelper();

test('issue-96-c6 (real helper, real FFmpeg): ~10 fps 960-px JPEGs from the shared capture; a synthetic signal loss drops the picture at once', { skip: !HELPER || !FFMPEG ? 'helper build or ffmpeg unavailable' : false, timeout: 60_000 }, async () => {
  const capture = new CaptureService({ helper: HELPER, helperOptions: { synthetic: true, syntheticLoss: '6:3:nosignal' } });
  const monitor = new ProgramMonitor(capture, { ffmpeg: () => FFMPEG! });
  try {
    capture.start(); monitor.start();
    await until('first frame', () => !!monitor.frame(), 10_000);
    const a = monitor.status().frames, t = Date.now(); await sleep(2000);
    const fps = (monitor.status().frames - a) / ((Date.now() - t) / 1000);
    assert.ok(fps > 8 && fps < 12, `monitor rate ${fps.toFixed(1)} fps`);
    const jpeg = monitor.frame()!; const tmp = path.join(os.tmpdir(), `pgm-${process.pid}.jpg`); fs.writeFileSync(tmp, jpeg.body);
    const dims = execFileSync(FFPROBE!, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', tmp]).toString().trim(); fs.rmSync(tmp);
    assert.equal(dims, 'mjpeg,960,540');
    await until('signal loss', () => monitor.reason() === 'No signal on the capture card', 10_000);
    assert.equal(monitor.frame(), null, 'no frozen frame during the loss');
    await until('back', () => !!monitor.frame(), 10_000);
  } finally { await capture.stop(); }
});
