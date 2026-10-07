import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../../src/app/state';
import { registerTracking, unregisterTracking } from '../../src/app/trackingHooks';
import { TrackingManager } from '../../src/tracking/trackingManager';
import { MotionLedger } from '../../src/tracking/motionLedger';
import { ControlStateMachine } from '../../src/model/controlStateMachine';
import { ActivityLog } from '../../src/app/activityLog';
import { CameraSelector } from '../../src/model/cameraSelector';
import { beginCalibrationPulse } from '../../src/tracking/calibration';
const {FakeDevice,FakeClient,config:tracking,observation}=require('./helpers.cjs');

test('actual pad hook preserves other-camera tracking, same-camera override, explicit RS resume and emergency invalidation',()=>{
  const originalNow=Date.now;let now=10000;Date.now=()=>now;
  const a=new FakeDevice(),b=new FakeDevice();a.id='cam1';b.id='cam2';
  const state=createInitialState({controlledCamera:'cam1',cameraIndex:0,controllerConnected:true,speedPreset:0});
  const devices:any=new Map([['cam1',a],['cam2',b]]),client=new FakeClient(),ledger=new MotionLedger();
  const source={sourceId:'rig-one',sonyCameraId:'AA:BB',device:'rig-one',cameraId:'cam1',invertPan:false,invertTilt:false};
  const manager=new TrackingManager({config:tracking,sources:[source],devices,client,ledger,now:()=>now,setInterval:()=>0,clearInterval:()=>{}});
  const config:any={cameras:[{id:'cam1',label:'One',protocol:'dji-bridge'},{id:'cam2',label:'Two',protocol:'dji-bridge'}],mappings:{trackingToggle:'RS'},speeds:{presets:[{multiplier:1}]}};
  registerTracking(state,{manager,client,ledger});manager.start();
  const machine=new ControlStateMachine(state,config,{changePreviewInput:async()=>{}} as any,devices,new ActivityLog());
  const input=(axes:any={},buttons:any={})=>{machine.updateInput({axes,buttons,triggers:{}} as any);machine.tick();};
  try {
    manager.select(source.sourceId,.7,.3);const id=manager.getStatus()[source.sourceId].sessionId!;
    client.emit('track',observation(id,now));manager.tick();assert.equal(a.log.at(-1).type,'move');
    now+=60;input({leftStickX:1});assert.equal(state.controlledCamera,'cam2');assert.equal(a.log.filter((e:any)=>e.type==='stop').length,0,'selection alone must not interrupt autonomous other-camera tracking');
    now+=60;input({rightStickX:.5});assert.equal(manager.getStatus()[source.sourceId].state,'tracking');assert.equal(b.log.at(-1).type,'move');
    now+=60;input({}, {X:true});assert.equal(state.controlledCamera,'cam1');
    now+=60;input({rightStickX:.5});assert.equal(manager.getStatus()[source.sourceId].state,'operator_override');assert.equal(a.log.filter((e:any)=>e.type==='stop').length,1);
    now+=60;input();client.emit('track',observation(id,now,{seq:1}));manager.tick();assert.equal(a.log.at(-1).type,'stop');
    now+=60;input({}, {RS:true});assert.equal(manager.getStatus()[source.sourceId].state,'tracking');manager.tick();assert.equal(a.log.at(-1).type,'move');
    now+=60;input({}, {back:true});assert.equal(manager.getStatus()[source.sourceId].sessionId,null);client.emit('track',observation(id,now,{seq:2}));manager.tick();assert.equal(a.log.at(-1).type,'stop');
  } finally {manager.stop();unregisterTracking(state);Date.now=originalNow;}
});
test('selecting another camera cancels the outgoing calibration owner so its pump cannot replay motion',async()=>{
  const a=new FakeDevice(),b=new FakeDevice(),client=new FakeClient(),ledger=new MotionLedger();
  const state=createInitialState({controlledCamera:'cam1',cameraIndex:0});
  const devices:any=new Map([['cam1',a],['cam2',b]]);
  const source={sourceId:'rig-one',sonyCameraId:'AA:BB',device:'rig-one',cameraId:'cam1',invertPan:false,invertTilt:false};
  const manager=new TrackingManager({config:tracking,sources:[source],devices,client,ledger,setInterval:()=>0,clearInterval:()=>{}});
  manager.start();registerTracking(state,{manager,client,ledger});
  let pulse:ReturnType<typeof beginCalibrationPulse>|undefined;
  const release=manager.acquireCalibration(source.sourceId,()=>pulse?.stop());
  pulse=beginCalibrationPulse(a,ledger,{onStop:release});
  try {
    assert.equal(a.log.at(-1).type,'move');
    const selector=new CameraSelector(state,[{id:'cam1',label:'One'},{id:'cam2',label:'Two'}] as any,{} as any,devices);
    selector.selectByIndex(1);const count=a.log.length;
    await new Promise(r=>setTimeout(r,180));
    assert.equal(pulse.stopped,true);assert.equal(a.log.length,count);assert.equal(a.log.at(-1).type,'stop');
  } finally {pulse.stop();manager.stop();unregisterTracking(state);}
});
