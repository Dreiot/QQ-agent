import assert from 'node:assert/strict';import {RpcBridge} from '../ui/shell/rpc-bridge.js';
const oldWindow=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(manifest={kind:'bundled',id:'settings',api:[]}){let rows=[{id:'primary',accountId:''},{id,accountId:'12345678',connected:true,wanted:true,status:'running'}],release,hold=false;const requests=[],replies=[],selected=[],frame={addEventListener(){},contentWindow:{postMessage:value=>replies.push(value)}};
 const bridge=new RpcBridge({frame,manifest,api:{request:()=>assert.fail('must use host account metadata')},controlApi:{request:async(method,path)=>{requests.push({method,path});if(hold)await new Promise(resolve=>release=resolve);return{accounts:rows};}},onViewConnectedAccount:target=>selected.push(target)});
 return{bridge,requests,replies,selected,set rows(value){rows=value;},set hold(value){hold=value;},release:()=>release?.(),call:target=>bridge.handle({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'select',method:'ui.viewConnectedAccount',params:{id:target},meta:{nonce:bridge.nonce,panel:manifest.id}}})};}
try{
 let f=fixture();await f.call(id);assert.deepEqual(f.selected,[id]);assert.deepEqual(f.requests,[{method:'GET',path:'/api/accounts'}]);assert.equal(f.replies.at(-1).result.selected,true);f.bridge.close();
 for(const manifest of [{kind:'user',id:'settings',api:[]},{kind:'bundled',id:'skills',api:[]}]){f=fixture(manifest);await f.call(id);assert.ok(f.replies.at(-1).error);assert.equal(f.requests.length,0);assert.equal(f.selected.length,0);f.bridge.close();}
 f=fixture();await f.call('../other');assert.ok(f.replies.at(-1).error);assert.equal(f.requests.length,0);f.bridge.close();
 for(const target of [{connected:false,wanted:true},{connected:true,wanted:false},{connected:true,wanted:true,accountId:'bad'}]){f=fixture();f.rows=[{id:'primary',accountId:''},{id,accountId:'12345678',...target}];await f.call(id);assert.ok(f.replies.at(-1).error);assert.equal(f.selected.length,0);f.bridge.close();}
 f=fixture();f.rows=[{id:'primary',accountId:'87654321'},{id,accountId:'12345678',connected:true,wanted:true}];await f.call(id);assert.equal(f.replies.at(-1).result.selected,true);assert.deepEqual(f.selected,[id]);f.bridge.close();
 f=fixture();f.hold=true;const pending=f.call(id);f.bridge.close();f.release();await pending;assert.equal(f.selected.length,0);assert.equal(f.replies.length,0);
 console.log('PASS connected-account view RPC: host verifies actual connection, selects the verified target from an existing account, rejects other panels/invalid/stopped targets and late replies');
}finally{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;}
