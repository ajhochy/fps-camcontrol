import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToTracker, safeFrameUrl } from '../../src/tracking/protocol';
import { TrackingSchema } from '../../src/tracking/configSchema';
test('TS source validation matches Python safe decoded camera IDs and unique frame URLs',()=>{
  const frameUrl='http://127.0.0.1:8080/api/sony/cameras/AA%3ABB/live-view/frame';
  assert.ok(safeFrameUrl(frameUrl));
  for(const id of ['%2Fetc','%0Asecret','%ZZ','x'.repeat(129)])assert.equal(safeFrameUrl('http://127.0.0.1:8080/api/sony/cameras/'+id+'/live-view/frame'),false);
  assert.equal(parseToTracker({protocol:1,type:'configure',sources:[{sourceId:'a',frameUrl},{sourceId:'b',frameUrl}]}),null);
  assert.equal(parseToTracker({protocol:1,type:'ping',nonce:'bad\nnonce'}),null);
});
test('sidecar configuration rejects URL queries that the client cannot use',()=>{
  assert.equal(TrackingSchema.safeParse({sidecarUrl:'ws://127.0.0.1:7900/?token=bad'}).success,false);
  assert.equal(TrackingSchema.safeParse({sources:[{device:'rig\n1',sonyCameraId:'AA:BB'}]}).success,false);
});
