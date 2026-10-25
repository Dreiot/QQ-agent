import fs from 'node:fs';
import {settingsEditor} from './settings-navigation.mjs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel/kernel.js';
import { createConsoleAuth } from '../ui/shell/console-auth.js';
import { isSettingsSaveRequest, settingsSavePatch } from './settings-save-observation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellApp = fs.readFileSync(path.join(ROOT, 'ui', 'shell', 'app.js'), 'utf8');
const rpcBridge = fs.readFileSync(path.join(ROOT, 'ui', 'shell', 'rpc-bridge.js'), 'utf8');
const apiClient = fs.readFileSync(path.join(ROOT, 'ui', 'shell', 'api-client.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'panels', 'manifest.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
}
function section(message) { console.log(`· ${message}`); }

section('静态宿主安全回归');
// URL cleanup moved into console-auth; exercise the helper used by the shell
// rather than requiring its implementation to remain inline in app.js.
let cleanedLocation = null;
const authWindow = {
  location: new URL('http://127.0.0.1:23434/?token=browser-e2e-token&keep=1&token=duplicate#anchor'),
  sessionStorage: { removeItem() {} },
  history: { replaceState(_state, _title, value) { cleanedLocation = value; } },
};
authWindow.top = authWindow;
const bootstrapAuth = await createConsoleAuth(authWindow);
const cleanedBootstrapUrl = new URL(cleanedLocation, authWindow.location.origin);
check(shellApp.includes('await createConsoleAuth()') && bootstrapAuth.token === 'browser-e2e-token' && !cleanedBootstrapUrl.searchParams.has('token'), 'shell 认证模块清除全部 token 查询键');
check(cleanedBootstrapUrl.pathname === '/' && cleanedBootstrapUrl.searchParams.get('keep') === '1' && cleanedBootstrapUrl.hash === '#anchor', 'token 清理保留其它 query/hash');
check(shellApp.includes("const api=new ApiClient({token})"), 'token 只注入内存 API client');
check(rpcBridge.includes('event.source===this.frame.contentWindow') && rpcBridge.includes("event.origin==='null'"), 'RPC 绑定 iframe source 与 opaque origin');
check(rpcBridge.includes('this.allowed(method,path)') && rpcBridge.includes('未授权的面板 API'), 'RPC 拒绝不在 allowlist 的 API');
check(apiClient.includes("!path.startsWith('/api/')") && apiClient.includes("path.includes('..')"), 'HTTP API client 拒绝越界路径');
check(manifest.panels.length >= 8 && manifest.panels.every((panel) => panel.api.every((rule) => /^\/api(?:\/[A-Za-z0-9._~-]+|\/:id|\/:key|\/:uid)*$/.test(rule.path))), '所有面板 API 声明均在安全路径格式内');

let playwright = null;
for (const name of ['playwright', 'playwright-core']) {
  try {
    playwright = createRequire(import.meta.url)(name);
    console.log(`· 使用本地 ${name} 模块`);
    break;
  } catch {
    // 禁止在验收时安装依赖；只探测本机已有模块。
  }
}

let browser;
let kernel;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-m3-browser-'));
try {
  const env = { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0' };
  const appRoot=path.join(dataDir,'application');fs.mkdirSync(appRoot);fs.cpSync(path.join(ROOT,'ui'),path.join(appRoot,'ui'),{recursive:true});
  kernel = createKernel({ appRoot,env, headless: true,
    transport:{id:'qa34-inert',start(){},stop(){},status:()=>({connected:false}),actions:{}},
    priceUpdates:{refresh:async()=>({ok:true}),updateCheck:async()=>({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false})},
    communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})},fetchImpl:async()=>{throw new Error('QA34 no external source');}});
  kernel.config.update({ server: { port: 0, token: 'browser-e2e-token' },telemetry:{enabled:false},proactive:{enabled:false} });
  const port = await kernel.start();
  const base = `http://127.0.0.1:${port}`;

  section('隔离内核 HTTP 安全回归');
  const shellResponse = await fetch(`${base}/`);
  check(shellResponse.status === 200 && shellResponse.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'shell HTTP 响应具备 anti-frame CSP');
  check((await fetch(`${base}/api/status`)).status === 401, '无 token API 请求被拒绝');
  check((await fetch(`${base}/api/status`, { headers: { 'x-console-token': 'browser-e2e-token' } })).status === 200, '精确 token API 请求可用');

  if (!playwright) {
    console.log('· 未发现本地 Playwright，明确跳过真实浏览器断言（静态与隔离 HTTP 安全断言已执行）');
  } else {
    // 与 69/70/71/73 同口径：优先环境变量，其次本机已有的 ms-playwright Chromium。
    // 不指定 executablePath 会落到 playwright 自带的 headless shell——本机没装，
    // launch 直接报 Executable doesn't exist（验收环境不允许现场下载浏览器）。
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
    if (executablePath) console.log(`· 使用 Chromium：${executablePath}`);
    browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath && fs.existsSync(executablePath) ? { executablePath } : {}),
    });
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.__browserE2ESse = { requests: [], hello: false, events: [] };
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname !== '/api/events') return response;
        const headers = init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Array.isArray(init?.headers) ? Object.fromEntries(init.headers) : { ...(init?.headers ?? {}) };
        window.__browserE2ESse.requests.push({ url: url.href, headers });
        const reader = response.clone().body?.getReader();
        if (!reader) return response;
        void (async () => {
          const decoder = new TextDecoder(); let buffer = '', eventName = 'message', data = [];
          const emit = () => {
            if (!data.length) return;
            const payload = data.join('\n');
            if (eventName === 'hello') window.__browserE2ESse.hello = true;
            window.__browserE2ESse.events.push({ name: eventName, data: payload });
            eventName = 'message'; data = [];
          };
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              let line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line) { emit(); continue; }
              const separator = line.indexOf(':');
              const field = separator === -1 ? line : line.slice(0, separator);
              const valueText = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
              if (field === 'event') eventName = valueText;
              else if (field === 'data') data.push(valueText);
            }
          }
          emit();
        })();
        return response;
      };
    });

    section('真实 Chromium shell、iframe 与 token 地址栏清理');
    await page.goto(`${base}/?token=browser-e2e-token&keep=1#anchor`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#nav button').length === n, manifest.panels.length, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#panel-host iframe').length === 1, null, { timeout: 15000 });
    const cleanUrl = new URL(page.url());
    check(!cleanUrl.searchParams.has('token'), '真实地址栏不再包含 token');
    check(cleanUrl.searchParams.get('keep') === '1' && cleanUrl.hash === '#anchor', '真实地址栏保留其它 query/hash');
    check(await page.locator('#nav button').count() === manifest.panels.length, '真实 shell 渲染的面板入口数与 manifest 一致');

    const panelIds = manifest.panels.map((panel) => panel.id);
    for (const id of panelIds) {
      await page.locator(`#nav button[data-panel="${id}"]`).click();
      await page.waitForFunction((expected) => document.querySelector('#panel-host iframe')?.src.includes(`/panels/${expected}/`), id, { timeout: 10000 });
      const frame = page.locator('#panel-host iframe');
      const expectedSandbox=id==='settings'?'allow-scripts allow-modals':'allow-scripts';
      check(await frame.getAttribute('sandbox') === expectedSandbox, `${id} 使用精确的 opaque sandbox，仅默认设置允许离开确认`);
    }
    const currentFrame = await page.locator('#panel-host iframe').elementHandle().then((handle) => handle?.contentFrame());
    const storage = await currentFrame.evaluate(() => {
      try {
        return { values: [...Object.values(localStorage), ...Object.values(sessionStorage)], opaque: false };
      } catch (error) {
        return { values: [], opaque: error.name === 'SecurityError' };
      }
    });
    check(storage.opaque || !storage.values.some((value) => String(value).includes('browser-e2e-token')), 'sandbox iframe storage 不含 shell token');

    section('设置面板真实 RPC config load 与 leave flush');
    const configResponse = page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'GET' && response.status() === 200, { timeout: 15000 });
    await page.locator('#nav button[data-panel="settings"]').click();
    await configResponse;
    const settingsFrame = page.frameLocator('#panel-host iframe');
    await settingsFrame.locator('#status').filter({ hasText: '配置已读取（脱敏）' }).waitFor({ state: 'visible', timeout: 15000 });
    await settingsEditor(settingsFrame,'model-config');await settingsFrame.getByRole('switch',{name:'视频输入',exact:true}).click();await settingsFrame.locator('#field-api-videoMode').selectOption('native');
    const saveResponse = page.waitForResponse((response) => isSettingsSaveRequest(response.request()) && settingsSavePatch(response.request())?.api?.videoMode==='native' && response.status() === 200, { timeout: 15000 });
    await page.locator('#nav button[data-panel="sessions"]').click();
    await saveResponse;
    const savedConfig = await (await fetch(`${base}/api/config`, { headers: { 'x-console-token': 'browser-e2e-token' } })).json();
    check(savedConfig.api?.videoMode === 'native', '离开 settings 触发真实 RPC flush 保存配置');

    section('shell fetch-stream SSE URL、header、hello 与事件');
    await page.waitForFunction(() => window.__browserE2ESse?.requests.length === 1 && window.__browserE2ESse.hello === true, null, { timeout: 15000 });
    const shellSse = await page.evaluate(() => window.__browserE2ESse.requests[0]);
    check(!new URL(shellSse.url).searchParams.has('token'), 'shell SSE URL 不含 token');
    check(shellSse.headers['x-console-token'] === 'browser-e2e-token', 'shell SSE 使用 x-console-token header 认证');
    kernel.bus.emit('log', { level: 'info', text: 'browser-e2e' });
    await page.waitForFunction(() => window.__browserE2ESse.events.some((event) => event.name === 'log' && JSON.parse(event.data).text === 'browser-e2e'), null, { timeout: 10000 });
    check(await page.evaluate(() => window.__browserE2ESse.hello === true), '真实 shell fetch-stream 收到 SSE hello');
    check(await page.evaluate(() => window.__browserE2ESse.events.some((event) => event.name === 'log' && JSON.parse(event.data).text === 'browser-e2e')), '真实 shell fetch-stream 收到 SSE log 事件');

    await context.close();
    await browser.close();
    browser = null;
    console.log(`✓ 真实 Chromium 已执行：${passed} 通过，${failed} 失败`);
  }
} catch (error) {
  failed += 1;
  console.error(`  ✗ M3 浏览器验收失败：${error?.stack || error}`);
} finally {
  try { await browser?.close(); } catch {}
  try { await kernel?.stop(); } catch (error) { console.error(`  ! kernel cleanup: ${error?.message || error}`); }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

console.log(`${failed === 0 ? '✓' : '✗'} 34-m3-browser-e2e：${passed} 通过，${failed} 失败${playwright ? '' : '，浏览器未执行'}`);
process.exit(failed === 0 ? 0 : 1);
