/** Electron desktop entrypoint for the thin QQ Agent shell. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, resolveProfile } from '../src/kernel/env.js';
import { defaultComponents } from '../bundled/runtime-defaults/components.js';
import { createCompositionLifecycle } from '../src/kernel/composition-lifecycle.js';
import {createRendererLeave} from './renderer-leave.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));


const APP_USER_MODEL_ID = 'cn.kondius.qq-agent';

const EMPTY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const LOGIN_PROFILE_PREFIX = '--qq-agent-profile=';
const LOGIN_DATA_PREFIX = '--qq-agent-data-dir=';
const captchaSessions = new WeakSet();
const CAPTCHA_PROBE_TARGETS = Object.freeze([
  'https://o.alicdn.com/',
  'https://captcha.cn-shanghai.aliyuncs.com/',
  'https://www.aliyun.com/',
  'https://kondius.cn/qq-agent/captcha-api/',
]);
const CAPTCHA_PROBE_TIMEOUT_MS = 5000;
const captchaInterceptorState = {
  installed: false,
  registeredAt: null,
  lastError: null,
  requestCount: 0,
  redirectCount: 0,
  lastRedirectAt: null,
};
// The desktop renderer receives the console token through a narrow, main-frame-only
// IPC bridge. It is never serialized into a navigation URL.
const consoleTokens = new WeakMap();
let bootstrapHandlerInstalled = false;
let bootstrapIpc = null;
let desktopIpc = null;
let desktopIpcCleanup = null;

let mainWindow = null;
let tray = null;
let kernel = null;
let startupCompositionLifecycle = null;
let runtime = null;
let shuttingDown = false;
let appRef = null;
let dialogRef = null;
const rendererLeave=createRendererLeave({getWindow:()=>mainWindow,allowFrame:(contents,frame)=>{try{const url=new URL(frame.url);return url.origin===consoleTokens.get(contents)?.origin&&url.pathname==='/';}catch{return false;}}});

let reloadPromise=null;
function reloadMainWindow(contents){
  if(shutdownPromise)return shutdownPromise;
  if(reloadPromise)return reloadPromise;
  reloadPromise=(async()=>{const result=await rendererLeave.prepare('reload');
    if(result.ok&&!shutdownPromise&&senderIsMainWindow(contents))contents.reloadIgnoringCache?.();
    else if(!result.ok)dialogRef?.showErrorBox?.('QQ Agent 暂未刷新',result.error);
    return result;
  })().finally(()=>{reloadPromise=null;});return reloadPromise;
}


let shutdownPromise = null;
let fatalHandlersInstalled = false;
let desktopConfigCleanup = null;
let appliedAutoStart;
const reportedStartupFailures = new Set();

function appendBootDiag(stage, detail = '') {
  const line = `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ''}\n`;
  try {
    if (runtime?.diagFile) fs.appendFileSync(runtime.diagFile, line, 'utf8');
    else fs.appendFileSync(path.join(APP_ROOT, 'boot-diag.log'), line, 'utf8');
  } catch { /* diagnostics must never block startup */ }
}

function nonEmptyDirectory(dir) {
  try { return fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch { return false; }
}

// These two internal login-item arguments restore the already resolved instance
// after OS login, overriding an unrelated globally inherited instance setting.
// No other Electron/Chromium flag or temporary port override is carried over.
export function resolveLoginItemEnvironment(argv = process.argv.slice(1), env = process.env) {
  const bound = {};
  for (const raw of argv) {
    const arg = String(raw);
    if (arg.startsWith(LOGIN_PROFILE_PREFIX)) {
      const value = arg.slice(LOGIN_PROFILE_PREFIX.length);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('开机自启 profile 参数必须是正整数');
      if (Object.hasOwn(bound, 'QQ_AGENT_PROFILE')) throw new Error('开机自启 profile 参数重复');
      bound.QQ_AGENT_PROFILE = String(Number(value));
    } else if (arg.startsWith(LOGIN_DATA_PREFIX)) {
      const value = arg.slice(LOGIN_DATA_PREFIX.length);
      if (!value.trim() || value.includes('\0')) throw new Error('开机自启 dataDir 参数必须是非空路径');
      if (Object.hasOwn(bound, 'QQ_AGENT_DATA_DIR')) throw new Error('开机自启 dataDir 参数重复');
      bound.QQ_AGENT_DATA_DIR = path.resolve(value);
    }
  }
  return { ...env, ...bound };
}

export function loginItemSettings(app, {
  autoStart = currentAutoStart(), profile = runtime?.profile, dataDir = runtime?.dataDir,
  appRoot = APP_ROOT, execPath = process.execPath, platform = process.platform,
} = {}) {
  const n = profile?.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1 || !String(dataDir ?? '').trim()) throw new Error('开机自启实例身份无效');
  const args = [
    ...(!app.isPackaged ? [path.resolve(appRoot)] : []),
    `${LOGIN_PROFILE_PREFIX}${n}`, `${LOGIN_DATA_PREFIX}${path.resolve(dataDir)}`,
  ].map(value => {
    // Electron joins login-item args into a Windows Run command line. Unlike
    // spawn's ordinary argv mode, setLoginItemSettings requires path quoting.
    if (platform !== 'win32' || !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  });
  // Windows uses one Run key per name. Distinct profiles must not overwrite
  // each other's login entries; profile 1 retains Electron's ordinary name.
  return { openAtLogin: Boolean(autoStart), path: execPath, args,
    name: n === 1 ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.profile-${n}` };
}

export function resolveElectronDataDir(electronApp, env = process.env, appRoot = APP_ROOT) {
  const profile = resolveProfile(env);
  if (env.QQ_AGENT_DATA_DIR) return { profile, dataDir: path.resolve(env.QQ_AGENT_DATA_DIR), source: 'env' };
  const suffix = profile.suffix;
  const unpacked = path.join(appRoot, `data${suffix}`);
  const packagedRoot = path.dirname(electronApp.getPath('exe') ?? appRoot);
  const packaged = path.join(packagedRoot, `data${suffix}`);
  const dataDir = electronApp.isPackaged ? packaged : unpacked;
  return { profile, dataDir, source: electronApp.isPackaged ? 'exe' : 'app-root' };
}

export function configureUserData(electronApp, env = process.env, appRoot = APP_ROOT, { components = defaultComponents, composition = null, lifecycle = null } = {}) {
  const resolved = resolveElectronDataDir(electronApp, env, appRoot);
  const preflight = (name, options) => {
    const value = components[name]({ ...options, components, composition, lifecycle });
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError(`Desktop preflight component ${name} must be synchronous`);
    }
    return value;
  };
  const personaText = preflight('runtime.persona.text', { appRoot });
  // Chromium must not create/open its cache before pending reset removes it.
  const defaults = preflight('runtime.config.defaults', { portOffset: resolved.profile.portOffset, personaText });
  preflight('runtime.reset.complete', { dataDir: resolved.dataDir, defaults });
  const appData = electronApp.getPath('appData');
  const legacy = path.join(appData, 'qq-agent', 'data');
  if (resolved.profile.n === 1 && !nonEmptyDirectory(resolved.dataDir) && nonEmptyDirectory(legacy) && path.resolve(legacy) !== path.resolve(resolved.dataDir)) {
    fs.mkdirSync(path.dirname(resolved.dataDir), { recursive: true });
    fs.cpSync(legacy, resolved.dataDir, { recursive: true, force: false });
  }
  fs.mkdirSync(resolved.dataDir, { recursive: true });
  const userData = path.join(resolved.dataDir, 'electron-user-data');
  electronApp.setPath('userData', userData);
  process.env.QQ_AGENT_DATA_DIR = resolved.dataDir;
  // Third-party runtimes stay beside the installed executable, outside the
  // shipped application/resources tree. A caller may choose another directory.
  if(electronApp.isPackaged&&!process.env.QQ_AGENT_PROTOCOL_DIR)process.env.QQ_AGENT_PROTOCOL_DIR=path.join(path.dirname(electronApp.getPath('exe')),'protocols');
  runtime = { ...resolved, userData, diagFile: path.join(resolved.dataDir, 'boot-diag.log') };
  appendBootDiag('main.js loaded');
  appendBootDiag('paths-resolved', `${resolved.source} dataDir=${resolved.dataDir}`);
  return runtime;
}

export function isLoopbackConsoleUrl(raw, expectedPort) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
      Number(url.port) === Number(expectedPort);
  } catch { return false; }
}

function iconFor(electron) {
  const iconPath = path.join(APP_ROOT, 'assets', 'icon.png');
  try {
    if (fs.existsSync(iconPath) && typeof electron.nativeImage?.createFromPath === 'function') {
      return electron.nativeImage.createFromPath(iconPath);
    }
  } catch { /* use the transparent fallback below */ }
  try { return electron.nativeImage?.createFromDataURL?.(EMPTY_ICON_DATA_URL); } catch { return undefined; }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed?.()) return;
  if (mainWindow.isMinimized?.()) mainWindow.restore?.();
  mainWindow.show?.();
  mainWindow.focus?.();
}

function currentPaused() {
  return Boolean(kernel?.orchestrator?.status?.().paused);
}

function currentAutoStart() {
  return Boolean(kernel?.config?.get?.().server?.autoStart);
}

export function createTray(electron, {
  profile = runtime?.profile,
  paused = currentPaused,
  autoStart = currentAutoStart,
  onPauseChange,
  onAutoStartChange,
  onShow = showMainWindow,
  onQuit,
} = {}) {
  if (typeof electron.Tray !== 'function' || typeof electron.Menu?.buildFromTemplate !== 'function') return null;
  let icon = iconFor(electron);
  if (!icon && typeof electron.nativeImage?.createEmpty === 'function') icon = electron.nativeImage.createEmpty();
  if (!icon) return null;
  const instance = new electron.Tray(icon);
  const profileLabel = profile?.n ? `profile=${profile.n}` : 'profile=1';
  instance.setToolTip?.(`QQ Agent (${profileLabel})`);
  const rebuild = () => {
    const isPaused = Boolean(typeof paused === 'function' ? paused() : paused);
    const auto = Boolean(typeof autoStart === 'function' ? autoStart() : autoStart);
    instance.setContextMenu?.(electron.Menu.buildFromTemplate([
      { label: '显示主界面', click: () => onShow?.() },
      { label: isPaused ? '恢复' : '暂停', click: () => onPauseChange?.(!isPaused) },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: auto, click: (item) => onAutoStartChange?.(Boolean(item?.checked)) },
      { type: 'separator' },
      { label: '退出', click: () => onQuit?.() },
    ]));
  };
  instance.refreshMenu = rebuild;
  instance.on?.('double-click', () => onShow?.());
  rebuild();
  return instance;
}

function configureCaptchaInterceptor(session) {
  const webRequest = session?.defaultSession?.webRequest;
  if (!webRequest?.onBeforeRequest || !session?.defaultSession) {
    captchaInterceptorState.lastError = 'Electron webRequest API unavailable';
    return false;
  }
  if (captchaSessions.has(session.defaultSession)) return true;
  try {
    webRequest.onBeforeRequest({ urls: ['https://*.aliyuncs.com/*', 'https://*.alicdn.com/*'] }, (details, callback) => {
      captchaInterceptorState.requestCount += 1;
      try {
        const source = new URL(details.url);
        const redirectURL = `https://kondius.cn/qq-agent/captcha-api/${source.hostname}${source.pathname}${source.search}`;
        captchaInterceptorState.redirectCount += 1;
        captchaInterceptorState.lastRedirectAt = new Date().toISOString();
        callback({ redirectURL });
      } catch {
        callback({});
      }
    });
    captchaSessions.add(session.defaultSession);
    captchaInterceptorState.installed = true;
    captchaInterceptorState.registeredAt = captchaInterceptorState.registeredAt ?? new Date().toISOString();
    captchaInterceptorState.lastError = null;
    return true;
  } catch (error) {
    captchaInterceptorState.lastError = String(error?.message ?? error).slice(0, 240);
    return false;
  }
}

function safeCaptchaState() {
  return {
    installed: Boolean(captchaInterceptorState.installed),
    registeredAt: captchaInterceptorState.registeredAt,
    lastError: captchaInterceptorState.lastError,
    requestCount: Number(captchaInterceptorState.requestCount) || 0,
    redirectCount: Number(captchaInterceptorState.redirectCount) || 0,
    lastRedirectAt: captchaInterceptorState.lastRedirectAt,
  };
}

function classifyProbeError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  if (error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code.includes('CERT') || code.includes('TLS') || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  return 'network';
}

async function probeCaptchaTarget(target, fetchImpl = globalThis.fetch) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const timeoutError = new Error('captcha probe timeout');
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
  }, CAPTCHA_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target, { method: 'HEAD', redirect: 'manual', cache: 'no-store', signal: controller.signal });
    return { target, ok: true, status: Number(response.status) || 0, latencyMs: Date.now() - started };
  } catch (error) {
    return { target, ok: false, status: null, latencyMs: Date.now() - started, error: classifyProbeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCaptchaNetwork(fetchImpl = globalThis.fetch) {
  const results = [];
  for (const target of CAPTCHA_PROBE_TARGETS) results.push(await probeCaptchaTarget(target, fetchImpl));
  return {
    ok: results.some((item) => item.ok),
    targets: results,
    checkedAt: new Date().toISOString(),
  };
}

export function captchaInterceptorStatus() {
  return safeCaptchaState();
}

function senderIsMainWindow(sender) {
  return Boolean(sender && !sender.isDestroyed?.() && mainWindow && !mainWindow.isDestroyed?.() && sender === mainWindow.webContents);
}

function installDesktopIpc(electron) {
  const ipcMain = electron?.ipcMain;
  if (!ipcMain || desktopIpc === ipcMain) return;
  desktopIpcCleanup?.();
  const allowedSender = (event) => senderIsMainWindow(event?.sender);
  const listeners = [];
  const on = (channel, listener) => {
    const wrapped = (event, ...args) => {
      if (!allowedSender(event)) return;
      listener(event, ...args);
    };
    ipcMain.on?.(channel, wrapped);
    listeners.push([channel, wrapped]);
  };
  on('qq-agent:quit', () => { void stopElectron(electron); });
  on('qq-agent:reload', (event) => { void reloadMainWindow(event.sender); });
  on('qq-agent:leave-ready', event=>rendererLeave.register(event));
  on('qq-agent:leave-result', (event,body)=>rendererLeave.acknowledge(event,body));
  on('app-refocus', () => showMainWindow());
  on('qq-agent:refocus', () => showMainWindow());
  on('qq-agent:open-devtools', (event) => event.sender.openDevTools?.({ mode: 'detach' }));
  if (typeof ipcMain.handle === 'function') {
    ipcMain.handle('qqa-captcha-net-probe', async (event) => allowedSender(event) ? probeCaptchaNetwork() : { ok: false, error: 'unauthorized' });
    ipcMain.handle('qqa-captcha-interceptor-status', (event) => allowedSender(event) ? safeCaptchaState() : { installed: false, error: 'unauthorized' });
  }
  desktopIpc = ipcMain;
  desktopIpcCleanup = () => {
    for (const [channel, listener] of listeners) { try { ipcMain.removeListener?.(channel, listener); } catch {} }
    try { ipcMain.removeHandler?.('qqa-captcha-net-probe'); } catch {}
    try { ipcMain.removeHandler?.('qqa-captcha-interceptor-status'); } catch {}
    desktopIpc = null;
    desktopIpcCleanup = null;
  };
}

function consoleUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

function installTokenBootstrap(ipcMain) {
  if (bootstrapHandlerInstalled || !ipcMain?.handle) return;
  bootstrapHandlerInstalled = true;
  bootstrapIpc = ipcMain;
  ipcMain.handle('qq-agent:get-console-token', (event) => {
    const sender = event?.sender;
    if (!senderIsMainWindow(sender)) return '';
    const bootstrap = consoleTokens.get(sender),frame = event?.senderFrame;
    if (!bootstrap || !frame) return '';
    try {
      // A renderer can request the credential again after a reload, but opaque
      // plugin iframes and same-window navigation to other pages must never get it.
      if (frame !== sender.mainFrame) return '';
      const url = new URL(frame.url);
      if (url.origin !== bootstrap.origin || url.pathname !== '/') return '';
      return typeof bootstrap.tokenOf === 'function' ? String(bootstrap.tokenOf() ?? '') : bootstrap.token;
    } catch { return ''; }
  });
}

export function createWindow(electron, port, {
  token = '',
  tokenOf = null,
  closeToTray = () => kernel?.config?.get?.().server?.closeToTray !== false,
  onCloseToTray,
  onRequestQuit,
} = {}) {
  const { BrowserWindow, session, shell } = electron;
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: true,
    },
  });
  // BrowserWindow.webContents is a native getter that throws once the window is
  // destroyed. Capture it while alive, including for destruction callbacks.
  const webContents = win.webContents;
  webContents.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)rendererLeave.reset();});
  webContents.once?.('destroyed',()=>rendererLeave.reset());
  consoleTokens.set(webContents, { token: String(token ?? '').trim(), tokenOf, origin: new URL(consoleUrl(port)).origin });
  webContents.once?.('destroyed', () => consoleTokens.delete(webContents));
  win.on('closed', () => consoleTokens.delete(webContents));
  win.once('ready-to-show', () => { if (!win.isDestroyed?.()) win.show(); });
  const openExternal = (url) => { try { void shell?.openExternal?.(url); } catch { /* external browser is best effort */ } };
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isLoopbackConsoleUrl(url, port)) openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!isLoopbackConsoleUrl(url, port)) {
      event.preventDefault();
      openExternal(url);
    }
  };
  webContents.on('will-navigate', guardNavigation);
  webContents.on('will-redirect', guardNavigation);
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appendBootDiag('did-fail-load', `${errorCode} ${errorDescription} ${validatedURL}`);
    if (isMainFrame) setTimeout(() => {
      if (!win.isDestroyed?.()) void win.loadURL(consoleUrl(port)).catch(() => {});
    }, 2000);
  });
  webContents.on('render-process-gone', (_event, details) => appendBootDiag('render-process-gone', JSON.stringify(details ?? {})));
  webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (Number(level) >= 2) appendBootDiag('console-message', `${level} ${sourceId}:${line} ${message}`);
  });
  webContents.on('before-input-event', (event, input) => {
    const refresh = input.type === 'keyDown' && (input.key === 'F5' || (input.key?.toLowerCase() === 'r' && (input.control || input.meta)));
    if (refresh) {
      event.preventDefault();
      if (!webContents.isDestroyed?.()) void reloadMainWindow(webContents);
    }
  });
  win.on('close', (event) => {
    if (shuttingDown || appRef?.isQuitting) return;
    const shouldHide = typeof closeToTray === 'function' ? closeToTray() : Boolean(closeToTray);
    if (shouldHide) {
      event.preventDefault();
      if (onCloseToTray) onCloseToTray(win);
      else win.hide();
      return;
    }
    event.preventDefault();
    if (onRequestQuit) onRequestQuit();
    else void stopElectron(electron);
  });
  try { Promise.resolve(session?.defaultSession?.setProxy?.({ mode: 'direct' })).catch(() => {}); } catch { /* no proxy API in mock */ }
  session?.defaultSession?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  configureCaptchaInterceptor(session);
  void win.loadURL(consoleUrl(port)).catch(() => {});
  return win;
}

function clearDesktopResources() {

  try { desktopConfigCleanup?.(); }
  catch (error) { appendBootDiag('desktop-config-unsubscribe-failed', String(error?.message ?? error)); }
  desktopConfigCleanup = null;
  try { tray?.destroy?.(); } catch { /* best effort */ }
  tray = null;
  try { desktopIpcCleanup?.(); } catch { /* best effort */ }
  try { if (bootstrapIpc?.removeHandler) bootstrapIpc.removeHandler('qq-agent:get-console-token'); } catch { /* best effort */ }
  bootstrapIpc = null;
  bootstrapHandlerInstalled = false;
  try { if (mainWindow && !mainWindow.isDestroyed?.()) mainWindow.destroy?.(); } catch { /* best effort */ }
  mainWindow = null;
}

export async function stopElectron(electron) {
  if (shutdownPromise) return shutdownPromise;
  appRef = electron.app;
  shutdownPromise = (async () => {
    const saved=await rendererLeave.prepare('quit');
    if(!saved.ok){showMainWindow();dialogRef?.showErrorBox?.('QQ Agent 暂未退出',saved.error);return saved;}
    shuttingDown = true;appRef.isQuitting = true;rendererLeave.reset();
    clearDesktopResources();
    let stopError = null;
    try { await kernel?.stop?.(); }
    catch (error) {
      stopError = error;
      appendBootDiag('shutdown-failed', error?.stack || String(error));
      try { dialogRef?.showErrorBox?.('QQ Agent 退出失败', error?.stack || String(error)); } catch { /* dialog may be unavailable */ }
    }
    finally { kernel = null; }
    if (stopError) {
      try { appRef.exit?.(1); } catch { /* best effort */ }
      return { ok: false, error: String(stopError?.message ?? stopError) };
    }
    appRef.quit?.();
    return { ok: true };
  })();
  const result=await shutdownPromise;if(!shuttingDown)shutdownPromise=null;return result;
}

function applyLoginItemSettings(app) {
  const enabled = currentAutoStart();
  try {
    app.setLoginItemSettings?.(loginItemSettings(app, { autoStart: enabled }));
    appliedAutoStart = enabled;
  } catch (error) { appendBootDiag('autostart-apply-failed', String(error?.message ?? error)); }
}

function syncDesktopConfig(app) {
  // Config notifications happen after atomic save/commit. A failed save cannot
  // change the OS login item; settings and tray share this single consumer.
  if (appliedAutoStart !== currentAutoStart()) applyLoginItemSettings(app);
  tray?.refreshMenu?.();
}

function handlePauseChange(paused) {
  if(kernel?.accounts?.setPaused){
    void kernel.accounts.setPaused(Boolean(paused)).then(()=>{tray?.refreshMenu?.();kernel?.bus?.emit?.('status',{paused:Boolean(paused),pauseReason:null});}).catch(()=>{dialogRef?.showErrorBox?.('QQ Agent 暂停状态未完全更新','部分账号未能修改暂停状态，请在账号管理中检查。');tray?.refreshMenu?.();});
    return;
  }
  if (paused) kernel?.orchestrator?.pause?.();
  else kernel?.orchestrator?.resume?.();
  tray?.refreshMenu?.();
  kernel?.bus?.emit?.('status', { paused: Boolean(paused), pauseReason: null });
}

function handleAutoStartChange(enabled, app) {
  try {
    kernel?.config?.update?.({ server: { autoStart: Boolean(enabled) } });
    if (!desktopConfigCleanup) syncDesktopConfig(app);
  } catch (error) {
    appendBootDiag('autostart-update-failed', String(error?.message ?? error));
    // Native checkbox menu items toggle before their click handler. Restore the
    // last committed flag after a failed save without changing the login item.
    tray?.refreshMenu?.();
  }
}

function installFatalHandlers(electron) {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  const fatal = (reason) => {
    // An exported startElectron caller may leave its original rejection
    // unhandled while Electron's requested exit is still pending.
    if (reportedStartupFailures.has(reason)) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    appendBootDiag('uncaught-fatal', error.stack || error.message);
    console.error('[electron] 未捕获异常：', error);
    try { electron.dialog?.showErrorBox?.('QQ Agent 运行失败', error.stack || error.message); } catch { /* dialog may be unavailable during shutdown */ }
    try { electron.app?.exit?.(1); } catch { /* best effort */ }
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

export async function startElectron(electronModule = null, options = {}) {
  try {
    return await startElectronInternal(electronModule, options);
  } catch (error) {
    // All launch stages, including preflight/import/factory failures, have one
    // reporting owner. Keep the original rejection for exported API callers.
    reportedStartupFailures.add(error);
    appendBootDiag('startup-failed', error?.stack || String(error));
    shuttingDown = true;
    if (appRef) appRef.isQuitting = true;
    clearDesktopResources();
    try { await kernel?.stop?.(); } catch (stopError) { appendBootDiag('startup-stop-failed', stopError?.stack || String(stopError)); }
    kernel = null;
    try { await startupCompositionLifecycle?.close(); }
    catch (cleanupError) { appendBootDiag('startup-composition-cleanup-failed', cleanupError?.stack || String(cleanupError)); }
    finally { startupCompositionLifecycle = null; }
    console.error('[electron] 启动失败：', error);
    try { dialogRef?.showErrorBox?.('QQ Agent 启动失败', error?.stack || String(error)); } catch { /* dialog may be unavailable */ }
    try {
      if (typeof appRef?.exit === 'function') appRef.exit(1);
      else process.exitCode = 1;
    } catch { process.exitCode = 1; }
    throw error;
  }
}

async function startElectronInternal(electronModule = null, { createKernel: createKernelImpl } = {}) {
  const electron = electronModule ?? await import('electron');
  const { app, ipcMain } = electron;
  appRef = app;
  dialogRef = electron.dialog ?? null;
  installFatalHandlers(electron);
  // Let Electron select the supported GPU path. Keep an explicit software
  // fallback for machines whose graphics driver needs it, before app readiness.
  if (process.env.QQ_AGENT_DISABLE_GPU === '1') app.disableHardwareAcceleration?.();
  app.setAppUserModelId?.(APP_USER_MODEL_ID);
  const launchEnv = resolveLoginItemEnvironment();
  for (const key of ['QQ_AGENT_PROFILE', 'QQ_AGENT_DATA_DIR']) {
    if (Object.hasOwn(launchEnv, key)) process.env[key] = launchEnv[key];
  }
  // Select the generation before Chromium can create its cache. Preflight and
  // the eventual application share exactly this plan and its resource scope.
  let preparedPlan = null;
  let factory = createKernelImpl;
  if (!factory) {
    const application = await import('../src/kernel/composition.js');
    preparedPlan = await application.loadComposition({ appRoot: APP_ROOT });
    startupCompositionLifecycle = createCompositionLifecycle();
    factory = application.createApplication;
  }
  configureUserData(app, launchEnv, APP_ROOT, preparedPlan ? { ...preparedPlan, lifecycle: startupCompositionLifecycle } : {});
  appendBootDiag('electron-preflight');
  installTokenBootstrap(ipcMain);
  installDesktopIpc(electron);
  const locked = app.requestSingleInstanceLock();
  if (!locked) {
    appendBootDiag('single-instance-denied');
    await startupCompositionLifecycle?.close();
    startupCompositionLifecycle = null;
    app.quit?.();
    return { acquired: false };
  }
  app.on?.('second-instance', () => showMainWindow());
  app.on?.('window-all-closed', () => { /* close hides to tray; explicit quit owns shutdown */ });
  app.on?.('before-quit', (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      void stopElectron(electron);
    }
  });
  await app.whenReady();
  appendBootDiag('app-ready');
  kernel = await factory({ headless: false, ...(preparedPlan ? { lifecycle: startupCompositionLifecycle } : {}) }, preparedPlan);
  startupCompositionLifecycle = null; // createApplication now owns the same scope.
  appendBootDiag('kernel-created');
  const port = await kernel.start();
  appendBootDiag('kernel-started', String(port));
  appliedAutoStart = undefined;
  applyLoginItemSettings(app);
  desktopConfigCleanup = kernel?.config?.onChange?.(() => {
    if (!shuttingDown) syncDesktopConfig(app);
  }) ?? null;
  mainWindow = createWindow(electron, port, {
    token: kernel?.config?.get?.().server?.token ?? '',
    tokenOf: () => kernel?.config?.get?.().server?.token ?? '',
    closeToTray: () => kernel?.config?.get?.().server?.closeToTray !== false,
    onCloseToTray: (win) => win.hide?.(),
    onRequestQuit: () => { void stopElectron(electron); },
  });
  tray = createTray(electron, {
    profile: runtime?.profile,
    paused: currentPaused,
    autoStart: currentAutoStart,
    onPauseChange: handlePauseChange,
    onAutoStartChange: (enabled) => handleAutoStartChange(enabled, app),
    onShow: showMainWindow,
    onQuit: () => { void stopElectron(electron); },
  });



  appendBootDiag('window-created');
  app.on?.('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed?.()) mainWindow = createWindow(electron, port, { token: kernel?.config?.get?.().server?.token ?? '', tokenOf: () => kernel?.config?.get?.().server?.token ?? '', closeToTray: () => kernel?.config?.get?.().server?.closeToTray !== false });
    else showMainWindow();
  });
  return { acquired: true, port, window: mainWindow, tray, kernel, update: null };
}

export function isElectronMainProcess(runtimeProcess = process) {
  return Boolean(runtimeProcess?.versions?.electron) && runtimeProcess?.type === 'browser';
}

// Electron loads the configured `main` module with process.argv[1] varying by
// launch form (`electron .`, Explorer, packaged exe). Do not gate startup on
// argv[1] matching this file: under the real desktop launcher it can be the app
// root, which would leave Electron alive with no window and no HTTP server.
if (isElectronMainProcess() || (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))) {
  // startElectron already reports, cleans up and exits. Handle its rejection so
  // the global unhandled-rejection handler cannot present the same error again.
  void startElectron().catch(() => {});
}
