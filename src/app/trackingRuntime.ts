import { AppState } from './state';
import { AppConfig } from '../config/configLoader';
import { MotionDevice } from '../devices/motionDevice';
import { TrackingClient } from '../tracking/trackingClient';
import { TrackingManager } from '../tracking/trackingManager';
import { MotionLedger } from '../tracking/motionLedger';
import { SidecarProcess } from '../tracking/sidecarProcess';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { registerTracking, unregisterTracking } from './trackingHooks';

/** Readiness is background-only: missing optional vision never blocks the app. */
export function startTrackingRuntime(state: AppState, config: AppConfig, devices: Map<string, MotionDevice>, backendOrigin: string, frameToken: string, paused: boolean) {
  let stopped=false, manager:TrackingManager|undefined,client:TrackingClient|undefined, helper:SidecarProcess|undefined;
  const ready=(async()=>{
    if(!config.tracking?.enabled || paused)return;
    const packaged=process.env.CAMCONTROL_EMBEDDED==='1';
    let url=config.tracking.sidecarUrl, token=process.env.TRACKER_WS_TOKEN;
    if(packaged) {
      if(process.env.CAMCONTROL_TRACKING_AVAILABLE!=='1')return;
      helper=new SidecarProcess({enabled:true,backendOrigin,frameToken,reacquireMs:config.tracking.reacquireMs,lostHoldMs:config.tracking.lostHoldMs});
      const connection=await helper.start();url=connection.url;token=connection.token;
      if(stopped){await helper.stop();return;}
    }
    if(stopped)return;
    client=new TrackingClient({enabled:true,url,token,backendOrigin,packaged,allowRemote:process.env.TRACKING_ALLOW_REMOTE==='1'});
    const refreshSources=()=>client?.configure(resolveTrackingSources(config).map(source=>({sourceId:source.sourceId,frameUrl:backendOrigin+'/api/sony/cameras/'+encodeURIComponent(source.sonyCameraId)+'/live-view/frame'})));
    refreshSources();
    const ledger=new MotionLedger();
    manager=new TrackingManager({config:config.tracking,sources:resolveTrackingSources(config),devices,client,ledger});
    registerTracking(state,{manager,client,ledger,refreshSources});
    helper?.on('exit',()=>{manager?.invalidateAll('sidecar_disconnected');client?.stop();});
    manager.start();
  })();
  // The caller may observe this curated failure; no raw helper exception leaks.
  const settled=ready.catch(async()=>{
    try {manager?.stop();} finally {
      client?.stop();unregisterTracking(state);
      await helper?.stop();
    }
  });
  const halt=()=>{stopped=true;try {manager?.stop();} finally {client?.stop();unregisterTracking(state);}};
  return { ready:settled, halt, async stop() {
    let failure:unknown;
    try {halt();} catch(error) {failure=error;}
    try {await helper?.stop();await settled;} finally {if(failure)throw failure;}
  } };
}
