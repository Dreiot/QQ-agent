import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../kernel/composition.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QQ = /^[0-9]{5,10}$/;
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,4096}$/.test(value);
const rejected = () => { throw Object.assign(new Error('协议端由主客户端统一管理。'), { status: 409, expose: true }); };
const inertProtocols = ({ appRoot }) => {
  const snapshot = () => ({ root: path.join(appRoot, 'protocols'), providers: [], running: null, settings: { autoStart: false } });
  return { start: async () => {}, close: async () => {}, scan: async () => snapshot(), snapshot,
    launch: rejected, stop: rejected, saveSettings: rejected, output: () => ({ text: '' }), loginContext: () => null, commitLoginConnection: rejected };
};
const inertLogin = () => ({ get: async () => ({ provider: null, source: 'worker', stage: 'unavailable', processes: [], qrImage: '', account: null }),
  connect: rejected, refresh: rejected, inject: rejected, closeView: () => ({ ok: true }), visibility: () => ({ ok: true }), close() {} });

async function plainDirectory(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('账号工作区路径不可用。');
  }
}
function safeConnection(onebot) {
  try {
    const http = new URL(onebot.httpUrl), ws = new URL(onebot.wsUrl);
    if (http.protocol !== 'http:' || ws.protocol !== 'ws:' || http.hostname !== '127.0.0.1' || ws.hostname !== '127.0.0.1'
      || http.username || http.password || ws.username || ws.password || http.search || ws.search || http.hash || ws.hash
      || http.pathname !== '/' || ws.pathname !== '/' || !http.port || !ws.port || http.port === ws.port
      || !tokenValid(onebot.accessToken) || onebot.httpAccessToken !== onebot.accessToken) throw Error();
    return { httpUrl: http.origin, wsUrl: ws.origin, accessToken: onebot.accessToken, httpAccessToken: onebot.httpAccessToken };
  } catch { throw new Error('账号连接参数无效。'); }
}

/** Dedicated Node child entry. It never creates an Electron app, window, tray or protocol process. */
export function startAccountWorker({ runtimeProcess = process, createApplicationImpl = createApplication, exit = code => process.exit(code) } = {}) {
  let kernel = null, generation = '', expectedAccount = '', initialized = false, stopping = false, stopPromise = null, statusTimer = null;
  const disposers = [];
  const send = value => {
    if (!runtimeProcess.connected || typeof runtimeProcess.send !== 'function') return;
    try { runtimeProcess.send({ ...value, generation }, () => {}); } catch { /* Parent shutdown owns this child. */ }
  };
  const currentIdentity = () => {
    const status = kernel?.transport?.status?.() || {}, candidate = status.selfId ?? status.userId ?? status.user_id ?? kernel?.transport?.selfId;
    return { status, accountId: QQ.test(String(candidate ?? '')) ? String(candidate) : '' };
  };
  const reportStatus = () => {
    if (!kernel || stopping) return;
    const identity = currentIdentity();
    // Stop wrong-account work synchronously; metadata batching must not delay this guard.
    if (identity.status.connected === true && identity.accountId !== expectedAccount) kernel.orchestrator?.pause?.();
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null; if (!kernel || stopping) return;
      const { status, accountId } = currentIdentity();
      if (status.connected === true && accountId !== expectedAccount) kernel.orchestrator?.pause?.();
      send({ type: 'account.status', connected: status.connected === true, accountId,
        nickname: String(status.selfNickname ?? status.nickname ?? kernel.transport?.selfNickname ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80),
        paused: kernel.orchestrator?.status?.()?.paused !== false });
    }, 40); statusTimer.unref?.();
  };
  async function stop(code = 0) {
    if (stopPromise) return stopPromise; stopping = true; clearTimeout(statusTimer);
    return stopPromise = (async () => {
      for (const dispose of disposers.splice(0)) try { dispose(); } catch {}
      try { await kernel?.stop?.(); } catch { code = 1; }
      send({ type: 'account.stopped' }); exit(code);
    })();
  }
  async function initialize(message) {
    if (initialized || stopping) return; initialized = true;
    if (!UUID.test(message.generation || '') || !UUID.test(message.workspaceId || '') || !QQ.test(message.accountId || '')
      || !tokenValid(message.serverToken) || runtimeProcess.env.QQ_AGENT_ACCOUNTS_CHILD !== '1'
      || runtimeProcess.env.QQ_AGENT_ACCOUNT_ID !== message.accountId) throw Error('账号启动身份无效。');
    generation = message.generation; expectedAccount = message.accountId;
    for (const [field, variable] of [['dataDir', 'QQ_AGENT_DATA_DIR'], ['extensionRoot', 'QQ_AGENT_EXTENSION_ROOT'], ['cacheRoot', 'QQ_AGENT_RUNTIME_CACHE_ROOT']]) {
      if (typeof message[field] !== 'string' || path.resolve(message[field]) !== path.resolve(runtimeProcess.env[variable] || '')) throw Error('账号工作区身份无效。');
      await plainDirectory(message[field]);
    }
    await plainDirectory(message.appRoot);
    const dataParent = path.dirname(path.resolve(message.dataDir));
    if (path.basename(dataParent) !== message.workspaceId || path.dirname(path.resolve(message.extensionRoot)) !== dataParent
      || path.dirname(path.resolve(message.cacheRoot)) !== dataParent) throw Error('账号工作区边界无效。');
    kernel = await createApplicationImpl({ appRoot: path.resolve(message.appRoot), env: runtimeProcess.env, headless: false,
      components: { 'runtime.migration.detect': () => ({ eligible: false, reason: '账号工作区不自动迁移其他账号数据' }),
        'runtime.localProtocols': inertProtocols, 'runtime.protocolLogin': inertLogin } });
    if (stopping) { await kernel.stop(); return; }
    kernel.config.update({ server: { token: message.serverToken, port: 0, autoStart: false }, localProtocols: { autoStart: false } });
    kernel.orchestrator.pause();
    let lastToken = message.serverToken;
    disposers.push(kernel.config.onChange(() => {
      if (stopping) return;
      const token = kernel.config.get().server?.token;
      if (!tokenValid(token)) { kernel.config.update({ server: { token: crypto.randomBytes(32).toString('hex') } }); return; }
      if (token !== lastToken) { lastToken = token; send({ type: 'account.credential', token }); }
      reportStatus();
    }));
    for (const name of ['onebot.status', 'status']) disposers.push(kernel.bus.on(name, reportStatus, { internal: true }));
    const port = await kernel.start();
    if (stopping) { await kernel.stop(); return; }
    send({ type: 'account.ready', port }); reportStatus();
  }
  const onMessage = message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'account.initialize') { void initialize(message).catch(async () => { send({ type: 'account.error' }); await stop(1); }); return; }
    if (message.type === 'account.generation' && UUID.test(message.generation || '')) { generation = message.generation; return; }
    if (message.generation !== generation) return;
    if (message.type === 'account.stop') { void stop(); return; }
    if (message.type === 'account.configure' && kernel && !stopping && UUID.test(message.requestId || '')) {
      try { kernel.config.update({ onebot: safeConnection(message.onebot) }); send({ type: 'account.response', requestId: message.requestId, ok: true }); }
      catch { send({ type: 'account.response', requestId: message.requestId, ok: false }); }
    }
    if (message.type === 'account.pause' && kernel && !stopping && UUID.test(message.requestId || '') && typeof message.paused === 'boolean') {
      try {
        const identity = currentIdentity();
        if (!message.paused && (identity.status.connected !== true || identity.accountId !== expectedAccount)) throw new Error('账号身份尚未就绪或已变化。');
        message.paused ? kernel.orchestrator.pause() : kernel.orchestrator.resume(); reportStatus();
        send({ type: 'account.response', requestId: message.requestId, ok: true });
      } catch { send({ type: 'account.response', requestId: message.requestId, ok: false }); }
    }
  };
  runtimeProcess.on('message', onMessage);
  const stopSignal = () => { void stop(); }, fatal = () => { send({ type: 'account.error' }); void stop(1); };
  for (const signal of ['disconnect', 'SIGINT', 'SIGTERM']) runtimeProcess.once(signal, stopSignal);
  for (const signal of ['uncaughtException', 'unhandledRejection']) runtimeProcess.on(signal, fatal);
  return { stop, get kernel() { return kernel; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) startAccountWorker();
