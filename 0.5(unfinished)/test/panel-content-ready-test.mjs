// Real client/host lifecycle with synthetic frames only: no live app or account.
import assert from 'node:assert/strict';
import {RpcBridge} from '../ui/shell/rpc-bridge.js';
import {PanelRegistry} from '../ui/shell/panel-registry.js';

const originals=Object.fromEntries(['window','document','parent','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const tick=()=>new Promise(setImmediate);
let sequence=0;
function fixture({kind='bundled',id='sessions',timeout=50}={}){
  const handlers=new Map(),sent=[],notices=[],loads=[];
  const emit=(type,event={})=>{for(const entry of [...handlers.get(type)||[]]){if(entry.once)handlers.set(type,handlers.get(type).filter(item=>item!==entry));entry.fn(event);}};
  const win={addEventListener(type,fn,options){const entries=handlers.get(type)||[];entries.push({fn,once:options?.once});handlers.set(type,entries);},removeEventListener(type,fn){handlers.set(type,(handlers.get(type)||[]).filter(entry=>entry.fn!==fn));},dispatchEvent:event=>emit(event.type,event)};
  globalThis.window=win;globalThis.document={defaultView:win};globalThis.location={origin:'http://synthetic-content-ready.invalid'};
  const frame={addEventListener(type,fn){if(type==='load')loads.push(fn);},setAttribute(){},remove(){this.removed=true;},contentWindow:{postMessage(message){sent.push(message);queueMicrotask(()=>emit('message',{source:globalThis.parent,origin:location.origin,data:message}));}}};
  const bridge=new RpcBridge({frame,timeout,manifest:{kind,id,title:'Synthetic',permissions:[],api:[]},api:{request(){throw Error('readiness cannot access an API');}}});
  globalThis.parent={postMessage(message){notices.push(message);queueMicrotask(()=>void bridge.handle({source:frame.contentWindow,origin:'null',data:message}));}};
  const message=(method,extras={})=>({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',method,meta:{nonce:bridge.nonce,panel:id},...extras}});
  return{bridge,frame,loads,sent,notices,emit,message,async client(){return import('../ui/panels/panel-client.js?content-ready='+ ++sequence);},close(){bridge.close();emit('pagehide');}};
}
try{
  {
    const f=fixture(),client=await f.client();
    const announcement=client.contentReady();await tick();
    assert.equal(f.notices.length,0,'content notification waits for the existing secure handshake');
    for(const load of f.loads)load();
    assert.equal(await announcement,true);
    assert.deepEqual(await f.bridge.whenContentReady({timeout:100}),{status:'ready'});
    assert.equal(f.bridge.ready,true,'the existing handshake is retained');
    const notices=f.notices.filter(item=>item.method==='panel.contentReady');
    assert.equal(notices.length,1);assert.deepEqual(Object.keys(notices[0]).sort(),['jsonrpc','meta','method']);
    assert.equal(await client.contentReady(),false,'first content notification is idempotent');
    f.close();
  }
  {
    const f=fixture();
    await f.bridge.handle(f.message('panel.contentReady'));
    assert.equal(f.bridge.contentState,null,'content cannot become ready before handshake');
    await f.bridge.handle(f.message('panel.ready'));
    const wrongSource=f.message('panel.contentReady');wrongSource.source={};
    const wrongOrigin=f.message('panel.contentReady');wrongOrigin.origin='http://other.invalid';
    const wrongNonce=f.message('panel.contentReady');wrongNonce.data.meta.nonce='wrong';
    const wrongPanel=f.message('panel.contentReady');wrongPanel.data.meta.panel='settings';
    for(const event of [wrongSource,wrongOrigin,wrongNonce,wrongPanel,f.message('panel.contentReady',{params:{}}),f.message('panel.contentReady',{id:'rpc-not-notification'})])await f.bridge.handle(event);
    assert.deepEqual(await f.bridge.whenContentReady({timeout:1}),{status:'timeout'});
    assert.equal(f.bridge.contentState,null,'a timeout cannot masquerade as accepted content');
    await f.bridge.handle(f.message('panel.contentReady'));
    assert.deepEqual(await f.bridge.whenContentReady(),{status:'ready'},'a later valid render can still announce readiness');
    f.close();
  }
  {
    const f=fixture({kind:'user'});
    assert.deepEqual(await f.bridge.whenContentReady({timeout:1}),{status:'timeout'},'an extension waits for its existing handshake instead of revealing an unloaded frame');
    await f.bridge.handle(f.message('panel.ready'));
    await f.bridge.handle(f.message('panel.contentReady',{id:'unauthorized'}));
    assert.equal(f.sent.at(-1).error.code,-32003,'a plugin does not receive a new host capability');
    assert.deepEqual(await f.bridge.whenContentReady(),{status:'unsupported'});f.close();
  }
  {
    const f=fixture(),waiting=f.bridge.whenContentReady({timeout:15000});f.bridge.close();
    assert.deepEqual(await waiting,{status:'closed'},'closing a frame resolves pending readiness immediately');
    await f.bridge.handle(f.message('panel.ready'));await f.bridge.handle(f.message('panel.contentReady'));
    assert.deepEqual(await f.bridge.whenContentReady(),{status:'closed'},'late old-frame notices cannot revive a closed bridge');f.close();
  }
  {
    const f=fixture(),client=await f.client();for(const load of f.loads)load();await tick();
    await f.bridge.flush();assert.equal(await client.contentReady(),false,'leaving content cannot announce itself as a new screen');f.close();
  }
  {
    const f=fixture();await f.bridge.handle(f.message('panel.ready'));
    const save=f.bridge.flush(),firstId=f.bridge.flushId;
    assert.equal(f.bridge.flush(),save,'concurrent leave callers share one flush');
    await f.bridge.handle(f.message('panel.flushed',{params:{flushId:firstId,ok:true}}));await save;
    await f.bridge.flush();
    assert.equal(f.sent.filter(item=>item.method==='panel.leave').length,1,'successful flush remains idempotent while old content stays visible');
    f.close();
  }
  {
    const f=fixture();await f.bridge.handle(f.message('panel.ready'));
    const failed=f.bridge.flush(),rejected=assert.rejects(failed,/synthetic save failure/);
    await f.bridge.handle(f.message('panel.flushed',{params:{flushId:f.bridge.flushId,ok:false,error:'synthetic save failure'}}));await rejected;
    assert.equal(f.bridge.leaving,false);assert.equal(f.bridge.flushed,false);
    const retry=f.bridge.flush();await f.bridge.handle(f.message('panel.flushed',{params:{flushId:f.bridge.flushId,ok:true}}));await retry;
    assert.equal(f.sent.filter(item=>item.method==='panel.leave').length,2,'failed saves remain retryable');f.close();
  }
  {
    const f=fixture({timeout:1});await f.bridge.handle(f.message('panel.ready'));
    await assert.rejects(f.bridge.flush(),/保存超时/);assert.equal(f.bridge.flushed,false);
    const retry=f.bridge.flush();await f.bridge.handle(f.message('panel.flushed',{params:{flushId:f.bridge.flushId,ok:true}}));await retry;f.close();
  }
  {
    const f=fixture();globalThis.document.createElement=()=>({addEventListener(){},setAttribute(){},remove(){this.removed=true;},contentWindow:{postMessage(){}}});
    const registry=new PanelRegistry({frameHost:{replaceChildren(){}},api:{}});
    assert.deepEqual(await registry.whenContentReady(),{status:'empty'});
    registry.register({id:'usage',kind:'bundled',title:'Usage',permissions:[],api:[]});await registry.mount('usage');
    const old=registry.current.bridge,waiting=registry.whenContentReady({timeout:15000});registry.dispose();
    assert.deepEqual(await waiting,{status:'closed'});assert.equal(old.closed,true);f.close();
  }
  console.log('Panel content readiness: authenticated payload-free notification, real-client handshake, bounded/closed waits, plugin isolation and idempotent/retryable flush passed.');
}finally{
  for(const [key,descriptor]of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
}
