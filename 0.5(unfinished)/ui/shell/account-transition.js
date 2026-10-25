// Runs in <head> before the first paint. Browser-owned snapshots stay in RAM;
// no account content or credentials are copied into storage or another scope.
(() => {
  const root=document.documentElement;
  const handoffKey='qq-agent.account-handoff.v1';
  let transition=null,timer=0,contentReady=false,revealFrame=0;
  function account(url){
    try{
      const value=new URL(url,location.href),ids=value.searchParams.getAll('account');
      if(value.origin!==location.origin||!['/','/index.html'].includes(value.pathname)||ids.length>1)return null;
      const id=ids[0]||'primary';
      return id==='primary'||/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)?id.toLowerCase():null;
    }catch{return null;}
  }
  function switchesAccount(from,to){const previous=account(from),next=account(to);return previous!==null&&next!==null&&previous!==next;}
  function consumeHandoff(){
    try{
      const value=JSON.parse(sessionStorage.getItem(handoffKey)||'null');sessionStorage.removeItem(handoffKey);
      if(!value||typeof value.from!=='string'||typeof value.to!=='string'||!Number.isFinite(value.at)||Date.now()-value.at<0||Date.now()-value.at>10000)return false;
      const from=account('/?account='+encodeURIComponent(value.from)),to=account('/?account='+encodeURIComponent(value.to));
      return from!==null&&to===account(location.href)&&from!==to;
    }catch{return false;}
  }
  function reveal(state='ready'){
    clearTimeout(timer);cancelAnimationFrame(revealFrame);root.inert=false;
    root.dataset.accountHandoffState=state;delete root.dataset.accountHandoff;
    transition?.skipTransition();transition=null;
  }
  window.addEventListener('pageswap',event=>{
    if(!event.viewTransition)return;
    event.viewTransition.ready.catch(()=>{});
    if(!switchesAccount(location.href,event.activation?.entry?.url)){event.viewTransition.skipTransition();return;}
    // no-referrer deliberately hides navigation.activation.from. Pass only a
    // short-lived pair of account IDs, never URLs, snapshots or editor data.
    try{sessionStorage.setItem(handoffKey,JSON.stringify({from:account(location.href),to:account(event.activation.entry.url),at:Date.now()}));}catch{}
    root.dataset.accountHandoff='outgoing';
  });
  window.addEventListener('pagereveal',event=>{
    const pending=consumeHandoff();
    if(!event.viewTransition)return;
    event.viewTransition.ready.catch(()=>{});
    const from=window.navigation?.activation?.from?.url;
    if(!(from&&switchesAccount(from,location.href))&&!pending){event.viewTransition.skipTransition();return;}
    transition=event.viewTransition;root.dataset.accountHandoff='incoming';root.dataset.accountHandoffState='waiting';root.inert=true;
    // The target may be a trusted replacement which has no content-ready hook.
    // Always release the old view rather than leave it covering an error page.
    timer=setTimeout(()=>reveal('timeout'),6500);
    transition.finished.finally(()=>{if(transition)reveal('finished');}).catch(()=>{});
    if(contentReady)revealFrame=requestAnimationFrame(()=>reveal());
  });
  window.addEventListener('qqa-account-content-ready',()=>{
    contentReady=true;
    if(transition)revealFrame=requestAnimationFrame(()=>reveal());
  });
  window.addEventListener('pagehide',()=>{clearTimeout(timer);cancelAnimationFrame(revealFrame);});
})();
