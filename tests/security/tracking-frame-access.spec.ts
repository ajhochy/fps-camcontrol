import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createStatusServer } from '../../src/ui/statusServer';
import { createInitialState } from '../../src/app/state';
import { ActivityLog } from '../../src/app/activityLog';
test('frame credential grants only configured GET frame routes, never operator APIs',async()=>{
  const old=process.env.CAMCONTROL_EMBEDDED,oldToken=process.env.CAMCONTROL_SESSION;
  process.env.CAMCONTROL_EMBEDDED='1';process.env.CAMCONTROL_SESSION='operator-fixture';
  const token='f'.repeat(64),config:any={cameras:[],tracking:{enabled:true,sources:[{device:'rig',sonyCameraId:'AA:BB'}]}};
  const sony:any={liveViewFrame:async()=>({body:Buffer.from('synthetic'),contentType:'image/jpeg',capturedAt:1000})};
  const app=(createStatusServer as any)(createInitialState(),config,undefined,new ActivityLog(),undefined,new Map(),sony,undefined,{frameToken:token});
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  const request=(route:string,method='GET',headers:any={})=>fetch(origin+route,{method,headers:{Authorization:'Bearer '+token,...headers}});
  try {
    assert.equal((await request('/api/sony/cameras/AA%3ABB/live-view/frame')).status,200);
    for(const route of ['/api/status','/api/tracking/status','/api/config','/api/sony/cameras/AA%3ACC/live-view/frame'])assert.equal((await request(route)).status,403);
    assert.equal((await request('/api/sony/cameras/AA%3ABB/live-view/frame','POST')).status,403);
    assert.equal((await request('/api/sony/cameras/AA%3ABB/live-view/frame','GET',{Origin:origin})).status,403);
    assert.equal((await request('/api/sony/cameras/AA%3ABB/live-view/frame','GET',{Authorization:'Bearer wrong'})).status,403);
    assert.equal((await request('/api/sony/cameras/AA%3ABB/live-view/frame','GET',{Authorization:'Bearer '+'é'.repeat(64)})).status,403);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(old===undefined)delete process.env.CAMCONTROL_EMBEDDED;else process.env.CAMCONTROL_EMBEDDED=old;if(oldToken===undefined)delete process.env.CAMCONTROL_SESSION;else process.env.CAMCONTROL_SESSION=oldToken;}
});
