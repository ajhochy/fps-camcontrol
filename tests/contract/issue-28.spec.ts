import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createStatusServer } from '../../src/ui/statusServer';
import { createInitialState } from '../../src/app/state';
import { ActivityLog } from '../../src/app/activityLog';
import { EventEmitter } from 'node:events';
import { TrackingManager } from '../../src/tracking/trackingManager';
import { TrackingSchema } from '../../src/tracking/configSchema';
import { MotionLedger } from '../../src/tracking/motionLedger';
import { resolveTrackingSources } from '../../src/tracking/sourceResolver';

async function fixture(run:(f:any)=>Promise<void>) {
  const state=createInitialState();
  let stopped=0,selected=0;
  const config:any={cameras:[{id:'cam1',deviceKey:'rig'}],atem:{ip:'127.0.0.1'},graphics:{},mappings:{},speeds:{},tracking:TrackingSchema.parse({enabled:true,sources:[{device:'rig',sonyCameraId:'AA:BB'}]})};
  const device:any={protocol:'dji-bridge',connected:true,gimbalAttached:true,stop:()=>stopped++,setPanTilt:()=>{}};
  const client:any=Object.assign(new EventEmitter(),{connected:true,start:()=>{},stop:()=>{},select:()=>{selected++;return true;},cancel:()=>true});
  const ledger=new MotionLedger();
  const manager=new TrackingManager({config:config.tracking,sources:resolveTrackingSources(config),devices:new Map([['cam1',device]]),client,ledger,setInterval:()=>0,clearInterval:()=>{}});
  manager.start();
  const app=(createStatusServer as any)(state,config,undefined,new ActivityLog(),undefined,new Map(),undefined,()=>({manager,client,ledger}));
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  const post=(action:string,body:any)=>fetch(origin+'/api/tracking/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{await run({state,manager,config,origin,post,stopped:()=>stopped,selected:()=>selected,disconnect:()=>device.connected=false});}finally{manager.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
test('issue-28-c1',()=>fixture(async f=>{
  for(const body of [{},{sourceId:'rig',x:-1,y:.5},{sourceId:'rig',x:'0.5',y:.5},{sourceId:'rig',x:.5,y:2},{sourceId:'rig',x:.5,y:.5,extra:true}])assert.equal((await f.post('select',body)).status,400);
  assert.equal((await f.post('select',{sourceId:'unknown',x:.5,y:.5})).status,404);
  f.config.tracking.enabled=false;assert.equal((await f.post('select',{sourceId:'rig',x:.5,y:.5})).status,409);
  f.config.tracking.enabled=true;f.config.cameras=[];assert.equal((await f.post('select',{sourceId:'rig',x:.5,y:.5})).status,409);
}));
test('issue-28-c2',()=>fixture(async f=>{f.disconnect();assert.equal((await f.post('select',{sourceId:'rig',x:.5,y:.5})).status,409);assert.equal(f.selected(),0);}));
test('issue-28-c3',()=>fixture(async f=>{for(let i=0;i<2;i++)assert.equal((await f.post('cancel',{sourceId:'rig'})).status,200);assert.equal(f.stopped(),2);}));
test('issue-28-c4',()=>fixture(async f=>{const r=await fetch(f.origin+'/api/status');const s=await r.json();for(const [key,value]of Object.entries(f.state))assert.deepEqual(s[key],value);const tracking=await fetch(f.origin+'/api/tracking/status').then(r=>r.json());assert.equal(tracking.enabled,true);assert.equal(tracking.sidecar.state,'connected');assert.equal(tracking.sources[0].sourceId,'rig');assert.equal('observation'in tracking.sources[0],false);}));
test('issue-28-c5',()=>fixture(async f=>{const start=Date.now();assert.equal((await f.post('select',{sourceId:'rig',x:.5,y:.5})).status,200);assert.equal(f.selected(),1);assert.ok(Date.now()-start<500);}));
test('issue-28-c6',()=>fixture(async f=>{const body={sourceId:'rig',x:.5,y:.5};assert.equal((await f.post('select',body)).status,200);assert.equal((await f.post('select',body)).status,429);assert.equal(f.selected(),1);}));
