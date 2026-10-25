// Application-wide account metadata is separate from each account's private
// message/session stream. A background selector never subscribes to another QQ.
export function registerAccountRoutes(http,{accounts,bus,config}={}){
  http.route('GET','/api/accounts',()=>accounts.snapshot());
  for(const action of ['start','stop'])http.route('POST','/api/accounts/'+action,async({body})=>{await accounts[action](body?.id);return accounts.snapshot();});
  http.route('POST','/api/accounts/remove',async({body})=>{if(typeof accounts.remove!=='function')throw Object.assign(new Error('当前账号管理实现不支持移除账号。'),{status:501,expose:true});await accounts.remove(body);return accounts.snapshot();});
  http.route('GET','/api/accounts/events',({req,res})=>{
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});
    let closed=false,timer=null,revision=0;
    const write=()=>{timer=null;if(closed||res.destroyed)return;if(res.writableLength>65536){res.destroy();return;}res.write('event: accounts\ndata: '+JSON.stringify({revision:++revision})+'\n\n');};
    const changed=()=>{if(!timer&&!closed){timer=setTimeout(write,80);timer.unref?.();}};
    const offs=['accounts','onebot.status','status'].map(name=>bus.on(name,changed,{internal:true}));
    const initialToken=config?.get?.()?.server?.token;
    const offToken=config?.onChange?.(()=>{if(config.get().server?.token!==initialToken)res.end();});
    const ping=setInterval(()=>{if(!closed&&!res.destroyed)res.write(': ping\n\n');},15000);ping.unref?.();
    const cleanup=()=>{if(closed)return;closed=true;clearTimeout(timer);clearInterval(ping);offToken?.();for(const off of offs)off?.();};
    res.once('close',cleanup);req.once('aborted',cleanup);write();
  });
}
