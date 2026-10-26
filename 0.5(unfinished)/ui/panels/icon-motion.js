// Native continuous loops; no timers, animation-frame loop, or idle tail.
import { LIFE_EMBLEM_FRAMES } from './life-emblem.js';
const installed = new WeakMap();
const OWNER='button,a[href],[role="button"],[role="link"],[role="tab"],[data-icon-active]';
const SELECTED=['button','a[href]','[role="button"]','[role="link"]','[role="tab"]'].flatMap(selector=>[selector+'[aria-current="page"]',selector+'[aria-selected="true"]']).concat('[data-icon-active="true"]').join(',');
const FOCUS_OWNER='[role="tab"],#nav button[data-panel],#settings-sidebar a[data-target],[data-icon-focus="true"]';
const SIGNALS=new Set(['aria-current','aria-selected','data-icon-active','data-icon-focus','role','href']);
const HIDDEN='[hidden],.hidden,.is-hidden,dialog:not([open])';
const MAX_OWNER_ICONS=4,MAX_DOCUMENT_ICONS=8,MAX_DOCUMENT_EFFECTS=24;
const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
function hiddenByClosedDetails(node){
  let child=node;
  for(let parent=node?.parentElement;parent;child=parent,parent=parent.parentElement){
    if(parent.tagName!=='DETAILS'||parent.open)continue;
    const summary=[...parent.children].find(element=>element.tagName==='SUMMARY');
    if(child!==summary)return true;
  }
  return false;
}
function plans(icon,scale){
  const role=(name)=>icon.querySelector('[data-icon-role="'+name+'"]')||icon;
  // Sine samples meet at the same position and velocity. No opacity changes,
  // repeated held frames, start delay, or post-gesture waiting period.
  const wave=(name,transform,phase=0,duration=1800)=>({target:role(name),duration,frames:Array.from({length:33},(_,i)=>({offset:i/32,transform:transform(Math.sin(i/32*Math.PI*2+phase),scale)}))});
  const x=(name,amount=1.7,phase=0,duration=1800)=>wave(name,(n,s)=>'translateX('+(n*amount*s).toFixed(4)+'px)',phase,duration);
  const y=(name,amount=1.5,phase=0,duration=1800)=>wave(name,(n,s)=>'translateY('+(n*amount*s).toFixed(4)+'px)',phase,duration);
  const turn=(name,degrees=12,duration=2000)=>wave(name,(n,s)=>'rotate('+(n*degrees*s).toFixed(4)+'deg)',0,duration);
  const grow=(name,amount=.12,phase=0,duration=1800)=>wave(name,(n,s)=>'scale('+(1-(n+1)*amount*s/2).toFixed(4)+')',phase,duration);
  switch(icon.dataset.iconMotion){
    case 'rules':return[grow('nodes',.18,0,2000)];
    case 'sessions':return[x('cursor',1.35)];
    case 'chats':return[y('message',1.35)];
    case 'memory':return[turn('portrait',14)];
    case 'usage':return ['meter-a','meter-b','meter-c'].map((name,i)=>wave(name,(n,s)=>'scaleY('+(1-(n+1)*.24*s).toFixed(4)+')',i*Math.PI*2/3,1700));
    case 'skills':return[turn('tool',12),grow('marks',.25,Math.PI)];
    case 'plugins':return[x('contacts',2.4)];
    case 'logs':return[x('records',1.2)];
    case 'settings':return ['control-a','control-b','control-c'].map((name,i)=>x(name,[2.2,-2.2,3][i],i*Math.PI*2/3,2000));
    case 'community':return[y('avatar',1.35),grow('identity',.25,Math.PI)];
    case 'model':return[grow('network',.18),grow('nodes',.25,Math.PI)];
    case 'shield':return[grow('lock',.18),grow('keyhole',.3,Math.PI)];
    case 'globe':return[grow('meridians',.2)];
    case 'smile':return[y('expression',.8)];
    case 'activity':return[x('cursor',1.2)];
    case 'emblem':return[{target:role('cells'),duration:1000,frames:LIFE_EMBLEM_FRAMES.map((d,index)=>({offset:index/8,d:`path("${d}")`,easing:'steps(1,end)'}))}];
    case 'archive':return[x('payload',1.8)];
    case 'panel':return[grow('anchor',.4)];
    case 'menu':return[grow('rails',.18)];
    case 'arrow':return[x('direction',1.6)];
    case 'arrow-up':return[y('direction',-1.2)];
    case 'arrow-down':return[y('direction',1.2)];
    case 'chevron':return[y('direction',1.8)];
    case 'check':return[grow('direction',.14)];
    case 'close':return[turn('direction',12)];
    case 'search':return[grow('lens',.15)];
    case 'refresh':return[turn('forward',20),turn('return',20)];
    case 'undo':return[x('direction',.8)];
    case 'plus':return[turn('direction',20)];
    case 'trash':return[y('slots',1.2)];
    case 'pause':return[grow('bars',.15)];
    case 'play':return[x('direction',1.1)];
    case 'upload':return[y('direction',1.1)];
    case 'folder':return[x('records',1.4)];
    case 'link':return[turn('join',15)];
    case 'copy':return[grow('sheet',.12)];
    case 'save':return[grow('slot',.25)];
    case 'info':return[y('dot',1.15)];
    case 'warning':return[grow('mark',.18)];
    case 'clock':return[turn('hands',20)];
    case 'loading':return[{target:icon,duration:1400,frames:[{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}]}];
    case 'sun':return[turn('rays',13),grow('core',.2,Math.PI)];
    case 'moon':return[turn('crescent',12)];
    case 'contrast':return[grow('half',.18)];
    case 'status-onebot-ready':return[grow('bridge',.2),grow('ready',.18,Math.PI)];
    case 'status-onebot-pending':return[grow('bridge',.2),turn('gap',18)];
    case 'status-model-ready':return[grow('nodes',.14),grow('ready',.18,Math.PI)];
    case 'status-model-pending':return[grow('nodes',.14),turn('gap',18)];
    default:return[grow('shell',.15)];
  }
}
/** Selection or visible keyboard focus on a page tab opts in. Ordinary actions
 * remain still. Disposing cancels effects without changing DOM selection. */
export function installIconMotion(doc=typeof document!=='undefined'?document:null){
  if(!doc?.addEventListener||!doc.defaultView)return()=>{};
  if(installed.has(doc))return installed.get(doc);
  const view=doc.defaultView,media=view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const selectedOwners=new Set(),states=new Map(),runningIcons=new Map();
  let disposed=false,observer,effectCount=0;
  const focused=owner=>owner?.matches?.(FOCUS_OWNER)&&owner.matches(':focus-visible');
  const selected=owner=>owner?.matches?.(SELECTED)||focused(owner);
  const allowed=()=>!disposed&&doc.visibilityState!=='hidden'&&!media?.matches&&!['off','false'].includes(doc.body?.dataset.iconMotion);
  const eligible=node=>node?.isConnected&&!node.matches?.(':disabled,[aria-disabled="true"]')&&!node.closest?.(HIDDEN)&&!hiddenByClosedDetails(node);
  const rendered=node=>{
    if(node?.namespaceURI!=='http://www.w3.org/2000/svg'||node.localName==='svg')return node?.checkVisibility?.({visibilityProperty:true})!==false;
    for(let current=node;current;current=current.parentElement){
      const style=view.getComputedStyle?.(current);
      if(style?.display==='none'||style?.visibility==='hidden'||style?.visibility==='collapse')return false;
      if(current.localName==='svg')return current.checkVisibility?.({visibilityProperty:true})!==false;
    }
    return true;
  };
  const configuration=icon=>{
    const style=view.getComputedStyle(icon),emblem=icon.dataset.iconMotion==='emblem';
    // Cell generations have their own cadence; navigation icon preferences
    // cannot accidentally accelerate or freeze the brand's discrete playback.
    const scale=emblem?1:clamp(style.getPropertyValue('--icon-motion-scale')||1,0,1.8,1);
    const speed=emblem?clamp(style.getPropertyValue('--brand-motion-speed')||1,.25,2,1):clamp(style.getPropertyValue('--icon-motion-speed')||1,.5,2,1);
    return{scale,speed,key:scale+'|'+speed};
  };
  const ownerOf=icon=>icon.closest?.(OWNER);
  const stopIcon=(owner,icon)=>{
    const state=states.get(owner);if(!state)return;
    for(const [animation,effect] of state.effects){if(effect.icon!==icon)continue;state.effects.delete(animation);--effectCount;try{animation.cancel();}catch{}}
    if(runningIcons.get(icon)===owner)runningIcons.delete(icon);
  };
  const stop=owner=>{if(!states.has(owner))return;for(const icon of runningIcons.keys())if(runningIcons.get(icon)===owner)stopIcon(owner,icon);states.delete(owner);};
  const stopAll=()=>{for(const owner of states.keys())stop(owner);};
  const track=owner=>{if(owner?.isConnected&&selected(owner))selectedOwners.add(owner);else{selectedOwners.delete(owner);stop(owner);}};
  const discover=node=>{if(node?.nodeType!==1&&node!==doc)return;if(node.matches?.(SELECTED)||focused(node))track(node);for(const owner of node.querySelectorAll?.(SELECTED)||[])track(owner);};
  const play=owner=>{
    if(!allowed()||!selected(owner)||!eligible(owner)||!rendered(owner))return;
    let state=states.get(owner),count=0;
    const icons=owner.matches?.('.qq-icon[data-icon-motion]')?[owner]:owner.querySelectorAll('.qq-icon[data-icon-motion]');
    for(const icon of icons){
      if(ownerOf(icon)!==owner||!eligible(icon)||!rendered(icon))continue;
      if(count++>=MAX_OWNER_ICONS)break;
      if(runningIcons.has(icon)||runningIcons.size>=MAX_DOCUMENT_ICONS)continue;
      const config=configuration(icon);if(!config.scale)continue;
      for(const plan of plans(icon,config.scale).slice(0,3)){
        if(effectCount>=MAX_DOCUMENT_EFFECTS)break;
        if(typeof plan.target.animate!=='function'||!rendered(plan.target))continue;
        let animation;
        try{animation=plan.target.animate(plan.frames,{duration:plan.duration/config.speed,easing:'linear',iterations:Infinity,fill:'none'});}catch{continue;}
        if(!state){state={effects:new Map()};states.set(owner,state);}
        state.effects.set(animation,{icon,target:plan.target,key:config.key});++effectCount;runningIcons.set(icon,owner);
        const finish=()=>{if(!state.effects.delete(animation))return;--effectCount;if(![...state.effects.values()].some(effect=>effect.icon===icon)&&runningIcons.get(icon)===owner)runningIcons.delete(icon);};
        animation.finished?.then(finish,finish);
      }
    }
  };
  const sync=()=>{
    if(!allowed()){stopAll();return;}
    for(const owner of selectedOwners)if(!owner.isConnected||!selected(owner))track(owner);
    for(const [owner,state] of states){
      if(!selectedOwners.has(owner)||!eligible(owner)||!rendered(owner)){stop(owner);continue;}
      const visibleIcons=new Map();
      for(const {icon,target,key} of state.effects.values()){
        if(!visibleIcons.has(icon))visibleIcons.set(icon,ownerOf(icon)===owner&&eligible(icon)&&rendered(icon)&&configuration(icon).key===key);
        if(!visibleIcons.get(icon)||!target.isConnected||!rendered(target))stopIcon(owner,icon);
      }
    }
    for(const owner of selectedOwners)play(owner);
  };
  const focusChanged=()=>{for(const owner of selectedOwners)track(owner);const owner=doc.activeElement?.closest?.(OWNER);if(owner)track(owner);sync();};
  const modalityChanged=()=>queueMicrotask(focusChanged);
  const changed=records=>{
    let relevant=false;
    for(const record of records){
      if(record.type==='attributes'&&SIGNALS.has(record.attributeName)){track(record.target);relevant=true;}
      else if(record.type==='childList'){for(const node of record.addedNodes)if(node.nodeType===1){discover(node);relevant=true;}if([...record.removedNodes].some(node=>node.nodeType===1))relevant=true;}
      else if(record.target===doc.body||record.target===doc.documentElement||[...selectedOwners].some(owner=>record.target===owner||record.target.contains?.(owner)||owner.contains?.(record.target)))relevant=true;
    }
    if(relevant)sync();
  };
  const cleanup=()=>{
    if(disposed)return;disposed=true;stopAll();selectedOwners.clear();observer?.disconnect();
    doc.removeEventListener('visibilitychange',sync);doc.removeEventListener('focusin',focusChanged);doc.removeEventListener('focusout',modalityChanged);doc.removeEventListener('keydown',modalityChanged);doc.removeEventListener('pointerdown',modalityChanged);
    view.removeEventListener('resize',sync);view.removeEventListener('pagehide',cleanup);media?.removeEventListener?.('change',sync);installed.delete(doc);
  };
  doc.addEventListener('visibilitychange',sync);doc.addEventListener('focusin',focusChanged);doc.addEventListener('focusout',modalityChanged);doc.addEventListener('keydown',modalityChanged);doc.addEventListener('pointerdown',modalityChanged);
  view.addEventListener('resize',sync);view.addEventListener('pagehide',cleanup,{once:true});media?.addEventListener?.('change',sync);
  if(view.MutationObserver){observer=new view.MutationObserver(changed);observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-current','aria-selected','data-icon-active','data-icon-focus','data-icon-motion','role','href','disabled','aria-disabled','hidden','open','class','style','data-sidebar','data-rail-collapsed']});}
  installed.set(doc,cleanup);discover(doc);sync();return cleanup;
}
