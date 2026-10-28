import {request,onLeave} from './panel-client.js';

const MIN=180,MAX=520,DEFAULT=288,GAP=18,DETAIL_MIN=320;
const clamp=value=>Math.round(Math.min(MAX,Math.max(MIN,Number(value)||DEFAULT)));
// Default UI leaf: an appended ui.assets file can replace this implementation.
// Opaque panels persist one validated preference through the host, never storage.
export function installListLayout(root,{load=()=>request('GET','/api/ui/list-layout'),save=width=>request('POST','/api/ui/list-layout',{width}),onLeaving=onLeave}={}) {
  if(!root||root.dataset.listLayout)return ()=>{};
  root.dataset.listLayout='true';root.classList.add('list-layout');
  const pane=root.firstElementChild,detail=root.lastElementChild,handle=document.createElement('div'),notice=document.createElement('small');
  if(!pane.id)pane.id='list-layout-pane';if(!detail.id)detail.id='list-layout-detail';
  handle.className='list-layout-handle';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');
  handle.setAttribute('aria-label','调整列表宽度');handle.setAttribute('aria-controls',`${pane.id} ${detail.id}`);handle.title='方向键调整宽度；双击恢复';
  notice.className='list-layout-notice';notice.setAttribute('role','status');notice.hidden=true;root.append(handle,notice);
  let preferred=DEFAULT,actual=DEFAULT,limit=MAX,revision=0,frame=0,keyboardTimer=0,drag=null,closed=false,pending=null,writing=null,rootWidth=0;
  const cleanups=[],media=matchMedia('(max-width: 850px)');
  const listen=(target,event,fn,options)=>{target.addEventListener(event,fn,options);cleanups.push(()=>target.removeEventListener(event,fn,options));};
  function paint(){
    frame=0;if(closed)return;
    const width=root.getBoundingClientRect().width,stacked=media.matches||width<MIN+GAP+DETAIL_MIN;rootWidth=width;
    limit=Math.floor(Math.min(MAX,Math.max(MIN,width-GAP-DETAIL_MIN)));actual=Math.min(preferred,limit);
    root.classList.toggle('list-layout-stacked',stacked);root.style.setProperty('--list-pane-width',`${actual}px`);
    handle.hidden=stacked;handle.tabIndex=stacked?-1:0;handle.setAttribute('aria-valuemin',String(MIN));handle.setAttribute('aria-valuemax',String(Math.floor(limit)));handle.setAttribute('aria-valuenow',String(Math.round(actual)));
  }
  function schedule(){if(!frame&&!closed)frame=requestAnimationFrame(paint);}
  function flushPaint(){if(frame){cancelAnimationFrame(frame);frame=0;}paint();}
  function persist(){
    if(writing)return writing;
    writing=(async()=>{
      while(pending!==null){const width=pending,ticket=revision;pending=null;
        try {await save(width);if(!closed&&ticket===revision){notice.hidden=true;notice.textContent='';}}
        catch {if(!closed&&ticket===revision){notice.textContent='列表宽度未能保存；再次调整可重试';notice.hidden=false;}}
      }
    })().finally(()=>{writing=null;});return writing;
  }
  function commit(){pending=clamp(preferred);return persist();}
  function end(commitChange=false){
    if(!drag)return;
    const previous=drag;drag=null;root.classList.remove('list-layout-dragging');
    try{handle.releasePointerCapture(previous.id);}catch{}
    if(!commitChange)preferred=previous.preferred;
    flushPaint();if(commitChange&&preferred!==previous.preferred)void commit();
  }
  listen(handle,'pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false||handle.hidden||closed||drag)return;
    event.preventDefault();if(keyboardTimer){clearTimeout(keyboardTimer);keyboardTimer=0;void commit();}flushPaint();++revision;
    drag={id:event.pointerId,x:event.clientX,start:actual,preferred};root.classList.add('list-layout-dragging');handle.setPointerCapture(event.pointerId);
  });
  listen(handle,'pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    if(!(event.buttons&1)){end(false);return;}
    preferred=Math.round(Math.min(limit,Math.max(MIN,drag.start+event.clientX-drag.x)));schedule();
  });
  listen(handle,'pointerup',event=>{if(drag?.id===event.pointerId)end(true);});
  listen(handle,'pointercancel',()=>end(false));listen(handle,'lostpointercapture',()=>end(false));
  listen(window,'blur',()=>end(false));listen(document,'visibilitychange',()=>{if(document.hidden)end(false);});
  listen(handle,'dblclick',()=>{end(false);clearTimeout(keyboardTimer);keyboardTimer=0;++revision;preferred=DEFAULT;flushPaint();void commit();});
  listen(handle,'keydown',event=>{
    if(event.key==='Escape'&&drag){event.preventDefault();end(false);return;}
    if(handle.hidden||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();end(false);++revision;
    preferred=event.key==='Home'?MIN:event.key==='End'?limit:Math.max(MIN,Math.min(limit,actual+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?32:8)));
    flushPaint();clearTimeout(keyboardTimer);keyboardTimer=setTimeout(()=>{keyboardTimer=0;void commit();},200);
  });
  const resize=new ResizeObserver(()=>{if(Math.abs(root.getBoundingClientRect().width-rootWidth)>.5){end(false);schedule();}});resize.observe(root);listen(media,'change',()=>{end(false);schedule();});
  paint();const readTicket=revision;
  Promise.resolve().then(()=>closed?null:load()).then(result=>{if(!closed&&revision===readTicket){preferred=clamp(result?.width);paint();}},()=>{if(!closed&&revision===readTicket){notice.textContent='列表宽度偏好暂时不可用';notice.hidden=false;}});
  function dispose(){
    if(closed)return;end(false);closed=true;resize.disconnect();cleanups.splice(0).forEach(fn=>fn());clearTimeout(keyboardTimer);keyboardTimer=0;if(frame)cancelAnimationFrame(frame);frame=0;
    handle.remove();notice.remove();root.classList.remove('list-layout','list-layout-stacked','list-layout-dragging');root.style.removeProperty('--list-pane-width');delete root.dataset.listLayout;unleave();
  }
  const unleave=onLeaving(async()=>{end(false);if(keyboardTimer){clearTimeout(keyboardTimer);keyboardTimer=0;pending=clamp(preferred);}await persist();dispose();});
  listen(window,'pagehide',dispose,{once:true});return dispose;
}
