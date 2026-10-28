import crypto from 'node:crypto';
import {sharedAppearanceFrom,appearanceDelta,mergeSharedAppearance,applySharedAppearance} from '../../ui/panels/appearance-sharing.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createHostAppearanceSync({config,broadcast=()=>{}}){
  let shared=null,observed=null,applying=false;
  function persist(next){
    const previousShared=shared,previousObserved=observed;
    shared=next;const uikit=applySharedAppearance(config.get().ui?.uikit,shared);observed=sharedAppearanceFrom(uikit);
    applying=true;try{config.update({ui:{sharedAppearance:{__replace__:shared},uikit:{__replace__:uikit}}});}catch(error){shared=previousShared;observed=previousObserved;throw error;}finally{applying=false;}
    broadcast(shared);
  }
  function ensure(seed){if(!shared){const ui=config.get().ui||{};const initial=ui.sharedAppearance?mergeSharedAppearance(ui.sharedAppearance,{}):sharedAppearanceFrom(seed??ui.uikit);persist(initial);}return shared;}
  const off=config.onChange?.(()=>{if(applying||!shared)return;const next=sharedAppearanceFrom(config.get().ui?.uikit),delta=appearanceDelta(observed,next);if(Object.keys(delta).length)persist(mergeSharedAppearance(shared,delta));});
  return {get:ensure,commit(delta){ensure();const next=mergeSharedAppearance(shared,delta);if(!same(next,shared))persist(next);return shared;},close(){off?.();}};
}
export function createWorkerAppearanceSync({config,initial,send,onChange=()=>{},timeoutMs=10000}){
  let shared=mergeSharedAppearance(initial,{}),observed,applying=false,closed=false;const pending=new Map();
  function paint(){let value=shared;for(const entry of pending.values())value=mergeSharedAppearance(value,entry.delta);const uikit=applySharedAppearance(config.get().ui?.uikit,value);observed=sharedAppearanceFrom(uikit);if(!same(uikit,config.get().ui?.uikit)){applying=true;try{config.update({ui:{uikit:{__replace__:uikit}}});}finally{applying=false;}onChange();}}
  paint();
  function enqueue(delta){
    const requestId=crypto.randomUUID();let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});promise.catch(()=>{});
    const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('共用外观尚未保存，请重试。'));},timeoutMs);timer.unref?.();pending.set(requestId,{delta,promise,resolve,reject,timer});send({type:'account.appearance',requestId,delta});
  }
  const off=config.onChange(()=>{if(applying||closed)return;const next=sharedAppearanceFrom(config.get().ui?.uikit),delta=appearanceDelta(observed,next);observed=next;if(Object.keys(delta).length)enqueue(delta);});
  return {
    receive(message){if(closed)return;const own=pending.get(message.requestId);if(own){clearTimeout(own.timer);pending.delete(message.requestId);}if(message.ok===false){own?.reject(Error('共用外观保存失败，请重试。'));return;}if(message.shared){shared=mergeSharedAppearance(message.shared,{});paint();}own?.resolve();},
    async flush(){if(closed)throw Error('账号已关闭');if(!pending.size){const delta=appearanceDelta(shared,sharedAppearanceFrom(config.get().ui?.uikit));if(Object.keys(delta).length)enqueue(delta);}await Promise.all([...pending.values()].map(entry=>entry.promise));},
    close(){closed=true;off();for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('账号已关闭，共用外观保存未确认'));}pending.clear();}
  };
}
