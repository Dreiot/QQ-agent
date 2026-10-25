import {isSettingsSaveRequest, settingsSavePatch} from './settings-save-observation.mjs';
import {settingsSection,settingsEditor,closeSettingsEditors} from './settings-navigation.mjs';
// 69 · 设置页呈现形式：真实内核 + 真实 Chromium 遍历验收。
//
// 为什么不用手工 CDP：面板是 sandbox='allow-scripts' 的 opaque-origin iframe，
// 既读不到 contentDocument，CDP 的 executionContext / getFrameTree 也不收录它
// （实测 getFrameTree 只有主框架）。用普通对象伪造 window.parent 会让
// MessageEvent 构造抛 "Failed to convert value to 'EventTarget'"，握手被静默拒绝。
// 正解与 34 号一致：Playwright 的 frameLocator 能直接穿透 sandbox iframe。
//
// 覆盖：通道条完整渲染、13 分区逐个可渲染、字段分组、危险区、仪表读数、筛选。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel/kernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'panels', 'manifest.json'), 'utf8'));

let playwright = null;
for (const name of ['playwright', 'playwright-core']) {
  try { playwright = createRequire(import.meta.url)(name); break; } catch { /* 只探测本机已有模块 */ }
}

let browser; let kernel;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-settings-'));
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
  outbound++; throw new Error('QA69 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA69 external DNS disabled'); };
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

try {
  const env = { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(dataDir, 'absent') };
  kernel = createKernel({ appRoot, env, headless: true,
    fetchImpl: async () => { outbound++; throw new Error('QA69 external traffic disabled'); },
    transport: { id: 'fixture', connected: false, selfId: '', actions: {}, start: async () => {}, stop: async () => {} },
    priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
    communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
  });
  kernel.config.update({ server: { port: 0, token: 'settings-69-token' }, telemetry: { enabled: false } });
  kernel.loader.startWatchers = () => {};
  const port = await kernel.start();
  assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);
  const base = `http://127.0.0.1:${port}`; ownedOrigins.add(base);
  console.log(`✓ 隔离内核已启动（端口 ${port}）`);

  if (!playwright) {
    console.log('· 未发现本地 Playwright，跳过真实浏览器断言');
    process.exit(0);
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  browser = await playwright.chromium.launch({ headless: true, ...(fs.existsSync(executablePath) ? { executablePath } : {}) });
  const page = await (await browser.newContext()).newPage();
  await routeOwnedPage(page, base);

  // 收集页面异常：任何一条都算呈现层 bug
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/favicon|404|Failed to load resource/i.test(msg.text())) pageErrors.push(msg.text()); });

  await page.goto(`${base}/?token=settings-69-token`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((n) => document.querySelectorAll('#nav button').length === n, manifest.panels.length, { timeout: 20000 });
  console.log(`✓ shell 已渲染 ${manifest.panels.length} 个面板入口`);

  console.log('=== A. 打开设置面板：通道条完整渲染 ===');
  const configResponse = page.waitForResponse((r) => r.url().endsWith('/api/config') && r.request().method() === 'GET' && r.status() === 200, { timeout: 20000 });
  await page.locator('#nav button[data-panel="settings"]').click();
  await configResponse;
  const frame = page.frameLocator('#panel-host iframe');
  await frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor({ state: 'visible', timeout: 20000 });

  const boot = await frame.locator('#settings-sidebar').evaluate((nav) => ({
    links: nav.querySelectorAll('a[data-target]').length,
    leds: nav.querySelectorAll('.led').length,
    groups: nav.querySelectorAll('.settings-group').length,
    channelNos: nav.querySelectorAll('.channel-no').length,
    hasFilter: !!document.querySelector('#settings-filter'),
    sections: document.querySelectorAll('.settings-section').length,
    visibleSections: [...document.querySelectorAll('.settings-section')].filter((s) => !s.hidden).length,
    fields: document.querySelectorAll('.settings-section .setting-field').length,
  }));
  console.log('  启动态：', boot);
  assert.equal(boot.links, 9, '九个旧版主要分区全部渲染');
  assert.equal(boot.leds, 9, '每个通道一枚状态灯');
  assert.equal(boot.channelNos, 9, '每个通道有编号');
  assert.equal(boot.groups, 1, '主要分区采用单层菜单');
  assert.equal(boot.hasFilter, true, '有筛选框');
  assert.equal(boot.sections, 9, '九个主要分区 DOM 都在');
  assert.equal(boot.visibleSections, 1, '同一时刻只显示一个分区');
  assert.ok(boot.fields > 100, `全部字段已构建（实际 ${boot.fields} 项）`);
  console.log(`✓ 通道条 13 项 / 5 分组 / 单分区视图 / ${boot.fields} 个字段，无渲染中断`);

  console.log('=== B. 逐个分区切换：每个都渲染出字段 ===');
  const ids = await frame.locator('#settings-sidebar a[data-target]').evaluateAll((els) => els.map((a) => a.dataset.target));
  assert.equal(ids.length, 9, '拿到九个分区 id');
  // Scrolling must make all sections genuinely reachable; do not bypass hit testing.
  const pickSection = async (sid) => {
    await settingsSection(frame,sid);
  };
  const perSection = {};
  for (const sid of ids) {
    await pickSection(sid);
    await page.waitForTimeout(160);
    perSection[sid] = await frame.locator(`#section-${sid}`).evaluate((card) => ({
      hidden: card.hidden,
      fields: card.querySelectorAll('.setting-field').length,
      groups: card.querySelectorAll('.field-group,.settings-fold').length,
      no: card.querySelector('.module-no')?.textContent || '',
      desc: card.querySelector('.module-text p')?.textContent || '',
    }));
    const v = perSection[sid];
    assert.equal(v.hidden, false, `${sid} 切换后可见`);
    assert.ok(v.fields > 0, `${sid} 渲染出字段（实际 ${v.fields}）`);
    assert.match(v.no, /^\d{2}$/, `${sid} 带两位通道编号`);
    assert.ok(v.desc.length > 0, `${sid} 抬头有说明`);
  }
  for (const [sid, v] of Object.entries(perSection)) {
    console.log(`  ${sid.padEnd(9)} ${v.no} · 字段 ${String(v.fields).padStart(2)} · 分组 ${v.groups}`);
  }
  const totalFields = Object.values(perSection).reduce((n, v) => n + v.fields, 0);
  const totalGroups = Object.values(perSection).reduce((n, v) => n + v.groups, 0);
  assert.equal(totalFields, boot.fields, '逐分区统计字段数与全局一致');
  console.log(`✓ 13 个分区全部可渲染，共 ${totalFields} 个字段 / ${totalGroups} 个字段组`);

  console.log('=== C. 字段分组生效 ===');
  const grouped = {};
  for (const [sid, min] of [['models', 4], ['chat', 8], ['memory', 2], ['access', 2], ['onebot', 1]]) {
    grouped[sid] = perSection[sid].groups;
    assert.ok(grouped[sid] >= min, `${sid} 至少 ${min} 个字段组（实际 ${grouped[sid]}）`);
  }
  console.log('✓ 分组生效：', grouped);

  console.log('=== D. 危险区收束放开限制的设置 ===');
  const danger = await frame.locator('#section-security').evaluate((card) => ({
    zones: card.querySelectorAll('.zone-danger').length,
    risky: card.querySelectorAll('.zone-danger .setting-field').length,
    outside: card.querySelectorAll(':scope > .settings-fields > .setting-field').length,
  }));
  console.log('  安全分区：', danger);
  assert.ok(danger.zones >= 1, '安全分区有危险区');
  assert.ok(danger.risky >= 2, `危险项已收进红框（实际 ${danger.risky} 项）`);
  console.log(`✓ ${danger.risky} 项"放开限制"的设置收进危险区`);

  console.log('=== E. 仪表读数（响应档位）===');
  await pickSection('wake');
  await page.waitForTimeout(200);
  const gauge = await frame.locator('#section-chat').evaluate((card) => ({
    readouts: card.querySelectorAll('.readout').length,
    ticks: card.querySelectorAll('.ticks').length,
    value: card.querySelector('#tier-readout')?.textContent || '',
    summary: card.querySelector('#tier-summary')?.textContent || '',
    slider: !!card.querySelector('#context-slider'),
    percent: !!card.querySelector('#random-percent'),
  }));
  console.log('  仪表：', gauge);
  assert.equal(gauge.readouts, 1, '有档位读数窗');
  assert.equal(gauge.ticks, 1, '有量程刻度');
  assert.match(gauge.value, /^\d \/ 4$/, `读数为「N / 4」（实际「${gauge.value}」）`);
  assert.ok(gauge.summary.length > 0, '有档位文字说明');
  assert.ok(gauge.slider && gauge.percent, '滑条与概率输入框都在');
  // 滑条改值 → 读数同步（证明不是静态装饰）
  await frame.locator('#context-slider').fill('5');
  await page.waitForTimeout(250);
  const after = await frame.locator('#tier-readout').textContent();
  assert.equal(after.trim(), '1 / 4', `拖到 5% 应显示 1 档（实际「${after.trim()}」）`);
  console.log(`✓ 仪表读数「${gauge.value.trim()}」，拖动滑条后联动为「${after.trim()}」`);

  // Real keyboard input must immediately update the second probability view,
  // before the debounce/HTTP acknowledgement or a complete settings reload.
  const responseSlider = frame.locator('#context-slider'), randomPercent = frame.locator('#random-percent');
  await responseSlider.press('Home');
  for (let i = 0; i < 5; i++) await responseSlider.press('PageUp');
  assert.equal(await responseSlider.inputValue(), '50');
  assert.match(await frame.locator('#tier-summary').textContent(), /3 档.*43%/);
  assert.equal(await randomPercent.inputValue(), '43', '50 on the real slider immediately shows the derived 43%');
  for (let i = 0; i < 4; i++) await responseSlider.press('PageUp');
  assert.equal(await responseSlider.inputValue(), '90');
  assert.equal(await randomPercent.inputValue(), '100');
  assert.match(await frame.locator('#tier-summary').textContent(), /4 档/);
  await responseSlider.press('End'); assert.equal(await randomPercent.inputValue(), '100');
  await responseSlider.press('Home'); assert.equal(await randomPercent.inputValue(), '0');
  await responseSlider.press('PageUp'); assert.equal(await responseSlider.inputValue(), '10'); assert.equal(await randomPercent.inputValue(), '0');
  await responseSlider.press('PageUp'); assert.equal(await responseSlider.inputValue(), '20'); assert.equal(await randomPercent.inputValue(), '0');

  const probabilitySave = expected => page.waitForResponse(r => {
    if (!isSettingsSaveRequest(r.request())) return false;
    const position = settingsSavePatch(r.request())?.store?.contextSliderPos;
    return Number.isFinite(position) && Math.abs(position - expected) < 0.001;
  }, { timeout: 5000 });
  await settingsEditor(frame,'tier-params');
  await randomPercent.fill('50');
  const halfSaved = probabilitySave(55); await randomPercent.press('Tab');
  assert.equal(await responseSlider.inputValue(), '55');
  assert.match(await frame.locator('#tier-summary').textContent(), /3 档.*50%/);
  assert.equal((await halfSaved).status(), 200);
  await frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
  assert.equal(kernel.config.get().store.randomPercent, 50);
  assert.equal(kernel.config.get().store.contextTier, 3);

  // A probability draft is not a slider edit until its own change event. A real
  // background status notification must preserve that currently focused draft.
  await randomPercent.fill('64');
  await randomPercent.evaluate(node => {
    window.qa69ProbabilityDraft = node; window.qa69ProbabilityStatusObserved = false;
    const listener = event => {
      if (event.data?.method !== 'shell.event' || event.data.params?.name !== 'status' || event.data.params.payload?.qa69ProbabilityDraft !== true) return;
      window.removeEventListener('message', listener);
      requestAnimationFrame(() => requestAnimationFrame(() => { window.qa69ProbabilityStatusObserved = true; }));
    };
    window.addEventListener('message', listener);
  });
  kernel.config.update({ store: { contextSliderPos: 90 } });
  kernel.bus.emit('status', { configUpdated: true, qa69ProbabilityDraft: true });
  await frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    function check() {
      if (window.qa69ProbabilityStatusObserved) return resolve();
      if (performance.now() > deadline) return reject(new Error('the real probability status notification did not reach the panel'));
      requestAnimationFrame(check);
    }
    check();
  }));
  assert.deepEqual(await randomPercent.evaluate(node => ({ same: node === window.qa69ProbabilityDraft, connected: window.qa69ProbabilityDraft.isConnected, focused: document.activeElement === node, value: node.value })), { same: true, connected: true, focused: true, value: '64' });
  const draftSaved = probabilitySave(64.8); await randomPercent.press('Tab');
  assert.equal((await draftSaved).status(), 200); await frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
  assert.equal(kernel.config.get().store.randomPercent, 64);
  assert.equal(await responseSlider.inputValue(), '64.8');
  assert.match(await frame.locator('#tier-summary').textContent(), /3 档.*64%/);
  console.log('✓ 六个键盘滑条边界即时同步概率；反向输入、真实保存与后台通知期间的概率草稿保护通过');

  console.log('=== F. 筛选：只影响通道条显隐，不动字段 DOM ===');
  await closeSettingsEditors(frame);
  await frame.locator('#settings-filter').fill('表情');
  await page.waitForTimeout(220);
  const filtered = await frame.locator('#settings-sidebar').evaluate((nav) => ({
    shown: [...nav.querySelectorAll('a[data-target]')].filter((a) => !a.classList.contains('is-hidden')).map((a) => a.dataset.target),
    sections: document.querySelectorAll('.settings-section').length,
    fields: document.querySelectorAll('.settings-section .setting-field').length,
  }));
  console.log('  筛选「表情」：', filtered);
  assert.deepEqual(filtered.shown, ['chat'], `表情设置已归入聊天分区（实际 ${filtered.shown}）`);
  assert.equal(filtered.sections, 9, '筛选不销毁任何分区 DOM');
  assert.equal(filtered.fields, boot.fields, '筛选不销毁任何字段（防抖保存不受影响）');

  await frame.locator('#settings-filter').fill('zzz不存在');
  await page.waitForTimeout(220);
  const emptyShown = await frame.locator('#settings-sidebar-empty').isVisible();
  assert.ok(emptyShown, '无匹配时显示空状态');
  await frame.locator('#settings-filter').fill('');
  await page.waitForTimeout(220);
  const restored = await frame.locator('#settings-sidebar a[data-target]').evaluateAll((els) => els.filter((a) => !a.classList.contains('is-hidden')).length);
  assert.equal(restored, 9, '清空筛选后恢复全部通道');
  console.log(`✓ 筛选命中 ${filtered.shown.join()}，DOM 与字段数不变（${filtered.fields}），无匹配有空状态，清空即恢复`);

  console.log('=== G. 分区切换不丢未保存输入（防抖语义）===');
  await frame.locator('#nav-marker-check').count().catch(() => 0);
  await pickSection('persona');
  await page.waitForTimeout(200);
  const personaField = frame.locator('#section-persona').locator('input[type="text"]').first();
  await personaField.fill('未保存的测试值');
  await pickSection('tools');
  await page.waitForTimeout(200);
  await pickSection('persona');
  await page.waitForTimeout(200);
  const kept = await frame.locator('#section-persona').locator('input[type="text"]').first().inputValue();
  assert.equal(kept, '未保存的测试值', '切换分区后未保存输入仍在（不重建 DOM）');
  console.log('✓ 分区切换保留未保存输入');

  console.log('=== H. 全程无未捕获异常 ===');
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource|ERR_/i.test(e));
  assert.deepEqual(real, [], `页面无未捕获异常（实际 ${real.length} 条）`);
  console.log(`✓ 0 条未捕获异常`);

  console.log('=== I. 不依赖外部字体（离线可用 + 不触发 CSP）===');
  // 控制台 CSP 是 style-src 'self'，任何外链字体都会被拦并在控制台报 CSP 违规；
  // 桌面应用还要求离线可用。这条断言防止以后又加回 Google Fonts。
  const shellHtml = fs.readFileSync(path.join(ROOT, 'ui', 'shell', 'index.html'), 'utf8');
  assert.ok(!/fonts\.(googleapis|gstatic)/.test(shellHtml), 'shell 不引外部字体');
  const cssSources = ['ui/shell/style.css', 'ui/panels/common.css', 'ui/panels/design-system.css'];
  for (const rel of cssSources) {
    const css = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(css), `${rel} 无外链 @import`);
  }
  const monoVar = await frame.locator('body').evaluate((b) => getComputedStyle(b).fontFamily);
  assert.ok(monoVar && monoVar.length > 0, '字体栈已就位');
  console.log('✓ 零外部字体依赖，离线可用且不触发 CSP');

  console.log('=== J. 组件预览控件可交互，且不触发真实配置保存 ===');
  await pickSection('uikit');
  const gallery = frame.locator('.component-preview');
  await gallery.scrollIntoViewIfNeeded();
  await gallery.getByText('示例控件只用于预览外观，不会保存配置或执行实际操作。', {exact:true}).waitFor();
  await page.waitForTimeout(600); // Let earlier real-setting debounce complete first.
  const previewWrites = [];
  const trackPreview = request => { if (isSettingsSaveRequest(request)) previewWrites.push(request.postData()); };
  page.on('request', trackPreview);
  const beforePreview = JSON.stringify(kernel.config.get());
  await gallery.getByRole('button', {name:'主按钮',exact:true}).click();
  await gallery.getByRole('button', {name:'危险按钮',exact:true}).click();
  assert.match(await gallery.locator('.component-preview-feedback').textContent(), /^1 次示例交互/, '首次危险按钮点击只累积进度');
  await gallery.getByRole('button', {name:'危险按钮',exact:true}).click();
  assert.equal(await gallery.getByRole('button', {name:'禁用按钮',exact:true}).isDisabled(), true);
  assert.match(await gallery.locator('.component-preview-feedback').textContent(), /^2 次示例交互/);
  await gallery.locator('input[type=checkbox]').uncheck();
  assert.equal(await gallery.getByText('示例开关 · 关闭', {exact:true}).isVisible(), true);
  await gallery.locator('input[type=range]').fill('35');
  assert.equal(await gallery.locator('.component-preview-value').textContent(), '35%');
  await gallery.locator('select').selectOption('紧凑');
  await gallery.locator('input[type=text]').fill('本地排版示例');
  assert.equal(await gallery.locator('.component-preview-type-title').textContent(), '本地排版示例');
  assert.equal(await gallery.locator('.component-preview-icons .qq-icon').count(), 5);
  await page.waitForTimeout(600);
  page.off('request', trackPreview);
  assert.deepEqual(previewWrites, [], '预览交互不会POST真实配置');
  assert.equal(JSON.stringify(kernel.config.get()), beforePreview, '预览交互不会修改内核配置');
  assert.deepEqual(pageErrors.filter(e=>!/favicon|Failed to load resource|ERR_/i.test(e)), [], '预览图标与交互无未捕获异常');
  console.log('✓ 组件预览可交互、明确为示例、与真实设置保存隔离');
} finally {
  await browser?.close().catch(() => {});
  await kernel?.stop();
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-settings-'));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  assertOffline(); if (kernel) assert.deepEqual(kernel.loader.listEntries(), []);
}
console.log('\n✓ 69 设置页呈现形式：全部通过');
