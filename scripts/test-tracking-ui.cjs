require('ts-node/register/transpile-only');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {createStatusServer}=require('../src/ui/statusServer');
const {createInitialState}=require('../src/app/state');
const {ActivityLog}=require('../src/app/activityLog');
const {TrackingSchema}=require('../src/tracking/configSchema');
const evidence=path.resolve('docs/ai/runs/tracking-ui-evidence',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(evidence,{recursive:true});
const config={atem:{ip:'127.0.0.1'},cameras:[],mappings:{},graphics:{},speeds:{presets:[],activePreset:0},tracking:TrackingSchema.parse({})};
const app=createStatusServer(createInitialState(),config,undefined,new ActivityLog(),undefined,new Map());
const server=http.createServer(app);
let browser,page;
const calls=[],errors=[],report={criteria:{},screenshots:[]};
const source={sourceId:'rig',sonyCameraId:'AA:BB',cameraId:'cam1',state:'idle',reason:null,sessionId:null};
let snapshot={enabled:true,sidecar:{state:'connected'},sources:[source]};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#28333b"/><rect x="240" y="100" width="120" height="270" fill="#8293a0"/><text x="20" y="35" fill="white" font-size="20">Synthetic preview</text></svg>';
async function waitState(state,reason=null) {
  source.state=state;source.reason=reason;
  await page.waitForFunction(expected=>document.querySelector('.tracking-controls')?.dataset.state===expected,state);
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  page=await browser.newPage({viewport:{width:1100,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname;
    if(route.request().method()!=='GET') {calls.push({path:p,body:route.request().postDataJSON()});return route.fulfill({json:{ok:true}});}
    if(p==='/api/tracking/status') return route.fulfill({json:snapshot});
    if(p==='/api/sony/status')return route.fulfill({json:{sidecar:{state:'healthy'},cameras:[{id:'AA:BB',name:'Synthetic test camera',state:'connected'},{id:'AA:CC',name:'Unmapped test camera',state:'connected'}]}});
    if(p.endsWith('/live-view/frame'))return route.fulfill({body:svg,contentType:'image/svg+xml'});
    if(p.endsWith('/properties'))return route.fulfill({json:{properties:{}}});
    if(p==='/api/status')return route.fulfill({json:createInitialState()});
    if(p==='/api/config')return route.fulfill({json:config});
    if(p==='/api/controllers')return route.fulfill({json:{controllers:[]}});
    if(p==='/api/profiles')return route.fulfill({json:{profiles:{},devices:{}}});
    if(p==='/api/rigs')return route.fulfill({json:{rigs:[],atem:{},devices:{},sonyDevices:[],unboundCameras:[]}});
    return route.fulfill({json:{}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('.sony-widget').first().waitFor();
  assert.ok(await page.getByRole('button',{name:'Track',exact:true}).count(),'issue-32-c1: Track control must exist');
  const widget=page.locator('.sony-widget').first();
  await widget.getByRole('button',{name:'Track',exact:true}).waitFor();
  assert.equal(await widget.getByRole('button',{name:'Focus (touch)',exact:true}).getAttribute('aria-pressed'),'true');
  report.criteria['issue-32-c1']='PASS';
  assert.equal(await page.locator('.sony-widget').nth(1).getByRole('button',{name:'Track',exact:true}).count(),0);report.criteria['issue-32-c2']='PASS';
  const image=widget.locator('.sony-preview img');
  await page.waitForFunction(()=>document.querySelector('.sony-preview img')?.naturalWidth===640);
  const box=await image.boundingBox();
  await widget.getByRole('button',{name:'Track',exact:true}).click();
  await image.click({position:{x:box.width/2,y:box.height/2}});
  assert.ok(calls.some(c=>c.path==='/api/tracking/select'&&Math.abs(c.body.x-.5)<.01&&Math.abs(c.body.y-.5)<.01));
  assert.ok(!calls.some(c=>c.path.endsWith('/touch')));await widget.getByText('Locking…',{exact:true}).waitFor();report.criteria['issue-32-c3']='PASS';
  source.sessionId='fixture';source.target={cx:.5,cy:.5,w:.25,h:.5,conf:.9};
  for(const [state,label] of [['tracking','Tracking'],['holding','Holding'],['lost','Target lost'],['sidecar_offline','Sidecar offline'],['stale','Stale video'],['operator_override','Paused — stick moved']]) {await waitState(state);await widget.getByText(label,{exact:true}).waitFor();}
  assert.equal(await widget.locator('.tracking-state').getAttribute('aria-live'),'polite');report.criteria['issue-32-c4']='PASS';
  await widget.getByRole('button',{name:'Resume',exact:true}).click();assert.ok(calls.some(c=>c.path==='/api/tracking/resume'));report.criteria['issue-32-c6']='PASS';
  await widget.getByRole('button',{name:'Stop tracking',exact:true}).click();await widget.locator('.sony-preview').focus();await page.keyboard.press('Escape');assert.equal(calls.filter(c=>c.path==='/api/tracking/cancel').length,2);report.criteria['issue-32-c5']='PASS';
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});});
  const before=await page.evaluate(()=>window.fpsTracking.pollCount);await page.waitForTimeout(700);assert.equal(await page.evaluate(()=>window.fpsTracking.pollCount),before);await page.evaluate(()=>{delete document.hidden;});report.criteria['issue-32-c7']='PASS';
  await widget.getByRole('button',{name:'Focus (touch)',exact:true}).click();await image.click({position:{x:box.width/2,y:box.height/2}});assert.ok(calls.some(c=>c.path.endsWith('/touch')));report.criteria['issue-32-c8']='PASS';
  await waitState('tracking');
  for(const [name,width,height]of [['desktop',1100,900],['tablet',820,1000],['mobile',390,844]]) {
    await page.setViewportSize({width,height});await widget.scrollIntoViewIfNeeded();
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      const shot=path.join(evidence,name+'-'+theme+'.png');await widget.screenshot({path:shot});report.screenshots.push(shot);
      assert.ok(await widget.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'widget does not overflow at '+width);
    }
  }
  report.criteria['issue-32-c9']='PASS';assert.deepEqual(errors,[]);report.pageErrors=errors;
  await page.reload();await page.getByRole('button',{name:'Focus (touch)',exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'Focus (touch)',exact:true}).first().getAttribute('aria-pressed'),'true');
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:error.message,criteria:report.criteria},null,2));}).finally(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
