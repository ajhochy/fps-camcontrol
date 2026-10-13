import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import { SonyManager, SonyRetryableError } from '../../src/sony/sonyManager';
import { SonyStateStore } from '../../src/sony/sonyStateStore';
import { createStatusServer } from '../../src/ui/statusServer';
import { createInitialState } from '../../src/app/state';
import { ActivityLog } from '../../src/app/activityLog';

const bytes=Buffer.from([255,216,255,217]);
function manager() {
  let now=1000, release!:()=>void, reads=0;
  const gate=new Promise<void>(r=>release=r);
  const m=new SonyManager({enabled:true,apiUrl:'http://127.0.0.1:8181',stateFile:'/unused'},new SonyStateStore('/unused'),{
    now:()=>new Date(now),fetch:async()=>{reads++;return {ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>{await gate;now=2222;return bytes;}} as any;}
  });
  return {m,release,reads:()=>reads};
}
async function route(fake:any, action:(origin:string)=>Promise<void>) {
  const config:any={cameras:[],atem:{ip:'127.0.0.1'},graphics:{},speeds:{},mappings:{}};
  const app=createStatusServer(createInitialState(),config,undefined as any,new ActivityLog(),undefined as any,new Map(),fake);
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{await action(`http://127.0.0.1:${(server.address() as any).port}`);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
test('issue-24-c1',async()=>{const f=manager();const work=f.m.liveViewFrame('AA:BB');f.release();const frame:any=await work;assert.equal(frame.capturedAt,2222);assert.deepEqual(frame.body,bytes);});
test('issue-24-c2',async()=>route({liveViewFrame:async()=>({body:bytes,contentType:'image/jpeg',capturedAt:2222})},async origin=>{const r=await fetch(origin+'/api/sony/cameras/AA:BB/live-view/frame');assert.equal(r.headers.get('x-frame-captured-at'),'2222');assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-type')! ,/^image\/jpeg/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);}));
test('issue-24-c3',async()=>{const f=manager();const a=f.m.liveViewFrame('AA:BB'),b=f.m.liveViewFrame('AA:BB');f.release();const [x,y]:any[]=await Promise.all([a,b]);assert.equal(f.reads(),1);assert.equal(x.capturedAt,2222);assert.strictEqual(x,y);});
test('issue-24-c4',async()=>route({liveViewFrame:async()=>{throw new SonyRetryableError('Busy');}},async origin=>{const r=await fetch(origin+'/api/sony/cameras/AA:BB/live-view/frame');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'1');}));
test('issue-24-c5',()=>{const s=fs.readFileSync('src/ui/statusServer.ts','utf8');assert.match(s,/await response\.blob\(\)/);assert.match(s,/URL\.createObjectURL/);assert.equal(s.includes("response.headers.get('X-Frame-Captured-At')"),false);});
