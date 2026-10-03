import assert from 'node:assert/strict';
import type { AppConfig } from '../config/configLoader';
import { sonyZoomSpeed, zoomTarget } from '../model/zoomTarget';

const devices = {
  vbot: { protocol: 'visca' }, birddog: { protocol: 'visca' },
  sonyA: { protocol: 'sony', sonyCameraId: 'AA:01' }, sonyNoId: { protocol: 'sony' },
};
const config = (cameras: unknown[]) => ({ cameras, devices } as unknown as AppConfig);
const connected = (...ids: string[]) => ({ connected: (id: string) => ids.includes(id) });

// Sony bound + connected => the camera zooms
assert.deepEqual(zoomTarget('cam1', config([{ id: 'cam1', camera: 'sonyA' }]), connected('AA:01')), { kind: 'sony', sonyId: 'AA:01' });
// bound but disconnected => head
assert.deepEqual(zoomTarget('cam1', config([{ id: 'cam1', camera: 'sonyA' }]), connected()), { kind: 'head' });
// `zoom: head` opt-out => head
assert.deepEqual(zoomTarget('cam1', config([{ id: 'cam1', camera: 'sonyA', zoom: 'head' }]), connected('AA:01')), { kind: 'head' });
// no Sony on the rig, a Sony device with no camera id, no Sony manager, unknown rig => head
assert.deepEqual(zoomTarget('cam2', config([{ id: 'cam2' }]), connected('AA:01')), { kind: 'head' });
assert.deepEqual(zoomTarget('cam1', config([{ id: 'cam1', camera: 'sonyNoId' }]), connected('AA:01')), { kind: 'head' });
assert.deepEqual(zoomTarget('cam1', config([{ id: 'cam1', camera: 'sonyA' }]), null), { kind: 'head' });
assert.deepEqual(zoomTarget('cam9', config([{ id: 'cam1', camera: 'sonyA' }]), connected('AA:01')), { kind: 'head' });

// speed mapping: only 0 is 0, the smallest movement is 1, full is 10, clamped
assert.equal(sonyZoomSpeed(0), 0);
assert.equal(sonyZoomSpeed(0.04), 1);
assert.equal(sonyZoomSpeed(-0.04), -1);
assert.equal(sonyZoomSpeed(0.5), 5);
assert.equal(sonyZoomSpeed(1), 10);
assert.equal(sonyZoomSpeed(-1), -10);
assert.equal(sonyZoomSpeed(3), 10);
assert.equal(sonyZoomSpeed(Number.NaN), 0);
console.log('zoomTargetTest passed');
