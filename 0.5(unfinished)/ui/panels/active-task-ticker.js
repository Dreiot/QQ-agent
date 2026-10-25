// Default task scheduler: idle and hidden panels do not own a ticking interval.
// A late poll cannot start a new interval after disposal.
export function createActiveTaskTicker({active,tick,poll=null,interval=1000,pollEvery=2}) {
  let timer=null,disposed=false,pollBusy=false,ticks=0,scheduledInterval=null;
  function stop(){if(timer!==null)clearInterval(timer);timer=null;ticks=0;scheduledInterval=null;}
  function refresh(){
    if(!poll||disposed||pollBusy||document.hidden||!active())return;
    pollBusy=true;
    Promise.resolve().then(()=>{if(!disposed&&active())return poll();}).catch(()=>{}).finally(()=>{pollBusy=false;sync();});
  }
  function pulse(){
    if(disposed||document.hidden||!active()){stop();return;}
    tick();if(++ticks%pollEvery===0)refresh();
  }
  function sync(){
    if(disposed||document.hidden||!active()){stop();return;}
    const requested=Number(typeof interval==='function'?interval():interval);
    const duration=Number.isFinite(requested)&&requested>0?Math.min(2147483647,Math.max(1,Math.floor(requested))):1000;
    if(timer!==null&&duration!==scheduledInterval)stop();
    if(timer===null){scheduledInterval=duration;timer=setInterval(pulse,duration);}
  }
  function visibility(){stop();sync();if(!document.hidden&&active()){tick();refresh();}}
  function dispose(){if(disposed)return;disposed=true;stop();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',dispose);}
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',dispose,{once:true});
  sync();return {sync,dispose};
}
