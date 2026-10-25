// OneBot v11 客户端：WS 收事件 + HTTP 发动作。
// 契约：SPEC §6.10（SLOW_ACTION 分档 90s/15s——send_poke 不在慢表）、§16 血泪 7/14、
// §13 T-14/T-18（退避 3s→30s 指数、连接成功清零）、401 风暴防护（代际互斥——连接循环并发事故）。
// Production credentials are resolved per account/channel; candidate rotation remains a legacy-only contract.
import WebSocket from 'ws';

// SLOW_ACTION（§6.10）：/^(send_(group|private)|upload_|_send)/i → 90s；其余 15s。
// ⚠️ 不能简单匹配 send_：send_poke / friend_poke 是轻交互，给 90s 等于卡死一分半。
const SLOW_ACTION_RE = /^(send_(group|private)|upload_|_send)/i;
const SLOW_TIMEOUT_MS = 90_000;
const FAST_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;

// Fetch's top-level message is often only "fetch failed". Keep diagnostics
// bounded and useful without exposing credentials from a nested cause.
function describeCause(error, credentials = []) {
  const seen = new Set(), parts = [];
  const redact = value => {
    let text = String(value ?? '').slice(0, 2048);
    for (const secret of credentials.filter(value => typeof value === 'string' && value)) {
      for (const value of new Set([secret, encodeURIComponent(secret)])) text = text.split(value).join('[REDACTED]');
    }
    return text.replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/((?:access[_-]?token|token|api[_-]?key|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#)]+)/gi, '$1[REDACTED]');
  };
  for (let current = error; current && !seen.has(current) && seen.size < 4; current = current.cause) {
    seen.add(current);
    const code = current.code ? `[${redact(current.code).slice(0, 64)}] ` : '';
    const message = redact(current.message || current.name || current).trim();
    const part = `${code}${message}`.trim();
    if (part && part !== 'fetch failed' && !parts.includes(part)) parts.push(part);
  }
  return (parts.join(' ← ') || 'fetch failed').slice(0, 1024);
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken = '', httpToken = '', onEvent, onStatus, log = console, tokenCandidates = null, getConfig = null, candidateScope = '', expectedSelfId = '', bindingKey = '', connectionError = null, connectionCode = null, scopedCredentials = false, probeIntervalMs = 15_000, reconnectBaseMs = RECONNECT_BASE_MS, handshakeTimeoutMs = 10_000 } = {}) {
    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl;
    this.accessToken = accessToken;
    this.scopedCredentials = !!scopedCredentials;
    this.httpToken = this.scopedCredentials ? httpToken : httpToken || accessToken; // Legacy contract: empty HTTP uses accessToken.
    this.onEvent = onEvent ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.log = log;
    this.tokenCandidates = tokenCandidates ?? (() => [this.accessToken]); // 轮换候选（provider 注入）
    this.ws = null;
    this.selfId = null;
    this.selfNickname = '';
    this.connected = false;
    this.transportReady = false;
    this.error = null;
    this.errorCode = null;
    this.stage = 'stopped';
    this.expectedSelfId = String(expectedSelfId ?? '');
    this.bindingKey = String(bindingKey ?? '');
    this.connectionError = connectionError || null;
    this.connectionCode = connectionCode || null;
    if (this.connectionError) { this.error = this.connectionError; this.errorCode = this.connectionCode; this.stage = 'configuration_error'; }
    this._wsSelfId = null;
    this._identityError = null;
    this._probeIntervalMs = Math.max(20, Number(probeIntervalMs) || 15_000);
    this._reconnectBaseMs = Math.max(20, Number(reconnectBaseMs) || RECONNECT_BASE_MS);
    this._handshakeTimeoutMs = Math.max(20, Number(handshakeTimeoutMs) || 10_000);
    this._probeInFlight = null;
    this._probeBusy = null;
    this._probeController = null;
    this._probeLoop = null;
    this._gen = 0;            // 代际计数：旧连接的一切回调一律作废（401 风暴防护）
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._probeTimers = new Set();
    this._tokenIdx = 0;
    this._httpTokenIdx = 0;
    this._lastTokenRetry = 0;
    this._closed = false;
    this._started = false;
    this.getConfig = getConfig;
    this._candidateScope = candidateScope;
    this._configurationGeneration = 0;
    this._httpControllers = new Set();
    this._strictCurrentTokens = false;
    this._workingWsToken = undefined;
  }

  // Configuration updates belong to this client generation, never to external QQ processes.
  // After changing endpoints/credentials, old disk candidates must not be retried at a new host.
  configure({ wsUrl = '', httpUrl = '', accessToken = '', httpToken = '', candidateScope = '', expectedSelfId = '', bindingKey = '', connectionError = null, connectionCode = null, scopedCredentials = false } = {}, { reconnect = this._started } = {}) {
    const normalized = value => typeof value === 'string' ? value : '';
    wsUrl = normalized(wsUrl); httpUrl = normalized(httpUrl); accessToken = normalized(accessToken);
    scopedCredentials = !!scopedCredentials;
    httpToken = scopedCredentials ? normalized(httpToken) : normalized(httpToken) || accessToken;
    candidateScope = normalized(candidateScope);
    expectedSelfId = String(expectedSelfId ?? ''); bindingKey = normalized(bindingKey);
    connectionError = normalized(connectionError) || null; connectionCode = normalized(connectionCode) || null;
    const bindingChanged = expectedSelfId !== this.expectedSelfId || connectionError !== this.connectionError || connectionCode !== this.connectionCode || scopedCredentials !== this.scopedCredentials;
    const wsChanged = wsUrl !== this.wsUrl || accessToken !== this.accessToken || candidateScope !== this._candidateScope || bindingChanged;
    const changed = wsChanged || httpUrl !== this.httpUrl || httpToken !== this.httpToken || bindingKey !== this.bindingKey;
    if (!changed) return false;
    this.wsUrl = wsUrl; this.httpUrl = httpUrl; this.accessToken = accessToken; this.httpToken = httpToken;
    this._candidateScope = candidateScope;
    this.expectedSelfId = expectedSelfId; this.bindingKey = bindingKey;
    this.connectionError = connectionError; this.connectionCode = connectionCode;
    this.scopedCredentials = scopedCredentials;
    ++this._configurationGeneration;
    this._tokenIdx = 0; this._httpTokenIdx = 0; this._lastTokenRetry = 0;
    this._strictCurrentTokens = true;
    this._workingWsToken = undefined;
    this._clearProbes();
    this._probeInFlight = null;
    this.selfId = null; this.selfNickname = ''; this._identityError = null;
    for (const controller of this._httpControllers) controller.abort(new Error('OneBot 接入配置已更改'));
    this._publish({ error: connectionError, errorCode: connectionCode, stage: connectionError ? 'configuration_error' : 'verifying' });
    if (wsChanged) {
      this._wsSelfId = null;
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      ++this._gen;
      this._teardown(this._gen);
      this._publish({ connected: false });
      if (reconnect && !this._closed) this.reconnect();
    } else if (this.connected && !this._closed) this._selfInfoProbe(this._gen);
    return true;
  }

  _syncConfiguration({ reconnect = this._started } = {}) {
    if (typeof this.getConfig === 'function') this.configure(this.getConfig(), { reconnect });
  }

  _wsTokens() {
    return this.scopedCredentials || this._strictCurrentTokens ? [this.accessToken] : this.tokenCandidates();
  }

  _publish(update = {}) {
    Object.assign(this, update);
    const identityVerified = this.expectedSelfId ? this._wsSelfId === this.selfId : !this._wsSelfId || this._wsSelfId === this.selfId;
    this.transportReady = !!(this.connected && this.selfId && identityVerified && !this.error && !this.connectionError && !this._identityError);
    if (this.transportReady) this.stage = 'ready';
    this.onStatus({ connected: this.connected, transportReady: this.transportReady, selfId: this.selfId, selfNickname: this.selfNickname,
      stage: this.stage, error: this.error, errorCode: this.errorCode, diagnosis: this.error, identityBound: !!this.expectedSelfId });
  }

  _clearProbes() {
    for (const timer of this._probeTimers) clearTimeout(timer);
    this._probeTimers.clear();
    this._probeLoop = null;
    this._probeController?.abort(new Error('OneBot 健康检测已更新'));
  }

  _configurationFailure() {
    return Object.assign(new Error(this.connectionError || 'OneBot 接入配置无效'), { code: this.connectionCode || 'ONEBOT_CONFIGURATION' });
  }

  _failIdentity(message) {
    const error = Object.assign(new Error(message), { code: 'ONEBOT_ACCOUNT_MISMATCH' });
    this._identityError = error;
    ++this._configurationGeneration;
    for (const controller of this._httpControllers) controller.abort(error);
    this.selfId = null; this.selfNickname = '';
    this._publish({ error: message, errorCode: error.code, stage: 'account_mismatch' });
    // Invalidate callbacks before closing a socket belonging to a different account.
    ++this._gen;
    this._teardown(this._gen);
    this._scheduleReconnect(this._gen, error);
    return error;
  }

  _acceptLogin(response) {
    if ((response?.status != null && response.status !== 'ok') || (response?.retcode != null && Number(response.retcode) !== 0)) {
      throw Object.assign(new Error('OneBot 登录状态查询失败'), { code: 'ONEBOT_HTTP_PROTOCOL' });
    }
    const id = response?.data?.user_id == null ? '' : String(response.data.user_id);
    if (!/^[1-9]\d*$/.test(id)) {
      this.selfId = null; this.selfNickname = '';
      const error = Object.assign(new Error('OneBot 已响应，但 QQ 账号尚未登录'), { code: 'ONEBOT_NOT_LOGGED_IN' });
      this._publish({ error: error.message, errorCode: error.code, stage: 'awaiting_login' });
      throw error;
    }
    if ((this.expectedSelfId && id !== this.expectedSelfId) || (this._wsSelfId && id !== this._wsSelfId)) {
      throw this._failIdentity('OneBot HTTP、WS 与所选 QQ 账号不一致，请检查账号绑定和端口');
    }
    this.selfId = id;
    this.selfNickname = typeof response.data.nickname === 'string' ? response.data.nickname : '';
    this._identityError = null;
    this._publish({ error: null, errorCode: null, stage: this.connected ? 'verifying' : 'disconnected' });
  }

  _acceptWsIdentity(id) {
    if (!/^[1-9]\d*$/.test(id)) return false;
    if ((this.expectedSelfId && id !== this.expectedSelfId) || (this.selfId && id !== this.selfId)) {
      this._failIdentity('OneBot WS 连接到了其他 QQ 账号，请检查账号绑定和端口');
      return false;
    }
    this._wsSelfId = id;
    this._publish();
    return true;
  }

  _endpoint(value, protocols, token) {
    let url;
    try { url = new URL(value); } catch { throw new Error('OneBot 接入地址为空或无效'); }
    if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.searchParams.has('access_token')) {
      throw new Error('OneBot 接入地址无效（请使用独立的令牌配置）');
    }
    if (token) url.searchParams.set('access_token', token);
    return url;
  }

  // ---- 连接管理 ----
  _createSocket(url) { return new WebSocket(url, { handshakeTimeout: this._handshakeTimeoutMs }); }

  async connect() {
    this._closed = false;
    this._started = true;
    this._connectNow();
  }

  _connectNow() {
    if (this._closed) return;
    this._syncConfiguration({ reconnect: false });
    this._clearProbes();
    this._probeInFlight = null;
    if (this.connectionError) {
      this._publish({ connected: false, error: this.connectionError, errorCode: this.connectionCode, stage: 'configuration_error' });
      return;
    }
    const gen = ++this._gen;
    this._lastWsFailure = null;
    this._wsSelfId = null;
    this._publish({ connected: false, stage: 'connecting' });
    const tokens = this._wsTokens();
    if (this._workingWsToken !== undefined) {
      const working = tokens.indexOf(this._workingWsToken);
      if (working >= 0) this._tokenIdx = working;
      else this._workingWsToken = undefined;
    }
    const token = tokens[this._tokenIdx % Math.max(1, tokens.length)] ?? '';
    let ws;
    try {
      const url = this._endpoint(this.wsUrl, ['ws:', 'wss:'], token);
      this.log.info?.(`[onebot] 连接 WS ${describeCause({ message: this.wsUrl }, [this.accessToken, this.httpToken, token])}${token ? '（令牌 #' + (this._tokenIdx % tokens.length + 1) + '）' : ''}`);
      ws = this._createSocket(url);
    } catch (err) {
      this._publish({ connected: false, error: describeCause(err, [token]), errorCode: 'ONEBOT_WS_ADDRESS', stage: 'configuration_error' });
      return;
    }
    this.ws = ws;

    ws.on('upgrade', response => {
      if (gen !== this._gen) return;
      const identity = response.headers?.['x-self-id'];
      if (identity != null) this._acceptWsIdentity(String(identity));
    });

    ws.on('open', () => {
      if (gen !== this._gen) return; // 旧代际回调作废
      this.connected = true;
      this._reconnectAttempts = 0; // 连接成功清零（§13 T-18）
      this._workingWsToken = token; // Pin the successful value only within this configuration scope.
      this._publish({ connected: true, error: null, errorCode: null, stage: 'verifying' });
      this.log.info?.('[onebot] WS 已连接');
      this._selfInfoProbe(gen);
    });

    ws.on('message', (raw) => {
      if (gen !== this._gen) return;
      let ev = null;
      try { ev = JSON.parse(String(raw)); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.self_id != null && !this._acceptWsIdentity(String(ev.self_id))) return;
      // Identity publication is synchronous: its observer may stop or replace
      // the provider before this message resumes dispatching.
      if (gen !== this._gen || this.ws !== ws || this._closed) return;
      // Automatic account binding cannot safely dispatch an unattributed event.
      if (this.expectedSelfId && ev.self_id == null) return;
      // OneBot v11 反向 WS：echo 响应走 _pending；事件走 onEvent
      if (ev.echo !== undefined && this._pending?.has(String(ev.echo))) {
        const { resolve } = this._pending.get(String(ev.echo));
        this._pending.delete(String(ev.echo));
        resolve(ev);
        return;
      }
      try {
        this.onEvent(ev); // onEvent 异常被 catch 成日志行，不打崩 WS（§6.1）
      } catch (err) {
        this.log.error?.(`[onebot] 事件处理异常：${err?.stack || err}`);
      }
    });

    ws.on('error', (err) => {
      if (gen !== this._gen) return;
      // 401：令牌不匹配 → 轮换候选重连（限频 5s，先重读磁盘——多账号 token 天然支持切换）
      if (this._looksLike401(err)) {
        this._workingWsToken = undefined;
        const now = Date.now();
        if (now - this._lastTokenRetry < 5000) {
          this._scheduleReconnect(gen, Object.assign(new Error('OneBot WS 401：令牌不匹配'), { code: 'ONEBOT_WS_UNAUTHORIZED' }), 5000 - (now - this._lastTokenRetry));
          return;
        }
        this._lastTokenRetry = now;
        const tokens = this._wsTokens(); // 未热切换时重读磁盘（多账号候选）
        if (tokens.length > 1 || this._tokenIdx === 0) {
          this._tokenIdx += 1;
          this.log.warn?.(`[onebot] 401 令牌不匹配，轮换候选（${this._tokenIdx % Math.max(1, tokens.length) + 1}/${Math.max(1, tokens.length)}）`);
        }
        this._teardown(gen);
        this._scheduleReconnect(gen, Object.assign(new Error('OneBot WS 401：令牌不匹配'), { code: 'ONEBOT_WS_UNAUTHORIZED' }), 5000);
        return;
      }
      const message = describeCause(err, [token, this.accessToken, this.httpToken]);
      this._lastWsFailure = Object.assign(new Error(`OneBot WS 连接失败：${message}`), { code: 'ONEBOT_WS_UNAVAILABLE' });
      this._publish({ error: this._lastWsFailure.message, errorCode: this._lastWsFailure.code, stage: 'disconnected' });
      this.log.warn?.(`[onebot] WS 错误：${message}`);
    });

    ws.on('close', (code, reason) => {
      if (gen !== this._gen || this.ws !== ws) return;
      this.connected = false;
      this.selfId = null; this.selfNickname = '';
      this._clearProbes();
      this._publish({ connected: false, stage: 'disconnected' });
      this.log.warn?.(`[onebot] WS 断开（code=${code}）`);
      const reasonText = String(reason ?? '');
      if (Number(code) === 1008 && /unauthor|invalid\s+access\s+token|token/i.test(reasonText)) {
        this._workingWsToken = undefined;
        const now = Date.now();
        if (now - this._lastTokenRetry >= 5000) {
          this._lastTokenRetry = now;
          const tokens = this._wsTokens();
          if (tokens.length > 1 || this._tokenIdx === 0) this._tokenIdx += 1;
          this._teardown(gen);
          this._scheduleReconnect(gen, Object.assign(new Error('OneBot WS 401：令牌不匹配'), { code: 'ONEBOT_WS_UNAUTHORIZED' }), 5000);
          return;
        }
      }
      this._scheduleReconnect(gen, this._lastWsFailure || new Error(`OneBot WS 连接已断开（code=${code}）`));
    });
  }

  _looksLike401(err) {
    const msg = String(err?.message ?? '');
    return /401|unauthorized|token/i.test(msg);
  }

  _teardown(gen) {
    if (gen !== this._gen) return;
    this._clearProbes();
    const socket = this.ws;
    this.ws = null;
    try { socket?.close(); } catch { /* 已死 */ }
    try { socket?.terminate(); } catch { /* 已死 */ }
    this.connected = false;
    this.transportReady = false;
    this.selfId = null; this.selfNickname = ''; this._wsSelfId = null;
  }

  _scheduleReconnect(gen, err, forceDelay = null) {
    if (gen !== this._gen || this._closed) return;
    this._publish({ connected: false, error: describeCause(err, [this.accessToken, this.httpToken]), errorCode: err?.code || 'ONEBOT_WS_DISCONNECTED', stage: err?.code === 'ONEBOT_ACCOUNT_MISMATCH' ? 'account_mismatch' : 'disconnected' });
    if (this._reconnectTimer) return; // 已排程（重入保护）
    // 退避 min(30s, 3s * 2^(n-1))（§13 T-18）
    const delay = forceDelay ?? Math.min(RECONNECT_MAX_MS, this._reconnectBaseMs * Math.pow(2, this._reconnectAttempts));
    this._reconnectAttempts += 1;
    this.log.info?.(`[onebot] ${delay}ms 后重连（第 ${this._reconnectAttempts} 次）`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (gen === this._gen && !this._closed) this._connectNow(); // 代际互斥：旧代际不得拉起新连接
    }, delay);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  reconnect() {
    if (this._closed || !this._started) return;
    // 主动重连（端口就绪轮询触发）：清零退避 + 换代际
    this._reconnectAttempts = 0;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    ++this._gen; // close/error callbacks from the previous socket are already obsolete.
    this._teardown(this._gen);
    this._connectNow();
  }

  async close() {
    this._closed = true;
    this._started = false;
    this._workingWsToken = undefined;
    ++this._configurationGeneration;
    for (const controller of this._httpControllers) controller.abort(new Error('OneBot 客户端已关闭'));
    this._gen++; // 全部回调作废
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._teardown(this._gen);
    this.connected = false;
    this.selfId = null; this.selfNickname = ''; this._wsSelfId = null;
    this._publish({ error: null, errorCode: null, stage: 'stopped' });
  }

  // Serial health probes continue after temporary HTTP/API/authentication failures.
  _selfInfoProbe(gen) {
    this._clearProbes();
    const configuration = this._configurationGeneration;
    const loop = { gen, configuration };
    this._probeLoop = loop;
    const current = () => this._probeLoop === loop && gen === this._gen && configuration === this._configurationGeneration && this.connected && !this._closed;
    const attempt = async () => {
      if (!current()) return;
      // configure() may replace this loop synchronously inside call(). Reserve
      // the slot before calling it, so its replacement waits for cancellation
      // to settle rather than starting a second request in the same account.
      if (this._probeBusy) {
        await this._probeBusy.done;
        if (current()) schedule(0);
        return;
      }
      let finish;
      const busy = { done: new Promise(resolve => { finish = resolve; }) };
      const controller = new AbortController();
      this._probeBusy = busy;
      this._probeController = controller;
      let pending;
      try {
        pending = this.call('get_login_info', {}, { probeGeneration: gen, signal: controller.signal });
        this._probeInFlight = pending;
        await pending;
      } catch { /* call publishes the current cause; only read-only probes retry. */ }
      finally {
        if (this._probeInFlight === pending) this._probeInFlight = null;
        if (this._probeController === controller) this._probeController = null;
        if (this._probeBusy === busy) this._probeBusy = null;
        finish();
        if (current()) schedule(this._probeIntervalMs);
      }
    };
    const schedule = delay => {
      if (!current()) return;
      const timer = setTimeout(() => {
        this._probeTimers.delete(timer);
        void attempt();
      }, delay);
      this._probeTimers.add(timer);
      timer.unref?.();
    };
    schedule(0);
  }

  // ---- HTTP action 调用 ----
  async call(action, params = {}, { signal, probeGeneration = null } = {}) {
    if (this._closed) throw new Error('OneBot 客户端已关闭');
    const cancelled = () => Object.assign(new Error(`OneBot ${action} 已取消`), { name: 'AbortError', __aborted: true });
    if (signal?.aborted) throw cancelled();
    this._syncConfiguration();
    if (this.connectionError) throw this._configurationFailure();
    const generation = this._configurationGeneration;
    const current = () => generation === this._configurationGeneration && !this._closed && (probeGeneration === null || (probeGeneration === this._gen && this.connected));
    const stale = () => new Error('OneBot 接入配置已更改或客户端已关闭');
    // Only these read-only probes may run while account identity is not established.
    if (this.expectedSelfId && action !== 'get_login_info' && action !== 'get_status') {
      if (this._identityError) throw this._identityError;
      await this.call('get_login_info', {}, { signal });
      if (!current()) throw stale();
      if (this.selfId !== this.expectedSelfId) throw this._failIdentity('OneBot 尚未验证所选 QQ 账号');
    }
    const httpUrl = this.httpUrl;
    try { this._endpoint(httpUrl, ['http:', 'https:'], ''); } // Empty/invalid settings fail before any request.
    catch (error) {
      error.code = 'ONEBOT_HTTP_ADDRESS'; this._httpFailure(error); throw error;
    }
    const timeout = SLOW_ACTION_RE.test(action) ? SLOW_TIMEOUT_MS : FAST_TIMEOUT_MS;
    const exactTokens = this.scopedCredentials || this._strictCurrentTokens;
    const candidates = exactTokens ? [] : this.tokenCandidates?.() ?? [];
    const tokens = [...new Set((exactTokens ? [this.httpToken] : [this.httpToken, this.accessToken, ...candidates]).filter((token) => typeof token === 'string'))];
    const ordered = tokens.length ? tokens.slice(this._httpTokenIdx % tokens.length).concat(tokens.slice(0, this._httpTokenIdx % tokens.length)) : [''];
    let lastUnauthorized = null;
    for (const token of ordered) {
      if (!current()) throw stale();
      const url = this._endpoint(httpUrl, ['http:', 'https:'], token);
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(action)}`;
      const controller = new AbortController();
      this._httpControllers.add(controller);
      const onAbort = () => controller.abort(signal.reason ?? new Error('操作已取消'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeout);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
          redirect: 'manual', // Never forward action credentials through an HTTP redirect.
        });
        if (signal?.aborted) throw cancelled();
        if (!current()) throw stale();
        if (res.status === 401) {
          lastUnauthorized = Object.assign(new Error('OneBot HTTP 401：令牌不匹配'), { status: 401, code: 'ONEBOT_HTTP_UNAUTHORIZED' });
          this._httpTokenIdx = (this._httpTokenIdx + 1) % Math.max(1, tokens.length);
          continue;
        }
        if (res.status === 426) {
          throw Object.assign(new Error(`OneBot HTTP ${res.status}：httpUrl 可能指向了 WebSocket 端口（请检查接入地址，HTTP API 与 WS 是两个端口）`), { code: 'ONEBOT_HTTP_ENDPOINT' });
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`OneBot HTTP ${res.status}：${text.slice(0, 200)}`), { status: res.status });
        }
        const data = await res.json();
        if (signal?.aborted) throw cancelled();
        if (!current()) throw stale();
        if (data && typeof data === 'object' && data.status === 'failed') {
          if (data.retcode === 1401) {
            lastUnauthorized = Object.assign(new Error('OneBot HTTP 401：令牌不匹配'), { status: 401, code: 'ONEBOT_HTTP_UNAUTHORIZED' });
            this._httpTokenIdx = (this._httpTokenIdx + 1) % Math.max(1, tokens.length);
            continue;
          }
          throw new Error(`OneBot 动作失败：${data.message ?? data.wording ?? '未知原因'}（retcode=${data.retcode}）`);
        }
        this._httpTokenIdx = tokens.indexOf(token) >= 0 ? tokens.indexOf(token) : 0;
        if (action === 'get_login_info') this._acceptLogin(data);
        if (!current()) throw stale(); // A status observer may synchronously replace this binding.
        return data;
      } catch (err) {
        if (generation !== this._configurationGeneration || this._closed) throw stale();
        if (probeGeneration !== null && probeGeneration !== this._gen && err?.code !== 'ONEBOT_ACCOUNT_MISMATCH') throw stale();
        if (signal?.aborted) throw cancelled();
        if (err?.name === 'AbortError' || /请求超时/.test(err?.message ?? '')) {
          const timeoutError = Object.assign(new Error(`OneBot ${action} 超时（${timeout / 1000}s）`), { code: 'ONEBOT_HTTP_TIMEOUT' });
          if (action === 'get_login_info') this._httpFailure(timeoutError);
          throw timeoutError;
        }
        if (err?.status !== 401) {
          const failure = Object.assign(new Error(`OneBot ${action} 请求失败：${describeCause(err, [...tokens, this.accessToken, this.httpToken])}`, { cause: err }), { code: err?.code || 'ONEBOT_HTTP_UNAVAILABLE', status: err?.status });
          if (action === 'get_login_info' && err?.code !== 'ONEBOT_ACCOUNT_MISMATCH' && err?.code !== 'ONEBOT_NOT_LOGGED_IN') this._httpFailure(failure);
          throw failure;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this._httpControllers.delete(controller);
      }
    }
    const failure = lastUnauthorized ?? new Error(`OneBot ${action} 失败：没有可用令牌`);
    this._httpFailure(failure);
    throw failure;
  }

  _httpFailure(error) {
    this.selfId = null; this.selfNickname = '';
    this._publish({ error: error.message, errorCode: error.code || 'ONEBOT_HTTP_UNAVAILABLE', stage: error.status === 401 ? 'http_unauthorized' : 'http_unavailable' });
  }
}
