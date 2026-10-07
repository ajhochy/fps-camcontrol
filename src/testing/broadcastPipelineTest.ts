import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { ffmpeg, ffprobe, probeFile, decodeFile, runtimeProbe } from '../broadcast/runtimeProbe';
import { MediaProcess, syntheticPipeline, runMedia, stopOwned, ownedPids } from '../broadcast/mediaProcess';
import { frameRate, rtmpUrl } from '../broadcast/ffmpegArgs';
import { MAX_SUBSCRIBER_BYTES } from '../broadcast/tsRelay';
import { probeOffset } from '../broadcast/avOffsetProbe';

const root = path.resolve(process.env.BROADCAST_EVIDENCE_ROOT || 'dist/broadcast-evidence/pipeline');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence: any = { started: new Date().toISOString(), status: 'RUNNING', developerOnly: true, cases: [] };
async function persist() { await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
// Regression: successful decode can hide an initial GOP discarded by advanced edit lists.
type Box = { type: string; start: number; end: number; payload: number; children: Box[] };
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  while (start + 8 <= end) {
    let size = bytes.readUInt32BE(start), header = 8;
    if (size === 1) { if (start + 16 > end) break; size = Number(bytes.readBigUInt64BE(start + 8)); header = 16; }
    if (size === 0) break; // An unfinished open-ended mdat is not completed persisted media.
    if (size < header || start + size > end) break;
    const type = bytes.toString('ascii', start + 4, start + 8), payload = start + header;
    result.push({ type, start, end: start + size, payload, children: ['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf'].includes(type) ? boxes(bytes, payload, start + size) : [] });
    start += size;
  }
  return result;
}
function descendants(items: Box[], type: string): Box[] {
  return items.flatMap(item => [...(item.type === type ? [item] : []), ...descendants(item.children, type)]);
}
function persistedMedia(bytes: Buffer) {
  const atoms = boxes(bytes), samples: Record<string, number> = {}, tracks: Record<number, string> = {};
  for (const trak of descendants(atoms.filter(b => b.type === 'moov'), 'trak')) {
    const tkhd = descendants([trak], 'tkhd')[0], hdlr = descendants([trak], 'hdlr')[0];
    const id = bytes.readUInt32BE(tkhd.payload + (bytes[tkhd.payload] === 1 ? 20 : 12));
    const kind = bytes.toString('ascii', hdlr.payload + 8, hdlr.payload + 12); tracks[id] = kind;
    samples[kind] = descendants([trak], 'stsz').reduce((n, b) => n + bytes.readUInt32BE(b.payload + 8), 0);
  }
  let fragments = 0;
  for (let i = 0; i < atoms.length - 1; i++) if (atoms[i].type === 'moof' && atoms[i + 1].type === 'mdat') {
    fragments++;
    for (const traf of descendants([atoms[i]], 'traf')) {
      const tfhd = descendants([traf], 'tfhd')[0], kind = tracks[bytes.readUInt32BE(tfhd.payload + 4)];
      assert.ok(kind, 'Fragment track must have persisted initialization');
      samples[kind] += descendants([traf], 'trun').reduce((n, b) => n + bytes.readUInt32BE(b.payload + 4), 0);
    }
  }
  return { bytes: bytes.length, atoms: atoms.map(({ type, start, end }) => ({ type, start, end })), samples, fragments,
    ready: atoms.some(b => b.type === 'moov') && fragments > 0 && samples.vide > 0 && samples.soun > 0 };
}
async function packets(file: string, interrupted = false) {
  const result = await runMedia(ffprobe, ['-v', 'error', ...(interrupted ? ['-advanced_editlist', '0'] : []), '-show_packets', '-show_entries', 'packet=codec_type,pts_time,flags', '-of', 'json', file]);
  return JSON.parse(result.stdout.toString()).packets as any[];
}
async function recoverAndCheck(interrupted: string, recovered: string) {
  assert.notEqual(interrupted, recovered);
  const original = await readFile(interrupted), sha = createHash('sha256').update(original).digest('hex');
  const media = persistedMedia(original);
  if (!media.ready) {
    assert.equal(createHash('sha256').update(await readFile(interrupted)).digest('hex'), sha);
    assert.equal(await readFile(recovered).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
    return { status: 'NO_RECOVERABLE_MEDIA', original: interrupted, sha256Unchanged: sha, media };
  }
  try {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-advanced_editlist', '0', '-i', interrupted, '-c', 'copy', '-y', recovered];
    const remux = await runMedia(ffmpeg, args);
    const before = await packets(interrupted, true), after = await packets(recovered);
    const counts = await runMedia(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', recovered]);
    for (const [kind, type] of [['vide', 'video'], ['soun', 'audio']]) {
      const source = before.filter(p => p.codec_type === type), target = after.filter(p => p.codec_type === type);
      assert.equal(source.length, media.samples[kind]); assert.equal(target.length, media.samples[kind], `Recovery dropped persisted ${type} samples`);
      assert.equal(Number(JSON.parse(counts.stdout.toString()).streams.find((s: any) => s.codec_type === type).nb_read_frames), media.samples[kind]);
      for (let i = 1; i < target.length; i++) assert.ok(Math.abs((Number(target[i].pts_time) - Number(target[i - 1].pts_time)) - (Number(source[i].pts_time) - Number(source[i - 1].pts_time))) < 0.0001, 'Recovery cadence hole');
    }
    assert.ok(after.find(p => p.codec_type === 'video').flags.includes('K'));
    const origin = (items: any[]) => Number(items.find(p => p.codec_type === 'video').pts_time) - Number(items.find(p => p.codec_type === 'audio').pts_time);
    assert.ok(Math.abs(origin(before) - origin(after)) < 0.0001, 'Recovery changed relative A/V origin');
    const decodePid = await decodeFile(recovered);
    return { status: 'RECOVERED', original: interrupted, recovered, sha256Unchanged: sha, media, args, remux, decodePid, counts: JSON.parse(counts.stdout.toString()), avOrigin: origin(after) };
  } finally { assert.equal(createHash('sha256').update(await readFile(interrupted)).digest('hex'), sha); }
}
async function inspect(file: string, fps: string, delay: number) {
  const metadata = await probeFile(file);
  const video = metadata.streams.find((s: any) => s.codec_type === 'video');
  const audio = metadata.streams.find((s: any) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.width, 1280); assert.equal(video.height, 720);
  assert.equal(video.has_b_frames, 0); assert.equal(video.r_frame_rate, fps);
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2);
  const frames = await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames', '-show_entries', 'frame=key_frame,best_effort_timestamp_time', '-of', 'json', file], 120000);
  const keys = JSON.parse(frames.stdout.toString()).frames;
  assert.ok(keys.length >= 3);
  for (let i = 1; i < keys.length; i++) assert.ok(Number(keys[i].best_effort_timestamp_time) - Number(keys[i - 1].best_effort_timestamp_time) <= 2 + 1 / frameRate(fps));
  const first = await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-of', 'json', file]);
  assert.equal(JSON.parse(first.stdout.toString()).frames[0].key_frame, 1);
  const decodePid = await decodeFile(file);
  const offset = await probeOffset(ffmpeg, file, fps, delay);
  return { file, metadata, keys, decodePid, offset };
}
async function runCase(fps: string, delay: number, seconds: number, failure = false) {
  const directory = path.join(root, `${fps.replace('/', '-')}-${delay}-${seconds}`); await mkdir(directory, { recursive: true });
  const received = path.join(directory, 'received.flv');
  const listener = new MediaProcess(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'warning', '-listen', '1', '-timeout', '10', '-i', rtmpUrl(), '-c', 'copy', '-f', 'flv', '-y', received], (seconds + 30) * 1000);
  await sleep(600);
  const pipeline = syntheticPipeline(ffmpeg, { width: 1280, height: 720, fps, delayFrames: delay, seconds });
  const recording = path.join(directory, 'recording.mp4');
  const recorder = pipeline.attach(recording, 'mp4');
  const publisher = pipeline.attach(rtmpUrl(), 'flv');
  const interrupted = path.join(directory, 'interrupted.mp4');
  const crashRecorder = failure ? pipeline.attach(interrupted, 'mp4') : undefined;
  const stalled = new PassThrough({ highWaterMark: 188 }); stalled.on('error', () => {});
  if (failure && seconds >= 45) pipeline.relay.subscribe(stalled);
  let peakQueued = 0;
  const rss: number[] = [];
  const sample = setInterval(() => {
    peakQueued = Math.max(peakQueued, pipeline.relay.bufferedBytes);
    const pids = ownedPids();
    if (pids.length) {
      try { const values = execFileSync('/bin/ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split(/\s+/).map(Number); rss.push(process.memoryUsage().rss + values.reduce((a, b) => a + b * 1024, 0)); } catch { /* An owned process may have just exited. */ }
    }
  }, 1000);
  try {
    await sleep(2500);
    const latePath = path.join(directory, 'late.mp4'); const late = pipeline.attach(latePath, 'mp4');
    await sleep(4000);
    const reconnectedPath = path.join(directory, 'reconnected.mp4'); const reconnectAt = Date.now();
    const reconnected = pipeline.attach(reconnectedPath, 'mp4');
    if (crashRecorder) {
      const deadline = Date.now() + 12000, growth = [];
      let media;
      do {
        const bytes = await readFile(interrupted).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
        media = persistedMedia(bytes); growth.push({ at: new Date().toISOString(), ...media });
        if (media.ready) break;
        await sleep(100);
      } while (Date.now() < deadline);
      evidence.crash = { pid: crashRecorder.child.pid, growth, stderr: crashRecorder.stderr.toString() }; await persist();
      assert.ok(media?.ready, 'Deadline: no complete persisted MP4 media before intentional crash');
      // Retain several complete GOPs for begin/middle/end content qualification, not just decode.
      await sleep(4000);
      crashRecorder.kill(); evidence.crash.result = await crashRecorder.done; await persist();
      assert.equal(evidence.crash.result.signal, 'SIGKILL');
    }
    const encode = await pipeline.encoder.done; assert.equal(encode.code, 0, encode.stderr);
    const results = await Promise.all([recorder.done, publisher.done, listener.done, late.done, reconnected.done]);
    for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.ok(result.pid > 0); assert.ok(Buffer.byteLength(result.stderr) <= 8192); }
    assert.ok(peakQueued <= MAX_SUBSCRIBER_BYTES + 1024 * 1024, `Unexpected aggregate relay queues ${peakQueued}`);
    if (failure && seconds >= 45) assert.ok(stalled.destroyed, 'Stalled output must hit actual 16MiB bound');
    const outputs = [];
    for (const file of [recording, latePath, reconnectedPath, received]) outputs.push(await inspect(file, fps, delay));
    const eof = persistedMedia(await readFile(recording));
    assert.ok(eof.atoms.some(b => b.type === 'moov') && eof.atoms.some(b => b.type === 'mdat'));
    assert.equal(eof.fragments, 0, 'Normal EOF must finalize regular MP4');
    assert.equal(descendants(boxes(await readFile(recording)), 'moof').length, 0);
    const reconnectDuration = Number(outputs[2].metadata.format.duration);
    const reconnectWall = (Date.now() - reconnectAt) / 1000;
    assert.ok(reconnectDuration < seconds - 6, 'Reconnect replayed backlog');
    assert.ok(reconnectDuration <= reconnectWall + 1);
    let recovery;
    if (failure) {
      const recovered = path.join(directory, 'recovered.mp4');
      recovery = await recoverAndCheck(interrupted, recovered);
      assert.equal(recovery.status, 'RECOVERED');
      recovery = { ...recovery, offset: await probeOffset(ffmpeg, recovered, fps, delay) };
    }
    // Exclude startup growth; aggregate Node + all actual owned FFmpeg processes, not unrelated system processes.
    const steady = rss.slice(10, -5);
    const rssGrowth = steady.length > 1 ? steady[steady.length - 1] - steady[0] : 0;
    if (seconds >= 3600) {
      assert.ok(rssGrowth < 50 * 1024 * 1024, `RSS growth ${rssGrowth}`);
      const pairs = outputs[0].offset.pairs;
      assert.ok(Math.abs(pairs[2].offset - pairs[0].offset) < 1 / frameRate(fps), 'Content drift exceeds one frame');
    }
    const result = { fps, delay, seconds, encode, results, outputs, peakQueued, rss, rssGrowth, reconnectDuration, reconnectWall, recovery };
    evidence.cases.push(result); await persist();
    console.log(`PASS real ${fps} delay=${delay} duration=${seconds}s`);
  } finally {
    clearInterval(sample); await stopOwned(); assert.equal(ownedPids().length, 0);
    if (crashRecorder && evidence.crash) { evidence.crash.result = await crashRecorder.done; await persist(); }
  }
}
async function main() {
  await mkdir(root, { recursive: true }); await persist();
  try {
    if (process.argv.includes('--recovery-contract')) {
      const file = path.resolve('docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/flush-completed-fragment.mp4');
      const media = persistedMedia(await readFile(file));
      assert.deepEqual(media.samples, { vide: 100, soun: 189 });
      evidence.recovery = await recoverAndCheck(file, path.join(root, 'contract-recovered.mp4'));
      assert.equal(evidence.recovery.status, 'RECOVERED');
      const empty = path.resolve('docs/ai/runs/artifacts/s1-mp4-repair-20261007-a/pre-repair-dist/pipeline/25-1-0-45/interrupted.mp4');
      assert.equal((await readFile(empty)).length, 88);
      evidence.uninitialized = await recoverAndCheck(empty, path.join(root, 'must-not-exist.mp4'));
      assert.equal(evidence.uninitialized.status, 'NO_RECOVERABLE_MEDIA');
      evidence.status = 'PASS'; return;
    }
    await runtimeProbe(path.join(root, 'capability'));
    if (process.argv.includes('--soak')) {
      const minutes = Number(process.env.BROADCAST_SOAK_MINUTES);
      assert.equal(minutes, 60, 'Acceptance soak requires explicit BROADCAST_SOAK_MINUTES=60');
      await runCase('30000/1001', 3, minutes * 60, true);
    } else if (process.argv.includes('--repair')) {
      await runCase('25/1', 0, 45, true);
    } else {
      for (const fps of ['25/1', '30000/1001', '30/1', '60000/1001', '60/1']) for (const delay of [0, 1, 3, 15]) await runCase(fps, delay, fps === '25/1' && delay === 0 ? 45 : 16, true);
    }
    evidence.status = 'PASS';
  } catch (error) { evidence.status = 'FAIL'; evidence.error = String(error); throw error; }
  finally { await stopOwned(); evidence.finished = new Date().toISOString(); await persist(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
