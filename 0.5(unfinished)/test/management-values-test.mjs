import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGroupManagement} from '../src/management/runtime.js';
import {NODE_CATALOG,validateManagement} from '../src/management/catalog.js';
import {dataLinkIssue} from '../ui/panels/rules/management-values.js';
import {canvasLayout} from '../ui/panels/rules/management-graph.js';
let serial=0,mid=0;
const n=(type,config={},extra={})=>({id:'n'+(++serial),type,config,...extra});
const rule=(nodes,trigger='message')=>({id:'rule',name:'扩展测试',enabled:true,groups:['12345'],cooldownSeconds:0,nodes:[n(trigger),...nodes]});
const until=async fn=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,5));}};
function fixture(rules=[],options={}){
  const dir=options.dir??fs.mkdtempSync(path.join(os.tmpdir(),'qqa-managed-nodes-')),calls=[],sent=[],clock=options.clock??{value:Date.now()},listeners=new Set();let currentRules=rules,role='owner';
  const config={get:()=>({management:{rules:currentRules}}),onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const transport={selfId:'111',status:()=>({connected:true}),actions:{getModerationMember:async(_group,user)=>({userId:user,role:String(user)==='111'?role:String(user)==='333'?'admin':'member',nickname:'小鱼',card:'测试名片',joinTime:clock.value/1000-300}),getModerationMembers:async()=>[{userId:'111',role},{userId:'222',role:'member',card:'测试名片'},{userId:'333',role:'admin',card:'管理员'},{userId:'444',role:'member',card:''}],moderateGroup:async(group,operation,opts)=>{opts.current();calls.push({group,...operation});}}};
  const send={sendTextBatch:async(group,text,opts)=>{await opts.beforeSend();sent.push({group,text});return {ok:true};},sendSegments:async(group,segments,opts)=>{await opts.beforeSend();sent.push({group,segments});return {ok:true};}};
  const management=createGroupManagement({config,transport,send,dataDir:dir,now:()=>clock.value});management.start();
  return {dir,management,calls,sent,clock,transport,setRole:value=>role=value,update(rules){currentRules=rules;for(const fn of listeners)fn();},async fire(text='x',user='222',extra={}){const previous=management.snapshot().runs[0]?.id;management.handleEvent({kind:'group',id:'12345',type:'message',event:{user_id:user,message_id:++mid,message:[{type:'text',data:{text}}],...extra}});await until(()=>!management.snapshot().active&&management.snapshot().runs[0]?.id!==previous);return management.snapshot().runs[0];},async close(keep=false){await management.close();if(!keep){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('qqa-managed-nodes-'));fs.rmSync(dir,{recursive:true,force:true});}}};
}
const bind=(node,key,source,port)=>{node.bindings??={};node.bindings[key]={nodeId:source.id,port};return node;};
const checked=r=>validateManagement({rules:[r]}).rules[0];
test('event fields feed independent action parameters; pure values are evaluated only once per round',async()=>{
  const duration=n('value_number',{value:45}),mute=n('mute'),r=rule([mute,duration]);r.nodes[0].next=mute.id;mute.next='$end';bind(mute,'duration',duration,'value');bind(mute,'user_id',r.nodes[0],'user_id');bind(mute,'group_id',r.nodes[0],'group_id');
  const f=fixture();try{const out=await f.management.dryRun(r,{userId:'222',event:{time:1700000000,sender:{nickname:'鱼'}}});assert.equal(out.status,'done',out.error);assert.deepEqual(out.actions.map(a=>[a.action,a.userId,a.seconds]),[['mute','222',45]]);assert.equal(out.values[r.nodes[0].id].time,'1700000000');assert.equal(out.values[r.nodes[0].id]['sender.nickname'],'鱼');assert.equal(out.trace.filter(t=>t.nodeId===duration.id&&t.status==='done').length,1);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('member lookup, formatting and concatenation produce the actual sent text',async()=>{
  const info=n('member_info'),join=n('text_join',{a:'欢迎 ',b:''}),send=n('send_text'),r=rule([info,send,join]);r.nodes[0].next=info.id;info.next=send.id;send.next='$end';bind(join,'b',info,'nickname');bind(send,'text',join,'text');
  const f=fixture([checked(r)]);try{const out=await f.management.dryRun(r,{userId:'222',memberInfo:{'222':{nickname:'小鱼'}}});assert.equal(out.status,'done',out.error);assert.equal(out.actions[0].value,'欢迎 小鱼');await f.fire();assert.equal(f.sent[0].text,'欢迎 小鱼');const live=f.management.getRun(f.management.snapshot().runs[0].id);assert.equal(live.values,undefined,'live records do not retain raw field values');}finally{await f.close();}
});
test('boolean data chooses an execution branch and one data output can feed multiple inputs',async()=>{
  const compare=n('number_compare',{a:5,b:3,operator:'gte'}),branch=n('branch_value'),a=n('rename_group',{text:'通过'}),b=n('rename_group',{text:'未通过'}),r=rule([branch,a,b,compare]);r.nodes[0].next=branch.id;branch.next=a.id;branch.otherwise=b.id;a.next=b.next='$end';bind(branch,'condition',compare,'result');
  const f=fixture();try{let out=await f.management.dryRun(r);assert.equal(out.actions[0].value,'通过');compare.config.a=1;out=await f.management.dryRun(r);assert.equal(out.actions[0].value,'未通过');}finally{await f.close();}
});
test('server and editor reject missing fields, mixed ID types, combined cycles and execution lines into pure nodes',()=>{
  const a=n('mute'),number=n('value_number',{value:60}),r=rule([a,number]);r.nodes[0].next=a.id;a.next='$end';
  for(const [source,port,input]of [[number,'value','user_id'],[r.nodes[0],'user_id','group_id'],[r.nodes[0],'absent','duration']]){const copy=structuredClone(r);bind(copy.nodes[1],input,source,port);assert.throws(()=>checked(copy),/类型不兼容|不存在/);assert.ok(dataLinkIssue(r,NODE_CATALOG,source.id,port,a.id,input));}
  const cyclic=structuredClone(r);bind(cyclic.nodes[1],'duration',cyclic.nodes[2],'value');bind(cyclic.nodes[2],'value',cyclic.nodes[1],'count');assert.throws(()=>checked(cyclic),/循环/);r.nodes[0].next=number.id;assert.throws(()=>checked(r),/不接执行线/);
});
test('dynamic range, selection values and missing data fail before an action; fallback can recover missing values',async()=>{
  const num=n('value_number',{value:-3}),mute=n('mute'),r=rule([mute,num]);r.nodes[0].next=mute.id;mute.next='$end';bind(mute,'duration',num,'value');const f=fixture();try{let out=await f.management.dryRun(r);assert.equal(out.status,'failed');assert.match(out.error,/范围/);assert.equal(out.actions.length,0);
    const name=n('value_text',{value:'invalid'}),compare=n('number_compare',{a:1,b:2}),branch=n('branch_value'),r2=rule([branch,compare,name]);r2.nodes[0].next=branch.id;branch.next=branch.otherwise='$end';bind(compare,'operator',name,'value');bind(branch,'condition',compare,'result');out=await f.management.dryRun(r2);assert.equal(out.status,'failed');assert.match(out.error,/可选值/);
    const fallback=n('default_value',{fallback:'朋友'}),join=n('text_join',{a:'欢迎 ',b:''}),send=n('send_text'),r3=rule([send,fallback,join]);r3.nodes[0].next=send.id;send.next='$end';bind(fallback,'value',r3.nodes[0],'sender.card');bind(join,'b',fallback,'value');bind(send,'text',join,'text');out=await f.management.dryRun(r3,{event:{sender:{}}});assert.equal(out.status,'done',out.error);assert.equal(out.actions[0].value,'欢迎 朋友');
  }finally{await f.close();}
});
test('inactive operational sources never reuse previous data; a fallback may explicitly handle an inactive source',async()=>{
  const cond=n('found',{text:'是'}),lookup=n('member_info'),send=n('send_text'),fallback=n('default_value',{fallback:'未查询'}),r=rule([cond,lookup,send,fallback]);r.nodes[0].next=cond.id;cond.next=lookup.id;cond.otherwise=send.id;lookup.next=send.id;send.next='$end';bind(send,'text',lookup,'nickname');const f=fixture();try{let out=await f.management.dryRun(r,{text:'是',memberInfo:{'10002':{nickname:'这轮查询'}}});assert.equal(out.actions[0].value,'这轮查询');out=await f.management.dryRun(r,{text:'否'});assert.equal(out.status,'failed');assert.match(out.error,/本轮未执行/);assert.equal(out.actions.length,0);bind(fallback,'value',lookup,'nickname');bind(send,'text',fallback,'value');out=await f.management.dryRun(r,{text:'否'});assert.equal(out.status,'done',out.error);assert.equal(out.actions[0].value,'未查询');}finally{await f.close();}
});
test('bound groups stay inside the rule scope and conflicting target inputs are rejected',async()=>{
  const send=n('send_text',{text:'x'},{values:{group_id:'99999'}}),r=rule([send]),f=fixture();try{let out=await f.management.dryRun(r);assert.equal(out.status,'failed');assert.match(out.error,/应用范围/);assert.equal(out.actions.length,0);const mute=n('mute',{seconds:60},{values:{user_id:'222',targets:['444']}});assert.throws(()=>checked(rule([mute])),/只指定一项/);}finally{await f.close();}
});
test('port visibility survives validation and never affects execution bindings',()=>{
  const r=rule([]),root=r.nodes[0];r.layout={version:1,positions:{[root.id]:{x:50,y:60}},visiblePorts:{[root.id]:{outputs:['user_id','text','time']}}};assert.deepEqual(JSON.parse(JSON.stringify(checked(r).layout)),r.layout);
});
test('new context ports control observation targets without changing another parallel path',async()=>{
  const wait=n('user_sent',{seconds:10},{values:{targets:['444']}}),a=n('mute',{seconds:5}),b=n('mute',{seconds:7}),r=rule([wait,a,b]);r.nodes[0].next=[wait.id,b.id];wait.next=a.id;wait.otherwise='$end';a.next=b.next='$end';bind(a,'targets',wait,'targets');const f=fixture();try{const out=await f.management.dryRun(r,{userId:'222',messages:[{afterSeconds:3,userId:'444',text:'出现'}]});assert.equal(out.status,'done',out.error);assert.deepEqual(out.actions.map(a=>[a.userId,a.seconds]).sort(),[['222',7],['444',5]],'the watched list is passed through an explicit data output; the parallel path retains its own targets');assert.equal(out.values[wait.id].targets,'列表 · 1 项');}finally{await f.close();}
});
test('field parsing rejects prototype paths and oversized literal structures; previews are bounded',async()=>{
  const field=n('data_field',{path:'__proto__.x'}),r=rule([field]);r.nodes[0].next='$end';const f=fixture();try{const out=await f.management.dryRun(r,{inspectNodes:[field.id]});assert.equal(out.status,'failed');assert.match(out.error,/字段路径/);const value=n('default_value',{fallback:'x'},{values:{value:'x'.repeat(100001)}});assert.throws(()=>checked(rule([value])),/内容过长/);
    const simple=rule([]),preview=await f.management.dryRun(simple,{text:'x'.repeat(5000),event:{sender:{nickname:'鱼'.repeat(200)}}});assert.equal(preview.values[simple.nodes[0].id].text.length,120);assert.equal(preview.values[simple.nodes[0].id]['sender.nickname'].length,120);
  }finally{await f.close();}
});
test('automatic layout keeps pure data nodes below the execution lane and updates data endpoints after moving',()=>{
  const join=n('text_join',{a:'欢迎 ',b:''}),send=n('send_text'),r=rule([join,send]);r.nodes[0].next=send.id;send.next='$end';bind(join,'b',r.nodes[0],'sender.nickname');bind(send,'text',join,'text');const model=canvasLayout(r,NODE_CATALOG),root=model.positions.get(r.nodes[0].id),value=model.positions.get(join.id),action=model.positions.get(send.id);assert.ok(value.y>Math.max(root.y+root.height,action.y+action.height),'calculation card must not cover the bypassing execution cable');assert.equal(model.dataEdges.length,2);assert.ok(model.dataEdges.every(e=>!e.path.includes('NaN')));
});
