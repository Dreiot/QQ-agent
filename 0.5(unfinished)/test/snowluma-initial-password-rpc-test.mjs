import assert from 'node:assert/strict';
import {RpcBridge} from '../ui/shell/rpc-bridge.js';

const savedWindow=globalThis.window;
globalThis.window={addEventListener(){},removeEventListener(){}};
const password='d1e2f30415263748';
function fixture({kind='bundled',id='settings',permitted=true,writeFailure=false,held=false}={}){
  const sent=[],calls=[],copies=[],notices=[];let release;
  const pending=held?new Promise(resolve=>{release=resolve;}):null;
  const frame={contentWindow:{postMessage:message=>sent.push(message)},addEventListener(){}};
  const api={request:async(method,path,body)=>{
    calls.push({method,path,body});
    if(path.endsWith('/initial-password')){await pending;return{password};}
    return{sessionId:'current-view',provider:'snowluma',source:'managed',hasInitialPassword:true};
  }};
  const bridge=new RpcBridge({frame,api,manifest:{id,kind,api:permitted?[{method:'GET',path:'/api/local-protocols/login'},{method:'POST',path:'/api/local-protocols/login/initial-password'}]:[]},
    writeClipboard:async value=>{if(writeFailure)throw Error('浏览器拒绝复制');copies.push(value);},onNotify:value=>notices.push(value)});
  const call=async(method,params)=>{
    const before=sent.length;
    await bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'fixture',method,params,meta:{nonce:bridge.nonce,panel:id}}});
    return sent.length>before?sent.at(-1):null;
  };
  return{bridge,call,sent,calls,copies,notices,release:()=>release?.()};
}
try{
  for(const options of [{kind:'user'},{id:'plugins'},{permitted:false}]){
    const f=fixture(options);try{assert.ok((await f.call('protocol.copyInitialPassword',{sessionId:'current-view'})).error);assert.equal(f.calls.length,0);assert.equal(f.copies.length,0);}finally{f.bridge.close();}
  }
  const f=fixture();try{
    assert.ok((await f.call('protocol.copyInitialPassword',{sessionId:'current-view'})).error,'opening a valid settings view comes before copying');
    await f.call('api.request',{method:'GET',path:'/api/local-protocols/login'});
    for(const params of [{sessionId:'stale'},{sessionId:'current-view',password},{}])assert.ok((await f.call('protocol.copyInitialPassword',params)).error);
    assert.ok((await f.call('api.request',{method:'POST',path:'/api/local-protocols/login/initial-password',body:{sessionId:'current-view'}})).error,'generic API replies never carry a bootstrap password into a frame');
    const response=await f.call('protocol.copyInitialPassword',{sessionId:'current-view'});
    assert.deepEqual(response.result,{ok:true});assert.deepEqual(f.copies,[password]);assert.deepEqual(f.notices,['初始密码已复制']);
    assert.equal(JSON.stringify(f.sent).includes(password),false,'frame replies contain no plaintext password');
    assert.equal(f.calls.filter(call=>call.path.endsWith('/initial-password')).length,1);
  }finally{f.bridge.close();}
  const failing=fixture({writeFailure:true});try{
    await failing.call('api.request',{method:'GET',path:'/api/local-protocols/login'});
    assert.ok((await failing.call('protocol.copyInitialPassword',{sessionId:'current-view'})).error);assert.deepEqual(failing.notices,[]);assert.deepEqual(failing.copies,[]);
  }finally{failing.bridge.close();}
  for(const end of ['close','session-change']){
    const f=fixture({held:true});
    try{
      await f.call('api.request',{method:'GET',path:'/api/local-protocols/login'});
      const copy=f.call('protocol.copyInitialPassword',{sessionId:'current-view'});
      if(end==='close')f.bridge.close();else f.bridge.protocolLoginSession='new-view';
      f.release();await copy;assert.deepEqual(f.copies,[]);assert.deepEqual(f.notices,[]);
    }finally{f.bridge.close();}
  }
  console.log('PASS SnowLuma initial-password RPC: settings-only copy, current session, host clipboard, no plaintext in frames, failures and late-response cancellation');
}finally{globalThis.window=savedWindow;}
