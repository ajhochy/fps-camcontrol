import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OutputSessions } from '../../src/broadcast/outputSession';
import { StreamingSchema } from '../../src/broadcast/streamingConfig';
import { CaptureService } from '../../src/program/captureService';
import { PROGRAM_DEFAULTS, ProgramFeed } from '../../src/program/programFeed';
import { programFeedFor } from '../../src/ui/programRoutes';
import { createInitialState } from '../../src/app/state';

const FAKE_HELPER = path.join(__dirname, '../program/fakeCaptureHelper.cjs');
const FAKE_ENCODER = path.join(__dirname, '../program/fakeEncoder.cjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
function rig(plans: object[]) {
  const spawned: number[] = [];
  const capture = new CaptureService({ backoffMinMs: 100, spawnHelper: (): ChildProcess => {
    spawned.push(Date.now());
    return spawn(process.execPath, [FAKE_HELPER, JSON.stringify(plans[Math.min(spawned.length - 1, plans.length - 1)])], { stdio: ['pipe', 'ignore', 'pipe'] });
  } });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-session-'));
  const sessions = new OutputSessions(capture, { ffmpeg: () => FAKE_ENCODER });
  const cfg = StreamingSchema.parse({ enabled: true, recordingFolder: folder });
  return { capture, sessions, cfg, spawned, folder, done: async () => { await capture.stop(); fs.rmSync(folder, { recursive: true, force: true }); } };
}
const reader = (id: string) => ({ id, restart: 'auto' as const, spawn: (fifo: string) => spawn('/bin/sh', ['-c', 'exec cat "$0" >/dev/null', fifo], { stdio: 'ignore' }) });

test('issue-70-c1: preview and session share the ONE capture; closing the preview cannot stop the recording', async () => {
  const r = rig([{}]);
  try {
    r.capture.start(); await until('capture up', () => r.capture.status().process === 'running');
    r.capture.addConsumer(reader('monitor'));
    const s = r.sessions.start(r.cfg);
    await until('session running', () => r.sessions.status()!.state === 'running');
    assert.equal(r.spawned.length, 1, 'one capture process for preview and session');
    await r.capture.removeConsumer('monitor');            // the preview goes idle / the iPad page closes
    await sleep(300);
    assert.equal(r.sessions.status()!.state, 'running', 'the session is unaffected');
    const done = await r.sessions.stop();
    assert.equal(done.endReason, 'stopped'); assert.equal(done.id, s.id);
    assert.match(fs.readFileSync(done.recordingPath, 'utf8'), /fake recording: \d+ bytes/);
  } finally { await r.done(); }
});

test('issue-70-c1b: the preview never opens the capture card while program capture owns it', async () => {
  const state = createInitialState();
  const feed = programFeedFor({ cameras: [], program: { ...PROGRAM_DEFAULTS, enabled: true, input: 'UltraStudio Recorder 3G', kind: 'decklink' }, programCapture: { enabled: true } } as any, state);
  assert.equal(feed.cardOwned(), true);
  const f = feed as any;
  let spawned = 0;
  f.devices = async () => [{ index: 0, name: 'UltraStudio Recorder 3G', kind: 'decklink' }];
  f.hasDecklink = async () => true;
  f.spawnCapture = () => { spawned++; };
  await feed.frame().catch(() => null);
  await sleep(50);
  assert.equal(spawned, 0, 'no second opener');
  assert.match(feed.status().error ?? '', /in use by program capture/);
  // A non-Blackmagic preview device (e.g. a USB capture stick) is still allowed.
  const other = new ProgramFeed({ ...PROGRAM_DEFAULTS, enabled: true, input: 'Cam Link 4K', kind: 'avfoundation' }); other.cardOwned = () => true;
  const o = other as any; let otherSpawned = 0;
  o.devices = async () => [{ index: 1, name: 'Cam Link 4K', kind: 'avfoundation' }]; o.spawnCapture = () => { otherSpawned++; };
  await other.frame().catch(() => null); await sleep(50);
  assert.equal(otherSpawned, 1);
});

test('issue-70-c2: valid signal, absent signal, disconnected device and failed process are reported separately; filler never clears absent', async () => {
  const r = rig([{ signalLostAfterMs: 300, deviceLostAfterMs: 900, exitAfterMs: 1500, exitCode: 1 }, {}]);
  const seen: string[] = [];
  r.capture.on('status', s => { const k = `${s.process}/${s.signal}/${s.device}`; if (seen[seen.length - 1] !== k) seen.push(k); });
  try {
    r.capture.start();
    await until('second helper', () => r.spawned.length === 2 && r.capture.status().signal === 'locked', 6000);
    for (const k of ['running/locked/ok', 'running/absent/ok', 'running/absent/disconnected', 'restarting/unknown/disconnected']) assert.ok(seen.includes(k), `${k} in ${seen.join(' → ')}`);
    assert.ok(r.capture.status().fillerFrames === 0);
  } finally { await r.done(); }
});

test('issue-70-c3: no signal keeps the session with a warning; device loss and process loss end it; returning hardware never restarts it', async () => {
  // signal absent on a healthy process: session continues, warned
  let r = rig([{ signalLostAfterMs: 400 }]);
  try {
    r.capture.start(); await until('up', () => r.capture.status().process === 'running');
    r.sessions.start(r.cfg); await until('running', () => r.sessions.status()!.state === 'running');
    await until('warning', () => r.sessions.status()!.warning === 'no-signal');
    await sleep(300);
    assert.equal(r.sessions.status()!.state, 'running');
    assert.equal((await r.sessions.stop()).endReason, 'stopped');
  } finally { await r.done(); }
  // device disconnected while the helper runs: the session ends safely
  r = rig([{ deviceLostAfterMs: 400 }]);
  try {
    r.capture.start(); await until('up', () => r.capture.status().process === 'running');
    r.sessions.start(r.cfg); await until('running', () => r.sessions.status()!.state === 'running');
    await until('ended', () => r.sessions.status()!.state === 'ended');
    assert.equal(r.sessions.status()!.endReason, 'device-lost');
    assert.ok(fs.existsSync(r.sessions.status()!.recordingPath), 'the recording was finalized from what arrived');
  } finally { await r.done(); }
  // process lost: the session ends; the capture comes back; the session does not
  r = rig([{ exitAfterMs: 500, exitCode: 1 }, {}]);
  try {
    r.capture.start(); await until('up', () => r.capture.status().process === 'running');
    r.sessions.start(r.cfg); await until('running', () => r.sessions.status()!.state === 'running');
    await until('ended', () => r.sessions.status()!.state === 'ended');
    assert.equal(r.sessions.status()!.endReason, 'capture-lost');
    await until('capture back', () => r.spawned.length === 2 && r.capture.status().signal === 'locked');
    await sleep(500);
    assert.equal(r.sessions.status()!.state, 'ended', 'never auto-restarted');
    assert.equal(r.capture.status().consumers.filter(c => c.id.startsWith('session-') && c.state !== 'ended').length, 0, 'nothing is sending');
    assert.equal(r.sessions.running(), false);
  } finally { await r.done(); }
});

// ---- real synthetic helper + real FFmpeg encoder (skipped when either is unavailable)
const FFMPEG = process.env.BROADCAST_FFMPEG || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(fs.existsSync);
const FFPROBE = FFMPEG && (process.env.BROADCAST_FFPROBE || path.join(path.dirname(FFMPEG), 'ffprobe'));
function buildHelper(): string | undefined {
  const dir = path.resolve(__dirname, '../../native/decklink-capture');
  try { execFileSync('make', ['-s', '-C', dir, 'BUILD=build-test'], { stdio: 'ignore' }); return path.join(dir, 'build-test/camcontrol-capture'); } catch { return undefined; }
}
const HELPER = buildHelper();
const probe = (file: string) => JSON.parse(execFileSync(FFPROBE!, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,nb_read_packets:format=duration', '-of', 'json', file]).toString());

test('issue-70-c4 (real helper, real encoder): Record only through the shared capture; signal loss keeps it with a warning; helper loss ends it with a playable MP4', { skip: !HELPER || !FFMPEG ? 'helper build or ffmpeg unavailable' : false, timeout: 90_000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'Livestream Recordings '));
  const capture = new CaptureService({ helper: HELPER, helperOptions: { synthetic: true, syntheticLoss: '3:2:nosignal' }, backoffMinMs: 300 });
  const sessions = new OutputSessions(capture, { ffmpeg: () => FFMPEG! });
  const cfg = StreamingSchema.parse({ enabled: true, recordingFolder: folder });
  try {
    capture.start(); await until('up', () => capture.status().signal === 'locked', 10_000);
    const a = sessions.start({ ...cfg, recordingFolder: folder });
    assert.match(a.recordingPath, /Livestream Recordings .*\/FPS \d{4}-\d{2}-\d{2} \d{6}\.mp4$/);
    await until('warning during the synthetic loss', () => sessions.status()!.warning === 'no-signal', 10_000);
    assert.equal(sessions.status()!.state, 'running');
    await until('signal back', () => sessions.status()!.warning === null, 10_000);
    const stopped = await sessions.stop();
    assert.equal(stopped.endReason, 'stopped');
    let p = probe(stopped.recordingPath);
    assert.deepEqual(p.streams.map((s: any) => s.codec_name).sort(), ['aac', 'h264']);
    // Covers before, during (2 s of black + silence filler) and after the loss, with no hole: 30 video packets per second.
    const dur = Number(p.format.duration), vpk = Number(p.streams.find((x: any) => x.codec_name === 'h264').nb_read_packets);
    assert.ok(dur >= 3, `duration ${dur}`);
    assert.ok(Math.abs(vpk - dur * 30) <= Math.max(3, dur), `video packets ${vpk} for ${dur} s`);
    // Second session, then kill the helper: the session ends as capture-lost; FFmpeg saw end of stream and closed the MP4.
    const b = sessions.start({ ...cfg, recordingFolder: folder });
    await until('b running', () => sessions.status()!.state === 'running' && capture.consumer(b.id)!.framesOut > 60, 10_000);
    execFileSync('pkill', ['-KILL', '-f', `${HELPER} --serve`]);
    await until('b ended', () => sessions.status()!.state === 'ended', 10_000);
    assert.equal(sessions.status()!.endReason, 'capture-lost');
    await until('encoder exited', () => sessions.status()!.encoderExit !== undefined, 15_000);
    p = probe(b.recordingPath);
    assert.ok(Number(p.format.duration) > 1.5, 'the partial recording is playable');
    await until('capture back', () => capture.status().process === 'running' && capture.status().restarts === 1, 10_000);
    assert.equal(sessions.running(), false, 'no session restarted by itself');
  } finally { await capture.stop(); fs.rmSync(folder, { recursive: true, force: true }); }
});
