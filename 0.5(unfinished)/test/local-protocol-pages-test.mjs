import assert from 'node:assert/strict';
import {RpcBridge} from '../ui/shell/rpc-bridge.js';
import {localProtocolLoginUrl,localProtocolPageUrl,LOCAL_PROTOCOL_RELEASES} from '../ui/panels/local-protocol-links.js';
import {hostApiRequestTimeout,panelApiRequestTimeout} from '../ui/panels/request-timeouts.js';
import {SseClient} from '../ui/shell/sse-client.js';

for(const url of ['https://evil.test/','http://127.0.0.1.evil.test/','http://2130706433:6099/?token=secret','http://user:pass@localhost/','http://localhost/?password=secret','http://127.0.0.1/#token','file:///tmp/a','javascript:alert(1)','not a url'])assert.equal(localProtocolLoginUrl(url),null,url);
assert.equal(localProtocolLoginUrl('http://127.0.0.1:6099/webui'),'http://127.0.0.1:6099/webui');
assert.equal(localProtocolLoginUrl('http://[::1]:6099/'),'http://[::1]:6099/');
assert.equal(hostApiRequestTimeout('POST','/api/local-protocols/start'),180000);assert.equal(panelApiRequestTimeout('POST','/api/local-protocols/start'),185000);assert.equal(hostApiRequestTimeout('GET','/api/local-protocols/start'),15000);
for(const [action,host,panel] of [['inject',90000,95000],['connect',35000,40000],['refresh',35000,40000]]){assert.equal(hostApiRequestTimeout('POST','/api/local-protocols/login/'+action),host);assert.equal(panelApiRequestTimeout('POST','/api/local-protocols/login/'+action),panel);assert.equal(hostApiRequestTimeout('GET','/api/local-protocols/login/'+action),15000);assert.equal(hostApiRequestTimeout('POST','/api/local-protocols/login/'+action+'-other'),15000);}
const events=[],sse=new SseClient({onEvent:(...args)=>events.push(args)});sse.dispatch('protocol-login','{"sessionId":"fixture-only"}');sse.dispatch('unknown-event','{}');assert.deepEqual(events,[['protocol-login',{sessionId:'fixture-only'}]]);
const savedWindow=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
try{
  const run={id:'snow-1',provider:'snowluma',status:'running',webUiUrl:'http://127.0.0.1:6099/'};
  for(const kind of ['user','bundled'])for(const id of ['settings','plugins','community']){
    const sent=[],opened=[],reads=[],frame={contentWindow:{postMessage:message=>sent.push(message)},addEventListener(){}};
    let running=structuredClone(run);
    const bridge=new RpcBridge({frame,manifest:{id,kind,api:[{method:'GET',path:'/api/local-protocols'}]},api:{request:async(method,path)=>{reads.push([method,path]);return{running};}},onOpenExternal:async(...args)=>{opened.push(args);return{ok:true};}});
    const call=async(params)=>{await bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'qa',method:'ui.openExternal',params,meta:{nonce:bridge.nonce,panel:id}}});return sent.at(-1);};
    if(kind==='bundled'&&id==='settings'){
      assert.ok((await call({target:'napcat-releases'})).result);assert.equal(opened.at(-1)[1].protocolUrl,LOCAL_PROTOCOL_RELEASES['napcat-releases']);
      assert.ok((await call({target:'local-protocol-login',id:run.id})).result);assert.equal(opened.at(-1)[1].protocolUrl,run.webUiUrl);assert.deepEqual(reads.at(-1),['GET','/api/local-protocols']);
      const count=opened.length;
      for(const params of [{target:'local-protocol-login',id:run.id,url:'http://evil.test'},{target:'local-protocol-login',id:'stale'},{target:'local-protocol-login'},{target:'https://evil.test'},{target:'snowluma-releases',url:'http://evil.test'}])assert.ok((await call(params)).error);
      for(const webUiUrl of ['http://evil.test','http://user:pass@localhost/','http://127.0.0.1:6099/?token=secret']){running={...run,webUiUrl};assert.ok((await call({target:'local-protocol-login',id:run.id})).error);}
      running={...run,status:'stopped'};assert.ok((await call({target:'local-protocol-login',id:run.id})).error);
      running=null;assert.ok((await call({target:'local-protocol-login',id:run.id})).error);assert.equal(opened.length,count,'untrusted URLs and stale instance IDs never open a page');
    }else{assert.ok((await call({target:'local-protocol-login',id:run.id})).error);assert.ok((await call({target:'napcat-releases'})).error);assert.equal(opened.length,0);assert.equal(reads.length,0);}
    bridge.close();
  }
  assert.equal(localProtocolPageUrl('local-protocol-login',{running:run},'old'),null);
  for(const kind of ['user','bundled'])for(const id of ['settings','plugins','community'])for(const permitted of [false,true]){
    const sent=[],opened=[],reads=[],frame={contentWindow:{postMessage:message=>sent.push(message)},addEventListener(){}};let current={sessionId:'session-owned',nativeUrl:'http://127.0.0.1:5099/'};
    const bridge=new RpcBridge({frame,manifest:{id,kind,api:permitted?[{method:'GET',path:'/api/local-protocols/login'}]:[]},api:{request:async(...args)=>{reads.push(args);return current;}},onOpenExternal:async(...args)=>{opened.push(args);return{ok:true};}});
    const call=async(params)=>{await bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'qa',method:'ui.openExternal',params,meta:{nonce:bridge.nonce,panel:id}}});return sent.at(-1);};
    if(kind==='bundled'&&id==='settings'&&permitted){
      assert.ok((await call({target:'protocol-login-native',id:'session-owned'})).result);assert.equal(opened.at(-1)[1].protocolUrl,current.nativeUrl);assert.deepEqual(reads.at(-1),['GET','/api/local-protocols/login',undefined,{sessionId:'session-owned',nativeOnly:1}]);const count=opened.length;
      for(const params of [{target:'protocol-login-native',id:'session-owned',url:'http://evil.test/'},{target:'protocol-login-native',id:'stale'},{target:'protocol-login-native'},{target:'protocol-login-native',id:''}])assert.ok((await call(params)).error);
      for(const nativeUrl of ['https://evil.test/','http://user:pass@127.0.0.1/','http://127.0.0.1:5099/?token=secret']){current={sessionId:'session-owned',nativeUrl};assert.ok((await call({target:'protocol-login-native',id:'session-owned'})).error);}assert.equal(opened.length,count,'native login opening only accepts the fresh matching session and a credential-free loopback URL');
    }else{assert.ok((await call({target:'protocol-login-native',id:'session-owned'})).error);assert.equal(reads.length,0);assert.equal(opened.length,0);}
    bridge.close();
  }
  {
    let release;const pending=new Promise(resolve=>{release=resolve;}),opened=[];
    const frame={contentWindow:{postMessage(){}},addEventListener(){}},manifest={id:'settings',kind:'bundled',api:[{method:'GET',path:'/api/local-protocols'}]};
    const bridge=new RpcBridge({frame,manifest,api:{request:()=>pending},onOpenExternal:(...args)=>opened.push(args)});
    const request=bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'qa',method:'ui.openExternal',params:{target:'local-protocol-login',id:run.id},meta:{nonce:bridge.nonce,panel:'settings'}}});
    bridge.close();release({running:run});await request;assert.equal(opened.length,0,'a late instance read cannot open a tab after the panel is gone');
  }
  {
    let release;const pending=new Promise(resolve=>{release=resolve;}),opened=[],frame={contentWindow:{postMessage(){}},addEventListener(){}};
    const bridge=new RpcBridge({frame,manifest:{id:'settings',kind:'bundled',api:[{method:'GET',path:'/api/local-protocols/login'}]},api:{request:()=>pending},onOpenExternal:(...args)=>opened.push(args)});
    const request=bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'qa',method:'ui.openExternal',params:{target:'protocol-login-native',id:'session-owned'},meta:{nonce:bridge.nonce,panel:'settings'}}});bridge.close();release({sessionId:'session-owned',nativeUrl:'http://127.0.0.1:5099/'});await request;assert.equal(opened.length,0,'a late native session read cannot open a page after panel leave');
  }
  const loginRpc=({id='settings',respond}={})=>{
    const calls=[],sent=[],frame={contentWindow:{postMessage:message=>sent.push(message)},addEventListener(){}},manifest={id,kind:'bundled',api:[{method:'GET',path:'/api/local-protocols/login'},{method:'POST',path:'/api/local-protocols/login/connect'},{method:'POST',path:'/api/local-protocols/login/close'},{method:'GET',path:'/api/status'}]};
    const bridge=new RpcBridge({frame,manifest,api:{request:(...args)=>{calls.push(args);return respond(...args);}}});
    const request=(method,path,body,query)=>bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'qa',method:'api.request',params:{method,path,body,query},meta:{nonce:bridge.nonce,panel:id}}});return{bridge,calls,sent,request};
  };
  {
    const f=loginRpc({respond:async(method)=>method==='GET'?{sessionId:'server-owned',stage:'waiting'}:{ok:true}});await f.request('GET','/api/local-protocols/login');assert.equal(f.bridge.protocolLoginSession,'server-owned');const rpcSignal=f.calls[0][4].signal;f.bridge.close();assert.equal(rpcSignal.aborted,false,'the completed GET has already left the ordinary controller set');assert.deepEqual(f.calls[1],['POST','/api/local-protocols/login/close',{sessionId:'server-owned'}],'host cleanup has no ordinary abort signal');assert.equal(f.bridge.protocolLoginSession,null);f.bridge.close();assert.equal(f.calls.length,2,'host close is idempotent');
  }
  for(const leaving of [false,true]){
    let release;const pending=new Promise(resolve=>{release=resolve;}),f=loginRpc({respond:(method)=>method==='GET'?pending:Promise.resolve({ok:true})});const request=f.request('GET','/api/local-protocols/login',undefined,{sessionId:'caller-query-id'});if(leaving)f.bridge.leaving=true;else f.bridge.close();release({sessionId:'server-late',qrImage:'private-fixture-image'});await request;
    assert.deepEqual(f.calls.filter(call=>call[0]==='POST'),[['POST','/api/local-protocols/login/close',{sessionId:'server-late'}]],'only the server-returned session is released after leave');assert.equal(f.sent.length,0,'private login material is never sent after close or leave');assert.equal(f.bridge.protocolLoginSession,null);f.bridge.close();
  }
  {
    let release;const pending=new Promise(resolve=>{release=resolve;}),f=loginRpc({respond:(method,path)=>method==='GET'?Promise.resolve({sessionId:'server-owned'}):path.endsWith('/connect')?pending:Promise.resolve({ok:true})});await f.request('GET','/api/local-protocols/login');const sent=f.sent.length,request=f.request('POST','/api/local-protocols/login/connect',{sessionId:'server-owned',password:'synthetic-only'});f.bridge.close();release({sessionId:'server-owned',qrImage:'late-private-image'});await request;assert.equal(f.sent.length,sent);assert.deepEqual(f.calls.filter(call=>call[1].endsWith('/close')),[['POST','/api/local-protocols/login/close',{sessionId:'server-owned'}]],'known close and a late action do not duplicate native cleanup');
  }
  {
    const f=loginRpc({respond:async(method,path)=>path.endsWith('/close')?{sessionId:'already-closed'}:{sessionId:'server-owned'}});await f.request('GET','/api/local-protocols/login');await f.request('POST','/api/local-protocols/login/close',{sessionId:'server-owned'});assert.equal(f.bridge.protocolLoginSession,null,'an acknowledged UI close never re-registers the closed response');f.bridge.close();assert.equal(f.calls.filter(call=>call[1].endsWith('/close')).length,1);
  }
  for(const [id,path] of [['plugins','/api/local-protocols/login'],['settings','/api/status']]){
    const f=loginRpc({id,respond:async()=>({sessionId:'unrelated'})});await f.request('GET',path);assert.equal(f.bridge.protocolLoginSession,null);f.bridge.close();assert.equal(f.calls.length,1,'other panels and unrelated APIs never trigger protocol cleanup');
  }
  console.log('✓ protocol pages: fixed releases, fresh matching instance, credential-free loopback URL, plugin/non-settings rejection, no arbitrary URL and bounded start timeout');
}finally{if(savedWindow===undefined)delete globalThis.window;else globalThis.window=savedWindow;}
