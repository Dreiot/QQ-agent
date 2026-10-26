// 73 · 组件库方案持久化链路：真实内核 + 真实 Chromium 全链路验收。
//
// 覆盖用户点名的链路（不只看预览，落盘 + 刷新回读都要对）：
//   旧配置兼容 → 编辑 → 自动保存 → 另存为自定义方案 → 刷新回读
//   → 重命名 → 切换基准 → 恢复出厂 → 删除自定义方案 → 刷新回读。
//
// 回归点（修复前实测的丢数据路径）：
//   旧扁平 ui.uikit 首次编辑只 POST 子路径，服务端深合并后是
//   「旧根键 + ui.uikit.dark.*」的中间态。migrateUikit 若只认新结构，
//   遗留配色会被静默丢弃、界面当场回落默认底色/圆角。
import assert from 'node:assert/strict';
import {settingsSection} from './settings-navigation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel/kernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'uikit-73-token';
const outDir = path.join(ROOT, '.qa-local/destructive-ui-20261016/related-agent-settings/73');
fs.mkdirSync(outDir, { recursive: true });

let playwright = null;
for (const name of ['playwright', 'playwright-core']) {
  try { playwright = createRequire(import.meta.url)(name); break; } catch { /* 探测本机模块 */ }
}
if (!playwright) { console.log('! 无 Playwright'); process.exit(1); }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-uikit73-'));
// Real default UI/routes and the formal source consumers stay under test.
// No loader extension is required by this fixture's business contract.
const appRoot = path.join(dataDir, 'application'); fs.mkdirSync(appRoot);
fs.cpSync(path.resolve(import.meta.dirname, '../ui'), path.join(appRoot, 'ui'), { recursive: true });
for (const directory of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(appRoot, directory));
let isolatedOutbound = 0, dnsCalls = 0; const browserOutbound = [], ownedOrigins = new Set();
const nativeFetch = globalThis.fetch, nativeLookup = dns.lookup;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (ownedOrigins.has(url.origin)) return nativeFetch(input, options);
  isolatedOutbound++; throw new Error('QA73 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA73 external DNS disabled'); };
const routeOwnedPage = (page, base) => page.route('**/*', route => {
  const url = route.request().url();
  if (new URL(url).origin === new URL(base).origin) return route.continue();
  browserOutbound.push(url); return route.abort();
});
function assertOffline() {
  assert.equal(isolatedOutbound, 0, 'no external Node fetch was attempted');
  assert.equal(dnsCalls, 0, 'no external DNS was attempted');
  assert.deepEqual(browserOutbound, [], 'browser requested only its exact owned console origin');
}

const kernel = createKernel({ appRoot,
  env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(dataDir, 'absent') },
    fetchImpl: async () => { isolatedOutbound++; throw new Error('QA73 external traffic disabled'); },
  transport: { id: 'fixture', connected: false, selfId: '', actions: {}, start: async () => {}, stop: async () => {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
  headless: true,
});
kernel.loader.startWatchers = () => {};
kernel.config.update({ server: { port: 0, token: TOKEN }, telemetry: { enabled: false } });
const port = await kernel.start();
const base = `http://127.0.0.1:${port}`;
ownedOrigins.add(base); assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);

const readConfig = async () => (await fetch(`${base}/api/config`, { headers: { 'x-console-token': TOKEN } })).json();
async function waitConfig(predicate, label, timeout = 7000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await readConfig();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(`${label}（超时，最后读到 ui.uikit=${JSON.stringify(last?.ui?.uikit)}）`);
}

let browser;
try {
  // ---- 预置一份旧扁平配置（0.4/早期 0.5 的真实存量格式）----
  const seed = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
    body: JSON.stringify({ ui: { uikit: { bg: '#101010', accent: '#ff8800', radius: 5 } } }),
  });
  assert.equal(seed.status, 200, '旧扁平配置可写入');

  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(version => path.join(cache, version, 'chrome-win64/chrome.exe')).find(file => fs.existsSync(file));
  assert.ok(executablePath, '73 requires an already installed local Chromium');
  browser = await playwright.chromium.launch({ headless: process.env.QA_HEADLESS !== '0', executablePath });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 })).newPage();
  await routeOwnedPage(page, base);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // "刷新回读"用带 token 的重新导航实现：shell 首帧会把 token 从 URL 剥掉，
  // page.reload() 后纯 Chromium 拿不到 token（Electron 侧有 qqAgentShell.getConsoleToken 补给），
  // 会卡在导航渲染。重新 goto 等价于重启 UI、从服务端回读配置，正是要验的语义。
  async function openUikit() {
    await page.waitForFunction(() => document.querySelectorAll('#nav button').length >= 8, null, { timeout: 20000 });
    await page.locator('#nav button[data-panel="settings"]').click();
    await page.waitForFunction(() => document.querySelector('#panel-host iframe')?.src.includes('/panels/settings/'), null, { timeout: 15000 });
    const frame = page.frameLocator('#panel-host iframe');
    await frame.locator('#field-ui-uikit-mode').waitFor({ state: 'attached', timeout: 20000 });
    await settingsSection(frame,'uikit');
    await frame.locator('.bg-editor').waitFor({ state: 'attached', timeout: 15000 });
    for(const key of ['colors','layout','themes']){const fold=frame.locator(`details[data-appearance-group="${key}"]`);if(!await fold.evaluate(n=>n.open))await fold.locator(':scope>summary').click();}
    return frame;
  }
  const setColor = (frame, key, value) => frame.locator(`#field-uikit-${key}`).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  // Send the real pointer sequence in one protocol operation so a busy CI host
  // cannot insert a >500ms pause between separate round trips.
  const charge = (control, clicks) => control.click({ clickCount: clicks, delay: 30 });

  console.log('=== A. 旧扁平配置首次渲染：外观完整呈现 ===');
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  let frame = await openUikit();
  assert.equal(await frame.locator('#field-uikit-bg').inputValue(), '#101010', '旧底色呈现');
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#ff8800', '旧强调色呈现');
  assert.equal(await frame.locator('#field-uikit-radius').inputValue(), '5', '旧圆角呈现');
  console.log('✓ 旧扁平配置渲染为暗色编辑态（bg/accent/radius 全部保留）');

  console.log('\n=== B. 首次编辑 + 自动保存：遗留外观不丢（回归点）===');
  await setColor(frame, 'accent', '#00ff00');
  const afterEdit = await waitConfig((c) => c.ui?.uikit?.dark?.accent === '#00ff00', '编辑后的强调色落盘');
  assert.equal(afterEdit.ui.uikit.accent, '#ff8800', '服务端仍保留旧根键（深合并中间态）');
  console.log('  中间态：', JSON.stringify(afterEdit.ui.uikit));
  // 刷新回读：修复前 migrateUikit 见到 dark 就丢弃旧根键，bg 回落 '#0d0f12'、radius 回落 11
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  frame = await openUikit();
  assert.equal(await frame.locator('#field-uikit-bg').inputValue(), '#101010', '刷新后旧底色仍在（不回落默认）');
  assert.equal(await frame.locator('#field-uikit-radius').inputValue(), '5', '刷新后旧圆角仍在');
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#00ff00', '刷新后新编辑仍在');
  console.log('✓ 刷新后旧底色/旧圆角/新强调色全部保留');

  console.log('\n=== C. 另存为自定义方案：完整方案（含旧配色）落盘 ===');
  await frame.locator('#uikit-scheme-name').fill('验收方案');
  await frame.getByRole('button',{name:'另存主题',exact:true}).click();
  const saved = await waitConfig((c) => String(c.ui?.uikit?.mode || '').startsWith('custom:'), '另存为落盘');
  const id = saved.ui.uikit.mode.slice(7);
  const entry = saved.ui.uikit.custom[id];
  assert.equal(entry.name, '验收方案', '方案名落盘');
  assert.equal(entry.tokens.bg, '#101010', '自定义方案携带旧底色（另存不遗漏）');
  assert.equal(entry.tokens.accent, '#00ff00', '自定义方案携带编辑后的强调色');
  assert.equal(entry.tokens.radius, 5, '自定义方案携带布局');
  assert.equal(saved.ui.uikit.bg, undefined, '整体替换已清掉遗留根键');
  console.log(`✓ 已另存 custom:${id}，旧配色/布局全部随方案带走`);

  console.log('\n=== D. 刷新回读：方案与名字都在 ===');
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  frame = await openUikit();
  assert.equal(await frame.locator('#field-ui-uikit-mode').inputValue(), `custom:${id}`, '刷新后仍选中自定义方案');
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#00ff00', '刷新后方案配色回读正确');
  const head = await frame.locator('#field-ui-uikit-mode').evaluate(select=>select.selectedOptions[0]?.textContent||'');
  assert.match(head, /验收方案/, `方案选择显示当前名字（实际「${head}」）`);
  console.log(`✓ 刷新回读正确（${head.trim()}）`);

  console.log('\n=== E. 重命名自定义方案 ===');
  await frame.locator(`#uikit-rename-${id}`).fill('改名方案');
  await frame.locator('#section-uikit .settings-list-row button', { hasText: '重命名' }).click();
  await waitConfig((c) => c.ui?.uikit?.custom?.[id]?.name === '改名方案', '重命名落盘');
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  frame = await openUikit();
  assert.equal(await frame.locator(`#uikit-rename-${id}`).inputValue(), '改名方案', '刷新后新名字回读');
  console.log('✓ 重命名落盘且刷新回读一致');

  console.log('\n=== F. 切换到暗色基准：自定义方案互不干扰 ===');
  await frame.locator('#field-ui-uikit-mode').evaluate((el) => {
    el.value = 'dark';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitConfig((c) => c.ui?.uikit?.mode === 'dark', '切回暗色基准落盘');
  // 暗色槽是"已修改态"（旧配色折叠在此），不是出厂值——这正是方案模型的语义
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#00ff00', '暗色槽保留已修改态');
  assert.ok((await readConfig()).ui.uikit.custom[id], '切换不删自定义方案');
  console.log('✓ 切换到暗色基准，自定义方案仍在');

  console.log('\n=== G. 恢复当前预设出厂 ===');
  await charge(frame.getByRole('button', { name: '恢复当前预设出厂', exact: true }), 3);
  assert.equal(await frame.locator('dialog.confirm-panel').count(), 0, '方案重置以点击进度执行，不弹确认框');
  const reset = await waitConfig((c) => c.ui?.uikit?.dark == null, '恢复出厂落盘');
  assert.equal(reset.ui.uikit.custom[id]?.name, '改名方案', '恢复出厂不动自定义方案');
  await page.waitForTimeout(300);
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#d6e452', '即时回落荧光黄绿');
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  frame = await openUikit();
  assert.equal(await frame.locator('#field-uikit-accent').inputValue(), '#d6e452', '刷新后仍是出厂强调色');
  assert.equal(await frame.locator('#field-uikit-bg').inputValue(), '#191a19', '刷新后是出厂暖黑底');
  console.log('✓ 恢复出厂生效，刷新后仍为出厂基准');

  console.log('\n=== H. 删除自定义方案 ===');
  await charge(frame.locator('#section-uikit .settings-list-row').getByRole('button', { name: '删除', exact: true }), 2);
  const deleted = await waitConfig((c) => Object.keys(c.ui?.uikit?.custom ?? {}).length === 0, '删除落盘');
  assert.equal(deleted.ui.uikit.mode, 'dark', '删除当前外方案回落暗色基准');
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  frame = await openUikit();
  assert.equal(await frame.locator('#field-ui-uikit-mode').inputValue(), 'dark', '刷新后选中暗色基准');
  const restoreCount = await frame.locator('#section-uikit button', { hasText: '恢复当前预设出厂' }).count();
  assert.equal(restoreCount, 1, '恢复出厂按钮唯一（renderKit 反复重建不泄漏）');
  console.log('✓ 删除落盘，刷新后回到干净的基准态');

  console.log('\n=== I. 全程无未捕获异常 / 无内联报错 ===');
  assert.deepEqual(pageErrors, [], `页面无未捕获异常（实际 ${JSON.stringify(pageErrors)}）`);
  assert.equal(await frame.locator('#section-uikit .error').count(), 0, '组件库无内联报错');
  await page.screenshot({ path: path.join(outDir, 'uikit-73-final.png') });
  console.log('✓ 0 条异常');
} finally {
  await browser?.close().catch(() => {});
  await kernel.stop();
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-uikit73-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
  assertOffline(); assert.deepEqual(kernel.loader.listEntries(), []);
}
console.log('\n✓ 73 组件库方案持久化链路：全部通过');
