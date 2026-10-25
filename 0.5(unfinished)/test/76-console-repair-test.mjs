// 真实 HTTP/loader 安装 + 跨日快照 + 实际 RPC/FormState/面板事件模块。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHttpServer } from '../src/kernel/http.js';
import { createConfig, buildDefaultConfig } from '../src/kernel/config.js';
import { createPluginLoader } from '../src/kernel/plugin-loader.js';
import { createToolRegistry, buildToolAvailabilityContext } from '../src/kernel/tools.js';
import { createCapabilityRegistry } from '../src/kernel/capability.js';
import { createPermissions } from '../src/kernel/permissions.js';
import { createScheduler } from '../src/kernel/scheduler.js';
import { createStorage } from '../src/kernel/storage.js';
import { registerConsoleRoutes } from '../src/console/routes.js';
import { COMMUNITY_BASE_URL, createCommunityMarketAdapters } from '../src/console/community-market-adapters.js';
import { FormState } from '../ui/panels/settings/form-state.js';
import { RpcBridge } from '../ui/shell/rpc-bridge.js';

function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  const locals = [], centers = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); centers.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const center = Buffer.concat(centers), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, center, end]);
}
function packageZip(id, kind = 'plugin', extra = {}) {
  return zip({ [`pkg/${kind}.json`]: JSON.stringify({ id, kind, entry: 'index.js', enabledByDefault: true, ...extra }), 'pkg/index.js': 'globalThis.__consoleRepairImport=(globalThis.__consoleRepairImport||0)+1;export default {setup(){globalThis.__consoleRepairSetup=(globalThis.__consoleRepairSetup||0)+1;}};' });
}
function dayKey(offset) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-console-repair-'));
for (const kind of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(root, kind));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
const dataDir = path.join(root, 'fixture-data'), log = { info() {}, warn() {}, error() {}, child() { return this; }, recent: () => [] };
const config = createConfig({ dataDir, defaults: buildDefaultConfig(), log }); config.load(); config.update({ server: { port: 0, token: 'repair-fixture-token' } });
const permissions = createPermissions({ dataDir, log, headless: true });
const capability = createCapabilityRegistry({ log }), registry = createToolRegistry({ log, permissions, capabilities: capability });
const scheduler = createScheduler({ log }), storage = createStorage({ dataDir, log });
const loader = createPluginLoader({ appRoot: root, config, log, permissions, registry, capabilityRegistry: capability, scheduler, storage });
let payload = packageZip('market.safe'), serverKind = 'plugin';
const fetchImpl = async (url) => {
  if (url === `${COMMUNITY_BASE_URL}/plugins`) return new Response(JSON.stringify({ok:true,items:[{id:'marketplace-display-name',type:'plugin',status:'approved',installCode:'SAFE12'}]}));
  if (url === `${COMMUNITY_BASE_URL}/install/verify`) return new Response(JSON.stringify({ ok: true, results: [{ code: 'SAFE12', ok: true, id: 'marketplace-display-name', type: serverKind }] }));
  if (url === `${COMMUNITY_BASE_URL}/install/SAFE12/download`) return new Response(payload);
  throw new Error(`Unexpected fixture request: ${url}`);
};
const http = createHttpServer({ config, log, staticDir: root });
let installZip;
const dnsLookup = async () => [{ address: '203.0.113.8', family: 4 }];
const marketClient = createCommunityMarketAdapters({ dataDir, appRoot: root, config, fetchImpl, dnsLookup, installZip: (...args) => installZip(...args) });
registerConsoleRoutes(http, { config, loader, permissions, registry, capability, log, dataDir, appRoot: root, sessions: { listSummaries: () => [] }, store: {}, fetchImpl, dnsLookup, marketClient, bindInstallZip: (fn) => { installZip = fn; } });
const port = await http.listen();
async function req(method, url, body) { const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'x-console-token': 'repair-fixture-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const install = () => req('POST', '/api/market/install', { id:'marketplace-display-name', kind:'plugin' });
try {
  console.log('· 市场与本地 ZIP 共用清单身份、停用和冲突检查');
  delete globalThis.__consoleRepairImport; delete globalThis.__consoleRepairSetup;
  let result = await install();
  assert.equal(result.status, 200); assert.equal(result.data.id, 'market.safe'); assert.equal(result.data.kind, 'plugin'); assert.equal(result.data.enabled, false);
  assert.equal(config.get().skills['market.safe'].enabled, false);
  assert.equal(loader.listEntries().find(x => x.id === 'market.safe').status, 'disabled');
  assert.equal(globalThis.__consoleRepairImport, undefined); assert.equal(globalThis.__consoleRepairSetup, undefined);
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'marketplace-display-name')), false);
  result = await install(); assert.equal(result.status, 409); assert.equal(fs.existsSync(path.join(root, 'plugins', 'market.safe_1')), false);
  result = await req('POST', '/api/skills/install', { zipBase64: payload.toString('base64') }); assert.equal(result.status, 409);
  payload = packageZip('local.safe'); result = await req('POST', '/api/skills/install', { zipBase64: payload.toString('base64') });
  assert.equal(result.status, 200); assert.equal(config.get().skills['local.safe'].enabled, false); assert.equal(globalThis.__consoleRepairImport, undefined);
  fs.mkdirSync(path.join(root, 'bundled', 'different-dir')); fs.writeFileSync(path.join(root, 'bundled', 'different-dir', 'plugin.json'), JSON.stringify({ id: 'protected.identity', kind: 'plugin' }));
  payload = packageZip('protected.identity'); assert.equal((await install()).status, 409);
  payload = packageZip('wrong.kind', 'skill'); assert.equal((await install()).status, 502);
  assert.equal(fs.existsSync(path.join(root, 'plugins', 'wrong.kind')), false);
  payload = packageZip('bad.entry', 'plugin', { entry: '../outside.js' }); assert.equal((await install()).status, 502);
  payload = zip({ 'pkg/plugin.json': '{"kind":"plugin"}', 'pkg/index.js': 'export default {}' }); assert.equal((await install()).status, 502);
  assert.deepEqual(fs.readdirSync(path.join(root, '.extension-management-v1', 'staging')), []);
  // 显式启用才运行顶层和 setup，安装期不会执行用户代码。
  result = await req('POST', '/api/skills/market.safe', { enabled: true }); assert.equal(result.status, 200);
  assert.equal(globalThis.__consoleRepairImport, 1); assert.equal(globalThis.__consoleRepairSetup, 1);
  payload = packageZip('market.safe'); result = await install(); assert.equal(result.status, 409);
  assert.equal(config.get().skills['market.safe'].enabled, true); assert.equal(globalThis.__consoleRepairSetup, 1);

  console.log('· 跨日工具计数求和，保留其它窗口聚合');
  fs.mkdirSync(path.join(dataDir, 'usage-days'), { recursive: true });
  for (const [offset, count] of [[-1, 2], [0, 3]]) {
    const day = dayKey(offset);
    fs.writeFileSync(path.join(dataDir, 'usage-days', `${day}.json`), JSON.stringify({ version: 1, day, aggregates: { totals: { totalTokens: count, runs: count }, hours: [], chats: [], models: [], searchCount: count, toolCounts: { send_message: count, search_web: count * 2 } } }));
  }
  result = await req('GET', '/api/usage/stats?range=7'); assert.equal(result.status, 200);
  assert.deepEqual(result.data.toolCounts, { send_message: 5, search_web: 10 }); assert.equal(result.data.searchCount, 5); assert.equal(result.data.totals.totalTokens, 5);
  assert.deepEqual((await req('GET', '/api/usage/stats?range=today')).data.toolCounts, { send_message: 3, search_web: 6 });

  console.log('· 带点映射键保持平铺，保存确认不会抹掉后续修改');
  const form = new FormState({ tools: { overrides: { send_message: true } } });
  form.setKey('tools.overrides', 'weather.v1__echo', false); const snapshot = form.snapshot();
  assert.deepEqual(snapshot.patch.tools.overrides, { send_message: true, 'weather.v1__echo': false });
  assert.equal(buildToolAvailabilityContext(snapshot.patch).override('weather.v1__echo'), false);
  form.setKey('tools.overrides', 'weather.v1__echo', true); form.setKey('tools.overrides', 'a.b__other', false); form.accept(snapshot, snapshot.patch);
  assert.deepEqual(form.snapshot().patch.tools.overrides, { send_message: true, 'weather.v1__echo': true, 'a.b__other': false });
  assert.throws(() => form.setKey('tools.overrides', '__proto__', false));
} finally {
  await http.close(); await loader.stopAll(); permissions.close();
  delete globalThis.__consoleRepairImport; delete globalThis.__consoleRepairSetup;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('qqa-console-repair-'));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('· 用户面板拒绝宿主主题，bundled 面板可实时预览');
const previousWindow = globalThis.window, previousDocument = globalThis.document;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
try {
  for (const kind of ['user', 'bundled']) {
    const sent = []; let applied = 0;
    const frame = { contentWindow: { postMessage: message => sent.push(message) }, addEventListener() {} };
    const bridge = new RpcBridge({ frame, manifest: { id: 'theme_fixture', kind }, onTheme: () => { applied++; } });
    const event = { source: frame.contentWindow, origin: 'null', data: { jsonrpc: '2.0', id: 'theme-1', method: 'theme.apply', params: { theme: { accent: '#123456' } }, meta: { panel: 'theme_fixture', nonce: bridge.nonce } } };
    await bridge.handle(event);
    assert.equal(applied, kind === 'bundled' ? 1 : 0);
    if (kind === 'user') assert.equal(sent.at(-1).error.code, -32003); else assert.deepEqual(sent.at(-1).result, { ok: true });
    bridge.close();
  }
} finally { globalThis.window = previousWindow; }

// 面板SSE阅读位置/迟到响应/草稿选择/整理卡片回归已迁入80真实Chromium，不再维护假DOM。
console.log("✓ 76-console-repair：HTTP安装/跨日计数/FormState/RPC全部行为检查通过；UI事件由80验证");
