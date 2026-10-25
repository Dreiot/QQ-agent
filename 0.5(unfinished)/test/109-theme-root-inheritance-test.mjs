import {settingsSection,settingsSave} from './settings-navigation.mjs';
import {isSettingsSaveRequest, settingsSavePatch} from './settings-save-observation.mjs';
// Real shell/opaque iframe computed paint, including custom and built-in modes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { isolateConsoleFixture } from './console-fixture-isolation.mjs';
import { DEFAULT_THEME, DARK_BASE, PRESETS, resolveScheme } from '../ui/panels/theme.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-theme109-')), token = 'theme109-console';
const isolation = isolateConsoleFixture(dataDir, '109');
const bright = { ...DEFAULT_THEME, ...PRESETS.light.tokens, styleMode: 'flux' };
const dark = { ...DEFAULT_THEME, ...DARK_BASE, accent: '#ad8ae6', line: '#37383a', styleMode: 'classic' };
const uikit = { mode: 'custom:bright', custom: { bright: { name: '明亮方案', tokens: bright }, dark: { name: '暗色方案', tokens: dark } } };
const kernel = createKernel({
  appRoot: isolation.appRoot, env: isolation.env, headless: true,
  transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
});
kernel.config.update({ server: { port: 0, token }, telemetry: { enabled: false }, proactive: {enabled:false}, ui: { uikit } });
kernel.loader.startWatchers=()=>{};
const colorKeys = ['--bg', '--canvas', '--rail', '--surface', '--surface-2', '--surface-3', '--overlay', '--line', '--line-soft', '--line-strong', '--text', '--muted', '--faint', '--accent', '--accent-ink', '--good', '--warn', '--bad', '--focus'];
function inspect(body, expected) {
  const doc = body.ownerDocument, root = doc.documentElement, rootStyle = getComputedStyle(root), bodyStyle = getComputedStyle(body);
  const reference = doc.createElement('span');reference.style.setProperty('transition', 'none', 'important');body.append(reference);
  const color = value => { reference.style.color = value;return getComputedStyle(reference).color; };
  const canvas = doc.createElement('canvas');canvas.width=canvas.height=1;
  const ctx = canvas.getContext('2d');
  const rgba = value => { ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]; };
  const nodeColor = selector => { const node = doc.querySelector(selector);return node ? getComputedStyle(node).color : null; };
  const card = doc.querySelector('.settings-section:not([hidden])');
  const primary = doc.querySelector('#save');
  const icon = doc.querySelector('#nav button.active .qq-icon') || doc.querySelector('.component-preview-icons .qq-icon');
  const result = {
    root: Object.fromEntries(expected.keys.map(key => [key, rootStyle.getPropertyValue(key).trim()])),
    body: Object.fromEntries(expected.keys.map(key => [key, bodyStyle.getPropertyValue(key).trim()])),
    bg: bodyStyle.backgroundColor, ink: bodyStyle.color, expectedBg: color(expected.scheme.bg), expectedInk: color(expected.scheme.text),
    styleMode: body.dataset.styleMode, light: body.classList.contains('theme-light'), colorScheme: bodyStyle.colorScheme,
    readinessInk: nodeColor('.readiness-name'), readinessBg: doc.querySelector('.rail') ? getComputedStyle(doc.querySelector('.rail')).backgroundColor : null, runtimeInk: nodeColor('#runtime-state'),
    cardPaint: card ? getComputedStyle(card).backgroundColor : null,
    cardRgba:card?rgba(getComputedStyle(card).backgroundColor):null,
    surfaceRgba:rgba(expected.scheme.surface),
    cardLine: card ? getComputedStyle(card).borderTopColor : null,
    cardLineWidth:card?Number.parseFloat(getComputedStyle(card).borderTopWidth):null,
    primaryPaint: primary ? getComputedStyle(primary).backgroundColor : null,
    expectedPrimaryPaint:color(expected.scheme.accent),
    iconColor:icon?getComputedStyle(icon).color:null,
    expectedIconColor:color(expected.scheme.accent),
    safeIcon:!!icon&&!icon.querySelector('script,img,foreignObject,[onload],[onerror]'),
  };
  reference.remove();return result;
}
function contrast(fg, bg) {
  const luminance = css => {
    const channels = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255;return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(fg), luminance(bg)].sort((a, b) => b - a);return (values[0] + 0.05) / (values[1] + 0.05);
}
let browser;
try {
  const port = await kernel.start();
  isolation.allowOrigin(`http://127.0.0.1:${port}`);isolation.assertEmpty(kernel);
  const playwright = createRequire(import.meta.url)('playwright-core');
  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(version => path.join(cache, version, 'chrome-win64/chrome.exe')).find(file => fs.existsSync(file));
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } }), errors = [];
  await isolation.bindPage(page, `http://127.0.0.1:${port}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await page.locator('#nav button[data-panel=settings]').click();
  const frame = page.frameLocator('#panel-host iframe');
  await frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
  await settingsSection(frame,'interface');
  for (const mode of ['custom:bright', 'custom:dark', 'light', 'dark', 'custom:bright']) {
    // Catch immediately: a paint/assertion failure closes the page in finally,
    // and its pending response waiter must not hide that original failure.
    const savedResponse = page.waitForResponse(response => isSettingsSaveRequest(response.request()) && settingsSavePatch(response.request())?.ui?.uikit?.mode === mode).then(response => ({ response }), error => ({ error }));
    await frame.locator('#field-ui-uikit-mode').selectOption(mode);
    await frame.locator('#field-ui-uikit-mode').hover();
    const scheme = resolveScheme({ ...uikit, mode }), expected = { scheme, keys: colorKeys };
    await page.waitForFunction(bg => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === bg, scheme.bg);
    for (let i = 0; i < 100 && await frame.locator('html').evaluate(root => getComputedStyle(root).getPropertyValue('--bg').trim()) !== scheme.bg; i++) await page.waitForTimeout(10);
    const shell = await page.locator('body').evaluate(inspect, expected), panel = await frame.locator('body').evaluate(inspect, expected);
    console.log(`· ${mode}: root/body bg ${shell.root['--bg']}/${shell.body['--bg']}, actual shell ${shell.bg}, panel card ${panel.cardPaint}`);
    for (const state of [shell, panel]) {
      for (const key of colorKeys) assert.equal(state.body[key], state.root[key], `${mode}: ${key} inherits the applied root theme`);
      assert.equal(state.ink, state.expectedInk, `${mode}: real text uses the supplied foreground`);
      assert.equal(state.styleMode, scheme.styleMode);
      assert.equal(state.colorScheme, /bright|light/.test(mode) ? 'light' : 'dark');
    }
    assert.equal(shell.bg, shell.expectedBg, `${mode}: actual shell canvas uses the chosen bg`);
    assert.equal(panel.bg, 'rgba(0, 0, 0, 0)', 'the iframe remains transparent so the shell owns the shared background');
    assert.ok(panel.cardRgba[3]>0, `${mode}: card surface remains visible`);
    panel.surfaceRgba.slice(0,3).forEach((channel,i)=>assert.ok(Math.abs(panel.cardRgba[i]-channel)<=1, `${mode}: actual card inherits supplied surface channels without fixing decoration opacity`));
    assert.ok(panel.cardLineWidth>0, `${mode}: card retains a visible section boundary`);
    assert.equal(panel.primaryPaint, panel.expectedPrimaryPaint, `${mode}: actual button uses the selected accent`);
    for(const state of [shell,panel]) {
      assert.equal(state.iconColor,state.expectedIconColor,`${mode}: vector/masked icon inherits user accent`);
      assert.ok(state.safeIcon,`${mode}: generated/shared icon contains no executable metadata`);
    }
    // Readiness labels now live in the rail; inspect their actual painted background.
    assert.ok(shell.readinessInk && shell.readinessBg, `${mode}: current readiness label and rail are present`);
    assert.ok(contrast(shell.readinessInk, shell.readinessBg) >= 4.5, `${mode}: readiness label remains readable`);
    assert.ok(contrast(shell.runtimeInk, shell.bg) >= 4.5, `${mode}: global runtime label remains readable`);
    await settingsSave(frame);
    const saved = await savedResponse;
    if (saved.error) throw saved.error;
    assert.equal(saved.response.status(), 200, `${mode}: chosen scheme receives a real successful save response`);
    await frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
    assert.equal(kernel.config.get().ui.uikit.mode, mode);
  }
  console.log('· A newly mounted opaque panel receives the saved theme through its ready handshake');
  const currentScheme=resolveScheme(kernel.config.get().ui.uikit);
  await page.locator('#nav button[data-panel=usage]').click();
  await frame.locator('#metrics .metric').first().waitFor();
  await page.locator('#nav button[data-panel=settings]').click();
  await frame.locator('#status').filter({hasText:'配置已读取'}).waitFor();
  const remounted=await frame.locator('body').evaluate(body=>{
    const root=body.ownerDocument.documentElement;
    return {root:getComputedStyle(root).getPropertyValue('--bg').trim(),body:getComputedStyle(body).getPropertyValue('--bg').trim()};
  });
  assert.deepEqual(remounted,{root:currentScheme.bg,body:currentScheme.bg},'新iframe就绪后继承真实保存方案，无需访问宿主DOM/存储');
  assert.deepEqual(errors, []);
  console.log('✓ 109 Actual shell/iframe token inheritance, custom bright/dark and built-in light/dark passed');
} finally {
  await browser?.close();await kernel.stop();isolation.assertEmpty(kernel);isolation.restore();assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('qqa-theme109-'));fs.rmSync(dataDir, { recursive: true, force: true });
}
