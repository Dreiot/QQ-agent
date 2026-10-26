import { createHash } from 'node:crypto';
import { mergeProtocolConnection } from './adapters.js';
import { isDeepStrictEqual } from 'node:util';

const NAP = '/api/QQLogin/';
const SNOW_STATUSES = new Set(['available', 'loading', 'connecting', 'loaded', 'online', 'disconnected', 'error']);
const NAP_PHASES = new Set(['waiting_qrcode', 'generating_qrcode', 'qrcode_scanned', 'initializing', 'ready', 'reconnecting', 'offline']);

/** Errors intentionally contain only our own messages, never upstream bodies or credentials. */
export class NativeLoginError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'NativeLoginError';
    Object.assign(this, options);
  }
}

const cleanText = (value, limit = 80) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, limit) : '';
const accountId = value => /^\d{1,20}$/.test(String(value ?? '')) && String(value) !== '0' ? String(value) : '';
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const providerName = provider => {
  if (provider !== 'napcat' && provider !== 'snowluma') throw new NativeLoginError('暂不支持此协议端的客户端登录。');
  return provider;
};
const authHeaders = (provider, credential) => {
  if (typeof credential !== 'string' || !credential || credential.length > 16384) {
    throw new NativeLoginError('请先验证协议端的访问凭据。', { needsCredentials: true });
  }
  return provider === 'snowluma' ? { 'x-snowluma-token': credential } : { Authorization: `Bearer ${credential}` };
};

function safeFailure(error, { authentication = false } = {}) {
  if (error instanceof NativeLoginError) return error;
  if (error?.status === 401) return new NativeLoginError('协议端凭据已失效，请重新验证。', { needsCredentials: true, status: 401 });
  if (error?.status === 403 && (error?.body?.consentRequired === true || error?.body?.mustChangePassword === true)) {
    return new NativeLoginError('请先在协议端原生页面完成首次确认及凭据设置。', { needsNative: true, status: 403 });
  }
  if (error?.status === 403) return new NativeLoginError('协议端拒绝了此访问，请检查访问凭据。', { needsCredentials: true, status: 403 });
  if (error?.status === 429) return new NativeLoginError('协议端暂时限制了登录尝试，请稍后再试。', { status: 429 });
  return new NativeLoginError(authentication ? '无法验证协议端的访问凭据，请检查后重试。' : '暂时无法读取协议端登录状态，请稍后重试。');
}

async function call(request, path, options) {
  if (typeof request !== 'function') throw new NativeLoginError('协议端连接尚未准备好。');
  try { return await request(path, options); }
  catch (error) { throw safeFailure(error); }
}

async function napCall(request, path, credential, { body = {}, timeoutMs = 7000 } = {}) {
  const result = await call(request, NAP + path, { method: 'POST', body, headers: authHeaders('napcat', credential), timeoutMs });
  if (!result || result.code !== 0) {
    const message = String(result?.message ?? '');
    if (/unauthorized|authorization failed|token.*(?:invalid|not initialized|revoked)/i.test(message)) {
      throw new NativeLoginError('协议端凭据已失效，请重新验证。', { needsCredentials: true });
    }
    throw new NativeLoginError(path === 'RefreshQRcode' ? '未能刷新二维码，请稍后重试。' : '暂时无法读取 NapCat 登录状态，请稍后重试。');
  }
  return result.data;
}

function emptyState(patch = {}) {
  return { stage: 'offline', qrImage: '', account: null, processes: [], canRefresh: false,
    needsNative: false, error: '', message: '', pollAfterMs: 1000, ...patch };
}

function nativeRequired() {
  return emptyState({ stage: 'native', needsNative: true, pollAfterMs: 0,
    message: '请在协议端原生页面完成首次确认及凭据设置，然后返回。' });
}

/** Exchange a user-supplied WebUI password for an in-memory native session. */
export async function authenticateNative({ provider, request, password, totp, recoveryCode }) {
  providerName(provider);
  if (typeof password !== 'string' || !password || password.length > 8192) {
    throw new NativeLoginError('请输入协议端的访问凭据。', { needsCredentials: true });
  }
  try {
    if (provider === 'napcat') {
      const result = await call(request, '/api/auth/login', { method: 'POST', timeoutMs: 10000,
        body: { hash: createHash('sha256').update(password + '.napcat').digest('hex'), ...(totp ? { totpCode: String(totp) } : {}) } });
      if (result?.code === 0 && result.data?.require2FA === true && !result.data?.Credential) {
        return { credential: '', needsTotp: true, needsNative: false, message: '请输入协议端的两步验证码。' };
      }
      if (result?.code !== 0 || typeof result.data?.Credential !== 'string' || !result.data.Credential) {
        if (/login rate limit/i.test(String(result?.message ?? ''))) throw new NativeLoginError('协议端暂时限制了登录尝试，请稍后再试。', { status: 429 });
        throw new NativeLoginError('访问凭据或两步验证码不正确，请检查后重试。', { needsCredentials: true });
      }
      return { credential: result.data.Credential, needsTotp: false, needsNative: false, message: '' };
    }
    const result = await call(request, '/api/login', { method: 'POST', timeoutMs: 10000,
      body: { password, ...(totp ? { totp: String(totp) } : {}), ...(recoveryCode ? { recoveryCode: String(recoveryCode) } : {}) } });
    if (result?.needsTotp === true && result.success !== true) {
      return { credential: '', needsTotp: true, needsNative: false, message: '请输入协议端的两步验证码或恢复码。' };
    }
    if (result?.success !== true || typeof result.token !== 'string' || !result.token) {
      throw new NativeLoginError('访问凭据或两步验证码不正确，请检查后重试。', { needsCredentials: true });
    }
    return { credential: result.token, needsTotp: false, needsNative: result.mustChangePassword === true,
      message: result.mustChangePassword === true ? '请先在原生页面修改初始访问凭据。' : '' };
  } catch (error) { throw safeFailure(error, { authentication: true }); }
}

/** Public process descriptions omit paths, raw errors and all unrelated native fields. */
export function normalizeSnowProcesses(list) {
  return (Array.isArray(list) ? list : []).filter(item => item && validPid(item.pid)).slice(0, 256).map(item => {
    // Once a bridge is live, its current UIN overrides the historical desktop snapshot.
    const snapshotId = accountId(item.account?.uin);
    const id = item.loggedIn === true ? accountId(item.uin) : snapshotId || accountId(item.uin);
    const status = SNOW_STATUSES.has(item.status) ? item.status : 'error';
    const selectable = !item.connected && ['available', 'disconnected', 'error'].includes(status);
    return { pid: item.pid, accountId: id, nickname: snapshotId && snapshotId === id ? cleanText(item.account?.nickname) : '', status, selectable, injected: item.injected === true,
      reason: selectable ? '' : ['loading', 'connecting'].includes(status) ? '正在接入，请稍候。' : '此 QQ 进程已接入。' };
  });
}

async function readNap({ request, credential, qrImageFor }) {
  const data = await napCall(request, 'CheckLoginStatus', credential);
  if (!data || typeof data !== 'object') throw new NativeLoginError('NapCat 返回的登录状态暂不可用。');
  const ready = data.isLogin === true && data.coreReady !== false;
  const phase = ready ? 'ready' : NAP_PHASES.has(data.loginPhase) ? data.loginPhase : 'offline';
  const stage = ready ? 'connected' : phase === 'qrcode_scanned' ? 'scanned'
    : ['initializing', 'reconnecting'].includes(phase) ? 'initializing'
      : phase === 'offline' && data.loginError ? 'error' : 'waiting';
  if (ready) {
    const info = await napCall(request, 'GetQQLoginInfo', credential);
    const id = accountId(info?.uin);
    if (!id) return emptyState({ stage: 'initializing', phase: 'initializing', pollAfterMs: 500,
      message: 'QQ 正在初始化账号信息，请稍候。' });
    return emptyState({ stage, phase, account: id ? { id, nickname: cleanText(info?.nick) } : null, pollAfterMs: 0 });
  }
  let qrImage = '';
  if (typeof data.qrcodeurl === 'string' && data.qrcodeurl && data.qrcodeurl.length <= 8192 && typeof qrImageFor === 'function') {
    try {
      const result = await qrImageFor(data.qrcodeurl);
      if (typeof result === 'string' && result.startsWith('data:image/png;base64,') && result.length <= 2 * 1024 * 1024) qrImage = result;
    } catch { /* A QR rendering failure must not expose the native scan URL. */ }
  }
  const error = data.loginError ? /二维码.*(?:过期|失效)/.test(String(data.loginError))
    ? '二维码已过期，请刷新。' : 'QQ 登录暂未完成，请重试或在原生页面查看。' : '';
  return emptyState({ stage, phase, qrImage, canRefresh: ['waiting_qrcode', 'offline'].includes(phase), error,
    pollAfterMs: ['qrcode_scanned', 'initializing', 'generating_qrcode', 'reconnecting'].includes(phase) ? 500 : 1500 });
}

async function snowCall(request, path, credential, options = {}) {
  return call(request, path, { method: 'GET', timeoutMs: 7000, ...options, headers: authHeaders('snowluma', credential) });
}

async function readSnow({ request, credential }) {
  const agreements = await snowCall(request, '/api/agreements', credential);
  if (agreements?.consentRequired === true) return nativeRequired();
  const auth = await snowCall(request, '/api/auth/state', credential);
  if (auth?.mustChangePassword === true) return nativeRequired();
  const data = await snowCall(request, '/api/processes', credential);
  if (!Array.isArray(data?.list)) throw new NativeLoginError('SnowLuma 返回的 QQ 进程列表暂不可用。');
  const processes = normalizeSnowProcesses(data.list);
  const online = processes.find(item => item.status === 'online');
  const active = processes.some(item => ['loading', 'connecting'].includes(item.status));
  return emptyState({ stage: online ? 'connected' : active ? 'initializing' : 'waiting',
    account: online?.accountId ? { id: online.accountId, nickname: online.nickname } : null, processes,
    message: processes.length ? '' : '请先启动并登录桌面 QQ。', pollAfterMs: active ? 500 : online ? 0 : 1500 });
}

/** Read-only status acquisition. No consent, password changes, logout or account switching. */
export async function readNativeLogin(options) {
  providerName(options?.provider);
  try { return options.provider === 'napcat' ? await readNap(options) : await readSnow(options); }
  catch (error) {
    const failure = safeFailure(error);
    if (failure.needsNative) return nativeRequired();
    throw failure;
  }
}

/** Explicit user refresh only; the controller reads the resulting state separately. */
export async function refreshNativeQr({ request, credential }) {
  await napCall(request, 'RefreshQRcode', credential, { timeoutMs: 15000 });
}

/** Re-read processes immediately before loading; a stale or already attached PID is rejected. */
export async function injectNativeProcess({ request, credential, pid, expectedAccountId }) {
  if (!validPid(pid)) throw new NativeLoginError('请选择有效的 QQ 进程。');
  if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !/^[0-9]{5,10}$/.test(expectedAccountId))) {
    throw new NativeLoginError('所选 QQ 账号无效，请刷新列表后重新选择。');
  }
  const current = await snowCall(request, '/api/processes', credential);
  if (!Array.isArray(current?.list)) throw new NativeLoginError('SnowLuma 返回的 QQ 进程列表暂不可用。');
  const process = normalizeSnowProcesses(current.list).find(item => item.pid === pid);
  if (!process?.selectable) throw new NativeLoginError('此 QQ 进程已变化，请刷新列表后重新选择。');
  if (expectedAccountId !== undefined && process.accountId !== expectedAccountId) {
    throw new NativeLoginError('此 QQ 进程的登录账号已变化，请刷新列表后重新选择。');
  }
  // An injected DLL survives a console restart. Reconcile its pipe instead of injecting twice.
  const result = await snowCall(request, `/api/processes/${pid}/${process.injected ? 'refresh' : 'load'}`, credential, { method: 'POST', timeoutMs: 30000 });
  if (result?.success !== true) throw new NativeLoginError('未能接入所选 QQ 进程，请检查桌面 QQ 状态及运行权限。');
}

/** Preserve the account's complete native snapshot and merge only QQ-Agent's named endpoints. */
export function snowConnection(document) {
  const owned = (key, name) => document?.networks?.[key]?.filter?.(row => row?.name === name);
  const http = owned('httpServers', 'qq-agent-http'), ws = owned('wsServers', 'qq-agent-ws');
  if (http?.length !== 1 || ws?.length !== 1) return null;
  const [h] = http, [w] = ws;
  // SnowLuma 2.2 omits the legacy enabled field; an entry in these arrays is active.
  if (![h, w].every(row => (row.enabled === undefined || row.enabled === true) && row.host === '127.0.0.1' && row.path === '/' && row.messageFormat === 'array' && row.reportSelfMessage === false
      && Number.isInteger(row.port) && row.port > 0 && row.port < 65536) || h.port === w.port || w.role !== 'Universal'
      || typeof h.accessToken !== 'string' || !h.accessToken || h.accessToken.length > 4096 || /[\x00-\x20\x7f]/.test(h.accessToken) || w.accessToken !== h.accessToken) return null;
  return { httpPort: h.port, wsPort: w.port, token: h.accessToken };
}

export async function prepareSnowConnection({ request, credential, accountId: selectedAccount, httpPort, wsPort, token, reuseExisting = false, verifySaved = false }) {
  if (typeof selectedAccount !== 'string' || !/^[0-9]{5,10}$/.test(selectedAccount)) {
    throw new NativeLoginError('请先在桌面 QQ 登录所选账号，再准备连接。');
  }
  const path = `/api/config/${selectedAccount}`;
  const snapshot = await snowCall(request, path, credential);
  if (!snapshot?.config || typeof snapshot.config !== 'object' || Array.isArray(snapshot.config)) {
    throw new NativeLoginError('暂时无法读取此 QQ 账号的连接配置，未修改配置。');
  }
  const existing = reuseExisting && snowConnection(snapshot.config);
  if (existing) return existing;
  let config;
  try {
    config = mergeProtocolConnection(snapshot.config, { provider: 'snowluma', httpPort, wsPort, token });
  } catch {
    throw new NativeLoginError('此 QQ 账号的连接配置暂不可用，未修改配置。');
  }
  const own = value => ['httpServers', 'wsServers'].map((key, index) => (value?.networks?.[key] || []).filter(row => row?.name === ['qq-agent-http', 'qq-agent-ws'][index]).map(row=>{
    const normalized={...row};if(normalized.enabled===true)delete normalized.enabled;if(key==='httpServers'&&normalized.enableWebSocket===undefined)normalized.enableWebSocket=false;return normalized;
  }));
  const rollback = async () => {
    const current = await snowCall(request, path, credential);
    if(!current?.config||typeof current.config!=='object'||Array.isArray(current.config))throw new NativeLoginError('无法核对原连接配置，请在协议端检查。');
    if (isDeepStrictEqual(own(current?.config), own(snapshot.config))) return;
    if (!current?.config || !isDeepStrictEqual(own(current.config), own(config))) throw new NativeLoginError('连接配置已被其他操作修改，请在协议端检查；未覆盖新配置。');
    const restored = { ...current.config, networks: { ...current.config.networks } };
    for (const [key, name] of [['httpServers', 'qq-agent-http'], ['wsServers', 'qq-agent-ws']]) {
      restored.networks[key] = [...current.config.networks[key].filter(row => row?.name !== name), ...(snapshot.config.networks?.[key] || []).filter(row => row?.name === name)];
    }
    const result = await snowCall(request, path, credential, { method: 'POST', body: restored, timeoutMs: 30000 });
    if (result?.success !== true || result.saved !== true || result.applied === false && result.online === true || (Array.isArray(result.errors)?result.errors.length:Object.keys(result.errors||{}).length)) throw new NativeLoginError('未能恢复原连接配置，请在协议端检查。');
    const verified=await snowCall(request,path,credential);if(!isDeepStrictEqual(own(verified?.config),own(restored)))throw new NativeLoginError('原连接配置未能保存，请在协议端检查。');
  };
  try {
  const result = await snowCall(request, path, credential, { method: 'POST', body: config, timeoutMs: 30000 });
  const errors = result?.errors;
  const hasErrors = Array.isArray(errors) ? errors.length > 0 : errors && typeof errors === 'object'
    ? Object.keys(errors).length > 0 : Boolean(errors);
  if (result?.success !== true || result.saved !== true || hasErrors || (result.applied === false && result.online === true)) {
    throw new NativeLoginError('所选 QQ 账号的连接配置未完整生效，请在协议端页面检查后重试。');
  }
  if (verifySaved) {
    const saved = await snowCall(request, path, credential);
    if (!isDeepStrictEqual(snowConnection(saved?.config), { httpPort, wsPort, token })) throw new NativeLoginError('协议端保存的连接配置与本次设置不一致，未连接此账号。');
  }
  return { httpPort, wsPort, token, rollback };
  } catch (error) {
    if (verifySaved) { try { await rollback(); } catch { throw new NativeLoginError('连接配置未完整生效，且未能恢复原配置，请打开协议端检查。'); } }
    throw error;
  }
}
