import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as YAML from 'yaml';
import { ActivityLog } from '../../src/app/activityLog';
import { createInitialState } from '../../src/app/state';
import { OutputSessions } from '../../src/broadcast/outputSession';
import { StreamingSchema, validateStreaming } from '../../src/broadcast/streamingConfig';
import { loadConfig } from '../../src/config/configLoader';
import { CaptureService } from '../../src/program/captureService';
import { registerProgramCapture } from '../../src/program/programCaptureRuntime';
import { createStatusServer } from '../../src/ui/statusServer';

const base: any = { atem: { ip: '127.0.0.1', defaultTransition: 'cut' }, devices: { rig: { label: 'Synthetic rig', protocol: 'dji-bridge', bridge: { host: '127.0.0.1', port: 17879 } } }, profiles: { one: { slots: [{ device: 'rig' }] } }, activeProfile: 'one', sony: { enabled: false } };
const KEYS = ['CAMCONTROL_HOME', 'DEVICES_CONFIG', 'SPEEDS_FILE', 'MAPPINGS_FILE'];
function home(raw: any): { dir: string; file: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-streaming-config-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/devices.yaml');
  fs.writeFileSync(file, YAML.stringify(raw));
  fs.writeFileSync(path.join(dir, 'config/speeds.json'), JSON.stringify({ presets: [{ name: 'Normal', multiplier: 1 }], activePreset: 0 }));
  fs.writeFileSync(path.join(dir, 'config/mappings.yaml'), '{}\n');
  const old = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.CAMCONTROL_HOME = dir;
  return { dir, file, restore: () => { for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Saving through the status server instantiates the YAML's rig (existing config-edit behaviour), whose bridge client
// keeps reconnecting; end the file once its tests are done instead of waiting on that unrelated socket.
test.after(() => setImmediate(() => process.exit()));

test('issue-69-c1: existing configs load with capture off and streaming idle; preview fps/width keep their meaning', () => {
  const h = home({ ...base, program: { enabled: true, input: 'Cam Link', fps: 12, width: 640 } });
  try {
    const c = loadConfig();
    assert.deepEqual(c.streaming, { enabled: false, source: 'program-capture', profile: '1080p30', videoBitrateKbps: 6000, recordingFolder: null, videoDelayFrames: 0 });
    assert.equal(c.programCapture!.enabled, false);
    assert.equal(c.program!.fps, 12); assert.equal(c.program!.width, 640);
  } finally { h.restore(); }
});

test('issue-69-c2: qualified values persist; boundaries and unsupported values give specific errors, never a substitute', () => {
  const ok = validateStreaming({ enabled: true, profile: '1080p2997', videoBitrateKbps: 2500, recordingFolder: '/Volumes/Recordings/Livestream Recordings', videoDelayFrames: 15 });
  assert.equal(ok.ok, true);
  for (const [input, field, msg] of [
    [{ profile: '720p60' }, 'profile', /Unsupported streaming profile: qualified profiles are 1080p30, 1080p2997/],
    [{ profile: '1080p60' }, 'profile', /Unsupported streaming profile/],
    [{ source: 'avfoundation' }, 'source', /program-capture/],
    [{ videoBitrateKbps: 2499 }, 'videoBitrateKbps', /at least 2500/],
    [{ videoBitrateKbps: 12001 }, 'videoBitrateKbps', /at most 12000/],
    [{ videoBitrateKbps: 6000.5 }, 'videoBitrateKbps', /whole number/],
    [{ videoDelayFrames: 16 }, 'videoDelayFrames', /0-15/],
    [{ videoDelayFrames: -1 }, 'videoDelayFrames', /0-15/],
    [{ videoDelayFrames: 1.5 }, 'videoDelayFrames', /whole number of frames/],
    [{ recordingFolder: 'relative/dir' }, 'recordingFolder', /absolute/],
    [{ recordingFolder: '/tmp/a|b' }, 'recordingFolder', /cannot contain/],
    [{ recordingFolder: '/tmp/a ' }, 'recordingFolder', /end in a space/],
    [{ codec: 'hevc' }, 'codec', /Unknown setting: codec/],
  ] as const) {
    const r = validateStreaming(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (!r.ok) { assert.equal(r.errors[0].field, field); assert.match(r.errors[0].message, msg); }
  }
  assert.throws(() => StreamingSchema.parse({ profile: '720p60' }));
});

// ---- routes, with a running capture (scripted fake helper) and a fake encoder
const FAKE_HELPER = path.join(__dirname, '../program/fakeCaptureHelper.cjs');
const FAKE_ENCODER = path.join(__dirname, '../program/fakeEncoder.cjs');
async function server(run: (f: { origin: string; put: (p: string, b: unknown, h?: Record<string, string>) => Promise<Response>; post: (p: string, b?: unknown) => Promise<Response>; sessions: OutputSessions; file: string; dir: string }) => Promise<void>) {
  const h = home({ ...base, programCapture: { enabled: true }, program: { enabled: false, input: 'UltraStudio Recorder 3G', kind: 'decklink' } });
  const folder = path.join(h.dir, 'Livestream Recordings'); fs.mkdirSync(folder);
  const state = createInitialState();
  // No rigs in the running config: these tests are about streaming routes, and a rig would make the server dial its bridge.
  const config: any = { ...loadConfig(), cameras: [], devices: {} };
  const capture = new CaptureService({ spawnHelper: (): ChildProcess => spawn(process.execPath, [FAKE_HELPER, '{}'], { stdio: ['pipe', 'ignore', 'pipe'] }) });
  const sessions = new OutputSessions(capture, { ffmpeg: () => FAKE_ENCODER });
  registerProgramCapture(state, { capture, sessions, applyCapture: async () => {} });
  capture.start();
  const app = (createStatusServer as any)(state, config, undefined, new ActivityLog(), undefined, new Map());
  const srv = http.createServer(app); await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(srv.address() as any).port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    await run({ origin, sessions, file: h.file, dir: folder,
      put: (p, b, extra = {}) => fetch(origin + p, { method: 'PUT', headers: { ...json, ...extra }, body: JSON.stringify(b) }),
      post: (p, b = {}) => fetch(origin + p, { method: 'POST', headers: json, body: JSON.stringify(b) }) });
  } finally { await capture.stop(); srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); h.restore(); }
}

test('issue-69-c3: config adapter saves valid settings and returns field errors for invalid ones', () => server(async f => {
  let r = await f.put('/api/streaming/config', { enabled: true, recordingFolder: f.dir, videoDelayFrames: 3 });
  assert.equal(r.status, 200);
  assert.equal(YAML.parse(fs.readFileSync(f.file, 'utf8')).streaming.videoDelayFrames, 3, 'persisted to devices.yaml');
  r = await f.put('/api/streaming/config', { profile: '720p60', videoDelayFrames: 99 });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.deepEqual(body.errors.map((e: any) => e.field).sort(), ['profile', 'videoDelayFrames']);
  r = await f.put('/api/streaming/config', { enabled: false }, { 'X-Remote': '1' });
  assert.equal(r.status, 403, 'the iPad page cannot change broadcast settings');
}));

test('issue-69-c4: while a session runs, every route that could change source/profile/encoding/delay/folder refuses visibly; camera routes stay usable', () => server(async f => {
  assert.equal((await f.put('/api/streaming/config', { enabled: true, recordingFolder: f.dir })).status, 200);
  await new Promise(r => setTimeout(r, 300));   // capture up
  const started = await f.post('/api/streaming/session', { mode: 'record' });
  assert.equal(started.status, 201, await started.clone().text());
  for (const [route, body, fields] of [
    ['/api/streaming/config', { profile: '1080p2997' }, ['profile']],
    ['/api/streaming/config', { videoBitrateKbps: 8000 }, ['videoBitrateKbps']],
    ['/api/streaming/config', { videoDelayFrames: 2 }, ['videoDelayFrames']],
    ['/api/streaming/config', { recordingFolder: os.tmpdir() }, ['recordingFolder']],
    ['/api/streaming/capture', { device: '1' }, ['device']],
    ['/api/streaming/capture', { enabled: false }, ['enabled']],
    ['/api/program', { input: 'Other Card' }, ['input']],
    ['/api/program', { kind: 'avfoundation' }, ['kind']],
  ] as const) {
    const r = await f.put(route, body);
    assert.equal(r.status, 409, `${route} ${JSON.stringify(body)}`);
    const j = await r.json(); assert.deepEqual(j.fields, fields); assert.match(j.error, /session is running/);
  }
  // Unrelated settings still save: switching the preview on, the on/off of streaming itself, capture queue tuning.
  assert.equal((await f.put('/api/program', { enabled: true })).status, 200);
  const tuned = await f.put('/api/streaming/capture', { stallMs: 3000 });
  assert.equal(tuned.status, 200); assert.equal((await tuned.json()).applied, false, 'applied with the next capture start');
  assert.equal((await fetch(f.origin + '/api/status')).status, 200);
  for (let i = 0; i < 200 && f.sessions.status()?.state === 'starting'; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(f.sessions.status()?.state, 'running', JSON.stringify(f.sessions.status()));
  assert.equal((await f.post('/api/streaming/session', { mode: 'record' })).status, 409, 'one session at a time');
  const stopped = await f.post('/api/streaming/session/stop');
  assert.equal((await stopped.json()).endReason, 'stopped');
  assert.equal((await f.put('/api/streaming/config', { videoDelayFrames: 2 })).status, 200, 'unlocked after stop');
}));

test('issue-69-c5: session start refuses clearly when it cannot run; Stream + record is not offered yet', () => server(async f => {
  let r = await f.post('/api/streaming/session', { mode: 'record' });
  assert.equal(r.status, 409); assert.equal((await r.json()).code, 'disabled');
  await f.put('/api/streaming/config', { enabled: true });
  r = await f.post('/api/streaming/session', { mode: 'record' });
  assert.equal((await r.json()).code, 'no-folder');
  await f.put('/api/streaming/config', { recordingFolder: path.join(f.dir, 'missing') });
  r = await f.post('/api/streaming/session', { mode: 'record' });
  assert.equal((await r.json()).code, 'folder-unusable');
  r = await f.post('/api/streaming/session', { mode: 'stream+record' });
  assert.equal(r.status, 501);
}));
