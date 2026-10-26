import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminateOwnedProtocolProcess } from '../protocols/process-tree.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QQ = /^[0-9]{5,10}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
const alive = child => child && child.exitCode == null && child.signalCode == null;
const inside = (root, target) => { const rel = path.relative(root, target); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

async function directory(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('账号工作区路径包含链接或不是普通目录。');
  }
  return absolute;
}
async function regularJson(file, missing = null) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw fail('账号工作区文件不是有效的普通文件。');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fail('账号工作区文件不是有效 JSON，已保留原文件。'); }
}
async function atomicJson(file, value) {
  await regularJson(file, null);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function unlocked(dataDir) {
  const file = path.join(dataDir, 'qq-agent.lock');
  let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) throw fail('账号实例锁无效，未修改工作区。', 409);
  const text = (await fs.readFile(file, 'utf8')).trim(), pid = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(pid)) throw fail('账号实例锁无效，未修改工作区。', 409);
  try { process.kill(pid, 0); throw fail('此账号工作区已有实例运行，未修改工作区。', 409); }
  catch (error) { if (error.code === 'ESRCH') return; if (error.code === 'EPERM') throw fail('此账号工作区已有实例运行，未修改工作区。', 409); throw error; }
}
async function existingDirectory(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('背景资产路径不可用。');
  }
}
async function readBackground(file) {
  const limit = 8 * 1024 * 1024;
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || !before.size || before.size > limit) throw new Error('背景资产不可用。');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('背景资产已变化。');
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead;
      if (size > limit) throw new Error('背景资产过大。');
    }
    const after = await fs.lstat(file);
    if (after.isSymbolicLink() || !after.isFile() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== size) throw new Error('背景资产已变化。');
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
/** Seed only unscoped local background assets; never fetch URLs or inspect another account. */
async function seedBackgrounds(ui, sourceData, targetData) {
  const source = path.join(sourceData, 'ui', 'backgrounds'), target = path.join(targetData, 'ui', 'backgrounds'), copied = new Map();
  async function copy(name) {
    if (copied.has(name)) return copied.get(name);
    let valid = false;
    try {
      await existingDirectory(source);
      const bytes = await readBackground(path.join(source, name));
      await existingDirectory(source);
      await directory(target);
      const destination = path.join(target, name);
      try { await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readBackground(destination)).equals(bytes)) throw new Error('目标背景资产已存在。');
      }
      valid = true;
    } catch { /* A missing/unsafe picture must not discard the account's colors. */ }
    copied.set(name, valid); return valid;
  }
  async function visit(value) {
    if (typeof value === 'string') {
      const local = /^\/(?:ui\/backgrounds|api\/uikit\/background)\//.test(value.trim());
      const scoped = /^\/accounts\/[^/]+\/(?:ui\/backgrounds|api\/uikit\/background)\//i.test(value.trim());
      if (scoped) return '';
      if (!local) return value;
      const match = /^\/(?:ui\/backgrounds|api\/uikit\/background)\/([A-Za-z0-9._-]{1,160})$/.exec(value);
      if (!match || ['.', '..'].includes(match[1]) || match[1].endsWith('.')) return '';
      return await copy(match[1]) ? value : '';
    }
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = await visit(value[i]); }
    else if (value && typeof value === 'object') { for (const key of Object.keys(value)) value[key] = await visit(value[key]); }
    return value;
  }
  return visit(ui);
}
function identity(primary) {
  let status = {};
  try { status = primary?.transport?.status?.() || {}; } catch {}
  const candidate = status.selfId ?? status.userId ?? status.user_id ?? primary?.transport?.selfId;
  const accountId = QQ.test(String(candidate ?? '')) ? String(candidate) : '';
  return { accountId, nickname: clean(status.selfNickname ?? status.nickname ?? primary?.transport?.selfNickname),
    connected: status.connected === true, paused: primary?.orchestrator?.status?.()?.paused === true,
    provider: status.provider ?? status.id ?? primary?.transport?.id ?? '' };
}
function connection(input) {
  if (!input || typeof input.accountId !== 'string' || !QQ.test(input.accountId)
    || !['napcat', 'snowluma'].includes(input.provider)
    || ![input.httpPort, input.wsPort].every(value => Number.isInteger(value) && value > 0 && value < 65536)
    || input.httpPort === input.wsPort || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{16,4096}$/.test(input.token)) {
    throw fail('账号连接参数无效。');
  }
  return { accountId: input.accountId, nickname: clean(input.nickname), provider: input.provider,
    onebot: { httpUrl: `http://127.0.0.1:${input.httpPort}`, wsUrl: `ws://127.0.0.1:${input.wsPort}`,
      accessToken: input.token, httpAccessToken: input.token } };
}

/** Each child owns its kernel and data. The public registry never stores endpoint credentials. */
export function createAccountManager({ appRoot, dataDir, config, bus, getPrimary = () => ({}), spawnImpl = fork,
  terminateImpl = child => terminateOwnedProtocolProcess(child), env = process.env,
  startTimeoutMs = 30000, stopTimeoutMs = 12000, requestTimeoutMs = 10000 } = {}) {
  const root = path.resolve(dataDir), accountsRoot = path.join(root, 'accounts'), manifest = path.join(root, 'accounts.json');
  const records = new Map(), runtimes = new Map(), queues = new Map(), removedAccounts = new Set();
  let initialized, registryError = '', closed = false, closing, registryQueue = Promise.resolve(), revision = 0, primaryAccount = null, primaryMismatch = false;
  let primaryWanted = true, primaryTransition = '', primaryConnectionError = '';
  const emit = (id, status) => { try { bus?.emit?.('accounts', { revision: ++revision, id, status }); } catch {} };
  const failed = id => { const runtime = runtimes.get(id) || { id }; if (!(runtime.status === 'running' && alive(runtime.child) && runtime.port)) runtime.status = 'error'; runtime.error ||= '此账号工作区未能完成操作，请检查数据目录和实例状态。'; runtimes.set(id, runtime); emit(id, runtime.status); };
  const serial = (id, work) => { const pending = (queues.get(id) || Promise.resolve()).catch(() => {}).then(work); queues.set(id, pending); pending.finally(() => { if (queues.get(id) === pending) queues.delete(id); }).catch(() => {}); return pending; };
  const registry = work => { const next = registryQueue.then(work); registryQueue = next.catch(() => {}); return next; };
  async function init() {
    if (!initialized) initialized = (async () => {
      await directory(root); await directory(accountsRoot);
      try {
        const value = await regularJson(manifest, { version: 1, accounts: [] });
        if (value?.version !== 1 || !Array.isArray(value.accounts)) throw Error();
        if (value.primaryWanted !== undefined && typeof value.primaryWanted !== 'boolean') throw Error();
        if (value.removedAccounts !== undefined && (!Array.isArray(value.removedAccounts) || value.removedAccounts.some(id => typeof id!=='string'||!QQ.test(id)) || new Set(value.removedAccounts).size!==value.removedAccounts.length)) throw Error();
        if (value.primaryAccount !== undefined && (!value.primaryAccount || typeof value.primaryAccount.accountId !== 'string' || !QQ.test(value.primaryAccount.accountId))) throw Error();
        const ids = new Set(), qqs = new Set();
        for (const item of value.accounts) {
          if (!UUID.test(item?.id || '') || !QQ.test(item?.accountId || '') || ids.has(item.id) || qqs.has(item.accountId)
            || !['napcat', 'snowluma'].includes(item.provider) || typeof item.wanted !== 'boolean') throw Error();
          ids.add(item.id); qqs.add(item.accountId);
        }
        for (const item of value.accounts) records.set(item.id, { id: item.id, accountId: item.accountId,
          nickname: clean(item.nickname), provider: item.provider, wanted: item.wanted });
        if (value.primaryAccount) primaryAccount = { accountId: value.primaryAccount.accountId, nickname: clean(value.primaryAccount.nickname),
          ...(['napcat', 'snowluma'].includes(value.primaryAccount.provider) ? { provider: value.primaryAccount.provider } : {}) };
        primaryWanted = value.primaryWanted !== false;
        for(const id of value.removedAccounts||[])removedAccounts.add(id);
        for(const record of records.values())if(removedAccounts.has(record.accountId))record.wanted=false;
        if(primaryAccount&&removedAccounts.has(primaryAccount.accountId))primaryWanted=false;
      } catch { registryError = '账号工作区清单无效，已保留原文件。'; }
      // snapshot() is awaited by the kernel before services.start(), so an
      // explicitly disconnected primary never opens a socket during startup.
      if (!primaryWanted && !registryError) {
        const primary = primaryOf(); primary.orchestrator?.pause?.();
        if (typeof primary.services?.setEnabled !== 'function') primaryConnectionError = '当前传输实现不支持独立断开。';
        else try { await primary.services.setEnabled('transport.provider', false); }
        catch { primaryConnectionError = '此账号连接未能完全停止，请检查协议端连接状态。'; }
      }
    })();
    await initialized;
  }
  const usable = async () => { await init(); if (closed) throw fail('账号工作区管理已停止。', 409); if (registryError) throw fail(registryError, 409); };
  const save = () => atomicJson(manifest, { version: 1, primaryWanted, ...(primaryAccount ? { primaryAccount } : {}), ...(removedAccounts.size?{removedAccounts:[...removedAccounts]}:{}), accounts: [...records.values()].map(({ id, accountId, nickname, provider, wanted }) => ({ id, accountId, nickname, provider, wanted })) });
  const primaryOf = () => { try { return getPrimary() || {}; } catch { return {}; } };
  function guardPrimary() {
    const primary = primaryOf(), observed = identity(primary);
    if (!primaryWanted) { primary.orchestrator?.pause?.(); observed.paused = true; }
    if (primaryAccount && observed.accountId) {
      primaryMismatch = observed.accountId !== primaryAccount.accountId;
      if (primaryMismatch) { primary.orchestrator?.pause?.(); observed.paused = true; }
    }
    return observed;
  }
  async function observePrimary() {
    await init(); const observed = guardPrimary();
    if (!closed && !registryError && !primaryAccount && observed.accountId) {
      const binding = { accountId: observed.accountId, nickname: observed.nickname };primaryAccount = binding;
      try{await registry(save);}catch(error){if(primaryAccount===binding)primaryAccount=null;throw error;}guardPrimary(); emit('primary', 'bound');
    }
    // A status event may have started binding before this caller arrived.
    // Do not report startup/restoration ready while that manifest is pending.
    await registryQueue;
    return observed;
  }
  const primarySubscriptions = [
    bus?.on?.('onebot.status', () => { guardPrimary(); void observePrimary().catch(() => {}); }, { internal: true }),
    bus?.on?.('status', () => { guardPrimary(); }, { internal: true }),
  ];
  async function locations(id) {
    if (!UUID.test(id || '')) throw fail('账号工作区不存在。', 404);
    const workspace = path.join(accountsRoot, id);
    if (!inside(accountsRoot, workspace)) throw fail('账号工作区路径越界。');
    await directory(workspace);
    const accountData = await directory(path.join(workspace, 'data'));
    const extensionRoot = await directory(path.join(workspace, 'extensions'));
    await directory(path.join(extensionRoot, 'plugins')); await directory(path.join(extensionRoot, 'skills'));
    const cacheRoot = await directory(path.join(workspace, 'extension-cache'));
    return { workspace, dataDir: accountData, extensionRoot, cacheRoot, file: path.join(accountData, 'config.json') };
  }
  function bind(child, message) {
    return new Promise((resolve, reject) => {
      if (!alive(child) || typeof child.send !== 'function') return reject(fail('账号工作进程已停止。', 409));
      try { child.send(message, error => error ? reject(fail('无法向账号工作进程发送指令。', 502)) : resolve()); }
      catch { reject(fail('无法向账号工作进程发送指令。', 502)); }
    });
  }
  async function request(runtime, type, patch = {}) {
    const requestId = crypto.randomUUID();
    let timer;
    const result = new Promise((resolve, reject) => {
      runtime.requests.set(requestId, { resolve, reject });
      timer = setTimeout(() => { runtime.requests.delete(requestId); reject(fail('账号工作进程未及时响应。', 504)); }, requestTimeoutMs); timer.unref?.();
    });
    result.catch(() => {});
    try { await bind(runtime.child, { type, requestId, generation: runtime.generation, ...patch }); return await result; }
    finally { clearTimeout(timer); runtime.requests.delete(requestId); }
  }
  async function startInternal(id) {
    await usable(); const record = records.get(id); if (!record) throw fail('账号工作区不存在。', 404);
    const existing = runtimes.get(id); if (existing?.status === 'running' && alive(existing.child)) return { workspaceId: id };
    if (existing && alive(existing.child)) await stopInternal(id, false);
    const dirs = await locations(id); await unlocked(dirs.dataDir); const saved = await regularJson(dirs.file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw fail('此账号尚未保存连接配置。', 409);
    const token = crypto.randomBytes(32).toString('hex'), generation = crypto.randomUUID();
    const runtime = { id, generation, token, port: null, status: 'starting', connected: false, paused: true, error: '', child: null, requests: new Map(), transport: {} };
    runtimes.set(id, runtime); emit(id, 'starting');
    let readyResolve, readyReject, exitResolve;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => {});
    runtime.exited = new Promise(resolve => { exitResolve = resolve; });
    let timer;
    try {
      const child = spawnImpl(WORKER, [], { execPath: process.execPath, execArgv: [], cwd: path.resolve(appRoot),
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', QQ_AGENT_ACCOUNTS_CHILD: '1', QQ_AGENT_ACCOUNT_ID: record.accountId,
          QQ_AGENT_DATA_DIR: dirs.dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_PROFILE: '1', QQ_AGENT_EXTENSION_ROOT: dirs.extensionRoot,
          QQ_AGENT_RUNTIME_CACHE_ROOT: dirs.cacheRoot, QQ_AGENT_ACCOUNT_PREFIX: '/accounts/' + id,
          QQ_AGENT_MIGRATE_FROM: '', QQ_AGENT_PROTOCOL_DIR: path.join(dirs.workspace, 'protocols') },
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      runtime.child = child;
      // Never forward worker stdout/configuration into browser events or startup credentials.
      child.stdout?.resume?.(); child.stderr?.resume?.();
      child.on('message', message => {
        if (runtimes.get(id) !== runtime || message?.generation !== runtime.generation) return;
        if (message.type === 'account.ready') {
          if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return readyReject(fail('账号工作进程返回了无效端口。', 502));
          runtime.port = message.port; runtime.status = 'running'; runtime.paused = true; readyResolve(); emit(id, 'running');
        } else if (message.type === 'account.credential' && typeof message.token === 'string' && /^[A-Za-z0-9_-]{16,4096}$/.test(message.token)) {
          runtime.token = message.token; runtime.generation = crypto.randomUUID();
          void bind(child, { type: 'account.generation', generation: runtime.generation }).catch(() => {}); emit(id, 'credentials');
        } else if (message.type === 'account.status') {
          runtime.connected = message.connected === true; runtime.paused = message.paused !== false;
          runtime.transport = { selfId: QQ.test(String(message.accountId || '')) ? String(message.accountId) : '', nickname: clean(message.nickname) };
          if (runtime.connected && runtime.transport.selfId !== record.accountId) { runtime.connected = false; runtime.error = '协议端当前账号与此工作区不一致。'; }
          else runtime.error = '';
          emit(id, runtime.status);
        } else if (message.type === 'account.response') {
          const pending = runtime.requests.get(message.requestId); if (!pending) return;
          runtime.requests.delete(message.requestId); message.ok === true ? pending.resolve() : pending.reject(fail('账号工作进程未完成配置。', 502));
        } else if (message.type === 'account.error') { runtime.error = '账号工作进程启动或运行失败。'; readyReject(fail(runtime.error, 502)); emit(id, 'error'); }
      });
      child.once('error', () => { runtime.error = '无法启动账号工作进程。'; readyReject(fail(runtime.error, 502)); });
      child.once('exit', () => {
        clearTimeout(timer); runtime.port = null; runtime.connected = false;
        if (runtime.status !== 'stopping' && runtime.status !== 'stopped') { runtime.status = 'error'; runtime.error ||= '账号工作进程已退出。'; }
        else runtime.status = 'stopped';
        for (const item of runtime.requests.values()) item.reject(fail('账号工作进程已退出。', 409)); runtime.requests.clear();
        readyReject(fail(runtime.error || '账号工作进程已退出。', 502)); exitResolve(); emit(id, runtime.status);
      });
      timer = setTimeout(() => readyReject(fail('账号工作进程启动超时。', 504)), startTimeoutMs); timer.unref?.();
      await bind(child, { type: 'account.initialize', generation, workspaceId: id, accountId: record.accountId, appRoot: path.resolve(appRoot),
        dataDir: dirs.dataDir, extensionRoot: dirs.extensionRoot, cacheRoot: dirs.cacheRoot, serverToken: token });
      await ready; if (closed) throw fail('账号工作区管理已停止。', 409);
      return { workspaceId: id };
    } catch (error) {
      runtime.error = '账号工作进程未能启动。';
      if (runtime.child && alive(runtime.child)) await stopInternal(id, false).catch(() => {});
      runtime.status = 'error'; emit(id, 'error'); throw fail(error.status === 504 ? '账号工作进程启动超时。' : '账号工作进程未能启动。', error.status || 502);
    } finally { clearTimeout(timer); }
  }
  async function stopInternal(id, explicit) {
    const record = records.get(id); if (!record) throw fail('账号工作区不存在。', 404);
    if (explicit) { await registry(async()=>{const previous=record.wanted;record.wanted=false;try{await save();}catch(error){record.wanted=previous;throw error;}}); }
    const runtime = runtimes.get(id); if (!runtime?.child || !alive(runtime.child)) { if (runtime) runtime.status = 'stopped'; emit(id, 'stopped'); return { workspaceId: id }; }
    runtime.status = 'stopping'; runtime.port = null; emit(id, 'stopping');
    await bind(runtime.child, { type: 'account.stop', generation: runtime.generation }).catch(() => {});
    let timer; const stopped = await Promise.race([runtime.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), stopTimeoutMs); timer.unref?.(); })]); clearTimeout(timer);
    if (!stopped && alive(runtime.child)) {
      await terminateImpl(runtime.child);
      let finalTimer; const exited = await Promise.race([runtime.exited.then(() => true), new Promise(resolve => { finalTimer = setTimeout(() => resolve(false), Math.max(1000, stopTimeoutMs)); finalTimer.unref?.(); })]); clearTimeout(finalTimer);
      if (!exited) { runtime.status = 'error'; runtime.error = '账号工作进程未能退出；实例锁已保留。'; throw fail(runtime.error, 502); }
    }
    runtime.status = 'stopped'; runtime.connected = false; emit(id, 'stopped'); return { workspaceId: id };
  }
  async function registerConnection(input) {
    const selected = connection(input); await usable(); await observePrimary();
    if (primaryAccount?.accountId === selected.accountId) {await registry(async()=>{if(!removedAccounts.delete(selected.accountId))return;try{await save();}catch(error){removedAccounts.add(selected.accountId);throw error;}});return { workspaceId: 'primary' };}
    const record = await registry(async () => {
      let row = [...records.values()].find(item => item.accountId === selected.accountId);
      const previous = row ? { ...row } : null;
      if (!row) { row = { id: crypto.randomUUID(), accountId: selected.accountId, nickname: selected.nickname, provider: selected.provider, wanted: true }; records.set(row.id, row); }
      else { row.nickname = selected.nickname || row.nickname; row.provider = selected.provider; row.wanted = true; }
      const removed=removedAccounts.delete(selected.accountId);try{await save();}catch(error){if(previous)Object.assign(row,previous);else records.delete(row.id);if(removed)removedAccounts.add(selected.accountId);throw error;}return row;
    });
    return serial(record.id, async () => {
      await usable();if(removedAccounts.has(record.accountId))throw fail('账号已移除，请重新选择账号接入。',409);const runtime = runtimes.get(record.id);
      if (runtime?.status === 'running' && alive(runtime.child)) { await request(runtime, 'account.configure', { onebot: selected.onebot }); return { workspaceId: record.id }; }
      const dirs = await locations(record.id); await unlocked(dirs.dataDir); const previous = await regularJson(dirs.file);
      if (previous !== null && (typeof previous !== 'object' || Array.isArray(previous))) throw fail('此账号配置根节点无效，已保留原文件。', 409);
      const initial = previous || structuredClone(config.get());
      if (!previous && initial.ui) initial.ui = await seedBackgrounds(initial.ui, root, dirs.dataDir);
      await atomicJson(dirs.file, { ...initial, onebot: selected.onebot,
        // New accounts must explicitly choose their own moderation rules.
        ...(!previous ? { extensions: { ...initial.extensions, providers: {} },management:{version:1,rules:[]} } : {}),
        server: { ...initial.server, token: '', port: 0, autoStart: false }, desktop: { ...initial.desktop, autoStart: false },
        localProtocols: { selectedId: '', account: '', autoStart: false } });
      return startInternal(record.id);
    }).catch(error => { failed(record.id); throw error; });
  }
  async function setPrimaryConnection(enabled) {
    await usable(); const primary = primaryOf();
    if (typeof primary.services?.setEnabled !== 'function') throw fail('当前传输实现不支持独立连接开关。', 409);
    // Reconnecting never silently resumes model work or automatic replies.
    primary.orchestrator?.pause?.();
    await registry(async () => { const previous = primaryWanted, removed=enabled&&primaryAccount&&removedAccounts.delete(primaryAccount.accountId); primaryWanted = enabled;
      try { await save(); } catch (error) { primaryWanted = previous;if(removed)removedAccounts.add(primaryAccount.accountId);throw error; } });
    primaryTransition = enabled ? 'starting' : 'stopping'; primaryConnectionError = ''; emit('primary', primaryTransition);
    try { await primary.services.setEnabled('transport.provider', enabled); }
    catch { primaryConnectionError = enabled ? '此账号未能建立连接，请检查协议端连接状态。' : '此账号连接未能完全停止，请检查协议端连接状态。';
      throw fail(primaryConnectionError, 502); }
    finally { primaryTransition = ''; guardPrimary(); emit('primary', primaryConnectionError ? 'error' : enabled ? 'running' : 'stopped'); }
    return { workspaceId: 'primary' };
  }
  async function start(id) { await usable(); if (id === 'primary') return serial(id, () => setPrimaryConnection(true)); if (!records.has(id)) throw fail('账号工作区不存在。', 404); return serial(id, async () => {if(removedAccounts.has(records.get(id).accountId))throw fail('账号已移除，请通过连接 QQ 重新添加。',409);await registry(async () => { const row=records.get(id),previous=row.wanted;row.wanted=true;try{await save();}catch(error){row.wanted=previous;throw error;} }); return startInternal(id); }).catch(error => { failed(id); throw error; }); }
  async function stop(id) { await usable(); return serial(id, () => id === 'primary' ? setPrimaryConnection(false) : stopInternal(id, true)); }
  // Removal forgets the visible connection, retaining the private workspace so
  // explicitly adding the same QQ again restores its own settings and history.
  async function remove(input={}) {
    await usable();await observePrimary();const id=input?.id,qq=input?.accountId;
    if(id!==undefined&&id!=='primary'&&!UUID.test(id||''))throw fail('账号标识无效。');
    if(qq!==undefined&&(typeof qq!=='string'||!QQ.test(qq)))throw fail('QQ 账号无效。');
    const record=id==='primary'?null:id?records.get(id):[...records.values()].find(row=>row.accountId===qq);
    if(id&&id!=='primary'&&!record)throw fail('账号工作区不存在。',404);
    const primary=id==='primary'||!id&&primaryAccount?.accountId===qq,target=primary?primaryAccount?.accountId:record?.accountId||qq;
    if(!target||qq&&target!==qq)throw fail('账号身份已变化，请刷新后重试。',409);
    return serial(primary?'primary':record?.id||'hidden:'+target,async()=>{
      if(primary)await setPrimaryConnection(false);else if(record)await stopInternal(record.id,true);
      await registry(async()=>{const existed=removedAccounts.has(target);removedAccounts.add(target);try{await save();}catch(error){if(!existed)removedAccounts.delete(target);throw error;}});
      emit(primary?'primary':record?.id||target,'removed');return {workspaceId:primary?'primary':record?.id||null,accountId:target};
    });
  }
  async function restore() { await init(); if (closed || registryError) return; await observePrimary(); for (const record of records.values()) if (record.wanted) await serial(record.id, () => startInternal(record.id)).catch(() => { failed(record.id); }); }
  function backend(id) {
    if(removedAccounts.has(records.get(id)?.accountId))return null;
    const runtime = runtimes.get(id); if (!runtime || runtime.status !== 'running' || !alive(runtime.child) || !runtime.port) return null;
    return { port: runtime.port, token: runtime.token, generation: runtime.generation };
  }
  async function snapshot() {
    await init(); const observed = await observePrimary(), primary = primaryAccount ? { ...observed,
      accountId: primaryAccount.accountId, nickname: primaryAccount.nickname || (observed.accountId === primaryAccount.accountId ? observed.nickname : ''),
      connected: observed.connected && observed.accountId === primaryAccount.accountId && !primaryMismatch } : observed;
    const primaryRemoved=removedAccounts.has(primaryAccount?.accountId);
    return { primary: 'primary', ...(registryError ? { error: registryError } : {}), removedAccounts:[...removedAccounts].map(accountId=>({accountId})),accounts: [
      { id: 'primary', workspaceId: 'primary', primary: true, ...primary,...(primaryRemoved?{accountId:'',nickname:'',connected:false,removed:true}:{}),
        status: primaryConnectionError || primaryMismatch ? 'error' : primaryTransition || (primaryWanted ? 'running' : 'stopped'), wanted: primaryWanted,
        ...(primaryConnectionError ? { error: primaryConnectionError } : primaryMismatch ? { error: '主工作区连接到了其他 QQ；已暂停，请恢复原账号连接。' } : {}) },
      ...[...records.values()].filter(record=>!removedAccounts.has(record.accountId)).map(record => { const runtime = runtimes.get(record.id); return { ...record, workspaceId: record.id, primary: false,
        status: runtime?.status || 'stopped', connected: runtime?.connected === true, paused: runtime?.paused !== false, error: runtime?.error || '' }; }),
    ] };
  }
  async function setPaused(paused) {
    await usable(); if (typeof paused !== 'boolean') throw fail('暂停状态必须是开关值。'); await observePrimary();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        if (!primaryWanted) return;
        const observed = guardPrimary();
        if (!paused && primaryAccount && (!observed.connected || observed.accountId !== primaryAccount.accountId || primaryMismatch)) throw fail('主工作区账号身份尚未就绪，无法恢复自动回复。', 409);
        const orchestrator = primaryOf()?.orchestrator; return paused ? orchestrator?.pause?.() : orchestrator?.resume?.();
      }),
      ...[...runtimes.values()].filter(runtime => runtime.status === 'running' && alive(runtime.child)).map(async runtime => {
        await request(runtime, 'account.pause', { paused }); runtime.paused = paused; emit(runtime.id, runtime.status);
      }),
    ]);
    const failures = results.filter(item => item.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(item => item.reason), '部分账号未能修改暂停状态。');
    return { ok: true };
  }
  function close() {
    if (closing) return closing; closed = true; for (const off of primarySubscriptions) off?.();
    return closing = (async () => { await registryQueue.catch(() => {}); await Promise.allSettled([...queues.values()]); const results = await Promise.allSettled([...records.keys()].map(id => stopInternal(id, false)));
      const failed = results.filter(item => item.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(item => item.reason), '部分账号工作进程未能停止。'); })();
  }
  return { snapshot, registerConnection, start, stop, remove,restore, close, backend, setPaused };
}
