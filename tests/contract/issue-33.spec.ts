import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as YAML from 'yaml';
import { createInitialState } from '../../src/app/state';
import { ControlStateMachine } from '../../src/model/controlStateMachine';
import { ActivityLog } from '../../src/app/activityLog';
import { loadConfig } from '../../src/config/configLoader';

function hooks() {const file=path.resolve('src/app/trackingHooks.ts');assert.ok(fs.existsSync(file),'production tracking hooks exist');return require(file);}
function fixture() {
  const state=createInitialState({controlledCamera:'cam1',controllerConnected:true,activeControllerProfile:'Virtual pad',speedPreset:0});
  const events:string[]=[];let mode='tracking';
  const manager={getStatus:()=>mode==='idle'?{}:{rig:{sourceId:'rig',cameraId:'cam1',state:mode,sessionId:'fixture'}},cancel:()=>{events.push('cancel');mode='idle';},resume:()=>{events.push('resume');mode='tracking';},operatorOverride:()=>events.push('override'),emergencyStop:()=>events.push('emergency')};
  hooks().registerTracking(state,{manager,ledger:{send:()=>true}});
  const config:any={cameras:[{id:'cam1',label:'Synthetic',protocol:'dji-bridge'}],mappings:{trackingToggle:'RS'},speeds:{presets:[{multiplier:1}]}};
  const activity=new ActivityLog();const machine=new ControlStateMachine(state,config,{} as any,new Map(),activity);
  const tick=(buttons:any)=>{machine.updateInput({buttons,axes:{},triggers:{}} as any);machine.tick();};
  return {state,events,activity,tick,suspend:()=>mode='operator_override'};
}
test('issue-33-c1',()=>{for(const file of ['xbox.yaml','xbox-bluetooth.yaml','switch-pro-bluetooth.yaml','wii-u-pro.yaml','generic.yaml']){const source=fs.readFileSync(path.join('controller-profiles',file),'utf8');assert.match(source,/RS/);}assert.match(fs.readFileSync('src/model/controlStateMachine.ts','utf8'),/trackingToggle/);});
test('issue-33-c2',()=>{const f=fixture();f.tick({RS:true});assert.deepEqual(f.events,['cancel']);f.tick({});f.tick({RS:true});assert.deepEqual(f.events,['cancel']);f.suspend();f.tick({});f.tick({RS:true});assert.deepEqual(f.events,['cancel','resume']);});
test('issue-33-c3',()=>{const f=fixture();f.tick({RS:true});f.tick({RS:true});assert.equal(f.events.length,1);assert.match(JSON.stringify(f.activity.getAll()),/Tracking|tracking/);});
test('issue-33-c4',()=>{const f=fixture();f.tick({back:true});assert.ok(f.events.includes('emergency'));assert.ok(!f.events.includes('cancel'));});
test('issue-33-c5',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'fps-rs-config-'));fs.mkdirSync(path.join(home,'config'));fs.writeFileSync(path.join(home,'config/devices.yaml'),YAML.stringify({atem:{ip:'127.0.0.1',defaultTransition:'cut'},cameras:[]}));fs.writeFileSync(path.join(home,'config/speeds.json'),'{"presets":[],"activePreset":0}');fs.writeFileSync(path.join(home,'config/mappings.yaml'),'{}');
  const old=process.env.CAMCONTROL_HOME;process.env.CAMCONTROL_HOME=home;try{assert.equal((loadConfig().mappings as any).trackingToggle,'RS');}finally{if(old===undefined)delete process.env.CAMCONTROL_HOME;else process.env.CAMCONTROL_HOME=old;}
});
