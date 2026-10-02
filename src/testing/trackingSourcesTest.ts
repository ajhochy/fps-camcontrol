import assert from 'node:assert/strict';
import type { AppConfig } from '../config/configLoader';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { TrackingSchema } from '../tracking/configSchema';
import { decideTrackingLaunch, helperRestartDelay } from '../tracking/launchDecision';

const devices = {
  rs3: { protocol: 'dji-bridge' }, rs3b: { protocol: 'dji-bridge' }, rs3c: { protocol: 'dji-bridge' },
  vbot: { protocol: 'visca' },
  sonyA: { protocol: 'sony', sonyCameraId: 'AA:01' }, sonyB: { protocol: 'sony', sonyCameraId: 'AA:02' },
  sonyV: { protocol: 'sony', sonyCameraId: 'AA:03' }, sonyNoId: { protocol: 'sony' },
};
const cam = (n: number, deviceKey: string, protocol: string, camera?: string) => ({ id: `cam${n}`, deviceKey, protocol, camera });
function config(cameras: ReturnType<typeof cam>[], tracking: unknown = {}): AppConfig {
  return { cameras, devices, tracking: TrackingSchema.parse({ enabled: true, ...(tracking as object) }) } as unknown as AppConfig;
}

// gimbal + Sony => source; sourceId is the inventory key; camera slot follows the profile
let sources = resolveTrackingSources(config([cam(1, 'rs3', 'dji-bridge', 'sonyA')]));
assert.deepEqual(sources.map(s => [s.sourceId, s.sonyCameraId, s.cameraId, s.invertPan]), [['rs3', 'AA:01', 'cam1', false]]);
// gimbal without Sony, Sony without id, VISCA without Sony => none
assert.deepEqual(resolveTrackingSources(config([cam(1, 'rs3', 'dji-bridge'), cam(2, 'rs3b', 'dji-bridge', 'sonyNoId'), cam(3, 'vbot', 'visca')])), []);
// a VISCA head with a bound Sony camera is a source (driven through the dead-man VISCA driver)
assert.deepEqual(resolveTrackingSources(config([cam(3, 'vbot', 'visca', 'sonyV')])).map(s => [s.sourceId, s.sonyCameraId, s.cameraId]), [['vbot', 'AA:03', 'cam3']]);
// a device that is not in the active profile never becomes a source
assert.deepEqual(resolveTrackingSources(config([cam(1, 'rs3b', 'dji-bridge', 'sonyB')])).map(s => s.sourceId), ['rs3b']);
assert.deepEqual(resolveTrackingSources(config([])), []);
// explicit override keeps its flags (and wins over derivation), others are still derived
sources = resolveTrackingSources(config([cam(1, 'rs3', 'dji-bridge', 'sonyA'), cam(2, 'rs3b', 'dji-bridge', 'sonyB')],
  { sources: [{ sonyCameraId: 'AA:01', device: 'rs3', invertPan: true }] }));
assert.deepEqual(sources.map(s => [s.sourceId, s.invertPan, s.cameraId]), [['rs3', true, 'cam1'], ['rs3b', false, 'cam2']]);
// explicit source whose device is not in the profile stays listed but unavailable
sources = resolveTrackingSources(config([], { sources: [{ sonyCameraId: 'AA:01', device: 'rs3' }] }));
assert.deepEqual(sources.map(s => [s.sourceId, s.cameraId]), [['rs3', null]]);
// a Sony camera claimed by an explicit entry is never derived onto a second gimbal
sources = resolveTrackingSources(config([cam(1, 'rs3', 'dji-bridge', 'sonyB'), cam(2, 'rs3b', 'dji-bridge', 'sonyA')],
  { sources: [{ sonyCameraId: 'aa:01', device: 'rs3' }] }));
assert.deepEqual(sources.map(s => s.sourceId), ['rs3']);
// autoSources:false => only the explicit list
assert.deepEqual(resolveTrackingSources(config([cam(1, 'rs3', 'dji-bridge', 'sonyA')], { autoSources: false })), []);
assert.equal(TrackingSchema.parse({}).autoSources, true);

// launch decision
const root = '/repo';
const files = new Set(['/repo/dist/tracking-runtime/python/bin/python3', '/repo/dist/tracking-runtime/models/object_detection_yolox_2022nov.onnx', '/repo/tracker-sidecar/main.py']);
const decide = (env: Record<string, string>, enabled = true, present = files, paused = false) =>
  decideTrackingLaunch({ enabled, paused, env, repoRoot: root, isFile: f => present.has(f) });
assert.equal(decide({}, false).mode, 'off');
assert.equal(decide({}, true, files, true).mode, 'off');
const owned = decide({});
assert.equal(owned.mode, 'owned');
assert.equal(owned.mode === 'owned' && owned.paths?.python, '/repo/dist/tracking-runtime/python/bin/python3');
assert.equal(owned.mode === 'owned' && owned.paths?.script, '/repo/tracker-sidecar/main.py');
assert.equal(decide({ TRACKER_WS_TOKEN: 'x'.repeat(40) }).mode, 'developer');
const missing = decide({}, true, new Set());
assert.equal(missing.mode, 'unavailable');
assert.match(missing.mode === 'unavailable' ? missing.reason : '', /not staged/);
assert.equal(decide({}, true, new Set(['/repo/dist/tracking-runtime/python/bin/python3'])).mode, 'unavailable');
assert.equal(decide({}, true, new Set([...files].filter(f => f.endsWith('main.py')))).mode, 'unavailable');
assert.equal(decide({ CAMCONTROL_EMBEDDED: '1', CAMCONTROL_TRACKING_AVAILABLE: '1' }).mode, 'owned');
assert.deepEqual(decide({ CAMCONTROL_EMBEDDED: '1', CAMCONTROL_TRACKING_AVAILABLE: '1' }), { mode: 'owned' });
assert.equal(decide({ CAMCONTROL_EMBEDDED: '1' }).mode, 'unavailable');
// packaged never honours a developer token
assert.equal(decide({ CAMCONTROL_EMBEDDED: '1', CAMCONTROL_TRACKING_AVAILABLE: '1', TRACKER_WS_TOKEN: 'y'.repeat(40) }).mode, 'owned');
// restart backoff grows and is capped
assert.deepEqual([0, 1, 2, 3, 4, 9].map(helperRestartDelay), [1000, 2000, 5000, 10000, 30000, 30000]);
console.log('trackingSourcesTest passed');
