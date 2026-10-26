import {settingsSection,settingsSave} from './settings-navigation.mjs';
import {isSettingsSaveRequest, settingsSavePatch, SETTINGS_SAVE_ROUTE} from './settings-save-observation.mjs';
// Real background modules/CSS, decoded pixels, config disk replay and a final
// production-kernel settings/upload check. All data and browsers are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createConfig, buildDefaultConfig } from '../src/kernel/config.js';
import { createKernel } from '../src/kernel/kernel.js';

const root = path.resolve(import.meta.dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-fit115-'));
const log = { info() {}, warn() {}, error() {} };
let config = createConfig({ dataDir, defaults: buildDefaultConfig(), log }); config.load();
let w=800,h=450;
const imageUrl = '/ui/backgrounds/pattern.png', iw = 320, ih = 240;
const raw = Buffer.alloc((iw * 3 + 1) * ih), colors = [[210, 45, 65], [35, 190, 90], [45, 90, 215], [240, 205, 40]];
for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
  let color = colors[(y >= ih / 2 ? 2 : 0) + (x >= iw / 2 ? 1 : 0)];
  if (x % 40 < 2 || y % 40 < 2) color = [15, 15, 15];
  if (Math.abs(x - iw / 2) < 2 || Math.abs(y - ih / 2) < 2) color = [255, 255, 255];
  const i = y * (iw * 3 + 1) + 1 + x * 3; color.forEach((v, c) => { raw[i + c] = v; });
}
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const type = Buffer.from(name), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8); return out; }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(iw); ihdr.writeUInt32BE(ih, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
config.update({ telemetry: { enabled: false }, proactive: { enabled: false }, ui: { uikit: { mode: 'dark', dark: { bgImage: imageUrl, bgFit: 'repeat', bgOpacity: 1, bgBlur: 0, bgZoom: 1, bgRotate: 0, bgOffsetX: 0, bgOffsetY: 0 } } } });
const files = {
  '/panels/theme.js': ['ui/panels/theme.js', 'text/javascript'],
  '/panels/background-media.js': ['ui/panels/background-media.js', 'text/javascript'],
  '/panels/account-scope.js': ['ui/panels/account-scope.js', 'text/javascript'],
  '/panels/visual-style.js': ['ui/panels/visual-style.js', 'text/javascript'],
  '/panels/motion.js': ['ui/panels/motion.js', 'text/javascript'],
  '/panels/press-feedback.js': ['ui/panels/press-feedback.js', 'text/javascript'],
  '/panels/settings/bg-editor.js': ['ui/panels/settings/bg-editor.js', 'text/javascript'],
  '/panels/destructive-action.js': ['ui/panels/destructive-action.js', 'text/javascript'],
  '/panels/destructive-layout.js': ['ui/panels/destructive-layout.js', 'text/javascript'],
  '/panels/destructive-motion.js': ['ui/panels/destructive-motion.js', 'text/javascript'],
  '/panels/destructive-snapshot.js': ['ui/panels/destructive-snapshot.js', 'text/javascript'],
  '/panels/vendor/gsap-3.13.0.min.js': ['ui/panels/vendor/gsap-3.13.0.min.js', 'text/javascript'],
  '/panels/vendor/gsap-runtime.js': ['ui/panels/vendor/gsap-runtime.js', 'text/javascript'],
  '/common.css': ['ui/panels/common.css', 'text/css'], '/shell.css': ['ui/shell/style.css', 'text/css'],
  '/design-system.css': ['ui/panels/design-system.css', 'text/css'],
  '/panels/design-system.css': ['ui/panels/design-system.css', 'text/css'],
  '/icon-motion.css': ['ui/panels/icon-motion.css', 'text/css'],
  '/press-feedback.css': ['ui/panels/press-feedback.css', 'text/css'],
  '/extension-updates.css': ['ui/panels/extension-updates.css', 'text/css'],
  '/panels/press-feedback.css': ['ui/panels/press-feedback.css', 'text/css'],
  '/panels/extension-updates.css': ['ui/panels/extension-updates.css', 'text/css'],
  '/destructive-action.css': ['ui/panels/destructive-action.css', 'text/css'],
  '/panels/icon-motion.css': ['ui/panels/icon-motion.css', 'text/css'],
  '/panels/destructive-action.css': ['ui/panels/destructive-action.css', 'text/css'],
  '/assets/endfield/archive.png': ['ui/panels/assets/endfield/archive.png', 'image/png'],
  '/assets/endfield/emblem.png': ['ui/panels/assets/endfield/emblem.png', 'image/png'],
  '/panels/assets/endfield/archive.png': ['ui/panels/assets/endfield/archive.png', 'image/png'],
  '/panels/assets/endfield/emblem.png': ['ui/panels/assets/endfield/emblem.png', 'image/png'],
};
const editorHtml = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/common.css"><style>.bg-editor{display:block}.bg-stage{width:800px;height:450px;border:0;border-radius:0}</style><div id="mount"></div><script type="module">import{createBackgroundEditor}from'/panels/settings/bg-editor.js';const values=await(await fetch('/state')).json();window.scene={width:800,height:450};const editor=createBackgroundEditor({getViewport:()=>window.scene,getImage:()=>values.bgImage,getValues:()=>values,onChange:p=>{Object.assign(values,p);editor.refresh();},onUpload(){},onClear(){}});window.editor=editor;document.querySelector('#mount').append(editor.element);window.setValues=p=>{Object.assign(values,p);editor.refresh();};editor.refresh();await document.querySelector('img').decode();window.ready=true;</script>`;
const hostHtml = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/shell.css"><script type="module">import{DEFAULT_THEME,writeTheme}from'/panels/theme.js';window.setValues=p=>writeTheme({...DEFAULT_THEME,bgImage:'${imageUrl}',bgOpacity:1,bgBlur:0,bgZoom:1,bgRotate:0,bgOffsetX:0,bgOffsetY:0,...p},{persist:false});setValues(await(await fetch('/state')).json());const image=new Image();image.src='${imageUrl}';await image.decode();window.ready=true;</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local').pathname;
  if (url === imageUrl) { res.setHeader('content-type', 'image/png'); res.end(png); return; }
  if (url === '/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(config.get().ui.uikit.dark)); return; }
  if (url === '/host' || url === '/editor') { res.setHeader('content-type', 'text/html'); res.end(url === '/host' ? hostHtml : editorHtml); return; }
  const file = files[url]; if (!file) { res.writeHead(404); res.end(); return; } res.setHeader('content-type', file[1]); res.end(fs.readFileSync(path.join(root, file[0])));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
function pixels(png) {
  const data = []; let width, height, channels;
  for (let p = 8; p < png.length;) { const n = png.readUInt32BE(p), type = png.toString('ascii', p + 4, p + 8), b = png.subarray(p + 8, p + 8 + n); if (type === 'IHDR') { width = b.readUInt32BE(0); height = b.readUInt32BE(4); assert.equal(b[8], 8); channels = b[9] === 6 ? 4 : b[9] === 2 ? 3 : 0; assert.ok(channels); } if (type === 'IDAT') data.push(b); p += n + 12; }
  const input = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, output = Buffer.alloc(stride * height); let from = 0;
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) { const filter = input[from++]; for (let x = 0; x < stride; x++) { const i = y * stride + x, a = x >= channels ? output[i - channels] : 0, b = y ? output[i - stride] : 0, c = y && x >= channels ? output[i - stride - channels] : 0; output[i] = (input[from++] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255; } }
  return { at: (x, y) => [...output.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] };
}
// Independent canvas renderer: fit or tile while retaining source aspect,
// rotate the original plane, then crop/enlarge the requested rectangle.
async function reference({ values, w, h, imageUrl, preview }) {
  const image = new Image(); image.src = imageUrl; await image.decode();
  const plane = document.createElement('canvas'); plane.width = w; plane.height = h; const p = plane.getContext('2d');
  if (values.bgFit === 'repeat') {
    const tw = w / 2, th = tw * image.naturalHeight / image.naturalWidth;
    for (let y = 0; y < h; y += th) for (let x = 0; x < w; x += tw) p.drawImage(image, x, y, tw, th);
  } else {
    const ratio = (values.bgFit === 'contain' ? Math.min : Math.max)(w / image.naturalWidth, h / image.naturalHeight), dw = image.naturalWidth * ratio, dh = image.naturalHeight * ratio;
    p.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  const rotated = document.createElement('canvas'); rotated.width = w; rotated.height = h; const r = rotated.getContext('2d');
  r.translate(w / 2, h / 2); r.rotate(values.bgRotate * Math.PI / 180); r.drawImage(plane, -w / 2, -h / 2);
  const output = document.createElement('canvas'); output.width = w; output.height = h; const o = output.getContext('2d');
  o.fillStyle = getComputedStyle(preview ? document.querySelector('.bg-stage') : document.body).backgroundColor; o.fillRect(0, 0, w, h);
  const z = values.bgZoom, cx = w * (.5 + values.bgOffsetX / 100), cy = h * (.5 + values.bgOffsetY / 100);
  if (preview) o.drawImage(rotated, 0, 0); else o.drawImage(rotated, cx - w * z / 2, cy - h * z / 2, w * z, h * z, 0, 0, w, h);
  const stage = preview ? document.querySelector('.bg-stage').getBoundingClientRect() : null;
  const controls = preview ? [...document.querySelectorAll('.bg-crop-size,.bg-rotate-dial,.bg-crop-handle')].map(n => n.getBoundingClientRect()).filter(b => b.width && b.height) : [];
  const out = [], left = preview ? Math.ceil(cx - w * z / 2 + 10) : 17, top = preview ? Math.ceil(cy - h * z / 2 + 10) : 19;
  for (let y = top; y < (preview ? cy + h * z / 2 - 10 : h - 2); y += preview ? 13 : 31) for (let x = left; x < (preview ? cx + w * z / 2 - 10 : w - 2); x += preview ? 17 : 37) {
    if (preview && (Math.abs(x - cx) < 4 || controls.some(b => x + stage.x >= b.left - 4 && x + stage.x <= b.right + 4 && y + stage.y >= b.top - 4 && y + stage.y <= b.bottom + 4))) continue;
    const rgb = [...o.getImageData(x, y, 1, 1).data].slice(0, 3), near = o.getImageData(x - 2, y - 2, 5, 5).data;
    // Compare flat areas, not interpolation along rotated grid/tile edges:
    // CSS composites once, whereas this independent reference uses two canvases.
    if ([...near].every((v, i) => i % 4 === 3 || Math.abs(v - rgb[i % 4]) <= 2)) out.push({ x, y, rgb });
  } return out;
}
let browser, kernel;
try {
  const playwright = createRequire(import.meta.url)('playwright-core'), cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(v => /^chromium-\d+$/.test(v)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  browser = await playwright.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(v => path.join(cache, v, 'chrome-win64/chrome.exe')).find(f => fs.existsSync(f)), headless: true });
  const editor = await browser.newPage({ viewport: { width: w, height: 700 } }), host = await browser.newPage({ viewport: { width: w, height: h } }), errors = [];
  const browserDiagnostics = [];
  const observe = (page, label) => {
    page.on('pageerror', error => { errors.push(error.message); browserDiagnostics.push(`${label} pageerror: ${error.message}`); });
    page.on('requestfailed', request => { const detail = `${label} requestfailed: ${request.url()} ${request.failure()?.errorText}`; errors.push(detail); browserDiagnostics.push(detail); });
    page.on('response', response => { if (response.status() >= 400) browserDiagnostics.push(`${label} HTTP ${response.status()}: ${response.url()}`); });
  };
  const ready = async (page, url, label) => {
    observe(page, label);
    try { await page.goto(url); await page.waitForFunction(() => window.ready); }
    catch (error) { throw new Error(`${label} readiness failed: ${error.message}\n${browserDiagnostics.join('\n')}`, { cause: error }); }
  };
  const base = `http://127.0.0.1:${server.address().port}`;
  await ready(editor, `${base}/editor`, 'editor'); await ready(host, `${base}/host`, 'host');
  const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  console.log('· Repeat is real tiling with valid CSS, and all fit modes preserve the non-16:9 image aspect');
  const repeated = await host.evaluate(() => { const s = getComputedStyle(document.body, '::before'); return { repeat: s.backgroundRepeat, size: s.backgroundSize }; });
  assert.equal(repeated.repeat, 'repeat'); assert.match(repeated.size, /^50%(?: auto)?$/, 'computed CSS may omit the default auto height');
  const modeShots = new Map();
  async function check(values,size) {
    if(size){
      w=size.width;h=size.height;
      await host.setViewportSize({width:w,height:h});await editor.setViewportSize({width:w,height:h+250});
      await editor.evaluate(({w,h})=>{window.scene={width:w,height:h};const stage=document.querySelector('.bg-stage');stage.style.width=w+'px';stage.style.height=h+'px';window.editor.refresh();},{w,h});
    }
    for (const page of [editor, host]) { await page.evaluate(v => setValues(v), values); await paint(page); }
    const hostExpected = await host.evaluate(reference, { values, w, h, imageUrl, preview: false });
    const previewExpected = await editor.evaluate(reference, { values, w, h, imageUrl, preview: true });
    const hostShot = await host.screenshot(), previewShot = await editor.locator('.bg-stage').screenshot();
    for (const [name, shot, expected] of [['host', hostShot, hostExpected], ['preview', previewShot, previewExpected]]) {
      assert.ok(expected.length >= (name === 'host' ? 100 : 12)); const actual = pixels(shot);
      const misses = expected.filter(p => actual.at(p.x, p.y).some((v, i) => Math.abs(v - p.rgb[i]) > 18));
      assert.equal(misses.length, 0, `${values.bgFit} ${name} ROI ${JSON.stringify(values)}: ${JSON.stringify(misses.slice(0, 3).map(p => ({ ...p, actual: actual.at(p.x, p.y) })))}`);
    }
    console.log(`  ${values.bgFit} ${values.bgZoom}, ${values.bgRotate}°, ${values.bgOffsetX}/${values.bgOffsetY}: preview ${previewExpected.length}, host ${hostExpected.length} reference pixels match`);
    return hostShot;
  }
  for (const fit of ['cover', 'contain', 'repeat']) {
    modeShots.set(fit, await check({ bgFit: fit, bgZoom: 1, bgRotate: 0, bgOffsetX: 0, bgOffsetY: 0 }));
    for (const angle of [0, 90, 45]) await check({ bgFit: fit, bgZoom: .57, bgRotate: angle, bgOffsetX: 15, bgOffsetY: -12 });
    await check({ bgFit: fit, bgZoom: .2, bgRotate: 90, bgOffsetX: -35, bgOffsetY: 30 });
  }
  for (const [a, b] of [['cover', 'contain'], ['contain', 'repeat'], ['cover', 'repeat']]) assert.equal(modeShots.get(a).equals(modeShots.get(b)), false, `${a}/${b} paint differently`);
  const center = await check({ bgFit: 'repeat', bgZoom: .57, bgRotate: 90, bgOffsetX: 0, bgOffsetY: 0 });
  const values = { bgFit: 'repeat', bgZoom: .57, bgRotate: 90, bgOffsetX: 15, bgOffsetY: -12 }, moved = await check(values);
  assert.equal(center.equals(moved), false);
  config.update({ ui: { uikit: { dark: values } } }); config = createConfig({ dataDir, defaults: buildDefaultConfig(), log }); config.load();
  const replay = await browser.newPage({ viewport: { width: w, height: h } }); await ready(replay, `${base}/host`, 'replay'); await paint(replay);
  assert.equal((await replay.screenshot()).equals(moved), true, 'disk replay reproduces exactly the tiled ROI');

  console.log('· Actual production settings picker updates preview and host immediately and saves the unchanged structure');
  for(const size of [{width:1200,height:600},{width:720,height:960},{width:900,height:900}])for(const fit of ['cover','contain','repeat'])for(const angle of [0,45]){
    await check({bgFit:fit,bgZoom:.57,bgRotate:angle,bgOffsetX:12,bgOffsetY:-9},size);
  }
  // Keep the production module/asset closure, without loading any extensions
  // installed beside the developer's checkout during this settings regression.
  const appRoot = path.join(dataDir, 'application');
  for (const name of ['src', 'bundled', 'ui']) fs.cpSync(path.join(root, name), path.join(appRoot, name), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(appRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  kernel = createKernel({ appRoot, env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(appRoot, 'absent-migration') }, headless: true,
    fetchImpl: async () => { assert.fail('115 prohibits all external HTTP'); },
    transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
    priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) }, communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) } });
  kernel.config.update({ server: { port: 0, token: 'fit115' } }); const port = await kernel.start();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }); observe(page, 'production');
  await page.goto(`http://127.0.0.1:${port}/?token=fit115`); await page.locator('#nav button[data-panel=settings]').click();
  const frame = page.frameLocator('#panel-host iframe'); await frame.locator('#settings-sidebar a[data-target=appearance]').waitFor({state:'visible'});
  await settingsSection(frame,'uikit');
  await frame.locator('details[data-appearance-group=background]>summary').click();
  await frame.locator('#section-uikit input[type=file]').setInputFiles({ name: 'pattern.png', mimeType: 'image/png', buffer: png });
  for (let i = 0; i < 200 && !await frame.locator('.bg-stage-img').evaluate(img => img.complete && img.naturalWidth > 0); i++) await page.waitForTimeout(20);
  assert.ok(await frame.locator('.bg-stage-img').evaluate(img => img.complete && img.naturalWidth > 0));
  const matchesSave = (request, expected) => {
    if (!isSettingsSaveRequest(request)) return false;
    const values = settingsSavePatch(request)?.ui?.uikit?.dark;
    return Object.entries(expected).every(([key, value]) => values?.[key] === value);
  };
  const saveResponse = expected => {const pending=page.waitForResponse(response => matchesSave(response.request(), expected));pending.catch(()=>{});return pending;};
  async function committed(responsePromise, expected) {
    const response = await responsePromise; assert.equal(response.status(), 200);
    const result = await response.json(); assert.equal(result.ok, true);
    for (const [key, value] of Object.entries(expected)) assert.equal(result.config.ui.uikit.dark[key], value, 'acknowledgement belongs to this edit');
    await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(kernel.config.get().ui.uikit.dark[key], value); assert.equal(disk.ui.uikit.dark[key], value);
    }
  }
  for (const mode of ['cover', 'contain', 'repeat']) {
    let release = () => {}, entered, intercept;
    if (mode === 'repeat') {
      let announce, captured = false;
      entered = new Promise(resolve => { announce = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      intercept = async route => {
        if (!captured && matchesSave(route.request(), { bgFit: mode })) { captured = true; announce(); await held; }
        await route.continue();
      };
      await page.route(SETTINGS_SAVE_ROUTE, intercept);
    }
    try {
      // Register before changing the field so a 700ms autosave cannot win the
      // race unnoticed. Both autosave and the button use the production save queue.
      const saved = saveResponse({ bgFit: mode });
      await frame.getByRole('radiogroup',{name:'背景铺法',exact:true}).locator(`[role=radio][data-value="${mode}"]`).click();
      const preview = await frame.locator('.bg-stage').evaluate(stage => ({ fit: getComputedStyle(stage.querySelector('img')).objectFit,
        repeated: getComputedStyle(stage.querySelector('.bg-stage-repeat')).display, size: getComputedStyle(stage.querySelector('.bg-stage-repeat')).backgroundSize }));
      assert.equal(preview.repeated !== 'none', mode === 'repeat', 'the real picker refreshes preview before a saved-config reload');
      if (mode !== 'repeat') assert.equal(preview.fit, mode); else assert.match(preview.size, /^50%(?: auto)?$/);
      if (entered) {
        await entered;
        assert.equal(kernel.config.get().ui.uikit.dark.bgFit, 'contain', 'an intercepted save has not committed yet');
      }
      await page.waitForFunction(mode => {
        const s = getComputedStyle(document.body, '::before');
        return s.backgroundRepeat === (mode === 'repeat' ? 'repeat' : 'no-repeat') && (mode === 'repeat' ? /^50%(?: auto)?$/.test(s.backgroundSize) : s.backgroundSize === mode);
      }, mode);
      release(); await committed(saved, { bgFit: mode });
      const host = await page.evaluate(() => { const s = getComputedStyle(document.body, '::before'); return { repeat: s.backgroundRepeat, size: s.backgroundSize }; });
      assert.equal(host.repeat, mode === 'repeat' ? 'repeat' : 'no-repeat');
      if (mode === 'repeat') assert.match(host.size, /^50%(?: auto)?$/); else assert.equal(host.size, mode);
    } finally { release(); if (intercept) await page.unroute(SETTINGS_SAVE_ROUTE, intercept); }
  }
  const zoomSaved = saveResponse({ bgZoom: .57 });
  await frame.locator('#bg-zoom').fill('57'); await frame.locator('#bg-zoom').dispatchEvent('input');
  await settingsSave(frame);
  await committed(zoomSaved, { bgZoom: .57 });
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(disk.ui.uikit.dark.bgFit, 'repeat'); assert.equal(disk.ui.uikit.dark.bgZoom, .57);
  assert.equal(Object.hasOwn(disk.ui.uikit.dark, 'bgRepeatDensity'), false);
  assert.deepEqual(errors, []); console.log('✓ 115 cover/contain/repeat pixels, rotation, movement, disk replay and real settings workflow passed');
} finally {
  await browser?.close(); await kernel?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true });
}
