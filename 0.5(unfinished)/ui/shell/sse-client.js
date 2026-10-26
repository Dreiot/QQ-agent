import {currentAccountScope} from '../panels/account-scope.js';

const EVENT_NAMES=['hello','accounts','session-start','session-update','session-delta','price-update','blocklist-sync','management-update','session-end','chat-update','memory-update','onebot-status','local-protocols','protocol-login','status','feedback','vision-scan','permission-ask','permission-decision','log','plugin-loaded','plugin-unloaded','plugin-error'];

export class SseClient {
  constructor({token='',base=currentAccountScope.base,endpoint='/api/events',onEvent=()=>{},onState=()=>{},retryDelay=1500,recoverAuth=null}={}) {
    this.token=token; this.onEvent=onEvent; this.onState=onState; this.retryDelay=retryDelay; this.recoverAuth=recoverAuth;
    if(typeof endpoint!=='string'||!endpoint.startsWith('/api/')||endpoint.includes('..')||endpoint.includes('?')||endpoint.includes('#'))throw Error('实时事件地址无效');
    Object.defineProperty(this,'url',{value:base+endpoint,enumerable:true});
    this.handlers=new Map(); this.controller=null; this.retryTimer=null; this.closed=true; this.generation=0;
  }
  setToken(token) { this.token=String(token ?? ''); if(!this.closed)this.connect(); }
  connect() { this.close(); this.closed=false; this.open(); return this; }
  on(name,fn) { if(!this.handlers.has(name))this.handlers.set(name,new Set());this.handlers.get(name).add(fn);return()=>this.handlers.get(name).delete(fn); }
  dispatch(name,data) {
    if(!EVENT_NAMES.includes(name))return;
    let payload={}; try { payload=data?JSON.parse(data):{}; } catch {}
    this.onEvent(name,payload); for(const fn of this.handlers.get(name)||[])fn(payload);
  }
  async open() {
    if(this.closed)return;
    const generation=this.generation,controller=new AbortController(),requestToken=this.token;this.controller=controller;let reader;
    const current=()=>!this.closed&&this.generation===generation&&this.controller===controller;
    this.onState('connecting');
    try {
      const response=await fetch(this.url,{headers:{accept:'text/event-stream','x-console-token':requestToken},cache:'no-store',signal:controller.signal});
      if(!current()){await response.body?.cancel?.();return;}
      if(!response.ok){
        let data={};try{data=await response.json();}catch{}
        if(!current())return;
        if(response.status===401&&data.code==='CONSOLE_AUTH_REQUIRED'&&typeof this.recoverAuth==='function'){
          let recovered=false;try{recovered=await this.recoverAuth({token:requestToken});}catch{}
          if(!current())return;
          if(recovered&&this.token!==requestToken){this.connect();return;}
        }
        throw Object.assign(new Error(`SSE 连接失败：HTTP ${response.status}`),{status:response.status});
      }
      if(!response.body)throw new Error('SSE 响应不支持流式读取');
      this.onState('connected');
      reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',eventName='message',data=[],dataLength=0;
      const emit=()=>{if(current()&&data.length)this.dispatch(eventName,data.join('\n'));eventName='message';data=[];dataLength=0;};
      while(current()) {
        const chunk=await reader.read(); if(chunk.done)break;
        if(!current())break;
        buffer+=decoder.decode(chunk.value,{stream:true});
        let newline;
        while((newline=buffer.indexOf('\n'))!==-1) {
          let line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.endsWith('\r'))line=line.slice(0,-1);
          if(!line){emit();continue;} if(line.startsWith(':'))continue;
          const separator=line.indexOf(':');const field=separator===-1?line:line.slice(0,separator);const value=separator===-1?'':line.slice(separator+1).replace(/^ /,'');
          if(field==='event'){if(value.length>256)throw Error('实时事件名称过长');eventName=value;}else if(field==='data'){dataLength+=value.length;if(dataLength>16*1024*1024)throw Error('实时事件超过读取上限');data.push(value);}
        }
        if(buffer.length>16*1024*1024)throw Error('实时事件行超过读取上限');
      }
      emit();
    } catch(error) {
      if(current()&&error.name!=='AbortError')this.onState('reconnecting',error);
    } finally {
      if(reader){try{void reader.cancel?.()?.catch?.(()=>{});}catch{}try{reader.releaseLock?.();}catch{}}
      if(current()){
        this.controller=null;
        this.retryTimer=setTimeout(()=>{if(!this.closed&&this.generation===generation)this.open();},this.retryDelay);
      }
    }
  }
  close() { this.closed=true;++this.generation;clearTimeout(this.retryTimer);this.retryTimer=null;this.controller?.abort();this.controller=null; }
}
