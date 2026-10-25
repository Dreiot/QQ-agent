import {currentAccountScope} from '../panels/account-scope.js';

export class ApiClient {
  constructor({token='',base=currentAccountScope.base,timeout=15000,recoverAuth=null,onTokenChange=null}={}) { this.token=token;Object.defineProperty(this,'base',{value:base,enumerable:true});this.timeout=timeout;this.authVersion=0;this.recoverAuth=recoverAuth;this.onTokenChange=onTokenChange; }
  setToken(token) { const next=String(token ?? '');if(next!==this.token){this.token=next;++this.authVersion;this.onTokenChange?.(next);} }
  async request(method,path,body,query={},options={}) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..')) throw new Error('无效 API 路径');
    if (!['GET','POST','PUT','DELETE','PATCH'].includes(String(method).toUpperCase())) throw new Error('无效 API 方法');
    const url=new URL(this.base+path,location.href);
    for (const [key,value] of Object.entries(query||{})) if (value!==undefined&&value!==null) url.searchParams.set(key,String(value));
    for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    const requestToken=this.token;
    const requestVersion=this.authVersion;
    const abort=()=>controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const ceiling=String(method).toUpperCase()==='POST'&&path==='/api/market/install'?180000:130000;
    const timeout=Number.isFinite(options.timeout)&&options.timeout>0?Math.min(options.timeout,ceiling):this.timeout;
    const timer=setTimeout(()=>controller.abort(new DOMException('请求超时','TimeoutError')),timeout);
    try {
      if(controller.signal.aborted)throw controller.signal.reason??new DOMException('已取消','AbortError');
      const response=await fetch(url,{method,headers:{accept:'application/json','content-type':'application/json','x-console-token':requestToken},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,keepalive:options.keepalive===true});
      const data=await response.json().catch(()=>({error:'响应不是 JSON'}));
      if(controller.signal.aborted)throw controller.signal.reason??new DOMException('已取消','AbortError');
      const message=response.status===503?`当前运行环境未提供该能力${data.error||data.message?`：${data.error||data.message}`:''}`:data.error||data.message||`HTTP ${response.status}`;
      if (!response.ok){
        const error=Object.assign(new Error(message),{status:response.status,data,credentialCurrent:requestVersion===this.authVersion});
        // Only the shared shell connection opts in. Candidate credentials must
        // fail honestly, and a business handler's 401 must never replay a write.
        if(attempt===0&&response.status===401&&data.code==='CONSOLE_AUTH_REQUIRED'&&typeof this.recoverAuth==='function'){
          let recovered=false;
          if(error.credentialCurrent){try{recovered=await this.recoverAuth({token:requestToken,version:requestVersion});}catch{}}
          else recovered=true; // A newer credential already owns this client.
          error.credentialCurrent=requestVersion===this.authVersion;
          if(controller.signal.aborted)throw controller.signal.reason??new DOMException('已取消','AbortError');
          if(!error.credentialCurrent)recovered=true;
          if(recovered)continue;
        }
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); }
    }
  }
  get(path,query) { return this.request('GET',path,undefined,query); }
  post(path,body) { return this.request('POST',path,body); }
  delete(path,body) { return this.request('DELETE',path,body); }
}
