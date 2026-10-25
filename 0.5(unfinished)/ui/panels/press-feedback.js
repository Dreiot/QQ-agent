// A temporary outline outside the pressed control, independent of its layout,
// overflow clipping, selected state and business handlers. No permanent RAF loop.
const PRESSABLE = 'button,summary,[role="button"],[role="switch"],[role="radio"],[role="tab"],input[type="checkbox"],input[type="radio"],label,.settings-sidebar a,.tabs a';
const BLOCKED = '[disabled],[aria-disabled="true"],[inert],[hidden],dialog:not([open]),[data-motion="off"]';
const NOOP = {dispose(){},cancelWithin(){},cancelWhere(){}};

/** Bounded paint preferences shared by shell and sandboxed panels. */
export function ripplePreferences(doc) {
  const style=doc?.defaultView?.getComputedStyle?.(doc.documentElement);
  const number=(name,fallback,min,max)=>{
    const value=style?.getPropertyValue(name)?.trim(),parsed=Number.parseFloat(value);
    return value&&Number.isFinite(parsed)?Math.max(min,Math.min(max,parsed)):fallback;
  };
  const paint=style?.getPropertyValue('--ripple-color')?.trim()||'';
  return {
    enabled:doc?.body?.dataset?.rippleMotion!=='off',
    color:/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(paint)?paint:'',
    spread:number('--ripple-spread',8,0,32),speed:number('--ripple-speed',1,.25,3),
  };
}

export function installPressFeedback(root, {readPolicy} = {}) {
  const doc=root?.nodeType===9?root:root?.ownerDocument,view=doc?.defaultView;
  if(!doc?.createElement||!view||!readPolicy)return NOOP;
  const active=new Map();
  let layer,disposed=false;
  const contains=node=>root===doc||root===node||root.contains?.(node);
  function release(ring){
    if(!active.has(ring))return;
    active.delete(ring);ring.remove();
    if(!active.size){layer?.hidePopover?.();layer?.remove();layer=null;}
  }
  function cancelWhere(predicate){
    for(const [ring,item] of [...active])if(predicate(item.target)){
      item.animation.cancel();release(ring);
    }
  }
  const cancelWithin=node=>cancelWhere(target=>!node||node===target||node.contains?.(target));
  function targetFor(event){
    let target=event.target?.closest?.(PRESSABLE);
    if(!target||!contains(target))return null;
    if(target.tagName==='INPUT')target=target.closest('label')||target;
    if(target.tagName==='LABEL'){
      const input=target.control||target.querySelector('input[type="checkbox"],input[type="radio"]');
      if(!input||!['checkbox','radio'].includes(input.type)||input.disabled)return null;
    }
    if(target.closest(BLOCKED)||target.matches(':disabled')||!target.getClientRects().length)return null;
    return target;
  }
  function press(event){
    if(disposed||doc.visibilityState==='hidden')return;
    if(event.type==='pointerdown'&&(event.button!==0||event.isPrimary===false))return;
    if(event.type==='keydown'&&(event.repeat||!['Enter',' '].includes(event.key)))return;
    const target=targetFor(event);if(!target)return;
    if(event.type==='keydown'){
      // Text editing (including a nested input) and non-activating keys stay native.
      if(event.target.matches?.('textarea,select,input:not([type="checkbox"]):not([type="radio"])'))return;
      if(event.key==='Enter'&&target.tagName==='LABEL')return;
      if(event.key===' '&&target.tagName==='A')return;
    }
    const policy=readPolicy(),preferences=ripplePreferences(doc);
    if(!policy.enabled||policy.scale<=0||!preferences.enabled||preferences.spread<=0)return;
    const rect=target.getBoundingClientRect(),style=view.getComputedStyle(target);
    if(rect.width<=0||rect.height<=0)return;
    cancelWithin(target);
    while(active.size>=8){const [ring,item]=active.entries().next().value;item.animation.cancel();release(ring);}
    if(!layer){
      layer=doc.createElement('div');layer.className='press-feedback-layer';
      layer.setAttribute('aria-hidden','true');layer.setAttribute('popover','manual');
      doc.body.append(layer);
      try{layer.showPopover?.();}catch{/* Older engines still use a fixed overlay. */}
    }
    const ring=doc.createElement('span');ring.className='press-feedback-ring';
    const color=preferences.color||style.getPropertyValue(target.classList.contains('danger')?'--bad':'--accent').trim()||style.color;
    Object.assign(ring.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,borderRadius:style.borderRadius,color});
    layer.append(ring);
    const spread=preferences.spread*Math.min(2,policy.scale),radii=style.borderRadius.split(' ').map(value=>`${(parseFloat(value)||0)+spread}px`).join(' ');
    let animation;
    try{
      animation=ring.animate([
        {opacity:.55,left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,borderRadius:style.borderRadius},
        {opacity:0,left:`${rect.left-spread}px`,top:`${rect.top-spread}px`,width:`${rect.width+spread*2}px`,height:`${rect.height+spread*2}px`,borderRadius:radii},
      ],{duration:420*policy.duration/preferences.speed,easing:'cubic-bezier(.12,.65,.25,1)',fill:'both'});
    }catch{ring.remove();if(!active.size){layer?.hidePopover?.();layer?.remove();layer=null;}return;}
    active.set(ring,{target,animation});
    animation.finished.then(()=>release(ring),()=>release(ring));
  }
  const cancelAll=()=>cancelWithin();
  const visibility=()=>{if(doc.visibilityState==='hidden')cancelAll();};
  let previousPreferences=JSON.stringify(ripplePreferences(doc));
  const preferencesObserver=view.MutationObserver?new view.MutationObserver(()=>{
    const next=JSON.stringify(ripplePreferences(doc));
    if(next!==previousPreferences){previousPreferences=next;cancelAll();}
  }):null;
  for(const target of [doc.documentElement,doc.body])if(target)preferencesObserver?.observe(target,{attributes:true,attributeFilter:['style','class','data-ripple-motion']});
  root.addEventListener('pointerdown',press,true);root.addEventListener('keydown',press,true);
  root.addEventListener('pointercancel',cancelAll,true);
  doc.addEventListener('scroll',cancelAll,true);doc.addEventListener('visibilitychange',visibility);
  view.addEventListener('resize',cancelAll);
  return {cancelWithin,cancelWhere,dispose(){
    if(disposed)return;disposed=true;cancelAll();
    preferencesObserver?.disconnect();
    root.removeEventListener('pointerdown',press,true);root.removeEventListener('keydown',press,true);
    root.removeEventListener('pointercancel',cancelAll,true);
    doc.removeEventListener('scroll',cancelAll,true);doc.removeEventListener('visibilitychange',visibility);
    view.removeEventListener('resize',cancelAll);
  }};
}
