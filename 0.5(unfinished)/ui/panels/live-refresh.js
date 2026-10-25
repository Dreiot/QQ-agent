// Event-driven snapshot recovery: one read in flight, one trailing read for a
// burst, no background polling. Visibility recovery also covers missed events.
export function createLiveRefresh(run,{delay=80,doc=document}={}){
  let dirty=false,busy=false,timer=null,disposed=false;
  const clear=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
  async function flush(){
    clear();if(disposed||busy||doc.hidden||!dirty)return;
    dirty=false;busy=true;
    try{await run();}catch{/* The panel owns its visible error state. */}
    finally{busy=false;if(dirty)schedule();}
  }
  function schedule(){if(!disposed&&!busy&&!doc.hidden&&timer===null)timer=setTimeout(flush,delay);}
  function request(){if(disposed)return;dirty=true;schedule();}
  const visibility=()=>{clear();if(!doc.hidden)request();};
  doc.addEventListener('visibilitychange',visibility);
  return {request,dispose(){disposed=true;clear();doc.removeEventListener('visibilitychange',visibility);}};
}
