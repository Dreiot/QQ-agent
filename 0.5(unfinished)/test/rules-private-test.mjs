import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createGroupManagement} from '../src/management/runtime.js';import {validateManagement} from '../src/management/catalog.js';
const node=(id,type,config={},extra={})=>({id,type,config,...extra});
const rule=(nodes,scope={private:['12345']})=>({id:'private-rule',name:'私聊测试',enabled:true,groups:[],cooldownSeconds:0,nodes:[node('start','message',{}, {next:nodes[0]?.id??'$end'}),...nodes],...scope});
const envelope=(kind,id,text='hello',mid=1)=>({kind,id,type:'message',event:{message_type:kind,message_id:mid,user_id:kind==='private'?id:'222',time:Date.now()/1000,message:[{type:'text',data:{text}}],sender:{nickname:'测试用户'}}});
const until=async fn=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};
function fixture(rules){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-private-rule-')),calls=[],lookups=[];const config={get:()=>({management:{rules}})},transport={selfId:'111',status:()=>({connected:true}),actions:{getModerationMember:async(group,user)=>{lookups.push(group);return{userId:user,role:'admin'};},moderateGroup:async()=>{throw Error('不得对真实群操作');}}};const send={sendTextBatch:async(key,text,options)=>{await options.beforeSend();calls.push({key,text});return {ok:true};}};const engine=createGroupManagement({config,transport,send,dataDir:dir});engine.start();return{engine,calls,lookups,async close(){await engine.close();fs.rmSync(dir,{recursive:true,force:true});}};}
test('private-only scope validates, legacy group scopes remain valid and malformed private ids fail',()=>{
  assert.equal(validateManagement({rules:[rule([node('note','note',{text:'ok'})])]}).rules[0].private[0],'12345');
  assert.throws(()=>validateManagement({rules:[rule([], {private:['bad']})]}),/私聊/);assert.throws(()=>validateManagement({rules:[rule([], {private:[],groups:[]})]}),/群聊或私聊/);
});
test('live private messages trigger a reply only for selected peers, with no group role lookup',async()=>{const f=fixture([rule([node('send','send_text',{text:'收到'}, {next:'$end'})])]);try{
  f.engine.handleEvent(envelope('group','12345'));f.engine.handleEvent(envelope('private','99999'));await new Promise(r=>setTimeout(r,25));assert.equal(f.calls.length,0);
  f.engine.handleEvent(envelope('private','12345'));await until(()=>f.calls.length===1&&!f.engine.snapshot().active);assert.deepEqual(f.calls,[{key:'private:12345',text:'收到'}]);assert.equal(f.lookups.length,0);const result=f.engine.snapshot().runs[0];assert.equal(result.chatKind,'private');assert.equal(result.chatId,'12345');assert.ok(!result.groupId);assert.equal(result.status,'done');
}finally{await f.close();}});
test('group and private with the same number have separate runs, cooldowns and counters',async()=>{const r=rule([node('count','counter_add',{key:'x',scope:'group',amount:1,seconds:600},{next:'send'}),node('send','send_text',{text:'{{count}}'},{next:'$end'})],{groups:['12345'],private:['12345']});r.cooldownSeconds=60;const f=fixture([r]);try{
  f.engine.handleEvent(envelope('group','12345'));f.engine.handleEvent(envelope('private','12345'));await until(()=>f.calls.length===2&&!f.engine.snapshot().active);assert.deepEqual(f.calls.map(c=>c.key).sort(),['group:12345','private:12345']);assert.ok(f.calls.every(c=>c.text==='1'));
}finally{await f.close();}});
test('a private wait ignores other peers and same-number group messages, then resumes on the selected private peer',async()=>{const f=fixture([rule([node('wait','user_sent',{seconds:1,text:'继续',quantifier:'any'},{next:'send'}),node('send','send_text',{text:'完成'},{next:'$end'})])]);try{
  f.engine.handleEvent(envelope('private','12345','开始'));await until(()=>f.engine.snapshot().runs.some(r=>r.trace.some(t=>t.type==='user_sent'&&t.status==='running')));
  f.engine.handleEvent(envelope('group','12345','继续',2));f.engine.handleEvent(envelope('private','99999','继续',3));await new Promise(r=>setTimeout(r,40));assert.equal(f.calls.length,0);
  f.engine.handleEvent(envelope('private','12345','继续',4));await until(()=>f.calls.length===1&&!f.engine.snapshot().active);assert.equal(f.calls[0].key,'private:12345');
}finally{await f.close();}});
test('private simulations expose conversation fields, fast-forward waits, and refuse group actions at that node',async()=>{const f=fixture([]);try{
  const r=rule([node('wait','user_not_sent',{seconds:2,text:'',quantifier:'any'},{next:'send'}),node('send','send_text',{text:'超时'},{next:'$end'})]);const done=await f.engine.dryRun(r,{chatKind:'private',userId:'12345',botRole:'member',inspectNodes:[]});assert.equal(done.status,'done');assert.equal(done.actions[0].value,'超时');assert.equal(done.values.start.chat_type,'private');assert.equal(done.values.start.chat_id,'12345');
  const unsafe=await f.engine.dryRun(rule([node('note','note',{text:'先记录'},{next:'mute'}),node('mute','mute',{seconds:60},{next:'$end'})]),{chatKind:'private',botRole:'member'});assert.equal(unsafe.status,'failed');assert.match(unsafe.error,/仅支持群聊/);assert.ok(unsafe.trace.some(t=>t.type==='note'&&t.status==='done'));assert.deepEqual(unsafe.actions,[]);
}finally{await f.close();}});
