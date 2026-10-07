import type { Express } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config/configLoader';
import type { TrackingHooks, TrackingRuntimeStatus } from '../app/trackingHooks';
import { resolveTrackingSources } from '../tracking/sourceResolver';
import { TrackingError } from '../tracking/trackingManager';

const sourceBody = z.object({sourceId:z.string().min(1).max(128)}).strict();
const selectBody = sourceBody.extend({x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)}).strict();
const speedBody = z.object({value:z.number().finite().min(.05).max(1)}).strict();
export function trackingSnapshot(config: AppConfig, hooks?: TrackingHooks, runtime?: TrackingRuntimeStatus) {
  const states = hooks?.manager.getStatus() ?? {};
  const sources = resolveTrackingSources(config).map(source => {
    const current = states[source.sourceId];
    const observed = current?.observation;
    return { sourceId:source.sourceId,sonyCameraId:source.sonyCameraId,cameraId:source.cameraId,maxSpeed:hooks?.manager.speedOf(source.sourceId) ?? config.tracking?.speeds[source.device] ?? config.tracking?.maxSpeed ?? .35,
      sessionId:current?.sessionId ?? null,state:current?.state ?? 'idle',reason:current?.reason ?? null,
      framing:current?.framing ?? {cx:.5,cy:.5},framingHeld:current?.framingHeld ?? false,
      canHoldFraming:current?.canHoldFraming ?? false,holdFramingReason:current ? current.holdFramingReason : 'Tracking service unavailable',
      ...(observed && observed.conf > 0 ? {target:{cx:observed.cx,cy:observed.cy,w:observed.w,h:observed.h,conf:observed.conf},ageMs:Math.max(0,Date.now()-observed.frameTs)} : {}),
    };
  });
  return {enabled:config.tracking?.enabled ?? false,sidecar:hooks?.client?.connected ? {state:'connected'} : {state:runtime?.state==='unavailable' ? 'unavailable':'offline',...(runtime?.reason ? {reason:runtime.reason}:{})},sources};
}

export function installTrackingRoutes(app: Express, config: AppConfig, getHooks:()=>TrackingHooks|undefined, getRuntime:()=>TrackingRuntimeStatus|undefined=()=>undefined, saveSpeed?:(device:string,value:number)=>void) {
  app.get('/api/tracking/status',(_req,res)=>res.json(trackingSnapshot(config,getHooks(),getRuntime())));
  // The Track speed slider (iPad camera menu): cap one source's tracking speed, applied at once and saved to devices.yaml.
  app.put('/api/tracking/sources/:sourceId/speed',(req,res)=>{
    const body=speedBody.safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Speed must be between 0.05 and 1'});return;}
    const source=resolveTrackingSources(config).find(s=>s.sourceId===req.params.sourceId);
    if(!source){res.status(404).json({error:'Unknown tracking source'});return;}
    try { saveSpeed?.(source.device, body.data.value); } catch (error) { res.status(409).json({error:error instanceof Error ? error.message : 'The speed could not be saved'});return; }
    const hooks=getHooks();
    if(hooks){ try { hooks.manager.setSpeed(source.sourceId, body.data.value); } catch (_) { /* no live session for this source yet; the saved value applies on the next start */ } }
    res.json({ok:true,sourceId:source.sourceId,maxSpeed:body.data.value});
  });
  for (const action of ['select','cancel','resume','hold-framing'] as const) app.post('/api/tracking/'+action,(req,res)=>{
    const body=(action==='select'?selectBody:sourceBody).safeParse(req.body);
    if(!body.success){res.status(400).json({error:'Invalid tracking request'});return;}
    const sourceId=body.data.sourceId;
    const hooks=getHooks();
    const source=resolveTrackingSources(config).find(s=>s.sourceId===sourceId);
    const status=hooks?.manager.getStatus()[sourceId];
    if(!source && !status){res.status(404).json({error:'Unknown tracking source'});return;}
    if(action!=='cancel' && !config.tracking?.enabled){res.status(409).json({error:'Tracking is disabled'});return;}
    if(!hooks){res.status(409).json({error:'Tracking service unavailable'});return;}
    if(action!=='cancel' && (source?.cameraId===null || status?.cameraId===null)){res.status(409).json({error:'Gimbal is not in the active profile'});return;}
    try {
      if(action==='select') {const point=body.data as z.infer<typeof selectBody>;hooks.manager.select(sourceId,point.x,point.y);}
      else if(action==='cancel') hooks.manager.cancel(sourceId);
      else if(action==='hold-framing') hooks.manager.holdFraming(sourceId);
      else hooks.manager.resume(sourceId);
      res.json({ok:true});
    } catch (error) {
      const code=error instanceof TrackingError && [400,404,409,429].includes(error.statusCode) ? error.statusCode : 409;
      res.status(code).json({error:action==='hold-framing' && error instanceof TrackingError && error.code==='framing_unavailable' ? error.message : code===429 ? 'Wait before selecting again':'Tracking source unavailable or awaiting a fresh selection'});
    }
  });
}
