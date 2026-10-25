import http from 'node:http';

const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const deny=(res,status,message)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:message}));};
const CONTROL=/^\/api\/(?:local-protocols(?:\/|$)|accounts(?:\/|$)|console-token(?:\/|$))/;
const requestHeaders=['accept','content-type','content-length','range','if-none-match','if-modified-since','last-event-id'];
const responseHeaders=['content-type','content-length','cache-control','content-range','accept-ranges','etag','last-modified','content-disposition','content-security-policy','x-content-type-options','referrer-policy','access-control-allow-origin','vary'];

// A namespace always names one immutable worker. No global "current account"
// participates in request routing; an old request cannot become another QQ's.
export function createAccountGateway({accounts,getPrimaryBackend,bus,config}={}){
  const active=new Set();let closed=false;
  let primaryToken=config?.get?.()?.server?.token;
  const offToken=config?.onChange?.(()=>{const next=config.get().server?.token;if(next!==primaryToken){primaryToken=next;for(const item of [...active])item.stop();}});
  function close(){closed=true;off?.();offToken?.();for(const item of [...active])item.stop();active.clear();}
  const off=bus?.on?.('accounts',()=>{for(const item of [...active]){const scope=accounts.backend(item.id),backend=item.control?getPrimaryBackend():scope;if(!scope||scope.generation!==item.scopeGeneration||scope.port!==item.scopePort||!backend||backend.generation!==item.generation||backend.port!==item.port)item.stop();}},{internal:true});
  function handle({req,res,pathname,urlObj}){
    if(closed){deny(res,503,'账号网关已停止');return;}
    const match=/^\/accounts\/([^/]+)(\/.*)$/.exec(pathname);
    if(!match||!ID.test(match[1])){deny(res,404,'账号路径无效');return;}
    const id=match[1],inner=match[2];
    if(inner==='/api/console/bootstrap'){deny(res,403,'账号认证仅由主控制台管理');return;}
    if(!inner.startsWith('/api/')&&!inner.startsWith('/panels/')&&!inner.startsWith('/ui/backgrounds/')){deny(res,404,'账号资源路径无效');return;}
    const control=CONTROL.test(inner),scope=accounts.backend(id),backend=control?getPrimaryBackend():scope;
    // Even shared protocol controls require an existing, running account scope.
    if(!scope){deny(res,409,'此账号尚未运行，请先启动');return;}
    if(!backend||!Number.isInteger(backend.port)||backend.port<1||backend.port>65535){deny(res,503,'此账号尚未就绪');return;}
    const search=new URLSearchParams(urlObj.searchParams);search.delete('token');
    const api=inner.startsWith('/api/');
    const limit=/^\/api\/(?:skills\/install|uikit\/background)\/?$/.test(inner)?12*1024**2:/^\/api\/captcha-forward\/?$/.test(inner)?8*1024**2:2*1024**2;
    if(api&&Number(req.headers['content-length'])>limit){req.resume();deny(res,413,'请求体超过该操作的大小上限');return;}
    const headers={};for(const key of requestHeaders)if(req.headers[key]!==undefined)headers[key]=req.headers[key];
    if(!api&&req.headers.origin==='null')headers.origin='null';
    headers['x-console-token']=backend.token;
    let done=false,size=0,upstream;
    const item={id,control,scopeGeneration:scope.generation,scopePort:scope.port,generation:backend.generation,port:backend.port,stop(){if(done)return;done=true;active.delete(item);upstream?.destroy();if(!res.writableEnded)res.destroy();}};
    const cleanup=()=>{done=true;active.delete(item);req.off('data',count);res.off('close',onClose);};
    const onClose=()=>{if(!res.writableEnded)item.stop();else cleanup();};
    const count=chunk=>{size+=chunk.length;if(size>16*1024**2){item.stop();req.destroy();}else if(api&&size>limit){req.unpipe(upstream);upstream.destroy();req.resume();deny(res,413,'请求体超过该操作的大小上限');cleanup();}};
    active.add(item);
    upstream=http.request({hostname:'127.0.0.1',port:backend.port,method:req.method,path:inner+(search.size?'?'+search:''),headers},response=>{
      if(done){response.destroy();return;}
      const outgoing={};for(const key of responseHeaders)if(response.headers[key]!==undefined)outgoing[key]=response.headers[key];
      // Public background URLs are scoped when produced, never interpreted by
      // whichever QQ happens to be visible when an image eventually loads.
      res.writeHead(response.statusCode||502,outgoing);
      response.on('error',()=>item.stop());response.on('end',cleanup);response.pipe(res);
    });
    upstream.on('error',()=>{if(done)return;cleanup();if(res.headersSent)res.destroy();else deny(res,502,'此账号的连接已中断，请检查运行状态');});
    req.on('data',count);req.on('aborted',()=>item.stop());res.on('close',onClose);
    req.pipe(upstream);
  }
  return{handle,close,get activeCount(){return active.size;}};
}
