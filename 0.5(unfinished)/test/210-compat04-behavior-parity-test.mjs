import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultComponents as defaults } from '../bundled/runtime-defaults/components.js';

const retainedOutput = process.argv[2] ? path.resolve(process.argv[2]) : null;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
function environment(t) {
  if (retainedOutput) fs.mkdirSync(retainedOutput, { recursive: true });
  const root = fs.mkdtempSync(path.join(retainedOutput ?? os.tmpdir(), 'qqa-compat210-'));
  const appRoot = path.join(root, 'app'), dataDir = path.join(root, 'data'), logs = [], runs = [];
  for (const kind of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(appRoot, kind), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push({ level, args })]));
  log.child = () => log;
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
  function plugin(id, source, manifest = {}) {
    const dir = path.join(appRoot, id === 'compat-04' ? 'bundled' : 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id, compat: '04', ...manifest }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return dir;
  }
  plugin('compat-04', `export { default } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../bundled/compat-04/index.js')).href)};`, { kind: 'plugin', compat: undefined });
  const configWriter = defaults['runtime.config']({ dataDir, defaults: defaults['runtime.config.defaults'](), log });
  configWriter.load(); configWriter.update({ api: { model: 'offline-fixture', maxRounds: 2 }, proactive: { enabled: false }, webSearch: { enabled: false }, skills: { echo: { settings: { tag: 'saved-and-reloaded' } } } });
  const config = defaults['runtime.config']({ dataDir, defaults: defaults['runtime.config.defaults'](), log }); config.load();
  const bus = defaults['runtime.bus']({ log });
  const permissions = defaults['runtime.permissions']({ dataDir, log, bus, headless: true });
  const capabilities = defaults['runtime.capability']({ log });
  const registry = defaults['runtime.tools']({ log, bus, permissions, capabilities });
  const scheduler = defaults['runtime.scheduler']({ log });
  const storage = defaults['runtime.storage']({ dataDir, log });
  let loader;
  const sdk = defaults['runtime.sdk']({ config, permissions, loaderOf: () => loader, bus, resolveProvider: name => capabilities.providers(name)[0]?.provider });
  loader = defaults['runtime.plugins']({ log, bus, appRoot, registry, capabilityRegistry: capabilities, permissions, scheduler, storage, config, sdkHost: sdk });
  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('210 offline fixture forbids network'); };
  t.after(() => {
    loader.stopAll(); scheduler.stop(); permissions.close(); globalThis.fetch = originalFetch;
    write('evidence.json', { entries: loader.listEntries(), runs, logs, networkAttempts });
    assert.equal(networkAttempts, 0);
    if (!retainedOutput) {
      const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
      assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('qqa-compat210-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  async function run(calls) {
    const bundle = defaults['core.tools.bundle']({ c: config.get() }, { registry, loader });
    const session = { id: `qa-${runs.length}`, chatKey: 'group:fixture', sent: [], usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    const requests = [], invocations = []; let llmCalls = 0;
    const result = await defaults['core.agentRunner']({
      session, systemPrompt: 'Offline compat04 parity', userPrompt: 'fixture trigger', tools: bundle.tools,
      execContext: { chatKey: session.chatKey, session, signal: new AbortController().signal, botName: 'QA' },
      cfg: config.get(), log, capabilities, hooksOf: name => loader.hooksOf(name),
      invokeTool: async (name, args, context) => { const returned = await bundle.invoke(name, args, context); invocations.push({ name, args, returned }); return returned; },
      callLLM: async args => {
        requests.push({ messages: structuredClone(args.messages), tools: structuredClone(args.tools) });
        const toolCalls = llmCalls++ === 0 ? calls.map(([name, input], i) => ({ id: `call-${i}`, type: 'function', function: { name, arguments: JSON.stringify(input) } })) : [];
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        return { message: { role: 'assistant', content: toolCalls.length ? '' : 'complete', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, usage, raw: { usage } };
      },
    });
    const item = { requests, invocations, result }; runs.push(item); return item;
  }
  const events = () => logs.flatMap(item => item.args).filter(item => typeof item === 'string' && item.includes('EV:')).map(item => JSON.parse(item.slice(item.indexOf('EV:') + 3)));
  return { root, plugin, config, loader, registry, capabilities, permissions, run, events, logs };
}
const tool = (run, name) => run.result.messages.find(message => message.toolCall?.name === name);
const payload = (run, name) => JSON.parse(tool(run, name).content);
const comboSource = `
let api; const generation = import.meta.url;
const event = (kind, context) => api.log('EV:' + JSON.stringify({kind,generation,reason:context?.reason,compatApi:typeof context?.config === 'function',rawSdk:typeof context?.config === 'object'}));
export function setup(value) {
 api=value; event('setup');
 api.registerTool({id:'ping',name:'Ping',parameters:{type:'object',properties:{}},execute(){return {content:'PONG'};}});
 if(api.config().failSetup){api.registerTool({id:'orphan',name:'Orphan',execute(){return 'bad';}});throw new Error('fixture setup failed');}
}
export const providers = {'qa.combo':({value})=>({value})};
export const hooks = {'before-llm-messages':({messages})=>messages.push({role:'user',content:'QA_COMBO_HOOK'})};
export function activate(context){event('activate',context);}
export function deactivate(context){event('deactivate',context);}
export function dispose(){event('dispose');}
`;
const consumerSource = `export function setup(ctx){ctx.registerTool({id:'read',name:'Read',params:{type:'object',properties:{value:{type:'string'}},required:['value']},execute(args){return {ok:true,result:{present:ctx.hasCapability('qa.combo'),value:ctx.capability('qa.combo',args)??null}};}});}`;

test('210 legacy parameters, argument order, payload, errors and explicit modern params reach the real runner', async t => {
  const e = environment(t);
  e.plugin('echo', `export function setup(api){
    api.registerTool({id:'echo',name:'Echo',parameters:{type:'object',properties:{input:{type:'string'}},required:['input']},execute(ctx,args){return {content:{input:args.input,chatKey:ctx.chatKey,tag:api.config().tag,narrow:!ctx.kernel&&!ctx.registry}};}});
    api.registerTool({id:'modern',name:'Modern',params:{type:'object',properties:{input:{type:'string'}},required:['input']},execute(args,ctx){return {ok:true,result:{input:args.input,chatKey:ctx.chatKey}};}});
    api.registerTool({id:'raw',name:'Raw',execute(){return {answer:42};}});
    api.registerTool({id:'empty',name:'Empty',execute(){return {content:undefined};}});
    api.registerTool({id:'fail',name:'Fail',execute(){return {content:'fixture denied',isError:true,detail:'kept'};}});
    api.registerTool({id:'throw',name:'Throw',execute(){throw new Error('fixture thrown');}});
  }`);
  e.plugin('native', `export function setup(ctx){ctx.registerTool({id:'echo',name:'Native echo',params:{type:'object',properties:{input:{type:'string'}},required:['input']},execute(args,context){return {ok:true,result:{input:args.input,chatKey:context.chatKey}};}});}`, { compat: undefined });
  await e.loader.loadAll(); assert.equal(e.loader.isActive('echo'), true); assert.equal(e.permissions.pending().length, 0);
  const r = await e.run([['echo__echo',{input:'HELLO'}],['echo__modern',{input:'HELLO'}],['native__echo',{input:'HELLO'}],['echo__raw',{}],['echo__empty',{}],['echo__fail',{}],['echo__throw',{}]]);
  const schema = r.requests[0].tools.find(item => item.function.name === 'echo__echo').function.parameters;
  assert.deepEqual(schema.required, ['input']); assert.deepEqual(schema.properties, {input:{type:'string'}});
  assert.deepEqual(payload(r,'echo__echo'), {input:'HELLO',chatKey:'group:fixture',tag:'saved-and-reloaded',narrow:true});
  for (const name of ['echo__modern','native__echo']) assert.deepEqual(payload(r,name),{input:'HELLO',chatKey:'group:fixture'});
  assert.deepEqual(payload(r,'echo__raw'),{answer:42});
  assert.equal(tool(r,'echo__empty').content,'');
  assert.equal(tool(r,'echo__fail').toolCall.ok,false); assert.match(tool(r,'echo__fail').content,/fixture denied/);
  assert.equal(r.invocations.find(item=>item.name==='echo__fail').returned.result.detail,'kept');
  assert.equal(tool(r,'echo__throw').toolCall.ok,false); assert.match(tool(r,'echo__throw').content,/fixture thrown/);
  const missing = await e.run([['echo__echo',{}]]); assert.equal(tool(missing,'echo__echo').toolCall.ok,false); assert.match(tool(missing,'echo__echo').content,/input/);
});

test('210 old and modern success/failure keep media in actual user parts and errors in tool text', async t => {
  const e=environment(t);
  e.plugin('media', `const image={type:'image_url',image_url:{url:${JSON.stringify(png)}}};const video={type:'video_url',video_url:{url:'data:video/mp4;base64,AAAA'}};
  export function setup(api){
    api.registerTool({id:'old_ok',name:'Old media',execute(){return {content:[{type:'text',text:'OLD_OK'},{type:'text',text:'SECOND'},image]};}});
    api.registerTool({id:'old_fail',name:'Old failure media',execute(){return {content:[{type:'text',text:'OLD_FAIL'},image,video],isError:true};}});
    api.registerTool({id:'new_ok',name:'New media',params:{type:'object'},execute(){return {ok:true,result:'NEW_OK',mediaParts:[image]};}});
    api.registerTool({id:'new_fail',name:'New failure media',params:{type:'object'},execute(){return {ok:false,error:'NEW_FAIL',mediaParts:[image]};}});
  }`);
  await e.loader.loadAll(); const r=await e.run(['old_ok','old_fail','new_ok','new_fail'].map(id=>['media__'+id,{}]));
  assert.equal(r.requests.length,2);
  const userParts=r.requests[1].messages.filter(message=>message.role==='user'&&Array.isArray(message.content)).flatMap(message=>message.content);
  assert.equal(userParts.filter(part=>part.type==='image_url'&&part.image_url.url===png).length,4);
  assert.equal(userParts.filter(part=>part.type==='video_url'&&part.video_url.url==='data:video/mp4;base64,AAAA').length,1);
  assert.equal(tool(r,'media__old_ok').content,'OLD_OK\nSECOND');
  for(const id of ['old_ok','old_fail','new_ok','new_fail']){
    const entry=tool(r,'media__'+id); assert.equal(entry.toolCall.ok,!id.endsWith('fail')); assert.match(entry.content,new RegExp(id.toUpperCase())); assert.doesNotMatch(entry.content,/base64|image_url|video_url/);
  }
});

test('210 setup combines declarations; disable/re-enable cleans one generation and keeps namespaces', async t => {
  const e=environment(t); e.plugin('combo',comboSource,{capabilities:['qa.combo']}); e.plugin('consumer',consumerSource,{compat:undefined});
  e.plugin('other',`export function setup(api){api.registerTool({id:'ping',name:'Other ping',execute(){return {content:'OTHER'};}});}`);
  await e.loader.loadAll(); const retained=e.registry.get('combo__ping');
  const first=await e.run([['combo__ping',{}],['other__ping',{}],['consumer__read',{value:'HELLO'}]]);
  assert.equal(tool(first,'combo__ping').content,'PONG'); assert.equal(tool(first,'other__ping').content,'OTHER');
  assert.deepEqual(payload(first,'consumer__read'),{present:true,value:{value:'HELLO'}});
  assert.equal(first.requests[0].messages.filter(message=>message.content==='QA_COMBO_HOOK').length,1);
  assert.deepEqual(e.events().map(item=>item.kind),['setup','activate']); assert.equal(e.events()[1].compatApi,true); assert.equal(e.events()[1].rawSdk,false);
  await e.loader.setEnabled('combo',false); assert.equal(e.capabilities.has('qa.combo'),false); assert.equal(e.loader.hooksOf('before-llm-messages').length,0); assert.equal(e.registry.get('combo__ping'),undefined);
  await assert.rejects(()=>retained.execute({},{}),/失效/);
  assert.deepEqual(e.events().map(item=>item.kind),['setup','activate','deactivate','dispose']); assert.equal(e.events()[2].reason,'disabled');
  await e.loader.setEnabled('combo',true); const second=await e.run([['consumer__read',{value:'AGAIN'}]]);
  assert.deepEqual(payload(second,'consumer__read'),{present:true,value:{value:'AGAIN'}}); assert.equal(e.loader.hooksOf('before-llm-messages').length,1);
  e.loader.stopAll(); e.loader.stopAll(); assert.equal(e.events().filter(item=>item.kind==='deactivate').length,2); assert.equal(e.events().filter(item=>item.kind==='dispose').length,2);
});

test('210 successful reload deactivates old, activates new once and disposes old without deleting new registrations', async t => {
  const e=environment(t), dir=e.plugin('combo',comboSource,{capabilities:['qa.combo']}); await e.loader.loadAll();
  const retained=e.registry.get('combo__ping'); await e.loader.loadDir('skills',dir);
  assert.deepEqual(e.events().map(item=>item.kind),['setup','activate','deactivate','setup','activate','dispose']);
  assert.equal(e.events()[2].reason,'reload'); assert.equal(e.events()[4].compatApi,true);
  assert.equal(e.capabilities.providers('qa.combo').length,1); assert.equal(e.loader.hooksOf('before-llm-messages').length,1);
  await assert.rejects(()=>retained.execute({},{}),/失效/);
  assert.equal(tool(await e.run([['combo__ping',{}]]),'combo__ping').content,'PONG');
});

test('210 setup failure rolls back partial registration and reactivates the retained legacy instance with compat API', async t => {
  const e=environment(t), dir=e.plugin('combo',comboSource,{capabilities:['qa.combo']}); e.plugin('consumer',consumerSource,{compat:undefined}); await e.loader.loadAll();
  const old=e.loader.hostEntry('combo'); e.config.update({skills:{combo:{settings:{failSetup:true}}}}); await e.loader.loadDir('skills',dir);
  assert.equal(e.loader.hostEntry('combo'),old); assert.match(old.loadError,/fixture setup failed/); assert.equal(e.registry.get('combo__orphan'),undefined);
  assert.deepEqual(e.events().map(item=>item.kind),['setup','activate','deactivate','setup','deactivate','dispose','activate']);
  const resumed=e.events().at(-1); assert.equal(resumed.generation,e.events()[0].generation); assert.equal(resumed.reason,'reload-failed'); assert.equal(resumed.compatApi,true); assert.equal(resumed.rawSdk,false);
  assert.equal(e.events()[4].reason,'setup-failed');
  e.config.update({skills:{combo:{settings:{failSetup:false}}}});
  const r=await e.run([['combo__ping',{}],['consumer__read',{value:'RESTORED'}]]);
  assert.equal(tool(r,'combo__ping').content,'PONG'); assert.deepEqual(payload(r,'consumer__read'),{present:true,value:{value:'RESTORED'}});
  assert.equal(r.requests[0].messages.filter(message=>message.content==='QA_COMBO_HOOK').length,1);
});

test('210 initial setup failure cleans partial tools and lifecycle once', async t => {
  const e=environment(t); e.plugin('combo',comboSource,{capabilities:['qa.combo']}); e.config.update({skills:{combo:{settings:{failSetup:true}}}}); await e.loader.loadAll();
  assert.equal(e.loader.isActive('combo'),false); assert.equal(e.registry.byOwner('combo').length,0); assert.equal(e.capabilities.has('qa.combo'),false); assert.equal(e.loader.hooksOf('before-llm-messages').length,0);
  assert.deepEqual(e.events().map(item=>item.kind),['setup','deactivate','dispose']); e.loader.stopAll(); assert.deepEqual(e.events().map(item=>item.kind),['setup','deactivate','dispose']);
});

test('210 register entry combines declarations and declarations-only legacy keeps its activation path', async t => {
  const e=environment(t);
  e.plugin('registered',`export function register(api){api.registerTool({id:'ping',name:'Register ping',execute(){return {content:'REGISTERED'};}});}export const providers={'qa.registered':()=>42};export const hooks={'before-llm-messages':({messages})=>messages.push({role:'user',content:'REGISTERED_HOOK'})};`);
  e.plugin('declared',`let api;export const providers={'qa.declared':()=>84};export const hooks={'before-llm-messages':({messages})=>messages.push({role:'user',content:'DECLARED_HOOK'})};export function activate(ctx){api=ctx;api.log('DECLARED_ACTIVATE');}export function deactivate(){api.log('DECLARED_DEACTIVATE');}export function dispose(){api.log('DECLARED_DISPOSE');}`);
  await e.loader.loadAll(); const r=await e.run([['registered__ping',{}]]);
  assert.equal(tool(r,'registered__ping').content,'REGISTERED'); assert.equal(e.capabilities.consume('qa.registered'),42); assert.equal(e.capabilities.consume('qa.declared'),84);
  for(const marker of ['REGISTERED_HOOK','DECLARED_HOOK']) assert.equal(r.requests[0].messages.filter(message=>message.content===marker).length,1);
  const count=marker=>e.logs.flatMap(item=>item.args).filter(item=>String(item).includes(marker)).length;
  assert.equal(count('DECLARED_ACTIVATE'),1); e.loader.stopAll(); e.loader.stopAll(); assert.equal(count('DECLARED_DEACTIVATE'),1); assert.equal(count('DECLARED_DISPOSE'),1);
});

test('210 stop during asynchronous legacy setup cleans once and rejects late registration', async t => {
  const e=environment(t); let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}), gate=new Promise(resolve=>{release=resolve;});
  e.capabilities.register('qa.wait','kernel',()=>{enter();return gate;});
  e.plugin('late',`let api;const event=kind=>api.log('EV:'+JSON.stringify({kind}));export async function setup(value){api=value;event('setup');await api.capability('qa.wait');api.registerTool({id:'late',name:'Late',execute(){return 'late';}});}export function deactivate(){event('deactivate');}export function dispose(){event('dispose');}`);
  const loading=e.loader.loadAll(); await entered; e.loader.stopAll(); release(); await loading;
  assert.equal(e.loader.isActive('late'),false); assert.equal(e.registry.byOwner('late').length,0); assert.deepEqual(e.events().map(item=>item.kind),['setup','deactivate','dispose']);
});

test('210 adapted context retains scoped SDK and denies undeclared HTTP/storage operations', async t => {
  const e=environment(t); e.plugin('narrow',`export function setup(api){api.registerTool({id:'check',name:'Check',execute:async(ctx)=>{
    let networkDenied=false,storeDenied=false;
    try{await api.fetch('https://not-requested.invalid/');}catch{networkDenied=true;}
    try{await ctx.store.recent('group:fixture',1);}catch{storeDenied=true;}
    return {content:{networkDenied,storeDenied,kernel:!!ctx.kernel,registry:!!ctx.registry,rawFetch:!!ctx.fetch}};
  }});}`); await e.loader.loadAll();
  const r=await e.run([['narrow__check',{}]]); assert.deepEqual(payload(r,'narrow__check'),{networkDenied:true,storeDenied:true,kernel:false,registry:false,rawFetch:false}); assert.equal(e.permissions.pending().length,0);
});

test('210 unmarked apiVersion:1 detects old calls, preserves mixed native tools and reads live settings without source changes', async t => {
  const e=environment(t);
  const dir=e.plugin('unmarked',`let api;
    export function setup(value){api=value;
      api.registerTool({id:'old',name:'Old unmarked',parameters:{type:'object',properties:{input:{type:'string'}},required:['input']},execute(ctx,args){api.log('AUTO_OLD_LOG');return {content:{input:args.input,chatKey:ctx.chatKey,tag:api.config().tag}};}});
      api.registerTool({id:'modern',name:'Modern mixed',params:{type:'object',properties:{input:{type:'string'}}},execute(args,ctx){return {ok:true,result:{input:args.input,chatKey:ctx.chatKey}};}});
      api.registerTool({id:'schema_less',name:'Native schema-less mixed',handler(args,ctx){return {ok:true,result:{input:args.input,chatKey:ctx.chatKey}};}});
      api.registerTool({id:'old_error',name:'Old error',parameters:{type:'object'},execute(){return {content:'OLD_BUSINESS_ERROR',isError:true};}});
    }
    export function promptSections(){return [{id:'age',content:api.config().tag}];}
  `,{compat:undefined,apiVersion:1,configSchema:{tag:{type:'string'}},settings:{tag:'default'}});
  const before=fs.readFileSync(path.join(dir,'skill.json'),'utf8'),code=fs.readFileSync(path.join(dir,'index.js'),'utf8');
  e.plugin('native',`export function setup(ctx){ctx.log.info('NATIVE_LOG');ctx.registerTool({id:'read',name:'Native config',params:{type:'object',properties:{input:{type:'string'}}},execute(args,execution){return {ok:true,result:{input:args.input,chatKey:execution.chatKey,tag:ctx.config.get('tag'),all:ctx.config.all(),onChange:typeof ctx.config.onChange,narrow:!ctx.kernel&&!ctx.registry,storage:typeof ctx.storage.get}};}});}`,{compat:undefined,configSchema:{tag:{type:'string'}},settings:{tag:'native'}});
  e.config.update({skills:{unmarked:{settings:{tag:'saved-37'}}}});
  await e.loader.loadAll();assert.equal(e.loader.isActive('unmarked'),true);assert.equal(e.loader.isActive('native'),true);
  assert.equal((await e.loader.promptSections({chatKey:'group:fixture'})).find(s=>s.owner==='unmarked').content,'saved-37');
  const r=await e.run([['unmarked__old',{input:'HELLO'}],['unmarked__modern',{input:'MODERN'}],['unmarked__schema_less',{input:'RAW'}],['native__read',{input:'NATIVE'}],['unmarked__old_error',{}]]);
  const schema=r.requests[0].tools.find(x=>x.function.name==='unmarked__old').function.parameters;assert.deepEqual(schema.required,['input']);
  assert.deepEqual(payload(r,'unmarked__old'),{input:'HELLO',chatKey:'group:fixture',tag:'saved-37'});
  assert.deepEqual(payload(r,'unmarked__modern'),{input:'MODERN',chatKey:'group:fixture'});
  assert.deepEqual(payload(r,'unmarked__schema_less'),{input:'RAW',chatKey:'group:fixture'});
  assert.deepEqual(payload(r,'native__read'),{input:'NATIVE',chatKey:'group:fixture',tag:'native',all:{tag:'native'},onChange:'function',narrow:true,storage:'function'});
  assert.equal(tool(r,'unmarked__old_error').toolCall.ok,false);assert.match(tool(r,'unmarked__old_error').content,/OLD_BUSINESS_ERROR/);
  const details=e.loader.listEntries().find(x=>x.id==='unmarked').compatibility;assert.equal(details.mode,'04');assert.equal(details.automatic,true);assert.ok(details.features.includes('tool.parameters'));assert.ok(details.features.includes('config()'));assert.ok(details.features.includes('log()'));
  assert.equal(e.loader.listEntries().find(x=>x.id==='native').compatibility.mode,'native');
  e.config.update({skills:{unmarked:{settings:{tag:'changed-38'}}}});
  assert.equal((await e.loader.promptSections({})).find(s=>s.owner==='unmarked').content,'changed-38');
  const retained=e.registry.get('unmarked__old');await e.loader.setEnabled('unmarked',false);assert.equal(e.registry.byOwner('unmarked').length,0);await assert.rejects(()=>retained.execute({},{}),/失效/);
  await e.loader.setEnabled('unmarked',true);await e.loader.loadDir('skills',dir,{hot:true});assert.equal(e.registry.byOwner('unmarked').length,4);
  assert.equal(payload(await e.run([['unmarked__old',{input:'RELOADED'}]]),'unmarked__old').tag,'changed-38');
  assert.equal(fs.readFileSync(path.join(dir,'skill.json'),'utf8'),before);assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),code);
  const denied=await e.loader.hostEntry('unmarked').ctx.fetch('https://never-requested.invalid/').then(()=>false,()=>true);assert.equal(denied,true);
});

test('210 automatic compatibility never retries a failed setup', async t => {
  const e=environment(t);let calls=0;e.capabilities.register('qa.setup-count','kernel',()=>++calls);
  e.plugin('broken',`export function setup(api){api.capability('qa.setup-count');api.log('OLD_BEFORE_FAILURE');api.registerTool({id:'partial',name:'Partial',parameters:{type:'object'},execute(){return {content:'no'};}});throw new Error('REAL_SETUP_FAILURE');}`,{compat:undefined});
  await e.loader.loadAll();assert.equal(calls,1);assert.equal(e.loader.isActive('broken'),false);assert.equal(e.registry.byOwner('broken').length,0);assert.match(e.loader.hostEntry('broken').loadError,/REAL_SETUP_FAILURE/);
});
