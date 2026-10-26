import {settingsSection,settingsSave} from './settings-navigation.mjs';
import {isSettingsSaveRequest, settingsSavePatch} from './settings-save-observation.mjs';
// Real minimum/default windows: every nested settings action remains reachable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { DEFAULT_THEME, PRESETS } from '../ui/panels/theme.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-uikit108-')), token = 'uikit108-console';
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
  outbound++; throw new Error('QA108 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA108 external DNS disabled'); };
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

const kernel = createKernel({
  appRoot, env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(dataDir, 'absent') }, headless: true,
  fetchImpl: async () => { outbound++; throw new Error('QA108 external traffic disabled'); },
  transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
});
kernel.loader.startWatchers = () => {};
kernel.config.update({ server: { port: 0, token }, telemetry: { enabled: false }, ui: { uikit: { mode: 'custom:qa108', custom: { qa108: { name: 'W'.repeat(40), tokens: { ...DEFAULT_THEME } } } } } });
let browser;
try {
  const port = await kernel.start(), base = `http://127.0.0.1:${port}`; ownedOrigins.add(base);
  assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);
  const playwright = createRequire(import.meta.url)('playwright-core');
  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(version => path.join(cache, version, 'chrome-win64/chrome.exe')).find(file => fs.existsSync(file));
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const errors = [];
  for (const size of [{ width: 960, height: 640 }, { width: 948, height: 635 }, { width: 1360, height: 860 }]) {
    const page = await browser.newPage({ viewport: size });page.on('pageerror', error => errors.push(error.message));
    await routeOwnedPage(page, base);
    await page.goto(`${base}/?token=${token}`);
    await page.locator('#nav button[data-panel=settings]').click();
    const frame = page.frameLocator('#panel-host iframe');
    await frame.locator('#settings-sidebar a[data-target=appearance]').waitFor();
    await settingsSection(frame,'uikit');
    const presets = frame.locator('#section-appearance .actions').filter({has:frame.locator('button.palette-choice')});
    await presets.scrollIntoViewIfNeeded();
    const layout = await presets.evaluate(row => {
      const doc = row.ownerDocument, width = doc.documentElement.clientWidth;
      const buttons = [...row.querySelectorAll('button.palette-choice')];
      return { width, pageOverflow: Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth) - width,
        labels: buttons.map(button => button.getAttribute('aria-label') || button.textContent),
        outside: buttons.filter(button => button.getBoundingClientRect().right > width + 1 || button.getBoundingClientRect().left < 0).map(button => button.textContent),
        rows: new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size,
        needsWrap:buttons.reduce((sum,button)=>sum+button.getBoundingClientRect().width,0)+Math.max(0,buttons.length-1)*Number.parseFloat(getComputedStyle(row).columnGap||'0')>row.getBoundingClientRect().width+1,
        otherOutside: [...doc.querySelectorAll('#section-appearance button, #uikit-scheme-name, [id^="uikit-rename-"]')].filter(node => node.checkVisibility() && node.getBoundingClientRect().right > width + 1).map(node => node.textContent || node.id),
      };
    });
    console.log(`· ${size.width}x${size.height} component-kit layout: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.labels, Object.values(PRESETS).map(preset => preset.label));
    assert.deepEqual(layout.outside, [], 'all eight presets fit horizontally instead of being clipped by the iframe');
    assert.deepEqual(layout.otherOutside, [], 'save-as and rename controls also fit the available width');
    assert.equal(layout.pageOverflow, 0);
    if(layout.needsWrap) assert.ok(layout.rows >= 2, 'the preset row wraps whenever its controls do not fit on one line');
    const gallery=frame.locator('.component-preview');
    assert.equal(await gallery.count(),1,'each component-kit rebuild has one local preview gallery');
    const galleryLayout=await gallery.evaluate(gallery=>{
      const doc=gallery.ownerDocument,width=doc.documentElement.clientWidth;
      return [...gallery.querySelectorAll('button,input,select,.qq-icon')].filter(node=>{
        const r=node.getBoundingClientRect();return r.width>0&&(r.right>width+1||r.left<0);
      }).map(node=>node.textContent||node.tagName);
    });
    assert.deepEqual(galleryLayout,[],'preview controls and theme icons fit the same narrow component-kit surface');
    for (const preset of Object.values(PRESETS)) {
      await presets.getByRole('button', { name: preset.label, exact: true }).click();
      assert.equal(await frame.locator('#field-uikit-accent').inputValue(), preset.tokens.accent);
      await frame.locator(`.palette-choice[data-palette="${Object.keys(PRESETS).find(key=>PRESETS[key]===preset)}"][aria-pressed=true]`).waitFor();
      assert.equal(await frame.locator('body').evaluate(body => Math.max(body.scrollWidth, body.ownerDocument.documentElement.scrollWidth) - body.ownerDocument.documentElement.clientWidth), 0, `${preset.label} also fits after its visual style is applied`);
    }
    await frame.locator('[data-appearance-group=themes] > summary').click();await frame.locator('#uikit-scheme-name').fill(`108-${size.width}`);
    await frame.getByRole('button', { name: '另存主题', exact: true }).click();
    await frame.locator('#section-appearance .settings-list-row').filter({hasText:`108-${size.width}`}).waitFor();
    const scheme = frame.locator('#section-appearance .settings-list-row').filter({ hasText: `108-${size.width}` });
    await scheme.locator('input[id^="uikit-rename-"]').fill(`108-${size.width}-renamed`);
    // Capture the renamed scheme's save before its autosave timer can complete.
    const saved = page.waitForResponse(response => {
      if (!isSettingsSaveRequest(response.request())) return false;
      const patch = settingsSavePatch(response.request())?.ui?.uikit;
      return Object.values((patch?.__replace__ ?? patch)?.custom ?? {}).some(scheme => scheme.name === `108-${size.width}-renamed`);
    });
    saved.catch(()=>{});await scheme.getByRole('button', { name: '重命名', exact: true }).click();
    
    assert.equal(await frame.locator('#section-appearance .settings-list-row').filter({ hasText: `108-${size.width}-renamed` }).count(), 1);
    await settingsSave(frame);
    const saveResponse = await saved;
    assert.equal(saveResponse.status(), 200, 'the exact renamed scheme save succeeds');
    assert.equal(await saveResponse.finished(), null, 'the actual save response is fully received before reading persisted config');
    
    const response = await fetch(`${base}/api/config`, { headers: { 'x-console-token': token } });
    const config = await response.json();
    assert.ok(Object.values(config.ui.uikit.custom).some(scheme => scheme.name === `108-${size.width}-renamed`));
    assert.ok(Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).ui.uikit.custom).some(scheme => scheme.name === `108-${size.width}-renamed`), 'the renamed scheme is also present in actual persisted config');
    assert.equal(await frame.locator('body').evaluate(body => Math.max(body.scrollWidth, body.ownerDocument.documentElement.scrollWidth) - body.ownerDocument.documentElement.clientWidth), 0, 'adding and renaming schemes does not reintroduce horizontal overflow');
    fs.mkdirSync(path.resolve('.shots'), { recursive: true });
    await presets.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve('.shots', `uikit-108-${size.width}.png`) });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('✓ 108 All eight color presets, narrow action rows, save-as and rename passed');
} finally {
  await browser?.close();await kernel.stop();
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-uikit108-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
  assertOffline(); assert.deepEqual(kernel.loader.listEntries(), []);
}
