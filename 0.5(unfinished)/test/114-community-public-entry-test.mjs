// Real opaque iframe -> host RPC -> popup dispatch; all public traffic is local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { isolateConsoleFixture } from './console-fixture-isolation.mjs';
import { RpcBridge } from '../ui/shell/rpc-bridge.js';
import { isSettingsLeaseOpenRequest } from './settings-save-observation.mjs';

// Exercise the real RPC validator without exposing arbitrary URLs or permitting
// user panels to impersonate the bundled community page.
const originalWindow = globalThis.window, sent = [], opened = [];
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const frameStub = { contentWindow: { postMessage: message => sent.push(message) }, addEventListener() {} };
const guard = new RpcBridge({ frame: frameStub, manifest: { id: 'community', kind: 'bundled', api: [] }, onOpenExternal: target => { opened.push(target);return { ok: true }; } });
const event = (target, patch = {}) => ({ source: frameStub.contentWindow, origin: 'null', data: { jsonrpc: '2.0', id: '114', method: 'ui.openExternal', params: { target }, meta: { nonce: guard.nonce, panel: 'community', ...patch } } });
try {
  await guard.handle(event('https://evil.invalid/?token=secret'));
  assert.equal(sent.at(-1).error.code, -32600);assert.equal(opened.length, 0);
  guard.manifest.kind = 'user';await guard.handle(event('feedback-btn'));
  assert.equal(sent.at(-1).error.code, -32003);assert.equal(opened.length, 0);
  guard.manifest = { id: 'settings', kind: 'bundled', api: [] };
  const wrongPanel = event('feedback-btn');wrongPanel.data.meta.panel = 'settings';
  await guard.handle(wrongPanel);assert.equal(sent.at(-1).error.code, -32003);
  guard.manifest = { id: 'community', kind: 'bundled', api: [] };
  await guard.handle(event('feedback-btn', { nonce: 'wrong' }));assert.equal(opened.length, 0);
  const wrongSource = event('feedback-btn');wrongSource.source = {};
  await guard.handle(wrongSource);assert.equal(opened.length, 0);
} finally {
  guard.close();
  if (originalWindow === undefined) delete globalThis.window;else globalThis.window = originalWindow;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-community114-')), token = 'community114-console';
// Keep the actual default provider closure, with no workspace/installed roots.
const isolation = isolateConsoleFixture(dataDir, '114');
fs.writeFileSync(path.join(isolation.appRoot, 'package.json'), JSON.stringify({type:'module'}));
fs.cpSync(new URL('../src', import.meta.url), path.join(isolation.appRoot, 'src'), {recursive:true});
for (const name of ["community","market"]) fs.cpSync(new URL(`../bundled/${name}`, import.meta.url), path.join(isolation.appRoot, 'bundled', name), {recursive:true});
function assertFixtureOwners(active = false) {
  assert.deepEqual(kernel.loader.listEntries().map(entry => entry.id).sort(), ["community","market"], 'only the actual declared default fixture owners are loaded');
  if (active) {
    for (const id of ["community","market"]) assert.equal(kernel.loader.isActive(id), true, id);
    assert.deepEqual(kernel.capability.providers('market.client').map(item => item.ownerId), ['market']);
    assert.deepEqual(kernel.capability.providers('community.client').map(item => item.ownerId), ['community']);
  }
}
function cleanupFixture() {
  try { isolation.restore(); } finally {
    const relative = path.relative(os.tmpdir(), dataDir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dataDir, {recursive:true, force:true});
  }
}

const kernel = createKernel({
  appRoot: isolation.appRoot, env: isolation.env, headless: true,
  fetchImpl: (...args) => fetch(...args),
  transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }), getBlocklist: () => ({ ok: true, ids: [] }), listAccounts: () => ({ ok: true, accounts: [] }) },
});
kernel.config.update({ server: { port: 0, token }, telemetry: { enabled: false }, proactive: {enabled:false}, api: { apiKey: 'private-config-secret-114' } });
kernel.loader.startWatchers = () => {};
let browser;
try {
  const port = await kernel.start(), base = isolation.allowOrigin(`http://127.0.0.1:${port}`);assertFixtureOwners(true);
  const playwright = createRequire(import.meta.url)('playwright-core');
  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(version => path.join(cache, version, 'chrome-win64/chrome.exe')).find(file => fs.existsSync(file));
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext(), publicRequests = [], writes = [], errors = [];
  const blockedBrowser = [], publicTargets = new Set(["https://www.kondius.cn/qq-agent/persona-plaza/","https://kondius.cn/qq-agent/comments","https://www.kondius.cn/qq-agent/plugin-market/"]);
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin === base) return route.continue();
    if (request.method() !== 'GET' || !publicTargets.has(request.url())) { blockedBrowser.push(request.url());return route.abort(); }
    publicRequests.push({ url: request.url(), method: request.method(), headers: request.headers() });
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>114 Local Public Page</title><p>Local navigation target only. No author submission.</p>' });
  });
  context.on('request', request => { if (request.method() === 'POST' && !isSettingsLeaseOpenRequest(request, base)) writes.push(request.url()); });
  const configBeforePublicNavigation = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  const page = await context.newPage();page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?token=${token}`);
  await page.locator('#nav button[data-panel=community]').click();
  const panel = page.frameLocator('#panel-host iframe');
  await panel.locator('#refresh').waitFor();
  assert.equal(await page.locator('#panel-host iframe').getAttribute('sandbox'), 'allow-scripts', 'the page is not granted popup or top-navigation privileges');
  const targets = [
    ['人设广场', 'https://www.kondius.cn/qq-agent/persona-plaza/'],
    ['留言板网页版', 'https://kondius.cn/qq-agent/comments'],
    ['市场网页版', 'https://www.kondius.cn/qq-agent/plugin-market/'],
  ];
  console.log('· Real buttons dispatch the three exact public addresses through the host despite the iframe sandbox');
  async function open(label, expectedUrl) {
    const popupPromise = context.waitForEvent('page');
    await panel.getByRole('button', { name: label, exact: true }).click();
    const popup = await popupPromise;await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), expectedUrl);assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    await panel.locator('#community-link-status').filter({ hasText: '已请求在浏览器打开' }).waitFor();
  }
  for (const [label, url] of targets) await open(label, url);
  assert.equal(publicRequests.length, 3);
  for (const request of publicRequests) {
    assert.equal(request.method, 'GET');assert.equal(new URL(request.url).search, '');
    assert.equal(request.headers.referer, undefined);
    assert.doesNotMatch(JSON.stringify(request), /community114-console|private-config-secret-114/);
  }
  assert.deepEqual(writes, [], 'public navigation never submits feedback or configuration');
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), configBeforePublicNavigation, 'public navigation preserves the complete config file');

  console.log('· Launcher failure is visible and retry stays available without claiming that feedback was sent');
  await page.evaluate(() => { window.qa114Open = window.open;window.open = () => { throw new Error('114 浏览器暂时不可用'); }; });
  await panel.getByRole('button', { name: '留言板网页版', exact: true }).click();
  await panel.locator('#community-link-status .error').filter({ hasText: '114 浏览器暂时不可用' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '留言板网页版', exact: true }).isEnabled(), true);
  assert.equal(publicRequests.length, 3);assert.deepEqual(writes, []);
  await page.evaluate(() => { window.open = window.qa114Open;delete window.qa114Open; });

  console.log('· Public links do not restore a disabled community provider or invent a local author-submission API');
  await kernel.loader.setEnabled('community', false);
  const unavailable = await fetch(`${base}/api/community/blocklist`, { headers: { 'x-console-token': token } });
  assert.equal(unavailable.status, 503);
  await open(...targets[1]);
  assert.equal(kernel.loader.isActive('community'), false);
  assert.equal((await fetch(`${base}/api/community/blocklist`, { headers: { 'x-console-token': token } })).status, 503);
  assert.equal(publicRequests.length, 4);assert.deepEqual(writes, []);
  await page.setViewportSize({ width: 960, height: 640 });
  assert.equal(await panel.locator('body').evaluate(body => Math.max(body.scrollWidth, body.ownerDocument.documentElement.scrollWidth) - body.ownerDocument.documentElement.clientWidth), 0);
  assert.deepEqual(errors, []);assert.deepEqual(blockedBrowser, []);isolation.assertOffline();assertFixtureOwners();
  console.log('✓ 114 Public entry dispatch, strict RPC targets, no credential/referrer leakage, failure/retry and provider preservation passed');
} finally {
  try { await browser?.close();await kernel.stop(); } finally { cleanupFixture(); }
}
