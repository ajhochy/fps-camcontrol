import path from 'node:path';
import { AppState } from './state';
import { AppConfig } from '../config/configLoader';
import { MotionDevice } from '../devices/motionDevice';
import { TrackingClient } from '../tracking/trackingClient';
import { TrackingManager } from '../tracking/trackingManager';
import { MotionLedger } from '../tracking/motionLedger';
import { SidecarProcess } from '../tracking/sidecarProcess';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { decideTrackingLaunch, helperRestartDelay } from '../tracking/launchDecision';
import { registerTracking, unregisterTracking, setTrackingRuntimeStatus } from './trackingHooks';
import { logger } from '../index';

/** dist/app/trackingRuntime.js and src/app/trackingRuntime.ts are both two levels below the repo root. */
const REPO_ROOT = path.resolve(__dirname, '../..');
/** A helper that stayed up this long resets the restart backoff. */
const STABLE_MS = 60000;

/** Readiness is background-only: missing optional vision never blocks the app. */
export function startTrackingRuntime(state: AppState, config: AppConfig, devices: Map<string, MotionDevice>, backendOrigin: string, frameToken: string, paused: boolean) {
  let stopped=false, manager:TrackingManager|undefined,client:TrackingClient|undefined, helper:SidecarProcess|undefined;
  let restartTimer:NodeJS.Timeout|undefined, attempts=0, upSince=0;
  const packaged=process.env.CAMCONTROL_EMBEDDED==='1';
  const status=(next:Parameters<typeof setTrackingRuntimeStatus>[1])=>setTrackingRuntimeStatus(state,next);
  const reasonOf=(error:unknown)=>error instanceof Error?error.message.replace(/[^\x20-\x7e]/g,'').slice(0,160):'unknown error';

  /** Launch (or relaunch) the owned helper; on failure or later death back off and try again. */
  const launchOwned=async(paths?:{python:string;script:string;model:string})=>{
    if(stopped||!client)return;
    const next=new SidecarProcess({enabled:true,backendOrigin,frameToken,reacquireMs:config.tracking!.reacquireMs,lostHoldMs:config.tracking!.lostHoldMs,
      ...(paths?{pythonPath:paths.python,scriptPath:paths.script,modelPath:paths.model}:{})});
    helper=next;
    try {
      const connection=await next.start();
      if(stopped){await next.stop();return;}
      upSince=Date.now();
      next.once('exit',()=>{
        if(stopped||helper!==next)return;
        manager?.invalidateAll('sidecar_disconnected');client?.stop();
        if(Date.now()-upSince>=STABLE_MS)attempts=0;
        scheduleRestart('tracking helper exited');
      });
      status({state:'running'});
      client.retarget(connection.url,connection.token);client.start();
    } catch(error) {
      if(stopped)return;
      await next.stop().catch(()=>{});
      scheduleRestart(reasonOf(error));
    }
  };
  const scheduleRestart=(why:string)=>{
    if(stopped||restartTimer)return;
    const delay=helperRestartDelay(attempts++);
    status({state:'restarting',reason:`${why}; retrying in ${Math.round(delay/1000)}s`});
    logger.warn({attempt:attempts,delayMs:delay},'tracking helper down; restarting');
    restartTimer=setTimeout(()=>{restartTimer=undefined;void launchOwned(currentPaths);},delay);
    restartTimer.unref();
  };
  let currentPaths:{python:string;script:string;model:string}|undefined;

  const ready=(async()=>{
    const decision=decideTrackingLaunch({enabled:!!config.tracking?.enabled,paused,env:process.env,repoRoot:REPO_ROOT});
    if(decision.mode==='off')return;
    if(decision.mode==='unavailable'){
      status({state:'unavailable',reason:decision.reason});
      logger.warn({reason:decision.reason},'tracking unavailable');
      return;
    }
    const developer=decision.mode==='developer';
    // An owned helper's real URL/token arrive via retarget(); until then the client is idle (reports offline).
    client=new TrackingClient({enabled:true,url:config.tracking!.sidecarUrl,token:developer?process.env.TRACKER_WS_TOKEN:undefined,backendOrigin,packaged,allowRemote:process.env.TRACKING_ALLOW_REMOTE==='1'});
    const refreshSources=()=>client?.configure(resolveTrackingSources(config).map(source=>({sourceId:source.sourceId,frameUrl:backendOrigin+'/api/sony/cameras/'+encodeURIComponent(source.sonyCameraId)+'/live-view/frame'})));
    refreshSources();
    const ledger=new MotionLedger();
    manager=new TrackingManager({config:config.tracking!,sources:resolveTrackingSources(config),devices,client,ledger});
    registerTracking(state,{manager,client,ledger,refreshSources});
    manager.start();
    if(developer){client.start();status({state:'running'});return;}
    currentPaths=decision.paths;
    status({state:'starting',reason:'starting tracking helper'});
    await launchOwned(currentPaths);
  })();
  // The caller may observe this curated failure; no raw helper exception leaks.
  const settled=ready.catch(async()=>{
    try {manager?.stop();} finally {
      client?.stop();unregisterTracking(state);
      status({state:'unavailable',reason:'tracking failed to start'});
      await helper?.stop();
    }
  });
  const halt=()=>{stopped=true;if(restartTimer)clearTimeout(restartTimer);try {manager?.stop();} finally {client?.stop();unregisterTracking(state);}};
  return { ready:settled, halt, async stop() {
    let failure:unknown;
    try {halt();} catch(error) {failure=error;}
    try {await helper?.stop();await settled;} finally {if(failure)throw failure;}
  } };
}
