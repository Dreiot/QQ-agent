// Real loader + all existing bundled tool entry points, with narrow public
// service fixtures and controlled HTTP. No QQ connection or external network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginLoader } from '../src/kernel/plugin-loader.js';
import { createCapabilityRegistry } from '../src/kernel/capability.js';
import { createToolRegistry } from '../src/kernel/tools.js';
import { createPermissions } from '../src/kernel/permissions.js';
import { createChatStore } from '../src/kernel/store.js';
import { createMemoryStore } from '../src/kernel/memory.js';
import { createReminderStore } from '../src/kernel/reminders.js';
import { createScheduler } from '../src/kernel/scheduler.js';
import { createStorage } from '../src/kernel/storage.js';
import { Bus } from '../src/kernel/bus.js';
import { createServiceHost } from '../src/kernel/service-host.js';

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-bundled-public-sdk-'));
const dataDir = path.join(appRoot, 'data');
fs.mkdirSync(dataDir);
const ids = ['core-tools', 'query-tools', 'memory-tools', 'sticker-tools', 'media-tools', 'system-tools', 'web-tools', 'voice-to-text', 'mcp-bridge', 'compat-04'];
const contextKey = `__bundledSdkContexts_${process.pid}`;
globalThis[contextKey] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
for (const dir of ['bundled', 'plugins', 'skills', 'src/kernel']) fs.mkdirSync(path.join(appRoot, dir), { recursive: true });
fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
fs.copyFileSync(new URL('../src/kernel/holidays.js', import.meta.url), path.join(appRoot, 'src/kernel/holidays.js'));
for (const id of ids) {
  const sourceDir = new URL(`../bundled/${id}/`, import.meta.url);
  const dir = path.join(appRoot, 'bundled', id);
  fs.cpSync(sourceDir, dir, { recursive: true });
  const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  assert.doesNotMatch(source, /ctx\??\.kernel/, `${id} does not access a privileged context`);
  fs.renameSync(path.join(dir, 'index.js'), path.join(dir, 'actual.js'));
  // Exercise the real entry point through a proxy that fails immediately if it
  // reaches for a privileged object, including through optional chaining.
  fs.writeFileSync(path.join(dir, 'index.js'), `import impl from './actual.js';
export default { ...impl, setup(ctx) {
  globalThis[${JSON.stringify(contextKey)}].push(ctx);
  const publicCtx = new Proxy(ctx, { get(target, key, receiver) {
    if (['kernel', 'registry', 'loader', 'bus'].includes(key)) throw new Error('private host access: ' + key);
    return Reflect.get(target, key, receiver);
  } });
  return impl.setup(publicCtx);
} };`);
}
const legacyDir = path.join(appRoot, 'skills', 'legacy-fixture');
fs.mkdirSync(legacyDir);
fs.writeFileSync(path.join(legacyDir, 'skill.json'), JSON.stringify({ id: 'legacy-fixture', compat: '04', permissions: ['net.outbound'] }));
fs.writeFileSync(path.join(legacyDir, 'index.js'), `export default { setup(api) {
  globalThis[${JSON.stringify(contextKey)} + '_legacy'] = api;
  api.registerTool({ id: 'fetch', name: 'Legacy Fetch', execute: async () => ({ ok: true, result: await (await api.fetch('https://legacy.fixture/')).text() }) });
} };`);

let cfg = {
  api: { apiKey: 'UNRELATED_API_SECRET' },
  allow: { groups: ['85', '86'], private: [] }, deny: { groups: [], private: [] },
  security: { imageSend: { requirePreview: true, maxPerRun: 3 } },
  webSearch: { provider: 'bing', searchUrl: 'https://search.fixture/search' },
  skills: {
    'voice-to-text': { enabled: true, settings: { enabled: true, baseUrl: 'https://asr.fixture/v1', apiKey: 'voice-secret', model: 'fixture-model' } },
    'mcp-bridge': { settings: { servers: [{ id: 'sdk', command: 'fixture' }] } },
  },
};
const config = { get: () => cfg, update: (patch) => { cfg = { ...cfg, ...patch }; } };
const bus = new Bus(log);
const caps = createCapabilityRegistry({ log });
const permissions = createPermissions({ log, bus, headless: true });
const services = createServiceHost({ capability: caps, config, bus, log, authorize: (_name, candidate) =>
  (caps.options(_name, candidate.ownerId).scopes ?? []).every((scope) => { const verdict = permissions.check(candidate.ownerId, scope, { kind: 'bundled' }); return verdict.decision === 'allow' && verdict.isValid?.() !== false; }) });
const registry = createToolRegistry({ log, permissions });
const scheduler = createScheduler({ log });
const store = createChatStore({ dataDir, log });
const memory = createMemoryStore({ dataDir, log });
const reminders = createReminderStore({ dataDir, log });
const chatKey = 'group:85';
store.appendIncoming(chatKey, { mid: 850, ts: Date.now(), senderId: '7', senderName: 'Fixture', text: 'hello', media: [{ kind: 'image', url: 'https://image.fixture/a.png' }, { kind: 'video', url: 'https://image.fixture/a.mp4' }] });
store.appendIncoming(chatKey, { mid: 851, ts: Date.now(), senderId: '7', text: '[转发]', media: [{ kind: 'forward', id: 'f' }] });
const expose = (target, methods) => Object.freeze(Object.fromEntries(methods.map((method) => [method, target[method].bind(target)])));
caps.register('host.config', 'kernel', {});
caps.register('data.messages', 'kernel', expose(store, ['recent', 'findByMid', 'updateByMid', 'listChats']));
caps.register('data.memory', 'kernel', expose(memory, ['append', 'query', 'remove']));
caps.register('data.reminders', 'kernel', expose(reminders, ['add', 'pending', 'cancel']));
const sent = [], feedback = [], httpCalls = [];
const sendResult = (type, key, payload, options) => { sent.push({ type, key, payload, options }); return { ok: true, sent: [{ text: type, msgId: sent.length }] }; };
caps.register('core.send', 'kernel', Object.freeze({
  sendTextBatch: async (key, texts, opts) => sendResult('text', key, texts, opts),
  poke: async (key, opts) => sendResult('poke', key, null, opts),
  sendImage: async (key, image, opts) => sendResult('image', key, image, opts),
  sendSticker: async (key, image, opts) => sendResult('sticker', key, image, opts),
}));
caps.register('host.feedback', 'kernel', { report: (payload) => feedback.push(payload) });
caps.register('transport.actions', 'kernel', { getForward: async () => ({ messages: [{ sender: { nickname: 'Forwarder' }, message: [{ type: 'text', data: { text: 'forward text' } }] }] }) });
const sticker = { id: 's1', emojiId: 'e1', url: 'https://image.fixture/sticker.png', desc: 'fixture sticker' };
let used = 0;
caps.register('data.stickers', 'kernel', Object.freeze({
  imagesDir: path.join(dataDir, 'stickers'), all: () => [{ ...sticker }], get: () => ({ ...sticker }),
  ensureSendable: async () => ({ url: sticker.url }),
  collectIntoQQ: async ({ desc }) => ({ ok: true, noted: true, entry: { ...sticker, desc } }), markUsed: () => { used++; },
}));
const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
caps.register('media.reader', 'kernel', Object.freeze({
  image: async () => ({ dataUrl: imagePart.image_url.url, mime: 'image/png', bytes: 100 }),
  imageParts: async () => ({ parts: [imagePart] }), probe: async (_media, opts) => ({ duration: 12, frames: opts.count, parts: [imagePart] }),
}));
let childStarts = 0, childStops = 0, stopAllCalls = 0;
let delayNextMcpListing = false, releaseMcpListing, listingEntered;
caps.register('process.mcp', 'kernel', Object.freeze({
  startServer: () => {
    childStarts++; let stopped = false; const delayed = delayNextMcpListing; delayNextMcpListing = false;
    return { notify() {}, stop() { if (!stopped) { stopped = true; childStops++; } }, request: async (method, args) => {
      if (method === 'tools/list') {
        if (delayed) { listingEntered(); return new Promise((resolve) => { releaseMcpListing = resolve; }); }
        return { tools: [{ name: 'echo', scopes: ['mcp.connect'] }] };
      }
      return method === 'tools/call' ? { echo: args.arguments } : {};
    } };
  },
  stopAll: () => { stopAllCalls++; }, redactError: () => 'adapter_error',
}));
let loader;
caps.register('extensions.state', 'kernel', { isActive: (id) => loader.isActive(id), videoFrames: () => ({ enabled: cfg.skills?.['video-frames']?.enabled !== false, frames: cfg.skills?.['video-frames']?.settings?.frames ?? 6 }) });
const legacyFetches = [];
caps.register('compat04.http', 'kernel', { fetchFor: async (url, options, detail) => { legacyFetches.push({ url, options, detail }); return new Response('legacy-response'); } });
loader = createPluginLoader({ appRoot, log, bus, registry, capabilityRegistry: caps, permissions, scheduler,
  storage: createStorage({ dataDir, log }), config,
  sdkHost: {
    capabilityAccess: (name, provider, { manifest }) => name === 'host.config'
      ? { get: () => structuredClone(Object.fromEntries((manifest.hostConfig ?? []).map((key) => [key, cfg[key]]))) }
      : provider,
    fetch: async (url, options) => {
      httpCalls.push({ url, options });
      if (url.includes('asr.fixture')) {
        assert.equal(options.headers.authorization, 'Bearer voice-secret');
        assert.equal(options.body.get('model'), 'fixture-model');
        assert.ok(options.body.get('file') instanceof Blob);
        return new Response('{"text":"public SDK transcription"}', { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('voice.fixture')) return new Response(Buffer.alloc(64), { headers: { 'content-type': 'audio/silk' } });
      if (url.includes('bocha.fixture')) {
        assert.equal(options.headers.authorization, 'Bearer domain-search-secret');
        return new Response(JSON.stringify({ data: { webPages: { value: [{ name: 'Domain search', url: 'https://result.fixture/' }] } } }));
      }
      if (url.includes('/images/search')) return new Response('"murl":"https://image.fixture/result.png"');
      if (url.includes('search.fixture')) return new Response('<li class="b_algo"><h2><a href="https://result.fixture/">Result</a></h2><p>Snippet</p></li>');
      return new Response('<h1>Page</h1><p>Public HTTP</p>');
    },
  },
});
caps._setActiveProbe(loader.isActive);
async function invoke(id, args = {}, session = {}) {
  const response = await registry.invoke(id, args, { execCtx: { chatKey, senderId: '7', session } });
  assert.equal(response.ok, true, `${id}: ${response.error}`);
  assert.equal(response.result.ok, true, `${id}: ${response.result.error}`);
  return response.result;
}

try {
  console.log('· Real loader: all 10 existing bundled entries use the public SDK');
  await loader.loadAll();
  assert.ok(caps.snapshotOwner('mcp-bridge').some((item) => item.name === 'process.mcp' && item.options.default === true), 'MCP default process implementation is registered by its plugin');
  assert.equal(registry.list().filter((tool) => tool.source?.startsWith('mcp:')).length, 0, 'MCP setup only registers, even with configured servers');
  assert.equal(caps.options('mcp.service', 'mcp-bridge').lifecycle, true);
  await services.start();
  for (const id of ids) assert.equal(loader.isActive(id), true, `${id}: ${loader.listEntries().find((entry) => entry.id === id)?.loadError}`);
  for (const ctx of globalThis[contextKey]) {
    for (const name of ['kernel', 'registry', 'loader', 'bus']) assert.equal(Object.hasOwn(ctx, name), false, `${ctx.id} exposes no ${name}`);
    const own = ctx.capability('host.config').get();
    assert.equal(own.api, undefined, 'unrelated host credentials stay outside the binding');
  }
  assert.equal(registry.list().length, 29, '27 standard tools plus one MCP tool and one legacy tool');
  await invoke('send_message', { messages: ['one', 'two'] });
  await invoke('send_to', { targetChatKey: 'group:86', messages: 'cross chat' });
  await invoke('send_poke', { targetUserId: '7' });
  await invoke('report_feedback', { message: 'fixture feedback' });
  assert.equal(feedback[0].message, 'fixture feedback');
  const finishSession = {};
  await invoke('finish', { reason: 'done', activeTopic: 'topic' }, finishSession);
  assert.equal(finishSession.finishReason, 'done');
  assert.equal((await invoke('get_recent_messages')).result.messages.length, 2);
  assert.equal((await invoke('get_active_members')).result.members[0].userId, '7');
  assert.equal((await invoke('get_chats')).result.chats[0].chatKey, chatKey);
  assert.equal((await invoke('get_message_detail', { messageId: 850 })).result.mid, 850);
  assert.match((await invoke('read_forward', { messageId: 851 })).result.text, /forward text/);
  assert.equal((await invoke('get_message_images', { messageId: 850 })).mediaParts.length, 1);
  assert.equal((await invoke('read_video', { messageId: 850, frames: 2 })).result.frames, 2);
  await invoke('memory_append', { category: 'memberImpression', userId: '7', content: 'fixture impression' });
  assert.equal((await invoke('memory_query', { userId: '7' })).result.count, 1);
  await invoke('memory_remove', { userId: '7', content: 'fixture impression' });
  assert.equal((await invoke('list_stickers')).result.items.length, 1);
  await invoke('get_sticker_image', { stickerId: 's1' });
  await invoke('collect_sticker', { messageId: 850, note: 'collected' });
  await invoke('send_sticker', { stickerId: 's1' });
  assert.equal(used, 1);
  const previewSession = {};
  await invoke('send_image', { url: 'https://image.fixture/send.png', preview: true }, previewSession);
  await invoke('send_image', { url: 'https://image.fixture/send.png' }, previewSession);
  const reminder = await invoke('set_reminder', { text: 'reminder', delayMinutes: 1 });
  assert.equal((await invoke('list_reminders')).result.reminders.length, 1);
  await invoke('cancel_reminder', { id: reminder.result.id });
  await invoke('check_holiday');
  await invoke('web_search', { query: 'public SDK' });
  assert.match((await invoke('web_fetch', { url: 'https://page.fixture/' })).result.content, /Public HTTP/);
  const imageRequestStart = httpCalls.length;
  assert.equal((await invoke('search_images', { query: 'image' })).result.results[0].url, 'https://image.fixture/result.png');
  assert.deepEqual(httpCalls.slice(imageRequestStart).map(call => { const url = new URL(call.url); return url.hostname + url.pathname; }), ['image.baidu.com/search/index', 'search.fixture/images/search'], 'an empty Baidu response falls back to the configured Bing endpoint through the same controlled HTTP entry');
  assert.equal(await caps.consume('media.transcribe', { file: 'https://voice.fixture/voice.silk' }), 'public SDK transcription');
  assert.equal(httpCalls.length, 6, 'search/page/two image sources/audio/ASR all use the controlled HTTP entry');
  const mcpTool = registry.list().find((tool) => tool.source === 'mcp:sdk');
  const mcpResponse = await registry.invoke(mcpTool.id, { message: 'echo' });
  assert.equal(mcpResponse.ok, true);
  assert.equal(mcpResponse.result.echo.message, 'echo');
  console.log('· MCP permission revoke stops one generation; regrant starts a fresh bridge');
  const stableMcpApi = caps.consume('mcp.tools');
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'deny');
  await new Promise((resolve) => setImmediate(resolve)); await services.idle();
  assert.equal(registry.get(mcpTool.id), undefined); assert.equal(childStops, 1); assert.deepEqual(stableMcpApi.list(), []);
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'allow'); await services.idle();
  assert.equal(childStarts, 2); assert.equal(childStops, 1); assert.equal(caps.consume('mcp.tools'), stableMcpApi, 'the published API is stable across service generations');
  assert.deepEqual(stableMcpApi.list(), ['sdk']);
  const recoveredMcp = await registry.invoke(mcpTool.id, { message: 'recovered' });
  assert.equal(recoveredMcp.ok, true); assert.equal(recoveredMcp.result.echo.message, 'recovered');
  await assert.rejects(mcpTool.execute({ message: 'obsolete' }), /MCP server 不可用/, 'an old tool closure cannot call the recovered bridge');
  console.log('· A revoked pending MCP discovery cannot remove a successor\'s tools');
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'deny'); await new Promise((resolve) => setImmediate(resolve)); await services.idle();
  delayNextMcpListing = true; const listingWaiting = new Promise((resolve) => { listingEntered = resolve; });
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'allow'); await listingWaiting;
  assert.equal(childStarts, 3);
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'deny'); await new Promise((resolve) => setImmediate(resolve)); await services.idle();
  assert.equal(childStops, 3); assert.equal(registry.get(mcpTool.id), undefined);
  permissions.setOverride('mcp-bridge', 'mcp.connect', 'allow'); await services.idle();
  const successorTool = registry.get(mcpTool.id); assert.ok(successorTool); assert.equal(childStarts, 4);
  releaseMcpListing({ tools: [{ name: 'echo', scopes: ['mcp.connect'] }] }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(mcpTool.id), successorTool); assert.deepEqual(stableMcpApi.list(), ['sdk']); assert.equal(childStops, 3);
  const legacyApi = globalThis[contextKey + '_legacy'];
  assert.equal(legacyApi.isSkillActive('web-tools'), true);
  permissions.setOverride('legacy-fixture', 'net.outbound', 'allow');
  assert.equal((await invoke('legacy-fixture__fetch')).result, 'legacy-response');
  assert.equal(legacyFetches[0].detail.pluginId, 'legacy-fixture');
  assert.equal(legacyFetches[0].detail.authorized, true);

  console.log('· Replacement capabilities are consumed at execution time and defaults yield');
  caps.register('media.reader', 'kernel', { imageParts: async () => ({ parts: [{ type: 'image_url', image_url: { url: 'replacement-image' } }] }) });
  assert.equal((await invoke('get_message_images', { messageId: 850 })).mediaParts[0].image_url.url, 'replacement-image');
  caps.register('web.search', 'query-tools', { search: async () => ({ query: 'replacement', results: [] }) });
  assert.equal((await invoke('web_search', { query: 'replacement' })).result.query, 'replacement');
  caps.unregister('web.search', 'query-tools');
  assert.equal((await invoke('web_search', { query: 'default restored' })).result.results[0].title, 'Result');
  cfg.webSearch = { provider: 'bocha', bocha: { baseUrl: 'https://bocha.fixture', apiKey: 'domain-search-secret' } };
  assert.equal((await invoke('web_search', { query: 'domain credential' })).result.results[0].title, 'Domain search');

  console.log('· Lifecycle stop withdraws MCP tools/children and web/voice providers');
  await loader.setEnabled('mcp-bridge', false);
  assert.equal(caps.snapshotOwner('mcp-bridge').some((item) => item.name === 'process.mcp'), false, 'disabling MCP withdraws its default process implementation');
  assert.equal(registry.get(mcpTool.id), undefined);
  assert.equal(childStops, 4);
  assert.ok(stopAllCalls >= 1);
  assert.equal(caps.has('mcp.tools'), false);
  await loader.setEnabled('web-tools', false);
  assert.equal(caps.has('web.search'), false);
  assert.equal(registry.get('web_search'), undefined);
  await loader.setEnabled('voice-to-text', false);
  assert.equal(caps.has('media.transcribe'), false);
  assert.ok(sent.some((item) => item.type === 'image') && sent.some((item) => item.type === 'sticker'));
  console.log('✓ 85 bundled public SDK: all entry points, behavior, replacement, lifecycle pass');
} finally {
  await services.stop();
  await loader.stopAll(); scheduler.stop(); permissions.close();
  delete globalThis[contextKey];
  delete globalThis[contextKey + '_legacy'];
  const relative = path.relative(os.tmpdir(), appRoot);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(appRoot).startsWith('qqa-bundled-public-sdk-'));
  fs.rmSync(appRoot, { recursive: true, force: true });
}

console.log('· Service host ignores routine permission audits and reconciles actual decisions');
{
  const events = new Bus(log), abilities = createCapabilityRegistry({ log });
  const authorization = createPermissions({ log, bus: events });
  let checks = 0;
  abilities.register('fixture.service', 'kernel', { create: async () => ({ start() {}, stop() {} }) }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, bus: events, log, authorize: () => {
    if (++checks > 10) throw new Error('permission audit refresh loop');
    return authorization.check('mcp-bridge', 'proc.exec', { kind: 'bundled' }).decision === 'allow';
  } });
  await host.start(); await new Promise((resolve) => setImmediate(resolve)); await host.idle();
  assert.equal(checks, 1, 'an ordinary check audit does not schedule another authorization');
  authorization.setOverride('mcp-bridge', 'proc.exec', 'allow');
  await host.idle(); assert.equal(checks, 2, 'an administrator decision refreshes once');
  const requested = authorization.checkAsync('sdk-ask-fixture', 'net.outbound');
  await host.idle(); assert.equal(checks, 2, 'a pending request is not a resolved authorization change');
  const pending = authorization.pending()[0]; authorization.resolveAsk(pending.id, 'once');
  assert.equal((await requested).decision, 'allow'); await host.idle();
  assert.equal(checks, 3, 'a resolved request refreshes once');
  await host.stop(); authorization.close();
}
console.log('· A late factory disposes its own resources without clearing published state');
{
  const abilities = createCapabilityRegistry({ log }), states = [];
  let release, entered, oldStops = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  abilities.register('fixture.service', 'kernel', { create: () => { entered(); return new Promise((resolve) => { release = resolve; }); } }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, log, onState: (name, value) => states.push({ name, value }) });
  const firstStart = host.start(); await waiting; host.invalidate();
  await firstStart;
  const replacement = { start() {}, stop() {} };
  abilities.register('fixture.service', 'kernel', { create: async () => replacement }, { lifecycle: true });
  await host.start();
  release({ stop() { oldStops++; } }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldStops, 1, 'the obsolete factory result is stopped');
  assert.deepEqual(states.map((state) => state.value), [replacement], 'an unpublished old entry cannot publish null');
  assert.equal(host.get('fixture.service'), replacement);
  await host.stop();
  assert.deepEqual(states.map((state) => state.value), [replacement, null], 'the actual owner clears state when stopped');
}
console.log('· Pending authorization is cancelled by stop or a new registration generation');
for (const change of ['stop', 'registration']) {
  const abilities = createCapabilityRegistry({ log });
  let entered, release, checks = 0, created = 0, stopped = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const provider = { create: () => { created++; return { stop() { stopped++; } }; } };
  abilities.register('fixture.service', 'fixture-owner', provider, { lifecycle: true });
  const initialVersion = abilities.version('fixture.service', 'fixture-owner');
  const host = createServiceHost({ capability: abilities, config: {}, log, authorize: () => {
    if (++checks === 1) { entered(); return new Promise((resolve) => { release = resolve; }); }
    return true;
  } });
  const starting = host.start(); await waiting;
  if (change === 'stop') await host.stop();
  else {
    abilities.register('fixture.service', 'fixture-owner', provider, { lifecycle: true });
    assert.notEqual(abilities.version('fixture.service', 'fixture-owner'), initialVersion);
  }
  let timer;
  try { await Promise.race([starting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${change} did not cancel authorization`)), 1000); })]); }
  finally { clearTimeout(timer); }
  await host.idle();
  assert.equal(created, change === 'stop' ? 0 : 1, 'only the current authorized generation may create a provider');
  release(true); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, change === 'stop' ? 0 : 1, 'a late authorization grant cannot start its obsolete generation');
  await host.stop(); assert.equal(stopped, change === 'stop' ? 0 : 1);
}
console.log('· Same-object registrations restart ownership and service events remain scoped');
{
  const abilities = createCapabilityRegistry({ log }), events = new Bus(log), contexts = [];
  let created = 0, stopped = 0, statuses = 0, privileged = 0;
  const provider = { create(context) { contexts.push(context); return { id: ++created, stop() { stopped++; } }; } };
  abilities.register('fixture.service', 'fixture-owner', provider, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, bus: events, log });
  events.on('transport.status', () => { statuses++; }); events.on('session.update', () => { privileged++; });
  await host.start(); contexts[0].emit('transport.status', { connected: true }); contexts[0].emit('session.update', { status: 'done' });
  const originalToken = host.token('fixture.service'); assert.ok(originalToken);
  assert.equal(statuses, 1); assert.equal(privileged, 0, 'a factory cannot emit arbitrary host control events');
  abilities.register('fixture.service', 'fixture-owner', provider, { lifecycle: true }); await host.idle();
  assert.equal(created, 2); assert.equal(stopped, 1); assert.equal(host.get('fixture.service').id, 2);
  assert.notEqual(host.token('fixture.service'), originalToken, 'completion identity changes with the registration generation');
  contexts[0].emit('transport.status', {}); contexts[1].emit('transport.status', {});
  assert.equal(statuses, 2, 'only the current registration can emit its permitted status event');
  await host.stop(); assert.equal(stopped, 2); assert.equal(host.token('fixture.service'), null);
  abilities.register('fixture.callback', 'kernel', provider);
  const callbackToken = host.token('fixture.callback'); abilities.register('fixture.callback', 'kernel', provider);
  assert.notEqual(host.token('fixture.callback'), callbackToken, 'an unmanaged callback also has a registration identity');
}
console.log('· Provider and authorization withdrawal cancel an unresolved start immediately');
for (const change of ['provider', 'permission']) {
  const abilities = createCapabilityRegistry({ log }), events = new Bus(log), states = [];
  let entered, release, signal, stopped = 0, starts = 0, authorized = true, context;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const provider = { create: (value) => { context = value; return {
    start: ({ signal: value }) => { signal = value; starts++; entered(); return new Promise((resolve) => { release = resolve; }); },
    stop: () => { stopped++; },
  }; } };
  abilities.register('fixture.service', 'fixture-owner', provider, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, bus: events, log, authorize: async () => authorized, onState: (_name, value) => states.push(value) });
  const starting = host.start(); await waiting;
  if (change === 'provider') abilities.unregisterOwner('fixture-owner');
  else { authorized = false; events.emit('permission.decision', { pluginId: 'fixture-owner', decision: 'deny', detail: '管理员显式决定' }); }
  let timer;
  try { await Promise.race([starting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${change} withdrawal did not cancel start`)), 1000); })]); }
  finally { clearTimeout(timer); }
  await new Promise((resolve) => setImmediate(resolve)); await host.idle();
  assert.equal(signal.aborted, true); assert.equal(stopped, 1); assert.equal(host.get('fixture.service'), undefined);
  let lateEvents = 0; events.on('transport.status', () => { lateEvents++; });
  release(); context.emit('transport.status', {}); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateEvents, 0); assert.equal(starts, 1); assert.equal(states.at(-1), null);
  await host.stop(); assert.equal(stopped, 1, 'revoked start is disposed only once');
}
console.log('· Invalidation handles stop rejections, and stop reports all cleanup failures');
{
  const abilities = createCapabilityRegistry({ log }), unhandled = [];
  const onUnhandled = (error) => unhandled.push(error); process.on('unhandledRejection', onUnhandled);
  for (const name of ['first', 'second']) abilities.register(name, 'kernel', { create: async () => ({ stop: async () => { throw new Error(`stop ${name}`); } }) }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, log });
  try {
    await host.start(); host.invalidate(); await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(host.stop(), (error) => error instanceof AggregateError && error.errors.length === 2 && /stop first/.test(error.message) && /stop second/.test(error.message));
    assert.deepEqual(unhandled, []); await host.stop();
  } finally { process.off('unhandledRejection', onUnhandled); }
}
console.log('· A per-service connection switch closes transport without stopping other services');
{
  const abilities = createCapabilityRegistry({ log }), events = new Bus(log), contexts = [], listeners = new Set();
  let transportStarts = 0, transportStops = 0, otherStops = 0, releaseStop, statuses = 0;
  const config = { onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  abilities.register('transport.provider', 'kernel', { create(context) { contexts.push(context); return {
    start() { transportStarts++; }, stop() { transportStops++; return new Promise(resolve => { releaseStop = resolve; }); },
  }; } }, { lifecycle: true });
  abilities.register('fixture.unrelated', 'kernel', { create: () => ({ start() {}, stop() { otherStops++; } }) }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config, bus: events, log }); events.on('transport.status', () => { statuses++; });
  await host.start(); const original = host.token('transport.provider'), other = host.token('fixture.unrelated'); assert.ok(original); assert.ok(other);
  const stopping = host.setEnabled('transport.provider', false);
  assert.equal(host.get('transport.provider'), undefined); assert.equal(host.token('transport.provider'), null, 'disable fences access synchronously');
  contexts[0].emit('transport.status', { connected: true }); assert.equal(statuses, 0, 'old transport cannot publish while close is pending');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(transportStops, 1); assert.equal(otherStops, 0); assert.equal(host.token('fixture.unrelated'), other);
  releaseStop(); await stopping; for (const listener of listeners) listener(); await host.idle(); assert.equal(transportStarts, 1, 'configuration refresh cannot reconnect a disabled transport');
  await host.setEnabled('transport.provider', true); assert.equal(transportStarts, 2); assert.notEqual(host.token('transport.provider'), original); assert.equal(host.token('fixture.unrelated'), other);
  const finalStop = host.stop(); await new Promise(resolve => setImmediate(resolve)); releaseStop(); await finalStop; assert.equal(otherStops, 1); assert.equal(transportStops, 2);
}
console.log('· A disabled connection stays closed at boot and cancels an unresolved transport start');
{
  const abilities = createCapabilityRegistry({ log }); let starts = 0, stops = 0, entered, release, oldContext;
  abilities.register('transport.provider', 'kernel', { create(context) { oldContext = context; return {
    start() { starts++; entered?.(); return new Promise(resolve => { release = resolve; }); }, stop() { stops++; },
  }; } }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, log });
  await host.setEnabled('transport.provider', false); await host.start(); assert.equal(starts, 0); assert.equal(host.get('transport.provider'), undefined);
  const waiting = new Promise(resolve => { entered = resolve; }); const enabling = host.setEnabled('transport.provider', true); await waiting;
  await host.setEnabled('transport.provider', false); await enabling; assert.equal(stops, 1); assert.equal(oldContext.signal.aborted, true); assert.equal(host.get('transport.provider'), undefined);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1); assert.equal(stops, 1); await host.stop();
}
console.log('· Per-service switch reports a real close failure while retaining its access fence');
{
  const abilities = createCapabilityRegistry({ log });
  abilities.register('transport.provider', 'kernel', { create: () => ({ start() {}, stop() { throw new Error('fixture close failure'); } }) }, { lifecycle: true });
  const host = createServiceHost({ capability: abilities, config: {}, log }); await host.start();
  await assert.rejects(host.setEnabled('transport.provider', false), /未能完全停止/); assert.equal(host.get('transport.provider'), undefined); assert.equal(host.token('transport.provider'), null);
  await assert.rejects(host.stop(), /fixture close failure/);
}
console.log('✓ 85 service host lifecycle and permission refresh boundaries pass');
