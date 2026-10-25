import {settingsSection,settingsReload,settingsSave,settingsEditor,settingsControl} from './settings-navigation.mjs';
import {isSettingsSaveRequest, settingsSavePatch, SETTINGS_SAVE_ROUTE} from './settings-save-observation.mjs';
// Isolated real kernel + settings iframe. External services are controlled;
// the application under headed QA and its data are never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { FormState } from '../ui/panels/settings/form-state.js';
import { DEFAULT_THEME, DARK_BASE, PRESETS } from '../ui/panels/theme.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-reload117-'));
const appRoot=path.join(dataDir,'application');fs.mkdirSync(appRoot);fs.cpSync(path.resolve(import.meta.dirname,'../ui'),path.join(appRoot,'ui'),{recursive:true});
const kernel = createKernel({appRoot, env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0',QQ_AGENT_MIGRATE_FROM:path.join(dataDir,'absent') }, headless: true,
  transport: { id: 'fixture', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) }, communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) } });
let browser;
const errors = [], oldName = 'QA-117-SAVED', discardName = 'QA-117-DISCARD';
try {
  kernel.config.update({ server: { port: 0, token: 'reload117' }, telemetry: { enabled: false }, proactive: { enabled: false }, api: { video: true } });
  const port = await kernel.start();
  const playwright = createRequire(import.meta.url)('playwright-core');
  const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
  const versions = fs.readdirSync(cache).filter(v => /^chromium-\d+$/.test(v)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  browser = await playwright.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(v => path.join(cache, v, 'chrome-win64/chrome.exe')).find(f => fs.existsSync(f)), headless: true });
  async function open() {
    kernel.config.update({ persona: { botName: oldName } });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?token=reload117`);
    await page.locator('#nav button[data-panel=settings]').click();
    const frame = page.frameLocator('#panel-host iframe');
    await frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
    await settingsSection(frame,'persona');
    return { page, frame, input: frame.locator('#field-persona-botName'), confirm: frame.locator('dialog.confirm-panel') };
  }
  const diskName = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).persona.botName;
  async function askReload({ frame, input, confirm }) {
    await input.fill(discardName); await settingsReload(frame);
    await confirm.getByRole('button', { name: '确认', exact: true }).waitFor();
  }

  console.log('· Confirmation pauses the 700ms timer; accepted discard cannot autosave afterwards');
  {
    const c = await open(); await askReload(c);
    await c.page.waitForTimeout(1000);
    assert.equal(diskName(), oldName, 'pending changes must not be committed while discard confirmation is open');
    await c.confirm.getByRole('button', { name: '确认', exact: true }).click();
    await c.frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
    assert.equal(await c.input.inputValue(), oldName);
    await c.page.waitForTimeout(900); assert.equal(diskName(), oldName);
    await c.page.close();
  }
  console.log('· A fast accept also cancels the original pending timer');
  {
    const c = await open(); await askReload(c);
    await c.confirm.getByRole('button', { name: '确认', exact: true }).click();
    await c.frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
    await c.page.waitForTimeout(900);
    assert.equal(await c.input.inputValue(), oldName); assert.equal(diskName(), oldName);
    await c.page.close();
  }
  console.log('· Cancel preserves pending input and resumes ordinary autosave');
  {
    const c = await open(); await askReload(c); await c.page.waitForTimeout(1000);
    assert.equal(diskName(), oldName);
    await c.confirm.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await c.input.inputValue(), discardName); assert.equal(diskName(), oldName);
    await c.frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(diskName(), discardName); await c.page.close();
  }
  console.log('· Input entered while the confirmed reload request is delayed survives and is saved');
  {
    const c = await open(); let release, notify, held = false;
    const blocked = new Promise(resolve => release = resolve), entered = new Promise(resolve => notify = resolve);
    await c.page.route('**/api/config', async route => {
      if (!held && route.request().method() === 'GET') {
        held = true; const response = await route.fetch(); notify(); await blocked; await route.fulfill({ response });
      } else await route.continue();
    });
    try {
      await askReload(c); await c.confirm.getByRole('button', { name: '确认', exact: true }).click();
      await entered;
      assert.equal(await c.input.inputValue(), oldName, 'the accepted version is discarded before the network response');
      const newer = 'QA-117-NEW-DURING-RELOAD'; await c.input.fill(newer);
      release(); await c.page.waitForTimeout(150);
      assert.equal(await c.input.inputValue(), newer);
      await c.frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
      assert.equal(diskName(), newer);
    } finally { release(); await c.page.close(); }
  }
  console.log('· Ordinary provider actions still flush other pending settings before reloading');
  {
    const c = await open();
    await c.input.fill('QA-117-PROVIDER-FLUSH');
    await settingsEditor(c.frame,'model-manager');
    await c.frame.locator('[data-settings-open=provider-add]').click();
    await c.frame.locator('#provider-name').fill('QA-117-PROVIDER');
    await c.frame.locator('#provider-base').fill('https://example.invalid/v1');
    await c.frame.locator('dialog[data-settings-editor=provider-add]').getByRole('button',{name:'添加渠道',exact:true}).click();
    await c.frame.locator('#provider-manager-nav').getByText('QA-117-PROVIDER', { exact: true }).waitFor();
    assert.equal(diskName(), 'QA-117-PROVIDER-FLUSH'); assert.equal(await c.confirm.count(), 0);
    await c.page.close();
  }

  console.log('· A renamed provider refreshes with action focus, while a focused real input retains its node');
  {
    const providerId = 'qa-117-refresh', initialName = 'QA-117-CHANNEL-A', renamed = 'QA-117-CHANNEL-B', focusedName = 'QA-117-CHANNEL-C';
    kernel.config.update({ providers: [{ id: providerId, displayName: initialName, baseUrl: 'http://127.0.0.1:1/v1', baseURL: 'http://127.0.0.1:1/v1', models: ['qa-model'] }], api: { provider: providerId, model: 'qa-model', baseUrl: 'http://127.0.0.1:1/v1' } });
    const c = await open(); await c.page.emulateMedia({ reducedMotion: 'reduce' });
    await settingsEditor(c.frame,'model-manager');
    let nextRead = null;
    await c.page.route('**/api/providers', async route => {
      if (route.request().method() !== 'GET' || !nextRead) return route.continue();
      const read = nextRead; nextRead = null;
      const response = await route.fetch();
      assert.equal(response.status(), 200); assert.equal((await response.json()).providers[0].displayName, read.expected);
      read.entered(); await read.gate; await route.fulfill({ response });
    });
    function armRead(expected) {
      let release, entered;
      const read = { expected, gate: new Promise(resolve => release = resolve), held: new Promise(resolve => entered = resolve) };
      read.release = release; read.entered = entered; nextRead = read; return read;
    }
    async function watchProviderReply(expected) {
      await c.frame.locator('body').evaluate((_, name) => {
        window.qa117ProviderReplyProcessed = false;
        const listener = event => {
          const result = event.data?.result;
          if (event.data?.jsonrpc !== '2.0' || result.providers?.[0]?.displayName !== name) return;
          window.removeEventListener('message', listener);
          requestAnimationFrame(() => requestAnimationFrame(() => { window.qa117ProviderReplyProcessed = true; }));
        };
        window.addEventListener('message', listener);
      }, expected);
    }
    async function waitProviderReply() {
      await c.frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        function check() {
          if (window.qa117ProviderReplyProcessed) return resolve();
          if (performance.now() > deadline) return reject(new Error('the held provider reply did not settle in the actual panel'));
          requestAnimationFrame(check);
        }
        check();
      }));
    }
    async function renameProvider(name) {
      await c.frame.locator('#provider-list [data-provider-field=displayName]').fill(name);
      const read = armRead(name);
      const saved = c.page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers/update' && response.request().method() === 'POST' && response.request().postDataJSON()?.providerId === providerId && response.request().postDataJSON()?.changes?.displayName === name);
      await c.frame.locator('#provider-list .provider-model-head h4').click();
      assert.equal((await saved).status(),200);await read.held;
      assert.equal(kernel.config.get().providers[0].displayName, name);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).providers[0].displayName, name);
      return read;
    }
    let read;
    try {
      read = await renameProvider(renamed);
      await c.frame.locator('#provider-list').getByRole('button',{name:'添加模型',exact:true}).focus();
      await watchProviderReply(renamed); read.release(); await waitProviderReply();
      await c.frame.locator(`#provider-manager-nav [data-provider-id="${providerId}"]`).filter({hasText:renamed}).waitFor({ timeout: 5000 });
      assert.equal(await c.frame.locator(`#field-api-provider option[value="${providerId}"]`).textContent(), renamed);

      read = await renameProvider(focusedName);
      await settingsEditor(c.frame,'model-config');
      const input=await settingsControl(c.frame,'#field-api-videoMode');
      await input.focus(); await input.evaluate(node => { window.qa117FocusedModel = node; });
      await watchProviderReply(focusedName); read.release(); await waitProviderReply();
      assert.deepEqual(await input.evaluate(node => ({ same: node === window.qa117FocusedModel, connected: window.qa117FocusedModel.isConnected, focused: document.activeElement === node, value: node.value })), { same: true, connected: true, focused: true, value: 'auto' });
      await settingsReload(c.frame);
      await settingsEditor(c.frame,'model-manager');
      await c.frame.locator(`#provider-manager-nav [data-provider-id="${providerId}"]`).filter({hasText:focusedName}).waitFor();
      assert.equal(await c.frame.locator(`#field-api-provider option[value="${providerId}"]`).textContent(), focusedName);
    } finally { read?.release(); nextRead?.release(); await c.page.close(); }
  }

  console.log('· A pre-edit GET released after the newer save cannot revert the editor or its color target');
  {
    kernel.config.update({ ui: { uikit: { mode: 'custom:bright', custom: {
      bright: { name: 'QA-117 bright', tokens: { ...DEFAULT_THEME, ...PRESETS.light.tokens } },
      dark: { name: 'QA-117 dark', tokens: { ...DEFAULT_THEME, ...DARK_BASE } },
    } } } });
    const c = await open();
    await settingsSection(c.frame,'interface');
    let release, notify, held = false;
    const blocked = new Promise(resolve => release = resolve), entered = new Promise(resolve => notify = resolve);
    await c.page.route('**/api/config', async route => {
      if (!held && route.request().method() === 'GET') {
        held = true; const response = await route.fetch();
        assert.equal(response.status(), 200); assert.equal((await response.json()).ui.uikit.mode, 'custom:bright');
        notify(); await blocked; await route.fulfill({ response });
      } else await route.continue();
    });
    try {
      await c.frame.locator('#save').focus();
      await c.frame.locator('#field-ui-uikit-mode').evaluate(node => {
        window.qa117ModeBeforeOldRead = node;
        window.qa117OldReadProcessed = false;
        const listener = event => {
          if (event.data?.jsonrpc !== '2.0' || event.data?.result?.ui?.uikit?.mode !== 'custom:bright') return;
          window.removeEventListener('message', listener);
          // The actual panel-client resolver runs in this same event. Two paint
          // boundaries allow its Promise.all and load continuation to finish.
          requestAnimationFrame(() => requestAnimationFrame(() => { window.qa117OldReadProcessed = true; }));
        };
        window.addEventListener('message', listener);
      });
      kernel.bus.emit('status', { configUpdated: true });
      await entered;
      const saved = c.page.waitForResponse(response => isSettingsSaveRequest(response.request()) && settingsSavePatch(response.request())?.ui?.uikit?.mode === 'custom:dark');
      await c.frame.locator('#field-ui-uikit-mode').selectOption('custom:dark');
      await settingsSave(c.frame);
      assert.equal((await saved).status(), 200);
      await c.frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
      assert.equal(kernel.config.get().ui.uikit.mode, 'custom:dark');
      const oldReply = c.page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET');
      release(); await oldReply;
      await c.frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        function check() {
          if (window.qa117OldReadProcessed) return resolve();
          if (performance.now() > deadline) return reject(new Error('the held configuration reply did not settle in the actual panel'));
          requestAnimationFrame(check);
        }
        check();
      }));
      const after = await c.frame.locator('#field-ui-uikit-mode').evaluate(node => ({
        oldNodeConnected: window.qa117ModeBeforeOldRead.isConnected,
        sameNode: node === window.qa117ModeBeforeOldRead,
        mode: node.value,
        accentTarget: document.querySelector('#field-uikit-accent').dataset.configPath,
      }));
      console.log('  delayed GET state:', JSON.stringify(after));
      assert.equal(after.oldNodeConnected, true, 'a stale response must not rebuild the current editor');
      assert.equal(after.sameNode, true);
      assert.equal(after.mode, 'custom:dark');
      assert.equal(after.accentTarget, 'ui.uikit.custom.dark.tokens.accent');
      assert.equal(kernel.config.get().ui.uikit.mode, 'custom:dark');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).ui.uikit.mode, 'custom:dark');

      const freshName = 'QA-117-FRESH-AFTER-STALE';
      const freshReply = c.page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET');
      kernel.config.update({ persona: { botName: freshName } });
      kernel.bus.emit('status', { configUpdated: true });
      await freshReply;
      await c.frame.locator('body').evaluate((_, expected) => new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        function check() {
          if (document.querySelector('#field-persona-botName')?.value === expected) return resolve();
          if (performance.now() > deadline) return reject(new Error('a fresh authoritative configuration did not reach the editor'));
          requestAnimationFrame(check);
        }
        check();
      }), freshName);
      assert.equal(await c.frame.locator('#field-ui-uikit-mode').inputValue(), 'custom:dark');
      assert.equal(await c.frame.locator('#field-uikit-accent').getAttribute('data-config-path'), 'ui.uikit.custom.dark.tokens.accent');
      assert.equal(kernel.config.get().persona.botName, freshName);
    } finally { release(); await c.page.close(); }
  }

  console.log('· A confirmed reload racing the same input version save reads fresh authority after the acknowledgement');
  {
    kernel.config.update({ ui: { uikit: { mode: 'custom:bright' } } });
    const c = await open();
    await settingsSection(c.frame,'interface');
    let releasePost, releaseGet, enteredPost, enteredGet, heldPost = false, heldGet = false, getReads = 0, darkPosts = 0;
    await c.page.evaluate(()=>{window.qa117ConfigReads=0;window.addEventListener('message',event=>{const m=event.data;if(event.source===document.querySelector('#panel-host iframe')?.contentWindow&&event.origin==='null'&&m?.method==='api.request'&&m.meta?.panel==='settings'&&m.params?.method==='GET'&&m.params?.path==='/api/config')window.qa117ConfigReads++;});});
    const postGate = new Promise(resolve => releasePost = resolve), getGate = new Promise(resolve => releaseGet = resolve);
    const postEntered = new Promise(resolve => enteredPost = resolve), getEntered = new Promise(resolve => enteredGet = resolve);
    await c.page.route(SETTINGS_SAVE_ROUTE, async route => {
      if (isSettingsSaveRequest(route.request()) && settingsSavePatch(route.request())?.ui?.uikit?.mode === 'custom:dark') {
        ++darkPosts;
        if (!heldPost) { heldPost = true; enteredPost(); await postGate; }
      } else if (route.request().method() === 'GET') {
        ++getReads;
        if (!heldGet) {
          heldGet = true; const response = await route.fetch();
          assert.equal(response.status(), 200); assert.equal((await response.json()).ui.uikit.mode, 'custom:bright');
          enteredGet(); await getGate; await route.fulfill({ response }); return;
        }
      }
      await route.continue();
    });
    try {
      const saved = c.page.waitForResponse(response => isSettingsSaveRequest(response.request()) && settingsSavePatch(response.request())?.ui?.uikit?.mode === 'custom:dark');
      await c.frame.locator('#field-ui-uikit-mode').selectOption('custom:dark');
      await settingsSave(c.frame); await postEntered;
      await settingsReload(c.frame);
      await c.confirm.getByRole('button', { name: '确认', exact: true }).click();
      await getEntered;
      // No newer input is entered: confirmation discards the same version,
      // while the already issued save can still acknowledge after this read.
      assert.equal(await c.frame.locator('#field-ui-uikit-mode').inputValue(), 'custom:bright');
      releasePost(); assert.equal((await saved).status(), 200);
      await c.frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
      assert.equal(kernel.config.get().ui.uikit.mode, 'custom:dark');
      await c.frame.locator('#save').focus();
      const fresh = c.page.waitForResponse(async response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'GET' && (await response.json()).ui.uikit.mode === 'custom:dark');
      releaseGet(); assert.equal((await fresh).status(), 200);
      await c.frame.locator('#status').filter({ hasText: '配置已读取' }).waitFor();
      assert.equal(await c.frame.locator('#field-ui-uikit-mode').inputValue(), 'custom:dark');
      assert.equal(await c.frame.locator('#field-uikit-accent').getAttribute('data-config-path'), 'ui.uikit.custom.dark.tokens.accent');
      assert.equal(kernel.config.get().ui.uikit.mode, 'custom:dark');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).ui.uikit.mode, 'custom:dark');
      assert.equal(darkPosts, 1, 'confirmed reload must not duplicate the already issued save');
      assert.equal(await c.page.evaluate(()=>window.qa117ConfigReads),2,'settings still performs only the stale read and one fresh read, without a refresh loop');
      assert.equal(getReads,3,'the third read is the host immediate config reconciliation after the accepted save');
    } finally { releasePost(); releaseGet(); await c.page.close(); }
  }

  console.log('· Saved tool overrides refresh runtime reasons without rebuilding focused controls');
  {
    const echoId = 'qa_117_status_echo', missingId = 'qa_117_status_missing';
    kernel.registry.register({ id: echoId, name: 'QA 117 status echo', category: 'system', execute: () => 'synthetic' });
    kernel.registry.register({ id: missingId, name: 'QA 117 missing capability', category: 'system', requires: ['qa117.never-provided'], execute: () => 'never executed' });
    kernel.config.update({ tools: { enabled: true, categories: { system: true }, overrides: { [echoId]: false } } });
    const c = await open(); c.page.setDefaultTimeout(8000);
    await settingsSection(c.frame,'tools');
    const tool = id => c.frame.locator('#tool-list label').filter({ hasText: `· ${id}` });
    const echo = tool(echoId), missing = tool(missingId), checkbox = echo.locator('input');
    const expectReason = (card, reason) => card.locator('small').filter({ hasText: reason }).waitFor({ state: 'attached', timeout: 4000 });
    const saveFor = predicate => c.page.waitForResponse(response => isSettingsSaveRequest(response.request()) && predicate(settingsSavePatch(response.request())));
    let configReads = 0, catalogReads = 0, stateReads = 0;
    await c.page.evaluate(()=>{window.qa117ConfigReads=0;window.addEventListener('message',event=>{const m=event.data;if(event.source===document.querySelector('#panel-host iframe')?.contentWindow&&event.origin==='null'&&m?.method==='api.request'&&m.meta?.panel==='settings'&&m.params?.method==='GET'&&m.params?.path==='/api/config')window.qa117ConfigReads++;});});
    c.page.on('request', request => {
      if (request.method() !== 'GET') return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/config') ++configReads;
      if (pathname === '/api/tools') ++catalogReads;
      if (pathname === '/api/tools/availability') ++stateReads;
    });
    try {
      await expectReason(echo, '该工具已被单独关闭'); await expectReason(missing, '缺少能力：qa117.never-provided');
      await checkbox.evaluate(node => { window.qa117ToolControl = node; window.qa117ToolRow = node.parentElement; });
      const enabled = saveFor(patch => patch.tools?.overrides?.[echoId] === true);
      await checkbox.check(); assert.equal((await enabled).status(), 200);
      await c.frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
      assert.equal(kernel.config.get().tools.overrides[echoId], true);
      await expectReason(echo, '当前可用');
      assert.deepEqual(await checkbox.evaluate(node => ({ same: node === window.qa117ToolControl, rowSame: node.parentElement === window.qa117ToolRow, connected: node.isConnected, focused: document.activeElement === node, checked: node.checked })), { same: true, rowSame: true, connected: true, focused: true, checked: true });
      assert.equal(stateReads, 1, 'one small authoritative state read follows the save');
      assert.equal(await c.page.evaluate(()=>window.qa117ConfigReads),0,'saving must not reload the whole config form');assert.equal(configReads,1,'one host reconciliation reads updated runtime configuration');assert.equal(catalogReads, 0, 'saving must not reload the tool catalog');
      console.log('  ✓ individual override / actual saved state / focused node identity');

      for (const [path, value, reason] of [
        ['tools.categories.system', false, '分类「system」已关闭'], ['tools.categories.system', true, '当前可用'],
        ['tools.enabled', false, '工具系统已关闭'], ['tools.enabled', true, '当前可用'],
      ]) {
        const control = await settingsControl(c.frame,`[data-config-path="${path}"]`);
        const saved = saveFor(patch => path === 'tools.enabled' ? patch.tools?.enabled === value : patch.tools?.categories?.system === value);
        await control.setChecked(value); assert.equal((await saved).status(), 200);
        await c.frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor(); await expectReason(echo, reason);
        await expectReason(missing, path === 'tools.enabled' && !value ? '工具系统已关闭' : '缺少能力：qa117.never-provided');
      }
      console.log('  ✓ category/global switches and real missing capability remain authoritative');

      // Hold an actual older state response until a newer override has committed
      // and rendered. The old response may not undo the new runtime reason.
      let releaseOld, enteredOld, held = false;
      const oldGate = new Promise(resolve => releaseOld = resolve), oldEntered = new Promise(resolve => enteredOld = resolve);
      await c.page.route('**/api/tools/availability', async route => {
        if (!held) {
          held = true; const response = await route.fetch();
          assert.equal((await response.json()).tools.find(item => item.id === echoId).enabled, false);
          enteredOld(); await oldGate; await route.fulfill({ response });
        } else await route.continue();
      });
      try {
        const disabled = saveFor(patch => patch.tools?.overrides?.[echoId] === false);
        await checkbox.uncheck(); assert.equal((await disabled).status(), 200); await oldEntered;
        const restored = saveFor(patch => patch.tools?.overrides?.[echoId] === true);
        await checkbox.check(); assert.equal((await restored).status(), 200); await expectReason(echo, '当前可用');
        await checkbox.evaluate((node, id) => {
          window.qa117OldToolStateProcessed = false;
          const listener = event => {
            if (!event.data?.result?.tools?.some(item => item.id === id && item.enabled === false)) return;
            window.removeEventListener('message', listener);
            requestAnimationFrame(() => requestAnimationFrame(() => { window.qa117OldToolStateProcessed = true; }));
          };
          window.addEventListener('message', listener);
        }, echoId);
        const oldReply = c.page.waitForResponse(response => new URL(response.url()).pathname === '/api/tools/availability');
        releaseOld(); await oldReply;
        await c.frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
          const deadline = performance.now() + 5000;
          const check = () => window.qa117OldToolStateProcessed ? resolve() : performance.now() > deadline ? reject(new Error('held old tool state did not reach the panel')) : requestAnimationFrame(check);
          check();
        }));
        assert.equal(await echo.locator('small').textContent(), '当前可用');
        assert.equal(await checkbox.evaluate(node => node === window.qa117ToolControl && document.activeElement === node && node.checked), true);
      } finally { releaseOld(); await c.page.unroute('**/api/tools/availability'); }
      console.log('  ✓ delayed older state cannot revert a newer saved override');

      let releaseDraft, enteredDraft;
      const draftGate = new Promise(resolve => releaseDraft = resolve), draftEntered = new Promise(resolve => enteredDraft = resolve);
      await c.page.route('**/api/tools/availability', async route => {
        const response = await route.fetch(); enteredDraft(); await draftGate; await route.fulfill({ response });
      });
      try {
        const disabled = saveFor(patch => patch.tools?.overrides?.[echoId] === false);
        await checkbox.uncheck(); assert.equal((await disabled).status(), 200); await draftEntered;
        await settingsSection(c.frame,'persona');
        await c.input.fill('QA-117-DRAFT-DURING-TOOL-STATE');
        await c.input.evaluate(node => { window.qa117ToolStateDraft = node; });
        releaseDraft(); await expectReason(echo, '该工具已被单独关闭');
        assert.deepEqual(await c.input.evaluate(node => ({ same: node === window.qa117ToolStateDraft, focused: document.activeElement === node, value: node.value })), { same: true, focused: true, value: 'QA-117-DRAFT-DURING-TOOL-STATE' });
        await c.frame.locator('#status').filter({ hasText: /^已保存/ }).waitFor();
      } finally { releaseDraft(); await c.page.unroute('**/api/tools/availability'); }
      console.log('  ✓ unrelated focused draft survives delayed runtime-state updates');

      await settingsSection(c.frame,'tools');
      await c.page.route('**/api/tools/availability', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA-117-synthetic-state-read-failure' }) }));
      const failedReadSave = saveFor(patch => patch.tools?.overrides?.[echoId] === true);
      await checkbox.check(); assert.equal((await failedReadSave).status(), 200);
      await expectReason(echo, '状态刷新失败，请重新读取');
      assert.equal(kernel.config.get().tools.overrides[echoId], true, 'a state read failure must not roll back an accepted config save');
      await c.page.unroute('**/api/tools/availability');
      const recoverySave = saveFor(patch => patch.tools?.overrides?.[echoId] === false);
      await checkbox.uncheck(); assert.equal((await recoverySave).status(), 200); await expectReason(echo, '该工具已被单独关闭');
      console.log('  ✓ failed state read is explicit and the next save recovers');

      const readsBefore = [await c.page.evaluate(()=>window.qa117ConfigReads), catalogReads, stateReads];
      await checkbox.evaluate(() => {
        window.qa117PlainStatusObserved = false;
        const listener = event => {
          if (event.data?.params?.payload?.qa117LastPlainStatus !== true) return;
          window.removeEventListener('message', listener);
          requestAnimationFrame(() => requestAnimationFrame(() => { window.qa117PlainStatusObserved = true; }));
        };
        window.addEventListener('message', listener);
      });
      for (let i = 0; i < 20; ++i) kernel.bus.emit('status', { qa117LastPlainStatus: i === 19 });
      await c.frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const check = () => window.qa117PlainStatusObserved ? resolve() : performance.now() > deadline ? reject(new Error('plain status burst did not reach the panel')) : requestAnimationFrame(check);
        check();
      }));
      assert.deepEqual([await c.page.evaluate(()=>window.qa117ConfigReads), catalogReads, stateReads], readsBefore, 'ordinary SSE status bursts add no form/catalog/state reads');
      console.log('  ✓ no extra reads or full form refresh for ordinary SSE status');
    } finally { await c.page.close(); kernel.registry.unregister(echoId); kernel.registry.unregister(missingId); }
  }

  console.log('· Tool state survives partial-save failure, nonblocking reset charging and a focused overlapping reload');
  {
    const id = 'qa_117_boundary_echo', failures = [];
    kernel.registry.register({ id, name: 'QA 117 boundary echo', category: 'system', execute: () => 'synthetic' });
    const openToolCase = async () => {
      kernel.config.update({ tools: { enabled: true, categories: { system: true }, overrides: { [id]: false } } });
      const c = await open(); c.page.setDefaultTimeout(8000);
      await settingsSection(c.frame,'tools');
      c.tool = c.frame.locator('#tool-list label').filter({ hasText: `· ${id}` }); c.checkbox = c.tool.locator('input');
      await c.checkbox.evaluate(node => { window.qa117BoundaryControl = node; });
      c.expectAvailable = () => c.tool.locator('small').filter({ hasText: '当前可用' }).waitFor({ state: 'attached', timeout: 4000 });
      c.watchReply = async (key, kind) => c.checkbox.evaluate((node, [key, kind, id]) => {
        window[key] = false;
        const listener = event => {
          const result = event.data?.result;
          if (kind === 'config' ? result?.tools?.overrides?.[id] !== true : !Array.isArray(result?.tools) || !result.tools.some(item => item.id === id)) return;
          window.removeEventListener('message', listener);
          requestAnimationFrame(() => requestAnimationFrame(() => { window[key] = true; }));
        };
        window.addEventListener('message', listener);
      }, [key, kind, id]);
      c.waitReply = key => c.frame.locator('body').evaluate((_, key) => new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const check = () => window[key] ? resolve() : performance.now() > deadline ? reject(new Error(`reply ${key} did not settle in panel`)) : requestAnimationFrame(check);
        check();
      }), key);
      return c;
    };
    const boundary = async (name, task) => {
      try { await task(); console.log(`  ✓ ${name}`); }
      catch (error) { failures.push({ name, error: error.message }); console.error(`  ✗ ${name}: ${error.message}`); }
    };
    try {
      await boundary('accepted tool save still refreshes when the next draft save fails', async () => {
        const c = await openToolCase(); let release, entered, held = false;
        const gate = new Promise(resolve => release = resolve), posted = new Promise(resolve => entered = resolve);
        await c.page.route(SETTINGS_SAVE_ROUTE, async route => {
          const body = settingsSavePatch(route.request());
          if (isSettingsSaveRequest(route.request()) && body?.persona?.botName === 'QA-117-LATER-SAVE-FAIL') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA-117-later-save-failure' }) });
          if (!held && isSettingsSaveRequest(route.request()) && body?.tools?.overrides?.[id] === true) {
            held = true; const response = await route.fetch(); assert.equal(response.status(), 200); entered(); await gate; return route.fulfill({ response });
          }
          await route.continue();
        });
        try {
          await c.checkbox.check(); await posted;
          await settingsSection(c.frame,'persona'); await c.input.fill('QA-117-LATER-SAVE-FAIL');
          release(); await c.frame.locator('#status').filter({ hasText: 'QA-117-later-save-failure' }).waitFor();
          const failedStatus = await c.frame.locator('#status').textContent();
          assert.equal(kernel.config.get().tools.overrides[id], true);
          assert.equal(kernel.config.get().persona.botName, oldName, 'the rejected second draft is not accepted');
          await c.expectAvailable();
          assert.equal(await c.input.inputValue(), 'QA-117-LATER-SAVE-FAIL');
          assert.equal(await c.frame.locator('#status').textContent(), failedStatus, 'refresh must retain the actual save failure');
        } finally { release(); await c.page.close(); }
      });
      await boundary('partial reset remains nonblocking and Escape or decay preserves one completed-save state refresh', async () => {
        for (const cancel of ['Escape', 'decay']) {
          const c = await openToolCase(); let release, entered, held = false, stateReads = 0, resetPosts = 0;
          const gate = new Promise(resolve => release = resolve), posted = new Promise(resolve => entered = resolve);
          c.page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname === '/api/tools/availability') ++stateReads; if (pathname === '/api/reset-data' && request.method() === 'POST') ++resetPosts; });
          await c.watchReply('qa117ResetStateReply', 'state');
          await c.page.route(SETTINGS_SAVE_ROUTE, async route => {
            if (!held && isSettingsSaveRequest(route.request())) { held = true; const response = await route.fetch(); entered(); await gate; return route.fulfill({ response }); }
            await route.continue();
          });
          try {
            await c.checkbox.check(); await posted;await settingsSection(c.frame,'reset'); const reset = c.frame.locator('#reset'); await reset.click();
            const charged = Number(await reset.getAttribute('data-danger-progress')); assert.ok(charged > 0 && charged < 1);
            assert.equal(await c.confirm.count(), 0, 'partial charging has no modal confirmation');
            assert.equal(await c.frame.locator('#fields').evaluate(node => node.inert), false, 'partial charging never takes ownership of the settings form');
            assert.equal(await c.checkbox.isEnabled(), true); assert.equal(await c.frame.locator('#save').isEnabled(), true); assert.equal(await c.frame.locator('#reload').isEnabled(), true);
            assert.equal(stateReads, 0, 'the held save has not yet reached its accepted client boundary');
            if (cancel === 'Escape') await c.page.keyboard.press('Escape');
            await c.frame.locator('#reset[data-danger-progress="0"]').waitFor({ state: 'attached' });
            assert.equal(resetPosts, 0, `${cancel} clears partial progress without submitting a reset`);
            release(); await c.waitReply('qa117ResetStateReply'); await c.expectAvailable();
            assert.equal(stateReads, 1, 'the accepted in-flight save triggers exactly one state refresh after charging is cancelled');
            assert.equal(await c.checkbox.evaluate(node => node === window.qa117BoundaryControl && node.checked), true);
          } finally { release(); await c.page.close(); }
        }
      });
      await boundary('overlapping reload updates runtime text even when an existing input takes focus', async () => {
        const c = await openToolCase(); let releaseState, enteredState, releaseConfig, enteredConfig, heldState = false, heldConfig = false;
        const stateGate = new Promise(resolve => releaseState = resolve), stateEntered = new Promise(resolve => enteredState = resolve);
        const configGate = new Promise(resolve => releaseConfig = resolve), configEntered = new Promise(resolve => enteredConfig = resolve);
        await c.page.route('**/api/tools/availability', async route => {
          if (!heldState) { heldState = true; const response = await route.fetch(); enteredState(); await stateGate; return route.fulfill({ response }); }
          await route.continue();
        });
        try {
          const hostApplied=c.page.waitForResponse(async response=>new URL(response.url()).pathname==='/api/config'&&response.request().method()==='GET'&&(await response.json()).tools?.overrides?.[id]===true);hostApplied.catch(()=>{});
          await c.checkbox.check(); await stateEntered;
          // The new host reconciliation is independent of this panel reload.
          // Complete it first, then gate the actual reload response as before.
          await hostApplied;
          await c.page.route('**/api/config', async route => {
            if (!heldConfig && route.request().method() === 'GET') { heldConfig = true; const response = await route.fetch(); enteredConfig(); await configGate; return route.fulfill({ response }); }
            await route.continue();
          });
          const fullState = c.page.waitForResponse(response => new URL(response.url()).pathname === '/api/tools/availability');
          await settingsReload(c.frame); await configEntered; await fullState;
          await c.checkbox.focus(); await c.watchReply('qa117FocusedReloadReply', 'config');
          releaseConfig(); await c.waitReply('qa117FocusedReloadReply');
          await c.watchReply('qa117OlderPartialReply', 'state'); releaseState(); await c.waitReply('qa117OlderPartialReply');
          await c.expectAvailable();
          assert.equal(await c.checkbox.evaluate(node => node === window.qa117BoundaryControl && document.activeElement === node && node.checked), true);
        } finally { releaseState(); releaseConfig(); await c.page.close(); }
      });
      assert.deepEqual(failures, [], 'all tool-state lifecycle boundaries must pass');
    } finally { kernel.registry.unregister(id); }
  }

  // The confirmation snapshot owns only its versions, never later input.
  const form = new FormState({ persona: { botName: oldName, roleText: 'saved role' } });
  form.set('persona.botName', discardName); form.set('persona.roleText', 'discard role');
  const snapshot = form.snapshot(); form.set('persona.botName', 'newer version');
  form.discardPending(snapshot);
  assert.equal(form.value('persona.botName'), 'newer version');
  assert.equal(form.value('persona.roleText'), 'saved role'); assert.equal(form.pending.size, 1);
  assert.deepEqual(errors, []);
  console.log('✓ 117 actual reload confirmation/timer/cancel/new-input/provider workflow and version discard passed');
} finally {
  await browser?.close(); await kernel.stop();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true });
}
