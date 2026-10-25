// Default settings presentation only. Configuration changes are immediate;
// visual removal waits for the reveal and its layout to reach their endpoints.
export function createConditionalMotion(doc=document){
  const win=doc.defaultView,media=win.matchMedia('(prefers-reduced-motion: reduce)'),entries=new Map(),layouts=new Map();
  const names=new Set(['settings-options-appear','search-service-appear','memory-cooldown-appear','model-media-appear','proactive-options-appear']);
  const enterDuration=220,exitDuration=160,easing='cubic-bezier(.2,.75,.2,1)';
  const motionFactor=()=>{
    if(doc.body?.dataset.interfaceMotion==='off')return 0;
    const value=parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--motion-duration-factor'));
    return Number.isFinite(value)?Math.max(0,Math.min(2,value)):1;
  };
  const canAnimate=()=>!media.matches&&!doc.hidden&&motionFactor()>0;
  let disposed=false;
  const keep=(el,keys)=>keys.map(key=>[key,el.style.getPropertyValue(key),el.style.getPropertyPriority(key)]);
  const putBack=(el,styles)=>{for(const[key,value,priority]of styles)value?el.style.setProperty(key,value,priority):el.style.removeProperty(key);};
  const cssHeight=(el,height)=>{const s=win.getComputedStyle(el);return Math.max(0,height-(s.boxSizing==='border-box'?0:['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((n,key)=>n+(parseFloat(s[key])||0),0)));};
  function stopLayout(parent){
    const layout=layouts.get(parent);if(!layout)return;
    layouts.delete(parent);layout.animation?.cancel();for(const animation of layout.moves)animation.cancel();for(const[el,styles]of layout.layers??[])putBack(el,styles);putBack(parent,layout.styles);
  }
  function releaseLayout(parent){
    const layout=layouts.get(parent);if(!layout||layout.animation?.playState==='running'||layout.animation?.pending)return;
    if([...entries].some(([el,entry])=>el.parentElement===parent&&entry.animation))return;
    // Async labels or a nested reveal can change the natural endpoint while
    // moving. Reconcile that size before releasing auto height, without a snap.
    if(!disposed&&canAnimate()&&parent.isConnected&&parent.getClientRects().length){
      const before=snapshot(parent);layout.animation?.cancel();
      if(Math.abs(parent.getBoundingClientRect().height-before.height)>.5){animateLayout(parent,before,100*motionFactor());return;}
    }
    stopLayout(parent);
  }
  function snapshot(parent){
    const scrollers=new Set([doc.scrollingElement]);for(let el=parent;el;el=el.parentElement)scrollers.add(el);
    const rect=parent.getBoundingClientRect();return{rect,height:rect.height,scrollLeft:parent.scrollLeft,scrollTop:parent.scrollTop,scrolls:[...scrollers].filter(Boolean).map(el=>[el,el.scrollLeft,el.scrollTop]),children:new Map([...parent.children].filter(el=>el.getClientRects().length).map(el=>[el,el.getBoundingClientRect()]))};
  }
  function overlay(el,entry,rect,before){
    if(entry.overlay||!rect)return;
    const parent=el.parentElement,parentRect=before.rect,style=win.getComputedStyle(parent),transform=new win.DOMMatrixReadOnly(win.getComputedStyle(el).transform);
    entry.overlay=keep(el,['position','top','left','width','height','margin-top','margin-right','margin-bottom','margin-left','box-sizing']);
    Object.assign(el.style,{position:'absolute',boxSizing:'border-box',margin:'0',left:`${rect.left-parentRect.left-(parseFloat(style.borderLeftWidth)||0)+before.scrollLeft-transform.e}px`,top:`${rect.top-parentRect.top-(parseFloat(style.borderTopWidth)||0)+before.scrollTop-transform.f}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  }
  function restoreOverlay(el,entry){if(entry.overlay){putBack(el,entry.overlay);entry.overlay=null;}}
  function animateLayout(parent,before,duration){
    const old=layouts.get(parent),styles=old?.styles??keep(parent,['overflow-x','overflow-y','overflow-clip-margin','position','align-content']);
    old?.animation?.cancel();for(const animation of old?.moves??[])animation.cancel();
    // Measure the final nested sizes without advancing their playback clocks.
    const nested=[...layouts].filter(([el,item])=>el!==parent&&parent.contains(el)&&item.toHeight).map(([el,item])=>{const saved=keep(el,['height']);el.style.setProperty('height',item.toHeight,'important');return[el,saved];});
    const to=parent.getBoundingClientRect().height,toHeight=`${cssHeight(parent,to)}px`;
    for(const[el,saved]of nested)putBack(el,saved);
    const layout={styles,moves:[],animation:null,toHeight,layers:old?.layers??new Map()};layouts.set(parent,layout);
    // A fixed animated height must not stretch the remaining auto grid rows.
    // Keep each row at its content size while only the enclosing space moves.
    parent.style.overflow='clip';parent.style.overflowClipMargin=`${Math.max(8,parseFloat(win.getComputedStyle(parent).overflowClipMargin)||0)}px`;parent.style.alignContent='start';if(win.getComputedStyle(parent).position==='static')parent.style.position='relative';
    // A sliding reveal can briefly cross its trigger's edge. Keep persistent
    // controls above the moving content, without changing their dimensions.
    for(const el of parent.children){
      if(el.classList.contains('settings-conditional')||!el.getClientRects().length)continue;
      if(!layout.layers.has(el))layout.layers.set(el,keep(el,['position','z-index']));
      const style=win.getComputedStyle(el);if(style.position==='static')el.style.position='relative';el.style.zIndex=String(Math.max(1,parseFloat(style.zIndex)||0));
    }
    const options={duration:Math.max(1,duration),easing,fill:'both'};
    layout.animation=parent.animate([{height:`${cssHeight(parent,before.height)}px`},{height:toHeight}],options);
    // Siblings inside the same grid/flex stack have already taken their final
    // layout slots. Move them from their previous positions while the parent
    // changes height, including the row gap removed by an outgoing control.
    const parentRect=parent.getBoundingClientRect();
    for(const[el,rect]of before.children){
      if(!el.isConnected||el.parentElement!==parent||el.hidden||entries.get(el)?.overlay)continue;
      // Compare local positions: dialog centering or scroll anchoring during
      // measurement must not become a second translation of the controls.
      const next=el.getBoundingClientRect(),dx=(rect.left-before.rect.left)-(next.left-parentRect.left),dy=(rect.top-before.rect.top)-(next.top-parentRect.top);
      if(Math.abs(dx)+Math.abs(dy)<.1)continue;
      layout.moves.push(el.animate([{translate:`${dx}px ${dy}px`},{translate:'0px 0px'}],options));
    }
    for(const animation of layout.moves)animation.finished.catch(()=>{});
    // Measuring the natural collapsed height briefly shortens the document.
    // Near its end the browser clamps scrolling before the animation restores
    // the old height. Restore that position before the next paint as well.
    for(const[el,left,top]of before.scrolls)if(el.scrollLeft!==left||el.scrollTop!==top)el.scrollTo({left,top,behavior:'instant'});
    layout.animation.finished.then(()=>{if(layouts.get(parent)===layout)releaseLayout(parent);},()=>{});
  }
  const restore=(el,entry)=>{
    el.hidden=!entry.visible;
    restoreOverlay(el,entry);
    el.inert=entry.visible?entry.inert:true;
    if(entry.visible){if(entry.aria===null)el.removeAttribute('aria-hidden');else el.setAttribute('aria-hidden',entry.aria);}
    else el.setAttribute('aria-hidden','true');
    delete el.dataset.conditionalPhase;
  };
  function finish(el,entry){++entry.version;entry.animation?.cancel();entry.animation=null;restore(el,entry);el.dataset.conditionalStatic='';releaseLayout(el.parentElement);}
  const settle=()=>{for(const[el,entry]of entries)finish(el,entry);for(const parent of [...layouts.keys()])stopLayout(parent);};
  let previousFactor=motionFactor();
  const policy=()=>{const factor=motionFactor();if(!canAnimate()||factor!==previousFactor)settle();previousFactor=factor;};
  media.addEventListener('change',policy);doc.addEventListener('visibilitychange',policy);win.addEventListener('pagehide',settle);
  // Closing an editor/section may cancel CSS playback before its promise
  // settles. Finish that visual removal now, before the editor is reopened.
  const observer=new win.MutationObserver(()=>{if(!disposed){for(const[el,entry]of entries)if(entry.animation&&(!el.isConnected||!el.getClientRects().length))finish(el,entry);for(const parent of layouts.keys())if(!parent.isConnected||!parent.getClientRects().length)stopLayout(parent);}});
  observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','open']});
  const preferenceObserver=new win.MutationObserver(policy);
  preferenceObserver.observe(doc.documentElement,{attributes:true,attributeFilter:['style']});
  preferenceObserver.observe(doc.body,{attributes:true,attributeFilter:['data-interface-motion']});
  function set(el,visible){
    if(disposed||!el)return;
    visible=!!visible;
    let entry=entries.get(el);
    if(!entry){
      entry={visible,inert:el.inert,aria:el.getAttribute('aria-hidden'),motion:el.getAttribute('data-motion'),version:0,animation:null};entries.set(el,entry);
      el.dataset.conditionalStatic='';el.classList.add('settings-conditional');el.dataset.motion='off';restore(el,entry);return;
    }
    if(entry.visible===visible)return;
    const parent=el.parentElement,before=parent&&snapshot(parent);
    entry.visible=visible;const version=++entry.version,fromStatic=el.hasAttribute('data-conditional-static');delete el.dataset.conditionalStatic;
    el.inert=visible?entry.inert:true;
    if(visible){if(entry.aria===null)el.removeAttribute('aria-hidden');else el.setAttribute('aria-hidden',entry.aria);el.hidden=false;restoreOverlay(el,entry);}
    else{
      if(el.contains(doc.activeElement)){
        const trigger=el.id&&[...doc.querySelectorAll('[aria-controls]')].find(node=>node.getAttribute('aria-controls')===el.id);
        if(trigger)trigger.focus({preventScroll:true});else doc.activeElement?.blur();
      }
      el.setAttribute('aria-hidden','true');
    }
    if(!canAnimate()||!el.isConnected||!el.getClientRects().length){finish(el,entry);return;}
    const animation=el.getAnimations().find(item=>names.has(item.animationName));
    if(!animation){finish(el,entry);return;}
    const progress=fromStatic?(visible?0:1):Math.max(0,Math.min(1,Number(animation.currentTime)/animation.effect.getComputedTiming().endTime)),duration=(visible?enterDuration:exitDuration)*motionFactor();
    animation.effect.updateTiming({duration});animation.currentTime=progress*duration;
    entry.animation=animation;el.dataset.conditionalPhase=visible?'entering':'leaving';
    if(parent){
      // Preserve the outgoing pixels outside normal flow. This lets the next
      // row start moving immediately instead of waiting for hidden to be set.
      if(!layouts.has(parent))layouts.set(parent,{styles:keep(parent,['overflow-x','overflow-y','overflow-clip-margin','position','align-content']),moves:[],animation:null});
      if(win.getComputedStyle(parent).position==='static')parent.style.position='relative';
      if(!visible)overlay(el,entry,before.children.get(el),before);
      animateLayout(parent,before,(visible?1-progress:progress)*duration);
    }
    // Reuse the current playback position, including a partly revealed frame.
    // Reversing again cannot restart at zero or complete an obsolete hide.
    if(visible?animation.playbackRate<0:animation.playbackRate>0)animation.reverse();
    animation.finished.then(()=>{if(!disposed&&entry.version===version){entry.animation=null;restore(el,entry);releaseLayout(parent);}},()=>{if(!disposed&&entry.version===version)finish(el,entry);});
  }
  function dispose(){
    if(disposed)return;disposed=true;observer.disconnect();preferenceObserver.disconnect();settle();media.removeEventListener('change',policy);doc.removeEventListener('visibilitychange',policy);win.removeEventListener('pagehide',settle);
    for(const[el,entry]of entries){el.inert=entry.inert;if(entry.aria===null)el.removeAttribute('aria-hidden');else el.setAttribute('aria-hidden',entry.aria);if(entry.motion===null)el.removeAttribute('data-motion');else el.setAttribute('data-motion',entry.motion);delete el.dataset.conditionalStatic;el.classList.remove('settings-conditional');}
    entries.clear();
  }
  return{set,dispose};
}
