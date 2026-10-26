import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGroupManagement} from '../src/management/runtime.js';
import {validateManagement} from '../src/management/catalog.js';
import {createModerationActions} from '../bundled/transport-onebot/moderation.js';
import {Bus} from '../src/kernel/bus.js';

const node=(type,config={},extra={})=>({id:Math.random().toString(36).slice(2),type,config,...extra});
const rule=(nodes,extra={})=>({id:'rule1',name:'测试规则',enabled:true,groups:['12345'],cooldownSeconds:0,nodes:[node('message'),...nodes],...extra});
let messageSequence=0;
const message=(text='hello',user='222',group='12345')=>({kind:'group',id:group,type:'message',event:{user_id:user,message_id:++messageSequence,message:[{type:'text',data:{text}}]}});
const until=async(fn)=>{const limit=Date.now()+3000;while(!fn()){if(Date.now()>limit)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};
function fixture(rules,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-management-')),listeners=new Set(),calls=[];let state={management:{rules}},identity='account1',role='admin',connected=true;
  const config={get:()=>state,onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const transport={selfId:'111',status:()=>({connected}),actions:{getModerationMember:async(_g,user)=>({userId:user,role:String(user)==='111'?role:user==='444'?'owner':'member'}),getModerationMembers:async()=>[{userId:'222',role:'member'},{userId:'333',role:'member'},{userId:'444',role:'owner'},{userId:'111',role:'admin'}],moderateGroup:async(g,op,options)=>{options.current();calls.push({g,...op});}}};
  const management=createGroupManagement({config,transport,dataDir:dir,identityOf:()=>identity,...options});management.start();
  return {management,calls,transport,setRole:r=>role=r,setIdentity:i=>identity=i,setConnected:c=>connected=c,update(rules){state={management:{rules}};for(const fn of listeners)fn();},async close(){await management.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('validates graph, trigger, cycles, account scope and disabled drafts',()=>{
  const r=rule([node('found',{text:'x'}),node('mute',{seconds:60})]);assert.equal(validateManagement({rules:[r]}).rules[0].nodes.length,3);
  assert.throws(()=>validateManagement({rules:[{...r,groups:[]}]}),/群/);
  assert.throws(()=>validateManagement({rules:[rule([node('unknown')])]}),/未知/);
  const cyclic=structuredClone(r);cyclic.nodes[2].next=cyclic.nodes[1].id;assert.throws(()=>validateManagement({rules:[cyclic]}),/循环/);
  assert.doesNotThrow(()=>validateManagement({rules:[rule([node('target_users')],{enabled:false,groups:[]})]}));
  assert.throws(()=>validateManagement({rules:[rule([node('target_users')])]}),/QQ/);
});
test('found/missing branches and selectors execute only in selected groups',async()=>{
  const r=rule([node('found',{text:'违规'}),node('target_users',{users:'222 444'}),node('mute',{seconds:60})]),f=fixture([r]);try{
    f.management.handleEvent(message('正常'));await until(()=>f.management.snapshot().runs.length===1);assert.equal(f.calls.length,0);
    f.management.handleEvent(message('违规','333','99999'));await new Promise(r=>setTimeout(r,20));assert.equal(f.management.snapshot().runs.length,1);
    f.management.handleEvent(message('违规'));await until(()=>f.calls.length===1);await until(()=>!f.management.snapshot().active);assert.equal(f.calls[0].userId,'222');assert.equal(f.calls[0].action,'mute');
    assert.ok(f.management.snapshot().runs[0].trace.some(t=>t.status==='skipped'));
  }finally{await f.close();}
});
test('all users excludes protected roles and self; no admin => no privileged actions',async()=>{
  const r=rule([node('target_all'),node('kick')]),f=fixture([r]);try{
    f.setRole('member');f.management.handleEvent(message());await until(()=>f.management.snapshot().runs.length&&!f.management.snapshot().active);assert.equal(f.calls.length,0);assert.match(f.management.snapshot().runs[0].error,/管理员/);
    f.setRole('admin');f.management.handleEvent(message());await until(()=>f.calls.length===2);assert.deepEqual(f.calls.map(c=>c.userId),['222','333']);
  }finally{await f.close();}
});

test('ordinary members run recording and replies without a role lookup; only a privileged step is denied',async()=>{
  const replies=[],send={sendTextBatch:async(key,text,options)=>{await options.beforeSend();replies.push({key,text});return {ok:true};}};
  const r=rule([node('note',{text:'普通成员规则'}),node('send_text',{text:'收到'})]),f=fixture([r],{send});
  try{
    f.setRole('member');let lookups=0;
    f.transport.actions.getModerationMember=async()=>{lookups++;throw Error('基础规则不应查询管理身份');};
    f.management.handleEvent(message());await until(()=>f.management.snapshot().runs.length&&!f.management.snapshot().active);
    assert.equal(f.management.snapshot().runs[0].status,'done');assert.equal(lookups,0);assert.deepEqual(replies,[{key:'group:12345',text:'收到'}]);
    const mixed=rule([node('note',{text:'先记录'}),node('mute',{seconds:60})]);
    const result=await f.management.dryRun(mixed,{botRole:'member'});
    assert.equal(result.status,'failed');assert.ok(result.trace.some(t=>t.type==='note'&&t.status==='done'));assert.match(result.error,/权限/);assert.deepEqual(result.actions,[]);
  }finally{await f.close();}
});
test('wait for messages observes selected members and group; not-sent branch times out',async()=>{
  const wait=node('user_sent',{seconds:.08}),r=rule([wait,node('mute',{seconds:20})]);wait.config.seconds=1;const f=fixture([r]);try{
    f.management.handleEvent(message());await until(()=>f.management.snapshot().runs[0]?.trace.some(t=>t.type==='user_sent'));
    f.management.handleEvent(message('other','333'));f.management.handleEvent(message('other','222','999'));await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.length,0);
    f.management.handleEvent(message('answer'));await until(()=>f.calls.length===1);
    // Other senders' own rules may wait, but cannot satisfy the first sender's wait.
    f.update([rule([node('user_not_sent',{seconds:1}),node('kick')])]);f.management.handleEvent(message());await until(()=>f.calls.some(c=>c.action==='kick'));
  }finally{await f.close();}
});
test('disable, identity changes and disconnection cancel pending work; restart has no catch-up',async()=>{
  const r=rule([node('delay',{seconds:1}),node('kick')]),f=fixture([r]);try{
    f.management.handleEvent(message());await until(()=>f.management.snapshot().active);f.update([{...r,enabled:false}]);await until(()=>!f.management.snapshot().active);assert.equal(f.calls.length,0);assert.equal(f.management.snapshot().runs[0].status,'cancelled');
    f.update([r]);f.management.handleEvent(message());await until(()=>f.management.snapshot().active);f.setIdentity('account2');await until(()=>!f.management.snapshot().active);assert.equal(f.calls.length,0);
    f.management.handleEvent(message());await until(()=>f.management.snapshot().active);f.setConnected(false);await until(()=>!f.management.snapshot().active);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('moving editor nodes preserves an active wait and does not reset its execution binding',async()=>{
  const r=rule([node('delay',{seconds:1}),node('mute',{seconds:60})]),f=fixture([r]);try{
    f.management.handleEvent(message());await until(()=>f.management.snapshot().runs[0]?.trace.some(t=>t.type==='delay'));
    const moved=structuredClone(r);moved.layout={version:1,positions:{[r.nodes[0].id]:{x:300,y:-100}}};f.update([moved]);
    await until(()=>f.calls.length===1);await until(()=>!f.management.snapshot().active);assert.equal(f.management.snapshot().runs[0].status,'done');assert.equal(f.calls[0].action,'mute');
  }finally{await f.close();}
});
test('simulation fast-forwards absent/sent branches and never calls real transport',async()=>{
  const r=rule([node('target_all'),node('user_not_sent',{seconds:60,quantifier:'all'}),node('whole_mute')]),f=fixture([]);try{
    const result=await f.management.dryRun(r,{members:['222','333'],messages:[{userId:'222',text:'x',afterSeconds:10}]});assert.equal(result.status,'done');assert.equal(result.actions.length,1);assert.equal(f.calls.length,0);
    const reply=await f.management.dryRun(r,{members:['222','333'],messages:[{userId:'222',text:'x',afterSeconds:10},{userId:'333',text:'x',afterSeconds:20}]});assert.equal(reply.actions.length,0);
    const denied=await f.management.dryRun(r,{botRole:'member',members:['222','333']});assert.match(denied.error,/管理员/);
  }finally{await f.close();}
});

test('fan-out runs independent paths while one waits, preserves selected users and merges once',async()=>{
  const a=node('target_users',{users:'222'}),b=node('target_users',{users:'333'}),wait=node('delay',{seconds:1}),muteA=node('mute',{seconds:20}),muteB=node('mute',{seconds:30}),join=node('join'),done=node('note',{text:'merged'});
  a.next=wait.id;wait.next=muteA.id;b.next=muteB.id;muteA.next=muteB.next=join.id;join.next=done.id;done.next='$end';const r=rule([a,b,wait,muteA,muteB,join,done]);r.nodes[0].next=[a.id,b.id];const f=fixture([r]);try{
    f.management.handleEvent(message());await until(()=>f.calls.length);assert.equal(f.calls[0].userId,'333','the waiting path must not block its sibling');await until(()=>!f.management.snapshot().active);
    assert.deepEqual(f.calls.map(c=>c.userId).sort(),['222','333']);const record=f.management.snapshot().runs[0];assert.equal(record.status,'done');assert.equal(record.trace.filter(t=>t.nodeId===join.id&&t.status==='done').length,1);assert.equal(record.trace.find(t=>t.nodeId===join.id&&t.status==='done').detail,'继续共同的后续步骤');assert.equal(record.trace.find(t=>t.nodeId===done.id&&t.status==='done').detail,'merged');
  }finally{await f.close();}
});

test('fan-out observes messages independently, conditional inactive paths do not block a merge, pause cancels all paths',async()=>{
  const first=node('user_sent',{seconds:60}),second=node('user_sent',{seconds:60}),join=node('join'),mute=node('mute',{seconds:20});first.next=second.next=join.id;first.otherwise=second.otherwise='$end';join.next=mute.id;mute.next='$end';const r=rule([first,second,join,mute]);r.nodes[0].next=[first.id,second.id];const f=fixture([]);try{
    const simulated=await f.management.dryRun(r,{userId:'222',messages:[{userId:'222',text:'hello',afterSeconds:1}]});assert.equal(simulated.actions.length,1);for(const n of [first,second])assert.equal(simulated.trace.find(t=>t.nodeId===n.id&&t.status==='done').port,'next');assert.equal(simulated.trace.filter(t=>t.nodeId===join.id&&t.status==='done').length,1);
    const condition=node('found',{text:'x'},{next:join.id,otherwise:'$end'}),inactive=node('delay',{seconds:60},{next:join.id});r.nodes=[r.nodes[0],condition,inactive,join,mute];r.nodes[0].next=condition.id;const simple=await f.management.dryRun(r,{text:'x'});assert.equal(simple.actions.length,1);assert.ok(!simple.trace.some(t=>t.nodeId===inactive.id));
    const slowA=node('delay',{seconds:1},{next:mute.id}),slowB=node('delay',{seconds:1},{next:mute.id});r.nodes=[r.nodes[0],slowA,slowB,mute];r.nodes[0].next=[slowA.id,slowB.id];f.update([r]);f.management.handleEvent(message());await until(()=>f.management.snapshot().runs[0]?.trace.filter(t=>t.type==='delay'&&t.status==='running').length===2);f.update([{...r,enabled:false}]);await until(()=>!f.management.snapshot().active);assert.equal(f.calls.length,0);assert.equal(f.management.snapshot().runs[0].status,'cancelled');
  }finally{await f.close();}
});
test('protocol verifies role without cache, checks retcode and prevents cross-account actions',async()=>{
  const calls=[];let role='admin',identity='one',fail=false,change=false,lookups=0;
  const client={selfId:111,async call(api,args){calls.push({api,args});if(api==='get_group_member_info'){lookups++;if(change&&lookups===2)identity='two';return {status:'ok',retcode:0,data:{user_id:args.user_id,role:args.user_id===111?role:'member'}};}return {status:fail?'failed':'ok',retcode:fail?1:0};}};
  const actions=createModerationActions({client,currentIdentity:()=>identity});await actions.moderateGroup('12345',{action:'mute',userId:'222',seconds:60});assert.equal(calls.at(-1).api,'set_group_ban');assert.ok(calls.filter(c=>c.api==='get_group_member_info').every(c=>c.args.no_cache===true));
  role='member';calls.length=0;await assert.rejects(actions.moderateGroup('12345',{action:'kick',userId:'222'}),/管理员/);assert.ok(calls.every(c=>c.api==='get_group_member_info'));
  role='admin';fail=true;await assert.rejects(actions.moderateGroup('12345',{action:'rename_group',value:'新群名'}),/未确认/);
  fail=false;change=true;lookups=0;calls.length=0;await assert.rejects(actions.moderateGroup('12345',{action:'kick',userId:'222'}),/已改变/);assert.ok(!calls.some(c=>c.api==='set_group_kick'));
});
test('consecutive simulated observation windows never reuse a consumed message',async()=>{
  const f=fixture([]);try{
    const r=rule([node('user_sent',{seconds:60}),node('user_not_sent',{seconds:10}),node('mute',{seconds:60})]);
    const result=await f.management.dryRun(r,{messages:[{userId:'10002',text:'first',afterSeconds:1},{userId:'10002',text:'later',afterSeconds:50}]});assert.equal(result.actions.length,1,'second observation is 1–11 seconds, not 50–60, and cannot reuse the message at 1 second');
  }finally{await f.close();}
});
test('authority is checked after a delay and independent runtimes never share rules or runs',async()=>{
  const a=fixture([rule([node('delay',{seconds:1}),node('kick')])]),b=fixture([]);try{
    a.management.handleEvent(message());await until(()=>a.management.snapshot().active);a.setRole('member');await until(()=>!a.management.snapshot().active);assert.equal(a.calls.length,0);assert.match(a.management.snapshot().runs[0].error,/权限/);assert.equal(b.management.snapshot().runs.length,0);assert.equal(b.calls.length,0);
  }finally{await a.close();await b.close();}
});
test('intervals coalesce missed ticks and enabling starts a fresh interval',async()=>{
  let clock=0;const r=rule([],{nodes:[node('interval',{seconds:10}),node('rename_group',{text:'测试群名'})]}),f=fixture([r],{now:()=>clock});try{
    await new Promise(r=>setTimeout(r,550));clock=10000;await until(()=>f.calls.length===1);clock=1000000;await until(()=>f.calls.length===2);await new Promise(r=>setTimeout(r,550));assert.equal(f.calls.length,2,'missed ticks do not fan out');
    f.update([{...r,enabled:false}]);clock+=100000;f.update([r]);await new Promise(r=>setTimeout(r,550));assert.equal(f.calls.length,2);clock+=10000;await until(()=>f.calls.length===3);
  }finally{await f.close();}
});
test('account pause cancels immediately even if resumed before the next clock tick',async()=>{
  const bus=new Bus(),frozen={paused:false},f=fixture([rule([node('delay',{seconds:1}),node('kick')])],{bus,isPaused:()=>frozen.paused});try{
    f.management.handleEvent(message());await until(()=>f.management.snapshot().active);frozen.paused=true;bus.emit('status',{paused:true});frozen.paused=false;bus.emit('status',{paused:false});await until(()=>!f.management.snapshot().active);assert.equal(f.calls.length,0);assert.equal(f.management.snapshot().runs[0].status,'cancelled');
    frozen.paused=true;f.management.handleEvent(message());await new Promise(r=>setTimeout(r,25));assert.equal(f.management.snapshot().active,0);
  }finally{await f.close();}
});
