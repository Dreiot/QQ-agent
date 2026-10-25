import {formatDuration} from './metrics.js';

export function formatWaitDeadline(until,now=Date.now()) {
  const value=Number(until);if(!Number.isFinite(value)||value<=now)return '等待调度…';
  return `等待 ${((value-now)/1000).toFixed(1)} 秒`;
}

// Presentation and read-only reconciliation are independent default UI policy.
// Expired clocks do not claim the backend has started a run.
export function installSessionActivity({list,detail=null,getSessions,refresh}) {
  const doc=list.ownerDocument,view=doc.defaultView;let disposed=false,frame=null,nodes=[],refreshing=null,again=false;
  const roots=[list,detail].filter(Boolean);
  const clocks=new WeakMap(),deadlines=new Map();
  function reconcile(){
    if(disposed||doc.hidden)return Promise.resolve();if(refreshing){again=true;return refreshing;}
    refreshing=Promise.resolve().then(()=>{if(!disposed&&!doc.hidden)return refresh();}).finally(()=>{refreshing=null;if(again){again=false;void reconcile().catch(()=>{});}});return refreshing;
  }
  function stop(){if(frame!==null)view.cancelAnimationFrame(frame);frame=null;}
  function nextFrame(){frame=null;paint();}
  function paint(){
    if(disposed||doc.hidden){stop();return;}
    const now=Date.now(),mono=view.performance.now();let future=false;
    for(const {node,until,start,base} of nodes){
      if(!node.isConnected)continue;
      let text;
      if(start!=null&&Number.isFinite(start)){
        let clock=clocks.get(node);
        if(!clock||clock.start!==start){clock={start,base:Math.max(base,now-start,0),at:mono};clocks.set(node,clock);}
        const elapsed=clock.base+Math.max(0,mono-clock.at);if(base>elapsed){clock.base=base;clock.at=mono;}
        text=`用时 ${formatDuration(Math.max(base,elapsed))}`;future=true;
      }else{
        let clock=deadlines.get(until);
        if(!clock){clock={base:until-now,at:mono};deadlines.set(until,clock);}
        const remaining=clock.base-Math.max(0,mono-clock.at);
        text=formatWaitDeadline(remaining,0);if(Number.isFinite(remaining)&&remaining>0)future=true;
      }
      if(node.textContent!==text)node.textContent=text;
    }
    if(!future)stop();else if(frame===null)frame=view.requestAnimationFrame(nextFrame);
  }
  function sync(){if(disposed)return;nodes=roots.flatMap(root=>[...root.querySelectorAll('[data-wait],[data-elapsed-start]')]).filter(node=>!node.closest('[hidden]')).map(node=>({node,until:Number(node.dataset.wait),start:node.hasAttribute('data-elapsed-start')?Number(node.dataset.elapsedStart):null,base:Math.max(0,Number(node.dataset.elapsedBase)||0)}));const live=new Set(nodes.filter(item=>item.start===null).map(item=>item.until));for(const until of deadlines.keys())if(!live.has(until))deadlines.delete(until);paint();}
  const observer=new view.MutationObserver(records=>{
    // Updating a countdown's text node is not a structural list change.
    if(records.some(r=>r.type==='attributes'||[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1)))sync();
  });
  for(const root of roots)observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-wait','data-elapsed-start','data-elapsed-base','hidden']});
  const heartbeat=()=>{if(!disposed&&!doc.hidden)void reconcile().catch(()=>{});};
  const visibility=()=>{stop();sync();if(!doc.hidden)heartbeat(true);};doc.addEventListener('visibilitychange',visibility);
  function dispose(){if(disposed)return;disposed=true;stop();observer.disconnect();doc.removeEventListener('visibilitychange',visibility);view.removeEventListener('pagehide',dispose);nodes=[];deadlines.clear();}
  view.addEventListener('pagehide',dispose,{once:true});sync();return {sync,heartbeat,dispose};
}
