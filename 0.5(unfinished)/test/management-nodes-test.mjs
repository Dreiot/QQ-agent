import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGroupManagement} from '../src/management/runtime.js';
import {NODE_CATALOG,validateManagement} from '../src/management/catalog.js';
import {createMessageWindow} from '../src/management/nodes.js';
import {createModerationActions} from '../bundled/transport-onebot/moderation.js';
import {createOneBotProvider} from '../bundled/transport-onebot/provider.js';
import {createSendQueue} from '../src/kernel/send.js';
import {buildDefaultConfig} from '../src/kernel/config.js';
let serial=0,mid=0;
const n=(type,config={},extra={})=>({id:'n'+(++serial),type,config,...extra});
const rule=(nodes,trigger='message')=>({id:'rule',name:'扩展测试',enabled:true,groups:['12345'],cooldownSeconds:0,nodes:[n(trigger),...nodes]});
const action=()=>n('rename_group',{text:'已通过'});
const until=async fn=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,5));}};
function fixture(rules=[],options={}){
  const dir=options.dir??fs.mkdtempSync(path.join(os.tmpdir(),'qqa-managed-nodes-')),calls=[],sent=[],clock=options.clock??{value:Date.now()},listeners=new Set();let currentRules=rules,role='owner';
  const config={get:()=>({management:{rules:currentRules}}),onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const transport={selfId:'111',status:()=>({connected:true}),actions:{getModerationMember:async(_group,user)=>({userId:user,role:String(user)==='111'?role:String(user)==='333'?'admin':'member',nickname:'小鱼',card:'测试名片',joinTime:clock.value/1000-300}),getModerationMembers:async()=>[{userId:'111',role},{userId:'222',role:'member',card:'测试名片'},{userId:'333',role:'admin',card:'管理员'},{userId:'444',role:'member',card:''}],moderateGroup:async(group,operation,opts)=>{opts.current();calls.push({group,...operation});}}};
  const send={sendTextBatch:async(group,text,opts)=>{await opts.beforeSend();sent.push({group,text});return {ok:true};},sendSegments:async(group,segments,opts)=>{await opts.beforeSend();sent.push({group,segments});return {ok:true};}};
  const management=createGroupManagement({config,transport,send,dataDir:dir,now:()=>clock.value});management.start();
  return {dir,management,calls,sent,clock,transport,setRole:value=>role=value,update(rules){currentRules=rules;for(const fn of listeners)fn();},async fire(text='x',user='222',extra={}){const previous=management.snapshot().runs[0]?.id;management.handleEvent({kind:'group',id:'12345',type:'message',event:{user_id:user,message_id:++mid,message:[{type:'text',data:{text}}],...extra}});await until(()=>!management.snapshot().active&&management.snapshot().runs[0]?.id!==previous);return management.snapshot().runs[0];},async close(keep=false){await management.close();if(!keep){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('qqa-managed-nodes-'));fs.rmSync(dir,{recursive:true,force:true});}}};
}
test('three-way matching chooses the first matching route, fallback and common join exactly once',async()=>{
  const join=n('join'),end=n('note',{text:'结束'}),help=action(),bad=n('mute',{seconds:60}),split=n('switch_text',{}, {routes:[{id:'help',label:'帮助',value:'帮助',match:'contains',next:help.id},{id:'bad',label:'违规',value:'违规',match:'contains',next:bad.id}],otherwise:join.id});help.next=bad.next=join.id;join.next=end.id;end.next='$end';const r=rule([split,help,bad,join,end]);const f=fixture();try{
    const first=await f.management.dryRun(r,{text:'帮助和违规'});assert.equal(first.actions[0].action,'rename_group');assert.equal(first.trace.filter(t=>t.type==='join'&&t.status==='done').length,1);assert.ok(first.trace.some(t=>t.port==='route:help'));
    const other=await f.management.dryRun(r,{text:'普通消息'});assert.equal(other.actions.length,0);assert.equal(other.trace.filter(t=>t.type==='join'&&t.status==='done').length,1);assert.ok(other.trace.some(t=>t.nodeId===split.id&&t.port==='otherwise'));
  }finally{await f.close();}
});
test('user and role switches route to named cases instead of collapsing to a boolean',async()=>{
  const f=fixture();try{for(const [type,value,scenario]of [['switch_user','222 444',{userId:'222'}],['switch_role','admin',{roles:{'10002':'admin'}}]]){const act=action(),split=n(type,{}, {routes:[{id:'route1',label:'匹配',value,next:act.id}],otherwise:'$end'});const result=await f.management.dryRun(rule([split,act]),scenario);assert.equal(result.actions.length,1);assert.ok(result.trace.some(t=>t.port==='route:route1'));}}finally{await f.close();}
});
test('text, mentions, dates, names, membership and probability conditions evaluate actual input',async()=>{
  const f=fixture(),now=new Date(2026,9,26,12).getTime();const cases=[
    [n('text_length',{min:1,max:1}),{text:'😄'},true],
    [n('contains_any',{text:'广告\n违规'}),{text:'违规了'},true],[n('contains_all',{text:'广告\n违规'}),{text:'只有广告'},false],
    [n('mentions_bot'),{event:{message:[{type:'at',data:{qq:'111'}}]}},true],[n('mentions_users',{users:'222'}),{event:{message:[{type:'at',data:{qq:'all'}}]}},false],
    [n('weekday',{days:'1 2 3'}),{now},true],[n('date_range',{start:'2026-10-25',end:'2026-10-27'}),{now},true],
    [n('card_matches',{match:'prefix',text:'测试'}),{memberInfo:{'10002':{card:'测试名片'}}},true],
    [n('nickname_matches',{match:'suffix',text:'鱼'}),{memberInfo:{'10002':{nickname:'小鱼'}}},true],
    [n('has_card'),{memberInfo:{'10002':{card:''}}},false],
    [n('joined_recently',{seconds:600}),{now,memberInfo:{'10002':{joinTime:now/1000-300}}},true],
    [n('joined_recently',{seconds:600}),{now,memberInfo:{'10002':{joinTime:0}}},false],
    [n('bot_owner'),{botRole:'admin'},false],[n('target_count',{min:1,max:1}),{},true],[n('group_is',{groups:'12345 55555'}),{},true],
    [n('chance',{percent:50}),{random:.49},true],[n('chance',{percent:50}),{random:.5},false],
  ];try{for(const [condition,scenario,expected]of cases){const result=await f.management.dryRun(rule([condition,action()]),scenario);assert.equal(result.status,'done',condition.type+': '+result.error);assert.equal(result.actions.length,expected?1:0,condition.type);}}finally{await f.close();}
});
test('frequency and duplicate content count real distinct messages, never duplicate protocol deliveries',async()=>{
  const f=fixture([rule([n('repeated_message',{seconds:60,count:3}),n('mute',{seconds:20})])]);try{
    await f.fire('相同');await f.fire('相同');await f.fire('不同');await f.fire('相同');assert.equal(f.calls.length,1);
    const lastMid=mid;f.management.handleEvent({kind:'group',id:'12345',type:'message',event:{user_id:'222',message_id:lastMid,message:[{type:'text',data:{text:'相同'}}]}});await new Promise(r=>setTimeout(r,20));assert.equal(f.calls.length,1);
    const yes=await f.management.dryRun(rule([n('message_frequency',{seconds:10,count:3,scope:'user'}),action()]),{userId:'222',history:[{afterSeconds:-5,userId:'222',text:'a'},{afterSeconds:-1,userId:'222',text:'b'},{afterSeconds:-1,userId:'333',text:'c'}]});assert.equal(yes.actions.length,1);
  }finally{await f.close();}
});
test('selectors compose by mentions, exclusion, intersection, role, card and recent speakers',async()=>{
  const f=fixture(),cases=[
    [[n('target_mentions'),n('target_exclude',{users:'444'})],{event:{message:[{type:'at',data:{qq:'222'}},{type:'at',data:{qq:'444'}},{type:'at',data:{qq:'all'}}]}},['222']],
    [[n('target_users',{users:'222 444'}),n('target_intersect',{users:'444'})],{},['444']],
    [[n('target_users',{users:'10002 444'}),n('target_except_sender')],{},['444']],
    [[n('target_role',{role:'member'})],{members:[{userId:'222',role:'member'},{userId:'333',role:'admin'}]},['222']],
    [[n('target_by_card',{match:'contains',text:'测试'})],{members:[{userId:'222',role:'member',card:'测试卡'},{userId:'444',role:'member',card:'其他'}]},['222']],
    [[n('target_recent',{seconds:60})],{userId:'222',history:[{afterSeconds:-5,userId:'444',text:'x'},{afterSeconds:-90,userId:'555',text:'y'}]},['222','444']],
    [[n('target_users',{users:'222 444'}),n('target_random',{count:1})],{random:0},['444']],
  ];try{for(const [nodes,scenario,expected]of cases){const result=await f.management.dryRun(rule([...nodes,n('mute',{seconds:10})]),scenario);assert.equal(result.status,'done',result.error);assert.deepEqual(result.actions.map(a=>a.userId),expected,nodes[0].type);}}finally{await f.close();}
});
test('counters persist across rounds/restart, expire and stay separate from dry runs',async()=>{
  const add=n('counter_add',{key:'次数',scope:'user',amount:1,seconds:60}),check=n('counter_check',{key:'次数',scope:'user',count:3}),r=rule([add,check,n('mute',{seconds:10})]);const clock={value:Date.now()};let f=fixture([r],{clock});let kept=false;
  try{await f.fire();await f.fire();assert.equal(f.calls.length,0);const simulation=await f.management.dryRun(r,{userId:'222',counterValues:{'次数':2}});assert.equal(simulation.actions.length,1);assert.equal(f.calls.length,0);await f.close(true);kept=true;f=fixture([r],{clock,dir:f.dir});kept=false;await f.fire();assert.equal(f.calls.length,1,'third real round persisted after restart');clock.value+=61000;await f.fire();assert.equal(f.calls.length,1,'expired count starts over');}finally{await f.close(kept);}
});
test('counter reset, wait-until and random delay are reflected by subsequent nodes',async()=>{
  const f=fixture(),now=new Date(2026,9,26,23,59).getTime();try{
    const result=await f.management.dryRun(rule([n('wait_until',{time:'00:01'}),n('time_between',{start:'00:00',end:'00:02'}),action()]),{now});assert.equal(result.actions.length,1);
    const reset=await f.management.dryRun(rule([n('counter_reset',{key:'次数',scope:'user'}),n('counter_check',{key:'次数',scope:'user',count:1}),action()]),{counterValues:{'次数':5}});assert.equal(reset.actions.length,0);
    const random=await f.management.dryRun(rule([n('random_delay',{min:1,max:10}),n('time_between',{start:'12:00',end:'12:01'}),action()]),{now:new Date(2026,9,26,11,59,55).getTime(),random:.9});assert.equal(random.actions.length,1);
  }finally{await f.close();}
});
test('new triggers are normalized by the real provider; bot invitations are not treated as join requests',()=>{
  const events=[];let raw;class Client{constructor(options){raw=options.onEvent;this.selfId=111;}}
  createOneBotProvider({cfg:()=>({onebot:{}}),clientFactory:Client,onEvent:event=>events.push(event)});
  for(const [notice,type]of [['group_decrease','member_leave'],['group_admin','admin_changed'],['group_upload','group_upload']]){raw({post_type:'notice',notice_type:notice,group_id:12345,user_id:222});assert.equal(events.at(-1).type,type);}
  raw({post_type:'request',request_type:'group',sub_type:'add',group_id:12345,user_id:222,flag:'private-flag'});assert.equal(events.at(-1).type,'join_request');const count=events.length;raw({post_type:'request',request_type:'group',sub_type:'invite',group_id:12345,user_id:222});assert.equal(events.length,count);
});
test('join approval uses only a received request context; simulation never submits it',async()=>{
  const f=fixture();try{
    const result=await f.management.dryRun(rule([n('approve_join')],'join_request'),{text:'验证信息'});assert.equal(result.actions[0].action,'approve_join');assert.equal(f.calls.length,0);
    const bad=await f.management.dryRun(rule([n('approve_join')]));assert.equal(bad.status,'failed');assert.match(bad.error,/真实入群申请/);
    const reject=await f.management.dryRun(rule([n('reject_join',{text:'验证信息不完整'})],'join_request'));assert.equal(reject.actions[0].value,'验证信息不完整');
  }finally{await f.close();}
});
test('owner operations recheck current ownership and reject unconfirmed native success',async()=>{
  const calls=[];let role='admin',ret={status:'ok',retcode:0},lookup=0,demote=false;const client={selfId:111,async call(api,args){calls.push({api,args});if(api==='get_group_member_info'){lookup++;if(demote&&lookup===3)role='admin';return {status:'ok',retcode:0,data:{user_id:args.user_id,role:args.user_id===111?role:args.user_id===333?'admin':'member'}};}return ret;}};
  const a=createModerationActions({client,currentIdentity:()=>1});await assert.rejects(a.moderateGroup('12345',{action:'grant_admin',userId:'222'}),/群主/);role='owner';await a.moderateGroup('12345',{action:'revoke_admin',userId:'333'});assert.equal(calls.at(-1).api,'set_group_admin');assert.equal(calls.at(-1).args.enable,false);
  role='owner';lookup=0;demote=true;calls.length=0;await assert.rejects(a.moderateGroup('12345',{action:'special_title',userId:'222',value:'头衔'}),/群主/);assert.ok(!calls.some(c=>c.api==='set_group_special_title'));
  role='owner';demote=false;ret={};await assert.rejects(a.moderateGroup('12345',{action:'rename_group',value:'群名'}),/未确认/);await assert.rejects(a.moderateGroup('12345',{action:'rename_group',value:'群名'},{current:()=>false}),/已改变/);
});
test('messages use the injected send queue, variables are plain text and oversized expansions fail in simulation too',async()=>{
  const r=rule([n('send_text',{text:'欢迎 {{nickname}} · {{user}} · {{group}}'})]),f=fixture([r]);try{
    await f.fire('x','222',{sender:{nickname:'小鱼'}});assert.equal(f.sent[0].text,'欢迎 小鱼 · 222 · 12345');assert.equal(f.calls.length,0);
    const tooLong=await f.management.dryRun(rule([n('special_title',{text:'{{nickname}}'})]),{botRole:'owner',event:{sender:{nickname:'很长的昵称'.repeat(20)}}});assert.equal(tooLong.status,'failed');assert.match(tooLong.error,/替换变量/);
  }finally{await f.close();}
});
test('every advertised node has valid metadata and rejects inconsistent parameters/route graphs',()=>{
  assert.equal(new Set(NODE_CATALOG.map(n=>n.type)).size,NODE_CATALOG.length);assert.ok(NODE_CATALOG.length>=70);for(const spec of NODE_CATALOG){assert.ok(spec.label&&spec.group);assert.ok(Array.isArray(spec.fields));}
  assert.throws(()=>validateManagement({rules:[rule([n('random_delay',{min:10,max:2})])]}),/最小值/);
  assert.throws(()=>validateManagement({rules:[rule([n('weekday',{days:'8'})])]}),/星期/);
  assert.throws(()=>validateManagement({rules:[rule([n('date_range',{start:'2026-02-30',end:'2026-03-02'})])]}),/日期/);
  assert.throws(()=>validateManagement({rules:[rule([n('switch_role',{}, {routes:[{id:'a',label:'不存在',value:'superadmin',next:'$end'}]})])]}),/身份/);
});
test('message observation storage is bounded and contains hashes rather than message text',()=>{
  const window=createMessageWindow();for(let i=0;i<11000;i++)window.add(String(i%10),{user_id:222,message_id:i,message:'private text '+i},i);assert.ok(window.size<=10000);const recent=window.recent('0',0);assert.ok(recent.length);assert.equal(recent[0].text,undefined);assert.match(recent[0].hash,/^[a-f0-9]{64}$/);assert.equal(window.add('0',{user_id:222,message_id:11000,message:'x'},11000),true);assert.equal(window.add('0',{user_id:222,message_id:11000,message:'x'},11000),false);window.clear();assert.equal(window.size,0);
});
test('existing and compatibility nodes execute through the real dry-run engine; primitives have their own exhaustive suite, with real action plans for every action type',async()=>{
  const f=fixture(),now=new Date(2026,9,26,12).getTime();try{
    for(const spec of NODE_CATALOG.filter(spec=>!spec.primitive)){
      const config=Object.fromEntries(spec.fields.map(field=>[field.key,field.default??(field.key==='users'?'222':field.key==='groups'?'12345':field.label.includes('YYYY-MM-DD')?(field.key==='start'?'2026-10-25':'2026-10-27'):'测试')]));
      const node=n(spec.type,config);if(spec.type==='format_text')node.values={a:'测试'};if(spec.routeKind)node.routes=[{id:'case1',label:'测试分支',value:spec.routeKind==='user'?'222':spec.routeKind==='role'?'member':'测试',...(spec.routeKind==='text'?{match:'contains'}:{}),next:'$end'}];
      const scenario={userId:'222',text:'测试',now,botRole:'owner',roles:{'222':'member','333':'admin'},members:['222','333'],memberInfo:{'222':{nickname:'测试',card:'测试',joinTime:now/1000-300}},messages:[{userId:'222',text:'测试',afterSeconds:1}],random:.25};
      const r=spec.trigger?{...rule([]),nodes:[node]}:rule([...(spec.type==='revoke_admin'?[n('target_users',{users:'333'})]:[]),node],['approve_join','reject_join'].includes(spec.type)?'join_request':'message');
      if(spec.pure){r.nodes[0].next='$end';scenario.inspectNodes=[node.id];}
      const result=await f.management.dryRun(r,scenario);assert.equal(result.status,'done',spec.type+': '+result.error);assert.ok(result.trace.some(t=>t.type===spec.type&&t.status==='done'),spec.type+' must have an executor');
      if(spec.group==='执行')assert.ok(result.actions.some(a=>a.action===(spec.type==='recall_window'?'recall':spec.type)),spec.type+' must produce an explicit operation');
    }
    assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
  }finally{await f.close();}
});
test('queued management messages recheck authority when they actually leave the shared send queue',async()=>{
  let release,entered=false,allowed=true;const firstGate=new Promise(resolve=>release=resolve),calls=[];
  const queue=createSendQueue({cfg:()=>buildDefaultConfig(),store:{appendSelf(){}},transport:{async send(_group,segments){calls.push(segments);if(calls.length===1){entered=true;await firstGate;}return {msgId:calls.length};}}});
  const first=queue.sendTextBatch('group:12345','普通排队消息');await until(()=>entered);
  const second=queue.sendTextBatch('group:12345','需要再次核验的管理消息',{beforeSend(){if(!allowed)throw Error('已失去管理权限');}});const rejected=assert.rejects(second,/已失去管理权限/);allowed=false;release();await first;await rejected;assert.equal(calls.length,1);
});
test('record summaries omit heavy details and request flags never enter persisted live history',async()=>{
  const r=rule([n('approve_join')],'join_request'),f=fixture([r]);try{
    f.management.handleEvent({kind:'group',id:'12345',type:'join_request',event:{post_type:'request',request_type:'group',sub_type:'add',group_id:12345,user_id:222,flag:'fixture-request-private-flag'}});await until(()=>!f.management.snapshot().active&&f.management.snapshot().runs.length===1);assert.equal(f.calls.length,1);
    const summary=f.management.snapshot({summary:true}).runs[0];assert.equal(summary.trace,undefined);assert.equal(summary.actions,undefined);assert.ok(summary.traceCount>0);const detail=f.management.getRun(summary.id);assert.ok(detail.trace.length);assert.equal(f.management.getRun('unknown'),null);
    await f.management.close();assert.ok(!fs.readFileSync(path.join(f.dir,'group-management-runs.json'),'utf8').includes('fixture-request-private-flag'));
  }finally{await f.close();}
});
