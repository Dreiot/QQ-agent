// 52 真实 RpcBridge/PanelRegistry 行为，不用 source.includes 假通过。
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { RpcBridge } from '../ui/shell/rpc-bridge.js';
import { PanelRegistry } from '../ui/shell/panel-registry.js';
const oldWindow = globalThis.window, oldDocument = globalThis.document;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
if (!globalThis.crypto) globalThis.crypto = webcrypto;
function frameFixture() {
  const sent = [], listeners = new Map();
  const frame = { contentWindow: { postMessage: (message) => sent.push(message) }, addEventListener: (name, fn) => listeners.set(name, fn), remove() { this.removed = true; }, setAttribute() {} };
  return { frame, sent, listeners };
}
try {
  const { frame, sent } = frameFixture(); const calls = [], configs = [];
  const manifest = { id: 'demo_panel', ownerId: 'demo', kind: 'user', generation: 'f'.repeat(8)+'-ffff-ffff-ffff-'+ 'f'.repeat(12), permissions: ['ui.panel'], api: [] };
  const bridge = new RpcBridge({ frame, manifest,
    onUserCall: async (...args) => { calls.push(args); return { ok: true, result: 'called' }; },
    onUserConfig: async (...args) => { configs.push(args); return { mode: 'safe' }; },
    api: { request() { throw new Error('user iframe must not proxy arbitrary API'); } },
  });
  const event = (method, params = {}, meta = {}) => ({ source: frame.contentWindow, origin: 'null', data: { jsonrpc: '2.0', id: '1', method, params, meta: { nonce: bridge.nonce, panel: manifest.id, ...meta } } });
  await bridge.handle(event('ctx.call', { tool: 'demo__echo', args: { text: 'x' }, ownerId: 'evil', generation: 'fake' }));
  assert.deepEqual(calls[0], ['demo__echo', { text: 'x' }, manifest.id, manifest.generation]);
  await bridge.handle(event('ctx.getConfig', { key: 'mode' }));
  assert.deepEqual(configs[0], ['mode', manifest.id, manifest.generation]);
  assert.deepEqual(sent.at(-1).result, { mode: 'safe' });
  await bridge.handle(event('api.request', { method: 'POST', path: '/api/reset-data' }));
  assert.ok(sent.at(-1).error); assert.equal(calls.length, 1);
  await bridge.handle(event('ctx.call', {}, { nonce: 'wrong' })); assert.equal(calls.length, 1);
  const spoof = event('ctx.call'); spoof.source = {}; await bridge.handle(spoof); assert.equal(calls.length, 1);
  const badOrigin = event('ctx.call'); badOrigin.origin = 'http://evil.test'; await bridge.handle(badOrigin); assert.equal(calls.length, 1);
  bridge.ready = true; const before = sent.length;
  bridge.event('log', { apiKey: 'secret', text: 'global log' });
  bridge.event('chat-update', { chatKey: 'group:123' });
  bridge.event('plugin-loaded', { id: 'other', password: 'secret' });
  assert.equal(sent.length, before);
  bridge.event('plugin-loaded', { id: 'demo', password: 'secret' });
  assert.deepEqual(sent.at(-1).params, { name: 'plugin-loaded', payload: { id: 'demo' } });
  bridge.close(); await bridge.handle(event('ctx.call')); assert.equal(calls.length, 1);

  const frames = [];
  globalThis.document = { createElement() { const f = frameFixture().frame; frames.push(f); return f; } };
  const registry = new PanelRegistry({ frameHost: { replaceChildren() {} }, api: {} });
  registry.register({ ...manifest, title: 'Demo', entry: 'index.html' });
  await registry.mount(manifest.id);
  assert.equal(frames[0].src, `/panels/u/demo_panel/${manifest.generation}/index.html`);
  assert.equal(frames[0].sandbox, 'allow-scripts');
  const loadingFrame=registry.current.frame;
  await registry.mount(manifest.id);
  assert.notEqual(registry.current.frame,loadingFrame,'an unready or failed panel can be retried');
  const readyFrame=registry.current.frame;
  registry.current.bridge.ready=true;
  assert.equal(await registry.mount(manifest.id),readyFrame,'reselecting the same ready definition keeps its live iframe');
  await registry.replace([{...manifest,title:'Demo',entry:'index.html'}]);
  assert.equal(await registry.mount(manifest.id),readyFrame,'an unchanged authoritative manifest preserves the current definition and frame');
  const nextDefinition={...manifest,title:'Demo',entry:'index.html',generation:'0'.repeat(8)+'-0000-0000-0000-'+ '0'.repeat(12)};
  const leavingBridge=registry.current.bridge;
  let authoritative=true;
  const obsoleteReplace=registry.replace([nextDefinition],{isCurrent:()=>authoritative});
  authoritative=false;
  await leavingBridge.handle({source:readyFrame.contentWindow,origin:'null',data:{jsonrpc:'2.0',method:'panel.flushed',params:{flushId:leavingBridge.flushId,ok:true},meta:{nonce:leavingBridge.nonce,panel:manifest.id}}});
  await obsoleteReplace;
  assert.equal(registry.current, null); assert.equal(readyFrame.removed, true,'a changed plugin generation must unload even the previously ready frame');
  assert.equal(registry.list()[0].generation,manifest.generation,'an obsolete manifest cannot commit after asynchronous panel leave');
  await registry.replace([nextDefinition]);
  assert.equal(registry.list()[0].generation,nextDefinition.generation,'the following authoritative manifest commits its fresh generation');
  await registry.mount(manifest.id); await registry.replace([]); assert.equal(registry.current, null);
  const dotted={...manifest,id:'weather_panel',ownerId:'weather.v1',title:'Weather',entry:'index.html'};
  registry.register(dotted);assert.equal(registry.list()[0].ownerId,'weather.v1');
  await registry.replace([{...dotted,id:'bad id'},dotted]);assert.equal(registry.list().length,1);assert.equal(registry.list()[0].id,'weather_panel');
  registry.dispose();

  // Exercise the host shortcut through both the initial ready handshake and
  // reuse of an already mounted editor. Plugins never receive this intent.
  const navigationMessages=new WeakMap();globalThis.document.createElement=()=>{const fixture=frameFixture();navigationMessages.set(fixture.frame,fixture.sent);return fixture.frame;};
  async function navigationCase(definition,options,expected,label){
    const nav=new PanelRegistry({frameHost:{replaceChildren(){}},api:{}});nav.register(definition);
    try{
      const navFrame=await nav.mount(definition.id,options),navBridge=nav.current.bridge,messages=navigationMessages.get(navFrame),settingsEvents=()=>messages.filter(message=>message.method==='shell.event'&&message.params?.name==='settings-section').map(message=>message.params.payload);
      assert.deepEqual(settingsEvents(),[],label+' waits for the iframe handshake');
      await navBridge.handle({source:navFrame.contentWindow,origin:'null',data:{jsonrpc:'2.0',method:'panel.ready',meta:{nonce:navBridge.nonce,panel:definition.id}}});
      assert.deepEqual(settingsEvents(),expected?[expected]:[],label+' initial navigation payload');
      assert.equal(await nav.mount(definition.id,options),navFrame,label+' preserves the ready editor');
      assert.deepEqual(settingsEvents(),expected?[expected,expected]:[],label+' active editor navigation payload');
      assert.equal(navFrame.src.endsWith('#'+options.section),!!expected,label+' navigation fragment follows the same allowed section');
    }finally{nav.dispose();}
  }
  const settings={id:'settings',kind:'bundled',title:'设置',permissions:[],api:[]};
  for(const connectQQ of [true,'123456','12345678901234567890'])await navigationCase(settings,{section:'onebot',connectQQ},{section:'onebot',connectQQ},'valid connection intent '+String(connectQQ));
  for(const connectQQ of [false,null,'','1234','123456789012345678901',123456,{accountId:'123456'},'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','http://127.0.0.1:5099/'])await navigationCase(settings,{section:'onebot',connectQQ},{section:'onebot'},'invalid connection intent '+JSON.stringify(connectQQ));
  for(const section of ['models','access'])await navigationCase(settings,{section,connectQQ:'123456'},{section},'other settings section '+section);
  await navigationCase(settings,{section:'not-declared',connectQQ:true},null,'unknown settings section');
  await navigationCase({...settings,id:'replacement_settings',navigation:{role:'configuration'}},{section:'onebot',connectQQ:'123456'},{section:'onebot',connectQQ:'123456'},'bundled configuration replacement');
  await navigationCase({...settings,id:'logs'},{section:'onebot',connectQQ:true},null,'unrelated bundled panel');
  await navigationCase({...manifest,id:'settings',title:'Plugin settings',entry:'index.html',navigation:{role:'configuration'}},{section:'onebot',connectQQ:true},null,'user panel with a settings-looking identity');
  console.log('✓ 52-panel-rpc-host：身份/代际/工具/配置/token隔离/SSE隔离/启停重载/连接意图导航边界全部通过');
} finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
