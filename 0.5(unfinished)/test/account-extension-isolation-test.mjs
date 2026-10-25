// Real loader, immutable module snapshots and authenticated HTTP ZIP lifecycle.
// All code, accounts, market replies and data below are temporary fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPluginLoader } from '../src/kernel/plugin-loader.js';
import { createConfig, buildDefaultConfig } from '../src/kernel/config.js';
import { createPermissions } from '../src/kernel/permissions.js';
import { createCapabilityRegistry } from '../src/kernel/capability.js';
import { createToolRegistry } from '../src/kernel/tools.js';
import { createScheduler } from '../src/kernel/scheduler.js';
import { createStorage } from '../src/kernel/storage.js';
import { createHttpServer } from '../src/kernel/http.js';
import { registerConsoleRoutes } from '../src/console/routes.js';
import { createCommunityMarketAdapters, createStoredZip, COMMUNITY_BASE_URL } from '../bundled/market/client.js';
import { Bus } from '../src/kernel/bus.js';

const log = { info() {}, warn() {}, error() {}, child() { return this; }, recent() { return []; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pluginFiles(id, label) {
  return [
    { name: 'package/plugin.json', data: Buffer.from(JSON.stringify({ id, kind: 'plugin', permissions: [] })) },
    { name: 'package/package.json', data: Buffer.from('{"type":"module"}') },
    { name: 'package/helper.js', data: Buffer.from(`export const value=${JSON.stringify(label)};`) },
    { name: 'package/index.js', data: Buffer.from("import {value} from './helper.js'; let count=0;export default {setup(ctx){ctx.registerTool({id:'read',name:'Read',execute:()=>value+':'+(++count)});}};") },
  ];
}
function writePlugin(root, kind, id, label) {
  const dir = path.join(root, kind, id); fs.mkdirSync(dir, { recursive: true });
  for (const file of pluginFiles(id, label)) fs.writeFileSync(path.join(dir, path.basename(file.name)), file.data);
  return dir;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-account-extensions-'));
  const appRoot = path.join(root, 'app'); fs.mkdirSync(appRoot);
  for (const kind of ['bundled', 'plugins', 'skills', 'src']) fs.mkdirSync(path.join(appRoot, kind));
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
  writePlugin(appRoot, 'bundled', 'bundled-demo', 'bundled');
  writePlugin(appRoot, 'plugins', 'primary-only', 'primary');
  const accounts = [];
  t.after(async () => {
    for (const account of accounts) await account.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('qqa-account-extensions-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function account(label, { legacy = false, runtimeCacheRoot: cacheOverride, publicPrefix } = {}) {
    const home = path.join(root, 'accounts', label), dataDir = path.join(home, 'data');
    const extensionRoot = legacy ? appRoot : path.join(home, 'extensions');
    const runtimeCacheRoot = cacheOverride ?? path.join(home, 'module-cache');
    fs.mkdirSync(dataDir, { recursive: true });
    const config = createConfig({ dataDir, defaults: buildDefaultConfig(), log }); config.load();
    const token = 'synthetic-extension-' + label;
    config.update({ server: { port: 0, token } });
    const bus = new Bus(log), permissions = createPermissions({ dataDir, log, bus, headless: true });
    const capability = createCapabilityRegistry({ log });
    const registry = createToolRegistry({ log, bus, permissions, capabilities: capability });
    const scheduler = createScheduler({ log });
    const loader = createPluginLoader({ appRoot, ...(legacy ? {} : { extensionRoot, runtimeCacheRoot }),
      config, log, bus, registry, capabilityRegistry: capability, permissions, scheduler,
      storage: createStorage({ dataDir, log }) });
    const http = createHttpServer({ config, log, staticDir: appRoot });
    let installZip;
    registerConsoleRoutes(http, { config, loader, permissions, registry, capability, log, dataDir,
      appRoot, ...(legacy ? {} : { extensionRoot }), publicPrefix, sessions: {}, store: {}, onebot: {},
      bindInstallZip(value) { installZip = value; } });
    const port = await http.listen();
    let stopped = false;
    const result = { home, appRoot, dataDir, extensionRoot, runtimeCacheRoot, config, loader, registry,
      async request(method, endpoint, body) {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method,
          headers: { 'x-console-token': token, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
      },
      install(id, label) { return this.request('POST', '/api/skills/install', {
        zipBase64: createStoredZip(pluginFiles(id, label)).toString('base64'), kind: 'plugin',
      }); },
      read(id = 'same-id') { return registry.get(id + '__read').execute(); },
      installZip: (...args) => installZip(...args),
      async close() { if (stopped) return; stopped = true; loader.stopAll(); scheduler.stop(); permissions.close(); await http.close(); },
    };
    accounts.push(result);
    return result;
  }
  return { root, appRoot, account };
}

test('same extension ID installs, loads, hot reloads and uninstalls independently', async t => {
  const f = await fixture(t), a = await f.account('a'), b = await f.account('b');
  await a.loader.loadAll(); await b.loader.loadAll();
  assert.equal(a.loader.isActive('bundled-demo'), true);
  assert.equal(b.loader.isActive('bundled-demo'), true);
  assert.equal(a.loader.hostEntry('primary-only'), null, 'shared primary plugins must not enter account scans');
  assert.equal(b.loader.hostEntry('primary-only'), null);
  assert.equal((await a.install('same-id', 'account-a')).status, 200);
  assert.equal((await b.install('same-id', 'account-b')).status, 200);
  assert.equal(fs.existsSync(path.join(f.appRoot, 'plugins', 'same-id')), false);
  assert.equal((await a.request('POST', '/api/skills/same-id', { enabled: true })).status, 200);
  assert.equal((await b.request('POST', '/api/skills/same-id', { enabled: true })).status, 200);
  assert.equal(await a.read(), 'account-a:1'); assert.equal(await b.read(), 'account-b:1');
  const aRuntime = a.loader.hostEntry('same-id').runtime, bRuntime = b.loader.hostEntry('same-id').runtime;
  assert.equal(path.dirname(aRuntime), a.runtimeCacheRoot);
  assert.equal(path.dirname(bRuntime), b.runtimeCacheRoot);
  assert.notEqual(aRuntime, bRuntime);
  assert.equal(fs.existsSync(path.join(f.appRoot, 'data-plugin-runtime')), false);
  fs.writeFileSync(path.join(a.extensionRoot, 'plugins', 'same-id', 'helper.js'), "export const value='account-a-updated';");
  assert.equal((await a.request('POST', '/api/skills/same-id/hot-reload', {})).data.ok, true);
  assert.equal(await a.read(), 'account-a-updated:1'); assert.equal(await b.read(), 'account-b:2');
  assert.equal(fs.existsSync(aRuntime), false, 'only the replaced account generation is deleted');
  assert.equal(fs.existsSync(bRuntime), true);
  assert.equal((await a.install('bundled-demo', 'invalid-override')).status, 409);
  assert.equal((await a.request('POST', '/api/skills/same-id', { enabled: false })).status, 200);
  const removed = await a.request('POST', '/api/skills/same-id/delete', {});
  assert.equal(removed.status, 200);
  assert.ok(fs.existsSync(path.join(a.extensionRoot, removed.data.quarantine, 'helper.js')));
  assert.equal(fs.existsSync(path.join(a.extensionRoot, 'plugins', 'same-id')), false);
  assert.equal(await b.read(), 'account-b:3'); assert.equal(b.loader.isActive('same-id'), true);
  await a.close(); assert.equal(fs.existsSync(bRuntime), true); assert.equal(await b.read(), 'account-b:4');
});

test('bundled module instances, authoring metadata and default roots retain the right ownership', async t => {
  const f = await fixture(t), a = await f.account('a'), b = await f.account('b');
  await a.loader.loadAll(); await b.loader.loadAll();
  assert.equal(await a.registry.get('read').execute(), 'bundled:1');
  assert.equal(await b.registry.get('read').execute(), 'bundled:1');
  assert.equal(path.dirname(a.loader.hostEntry('bundled-demo').runtime), a.runtimeCacheRoot);
  assert.equal(path.dirname(b.loader.hostEntry('bundled-demo').runtime), b.runtimeCacheRoot);
  const metadata = (await a.request('GET', '/api/extensions/authoring-context')).data;
  assert.equal(metadata.appRoot, f.appRoot); assert.equal(metadata.extensionRoot, a.extensionRoot);
  const legacy = await f.account('legacy', { legacy: true }); await legacy.loader.loadAll();
  assert.equal(legacy.loader.isActive('primary-only'), true);
  assert.equal(path.dirname(legacy.loader.hostEntry('primary-only').runtime), path.join(f.appRoot, 'data-plugin-runtime'));
  assert.deepEqual(Object.keys((await legacy.request('GET', '/api/extensions/authoring-context')).data).sort(), ['appRoot', 'docs', 'version']);
});

test('watching a replaced account root never reloads or unloads another account', async t => {
  const f = await fixture(t), a = await f.account('a'), b = await f.account('b');
  await a.install('same-id', 'a'); await b.install('same-id', 'b');
  await a.request('POST', '/api/skills/same-id', { enabled: true });
  await b.request('POST', '/api/skills/same-id', { enabled: true });
  a.loader.startWatchers(); b.loader.startWatchers();
  await pause(100);
  const bGeneration = b.loader.hostEntry('same-id').generation;
  const plugins = path.join(a.extensionRoot, 'plugins'), retired = path.join(a.extensionRoot, 'retired-plugins');
  assert.equal(path.dirname(plugins), a.extensionRoot); assert.equal(path.dirname(retired), a.extensionRoot);
  fs.renameSync(plugins, retired); fs.mkdirSync(plugins);
  writePlugin(a.extensionRoot, 'plugins', 'replacement', 'replacement');
  const deadline = Date.now() + 6000;
  while (!a.loader.isActive('replacement') || a.loader.hostEntry('same-id')) {
    assert.ok(Date.now() < deadline, 'independent extension parent watcher must notice root replacement'); await pause(30);
  }
  assert.equal(b.loader.hostEntry('same-id').generation, bGeneration);
  assert.equal(await b.read(), 'b:1');
});

test('cross-account paths, ancestor junctions and cache junctions are rejected', async t => {
  const f = await fixture(t), a = await f.account('a'), b = await f.account('b');
  fs.mkdirSync(path.join(a.extensionRoot, 'plugins'));
  const bDir = writePlugin(b.extensionRoot, 'plugins', 'same-id', 'b');
  await assert.rejects(a.loader.loadDir('plugins', bDir), /直接子目录/);
  const alias = path.join(a.home, 'linked-extensions');
  fs.symlinkSync(b.extensionRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createPluginLoader({ appRoot: f.appRoot, extensionRoot: path.join(alias, 'nested') }), /符号链接/);
  const management = path.join(a.extensionRoot, '.extension-management-v1');
  fs.mkdirSync(path.join(b.extensionRoot, '.extension-management-v1'), { recursive: true });
  fs.symlinkSync(path.join(b.extensionRoot, '.extension-management-v1'), management, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await a.install('cannot-cross', 'blocked')).status, 403);
  assert.equal(fs.existsSync(path.join(b.extensionRoot, 'plugins', 'cannot-cross')), false);
  fs.unlinkSync(management);
  fs.mkdirSync(b.runtimeCacheRoot, { recursive: true });
  const linkedCache = path.join(f.root, 'linked-cache');
  fs.symlinkSync(b.runtimeCacheRoot, linkedCache, process.platform === 'win32' ? 'junction' : 'dir');
  const c = await f.account('c', { runtimeCacheRoot: linkedCache });
  await c.loader.loadAll();
  assert.equal(c.loader.isActive('bundled-demo'), false);
  assert.match(c.loader.hostEntry('bundled-demo').loadError, /符号链接/);
  assert.deepEqual(fs.readdirSync(b.runtimeCacheRoot), []);
});

test('market publishing and installation use the account extension root', async t => {
  const f = await fixture(t), a = await f.account('a');
  await a.install('same-id', 'account-market-a');
  writePlugin(f.appRoot, 'plugins', 'same-id', 'primary-market-must-not-publish');
  fs.writeFileSync(path.join(a.dataDir, 'account.json'), JSON.stringify({ accounts: [{ username: 'synthetic-user', token: 'synthetic-market-session' }] }));
  const bodies = [], archive = createStoredZip(pluginFiles('market-added', 'account-market-installed'));
  const client = createCommunityMarketAdapters({ appRoot: f.appRoot, extensionRoot: a.extensionRoot,
    dataDir: a.dataDir, config: a.config, installZip: a.installZip,
    dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (url, options) => {
      if (url === COMMUNITY_BASE_URL + '/market/publish') { bodies.push(Buffer.from(options.body).toString('utf8')); return new Response('{"ok":true}'); }
      if (url === COMMUNITY_BASE_URL + '/plugins') return new Response('{"ok":true,"items":[{"id":"market-added","type":"plugin","status":"approved","installCode":"SYNTHETIC"}]}');
      if (url === COMMUNITY_BASE_URL + '/install/verify') return new Response('{"ok":true,"results":[{"code":"SYNTHETIC","ok":true,"id":"market-added","type":"plugin"}]}');
      if (url === COMMUNITY_BASE_URL + '/install/SYNTHETIC/download') return new Response(archive);
      throw new Error('Unexpected synthetic market request');
    } });
  assert.equal((await client.publish({ kind: 'plugin', id: 'same-id', accountUsername: 'synthetic-user' })).ok, true);
  assert.ok(bodies[0].includes('account-market-a'));
  assert.equal(bodies[0].includes('primary-market-must-not-publish'), false);
  const installed = await client.install({ kind: 'plugin', id: 'market-added' });
  assert.equal(installed.dir, path.join(a.extensionRoot, 'plugins', 'market-added'));
  assert.equal(fs.existsSync(path.join(installed.dir, 'index.js')), true);
  assert.equal(fs.existsSync(path.join(f.appRoot, 'plugins', 'market-added')), false);
});

test('account background URLs use only a validated public account prefix', async t => {
  const f = await fixture(t), prefix = '/accounts/12345678-1234-4321-9876-123456789abc';
  const a = await f.account('a', { publicPrefix: prefix });
  const b = await f.account('b', { publicPrefix: '//untrusted.invalid/accounts/anything' });
  const image = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64') };
  const own = await a.request('POST', '/api/uikit/background', image);
  const fallback = await b.request('POST', '/api/uikit/background', image);
  assert.equal(own.status, 200); assert.ok(own.data.url.startsWith(prefix + '/ui/backgrounds/'));
  assert.equal(fallback.status, 200); assert.match(fallback.data.url, /^\/ui\/backgrounds\/bg-/);
});
