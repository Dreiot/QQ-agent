import {settingsSection,settingsSave} from './settings-navigation.mjs';
// Real settings iframe, FileReader, upload/config HTTP and isolated disk.
// Only response delivery is controlled; no vendor, credentials or headed QA data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { isolateConsoleFixture } from './console-fixture-isolation.mjs';

const panelOption = process.argv.indexOf('--panel-source');
const suppliedPanel = panelOption < 0 ? null : fs.readFileSync(path.resolve(process.argv[panelOption + 1]), 'utf8');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-upload155-'));
const isolation=isolateConsoleFixture(dataDir,'155');
const kernel = createKernel({appRoot:isolation.appRoot,env:isolation.env,headless:true,
  transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) }, communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) } });
let browser;
kernel.loader.startWatchers=()=>{};
const results = [], errors = [], png = (() => {
  const crc = b => { let c = 0xffffffff; for (const n of b) { c ^= n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, b) => { const t = Buffer.from(name), o = Buffer.alloc(b.length + 12); o.writeUInt32BE(b.length); t.copy(o, 4); b.copy(o, 8); o.writeUInt32BE(crc(Buffer.concat([t, b])), b.length + 8); return o; };
  const head = Buffer.alloc(13); head.writeUInt32BE(16); head.writeUInt32BE(9, 4); head[8] = 8; head[9] = 2;
  const raw = Buffer.alloc(49 * 9); for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) { const p = y * 49 + x * 3 + 1; raw[p] = x * 13; raw[p + 1] = y * 23; raw[p + 2] = 180; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
const slot = (u, mode) => mode.startsWith('custom:') ? u.custom[mode.slice(7)].tokens : u[mode];
const seed = mode => ({ mode, dark: { bgImage: '', bgRotate: 27, bgZoom: .56, bgOffsetX: 7, bgOffsetY: -3 }, light: { bgImage: '', bgRotate: 46 },
  custom: { A: { name: '155 A', tokens: { bgImage: '', bgRotate: 71, bgZoom: .7 } }, B: { name: '155 B', tokens: { bgImage: '', bgRotate: 92, bgZoom: .8 } } } });
const disk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
async function until(fn, label, timeout = 8000) { const end = Date.now() + timeout; while (!fn()) { assert.ok(Date.now() < end, label); await new Promise(r => setTimeout(r, 20)); } }
async function check(name, task) { try { await task(); results.push({ name, passed: true }); console.log('✓ ' + name); } catch (error) { results.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); } }
try {
  kernel.config.update({ server: { port: 0, token: 'upload155' }, telemetry: { enabled: false }, proactive: { enabled: false } });
  const port = await kernel.start(), base = `http://127.0.0.1:${port}`;
  isolation.allowOrigin(base);isolation.assertEmpty(kernel);
  const playwright = createRequire(import.meta.url)('playwright-core'), cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(v => /^chromium-\d+$/.test(v)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  browser = await playwright.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(v => path.join(cache, v, 'chrome-win64/chrome.exe')).find(f => fs.existsSync(f)), headless: process.env.QA_HEADLESS !== '0' });
  async function open(mode = 'custom:A', delayReader = false) {
    const initial = seed(mode); kernel.config.update({ ui: { uikit: { __replace__: initial } } });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' }); page.on('pageerror', e => errors.push(e.message));
    await isolation.bindPage(page,base);
    if (suppliedPanel !== null) await page.route('**/panels/settings/panel.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: suppliedPanel }));
    if (delayReader) await page.addInitScript(() => {
      const read = FileReader.prototype.readAsDataURL; window.heldReaders155 = [];
      FileReader.prototype.readAsDataURL = function(file) { window.heldReaders155.push(() => read.call(this, file)); };
    });
    await page.goto(`${base}/?token=upload155`); await page.locator('#nav button[data-panel=settings]').click();
    const frame = page.frameLocator('#panel-host iframe'); await frame.locator('#settings-sidebar a[data-target=appearance]').waitFor({state:'visible'});
    const kit = async () => {await settingsSection(frame,'uikit');for(const key of ['background','themes']){const fold=frame.locator(`details[data-appearance-group=${key}]`);if(!await fold.evaluate(n=>n.open))await fold.locator(':scope>summary').click();}}; await kit();
    const modeTo = async mode => { await settingsSection(frame,'appearance');const owner=frame.locator('.setting-field:has(#field-ui-uikit-mode)');if(await owner.locator(`[role=radio][data-value="${mode}"]`).count())await owner.locator(`[role=radio][data-value="${mode}"]`).click();else await frame.locator('#field-ui-uikit-mode').selectOption(mode); await kit(); };
    const file = () => frame.locator('#section-uikit input[type=file]');
    const upload = async name => file().setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: png });
    const uploads = [];
    await page.route('**/api/uikit/background', async route => {
      const response = await route.fetch(); let release, finish;
      const hold = new Promise(r => release = r), done = new Promise(r => finish = r), body = await response.json();
      const call = { body, response, release, done, fail: false }; uploads.push(call); await hold;
      if (call.fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA155 upload failed' }) });
      else await route.fulfill({ response }); finish();
    });
    const entered = async n => { await until(() => uploads.length >= n, 'upload request ' + n); return uploads[n - 1]; };
    const settle = async call => { call.release(); await call.done; await page.waitForTimeout(1000); };
    const close = async () => { for (const call of uploads) call.release(); await page.close(); };
    return { page, frame, initial, kit, modeTo, upload, uploads, entered, settle, close };
  }
  for (const [from, to, back] of [['custom:A', 'custom:B', false], ['dark', 'custom:A', false], ['custom:A', 'light', false], ['custom:A', 'custom:B', true]]) await check(`upload ${from} → ${to}${back ? ' → original' : ''} never writes a different or retired slot`, async () => {
    const c = await open(from); try { await c.upload('switch'); const call = await c.entered(1); await c.modeTo(to); if (back) await c.modeTo(from); await c.settle(call);
      const live = kernel.config.get().ui.uikit; assert.deepEqual(live.custom, c.initial.custom); assert.deepEqual(live.dark, c.initial.dark); assert.deepEqual(live.light, c.initial.light);
      assert.equal(disk().ui.uikit.mode, back ? from : to); assert.equal((await c.frame.locator('#status').textContent()).includes('背景图已上传'), false);
    } finally { await c.close(); }
  });
  await check('switch while real FileReader is held avoids even a stale upload POST', async () => {
    const c = await open('dark', true); try { await c.upload('reader'); await c.frame.locator('#section-uikit input[type=file]').evaluate(() => { if (window.heldReaders155.length !== 1) throw new Error('reader not held'); });
      await c.modeTo('custom:B'); await c.frame.locator('#section-uikit').evaluate(() => window.heldReaders155[0]()); await c.page.waitForTimeout(1000);
      assert.equal(c.uploads.length, 0); assert.deepEqual(kernel.config.get().ui.uikit.custom, c.initial.custom);
    } finally { await c.close(); }
  });
  await check('leaving and destroying settings cannot publish a delayed upload', async () => {
    const c = await open(); try { await c.upload('leave'); const call = await c.entered(1); await c.page.locator('#nav button[data-panel=chats]').click();
      await c.page.waitForFunction(() => document.querySelector('#panel-host iframe')?.src.includes('/panels/chats/')); await c.settle(call);
      assert.deepEqual(kernel.config.get().ui.uikit, c.initial); assert.deepEqual(disk().ui.uikit, c.initial);
    } finally { await c.close(); }
  });
  await check('latest upload wins out of order; normal settings save and crop still commit', async () => {
    const c = await open(); try { await c.upload('old'); const old = await c.entered(1); await c.upload('new'); const latest = await c.entered(2);
      await settingsSection(c.frame,'interface');const nextVision=!await c.frame.locator('#field-ui-showVision').isChecked(); await c.frame.locator('.setting-field:has(#field-ui-showVision)').click(); await c.kit();
      await c.settle(latest); assert.equal(slot(kernel.config.get().ui.uikit, 'custom:A').bgImage, latest.body.url);
      assert.notEqual(old.body.url, latest.body.url, 'actual upload responses identify different stored files');
      await c.settle(old); assert.equal(slot(kernel.config.get().ui.uikit, 'custom:A').bgImage, latest.body.url);
      assert.equal((await c.frame.locator('#status').textContent()).includes('QA155 upload failed'), false); assert.equal(disk().ui.showVision, nextVision);
      for (const [id, value] of [['bg-rotate', '123'], ['bg-zoom', '57']]) await c.frame.locator('#' + id).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
      await settingsSave(c.frame);
      await until(() => slot(disk().ui.uikit, 'custom:A').bgRotate === 123 && slot(disk().ui.uikit, 'custom:A').bgZoom === .57, 'latest crop committed');
      assert.deepEqual(kernel.config.get().ui.uikit.custom.B, c.initial.custom.B); assert.deepEqual(kernel.config.get().ui.uikit.dark, c.initial.dark);
      await c.page.goto(`${base}/?token=upload155`); await c.page.locator('#nav button[data-panel=settings]').click(); await c.frame.locator('#settings-sidebar a[data-target=appearance]').waitFor({state:'visible'}); await c.kit();
      assert.equal(await c.frame.locator('#bg-rotate').inputValue(), '123'); assert.equal(await c.frame.locator('#bg-zoom').inputValue(), '57');
    } finally { await c.close(); }
  });
  await check('a stale failure does not replace the latest successful upload feedback', async () => {
    const c = await open(); try { await c.upload('old-error'); const old = await c.entered(1); old.fail = true; await c.upload('new-ok'); const latest = await c.entered(2);
      await c.settle(latest); const status = await c.frame.locator('#status').textContent(); await c.settle(old);
      assert.equal(slot(disk().ui.uikit, 'custom:A').bgImage, latest.body.url); assert.equal(await c.frame.locator('#status').textContent(), status);
    } finally { await c.close(); }
  });
  await check('clear invalidates an in-flight replacement without restoring a removed background', async () => {
    const c = await open(); try { await c.upload('initial'); await c.settle(await c.entered(1)); await c.upload('replacement'); const call = await c.entered(2);
      const clear = c.frame.locator('.bg-editor').getByRole('button', { name: '清除', exact: true }); await clear.click();
      assert.notEqual(slot(kernel.config.get().ui.uikit, 'custom:A').bgImage, '', '第一次点击保留当前背景与待替换请求');
      await clear.click(); await c.settle(call);
      assert.equal(slot(kernel.config.get().ui.uikit, 'custom:A').bgImage, ''); assert.equal(slot(disk().ui.uikit, 'custom:A').bgImage, '');
      assert.ok((await c.frame.locator('.bg-editor').textContent()).includes('尚未选择背景'));
    } finally { await c.close(); }
  });
  await check('current failure remains visible; ordinary save and a later valid upload recover', async () => {
    const c = await open('light'); try { await c.upload('failed'); const call = await c.entered(1); call.fail = true; await c.settle(call);
      assert.match(await c.frame.locator('#status').textContent(), /上传失败.*QA155 upload failed/); assert.deepEqual(kernel.config.get().ui.uikit, c.initial);
      await settingsSection(c.frame,'interface');const nextVision=!await c.frame.locator('#field-ui-showVision').isChecked(); await c.frame.locator('.setting-field:has(#field-ui-showVision)').click(); await settingsSave(c.frame); await until(() => disk().ui.showVision === nextVision, 'ordinary save after failure');
      await c.kit(); await c.upload('recover'); const good = await c.entered(2); await c.settle(good);
      assert.equal(slot(disk().ui.uikit, 'light').bgImage, good.body.url); assert.equal(slot(disk().ui.uikit, 'light').bgRotate, 0); assert.equal(slot(disk().ui.uikit, 'light').bgZoom, 1);
      assert.deepEqual(kernel.config.get().ui.uikit.custom, c.initial.custom);
    } finally { await c.close(); }
  });
  await check('old failure while the newest FileReader/upload remains pending cannot clear its selection', async () => {
    const c=await open();try{
      await c.upload('old-error');const old=await c.entered(1);old.fail=true;await c.upload('latest-pending');const latest=await c.entered(2);
      const before=await c.frame.locator('#status').textContent();await c.settle(old);
      assert.equal(await c.frame.locator('#section-uikit input[type=file]').evaluate(input=>input.files[0]?.name),'latest-pending.png');
      assert.equal(await c.frame.locator('#status').textContent(),before);
      await c.settle(latest);assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,latest.body.url);
    }finally{await c.close();}
  });
  await check('same-slot rename preserves a valid current upload and renamed scheme',async()=>{
    const c=await open();try{await c.upload('rename');const call=await c.entered(1);
      await c.frame.locator('#uikit-rename-A').fill('155 renamed');
      await c.frame.locator('.settings-list-row').filter({hasText:'155 A'}).getByRole('button',{name:'重命名',exact:true}).click();
      await c.settle(call);assert.equal(kernel.config.get().ui.uikit.mode,'custom:A');assert.equal(kernel.config.get().ui.uikit.custom.A.name,'155 renamed');
      assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,call.body.url,'renaming is not a replacement or cancellation of the selected background');
    }finally{await c.close();}
  });
  await check('same-slot color-only preset preserves a valid current background upload',async()=>{
    const c=await open();try{await c.upload('palette');const call=await c.entered(1);
      await c.frame.getByRole('button',{name:'Linear',exact:true}).click();await c.settle(call);
      assert.equal(kernel.config.get().ui.uikit.mode,'custom:A');assert.equal(slot(disk().ui.uikit,'custom:A').accent,'#5e6ad2');
      assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,call.body.url,'the color-only preset must not discard the selected background');
    }finally{await c.close();}
  });
  await check('another console saving ordinary settings cannot silently discard a valid same-slot upload',async()=>{
    const c=await open();try{await c.upload('external-save');const call=await c.entered(1);
      const response=await fetch(`${base}/api/config`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'upload155'},body:JSON.stringify({persona:{roleText:'QA155 another console'}})});assert.equal(response.status,200);
      await c.page.waitForTimeout(400);await c.settle(call);assert.equal(disk().persona.roleText,'QA155 another console');
      assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,call.body.url);
      assert.equal(await c.frame.locator('.bg-stage-img').getAttribute('src'),call.body.url,'the active visible preview receives the image');
      assert.equal(await c.frame.locator('.bg-stage-img').evaluate(img=>img.decode().then(()=>img.naturalWidth)),16);
    }finally{await c.close();}
  });

  await check('resetting the current whole scheme cancels its pending background selection', async () => {
    const c=await open();try{await c.upload('whole-reset');const call=await c.entered(1);
      const reset=c.frame.getByRole('button',{name:'把当前方案重置为暗色基准',exact:true});for(let i=0;i<3;i++)await reset.click();
      assert.equal(await c.frame.locator('dialog.confirm-panel').count(),0,'方案重置不再弹确认框');
      await c.settle(call);assert.equal(kernel.config.get().ui.uikit.mode,'custom:A');
      assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,'');assert.equal(slot(disk().ui.uikit,'custom:A').bgRotate,0);
    }finally{await c.close();}
  });
  await check('a real background removal saved by another console cancels the same-slot replacement',async()=>{
    const c=await open();try{await c.upload('remote-original');await c.settle(await c.entered(1));
      await c.upload('remote-replacement');const call=await c.entered(2);
      const response=await fetch(`${base}/api/config`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'upload155'},body:JSON.stringify({ui:{uikit:{custom:{A:{tokens:{bgImage:''}}}}}})});assert.equal(response.status,200);
      await c.frame.getByText('尚未选择背景',{exact:true}).waitFor({state:'visible'});await c.settle(call);
      assert.equal(kernel.config.get().ui.uikit.mode,'custom:A');assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,'');
    }finally{await c.close();}
  });
  await check('file picker opened before an ordinary same-slot refresh still starts its legitimate upload',async()=>{
    const c=await open();try{
      const promise=c.page.waitForEvent('filechooser');await c.frame.getByRole('button',{name:'选择图片或视频',exact:true}).click();const chooser=await promise;
      const response=await fetch(`${base}/api/config`,{method:'POST',headers:{'content-type':'application/json','x-console-token':'upload155'},body:JSON.stringify({persona:{roleText:'QA155 chooser other console'}})});assert.equal(response.status,200);
      for(let i=0;i<100&&await chooser.element().evaluate(input=>input.isConnected);i++)await c.page.waitForTimeout(20);
      assert.equal(await chooser.element().evaluate(input=>input.isConnected),false,'real config refresh replaces the former input while its picker is open');
      await chooser.setFiles({name:'picker-after-refresh.png',mimeType:'image/png',buffer:png});const call=await c.entered(1);await c.settle(call);
      assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,call.body.url);
      assert.equal(await c.frame.locator('.bg-stage-img').getAttribute('src'),call.body.url,'the active visible preview receives the image');
      assert.equal(await c.frame.locator('.bg-stage-img').evaluate(img=>img.decode().then(()=>img.naturalWidth)),16);
    }finally{await c.close();}
  });

  await check('a newer picker survives completion and redraw of an earlier same-slot upload',async()=>{
    const c=await open();try{await c.upload('earlier-pending');const earlier=await c.entered(1);
      const picker=c.page.waitForEvent('filechooser');await c.frame.getByRole('button',{name:'选择图片或视频',exact:true}).click();const chooser=await picker;
      await c.settle(earlier);assert.equal(await chooser.element().evaluate(input=>input.isConnected),false);
      await chooser.setFiles({name:'later-picker.png',mimeType:'image/png',buffer:png});const later=await c.entered(2);await c.settle(later);
      assert.notEqual(later.body.url,earlier.body.url);assert.equal(slot(disk().ui.uikit,'custom:A').bgImage,later.body.url);
    }finally{await c.close();}
  });
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: results, passed: results.every(r => r.passed) }));
  assert.equal(results.filter(r => !r.passed).length, 0, '155 all actual upload lifecycle cases');
  console.log('✓ 155 theme upload lifecycle: slot isolation, reader/leave/cancel, latest request, feedback, save/crop/disk passed');
} finally {
  await browser?.close(); await kernel.stop();isolation.assertEmpty(kernel);isolation.restore();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true });
}
