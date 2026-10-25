// 宿主 API 权限约束（不是 Node 代码执行沙箱）：只加载可信插件。
// 管理员授权独立落盘且绑定代码指纹；插件清单只能声明需要什么，不能替管理员同意。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCOPES = {
  'qq.send': { bundled: 'allow', user: 'ask', askable: true, desc: '经发送队列出站' },
  'net.outbound': { bundled: 'allow', user: 'ask', askable: true, desc: 'safe-fetch 出站请求' },
  'net.raw': { bundled: 'deny', user: 'deny', askable: false, desc: '原始 socket 不开放授权' },
  'fs.namespace': { bundled: 'allow', user: 'allow', askable: true, desc: '自己的插件存储命名空间' },
  'fs.outsideNamespace': { bundled: 'deny', user: 'ask', askable: true, desc: '命名空间外读写' },
  'proc.exec': { bundled: 'deny', user: 'ask', askable: true, desc: '拉起子进程' },
  'data.memory.read': { bundled: 'deny', user: 'ask', askable: true, desc: '读记忆仓脱敏视图' },
  'data.sessions.read': { bundled: 'deny', user: 'ask', askable: true, desc: '读会话仓脱敏视图' },
  'ui.panel': { bundled: 'allow', user: 'ask', askable: true, desc: '注册控制台面板' },
  'scheduler': { bundled: 'allow', user: 'allow', askable: true, desc: '常驻定时器' },
  'mcp.connect': { bundled: 'deny', user: 'ask', askable: true, desc: '连接外部 MCP server' },
};
const BUNDLED_SCOPE_EXCEPTIONS = {
  'data.sessions.read': ['query-tools'],
  'proc.exec': ['media-service', 'mcp-bridge'],
  'mcp.connect': ['mcp-bridge'],
};

export function createPermissions({ log = console, bus = null, headless = false, dataDir = null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => Date.now() } = {}) {
  const overrides = new Map();
  const identities = new Map();
  const revisions = new Map();
  const revisionFor = (pluginId, scope) => revisions.get(`${pluginId}\u0000${scope}`) ?? 0;
  const bumpRevision = (pluginId, scope) => revisions.set(`${pluginId}\u0000${scope}`, revisionFor(pluginId, scope) + 1);
  const audit = [];
  const askHandlers = new Set();
  const pending = new Map();
  const pendingByScope = new Map();
  const file = dataDir ? path.join(dataDir, 'plugin-authorizations.json') : null;
  let closed = false;
  const key = (id, scope) => `${id}\u0000${scope}`;

  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (saved.version !== 1 || !Array.isArray(saved.grants)) throw new Error('授权文件格式错误');
      for (const grant of saved.grants) {
        if (typeof grant.pluginId !== 'string' || !/^[a-f0-9]{64}$/.test(grant.fingerprint ?? '') || !Object.hasOwn(SCOPES, grant.scope) || !['allow', 'deny', 'ask'].includes(grant.value)) continue;
        overrides.set(key(grant.pluginId, grant.scope), { value: grant.value, fingerprint: grant.fingerprint });
      }
    } catch { log.warn?.('[permissions] 授权文件不可读，已拒绝采用历史授权；需要重新确认'); }
  }

  function save() {
    if (!file) return;
    const grants = [];
    for (const [compound, record] of overrides) {
      const [pluginId, scope] = compound.split('\u0000');
      if (record.fingerprint) grants.push({ pluginId, scope, ...record });
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function safeDetail(detail) {
    if (detail == null) return null;
    let text;
    try { text = typeof detail === 'string' ? detail : JSON.stringify(detail); }
    catch { text = '[unserializable detail]'; }
    return String(text)
      .replace(/(["']?)(token|secret|password|passwd|api[_-]?key|access[_-]?token|cookie|authorization|path|file|env|command|args)(?:\1)\s*[:=]\s*(?:["'][^"']*["']|[^,;\s}]+)/gi, '$1$2$1=[REDACTED]')
      .replace(/(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\)[^\s,;}\]]+/g, '[REDACTED_PATH]').slice(0, 500);
  }
  function auditRecord(pluginId, scope, decision, detail, requestId = null, resolution = null) {
    const rec = { at: new Date(now()).toISOString(), pluginId, scope, decision, detail: safeDetail(detail), id: crypto.randomUUID().slice(0, 8), ...(requestId ? { requestId } : {}), ...(resolution ? { resolution } : {}) };
    audit.push(rec);
    if (audit.length > 2000) audit.shift();
    bus?.emit('permission.decision', rec);
    if (decision === 'deny') log.warn?.(`[permissions] 拒绝 ${pluginId} → ${scope}（${rec.detail ?? ''}）`);
  }
  function isCurrent(pluginId, fingerprint = null) {
    const identity = identities.get(pluginId);
    if (!identity) return !dataDir && !fingerprint;
    if (fingerprint && fingerprint !== identity.fingerprint) return false;
    try { return identity.isCurrent?.() !== false; } catch { return false; }
  }
  function overrideFor(pluginId, scope) {
    const record = overrides.get(key(pluginId, scope));
    if (!record) return null;
    const identity = identities.get(pluginId);
    if (record.fingerprint && (record.fingerprint !== identity?.fingerprint || !isCurrent(pluginId))) return null;
    return record.value;
  }
  function allowed(pluginId, scope, { kind = 'user', fingerprint = null } = {}) {
    const revision = revisionFor(pluginId, scope);
    const identity = identities.get(pluginId);
    return {
      decision: 'allow', reason: null,
      // 内部一次性凭据：不重新请求 once；授权/身份/代码/服务生命周期变化均失效。
      isValid: () => !closed && revisionFor(pluginId, scope) === revision
        && (kind === 'bundled' || (identities.get(pluginId) === identity && isCurrent(pluginId, fingerprint)))
        && overrideFor(pluginId, scope) !== 'deny',
    };
  }
  function settle(item, decision, reason, resolution) {
    const { request } = item;
    clearTimeoutFn(item.timer);
    pending.delete(request.id);
    if (pendingByScope.get(key(request.pluginId, request.scope)) === item) pendingByScope.delete(key(request.pluginId, request.scope));
    auditRecord(request.pluginId, request.scope, decision, reason, request.id, resolution);
    item.resolve(decision === 'allow'
      ? allowed(request.pluginId, request.scope, { fingerprint: request.fingerprint })
      : { decision, reason });
  }
  function cancelPending(pluginId, scope = null, reason = '插件状态或授权已改变') {
    for (const item of [...pending.values()]) {
      if (item.request.pluginId === pluginId && (scope === null || item.request.scope === scope)) settle(item, 'deny', reason, 'invalidated');
    }
  }
  function bindPlugin(pluginId, { fingerprint, scopes = [], isCurrent: current = () => true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw new Error('插件代码指纹无效');
    cancelPending(pluginId);
    const declared = new Set(scopes.map((scope) => scope === 'web_fetch' ? 'net.outbound' : scope));
    identities.set(pluginId, { fingerprint, scopes: declared, isCurrent: current });
  }
  function unbindPlugin(pluginId) { cancelPending(pluginId); identities.delete(pluginId); }
  function revokePlugin(pluginId) {
    const previous = [...overrides.entries()].filter(([compound]) => compound.split('\u0000')[0] === pluginId);
    for (const [compound] of previous) overrides.delete(compound);
    try { save(); } catch (error) {
      for (const [compound, record] of previous) overrides.set(compound, record);
      throw error;
    }
    // 原子持久化成功后再令一次性凭据和等待请求失效；失败时不损坏旧授权。
    for (const scope of Object.keys(SCOPES)) bumpRevision(pluginId, scope);
    unbindPlugin(pluginId);
    return previous.length;
  }
  function setOverride(pluginId, scope, value, { fingerprint = null } = {}) {
    if (closed || !Object.hasOwn(SCOPES, scope) || !['allow', 'deny', 'ask'].includes(value)) return false;
    const identity = identities.get(pluginId);
    if (dataDir && (!identity || !isCurrent(pluginId, fingerprint) || !identity.scopes.has(scope))) return false;
    if (fingerprint && (!identity || !isCurrent(pluginId, fingerprint))) return false;
    const record = { value, fingerprint: identity?.fingerprint ?? null };
    const compound = key(pluginId, scope);
    const previous = overrides.get(compound);
    overrides.set(compound, record);
    try { save(); } catch (error) {
      if (previous) overrides.set(compound, previous); else overrides.delete(compound);
      throw error;
    }
    bumpRevision(pluginId, scope);
    cancelPending(pluginId, scope, '管理员已改变该权限');
    auditRecord(pluginId, scope, value, '管理员显式决定');
    return true;
  }
  function check(pluginId, scope, { kind = 'user', detail = null, notify = true, auditAsk = true, fingerprint = null, hostBinding = false } = {}) {
    const reject = (reason) => { auditRecord(pluginId, scope, 'deny', reason); return { decision: 'deny', reason }; };
    if (closed) return reject('权限服务已关闭');
    const def = Object.hasOwn(SCOPES, scope) ? SCOPES[scope] : null;
    if (!def) return reject(`未知权限范围 ${scope}`);
    if (!def.askable) return reject('该权限不开放授权');
    if (kind === 'bundled') {
      if (hostBinding && ['data.sessions.read', 'data.memory.read', 'fs.outsideNamespace'].includes(scope)) {
        auditRecord(pluginId, scope, 'allow', '具名宿主绑定'); return allowed(pluginId, scope, { kind, fingerprint });
      }
      if (def.bundled === 'allow' || BUNDLED_SCOPE_EXCEPTIONS[scope]?.includes(pluginId)) {
        auditRecord(pluginId, scope, 'allow', '捆绑默认或白名单'); return allowed(pluginId, scope, { kind, fingerprint });
      }
      return reject('捆绑插件未声明该权限');
    }
    const identity = identities.get(pluginId);
    if ((identity || fingerprint) && !isCurrent(pluginId, fingerprint)) return reject('插件内容已改变或调用来自旧实例，请重新加载并授权');
    if (dataDir && !identity) return reject('插件未绑定宿主身份');
    if (identity && def.user !== 'allow' && !identity.scopes.has(scope)) return reject('插件未声明该权限');
    const ov = overrideFor(pluginId, scope);
    if (ov === 'deny') return reject('该权限已被管理员关闭');
    if (ov === 'allow' || (def.user === 'allow' && ov !== 'ask')) {
      auditRecord(pluginId, scope, 'allow', ov === 'allow' ? '管理员覆盖' : '用户默认允许'); return allowed(pluginId, scope, { kind, fingerprint });
    }
    if (headless) return reject('无人在场，该操作需要人工确认（headless ask=deny）');
    if (notify) for (const fn of askHandlers) { try { fn({ pluginId, scope, detail }); } catch {} }
    if (auditAsk) auditRecord(pluginId, scope, 'ask', '等待用户决定');
    return { decision: 'ask', reason: def.desc };
  }
  function checkAsync(pluginId, scope, opts = {}) {
    const verdict = check(pluginId, scope, { ...opts, notify: false, auditAsk: false });
    if (verdict.decision !== 'ask') return Promise.resolve(verdict);
    const compound = key(pluginId, scope);
    const existing = pendingByScope.get(compound);
    if (existing) return existing.promise;
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId, requestId, pluginId, scope, detail: safeDetail(opts.detail), reason: verdict.reason,
      fingerprint: identities.get(pluginId)?.fingerprint ?? null,
      createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 60000).toISOString(),
    };
    let resolveRequest;
    const promise = new Promise((resolve) => { resolveRequest = resolve; });
    const item = { request, timer: null, resolve: resolveRequest, promise };
    pending.set(requestId, item); pendingByScope.set(compound, item);
    item.timer = setTimeoutFn(() => {
      if (pending.get(requestId) === item) settle(item, 'deny', '权限确认超时', 'timeout');
    }, 60000);
    auditRecord(pluginId, scope, 'ask', '等待用户决定', requestId, 'pending');
    bus?.emit('permission.ask', request);
    for (const fn of askHandlers) { try { fn(request); } catch {} }
    return promise;
  }
  function resolveAsk(requestId, decision) {
    const item = pending.get(String(requestId));
    if (!item) return { ok: false, error: '权限请求不存在或已过期' };
    if (!['once', 'always', 'deny'].includes(decision)) return { ok: false, error: '决定必须是 once、always 或 deny' };
    const { pluginId, scope, fingerprint } = item.request;
    if ((fingerprint && !isCurrent(pluginId, fingerprint)) || overrideFor(pluginId, scope) === 'deny') {
      settle(item, 'deny', '插件版本或授权已改变', 'invalidated'); return { ok: false, error: '插件版本或授权已改变' };
    }
    if (decision === 'always') {
      const compound = key(pluginId, scope);
      const previous = overrides.get(compound);
      overrides.set(compound, { value: 'allow', fingerprint });
      try { save(); } catch (error) {
        if (previous) overrides.set(compound, previous); else overrides.delete(compound);
        return { ok: false, error: '无法保存授权，本次未放行' };
      }
      bumpRevision(pluginId, scope);
    }
    settle(item, decision === 'deny' ? 'deny' : 'allow', decision === 'deny' ? '用户拒绝该权限' : '用户同意', decision);
    return { ok: true, requestId: String(requestId), decision };
  }
  function close(reason = '权限服务已关闭') {
    closed = true;
    for (const item of [...pending.values()]) settle(item, 'deny', reason, 'shutdown');
    askHandlers.clear();
  }
  return {
    check, checkAsync, resolveAsk, close, bindPlugin, unbindPlugin, revokePlugin, isCurrent, setOverride,
    pending: () => [...pending.values()].map(({ request }) => ({ ...request })),
    scopes: () => Object.fromEntries(Object.entries(SCOPES).map(([scope, def]) => [scope, { ...def }])),
    isGranted(pluginId, scope, fingerprint = null) {
      if (!isCurrent(pluginId, fingerprint)) return false;
      const def = Object.hasOwn(SCOPES, scope) ? SCOPES[scope] : null;
      if (closed || !def?.askable || !identities.get(pluginId)?.scopes.has(scope)) return false;
      const ov = overrideFor(pluginId, scope);
      return ov === 'allow' || (def.user === 'allow' && ov !== 'deny' && ov !== 'ask');
    },
    status(pluginId, scope) { return { scope, def: Object.hasOwn(SCOPES, scope) ? { ...SCOPES[scope] } : null, override: overrideFor(pluginId, scope), fingerprint: identities.get(pluginId)?.fingerprint ?? null }; },
    onAsk(fn) { askHandlers.add(fn); return () => askHandlers.delete(fn); },
    audit: ({ n = 100 } = {}) => audit.slice(-n),
  };
}
