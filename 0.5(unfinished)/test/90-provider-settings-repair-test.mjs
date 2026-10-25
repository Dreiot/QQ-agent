import {settingsReload,settingsSection,settingsEditor,openSettingsFold,settingsProvider,settingsPickModel} from './settings-navigation.mjs';
import {isSettingsSaveRequest, settingsSavePatch} from './settings-save-observation.mjs';
// Actual kernel HTTP + headless Chromium; no visible window or real credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { createConfig, buildDefaultConfig } from '../src/kernel/config.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-provider90-')), token = 'provider90-token';
// This fixture uses the actual default UI and imported kernel consumers, with
// no bundled or installed extensions. Data and migration roots are temporary.
const appRoot = path.join(dataDir, 'application'); fs.mkdirSync(appRoot);
fs.cpSync(path.resolve(import.meta.dirname, '../ui'), path.join(appRoot, 'ui'), { recursive: true });
for (const directory of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(appRoot, directory));
let outbound = 0, dnsCalls = 0; const browserOutbound = [], ownedOrigins = new Set();
const nativeFetch = globalThis.fetch, nativeLookup = dns.lookup;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (ownedOrigins.has(url.origin)) return nativeFetch(input, options);
  outbound++; throw new Error('QA90 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA90 external DNS disabled'); };
const routeOwnedPage = (page, base) => page.route('**/*', route => {
  const url = route.request().url();
  if (new URL(url).origin === new URL(base).origin) return route.continue();
  browserOutbound.push(url); return route.abort();
});
function assertOffline() {
  assert.equal(outbound, 0, 'no external Node fetch was attempted');
  assert.equal(dnsCalls, 0, 'no external DNS was attempted');
  assert.deepEqual(browserOutbound, [], 'the browser requested only its owned console origin');
}

const kernel = createKernel({ appRoot, env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(dataDir, 'absent') }, headless: true,
  fetchImpl: async () => { outbound++; throw new Error('QA90 external traffic disabled'); },
  transport: { id: 'fixture', selfId: '99', start() {}, stop() {}, status: () => ({ connected: false }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) }, communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) } });
kernel.loader.startWatchers = () => {};
kernel.config.update({ server: { port: 0, token }, telemetry: { enabled: false },
  api: { provider: 'a', baseUrl: 'https://a.example/v1', model: 'model-a', apiKey: 'direct-fixture-key' },
  providers: [
    { id: 'a', displayName: 'Channel A', baseUrl: 'https://a.example/v1', models: ['model-a'] },
    { id: 'b', displayName: 'Channel B', baseURL: 'https://b.example/v1', models: [{ id: 'model-b1' }, { id: 'model-b2' }] },
    { id: 'empty', displayName: 'Empty Channel', baseUrl: 'https://empty.example/v1', models: [] },
    { id: 'legacy', baseUrl: 'https://legacy.example/v1', models: [], apiKey: 'legacy-inline-key', apiKeyFrom: 'NONEXISTENT_PROVIDER90_KEY' },
  ], dshProviderKeys: { a: 'keep-a-key', b: 'clear-b-key', legacy: 'clear-legacy-key' } });
const port = await kernel.start(), base = `http://127.0.0.1:${port}`; ownedOrigins.add(base);
  assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);
const request = async (method, pathname, body) => {
  const response = await fetch(base + pathname, { method, headers: { 'x-console-token': token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
};
const waitFor = async (check) => { for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); } assert.fail('fixture state did not settle'); };
async function charge(button, clicks) {
  assert.equal(await button.getAttribute('data-danger-clicks'), String(clicks));
  // One actionability check sends exactly N trusted clicks. Rechecking CSS
  // stability between clicks can exceed the real 500ms gesture hold period.
  await button.click({ clickCount: clicks });
}
let browser;
try {
  console.log('· Real HTTP: clear/delete remove persisted provider credentials without touching another provider');
  let response = await request('POST', '/api/providers/set-key', { providerId: 'legacy', apiKey: '' });
  assert.equal(response.status, 200); assert.equal(response.data.hasKey, false);
  assert.equal(kernel.config.get().dshProviderKeys.legacy, undefined);
  assert.equal(kernel.config.get().providers.find((item) => item.id === 'legacy').apiKey, '');
  assert.equal(kernel.config.get().providers.find((item) => item.id === 'legacy').apiKeyFrom, '');
  assert.equal((await request('GET', '/api/providers')).data.providers.find((item) => item.id === 'legacy').hasKey, false);
  assert.equal((await request('POST', '/api/providers/set-key', { providerId: 'b' })).status, 400);
  assert.equal((await request('POST', '/api/providers/set-key', { providerId: 'b', apiKey: '******' })).status, 400);
  assert.equal(kernel.config.get().dshProviderKeys.b, 'clear-b-key');
  response = await request('DELETE', '/api/providers', { providerId: 'legacy' }); assert.equal(response.status, 200);
  assert.equal(kernel.config.get().dshProviderKeys.legacy, undefined); assert.equal(kernel.config.get().api.provider, 'a');
  const fromDisk = createConfig({ dataDir, defaults: buildDefaultConfig(), log: { info() {}, warn() {} } }); fromDisk.load();
  assert.equal(fromDisk.get().dshProviderKeys.legacy, undefined); assert.equal(fromDisk.get().dshProviderKeys.a, 'keep-a-key');
  assert.equal(fromDisk.get().providers.some((item) => item.id === 'legacy'), false);

  console.log('· Headless actual settings iframe: selecting a channel atomically updates endpoint/model and preserves another pending edit');
  const playwright = createRequire(import.meta.url)('playwright-core');
  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.flatMap((version) => ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'].map((relative) => path.join(cache, version, relative))).find((file) => fs.existsSync(file));
  assert.ok(executablePath && fs.existsSync(executablePath), 'use an existing local Chromium; never download');
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }), errors = [], patches = [];
  page.setDefaultTimeout(8000); page.on('pageerror', (error) => errors.push(error.message));
  await routeOwnedPage(page, base);
  page.on('request', (req) => { if (isSettingsSaveRequest(req)) patches.push(settingsSavePatch(req)); });
  await page.goto(`${base}/?token=${token}`); await page.locator('#nav button[data-panel="settings"]').click();
  const frame = page.frameLocator('#panel-host iframe'); await frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
  const open = async (id) => settingsSection(frame,id);
  await open('persona'); await frame.locator('#field-persona-botName').fill('pending-name');
  await settingsEditor(frame,'model-config');await settingsPickModel(frame,'main','b','model-b1');
  assert.equal(await frame.locator('#base-url').inputValue(), 'https://b.example/v1'); assert.equal(await frame.locator('#model').inputValue(), 'model-b1');
  await waitFor(() => kernel.config.get().api.provider === 'b');
  assert.equal(kernel.config.get().api.baseUrl, 'https://b.example/v1'); assert.equal(kernel.config.get().api.model, 'model-b1'); assert.equal(kernel.config.get().persona.botName, 'pending-name');
  const switchPatch = patches.find((patch) => patch.api?.provider === 'b'); assert.equal(switchPatch.api.baseUrl, 'https://b.example/v1'); assert.equal(switchPatch.api.model, 'model-b1');
  await frame.getByRole('button',{name:'从目录选择主模型',exact:true}).click();const emptyPicker=frame.locator('dialog.model-picker');await emptyPicker.locator('nav [data-provider-id=empty]').click();assert.equal(await emptyPicker.locator('button[data-model-id]').count(),0);await emptyPicker.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(kernel.config.get().api.provider,'b');assert.equal(kernel.config.get().api.model,'model-b1','browsing an empty channel does not clear the configured model');
  const channel=()=>frame.locator('#provider-list article[data-provider-id=b]');
  const providerRender = async (trigger) => {
    const previous = await channel().elementHandle();
    const read = page.waitForResponse((response) => response.request().method() === 'GET' && response.url() === base + '/api/providers')
      .then((response) => ({ response }), (error) => ({ error }));
    await trigger();
    const outcome = await read; if (outcome.error) throw outcome.error;
    assert.equal(outcome.response.status(), 200); await outcome.response.finished();
    // Dialog closure precedes its asynchronous load(). Its original row must
    // retire before the next independent update or confirmation gesture starts.
    await waitFor(() => previous.evaluate((node) => !node.isConnected));
  };
  await frame.getByRole('button',{name:'从目录选择主模型',exact:true}).click();await frame.locator('dialog.model-picker nav [data-provider-id=b]').click();await frame.locator('dialog.model-picker [data-model-id=model-b2]').click();await waitFor(()=>kernel.config.get().api.model==='model-b2');await settingsEditor(frame,'model-manager');await settingsProvider(frame,'b');
  assert.equal(kernel.config.get().api.baseUrl, 'https://b.example/v1');

  console.log('· Headless actual clear/save/delete dialogs keep keys absent after fresh HTTP and disk reads');
  const clearKey=channel().getByRole('button',{name:'清除密钥',exact:true});await charge(clearKey,3);
  assert.equal(await frame.locator('dialog.confirm-panel').count(),0);await waitFor(()=>kernel.config.get().dshProviderKeys.b===undefined);
  await channel().getByRole('textbox',{name:'渠道名称',exact:true}).fill('Channel B edited');await channel().locator('.provider-model-head h4').click();await channel().locator('.provider-save-status').filter({hasText:'已保存'}).waitFor();
  assert.equal((await request('GET', '/api/providers')).data.providers.find((item) => item.id === 'b').hasKey, false);
  assert.equal(kernel.config.get().dshProviderKeys.a, 'keep-a-key');
  assert.equal((await request('POST', '/api/providers/set-key', { providerId: 'b', apiKey: 'new-key-to-delete' })).status, 200);
  // This direct fixture write does not emit a settings reload event. Read it
  // through the existing UI instead of racing the previous save's pending load.
  await providerRender(() => settingsReload(frame));
  await channel().locator('[data-manager-key=set]').waitFor();
  await charge(channel().getByRole('button', { name: '删除渠道', exact: true }), 4);
  assert.equal(await frame.locator('dialog.confirm-panel').count(), 0);
  await waitFor(() => !kernel.config.get().providers.some((item) => item.id === 'b'));
  assert.equal(kernel.config.get().dshProviderKeys.b, undefined); assert.equal(kernel.config.get().api.provider, ''); assert.equal(kernel.config.get().api.model, ''); assert.equal(kernel.config.get().api.baseUrl, '');
  fromDisk.load(); assert.equal(fromDisk.get().dshProviderKeys.b, undefined); assert.equal(fromDisk.get().dshProviderKeys.a, 'keep-a-key');
  assert.deepEqual(errors, []); console.log('✓ 90 provider settings: real HTTP + headless UI + persisted config pass');
} finally {
  await browser?.close(); await kernel.stop();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-provider90-'));
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  fs.rmSync(dataDir, { recursive: true, force: true });
  assertOffline(); assert.deepEqual(kernel.loader.listEntries(), []);
}
