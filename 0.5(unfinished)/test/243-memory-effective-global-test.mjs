// Effective community policy from discovery through model input and host commit.
// All service/model/transport boundaries in this file are owned in-process fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getEventListeners } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createCapabilityRegistry } from '../src/kernel/capability.js';
import { createChatStore } from '../src/kernel/store.js';
import { createMemoryStore } from '../src/kernel/memory.js';
import { createMemoryConsolidator } from '../bundled/memory-service/consolidator.js';
import { createMemoryConsolidationAdapter, requestMemoryConsolidation } from '../src/console/memory-media-adapters.js';
import { createApplication } from '../src/kernel/composition.js';
import { defaultComponents as defaults } from '../bundled/runtime-defaults/components.js';

const root = path.resolve(import.meta.dirname, '..'), attempts = [], restores = [];
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let n=0;n<300;n++) { if (check()) return; await tick(); } assert.ok(check(), 'owned fixture reached its terminal state'); }
const result = input => ({ message: { role: 'assistant', content: JSON.stringify({ impressions: input.impressions.length ? input.impressions.slice(0, 1) : [{ content: `真实印象${input.userId}`, createdAt: 243 }] }) }, usage: {} });
function deny(object, key, label) { if (typeof object[key] !== 'function') return; const original=object[key]; object[key]=()=>{attempts.push(label);throw new Error('243 forbids '+label);}; restores.push(()=>{object[key]=original;}); }
test.before(()=>{
  for(const key of ['connect','createConnection']) deny(net,key,'net.'+key);
  deny(net.Socket.prototype,'connect','socket');deny(net.Server.prototype,'listen','listener');deny(tls,'connect','TLS');deny(dgram,'createSocket','dgram');
  for(const object of [http,https])for(const key of ['get','request'])deny(object,key,'HTTP '+key);
  for(const object of [dns,dns.promises])for(const key of Object.keys(object))if(/^(resolve|lookup|reverse)/.test(key))deny(object,key,'DNS '+key);
  for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])deny(childProcess,key,'native '+key);
  deny(globalThis,'fetch','fetch');syncBuiltinESMExports();
});
test.after(()=>{for(const restore of restores.reverse())restore();syncBuiltinESMExports();assert.deepEqual(attempts,[]);});
function removeTemporary(folder) {const resolved=path.resolve(folder);assert.equal(path.dirname(resolved).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('qqa-memory243-'));fs.rmSync(resolved,{recursive:true,force:true});}
function temporary(t,register=true) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-memory243-'));
  if(register)t.after(()=>removeTemporary(folder));
  return folder;
}
function pure(t,{ids=['444'],config={},model=null,source=null}={}) {
  const dataDir=temporary(t),c={api:{model:'offline243'},memory:{maxImpressionsPerMember:5},globalBlocklist:['333'],communityExemptions:['333'],...config};
  let change;const capability=createCapabilityRegistry({log:{},selection:()=>c.capabilityProviders??{},subscribeSelection:fn=>{change=fn;}});
  const store=createChatStore({dataDir,log:{}}),memory=createMemoryStore({dataDir,cfg:()=>c,log:{}}),models=[],events=[];
  const community=source??{getBlocklist:()=>({ok:true,ids})};capability.register('community.client','kernel',community);
  const run=createMemoryConsolidator({cfg:()=>c,memory,store,log:{},callLLM:async args=>{const input=JSON.parse(args.messages[1].content.split('\n').at(-1));models.push(input);return model?model(input,args):result(input);}});
  capability.register('memory.consolidate','kernel',run);
  const adapter=createMemoryConsolidationAdapter({capability,memory,store,cfg:()=>c,emit:(_name,event)=>events.push(event)});
  const append=(uid,count=1)=>{for(let i=0;i<count;i++)store.appendIncoming('group:100',{senderId:uid,senderName:'成员'+uid,text:`发言${uid}-${i}`,ts:243+i});};
  const old=(uid)=>memory.append('group:100',{userId:uid,name:'成员'+uid,content:'旧印象'+uid});
  const file=uid=>path.join(dataDir,'memory/group_100',uid+'.json');
  const done=async()=>{await until(()=>!adapter.running.size);return events.at(-1);};
  const pin=(name,id)=>{c.capabilityProviders={...c.capabilityProviders,[name]:id};change();};
  return{dataDir,c,capability,store,memory,models,events,adapter,append,old,file,done,pin,community,run};
}

test('selected effective IDs reach the default model DTO; excluded existing archives stay byte stable',async t=>{
  const e=pure(t);e.append('333',45);e.append('444',45);e.append('555');e.old('444');e.old('555');
  e.memory.append('group:100',{userId:'555',name:'成员555',content:'第二条旧印象'});
  const blockedBefore=fs.readFileSync(e.file('444'),'utf8');
  let reads=0;const recent=e.store.recent;e.store.recent=(...args)=>{reads++;return recent(...args);};
  assert.equal(e.adapter.start({chatKey:'group:100',create:true,createUserIds:['333','444']}).status,202);
  assert.equal((await e.done()).phase,'consolidate-done');
  assert.deepEqual(e.models.map(input=>input.userId).sort(),['333','555']);
  assert.equal(e.models.find(input=>input.userId==='333').messages.length,40);
  assert.equal(e.models.find(input=>input.userId==='333').messages[0].text,'发言333-5');
  assert.equal(reads,1,'default consolidator consumes supplied history instead of reading raw archives');
  assert.equal(fs.readFileSync(e.file('444'),'utf8'),blockedBefore);
  assert.equal(e.memory.query('group:100',{userId:'333'})[0].impressions[0].content,'真实印象333');
});

test('manual create and merge cannot process blocked IDs, including a historical name-only file',async t=>{
  const e=pure(t);e.append('444',3);e.old('444');e.memory.append('group:100',{name:'成员444',content:'旧名称档'});
  const before=fs.readFileSync(e.file('444'),'utf8');
  assert.equal(e.adapter.start({chatKey:'group:100',userIds:['444'],create:true}).status,202);
  assert.equal((await e.done()).phase,'consolidate-error');assert.equal(e.models.length,0);
  assert.equal(e.memory.lastConsolidatedAt('group:100'),0);assert.equal(fs.readFileSync(e.file('444'),'utf8'),before);
  assert.equal(e.adapter.start({chatKey:'group:100'}).status,202);await e.done();assert.equal(e.models.length,0);
  assert.ok(e.memory.query('group:100').some(member=>!member.userId&&member.name==='成员444'));
});

test('an actual Promise is awaited; valid empty selected IDs override raw config, source errors use exemption fallback',async t=>{
  const hold=deferred();let current=()=>hold.promise;
  const e=pure(t,{config:{globalBlocklist:['333','555'],communityExemptions:['333']},source:{getBlocklist:()=>current()}});e.append('333');e.append('555');
  assert.equal(e.adapter.start({chatKey:'group:100',userIds:['555'],create:true}).status,202);await tick();assert.equal(e.models.length,0);
  current=()=>({ok:true,ids:[]});hold.resolve({ok:true,ids:[]});await e.done();assert.deepEqual(e.models.map(input=>input.userId),['555']);
  current=()=>{throw new Error('owned source unavailable');};
  assert.equal(e.adapter.start({chatKey:'group:100',userIds:['333'],create:true}).status,202);await e.done();assert.equal(e.models.at(-1).userId,'333');
  const count=e.models.length;assert.equal(e.adapter.start({chatKey:'group:100',userIds:['555'],create:true}).status,202);await e.done();assert.equal(e.models.length,count);
});

test('a member blocked during the model wait is preserved while other valid proposals commit without false cooldown',async t=>{
  const hold=deferred(),ids=[];const e=pure(t,{ids,model:async input=>{if(input.userId==='555')await hold.promise;return result(input);}});
  e.old('555');e.old('666');const before=fs.readFileSync(e.file('555'),'utf8');
  assert.equal(e.adapter.start({chatKey:'group:100'}).status,202);await until(()=>e.models.length>0);ids.push('555');hold.resolve();
  const terminal=await e.done();assert.equal(terminal.phase,'consolidate-done');assert.equal(terminal.updated,1);assert.ok(terminal.failures.some(f=>f.userId==='555'));
  assert.equal(fs.readFileSync(e.file('555'),'utf8'),before);assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
});

for(const name of ['community.client','memory.consolidate'])for(const mutation of ['pin-ABA','same-registration'])test(`${name} ${mutation} latches invalidation and rejects a late proposal`,async t=>{
  const hold=deferred();const e=pure(t,{ids:[],model:async input=>{await hold.promise;return result(input);}});e.old('555');
  const before=fs.readFileSync(e.file('555'),'utf8');
  assert.equal(e.adapter.start({chatKey:'group:100'}).status,202);await until(()=>e.models.length===1);
  const original=name==='community.client'?e.community:e.run;
  if(mutation==='same-registration')e.capability.register(name,'kernel',original);
  else {e.capability.register(name,'other',name==='community.client'?{getBlocklist:()=>({ok:true,ids:[]})}:async args=>({members:args.members}));e.pin(name,'other');e.pin(name,'kernel');}
  await e.done();hold.resolve();await tick();assert.equal(e.events.at(-1).phase,'consolidate-error');
  assert.equal(fs.readFileSync(e.file('555'),'utf8'),before);assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
});

test('caller cancellation clears running state before a model that ignores abort returns',async t=>{
  const hold=deferred();const e=pure(t,{ids:[],model:async input=>{await hold.promise;return result(input);}});e.old('555');const before=fs.readFileSync(e.file('555'),'utf8');
  const controller=new AbortController();assert.equal(e.adapter.start({chatKey:'group:100',signal:controller.signal}).status,202);await until(()=>e.models.length===1);controller.abort(new Error('owned cancellation'));
  assert.equal((await e.done()).phase,'consolidate-error');hold.resolve();await tick();assert.equal(fs.readFileSync(e.file('555'),'utf8'),before);assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
});

test('concurrent appends and persistence failures preserve memory and do not mark cooldown',async t=>{
  const hold=deferred();const e=pure(t,{ids:[],model:async input=>{await hold.promise;return result(input);}});e.old('555');
  assert.equal(e.adapter.start({chatKey:'group:100'}).status,202);await until(()=>e.models.length===1);e.memory.append('group:100',{userId:'555',name:'成员555',content:'等待时追加事实'});hold.resolve();assert.equal((await e.done()).phase,'consolidate-error');assert.equal(e.memory.query('group:100',{userId:'555'})[0].impressions.length,2);assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
  const before=fs.readFileSync(e.file('555'),'utf8'),write=fs.writeFileSync;
  fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(e.file('555')+'.'))throw new Error('owned disk write failure');return write(file,...args);};
  try {assert.equal(e.adapter.start({chatKey:'group:100'}).status,202);assert.equal((await e.done()).phase,'consolidate-error');}finally{fs.writeFileSync=write;}
  assert.equal(fs.readFileSync(e.file('555'),'utf8'),before);assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
});

function writeFixturePlugin(appRoot,id,source,permissions=[]) {
  const dir=path.join(appRoot,'plugins',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify({id,kind:'plugin',apiVersion:1,entry:'index.js',enabledByDefault:true,permissions}));fs.writeFileSync(path.join(dir,'index.js'),source);return dir;
}
async function application(t,{config={},layer=null,sourceManaged=false}={}) {
  const appRoot=temporary(t,false),dataDir=path.join(appRoot,'data'),models=[],chatModels=[],events=[];let app,mid=24300,onChat=null;
  const bridge={ids:['444'],source:null,memory:null,sourceCalls:0,sourceStarts:0,sourceStops:0};globalThis.__memory243=bridge;
  t.after(async()=>{try{await app?.stop();}finally{if(globalThis.__memory243===bridge)delete globalThis.__memory243;removeTemporary(appRoot);}});
  for(const name of ['bundled','plugins','skills'])fs.mkdirSync(path.join(appRoot,name),{recursive:true});fs.writeFileSync(path.join(appRoot,'package.json'),' {"type":"module"}');
  fs.cpSync(path.join(root,'bundled/core-tools'),path.join(appRoot,'bundled/core-tools'),{recursive:true});
  const memoryDir=path.join(appRoot,'bundled/memory-service');fs.mkdirSync(memoryDir);fs.copyFileSync(path.join(root,'bundled/memory-service/plugin.json'),path.join(memoryDir,'plugin.json'));fs.writeFileSync(path.join(memoryDir,'index.js'),`export {default} from ${JSON.stringify(pathToFileURL(path.join(root,'bundled/memory-service/index.js')).href)};`);
  writeFixturePlugin(appRoot,'community243',`export default {setup(ctx){const b=globalThis.__memory243;ctx.registerCapability('community.client',{start(){b.sourceStarts++;},stop(){b.sourceStops++;},getBlocklist(options){b.sourceCalls++;return b.source?b.source(options):{ok:true,ids:b.ids};}},{lifecycle:${sourceManaged}});}};`,['net.outbound']);
  writeFixturePlugin(appRoot,'sdk243',`export default {setup(ctx){globalThis.__memory243.sdk=args=>ctx.capability('memory.consolidate',args);globalThis.__memory243.registerMemory=provider=>ctx.registerCapability('memory.consolidate',provider,{lifecycle:true});}};`,['net.outbound','data.memory.read','data.sessions.read','fs.outsideNamespace']);
  if(layer){const dir=path.join(appRoot,'overrides/memory243');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'composition.json'),JSON.stringify({version:2,id:'memory243',enabled:layer.enabled!==false,components:{'core.orchestrator':{module:'index.mjs',mode:layer.mode}}}));fs.writeFileSync(path.join(dir,'index.mjs'),layer.mode==='wrap'?'export default previous=>options=>{globalThis.__memory243.layer="wrap";return previous(options);};':`import {createOrchestrator} from ${JSON.stringify(pathToFileURL(path.join(root,'src/kernel/orchestrator.js')).href)};export default options=>{globalThis.__memory243.layer="replace";return createOrchestrator(options);};`);}
  const transport={id:'owned243',selfId:'800',start(){},stop(){},actions:{getAccountIdentity:()=> '800'},send:async()=>({msgId:++mid}),toPlatformSegments:segments=>segments};
  app=await createApplication({appRoot,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_MIGRATE_FROM:path.join(appRoot,'absent'),QQ_AGENT_PORT:'0'},transport,
    components:{'runtime.logger':options=>defaults['runtime.logger']({...options,mirrorConsole:false}),'runtime.serviceLease':options=>{const select=defaults['runtime.serviceLease'](options);return(name,args)=>{const lease=select(name,args);bridge.onLease?.(name,lease);return lease;};},'llm.complete':async args=>{if(!String(args.messages[0]?.content).includes('你是群友记忆整理器')){chatModels.push(args.messages);onChat?.();return {message:{role:'assistant',content:''},finishReason:'stop'};}const input=JSON.parse(args.messages[1].content.split('\n').at(-1));models.push({input,args});return bridge.memory?bridge.memory(input,args):result(input);}},
    fetchImpl:async()=>{throw new Error('243 generic SDK HTTP must remain inert');},priceUpdates:{refresh:async()=>({ok:true,remote:false}),resolve:()=>null},communityMarket:{getBlocklist(){throw new Error('243 must use selected community, never fixed default cache');}}});
  app.config.update({api:{model:'offline243',maxRounds:1},allow:{groups:['100']},allowAllWhenEmpty:false,globalBlocklist:['333'],communityExemptions:['333'],telemetry:{enabled:false},proactive:{enabled:false},chatActive:{enabled:false},sticker:{enabled:false},memory:{consolidateEnabled:true,discoverMinMessages:20,discoverMaxMembers:3},sessionRetryAttempts:0,store:{contextSliderPos:100,historyCount:10,promptAnchor:{enabled:false}},...config});
  app.bus.on('memory.update',event=>events.push(event),{internal:true});
  await app.loader.loadAll();assert.deepEqual(app.loader.listEntries().map(e=>e.id).sort(),['community243','core-tools','memory-service','sdk243']);for(const entry of app.loader.listEntries())assert.equal(entry.status,'active',entry.id+': '+entry.loadError);
  assert.equal(app.permissions.setOverride('community243','net.outbound','allow'),true);for(const scope of ['net.outbound','data.memory.read','data.sessions.read','fs.outsideNamespace'])assert.equal(app.permissions.setOverride('sdk243',scope,'allow'),true);
  await app.services.start();assert.equal(app.httpServer.port,null);assert.equal(typeof app.services.get('memory.consolidate'),'function');
  const append=(uid,count=1,extra={})=>{for(let i=0;i<count;i++){const entry=app.store.appendIncoming('group:100',{senderId:uid,senderName:'成员'+uid,text:`归档${uid}-${i}`,ts:243+i,...extra});app.store.markEntryRead('group:100',entry.id);}};
  const run=async()=>{const accepted=await app.ingest.ingestMessage({kind:'group',id:'100',event:{user_id:'999',message_id:++mid,sender:{nickname:'触发成员'},raw_message:'@机器人 fixture243'}});assert.equal(accepted.accepted,true);const s=app.sessions.create('group:100',{waitUntil:Date.now()+1});await app.orchestrator.wake('group:100',{waitingSessionId:s.id,verified:true});assert.ok(['done','noreply'].includes(app.sessions.peek(s.id).status),app.sessions.peek(s.id).error);return s;};
  const request=(args={})=>requestMemoryConsolidation({memory:app.memory,chatKey:'group:100',...args});
  const done=async count=>{await until(()=>events.filter(e=>e.phase==='consolidate-done'||e.phase==='consolidate-error').length>count);return events.at(-1);};
  return{app,appRoot,dataDir,bridge,models,chatModels,events,append,run,request,done,setChatHook:fn=>{onChat=fn;}};
}

test('actual loader, selected community, shared automatic adapter and default SDK-backed model persist exempt discovery',async t=>{
  const f=await application(t);f.append('333',45);f.append('444',45);f.app.memory.append('group:100',{userId:'444',name:'成员444',content:'排除前已有的真实旧档'});
  const old=JSON.stringify(f.app.memory.query('group:100',{userId:'444'}));await f.run();assert.equal((await f.done(0)).phase,'consolidate-done');
  assert.deepEqual(f.models.map(x=>x.input.userId),['333']);assert.equal(f.models[0].input.messages.length,40);assert.equal(f.models[0].input.messages[0].text,'归档333-5');
  assert.equal(JSON.stringify(f.app.memory.query('group:100',{userId:'444'})),old);assert.ok(f.app.memory.query('group:100',{userId:'333'})[0].impressions.length);assert.equal(f.chatModels.length,1);assert.ok(f.bridge.sourceCalls>=4);
});

test('actual selected community Promise suspends automatic discovery; disabled settings after await prevent dispatch',async t=>{
  const f=await application(t);f.append('333',20);const hold=deferred();f.setChatHook(()=>{f.bridge.source=()=>hold.promise;});await f.run();await tick();assert.equal(f.models.length,0);
  f.app.config.update({memory:{consolidateEnabled:false}});hold.resolve({ok:true,ids:[]});await tick();await tick();assert.equal(f.models.length,0);assert.equal(f.events.filter(e=>e.phase==='consolidate-start').length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

test('actual public SDK direct consolidation keeps cfg fallback and returns proposals without archive writes',async t=>{
  const f=await application(t,{config:{globalBlocklist:['333','555'],communityExemptions:['333']}});f.append('333',2);f.append('555',2);
  const out=await f.bridge.sdk({chatKey:'group:100',members:[],create:true,userIds:['333','555']});
  assert.deepEqual(f.models.map(x=>x.input.userId),['333']);assert.deepEqual(out.members.map(m=>m.userId),['333']);assert.equal(f.app.memory.query('group:100').length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

for(const managed of [false,true])test(`actual ${managed?'managed':'unmanaged'} source permission revoke/allow invalidates the original in-flight receipt`,async t=>{
  const f=await application(t,{sourceManaged:managed});f.app.memory.append('group:100',{userId:'555',name:'成员555',content:'必须保留的原档'});const before=JSON.stringify(f.app.memory.query('group:100'));
  const hold=deferred();f.bridge.memory=async input=>{await hold.promise;return result(input);};assert.equal(f.request().status,202);await until(()=>f.models.length===1);
  assert.equal(f.app.permissions.setOverride('community243','net.outbound','deny'),true);assert.equal(f.app.permissions.setOverride('community243','net.outbound','allow'),true);await f.app.services.refresh();
  await f.done(0);hold.resolve();await tick();assert.equal(f.events.at(-1).phase,'consolidate-error');assert.equal(JSON.stringify(f.app.memory.query('group:100')),before);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

for(const mutation of ['disable','register-same','pin-ABA'])test(`actual selected source ${mutation} cannot commit a late default-model result`,async t=>{
  const f=await application(t);f.app.memory.append('group:100',{userId:'555',name:'成员555',content:'原档保留'});const before=JSON.stringify(f.app.memory.query('group:100'));
  const hold=deferred();f.bridge.memory=async input=>{await hold.promise;return result(input);};assert.equal(f.request().status,202);await until(()=>f.models.length===1);
  if(mutation==='disable')await f.app.loader.setEnabled('community243',false);
  else if(mutation==='register-same'){const selected=f.app.capability.providers('community.client')[0];f.app.capability.register('community.client',selected.ownerId,selected.provider);}
  else{f.app.capability.register('community.client','kernel',{getBlocklist:()=>({ok:true,ids:[]})});f.app.config.update({extensions:{providers:{'community.client':'kernel'}}});f.app.config.update({extensions:{providers:{'community.client':'community243'}}});}
  await f.done(0);hold.resolve();await tick();assert.equal(f.events.at(-1).phase,'consolidate-error');assert.equal(JSON.stringify(f.app.memory.query('group:100')),before);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});


for(const mode of ['replace','wrap','disabled'])test(`appended whole orchestrator ${mode} preserves selected policy and actual automatic writes`,async t=>{
  const f=await application(t,{layer:{mode:mode==='disabled'?'replace':mode,enabled:mode!=='disabled'}});f.append('333',20);f.append('444',20);await f.run();assert.equal((await f.done(0)).phase,'consolidate-done');
  assert.deepEqual(f.models.map(x=>x.input.userId),['333']);assert.equal(f.bridge.layer,mode==='disabled'?undefined:mode);assert.equal(f.app.composition.selection.components['core.orchestrator'].ownerId,mode==='disabled'?'defaults':'memory243');
});

test('actual selected object memory service gets filtered DTO and stopping it rejects a late proposal',async t=>{
  const f=await application(t);f.append('333');f.append('444');let calls=0,starts=0,stops=0,captured;const hold=deferred();
  const provider={start(){starts++;},stop(){stops++;},async consolidate(args){calls++;captured=args;await hold.promise;return{members:[{userId:'333',name:'成员333',impressions:[{content:'替换服务提案',createdAt:243}]}]};}};
  f.bridge.registerMemory(provider);await f.app.services.refresh();assert.equal(starts,1);assert.equal(f.app.services.get('memory.consolidate'),provider);
  assert.equal(f.request({create:true,userIds:['333','444']}).status,202);await until(()=>calls===1);assert.deepEqual(captured.history.map(entry=>entry.senderId),['333']);assert.deepEqual(captured.userIds,['333']);assert.equal(f.request().status,409);
  await f.app.loader.setEnabled('sdk243',false);await f.app.services.refresh();await f.done(0);hold.resolve();await tick();assert.equal(stops,1);assert.equal(f.events.at(-1).phase,'consolidate-error');assert.equal(f.app.memory.query('group:100').length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);assert.equal(typeof f.app.services.get('memory.consolidate'),'function');
});

for(const action of ['pause-resume','stop'])test(`automatic pending discovery ${action} cannot revive its held community read`,async t=>{
  const f=await application(t);f.append('333',20);const hold=deferred();f.setChatHook(()=>{f.bridge.source=()=>hold.promise;});await f.run();await tick();assert.equal(f.models.length,0);
  if(action==='pause-resume'){f.app.orchestrator.pause();f.app.orchestrator.resume({skipBacklog:true});}else f.app.orchestrator.stop();
  hold.resolve({ok:true,ids:[]});await tick();await tick();assert.equal(f.models.length,0);assert.equal(f.events.filter(e=>e.phase==='consolidate-start').length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

test('pause after automatic dispatch still aborts the shared adapter and preserves its original archive',async t=>{
  const f=await application(t);f.append('333',20);const hold=deferred();f.bridge.memory=async input=>{await hold.promise;return result(input);};await f.run();await until(()=>f.models.length===1);f.app.orchestrator.pause();f.app.orchestrator.resume({skipBacklog:true});
  await f.done(0);hold.resolve();await tick();assert.equal(f.events.at(-1).phase,'consolidate-error');assert.equal(f.app.memory.query('group:100').length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});


for(const mutation of ['revoke-allow','register-same','pin-ABA'])test(`actual selected object memory ${mutation} latches cancellation through the host receipt`,async t=>{
  const f=await application(t);f.app.memory.append('group:100',{userId:'555',name:'成员555',content:'旧模型不得覆盖'});const before=JSON.stringify(f.app.memory.query('group:100'));const hold=deferred();let calls=0;
  const provider={start(){},stop(){},async consolidate(args){calls++;await hold.promise;return{members:args.members.map(member=>({...member,impressions:member.impressions.slice(0,1)}))};}};
  f.bridge.registerMemory(provider);await f.app.services.refresh();assert.equal(f.request().status,202);await until(()=>calls===1);
  if(mutation==='revoke-allow'){assert.equal(f.app.permissions.setOverride('sdk243','net.outbound','deny'),true);assert.equal(f.app.permissions.setOverride('sdk243','net.outbound','allow'),true);}
  else if(mutation==='register-same')f.bridge.registerMemory(provider);
  else{f.app.capability.register('memory.consolidate','kernel',async args=>({members:args.members}));f.app.config.update({extensions:{providers:{'memory.consolidate':'kernel'}}});f.app.config.update({extensions:{providers:{'memory.consolidate':'sdk243'}}});}
  await f.app.services.refresh();await f.done(0);hold.resolve();await tick();assert.equal(f.events.at(-1).phase,'consolidate-error');assert.equal(JSON.stringify(f.app.memory.query('group:100')),before);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

for(const mutation of ['register-same','pin-ABA'])test(`actual held community read ${mutation} stops before any memory model request`,async t=>{
  const f=await application(t);f.app.memory.append('group:100',{userId:'555',name:'成员555',content:'名单尚未返回'});const hold=deferred();f.bridge.source=()=>hold.promise;
  assert.equal(f.request().status,202);await tick();assert.equal(f.models.length,0);
  if(mutation==='register-same'){const selected=f.app.capability.providers('community.client')[0];f.app.capability.register('community.client',selected.ownerId,selected.provider);}
  else{f.app.capability.register('community.client','kernel',{getBlocklist:()=>({ok:true,ids:[]})});f.app.config.update({extensions:{providers:{'community.client':'kernel'}}});f.app.config.update({extensions:{providers:{'community.client':'community243'}}});}
  await f.done(0);hold.resolve({ok:true,ids:[]});await tick();assert.equal(f.models.length,0);assert.equal(f.app.memory.lastConsolidatedAt('group:100'),0);
});

test('actual selected empty result is authoritative, then disabled source uses cfg minus exemptions for a new request',async t=>{
  const f=await application(t,{config:{globalBlocklist:['333','555'],communityExemptions:['333']}});f.append('333');f.append('555');f.bridge.ids=[];
  assert.equal(f.request({create:true,userIds:['555']}).status,202);assert.equal((await f.done(0)).phase,'consolidate-done');assert.equal(f.models[0].input.userId,'555');
  await f.app.loader.setEnabled('community243',false);await f.app.services.refresh();assert.equal(f.request({create:true,userIds:['333']}).status,202);assert.equal((await f.done(1)).phase,'consolidate-done');assert.equal(f.models[1].input.userId,'333');
  const count=f.models.length;assert.equal(f.request({userIds:['555']}).status,202);assert.equal((await f.done(2)).phase,'consolidate-error');assert.equal(f.models.length,count);
});

test('actual discovery retains the 2000-row bound and dedicated memory model selection',async t=>{
  const f=await application(t,{config:{providers:[{id:'dedicated243',baseURL:'https://memory243.invalid'}],memory:{useChatModel:false,provider:'dedicated243',model:'memory243'}}});f.append('333',20);f.append('777',2000,{isPoke:true});await f.run();await tick();await tick();assert.equal(f.models.length,0);
  f.append('333',20);await f.run();assert.equal((await f.done(0)).phase,'consolidate-done');assert.equal(f.models.length,1);assert.equal(f.models[0].input.userId,'333');assert.equal(f.models[0].input.messages.length,20);assert.equal(f.models[0].args.overrides.model,'memory243');assert.equal(f.models[0].args.overrides.provider,'dedicated243');
});


test('repeated successful conversations coalesce one held discovery per chat',async t=>{
  const f=await application(t);f.append('333',20);const hold=deferred();let heldSignal=null;
  f.setChatHook(()=>{if(f.bridge.source)return;f.bridge.source=options=>{if(!heldSignal){heldSignal=options.signal;return hold.promise;}return options.signal===heldSignal?hold.promise:{ok:true,ids:[]};};});
  await f.run();await until(()=>heldSignal!==null);await f.run();await tick();await tick();assert.equal(f.chatModels.length,2);assert.equal(f.models.length,0,'another completed chat must not overtake the pending discovery');
  hold.resolve({ok:true,ids:[]});assert.equal((await f.done(0)).phase,'consolidate-done');assert.equal(f.models.length,1);
});


test('a resumed discovery epoch survives the old ignored-signal read completing late',async t=>{
  const f=await application(t);f.append('333',20);const knownSignals=new Set(),held=[];
  f.bridge.onLease=(name,lease)=>{if(name==='community.client')knownSignals.add(lease.signal);};
  f.bridge.source=({signal})=>{if(!knownSignals.has(signal))return{ok:true,ids:[]};let item=held.find(entry=>entry.signal===signal);if(!item){item={signal,...deferred()};held.push(item);}return item.promise;};
  await f.run();await until(()=>held.length===1);assert.ok(getEventListeners(held[0].signal,'abort').length>0);
  f.app.orchestrator.pause();f.app.orchestrator.resume({skipBacklog:true});await f.run();await until(()=>held.length===2);assert.equal(getEventListeners(held[0].signal,'abort').length,0,'stopped discovery removes its abort listener even while the source promise is pending');
  held[0].resolve({ok:true,ids:[]});await tick();await f.run();await tick();assert.equal(held.length,2,'late old completion cannot clear the new pending discovery');assert.equal(f.models.length,0);
  f.bridge.source=()=>({ok:true,ids:[]});held[1].resolve({ok:true,ids:[]});assert.equal((await f.done(0)).phase,'consolidate-done');assert.equal(f.models.length,1);assert.equal(getEventListeners(held[1].signal,'abort').length,0);
});

test('the default consolidator stop rejects an ignored-signal model and releases its listeners before late completion',async t=>{
  const hold=deferred();let signal;const e=pure(t,{ids:[],model:async(_input,args)=>{signal=args.signal;return hold.promise;}});e.old('555');
  const pending=e.run({chatKey:'group:100'});await until(()=>e.models.length===1);assert.ok(getEventListeners(signal,'abort').length>0);e.run.stop();await assert.rejects(pending,/中止/);assert.equal(getEventListeners(signal,'abort').length,0);hold.resolve(result(e.models[0]));await tick();assert.equal(e.memory.lastConsolidatedAt('group:100'),0);
});
