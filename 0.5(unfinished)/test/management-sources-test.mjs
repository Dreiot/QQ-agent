import test from 'node:test';
import assert from 'node:assert/strict';
import {NODE_CATALOG,validateManagement} from '../src/management/catalog.js';
import {createValueRuntime} from '../src/management/value-runtime.js';
import {executeManagementFlow} from '../src/management/flow.js';
import {evaluateExtendedNode} from '../src/management/nodes.js';
import {inputSource} from '../ui/panels/rules/management-sources.js';

const node=(id,type,config={},extra={})=>({id,type,config,...extra});
const port=(item,key)=>NODE_CATALOG.find(spec=>spec.type===item.type).ports.inputs.find(input=>input.key===key);
const source=(rule,item,key)=>inputSource(rule,item,NODE_CATALOG,port(item,key));
const ruleOf=nodes=>({id:'source-test',name:'来源验证',enabled:false,groups:['12345'],cooldownSeconds:0,nodes});
function runtime(rule){
  const root={rule,kind:'group',group:'12345',chatId:'12345',scopeId:'12345',user:'222',self:'111',targets:['222'],event:{user_id:'222',group_id:'12345',time:1700000000,message_id:'12',message:[{type:'text',data:{text:'#sl'}}]},startedAt:1700000001000,dry:true,elapsed:0,consumed:new Set(),record:{},controller:new AbortController()};
  const values=createValueRuntime({root,catalog:NODE_CATALOG,validateConfig:(_spec,config)=>config,guard:()=>{},trace:()=>{},now:()=>1700000010000});
  return {root,values};
}
async function walk(input){
  const rule=validateManagement({rules:[input]}).rules[0],{root,values}=runtime(rule),used=new Map();
  await executeManagementFlow({rule,catalog:NODE_CATALOG,initial:root,signal:root.controller.signal,step:async(state,original)=>{
    const prepared=await values.prepare(state,original),{run,node:item}=prepared;
    const result=await evaluateExtendedNode(run,item,{at:()=>root.startedAt+run.elapsed*1000,random:()=>0,recent:()=>[],members:async()=>[],member:async()=>null});
    used.set(item.id,{targets:[...run.targets],inputs:prepared.values});values.complete(state,original,run,{result:result?.pass??true});return result?.pass===false?'otherwise':'next';
  }});
  return {rule,used,values,root};
}

test('source descriptions follow binding, literal, configuration, inheritance and defaults used by the value runtime',async()=>{
  const start=node('start','message'),constant=node('constant','value_number',{value:18}),mute=node('mute','mute',{seconds:60},{values:{duration:45},bindings:{duration:{nodeId:'constant',port:'value'}}}),rule=ruleOf([start,mute,constant]);
  let engine=runtime(rule),actual=await engine.values.prepare(engine.root,mute);
  assert.equal(source(rule,mute,'duration').kind,'linked');assert.equal(actual.values.duration,18);
  delete mute.bindings.duration;actual=await engine.values.prepare(engine.root,mute);assert.equal(source(rule,mute,'duration').value,45);assert.equal(actual.values.duration,45);
  delete mute.values.duration;actual=await engine.values.prepare(engine.root,mute);assert.equal(source(rule,mute,'duration').value,60);assert.equal(actual.values.duration,60);
  delete mute.config.seconds;actual=await engine.values.prepare(engine.root,mute);assert.equal(source(rule,mute,'duration').value,600);assert.equal(actual.values.duration,600);
  const check=node('check','text_match',{match:'equals',text:'#sl'});rule.nodes.push(check);engine=runtime(rule);actual=await engine.values.prepare(engine.root,check);assert.equal(source(rule,check,'content').kind,'auto');assert.match(source(rule,check,'content').text,/01.*收到消息/);assert.equal(actual.values.content,'#sl');
  check.values={content:''};actual=await engine.values.prepare(engine.root,check);assert.equal(source(rule,check,'content').text,'空文字');assert.equal(actual.values.content,'','an explicit empty string is not an inherited value');
  const length=node('length','list_count');rule.nodes.push(length);engine=runtime(rule);actual=await engine.values.prepare(engine.root,length);assert.equal(source(rule,length,'list').label,'默认值');assert.deepEqual(actual.values.list,[]);
  const compare=node('compare','compare');rule.nodes.push(compare);assert.equal(source(rule,compare,'a').kind,'required');
});

test('a selection changes following members while an ordinary node override stays local',async()=>{
  const input=ruleOf([node('start','message'),node('select','target_union',{users:'333 444'}),node('local','note',{text:'本节点'},{values:{targets:['555']}}),node('after','note',{text:'后续'})]);
  const {rule,used}=await walk(input),local=rule.nodes.find(n=>n.id==='local'),after=rule.nodes.find(n=>n.id==='after');
  assert.deepEqual(used.get('select').targets,['222','333','444']);assert.deepEqual(used.get('local').targets,['555']);assert.deepEqual(used.get('after').targets,['222','333','444']);
  assert.equal(source(rule,local,'targets').text,'555');assert.match(source(rule,after,'targets').text,/02.*补充指定用户/);assert.doesNotMatch(source(rule,after,'targets').text,/本节点|555/);
  assert.match(source(rule,after,'user_id').text,/01.*收到消息/,'selection must not replace the event-related QQ');assert.equal(used.get('after').inputs.user_id,'222');
});

test('parallel and conditional paths describe possible member sources and the runtime merges only paths that arrive',async()=>{
  const input=ruleOf([node('start','message',{}, {next:['a','condition']}),node('a','target_union',{users:'333'},{next:'join'}),node('condition','text_match',{match:'equals',text:'no'},{next:'inactive',otherwise:'active'}),node('inactive','target_union',{users:'999'},{next:'join'}),node('active','target_union',{users:'444'},{next:'join'}),node('join','join',{}, {next:'$end'})]);
  const {rule,used}=await walk(input),join=rule.nodes.find(n=>n.id==='join'),hint=source(rule,join,'targets');
  assert.equal(used.has('inactive'),false);assert.deepEqual(new Set(used.get('join').targets),new Set(['222','333','444']));assert.match(hint.text,/实际到达.*合并/);assert.match(hint.detail,/02.*补充指定用户/);assert.match(hint.detail,/04.*补充指定用户/);assert.match(hint.detail,/05.*补充指定用户/);assert.match(hint.detail,/可能/,'static descriptions must not claim every possible branch actually ran');
});

test('automatic single-member override follows this node explicit member list rather than the unused inherited QQ',async()=>{
  const selector=node('selector','target_union',{users:'333'}),mute=node('mute','mute',{seconds:60},{values:{targets:['777','888']}}),rule=ruleOf([node('start','message'),selector,mute]);
  let engine=runtime(rule),prepared=await engine.values.prepare(engine.root,mute),members=source(rule,mute,'targets'),single=source(rule,mute,'user_id');
  assert.equal(prepared.values.user_id,'222','runtime still reads inherited user_id, but does not apply it as a singleton override');assert.deepEqual(prepared.run.targets,['777','888']);assert.ok(single.text.includes(members.text),'automatic single-member hint should identify the explicit target list used for the actual operation');
  mute.values={};mute.bindings={targets:{nodeId:'selector',port:'targets'}};engine=runtime(rule);engine.values.seed(selector,{targets:['333','444']});prepared=await engine.values.prepare(engine.root,mute);members=source(rule,mute,'targets');single=source(rule,mute,'user_id');assert.deepEqual(prepared.run.targets,['333','444']);assert.ok(single.text.includes(members.text),'automatic singleton hint should identify the bound target list');
  mute.bindings={};mute.values={user_id:'555'};prepared=await engine.values.prepare(engine.root,mute);assert.deepEqual(prepared.run.targets,['555']);assert.equal(source(rule,mute,'user_id').text,'555');
});

test('pure nodes use trigger context unless data is explicitly wired from a branch result',async()=>{
  const start=node('start','message'),selector=node('selector','target_union',{users:'333'}),read=node('read','data_field',{path:'user_id'}),rule=ruleOf([start,selector,read]),engine=runtime(rule);
  engine.values.seed(selector,{user_id:'444',targets:['333','444']});engine.root.targets=['222'];
  const prepared=await engine.values.prepare(engine.root,read);assert.equal(prepared.values.object.user_id,'222');assert.match(source(rule,read,'object').text,/01.*收到消息/);
  read.bindings={object:{nodeId:'start',port:'event'}};engine.values.seed(start,{event:{user_id:'555'}});const changed=await engine.values.prepare(engine.root,read);assert.equal(changed.values.object.user_id,'555');assert.equal(source(rule,read,'object').kind,'linked');
  const timestamp=node('time','time_format');rule.nodes.push(timestamp);const timeEngine=runtime(rule);assert.match(source(rule,timestamp,'time').detail,/开始时间/);delete timeEngine.root.event.time;assert.equal((await timeEngine.values.prepare(timeEngine.root,timestamp)).values.time,timeEngine.root.startedAt/1000);
});

test('template variables become required exactly when the configured template references them',async()=>{
  const text=node('text','format_text',{template:'成员 {{a}}，序号 {{d}}'}),rule=ruleOf([node('start','message'),text]);
  assert.equal(source(rule,text,'a').kind,'required');assert.equal(source(rule,text,'d').kind,'required');assert.equal(source(rule,text,'b').kind,'optional');assert.equal(source(rule,text,'c').kind,'optional');
  let engine=runtime(rule);await assert.rejects(engine.values.inspect([text.id]),/模板变量 a/);
  text.values={a:'小鱼',d:3};assert.equal(source(rule,text,'a').kind,'filled');assert.equal(source(rule,text,'d').kind,'filled');engine=runtime(rule);const [output]=await engine.values.inspect([text.id]);assert.equal(output.text,'成员 小鱼，序号 3');
  text.config.template='不需要变量';text.values={};assert.equal(source(rule,text,'a').kind,'optional');engine=runtime(rule);assert.equal((await engine.values.inspect([text.id]))[0].text,'不需要变量');
  text.values={template:'改用 {{b}}'};assert.equal(source(rule,text,'a').kind,'optional');assert.equal(source(rule,text,'b').kind,'required');
  text.bindings={template:{nodeId:'start',port:'text'}};assert.match(source(rule,text,'a').text,/连入.*模板/);assert.match(source(rule,text,'b').detail,/含.*\{\{b\}\}/);
});
