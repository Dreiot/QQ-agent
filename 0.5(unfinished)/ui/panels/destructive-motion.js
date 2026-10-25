// Default data-tearing renderer. Replace this asset through ui.assets to change
// visuals without replacing confirmation state, RPCs, permissions or business.
import {gsap,gsapReady} from './vendor/gsap-runtime.js';
import {createDestructiveSnapshot,mountDestructiveVisual,releaseDestructiveVisual} from './destructive-snapshot.js';
import {interfaceMotion,observeInterfaceMotion} from './motion.js';

const active=new WeakMap();
const noop=()=>Object.freeze({update(){},exit:async()=>{},dispose(){}});
export function createDestructiveMotion(node,{windowMode=false,exitOnly=false}={}){
  const doc=node?.ownerDocument,win=doc?.defaultView;
  if(!doc)return noop();
  // Optional graphics never delay panel-client initialization or RPC event
  // handlers. Queue only the latest visual state while the local engine loads.
  if(!gsap){
    let actual=null,released=false,latest=null;
    const ready=gsapReady.then(()=>{if(released||!node.isConnected)return;actual=gsap?createDestructiveMotion(node,{windowMode,exitOnly}):noop();if(latest)actual.update(...latest);});
    return Object.freeze({update(...args){latest=args;actual?.update(...args);},exit(options){return ready.then(()=>{if(!released)return actual?.exit(options);});},dispose(){released=true;actual?.dispose();}});
  }
  let owners=active.get(doc);if(!owners){owners=new Set();active.set(doc,owners);}
  // Large multi-selection keeps every tint, but bounds composited text copies.
  if(owners.size>=8)return noop();
  const media=win.matchMedia?.('(prefers-reduced-motion: reduce)'),rect=windowMode?{left:0,top:0,right:win.innerWidth,bottom:win.innerHeight,width:win.innerWidth,height:win.innerHeight}:node.getBoundingClientRect();
  let preference=interfaceMotion(doc,media);
  const snapshot=createDestructiveSnapshot(node,rect),fx=doc.createElement('span'),live=doc.createElement('span'),base=doc.createElement('span');
  fx.className=`danger-motion${windowMode?' danger-motion-window':''}${exitOnly?' danger-exit-fragments':''}`;fx.dataset.destructiveVisual='';fx.dataset.phase='charging';fx.setAttribute('aria-hidden','true');fx.inert=true;
  base.className='danger-motion-base';live.className='danger-motion-live';fx.append(base,live);
  const view={amount:0},slices=[],bits=[],shards=[];
  let disposed=false,exiting=false,visible=true,target=0,fade,departure,exitPromise,finishExit,opacityAnimation,intersection;
  const random=(a,b)=>gsap.utils.random(a,b),amplitude=()=>(2+view.amount**1.75*70)*preference.scale;
  for(let i=0;i<8;i++){const part=doc.createElement('span');part.className='danger-motion-slice';part.append(snapshot.cloneNode(true));live.append(part);slices.push(part);}
  for(let i=0;i<18;i++){const bit=doc.createElement('span');bit.className='danger-motion-bit';live.append(bit);bits.push(bit);}
  const cycle=gsap.timeline({paused:true,repeat:-1,repeatRefresh:true});
  slices.forEach((part,i)=>{
    const at=i*.022;
    cycle.set(part,{x:()=>random(-amplitude(),amplitude()),y:0,skewX:0,clipPath:()=>{const top=random(2,87),height=random(2,5+view.amount*14);return `inset(${top}% 0 ${Math.max(0,100-top-height)}% 0)`;},opacity:0},at)
      .to(part,{x:()=>random(-amplitude(),amplitude()),y:()=>random(-8,8)*view.amount**2*preference.scale,skewX:()=>random(-5,5)*view.amount**2*preference.scale,opacity:()=>i<2+Math.floor(view.amount*7)?Math.min(.95,.25+view.amount*.78):0,duration:.075,ease:'steps(2)'},at)
      .to(part,{x:()=>random(-amplitude(),amplitude()),y:()=>random(-12,12)*view.amount**2*preference.scale,opacity:0,duration:.085,ease:'steps(2)'},at+.09);
  });
  bits.forEach((bit,i)=>{
    const at=(i%8)*.021;
    cycle.set(bit,{left:()=>`${random(0,84)}%`,top:()=>`${random(3,95)}%`,width:()=>`${random(3,11+view.amount*23)}%`,height:()=>random(1,3+view.amount*10),x:0,opacity:0},at)
      .to(bit,{x:()=>random(-amplitude(),amplitude()),scaleX:()=>1+(random(.5,1.8)-1)*preference.scale,opacity:()=>i<2+Math.floor(view.amount*18)?random(.2,.75)*(.35+view.amount*.65):0,duration:.065,ease:'steps(2)'},at)
      .to(bit,{x:()=>random(-amplitude()*1.6,amplitude()*1.6),opacity:0,duration:.075,ease:'steps(2)'},at+.08);
  });
  function paint(){
    if(disposed)return;
    fx.dataset.progress=String(view.amount);
    cycle.timeScale((.45+view.amount**1.1*2.9)*(exiting?1.45:1)/Math.max(.01,preference.duration));
    if(view.amount>.001&&preference.enabled&&preference.scale>0&&!doc.hidden&&visible&&node.isConnected)cycle.play();
    else{cycle.pause();gsap.set([...slices,...bits],{opacity:0});}
  }
  function update(progress,{decaying=false}={}){
    if(disposed||exiting||!Number.isFinite(progress))return;
    const next=Math.max(0,Math.min(1,progress));
    if(next===target)return;
    target=next;fade?.kill();
    // Decay is already sampled linearly by the behavioral controller.
    if(decaying||!preference.enabled){view.amount=next;paint();}
    else fade=gsap.to(view,{amount:next,duration:.13*preference.duration,ease:'power2.out',onUpdate:paint});
  }
  function policy(){preference=interfaceMotion(doc,media);if(!preference.enabled||doc.hidden){if(exiting)finishExit?.();else paint();}else paint();}
  const unobservePolicy=observeInterfaceMotion(doc,next=>{preference=next;fade?.kill();if(exiting)finishExit?.();cycle.pause(0).invalidate();gsap.set([...slices,...bits],{opacity:0});});
  function dispose(){
    if(disposed)return;disposed=true;finishExit?.();fade?.kill();departure?.kill();cycle.kill();opacityAnimation?.cancel();intersection?.disconnect();
    unobservePolicy();media?.removeEventListener('change',policy);doc.removeEventListener('visibilitychange',policy);win.removeEventListener('pagehide',dispose);
    gsap.killTweensOf(view);releaseDestructiveVisual(node,fx);owners.delete(api);
  }
  function exit({signal,duration=540}={}){
    if(exitPromise)return exitPromise;
    if(disposed||signal?.aborted||!preference.enabled||doc.hidden)return Promise.resolve();
    exiting=true;fade?.kill();target=view.amount=1;fx.dataset.phase='rupture';paint();
    for(let i=0;i<12;i++){const shard=doc.createElement('span');shard.className='danger-motion-shard';shard.style.clipPath=`inset(${i/12*100}% 0 ${(11-i)/12*100}% 0)`;shard.append(snapshot.cloneNode(true));fx.append(shard);shards.push(shard);}
    exitPromise=new Promise(resolve=>{
      let finished=false,timer=0;
      finishExit=()=>{if(finished)return;finished=true;win.clearTimeout(timer);signal?.removeEventListener('abort',finishExit);departure?.kill();cycle.pause();opacityAnimation?.cancel();resolve();};
      signal?.addEventListener('abort',finishExit,{once:true});
      const scale=Math.max(.65,Math.min(1.5,Number(duration)/540||1))*preference.duration;
      if(!windowMode&&typeof node.animate==='function'){
        opacityAnimation=node.animate([{opacity:1,offset:0},{opacity:1,offset:.72},{opacity:0,offset:1}],{duration:540*scale,easing:'linear',fill:'forwards'});
        opacityAnimation.finished.catch(()=>{});
      }
      departure=gsap.timeline({onComplete:finishExit});
      departure.call(()=>{fx.dataset.phase='shatter';},[],.16)
        .set(base,{opacity:windowMode?0:1},.16)
        .set(shards,{opacity:1,x:0,y:0,scaleX:1},.16)
        .to(live,{opacity:0,duration:.25,ease:'power1.in'},.28);
      shards.forEach((shard,i)=>{
        const direction=i%2?1:-1,at=.16+i*.006;
        departure.to(shard,{x:direction*random(22,48)*preference.scale,y:random(-6,6)*preference.scale,duration:.045,ease:'steps(2)'},at)
          .to(shard,{x:-direction*random(60,120)*preference.scale,y:direction*random(9,18)*preference.scale,scaleX:1+(random(.75,1.2)-1)*preference.scale,duration:.07,ease:'steps(2)'},at+.045)
          .to(shard,{x:direction*random(160,290)*preference.scale,y:random(-28,28)*preference.scale,scaleX:1+(random(.08,.52)-1)*Math.min(1,preference.scale),opacity:0,duration:.20,ease:'power2.in'},at+.115);
      });
      departure.timeScale(1/scale);timer=win.setTimeout(finishExit,650*scale);
    });
    return exitPromise;
  }
  const api=Object.freeze({update,exit,dispose});owners.add(api);
  mountDestructiveVisual(node,fx,{fixed:windowMode});
  if(win.IntersectionObserver&&!windowMode){intersection=new win.IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting!==false;paint();});intersection.observe(node);}
  media?.addEventListener('change',policy);doc.addEventListener('visibilitychange',policy);win.addEventListener('pagehide',dispose,{once:true});
  return api;
}
