/* Operate: add an explicit mode and an always-reachable stop to the incumbent
 * Sony preview. Focus remains the default; no preference survives reload. */
(function () {
  'use strict';
  const modes = new Map(), widgets = new Map();
  let snapshot = { enabled:false, sidecar:{state:'offline'}, sources:[] };
  let delay = 250, timer;
  const labels = { idle:'Choose a person in Track mode', locking:'Locking…', tracking:'Tracking', holding:'Holding', lost:'Target lost', sidecar_offline:'Sidecar offline', stale:'Stale video', operator_override:'Paused — stick moved', unavailable:'Gimbal unavailable', disabled:'Tracking is disabled' };
  const api = window.fpsTracking = { pollCount:0, renderWidgets };
  // A rig with no connected camera has a placeholder card with no camera ID: nothing to track there.
  function forCamera(id) { if(!id)return undefined; return snapshot.sources.find(source => String(source.sonyCameraId).toUpperCase() === id.toUpperCase()); }
  function button(label, action, className) { const el=document.createElement('button'); el.type='button';el.className='btn-sm '+(className||'');el.textContent=label;el.addEventListener('click',action);return el; }
  function renderWidgets() {
    document.querySelectorAll('.sony-widget').forEach(article => {
      const id=article.dataset.cameraId, source=forCamera(id);
      let widget=widgets.get(id);
      if(widget && widget.article!==article) {widgets.delete(id);widget=null;}
      if(!source || !source.cameraId) {if(widget){widget.controls.hidden=true;widget.box.hidden=true;}return;}
      if(!widget) {
        const controls=document.createElement('div');controls.className='tracking-controls';controls.setAttribute('aria-label','Person tracking controls');
        const preview=article.querySelector('.sony-preview');preview.tabIndex=0;
         const status=document.createElement('div');status.className='tracking-state';status.setAttribute('aria-live','polite');status.setAttribute('role','status');
         status.id='tracking-status-'+id.replace(/:/g,'-');preview.setAttribute('aria-describedby',status.id);
        const box=document.createElement('span');box.className='tracking-box';box.hidden=true;box.setAttribute('aria-hidden','true');preview.append(box);
        widget={article,preview,controls,status,box,source};
        widget.focus=button('Focus (touch)',()=>{modes.set(id,'focus');update(widget);});
        widget.track=button('Track',()=>{modes.set(id,'track');update(widget);preview.focus();});
        widget.stop=button('Stop tracking',()=>command(widget,'cancel'),'tracking-stop');
        widget.resume=button('Resume',()=>command(widget,'resume'));
         widget.hold=button('Hold this framing',()=>command(widget,'hold-framing'));
         widget.hold.setAttribute('aria-describedby',status.id);widget.resume.setAttribute('aria-describedby',status.id);
        controls.append(widget.focus,widget.track,widget.stop,widget.resume,widget.hold,status);preview.after(controls);widgets.set(id,widget);
        preview.addEventListener('keydown',event=>{if(event.key==='Escape'&&widget.source.sessionId){event.preventDefault();command(widget,'cancel');}});
        preview.querySelector('img').addEventListener('load',()=>position(widget));
      }
      widget.source=source;widget.controls.hidden=false;update(widget);
    });
  }
  function update(widget) {
    const source=widget.source,id=widget.article.dataset.cameraId, mode=modes.get(id)||'focus';
    widget.focus.setAttribute('aria-pressed',String(mode==='focus'));widget.track.setAttribute('aria-pressed',String(mode==='track'));
    widget.track.disabled=!snapshot.enabled || snapshot.sidecar.state!=='connected';
    widget.stop.hidden=!source.sessionId;widget.resume.hidden=source.state!=='operator_override';
    widget.hold.disabled=!source.canHoldFraming || !snapshot.enabled || snapshot.sidecar.state!=='connected';
    widget.hold.title=source.holdFramingReason||'Capture the current placement and resume tracking';
    widget.resume.disabled=source.canHoldFraming===false || !snapshot.enabled || snapshot.sidecar.state!=='connected';
    let state=source.state;
    if(!snapshot.enabled)state='disabled';else if(snapshot.sidecar.state!=='connected')state='sidecar_offline';
    widget.controls.dataset.state=state;
    const reason=state==='sidecar_offline'&&typeof snapshot.sidecar.reason==='string'?snapshot.sidecar.reason:'';
    if(!source.sessionId||!snapshot.enabled||snapshot.sidecar.state!=='connected')widget.feedbackUntil=0;
    const instructions=mode==='track'?' — Select a person in the preview. Escape stops tracking.':'';
    const message=(widget.feedbackUntil>Date.now()?widget.feedback:(labels[state]||'Tracking unavailable')+(reason?' — '+reason:'')+
      (source.framingHeld?' — Framing held':'')+(state==='operator_override'?(source.holdFramingReason?' — '+source.holdFramingReason:' — Hold this framing captures placement and resumes; Resume preserves placement.') :''))+instructions;
    if(widget.status.textContent!==message) {
      const label=labels[state]||'Tracking unavailable';
      if(message.startsWith(label)) {
        const summary=document.createElement('span');summary.textContent=label;
        widget.status.replaceChildren(summary,document.createTextNode(message.slice(label.length)));
      } else widget.status.textContent=message;
    }
    position(widget);
  }
  function position(widget) {
    const target=widget.source.target,image=widget.preview.querySelector('img');
    widget.box.hidden=!target||!image.naturalWidth||!widget.source.sessionId;
    if(widget.box.hidden)return;
    const ratio=Math.min(image.clientWidth/image.naturalWidth,image.clientHeight/image.naturalHeight);
    const width=image.naturalWidth*ratio,height=image.naturalHeight*ratio;
    Object.assign(widget.box.style,{left:((image.clientWidth-width)/2+(target.cx-target.w/2)*width)+'px',top:((image.clientHeight-height)/2+(target.cy-target.h/2)*height)+'px',width:(target.w*width)+'px',height:(target.h*height)+'px'});
  }
  async function command(widget, action, point) {
    try {
      const response=await fetch('/api/tracking/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({sourceId:widget.source.sourceId},point||{}))});
      if(!response.ok){const body=await response.json();throw new Error(typeof body.error==='string'?body.error:'Action unavailable');}
      widget.feedbackUntil=0;
      if(action==='select'){widget.status.textContent='Locking…';widget.controls.dataset.state='locking';}
      else if(action==='cancel'){widget.status.textContent='Tracking stopped';widget.box.hidden=true;}
      // Resume never locally changes state: only the manager can re-arm motion.
    } catch (error) {widget.feedback=(error.message||'Action unavailable')+'. Check the gimbal and select a fresh target.';widget.feedbackUntil=Date.now()+3500;widget.status.textContent=widget.feedback;}
  }
  document.getElementById('sony-cameras').addEventListener('pointerup',event=>{
    if(event.target.tagName!=='IMG')return;
    const id=event.target.dataset.id,widget=widgets.get(id);
    if(!widget||modes.get(id)!=='track')return;
    event.stopImmediatePropagation();
    if(widget.track.disabled)return;
    const point=window.sonyContainedPoint(event.target,event.clientX,event.clientY);
    if(point)command(widget,'select',{x:point.x,y:point.y});
  },true);
  async function poll() {
    if(document.hidden){timer=setTimeout(poll,500);return;}
    try {
      api.pollCount++;
      const response=await fetch('/api/tracking/status',{cache:'no-store'});if(!response.ok)throw new Error();
      const next=await response.json();if(!Array.isArray(next.sources)||!next.sidecar)throw new Error();
      snapshot=next;delay=250;
    } catch (_) {snapshot.sidecar={state:'offline'};snapshot.sources=snapshot.sources.map(source=>({...source,canHoldFraming:false,target:null,framingHeld:false}));delay=Math.min(delay*2,4000);}
    renderWidgets();timer=setTimeout(poll,delay);
  }
  window.addEventListener('resize',()=>widgets.forEach(position));
  window.addEventListener('pagehide',()=>clearTimeout(timer),{once:true});
  poll();
})();
