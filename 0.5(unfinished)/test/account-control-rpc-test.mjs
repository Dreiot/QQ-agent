import assert from 'node:assert/strict';
import {RpcBridge} from '../ui/shell/rpc-bridge.js';

// Pure host-boundary test: no server, browser, credential or QQ connection.
const oldWindow=globalThis.window;
globalThis.window={addEventListener(){},removeEventListener(){}};
const requests=[],replies=[],stopped=[],id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const frame={addEventListener(){},contentWindow:{postMessage:message=>replies.push(message)}};
const api={request:async(method,path,body)=>{requests.push({target:'account',method,path,body});return{ok:true};}};
const controlApi={request:async(method,path,body)=>{requests.push({target:'primary',method,path,body});return{accounts:[{id:'primary'},{id,status:'stopped',wanted:false}]};}};
const manifest={kind:'bundled',id:'settings',api:[{method:'GET',path:'/api/accounts'},{method:'POST',path:'/api/accounts/start'},{method:'POST',path:'/api/accounts/stop'},{method:'POST',path:'/api/accounts/remove'},{method:'GET',path:'/api/status'}]};
const bridge=new RpcBridge({frame,api,controlApi,manifest,onAccountStopped:account=>stopped.push(account)});
let sequence=0;
const call=async(method,path,body)=>{await bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:++sequence,method:'api.request',params:{method,path,body},meta:{nonce:bridge.nonce,panel:'settings'}}});return replies.at(-1);};
try{
  await call('GET','/api/accounts');assert.equal(requests.at(-1).target,'primary');
  await call('POST','/api/accounts/stop',{id});assert.equal(requests.at(-1).target,'primary');assert.deepEqual(stopped,[id]);assert.ok(replies.at(-1).result.accounts,'the stop acknowledgment comes from the surviving main console');
  await call('POST','/api/accounts/start',{id:'primary'});assert.equal(requests.at(-1).target,'primary');assert.deepEqual(stopped,[id]);
  await call('POST','/api/accounts/remove',{id,accountId:'12345678'});assert.equal(requests.at(-1).target,'primary');assert.deepEqual(stopped,[id,id]);assert.ok(replies.at(-1).result.accounts,'removal also returns through the surviving main console');
  await call('POST','/api/accounts/remove',{accountId:'87654321'});assert.equal(requests.at(-1).target,'primary');assert.deepEqual(stopped,[id,id],'removing a detected account does not navigate the current workspace');
  await call('GET','/api/status');assert.equal(requests.at(-1).target,'account','ordinary settings requests retain their fixed account scope');
  const count=requests.length;assert.ok((await call('POST','/api/accounts/stop',{id:'../other'})).error);assert.equal(requests.length,count);
  for(const body of [{},{accountId:'../other'},{id:'../other',accountId:'12345678'}])assert.ok((await call('POST','/api/accounts/remove',body)).error);assert.equal(requests.length,count);
  assert.ok((await call('GET','/api/accounts/events')).error,'the iframe does not acquire a raw global event channel');
  console.log('Account control RPC: only declared controls use primary, stop acknowledgment survives account shutdown, ordinary requests stay scoped and invalid IDs are rejected.');
}finally{bridge.close();if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;}
