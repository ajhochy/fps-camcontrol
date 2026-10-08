import test from 'node:test';
import assert from 'node:assert/strict';
import { SidecarProcess } from '../../src/tracking/sidecarProcess';
import { startTrackingRuntime } from '../../src/app/trackingRuntime';
import { trackingFor } from '../../src/app/trackingHooks';
import { createInitialState } from '../../src/app/state';
test('failure after owned helper readiness still reaps helper and unregisters capabilities',async()=>{
  const originalStart=SidecarProcess.prototype.start,originalStop=SidecarProcess.prototype.stop;
  const embedded=process.env.CAMCONTROL_EMBEDDED,available=process.env.CAMCONTROL_TRACKING_AVAILABLE;
  let starts=0,stops=0;
  SidecarProcess.prototype.start=async()=>{starts++;return {url:'ws://127.0.0.1:1',token:'fake-only'};};
  SidecarProcess.prototype.stop=async()=>{stops++;};
  process.env.CAMCONTROL_EMBEDDED='1';process.env.CAMCONTROL_TRACKING_AVAILABLE='1';
  const state=createInitialState();
  try {
    // Intentionally bypass config parsing to force a post-start protocol failure.
    const config:any={cameras:[],tracking:{enabled:true,sidecarUrl:'ws://127.0.0.1:1',sources:[{device:'bad\nsource',sonyCameraId:'AA:BB'}]}};
    const runtime=startTrackingRuntime(state,config,new Map(),'http://127.0.0.1:8080','f'.repeat(64),false);
    await runtime.ready;assert.equal(starts,1);assert.equal(stops,1);assert.equal(trackingFor(state),undefined);
  } finally {
    SidecarProcess.prototype.start=originalStart;SidecarProcess.prototype.stop=originalStop;
    if(embedded===undefined)delete process.env.CAMCONTROL_EMBEDDED;else process.env.CAMCONTROL_EMBEDDED=embedded;
    if(available===undefined)delete process.env.CAMCONTROL_TRACKING_AVAILABLE;else process.env.CAMCONTROL_TRACKING_AVAILABLE=available;
  }
});
