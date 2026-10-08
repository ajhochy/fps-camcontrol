const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackingController } = require('../../src/tracking/trackingController');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { TrackingManager } = require('../../src/tracking/trackingManager');
const { TrackingSchema } = require('../../src/tracking/configSchema');
const { MotionLedger } = require('../../src/tracking/motionLedger');
const { resolveTrackingSources } = require('../../src/tracking/sourceResolver');
const { createStatusServer } = require('../../src/ui/statusServer');
const { createInitialState } = require('../../src/app/state');
const { ActivityLog } = require('../../src/app/activityLog');

function fixture() {
  let now = 1000, seq = 0, stopped = 0;
  const motion = [];
  const config = { cameras:[{id:'cam1',label:'Synthetic rig',deviceKey:'rig'}], atem:{ip:'127.0.0.1'}, graphics:{}, mappings:{}, speeds:{presets:[],activePreset:0},
    tracking:TrackingSchema.parse({enabled:true,sources:[{device:'rig',sonyCameraId:'AA:BB'}]}) };
  const device = {protocol:'dji-bridge',connected:true,gimbalAttached:true,stop:()=>{stopped++;},setPanTilt:(pan,tilt)=>motion.push({pan,tilt})};
  const client = Object.assign(new EventEmitter(), {connected:true,start(){},stop(){},select(){return true;},cancel(){return true;}});
  const ledger = new MotionLedger(), sources = resolveTrackingSources(config), devices = new Map([['cam1',device]]);
  const manager = new TrackingManager({config:config.tracking,sources,devices,client,ledger,now:()=>now,setInterval:()=>0,clearInterval(){}});
  manager.start();
  const status = () => manager.getStatus().rig;
  const feed = (extra={}) => client.emit('track',{protocol:1,type:'track',sourceId:'rig',sessionId:status().sessionId,seq:++seq,state:'tracking',cx:.7,cy:.3,w:.1,h:.2,conf:.9,frameTs:now,processedAt:now,...extra});
  const select = () => { manager.select('rig',.5,.5); feed(); };
  return {manager,device,client,ledger,config,sources,devices,status,feed,select,motion,stopped:()=>stopped,advance:(ms)=>now+=ms};
}
async function serverFixture(run) {
  const f=fixture(), state=createInitialState();
  state.previewCamera=state.programCamera=state.controlledCamera='cam1';
  const app=createStatusServer(state,f.config,undefined,new ActivityLog(),undefined,f.devices,undefined,()=>({manager:f.manager,client:f.client,ledger:f.ledger}));
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  f.origin='http://127.0.0.1:'+server.address().port;
  f.post=(action,body)=>fetch(f.origin+'/api/tracking/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  f.read=()=>fetch(f.origin+'/api/tracking/status').then(r=>r.json());
  try {await run(f);} finally {f.manager.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
}

// c2/c3: fixed-center control or retained derivative history would move a composed subject.
test('Keep this framing holds an off-center anchor and follows displacement without a capture jump', () => {
  const controller = new TrackingController({ maxSpeed: .35, deadzone: .02, lostHoldMs: 1500, kp: 1, kd: .1, pipelineDelayMs: 0 });
  const observation = { cx: .7, cy: .3, w: .1, h: .2, conf: .9, frameTs: 1000, state: 'tracking' };
  assert.ok(controller.update(observation, 1000).pan > 0);
  assert.equal(typeof controller.setFraming, 'function', 'controller must support a session-local desired center');
  controller.setFraming(.7, .3);
  assert.deepEqual(controller.update({ ...observation, frameTs: 1050 }, 1050), { pan: 0, tilt: 0, state: 'tracking' });
  const moved = controller.update({ ...observation, cx: .8, cy: .4, frameTs: 1100 }, 1100);
  assert.ok(moved.pan > 0 && moved.tilt < 0);
  controller.reset();
  assert.deepEqual(controller.update({ ...observation, frameTs: 1150 }, 1150), { pan: 0, tilt: 0, state: 'tracking' }, 'ordinary Resume smoothing reset preserves framing');
});

// c1/c3: capture must consume the manager's current accepted box, not a client point or the select point.
test('c1/c3 authoritative capture resumes about both axes; ordinary Resume preserves anchor', () => {
  const f=fixture();try {
    assert.equal(typeof f.manager.holdFraming,'function','manager must expose authoritative capture');
    assert.deepEqual(f.status().framing,{cx:.5,cy:.5});f.select();f.manager.tick();assert.ok(f.motion.length);
    f.manager.operatorOverride('cam1');f.advance(50);f.feed();
    assert.equal(f.status().canHoldFraming,true);f.manager.holdFraming('rig');
    assert.equal(f.status().state,'tracking');assert.deepEqual(f.status().framing,{cx:.7,cy:.3});
    const copy=f.status();copy.framing.cx=.1;assert.equal(f.status().framing.cx,.7,'status copy cannot change anchor');
    const before=f.motion.length;f.manager.tick();assert.equal(f.motion.length,before,'capture causes no derivative/smoothing impulse');
    f.advance(50);f.feed({cx:.8,cy:.4});f.manager.tick();assert.ok(f.motion.at(-1).pan>0&&f.motion.at(-1).tilt<0);
    f.manager.operatorOverride('cam1');f.advance(50);f.feed();f.manager.resume('rig');
    assert.deepEqual(f.status().framing,{cx:.7,cy:.3});f.manager.tick();assert.equal(f.status().pan,0);assert.equal(f.status().tilt,0);
  } finally {f.manager.stop();}
});

// c1: each fixture differs in the actual safety state, with earlier guards valid.
for(const [name,alter] of Object.entries({
  stale:f=>f.advance(500), future:f=>{f.feed({frameTs:1050,processedAt:1050});f.advance(-1);},
  lost:f=>f.feed({state:'lost',conf:0,cx:0,cy:0,w:0,h:0}), locking:f=>f.feed({state:'locking',conf:0,cx:0,cy:0,w:0,h:0}),
  offline:f=>{f.client.connected=false;}, unavailable:f=>{f.device.gimbalAttached=false;},
  manual:f=>f.ledger.send(f.device,.2,0,1050), noTarget:f=>f.manager.cancel('rig'),
  wrongSession:f=>{f.manager.cancel('rig');f.advance(300);f.manager.select('rig',.5,.5);f.feed({sessionId:'00000000-0000-4000-8000-000000000000'});},
  wrongSource:f=>{f.manager.cancel('rig');f.advance(300);f.manager.select('rig',.5,.5);f.feed({sourceId:'other'});},
  estop:f=>f.manager.emergencyStop(), disabled:f=>f.manager.stop(),
})) test('c1 rejects '+name+' without anchor or motion mutation',()=>{
  const f=fixture();try {
    assert.equal(typeof f.manager.holdFraming,'function');f.select();f.manager.operatorOverride('cam1');alter(f);
    const before=f.status(), motions=f.motion.length;
    assert.equal(before.canHoldFraming,false);assert.equal(typeof before.holdFramingReason,'string');
    assert.throws(()=>f.manager.holdFraming('rig'),e=>e.statusCode===409);
    assert.deepEqual(f.status().framing,before.framing);assert.equal(f.status().state,before.state);assert.equal(f.motion.length,motions);
    if(name==='manual') {assert.throws(()=>f.manager.resume('rig'),e=>e.statusCode===409);f.ledger.stop(f.device);assert.equal(f.status().canHoldFraming,true);}
  }finally{f.manager.stop();}
});

// c4: lifecycle actions must not leak the previous person's composition into a new session.
for(const action of ['select','cancel','invalidateAll','invalidateCamera','reconcile','emergencyStop']) test('c4 '+action+' clears framing',()=>{
  const f=fixture();try {
    assert.equal(typeof f.manager.holdFraming,'function');f.select();f.manager.operatorOverride('cam1');f.manager.holdFraming('rig');
    assert.deepEqual(f.status().framing,{cx:.7,cy:.3});f.advance(300);
    if(action==='select')f.manager.select('rig',.5,.5);
    else if(action==='cancel')f.manager.cancel('rig');
    else if(action==='invalidateCamera')f.manager.invalidateCamera('cam1','test');
    else if(action==='reconcile')f.manager.reconcile(f.config.tracking,f.sources,f.devices);
    else if(action==='emergencyStop')f.manager.emergencyStop();
    else f.manager.invalidateAll('test');
    assert.deepEqual(f.status().framing,{cx:.5,cy:.5});
  }finally{f.manager.stop();}
});

// c7: actual HTTP mutation and next GET prove publication; closed body never accepts client anchors.
test('c7 API sourceId-only capture, rejection and subsequent public status',()=>serverFixture(async f=>{
  f.select();f.manager.operatorOverride('cam1');
  assert.equal((await f.read()).sources[0].holdFramingReason,null,'ready capture must not publish an unavailable reason');
  assert.equal((await f.post('hold-framing',{sourceId:'rig'})).status,200,'capture route must exist');
  const source=(await f.read()).sources[0];assert.deepEqual(source.framing,{cx:.7,cy:.3});assert.equal(source.state,'tracking');assert.equal(source.canHoldFraming,false);
  f.manager.operatorOverride('cam1');
  for(const body of [{},{sourceId:7},{sourceId:'rig',cx:.1},{sourceId:'rig',x:.1,y:.2},{sourceID:'rig'},{sourceId:'rig',anchor:{cx:.1,cy:.2}}]) {
    assert.equal((await f.post('hold-framing',body)).status,400);assert.deepEqual(f.status().framing,{cx:.7,cy:.3});assert.equal(f.status().state,'operator_override');
  }
  assert.equal((await f.post('hold-framing',{sourceId:'unknown'})).status,404);
  f.advance(500);assert.equal((await f.post('hold-framing',{sourceId:'rig'})).status,409);
  assert.equal((await f.read()).sources[0].canHoldFraming,false);
  assert.equal((await f.post('cancel',{sourceId:'rig'})).status,200);assert.deepEqual((await f.read()).sources[0].framing,{cx:.5,cy:.5});
}));

// c5: browser consumes the real manager/API on both desktop and both iPad composing panes.
test('c5 desk and iPad accessible capture/readiness/errors/resume/reset with fake boundaries only', {timeout:60000},()=>serverFixture(async f=>{
  const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path');
  const evidence=path.resolve('docs/ai/runs/keep-this-framing-evidence',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(evidence,{recursive:true});
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
   const errors=[],calls=[],keyboardEvidence=[];
   let remoteEnabled=true, pollingFailure=false;
  try {
    for(const view of ['desk','remote']) {
      const page=await browser.newPage({viewport:view==='desk'?{width:1100,height:900}:{width:1194,height:834}});
      const remoteMessages=[],focusCalls=[];
      let programLive=false,slidesSent;
      const slidesMessage=new Promise(resolve=>{slidesSent=resolve;});
      page.on('pageerror',e=>errors.push(e.message));
       page.on('request',r=>{if(r.url().endsWith('/api/tracking/hold-framing'))calls.push(r.postDataJSON());});
      // Remote websocket is an external input boundary, never used to mock tracking state.
      await page.routeWebSocket('**/ws/remote-controller',ws=>ws.onMessage(data=>{
        const message=JSON.parse(data);remoteMessages.push(message);
        if(message.t==='lowerThirds')slidesSent(message);
        ws.send(JSON.stringify({t:'welcome',enabled:remoteEnabled,owner:'none',needsPin:false}));
      }));
      await page.route('**/api/**',route=>{
        const p=new URL(route.request().url()).pathname;
         if(p==='/api/tracking/status'&&pollingFailure)return route.abort();
         if(p.startsWith('/api/tracking/'))return route.continue();
        if(p.endsWith('/touch-cancel')){
          focusCalls.push({path:p,method:route.request().method()});
          return route.fulfill({status:focusCalls.length===1?200:409,json:focusCalls.length===1?{}:{error:'Nothing to clear'}});
        }
        if(p==='/api/program/status')return route.fulfill({json:{enabled:programLive}});
        if(p==='/api/status')return route.fulfill({json:{...createInitialState(),remoteControl:{enabled:remoteEnabled},previewCamera:'cam1',programCamera:'cam1',controlledCamera:'cam1'}});
        if(p==='/api/config')return route.fulfill({json:f.config});
        if(p==='/api/rigs')return route.fulfill({json:{rigs:[{id:'cam1',camera:'sony',protocol:'dji-bridge'}],sonyDevices:[{key:'sony',sonyCameraId:'AA:BB'}],devices:{},unboundCameras:[]}});
        if(p==='/api/sony/status')return route.fulfill({json:{sidecar:{state:'healthy'},cameras:[{id:'AA:BB',name:'Synthetic camera',state:'connected'}]}});
        if(p.endsWith('/live-view/frame')||p==='/api/program/frame')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#28333b"/><rect x="416" y="96" width="64" height="96" fill="#8293a0"/></svg>'});
        if(p.endsWith('/properties'))return route.fulfill({json:{properties:{}}});
        return route.fulfill({json:{}});
      });
      f.manager.cancel('rig');f.advance(300);
      await page.goto(f.origin+(view==='desk'?'':'/remote'));
      const bars=page.locator(view==='desk'?'.tracking-controls':'.track-bar');
      await bars.first().waitFor();
       const hold=page.getByRole('button',{name:'Hold this framing',exact:true});
       assert.equal(await hold.count(),view==='desk'?1:2,'all composing views have accessible Hold this framing');
       const tabTo=async locator=>{
         for(let i=0;i<100;i++){await page.keyboard.press('Tab');if(await locator.evaluate(e=>e===document.activeElement)){
           assert.equal(await locator.evaluate(e=>e.matches(':focus-visible')&&getComputedStyle(e).outlineStyle!=='none'&&parseFloat(getComputedStyle(e).outlineWidth)>=2),true,'keyboard focus must be visible');return;
         }}assert.fail('control must be reachable with Tab');
       };
       await bars.first().getByRole('button',{name:'Track',exact:true}).click();
       if(view==='remote'){
         assert.equal(await page.locator('.track-state[aria-live="polite"]').count(),1,'same source must have only one live announcer');
         for(const button of await bars.locator('button').all())if(await button.isVisible()){
           const r=await button.boundingBox();assert.ok(r.width>=44&&r.height>=44,'remote buttons retain minimum target size');
           const pane=await button.evaluate(e=>{const r=e.closest('.pane').getBoundingClientRect();return {left:r.left,right:r.right};});assert.ok(r.x>=pane.left&&r.x+r.width<=pane.right,'Track header must not clip');
         }
       }
       const waitDisabled=async value=>page.waitForFunction(({sel,value})=>[...document.querySelectorAll(sel)].filter(b=>b.textContent==='Hold this framing').every(b=>b.disabled===value),{sel:view==='desk'?'.tracking-controls button':'.track-bar button',value});
       await waitDisabled(true);f.select();f.manager.operatorOverride('cam1');await waitDisabled(false);
       for(const bar of await bars.all()){
         for(const name of ['Hold this framing','Resume'])assert.ok(await bar.getByRole('button',{name,exact:true}).getAttribute('aria-describedby'),'Hold and Resume must describe visible status');
         assert.match(await bar.innerText(),/captures placement and resumes; Resume preserves placement/);
       }
       await page.screenshot({path:path.join(evidence,view+'-paused-ready.png'),fullPage:true});
       f.config.tracking.enabled=false;await waitDisabled(true);
       for(const bar of await bars.all())assert.equal(await bar.getByRole('button',{name:'Resume',exact:true}).isDisabled(),true);
       await page.screenshot({path:path.join(evidence,view+'-disabled.png'),fullPage:true});f.config.tracking.enabled=true;await waitDisabled(false);
       if(view==='remote'){remoteEnabled=false;await waitDisabled(true);await page.getByText(/Remote control.*off/i).first().waitFor();await page.screenshot({path:path.join(evidence,'remote-control-off.png'),fullPage:true});remoteEnabled=true;await waitDisabled(false);}
       pollingFailure=true;await waitDisabled(true);
       assert.equal(await bars.first().getByRole('button',{name:'Resume',exact:true}).isDisabled(),true,'poll failure must clear cached Resume readiness');
       await page.screenshot({path:path.join(evidence,view+'-poll-failure.png'),fullPage:true});
       pollingFailure=false;await waitDisabled(false);
      assert.equal(f.ledger.send(f.device,.2,0,f.advance(50)),true,'manual motion must really acquire the shared ledger');await waitDisabled(true);f.ledger.stop(f.device);await waitDisabled(false);
      // Race between rendered readiness and backend mutation: API, not UI, rejects stale capture.
      const rejected=page.waitForResponse(r=>r.url().endsWith('/api/tracking/hold-framing')&&r.request().method()==='POST');
      f.advance(500);await hold.first().click();
      assert.equal((await rejected).status(),409);
      await page.getByText(/fresh healthy target/i).first().waitFor();assert.equal(f.status().state,'operator_override');
       f.feed();await waitDisabled(false);
       await page.waitForFunction(sel=>[...document.querySelectorAll(sel)].every(el=>el.textContent.includes('captures placement and resumes; Resume preserves placement')),view==='desk'?'.tracking-state':'.track-state');
       if(view==='remote')await page.waitForFunction(()=>document.getElementById('banner').hidden||!document.getElementById('banner').textContent.includes('Tracking:'));
       await tabTo(hold.first());
       await page.screenshot({path:path.join(evidence,view+'-keyboard-hold.png'),fullPage:true});await page.keyboard.press('Enter');
       keyboardEvidence.push(view+' Hold uses Tab / Enter with visible focus');
       await page.waitForFunction(sel=>[...document.querySelectorAll(sel)].every(el=>el.textContent.includes('Framing held')),view==='desk'?'.tracking-state':'.track-state');
       assert.deepEqual(f.status().framing,{cx:.7,cy:.3});assert.equal(f.status().state,'tracking');await waitDisabled(true);
       if(view==='remote')await page.waitForFunction(()=>document.getElementById('banner').hidden||!document.getElementById('banner').textContent.includes('Tracking:'));
      await page.screenshot({path:path.join(evidence,view+'-held.png'),fullPage:true});
      f.manager.operatorOverride('cam1');await waitDisabled(false);
       const resume=bars.first().getByRole('button',{name:'Resume',exact:true});await tabTo(resume);
       await page.screenshot({path:path.join(evidence,view+'-keyboard-resume.png'),fullPage:true});await page.keyboard.press('Enter');
       keyboardEvidence.push(view+' Resume uses Tab / Enter with visible focus');
      await waitDisabled(true);assert.deepEqual(f.status().framing,{cx:.7,cy:.3});
      f.manager.operatorOverride('cam1');f.feed({state:'lost',conf:0,cx:0,cy:0,w:0,h:0});await waitDisabled(true);
       f.feed();await waitDisabled(false);f.client.connected=false;await waitDisabled(true);
       assert.equal(await bars.first().getByRole('button',{name:'Resume',exact:true}).isDisabled(),true,'Resume must not retain readiness while sidecar is offline');
       f.client.connected=true;
       f.manager.cancel('rig');
       const reset=(await f.read()).sources[0];assert.deepEqual(reset.framing,{cx:.5,cy:.5});assert.equal(reset.sessionId,null);assert.equal(reset.target,undefined);
       await page.waitForFunction(view=>{
         const states=[...document.querySelectorAll(view==='desk'?'.tracking-state':'.track-state')];
         const boxes=[...document.querySelectorAll(view==='desk'?'.tracking-box':'.track-box')];
         const bars=[...document.querySelectorAll(view==='desk'?'.tracking-controls':'.track-bar')];
         return states.length===(view==='desk'?1:2)&&states.every(s=>s.textContent.includes('Choose a person')&&!s.textContent.includes('Framing held'))&&boxes.every(b=>view==='desk'?b.hidden:!b.classList.contains('on'))&&bars.every(b=>[...b.querySelectorAll('button')].filter(x=>/^(Resume|Stop|Stop tracking)$/.test(x.textContent)).every(x=>x.hidden));
       },view);
       await waitDisabled(true);
       if(view==='remote')await page.waitForFunction(()=>document.getElementById('banner').hidden||!document.getElementById('banner').textContent.includes('Tracking:'));
      await page.screenshot({path:path.join(evidence,view+'-reset.png'),fullPage:true});
      if(view==='remote'){
        // Clear focus must survive the framing header, encode the Sony id, and treat 409 as non-error feedback.
        await page.waitForFunction(()=>document.getElementById('ownerPill').getAttribute('aria-label')==='Desk has control'&&!document.getElementById('claimBtn').disabled);
        const before=(await f.read()).sources[0];
        for(const [pane,feedback] of [['pvw','Focus point cleared'],['pgm','Nothing to clear']]){
          const clear=page.locator('#pane-'+pane).getByRole('button',{name:'Clear focus point',exact:true});
          await clear.waitFor();await clear.click();
          await page.waitForFunction(text=>{const b=document.getElementById('banner');return !b.hidden&&b.textContent===text;},feedback);
          assert.equal(await page.locator('#banner').isVisible(),true);
          assert.equal(await page.locator('#banner').evaluate(b=>b.classList.contains('bad')),false);
          assert.deepEqual((await f.read()).sources[0],before,'Clear focus must not mutate the tracking source');
        }
        assert.deepEqual(focusCalls,[{path:'/api/sony/cameras/AA%3ABB/touch-cancel',method:'POST'},{path:'/api/sony/cameras/AA%3ABB/touch-cancel',method:'POST'}]);
        // Slides must not acquire the camera seat or accidentally issue a tracking command.
        assert.equal(await page.getByRole('button',{name:'Take control',exact:true}).isVisible(),true);
        await page.locator('#ltBtn').click();
        assert.deepEqual(await Promise.race([slidesMessage,new Promise((_,reject)=>{setTimeout(()=>reject(new Error('Slides must send lowerThirds within 5 seconds')),5000).unref();})]),{t:'lowerThirds'});
        assert.deepEqual(remoteMessages.filter(m=>m.t==='lowerThirds'),[{t:'lowerThirds'}]);
        assert.equal(remoteMessages.some(m=>m.t==='claim'),false);
        assert.deepEqual((await f.read()).sources[0],before,'Slides must preserve the tracking source');
        // A real rendered program-feed PGM must exclude Clear focus while PVW remains a Sony view.
        programLive=true;await page.reload();
        await page.locator('#pane-pgm img[alt="Program output"]').waitFor();
        await page.waitForFunction(()=>document.querySelector('#pane-pgm .clear-focus').hidden&&!document.querySelector('#pane-pvw .clear-focus').hidden);
        assert.equal(await page.locator('#pane-pgm').getByRole('button',{name:'Clear focus point',exact:true}).count(),0);
        assert.equal(await page.locator('#pane-pvw').getByRole('button',{name:'Clear focus point',exact:true}).isVisible(),true);
        assert.equal(focusCalls.length,2);assert.deepEqual((await f.read()).sources[0],before);
      }
      await page.close();
    }
    assert.deepEqual(errors,[]);assert.equal(calls.length,4);for(const body of calls)assert.deepEqual(body,{sourceId:'rig'});
     const sourceHashes=Object.fromEntries(['ui/tracking/tracking.js','ui/remote/remote.js','ui/remote/remote.css','ui/remote/index.html','src/ui/statusServer.ts','tests/tracking/keep-this-framing.test.cjs'].map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
     fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({fakeOnly:true,criteria:['c1','c3','c4','c5','c7'],sourceHashes,calls,keyboardEvidence,selectionWaiver:'AJ explicitly excludes inherited keyboard target selection; not an accessibility PASS',reset:'next real public GET and exact DOM reset on desk/PVW/PGM',pageErrors:errors,screenshots:fs.readdirSync(evidence).filter(n=>n.endsWith('.png'))},null,2));
  }finally{await browser.close();}
}));
