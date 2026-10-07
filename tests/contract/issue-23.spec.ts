import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as YAML from 'yaml';
import { loadConfig, resolveProfile, saveDevicesConfig, validateDevicesConfig } from '../../src/config/configLoader';

const inventory: any = { rig: {label:'Synthetic rig',protocol:'dji-bridge',bridge:{host:'127.0.0.1',port:17879}}, other:{label:'Other',protocol:'visca',viscaIp:'127.0.0.1'} };
const base: any = {atem:{ip:'127.0.0.1',defaultTransition:'cut'},devices:inventory,profiles:{one:{slots:[{device:'rig'}]}},activeProfile:'one',sony:{enabled:false}};
function fixture(raw: any, run:(config:any, file:string)=>void, env:Record<string,string>={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'fps-tracking-config-'));
  fs.mkdirSync(path.join(home,'config'));
  const file=path.join(home,'config/devices.yaml');
  fs.writeFileSync(file,'# Tracking stays opt-in; no personal hardware IDs.\n'+YAML.stringify(raw));
  fs.writeFileSync(path.join(home,'config/speeds.json'),JSON.stringify({presets:[{name:'Normal',multiplier:1}],activePreset:0}));
  fs.writeFileSync(path.join(home,'config/mappings.yaml'),'{}\n');
  const keys=['CAMCONTROL_HOME','DEVICES_CONFIG','SPEEDS_FILE','MAPPINGS_FILE','TRACKING_ENABLED','TRACKING_SIDECAR_URL'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys) delete process.env[k]; process.env.CAMCONTROL_HOME=home; Object.assign(process.env,env);
  try { run(loadConfig(),file); } finally {for(const k of keys) {if(old[k]===undefined) delete process.env[k];else process.env[k]=old[k];}}
}
test('issue-23-c1',()=>fixture(base,c=>{assert.equal(c.tracking?.enabled,false);assert.deepEqual(c.tracking.sources,[]);assert.equal(c.cameras.length,1);}));
test('issue-23-c2',()=>{
  fixture({...base,tracking:{sources:[{device:'rig',sonyCameraId:'AA:BB'}]}},c=>{
    assert.equal(c.tracking.sidecarUrl,'ws://127.0.0.1:7900');assert.equal(c.tracking.maxSpeed,.35);assert.equal(c.tracking.deadzone,.04);assert.equal(c.tracking.lostHoldMs,3000);
    assert.equal(c.tracking.sources[0].invertPan,false);assert.equal(c.tracking.sources[0].invertTilt,false);
  });
  for(const bad of [{maxSpeed:0},{maxSpeed:1.01},{maxSpeed:Infinity},{deadzone:-1},{deadzone:.31},{lostHoldMs:-1},{sidecarUrl:'https://127.0.0.1'},{sources:[{device:'rig',sonyCameraId:'AA:BB',invertPan:1}]}]) assert.throws(()=>fixture({...base,tracking:bad},()=>{}));
});
test('issue-23-c3',()=>{
  for(const [value,want] of [['true',true],['1',true],['false',false],['0',false]] as const) fixture({...base,tracking:{enabled:!want}},c=>{assert.equal(c.tracking.enabled,want);assert.equal(c.tracking.sidecarUrl,'ws://127.0.0.1:7901');},{TRACKING_ENABLED:value,TRACKING_SIDECAR_URL:'ws://127.0.0.1:7901'});
  assert.throws(()=>fixture(base,()=>{},{TRACKING_ENABLED:'yes'}),/TRACKING_ENABLED/);
});
test('issue-23-c4',()=>{
  for(const device of ['missing','other']) assert.throws(()=>fixture({...base,tracking:{sources:[{device,sonyCameraId:'AA:BB'}]}},()=>{}),new RegExp(device));
  assert.throws(()=>fixture({...base,tracking:{sources:[{device:'rig',sonyCameraId:'AA:BB'},{device:'rig',sonyCameraId:'AA:CC'}]}},()=>{}),/duplicate|more than once/i);
});
test('issue-23-c5',()=>{
  assert.equal((resolveProfile(inventory,{slots:[{device:'rig'}]})[0] as any).deviceKey,'rig');
  fixture({atem:base.atem,cameras:[{id:'cam1',label:'Legacy',viscaIp:'127.0.0.1'}]},c=>assert.equal(c.cameras[0].deviceKey,undefined));
});
test('issue-23-c6',()=>{
  const file=path.resolve(__dirname,'../../src/tracking/sourceResolver.ts');assert.ok(fs.existsSync(file),'pure source resolver exists');
  const {resolveTrackingSources}=require(file);
  fixture({...base,tracking:{sources:[{device:'rig',sonyCameraId:'AA:BB'}]}},c=>{
    assert.equal(resolveTrackingSources(c)[0].cameraId,'cam1');c.cameras=resolveProfile(inventory,{slots:[{device:'other'}]});assert.equal(resolveTrackingSources(c)[0].cameraId,null);
    c.cameras=resolveProfile(inventory,{slots:[{device:'other'},{device:'rig'}]});assert.equal(resolveTrackingSources(c)[0].cameraId,'cam2');assert.equal(resolveTrackingSources(c)[0].sourceId,'rig');
  });
});
test('issue-23-c7',()=>fixture({...base,tracking:{enabled:false,sources:[{device:'rig',sonyCameraId:'AA:BB'}]},extension:{preserve:true}},(c,file)=>{
  assert.ok(c.tracking,'tracking parsed before save');
  saveDevicesConfig(validateDevicesConfig({atem:c.atem,cameras:c.cameras.map((x:any)=>({...x,label:'New'})),graphics:c.graphics}));
  const text=fs.readFileSync(file,'utf8');assert.match(text,/# Tracking stays opt-in/);assert.equal(YAML.parse(text).extension.preserve,true);assert.equal(YAML.parse(text).tracking.sources[0].device,'rig');
}));
