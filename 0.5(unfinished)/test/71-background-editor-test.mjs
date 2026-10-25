// 验证三件事：
//  1. 背景图只画一层（shell 1 层，面板 iframe 不再各画一层）
//  2. 背景图尺寸 = 整个页面（铺满视口，不是只铺一块）
//  3. 编辑器可用：16:9 选框、拖角缩放、旋转、位置微调，且写进 config
import assert from 'node:assert/strict';
import {settingsSection} from './settings-navigation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel/kernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, '.shots');
fs.mkdirSync(outDir, { recursive: true });

let playwright = null;
for (const name of ['playwright', 'playwright-core']) {
  try { playwright = createRequire(import.meta.url)(name); break; } catch { /* 探测本机模块 */ }
}
if (!playwright) { console.log('! 无 Playwright'); process.exit(1); }

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// 造一张可辨识的测试图：左半红右半蓝，中间一条白带（作为"选框边界"参照）
function makeTestPng() {
  const width = 640, height = 360;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0; // filter byte
    for (let x = 0; x < width; x += 1) {
      const left = x < width * 0.46;
      const right = x > width * 0.54;
      if (left) { raw[o++] = 214; raw[o++] = 69; raw[o++] = 69; }
      else if (right) { raw[o++] = 56; raw[o++] = 122; raw[o++] = 214; }
      else { raw[o++] = 240; raw[o++] = 240; raw[o++] = 240; }
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Decode Chromium's PNG output so the production content-area check proves
// visible image pixels, rather than only checking translucent CSS declarations.
function screenshotPixels(png) {
  const data = []; let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); assert.equal(chunk[8], 8); channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 0; assert.ok(channels); }
    if (type === 'IDAT') data.push(chunk);
    offset += length + 12;
  }
  const input = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, output = Buffer.alloc(stride * height); let from = 0;
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = input[from++]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? output[at - channels] : 0, b = y ? output[at - stride] : 0, c = y && x >= channels ? output[at - stride - channels] : 0;
      output[at] = (input[from++] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  return { at: (x, y) => [...output.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-bg-'));
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
  isolatedOutbound++; throw new Error('QA71 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA71 external DNS disabled'); };
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
    fetchImpl: async () => { isolatedOutbound++; throw new Error('QA71 external traffic disabled'); },
  transport: { id: 'fixture', connected: false, selfId: '', actions: {}, start: async () => {}, stop: async () => {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
  headless: true,
});
kernel.loader.startWatchers = () => {};
kernel.config.update({ server: { port: 0, token: 'bg-token' }, telemetry: { enabled: false } });
const port = await kernel.start();
const base = `http://127.0.0.1:${port}`;
ownedOrigins.add(base); assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);

// 先把测试图上传进去（走真实接口）
const png = makeTestPng();
const upload = await fetch(`${base}/api/uikit/background`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': 'bg-token' },
  body: JSON.stringify({ data: `data:image/png;base64,${png.toString('base64')}` }),
});
const uploaded = await upload.json();
console.log('上传：', upload.status, uploaded);

let browser;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  browser = await playwright.chromium.launch({ headless: true, ...(fs.existsSync(executablePath) ? { executablePath } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 })).newPage();
  await routeOwnedPage(page, base);
  await page.goto(`${base}/?token=bg-token`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#nav button').length >= 8, null, { timeout: 20000 });
  await page.locator('#nav button[data-panel="settings"]').click();
  await page.waitForFunction(() => document.querySelector('#panel-host iframe')?.src.includes('/panels/settings/'), null, { timeout: 15000 });
  await page.waitForTimeout(3500);
  const frame = page.frameLocator('#panel-host iframe');
  // 切到组件库分区
  await settingsSection(frame,'uikit');
  // Background controls now live in the visible appearance "背景" fold. Open
  // its actual summary rather than filling a range inside a closed details.
  const openBackground=async()=>{const fold=frame.locator('details[data-appearance-group="background"]');if(!await fold.evaluate(node=>node.open))await fold.locator(':scope > summary').click();};
  await openBackground();
  await page.waitForTimeout(800);
  assert.ok(await frame.locator('.bg-editor').count(), '背景图编辑器未渲染');

  console.log('\n=== A. 编辑器已渲染 ===');
  // 走真实上传路径（FileReader → POST /api/uikit/background → form.set → renderKit），
  // 不要直接 POST /api/config：面板 iframe 里的 form 是异步载入的，
  // 外部改配置不会让编辑器读到值（实测 imgSrc=null → 走空态，选框量不到尺寸）。
  await frame.locator('#section-uikit input[type="file"]').setInputFiles({
    name: 'test-bg.png', mimeType: 'image/png', buffer: png,
  });
  // 等上传 + 重新渲染。
  // 注意：面板是 sandbox=allow-scripts 的 opaque-origin iframe，
  // shell 文档读不到它的 contentDocument —— 用 Playwright 的 frameLocator 等待。
  await frame.locator('.bg-stage-img[src]').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await openBackground();

  const editor = await frame.locator('#section-uikit').evaluate((card) => {
    const stage = card.querySelector('.bg-stage');
    const crop = card.querySelector('.bg-crop');
    const dial = card.querySelector('.bg-rotate-dial');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; };
    const stageBox = stage?.getBoundingClientRect();
    const cropBox = crop?.getBoundingClientRect();
    return {
      hasStage: !!stage, hasCrop: !!crop, hasDial: !!dial,
      stage: r(stage), crop: r(crop),
      // 选框比例 = 宽/高，必须是 16/9
      cropRatio: cropBox && cropBox.height > 0 ? +(cropBox.width / cropBox.height).toFixed(3) : 0,
      // 选框宽占舞台宽的比例（bgZoom=1 时应≈100%）
      cropVsStage: stageBox && cropBox ? +(cropBox.width / stageBox.width).toFixed(3) : 0,
      handles: card.querySelectorAll('.bg-crop-handle').length,
      sliders: ['bg-rotate', 'bg-zoom', 'bg-offset-x', 'bg-offset-y'].filter((id) => card.querySelector(`#${id}`)),
      // 四个参数必须都是 range 滑条。漏 type='range' 会静默渲染成文本框
      // （实测"垂直位置"显示成输入 "0" 而不是滑条）。
      sliderTypes: Object.fromEntries(['bg-rotate', 'bg-zoom', 'bg-offset-x', 'bg-offset-y']
        .map((id) => [id, card.querySelector(`#${id}`)?.type ?? 'missing'])),
      // "恢复当前预设出厂" 按钮只能有一个：renderKit 清空的是 kit.fields，
      // 若把按钮 append 到 kit.card，每次渲染都会多挂一个（实测叠出 5 个）。
      restoreBtnCount: [...card.querySelectorAll('button')]
        .filter((b) => (b.textContent || '').includes('恢复当前预设出厂')
          || (b.textContent || '').includes('重置为暗色基准')).length,
      anglePresets: card.querySelectorAll('.bg-angle-presets button').length,
      cropSizeLabel: crop?.querySelector('.bg-crop-size')?.textContent || '', cropDisplay: crop?getComputedStyle(crop).display:null, cropStyleW: crop?.style.width, imgSrc: card.querySelector('.bg-stage-img')?.getAttribute('src')||null, stageDisplay: stage?getComputedStyle(stage).display:null,
    };
  });
  console.log('  ', JSON.stringify(editor));
  console.log('  配置回读：', JSON.stringify((await (await fetch(`${base}/api/config`, { headers: { 'x-console-token': 'bg-token' } })).json()).ui?.uikit));

  console.log('\n=== B. 16:9 选框比例正确 ===');
  const imgProbe = await frame.locator('.bg-stage-img').evaluate((el) => ({
    src: el.getAttribute('src'), complete: el.complete, nw: el.naturalWidth, nh: el.naturalHeight,
  }));
  console.log('  预览图加载：', JSON.stringify(imgProbe));
  assert.ok(imgProbe.complete && imgProbe.nw > 0, `预览图未加载成功：${JSON.stringify(imgProbe)}`);
  console.log(`✓ 预览图已加载 ${imgProbe.nw}×${imgProbe.nh}`);
  assert.equal(editor.handles, 4, '应有 4 个角把手');
  assert.equal(editor.sliders.length, 4, '四个参数滑条都在');
  assert.deepEqual(editor.sliderTypes,
    { 'bg-rotate': 'range', 'bg-zoom': 'range', 'bg-offset-x': 'range', 'bg-offset-y': 'range' },
    '四个参数都必须是 range 滑条（漏 type 会渲染成文本框）');
  assert.equal(editor.restoreBtnCount, 1,
    `「恢复出厂」按钮只应有一个（实际 ${editor.restoreBtnCount} 个 —— renderKit 往 kit.card 挂载导致重复渲染泄漏）`);
  console.log('✓ 四个参数均为滑条，「恢复出厂」按钮唯一');
  assert.ok(Math.abs(editor.cropRatio - 16 / 9) <= 0.02, `选框比例 ${editor.cropRatio} 不是 16:9（期望 1.778）`);
  console.log(`✓ 选框比例 ${editor.cropRatio}（16:9 = 1.778），${editor.handles} 个角把手，占舞台 ${Math.round(editor.cropVsStage * 100)}% 宽`);
  console.log(`  选框标签：${editor.cropSizeLabel}`);

  console.log('\n=== B2. 缩放锁定 16:9 ===');
  //拖角/滑条改变大小时，比例必须仍是 16:9
  await frame.locator('#bg-zoom').fill('55');
  await frame.locator('#bg-zoom').dispatchEvent('input');
  await page.waitForTimeout(400);
  const ratioAfter = await frame.locator('.bg-crop').evaluate((c) => {
    const b = c.getBoundingClientRect();
    return +(b.width / b.height).toFixed(3);
  });
  console.log(`  缩到 55% 后比例：${ratioAfter}`);
  assert.ok(Math.abs(ratioAfter - 16 / 9) <= 0.02, `缩放后比例变成 ${ratioAfter}，不再是 16:9`);
  console.log('✓ 缩放时比例恒定 16:9');
  await frame.locator('#bg-zoom').fill('100');
  await frame.locator('#bg-zoom').dispatchEvent('input');
  await page.waitForTimeout(300);

  console.log('\n=== C. 验证只画一层 ===');
  // shell 绘制状态
  const layers = await page.evaluate(() => {
    const a = getComputedStyle(document.body, '::before');
    const paint = pseudo => {
      const s = getComputedStyle(document.body, pseudo);
      return s.display !== 'none' && !['none', 'normal'].includes(s.content) && s.backgroundImage !== 'none';
    };
    return {
      shellDraws: paint('::before'),
      backgroundLayers: ['::before', '::after'].filter(paint).length,
      shellBgImage: a.backgroundImage.slice(0, 40),
      frameCount: document.querySelectorAll('#panel-host iframe').length,
    };
  });
  const panelLayer = await frame.locator('body').evaluate((b) => {
    return {
      // An undefined pseudo-element has content:normal and paints nothing,
      // even though its computed display is inline. Count actual image layers.
      backgroundLayers: ['::before', '::after'].filter(pseudo => {
        const s = getComputedStyle(b, pseudo);
        return s.display !== 'none' && !['none', 'normal'].includes(s.content) && s.backgroundImage !== 'none';
      }).length,
      bgOwner: b.dataset.bgOwner,
    };
  });
  console.log('  shell 绘制:', layers, ' 面板侧:', panelLayer);
  assert.equal(layers.shellDraws, true, '上传后的背景图必须由宿主实际绘制');
  assert.equal(layers.backgroundLayers, 1, '宿主只应绘制一个背景图层');
  assert.equal(panelLayer.backgroundLayers, 0, '面板不应重复绘制宿主背景图');
  console.log('✓ 只有 shell 画一层，面板未重复绘制背景图');

  console.log('\n=== D. 背景图尺寸 = 整个页面 ===');
  const size = await page.evaluate(() => {
    const a = getComputedStyle(document.body, '::before');
    const b = document.body.getBoundingClientRect();
    const w = Number.parseFloat(a.width), h = Number.parseFloat(a.height);
    const [ox, oy] = a.transformOrigin.split(' ').map(Number.parseFloat);
    const matrix = new DOMMatrix(a.transform);
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => {
      const p = new DOMPoint(x - ox, y - oy).matrixTransform(matrix);
      return { x: p.x + ox + Number.parseFloat(a.left), y: p.y + oy + Number.parseFloat(a.top) };
    });
    return {
      cssTop: a.top, cssRight: a.right, cssBottom: a.bottom, cssLeft: a.left,
      bgSize: a.backgroundSize,
      bodyW: Math.round(b.width), bodyH: Math.round(b.height),
      vw: window.innerWidth, vh: window.innerHeight,
      planeRatio: w / h, paintedLeft: Math.min(...corners.map(p => p.x)), paintedRight: Math.max(...corners.map(p => p.x)),
      paintedTop: Math.min(...corners.map(p => p.y)), paintedBottom: Math.max(...corners.map(p => p.y)),
    };
  });
  console.log('  ', JSON.stringify(size));
  const coversViewport = size.paintedLeft <= 0.1 && size.paintedTop <= 0.1
    && size.paintedRight >= size.vw - 0.1 && size.paintedBottom >= size.vh - 0.1;
  assert.ok(Math.abs(size.planeRatio - 16 / 9) < .01, '宿主与编辑器使用同一16:9原图平面');
  assert.ok(coversViewport, `背景层未铺满视口：${JSON.stringify(size)}`);
  console.log('✓ 16:9原图平面居中覆盖整个视口');

  console.log('\n=== D2. 内容未被背景遮挡（层级）===');
  // Verify stacking and hit-testing, without requiring an old numeric z-index.
  // The host may use a negative backdrop or a positive content layer.
  const layer = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const cs = getComputedStyle(shell);
    const backdrop = getComputedStyle(document.body, '::before');
    const r = shell.getBoundingClientRect();
    const nav = document.querySelector('#nav button');
    return {
      shellZ: cs.zIndex, shellPosition: cs.position,
      backdropZ: backdrop.zIndex, backdropPointerEvents: backdrop.pointerEvents,
      shellVisible: r.width > 0 && r.height > 0,
      // 导航项中心点的最顶层元素是否属于 shell（若被背景盖住则命中 body 伪元素之外的东西）
      navHitOk: (() => {
        if (!nav) return false;
        const b = nav.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return !!hit && (hit === nav || nav.contains(hit));
      })(),
      shellRect: { w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  console.log('  ', JSON.stringify(layer));
  assert.ok(Number(layer.shellZ === 'auto' ? 0 : layer.shellZ) > Number(layer.backdropZ === 'auto' ? 0 : layer.backdropZ), '内容层必须处于背景图层之上');
  assert.equal(layer.backdropPointerEvents, 'none', '背景不得拦截用户输入');
  assert.ok(layer.navHitOk, '导航项被背景层遮挡（elementFromPoint 未命中导航）');
  console.log(`✓ 内容层在背景之上（.app-shell z-index=${layer.shellZ}，导航可点击）`);

  console.log('\n=== D3. 背景图真的透上来（浅色主题实测）===');
  // 回归点：.workspace / .rail / iframe / 面板 body 曾经都用**不透明**背景色，
  // 正好盖住 shell 的背景伪元素 —— 浅色主题下背景图完全不可见（用户实机反馈）。
  // Work-area margins must expose the host image; navigation keeps its own
  // readable surface rather than requiring the old translucent rail skin.
  const seeThrough = await page.evaluate(() => {
    const alpha = (c) => {
      // 注意：color-mix() 的计算值是 `color(srgb r g b / a)` 新语法，不是 rgba()。
      // 两种都要认，否则会把半透明误判成不透明（第一次写断言时就踩了这个坑）。
      const s = String(c || '');
      const slash = /\/\s*([\d.]+)\s*\)/.exec(s);
      if (slash) return Number(slash[1]);
      const rgba = /rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(s);
      return rgba ? Number(rgba[1]) : 1;
    };
    const ws = getComputedStyle(document.querySelector('.workspace'));
    const rail = getComputedStyle(document.querySelector('.rail'));
    const frame = document.querySelector('#panel-host iframe');
    const fs = frame ? getComputedStyle(frame) : null;
    return {
      workspaceBg: ws.backgroundColor, workspaceAlpha: alpha(ws.backgroundColor),
      railBg: rail.backgroundColor, railAlpha: alpha(rail.backgroundColor),
      iframeBg: fs?.backgroundColor, iframeAlpha: alpha(fs?.backgroundColor),
    };
  });
  console.log('  ', JSON.stringify(seeThrough));
  assert.ok(seeThrough.workspaceAlpha < 1, `.workspace 需掺透明（alpha=${seeThrough.workspaceAlpha}），否则盖住背景图`);
  assert.ok(seeThrough.railAlpha > 0, '导航需要可读的表面底色');
  assert.ok(seeThrough.iframeAlpha < 1, 'iframe 底色不能完全遮住宿主背景');
  // 面板 iframe 内的 body 也必须透明（同理：面板侧不画背景，靠 shell 透出）
  const panelBodyBg = await frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  console.log('  面板 body 背景：', panelBodyBg);
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(panelBodyBg),
    `面板 body 背景应透明（实际 ${panelBodyBg}）—— 不透明会盖住 shell 的背景图`);
  const samplePoints = await page.locator('#panel-host').evaluate(host => {
    const box = host.getBoundingClientRect(), points = [];
    // These points are inside the real iframe's outer document margin, away
    // from headers, cards and crop controls. They must expose the host layer.
    for (const dx of [3, 7, 11]) for (const dy of [3, 7, 11]) points.push({ x: Math.floor(box.left + dx), y: Math.floor(box.top + dy) });
    return points;
  });
  const painted = screenshotPixels(await page.screenshot());
  const backgroundState = await page.evaluate(() => { const value = document.body.dataset.bgImage; document.body.dataset.bgImage = 'off'; return value; });
  let unpainted;
  try {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    unpainted = screenshotPixels(await page.screenshot());
  } finally {
    await page.evaluate(value => { document.body.dataset.bgImage = value; }, backgroundState);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const changed = samplePoints.filter(point => painted.at(point.x, point.y).some((value, channel) => Math.abs(value - unpainted.at(point.x, point.y)[channel]) > 2));
  assert.equal(changed.length, samplePoints.length, '关闭宿主背景后，真实面板留白的所有采样像素都应变化；否则背景被内容底色遮住');
  console.log('✓ 工作区与面板可透出背景，导航保持独立可读底色');

  await page.screenshot({ path: path.join(outDir, 'bg-01-applied.png') });

  console.log('\n=== E. 旋转生效（走编辑器快捷按钮）===');
  // 用编辑器自己的 90° 按钮，而不是外部 POST /api/config：
  // 面板 iframe 里的 form 是异步载入的，外部改配置不会推给面板。
  await frame.locator('#section-uikit .bg-angle-presets button', { hasText: '90°' }).click();
  await page.waitForTimeout(900);
  const rotated = await page.evaluate(() => getComputedStyle(document.body, '::before').transform);
  const dialAngle = await frame.locator('.needle').evaluate((n) => getComputedStyle(n).transform);
  const rotateVal = await frame.locator('#bg-rotate').inputValue();
  console.log(`  shell ::before transform=${rotated}`);
  console.log(`  编辑器旋钮角度=${dialAngle}，滑条值=${rotateVal}`);
  assert.ok(/matrix/.test(rotated) && rotated !== 'none', 'shell 侧旋转未生效');
  assert.equal(rotateVal, '90', `编辑器滑条未同步（实际 ${rotateVal}）`);
  await page.screenshot({ path: path.join(outDir, 'bg-02-rotated.png') });
  console.log('✓ 旋转 90° 已应用（红蓝互换位置可见）');

  console.log('\n=== F. 编辑器操作 → 写进配置 ===');
  console.log('\n=== F. 真实拖拽：移动选框 + 拖角缩放 ===');
  // 100% selects the whole image and cannot move without leaving it.
  await frame.locator('#bg-zoom').fill('55');
  await frame.locator('#bg-zoom').dispatchEvent('input');
  await page.waitForTimeout(300);
  // F1 拖动选框主体 → 水平/垂直位置变化
  const beforeMove = await frame.locator('.bg-crop').evaluate((c) => ({ left: c.style.left, top: c.style.top }));
  console.log('  舞台 box=', JSON.stringify(await frame.locator('.bg-stage').boundingBox()));
  console.log('  选框 box=', JSON.stringify(await frame.locator('.bg-crop').boundingBox()));
  const stageBox = await frame.locator('.bg-stage').boundingBox();
  const cropBox = await frame.locator('.bg-crop').boundingBox();
  await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width * 0.7, stageBox.y + stageBox.height * 0.62, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterMove = await frame.locator('.bg-crop').evaluate((c) => ({ left: c.style.left, top: c.style.top }));
  console.log(`  拖动：left ${beforeMove.left} → ${afterMove.left}；top ${beforeMove.top} → ${afterMove.top}`);
  if (beforeMove.left === afterMove.left && beforeMove.top === afterMove.top) {
    assert.fail('拖动选框没有改变位置');
  }
  const offsetXVal = await frame.locator('#bg-offset-x').inputValue();
  const offsetYVal = await frame.locator('#bg-offset-y').inputValue();
  console.log(`  偏移滑条：x=${offsetXVal}% y=${offsetYVal}%`);
  if (Number(offsetXVal) === 0 && Number(offsetYVal) === 0) assert.fail('拖动后偏移仍为 0');
  console.log('✓ 拖动选框改变范围位置');

  // F2 拖角把手 → 范围大小变化，比例仍锁 16:9
  // 注意：不能用 page.mouse 拖 iframe 内的元素 —— 坐标换算在 sandbox iframe 下不可靠
  // （实测 elementFromPoint 返回 null）。改为在面板文档内派发 PointerEvent。
  const sizeBefore = await frame.locator(".bg-crop").boundingBox();
  const resizeResult = await frame.locator(".bg-crop").evaluate((c) => {
    const stage = c.closest(".bg-stage");
    const s = stage.getBoundingClientRect();
    const handle = c.querySelector('.bg-crop-handle[data-corner="se"]');
    const hb = handle.getBoundingClientRect();
    const cx = hb.x + hb.width / 2, cy = hb.y + hb.height / 2;
    const opts = { bubbles: true, cancelable: true, pointerId: 7, clientX: cx, clientY: cy, isPrimary: true };
    handle.dispatchEvent(new PointerEvent("pointerdown", opts));
    // 往左上拖 25% 舞台宽高
    stage.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: cx - s.width * 0.25, clientY: cy - s.height * 0.25 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...opts }));
    return { afterW: Math.round(c.getBoundingClientRect().width), afterH: Math.round(c.getBoundingClientRect().height) };
  });
  await page.waitForTimeout(400);
  console.log(`  拖角：${Math.round(sizeBefore.width)}×${Math.round(sizeBefore.height)} → ${resizeResult.afterW}×${resizeResult.afterH}`);
  assert.notEqual(resizeResult.afterW, Math.round(sizeBefore.width), '拖角没有改变范围大小');
  const r = resizeResult.afterW / resizeResult.afterH;
  assert.ok(Math.abs(r - 16 / 9) <= 0.03, `拖角后比例变成 ${r.toFixed(3)}，不再是 16:9`);
  const zoomVal = await frame.locator("#bg-zoom").inputValue();
  console.log(`  缩放滑条同步为 ${zoomVal}%`);
  console.log("✓ 拖角改变范围大小，且比例恒定 16:9");

  // F3 落盘检查：等防抖保存后读配置
  await page.waitForTimeout(1200);
  const cfg = await (await fetch(`${base}/api/config`, { headers: { 'x-console-token': 'bg-token' } })).json();
  const dark = cfg.ui?.uikit?.dark ?? {};
  console.log('  cfg 顶层键=', JSON.stringify(Object.keys(cfg)));
  console.log('  cfg.ui=', JSON.stringify(cfg.ui)?.slice(0,400));
  console.log(`  config: bgRotate=${dark.bgRotate} bgZoom=${dark.bgZoom} bgOffsetX=${dark.bgOffsetX} bgOffsetY=${dark.bgOffsetY}`);
  if (dark.bgRotate !== 90) assert.fail(`旋转未落盘（bgRotate=${dark.bgRotate}）`);
  if (typeof dark.bgOffsetX !== 'number' || typeof dark.bgOffsetY !== 'number') {
    assert.fail('偏移未落盘');
  }
  assert.equal(typeof dark.bgZoom, 'number', '范围大小未落盘');
  await page.screenshot({ path: path.join(outDir, 'bg-03-editor.png') });
  console.log('✓ 编辑器操作已写入 config.json');

  console.log('\n=== G. 编辑器区域截图 ===');
  await frame.locator('.bg-editor').screenshot({ path: path.join(outDir, 'bg-04-editor-closeup.png') });
  console.log('✓ bg-04-editor-closeup.png');
} finally {
  await browser?.close().catch(() => {});
  await kernel.stop();
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-bg-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
  assertOffline(); assert.deepEqual(kernel.loader.listEntries(), []);
}
console.log('\n✓ 背景图验证完成');
