import {VISUAL_KINDS,VISUAL_PROPERTIES,normalizeVisualValue,validVisualSelector,visualPage} from './visual-style.js';
export function visualKind(el){
  if(el.matches('#nav button,.settings-sidebar a'))return'navigation';
  if(el.matches('button'))return'button';
  if(el.matches('input[type=range]'))return'range';
  if(el.matches('input[type=checkbox],input[type=radio]'))return'choice';
  if(el.matches('.is-switch,.personalization-toggle,.choice-toggle,[role=switch]'))return'switch';
  if(/(?:^|\s)[\w-]*(?:title|label|caption)(?:\s|$)/.test(typeof el.className==='string'?el.className:''))return'text';
  for(const kind of ['textarea','select','input','dialog','heading','icon','image','table','row','list','card','navigation','text'])try{if(el.matches(VISUAL_KINDS[kind].selector))return kind;}catch{}
  return'container';
}
export function visualSelector(el,doc=el.ownerDocument){
  const parts=[];let at=el;
  while(at&&at!==doc.body&&parts.length<14){
    if(at.id&&/^[A-Za-z_][\w:.-]{0,95}$/.test(at.id)&&!/^component-preview-\d+-/.test(at.id)){
      const selector=`[id="${at.id}"]`;if(doc.querySelectorAll(selector).length===1){parts.unshift(selector);break;}
    }
    let part=at.localName;if(!/^[a-z][\w-]*$/.test(part||''))return null;
    const classes=[...at.classList].filter(c=>/^[A-Za-z_][\w-]*$/.test(c)&&!/(?:^is-|active|selected|focus|enter|leave|motion|loading|error)/i.test(c)).slice(0,2);
    if(classes.length){const candidate=part+classes.map(c=>'.'+c).join('');if(doc.querySelectorAll(candidate).length===1){parts.unshift(candidate);break;}part=candidate;}
    const siblings=[...(at.parentElement?.children||[])].filter(n=>n.localName===at.localName);if(siblings.length>1)part+=`:nth-of-type(${siblings.indexOf(at)+1})`;
    parts.unshift(part);at=at.parentElement;
  }
  if(!parts.length)return'body';const selector=parts.join(' > ');return validVisualSelector(selector)?selector:null;
}
export function createVisualPicker(doc,{select=()=>{}}={}){
  const win=doc.defaultView;let enabled=false,outline=null,hovered=null,selected=null,selectedSelector=null,previewState=null,frame=0,observer=null,drag=null,dragFrame=0;
  const owned=el=>!el||el.closest('[data-visual-owned]')||el.matches('html,body,head,script,style,link,meta,iframe');
  const target=event=>{let el=event.target?.nodeType===1?event.target:event.target?.parentElement;if(owned(el))return null;if(event.shiftKey)return el.closest('svg')||el;return el.closest('button,.is-switch,.personalization-toggle,[role=switch]')||el;};
  function draw(el){
    if(!enabled||!el?.isConnected){outline?.remove();outline=null;return;}
    if(!outline){outline=doc.createElement('div');outline.dataset.visualOwned='true';outline.setAttribute('role','presentation');outline.style.cssText='position:fixed;pointer-events:none;z-index:2147483000;border:2px solid #7b9eff;border-radius:3px;background:#7799ff12;box-sizing:border-box;';doc.body.append(outline);}
    const container=el.closest('dialog[open]')||doc.body;if(outline.parentElement!==container)container.append(outline);
    const r=el.getBoundingClientRect();Object.assign(outline.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
    let handle=outline.querySelector('[data-visual-resize]');
    if(el===selected&&!handle){
      handle=doc.createElement('div');handle.dataset.visualResize='true';handle.tabIndex=0;handle.setAttribute('role','button');handle.setAttribute('aria-label','拖动调整尺寸');handle.title='拖动调整尺寸；方向键每次调整 4px';handle.style.cssText='position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;background:#b9c8ff;border:1px solid #25316b;border-radius:2px;cursor:nwse-resize;pointer-events:auto;';outline.append(handle);
      const emitResize=()=>{dragFrame=0;if(!drag||!enabled)return;select({page:visualPage(doc),selector:selectedSelector,kind:visualKind(selected),resize:{width:drag.width,height:drag.height}});};
      handle.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();const box=selected.getBoundingClientRect();drag={x:event.clientX,y:event.clientY,startWidth:box.width,startHeight:box.height,width:box.width,height:box.height};hovered=selected;handle.setPointerCapture(event.pointerId);});
      handle.addEventListener('pointermove',event=>{if(!drag)return;drag.width=Math.max(8,Math.min(3840,Math.round(drag.startWidth+event.clientX-drag.x)));drag.height=Math.max(8,Math.min(2160,Math.round(drag.startHeight+event.clientY-drag.y)));if(!dragFrame)dragFrame=win.requestAnimationFrame(emitResize);});
      const finish=()=>{if(dragFrame)win.cancelAnimationFrame(dragFrame);emitResize();drag=null;};handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
      handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const box=selected.getBoundingClientRect();const width=Math.max(8,Math.min(3840,Math.round(box.width+(event.key==='ArrowRight'?4:event.key==='ArrowLeft'?-4:0)))),height=Math.max(8,Math.min(2160,Math.round(box.height+(event.key==='ArrowDown'?4:event.key==='ArrowUp'?-4:0))));select({page:visualPage(doc),selector:selectedSelector,kind:visualKind(selected),resize:{width,height}});});
    }else if(el!==selected)handle?.remove();
  }
  function reconnect(){if(selectedSelector&&!selected?.isConnected){selected=doc.querySelector(selectedSelector);if(!hovered?.isConnected)hovered=selected;}if(selected){if(enabled&&previewState)selected.setAttribute('data-visual-preview-state',previewState);else selected.removeAttribute('data-visual-preview-state');}}
  const schedule=()=>{if(frame)return;frame=win.requestAnimationFrame(()=>{frame=0;reconnect();draw(selected||hovered);});};
  function choose(el){
    if(owned(el))return;const selector=visualSelector(el,doc);if(!selector)return;
    selected?.removeAttribute('data-visual-preview-state');selected=el;selectedSelector=selector;hovered=el;draw(el);const computed=win.getComputedStyle(el),values={};
    let colorCanvas=null;
    for(const [key,spec]of Object.entries(VISUAL_PROPERTIES)){
      let raw=computed[key];if(key==='backgroundColor'&&/gradient\(/.test(computed.backgroundImage)){const first=/\b(?:rgba?\([^)]*\)|color\([^)]*\))|#[\da-f]{3,8}/i.exec(computed.backgroundImage);if(first)raw=first[0];}
      let value=normalizeVisualValue(key,raw);
      if(value===null&&spec.type==='color'&&win.CSS?.supports('color',raw)){
        colorCanvas??=doc.createElement('canvas');colorCanvas.width=colorCanvas.height=1;const ctx=colorCanvas.getContext('2d',{willReadFrequently:true});if(ctx){ctx.clearRect(0,0,1,1);ctx.fillStyle=raw;ctx.fillRect(0,0,1,1);const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;value=`rgba(${r},${g},${b},${Number((a/255).toFixed(3))})`;}
      }
      if(value!==null)values[key]=value;
    }
    const kind=visualKind(el),family=kind==='container'||!el.matches(VISUAL_KINDS[kind].selector)?[...el.classList].find(c=>/^[A-Za-z_][\w-]*$/.test(c)&&!/(?:active|selected|motion)/i.test(c)):null;
    select({page:visualPage(doc),selector,kind,values,tag:el.localName,...(family?{family:`${el.localName}.${family}`}:{})});
  }
  const move=event=>{if(event.altKey||drag)return;hovered=target(event);schedule();};
  const click=event=>{if(event.altKey)return;const el=target(event);if(!el)return;event.preventDefault();event.stopImmediatePropagation();if(selected!==el||event.detail===0)choose(el);};
  const press=event=>{const el=target(event);if(!event.altKey&&el&&event.button===0){event.preventDefault();event.stopImmediatePropagation();choose(el);}};
  const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();set(false);select({pause:true});}};
  function set(next){
    if(enabled===next)return;enabled=next;
    for(const [name,fn]of [['pointermove',move],['click',click],['pointerdown',press],['keydown',key]])doc[next?'addEventListener':'removeEventListener'](name,fn,true);
    for(const name of ['scroll','resize'])win[next?'addEventListener':'removeEventListener'](name,schedule,true);
    if(next&&win.MutationObserver){observer=new win.MutationObserver(()=>{if(selectedSelector&&!selected?.isConnected)schedule();});observer.observe(doc.body,{childList:true,subtree:true});}else{observer?.disconnect();observer=null;}
    if(!next){if(frame)win.cancelAnimationFrame(frame);if(dragFrame)win.cancelAnimationFrame(dragFrame);frame=dragFrame=0;drag=null;outline?.remove();outline=null;selected?.removeAttribute('data-visual-preview-state');}else draw(selected);
  }
  return{set,preview(state){previewState=state;reconnect();if(enabled)schedule();},parent(){reconnect();if(selected?.parentElement)choose(selected.parentElement);},dispose(){set(false);selected=null;hovered=null;selectedSelector=null;}};
}
