// LLM 调用链：chatCompletion（流式或完整响应）+ chatCompletionWithRetry（候选降级+退避）+
// isRetryableError / addUsage / thinking 方言适配。
// 契约：notes/06c-llm.md 全文（§3 请求契约 / §3.4 重试 / §3.6 方言表 / §5 用量）。
// 会话提供 onDelta 时读取真实流；其它调用保留完整响应。abort 不可重试。

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveThinkingPolicy } from './thinking-policy.js';
import {readChatStream} from './llm-stream.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const OPENCODE_SESSION = `qqagent-${crypto.randomUUID()}`;
const MIN_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF = [1000, 2000]; // 1000 * 2^attempt，无抖动无上限封顶（仅 2 次）

function untilAborted(run, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('已中止'));
  const work = Promise.resolve().then(() => {
    if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    return run();
  });
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('已中止')); };
    signal.addEventListener('abort', abort, {once: true});
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

// ---------- isRetryableError（06c §3.4）----------
const NOT_RETRY_HTTP = new Set([401, 400, 403, 404, 405, 409, 413, 422, 421]);
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false; // abort 不重试——中止按钮要真的停得住
  if (error?.status && NOT_RETRY_HTTP.has(Number(error.status))) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;
  if (error?.status && Number(error.status) >= 500) return true;
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;
  if (/模型请求失败/.test(msg)) return true;
  if (/JSON|解析/.test(msg) && /无法解析|解析失败|失败/.test(msg)) return true;
  return false; // 兜底未知错误不重试
}

// ---------- 用量累加（06c §5.1：读 snake_case 写 camelCase；calls 不归这里管——SUSPECT 复刻）----------
export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}
export function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens) || (prompt + completion);
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += total;
  target.cachedTokens += Number(cached) || 0;
  return target;
}
export function cacheHitRate(usage) {
  if (!usage || !usage.promptTokens) return 0;
  return Math.min(1, Math.max(0, usage.cachedTokens / usage.promptTokens));
}

// ---------- 密钥解析（06c §2：配置驱动，不读 env）----------
export function resolveApiKey(cfg) {
  const pid = cfg?.api?.provider;
  if (pid) {
    const k1 = cfg?.dshProviderKeys?.[pid];
    if (k1 && k1 !== '******') return k1;
    const p = (cfg?.providers ?? []).find((x) => x && x.id === pid);
    if (p?.apiKey && p.apiKey !== '******') return p.apiKey;
    const fromEnv = p?.apiKeyFrom ? process.env[String(p.apiKeyFrom)] : '';
    if (fromEnv && fromEnv !== '******') return fromEnv;
  }
  const k = cfg?.api?.apiKey;
  return k && k !== '******' ? k : '';
}
// Explicit channel calls do not borrow the direct-mode credential. The legacy
// standalone helper above remains import-compatible for older integrations.
export function resolveRequestApiKey(cfg) {
  return resolveApiKey({...cfg, api:{...cfg?.api, apiKey:cfg?.api?.provider ? '' : cfg?.api?.apiKey}});
}
function endpointOrigin(value) {
  try { const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:''; }
  catch { return ''; }
}
function endpointIdentity(value) {
  try { if(!endpointOrigin(value))return '';const url=new URL(value);url.pathname=url.pathname.replace(/\/+$/,'')||'/';url.hash='';return url.href; }
  catch { return ''; }
}

// Legacy helpers remain importable; production calls resolve llm.dialect instead.
export { detectDialect, buildThinkingParams, looksLikeThinkingRejection } from '../../bundled/llm-dialects/dialects.js';

export function extractReasoning(message) {
  if (!message || typeof message !== 'object') return null;
  for (const k of ['reasoning_content', 'reasoning', 'thinking', 'thoughts']) {
    if (typeof message[k] === 'string' && message[k]) return message[k];
  }
  if (Array.isArray(message.reasoning_details)) {
    const s = message.reasoning_details.map((x) => x?.text ?? '').filter(Boolean).join('\n');
    if (s) return s;
  }
  if (Array.isArray(message.content)) {
    const s = message.content.filter((p) => p?.type === 'thinking' || p?.type === 'reasoning')
      .map((p) => p?.text ?? p?.thinking ?? '').filter(Boolean).join('\n');
    if (s) return s;
  }
  return null;
}

export function extractReasoningTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return Number(usage.completion_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens ?? 0) || 0;
}

// 专用模型自动切换（06c §3.2）：视频优先——video_url+videoModel → videoModel；否则 image/video+visionModel
export function specializedModelFor(messages, api) {
  if (!Array.isArray(messages)) return null;
  let hasImage = false, hasVideo = false;
  for (const m of messages) {
    const parts = Array.isArray(m?.content) ? m.content : [];
    for (const p of parts) {
      if (p?.type === 'video_url') hasVideo = true;
      if (p?.type === 'image_url') hasImage = true;
    }
  }
  if (hasVideo && api?.videoModel) return api.videoModel;
  if ((hasImage || hasVideo) && api?.visionModel) return api.visionModel;
  return null;
}

// Explicit media bindings are resolved as a complete identity, not a model ID
// guessed across catalogues. Legacy ID-only settings keep the primary endpoint.
// The default completion path consumes the replaceable llm.target component.
export function selectPrimaryModelTarget({messages, cfg}) {
  const trim = value => typeof value === 'string' ? value.trim() : value;
  const media = {...cfg?.api, visionModel: trim(cfg?.api?.visionModel), videoModel: trim(cfg?.api?.videoModel)};
  const model = specializedModelFor(messages, media);
  if (!model) return null;
  if (typeof model !== 'string') throw new Error('专用模型 ID 必须是字符串');
  const video = messages.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'video_url'));
  const key = video && media.videoModel ? 'videoProvider' : 'visionProvider';
  const id = String(cfg?.api?.[key] ?? '').trim();
  if (!id) return {model};
  const candidates = (cfg.providers ?? []).filter(p => p.id === id);
  if (candidates.length !== 1) throw new Error('专用模型指定的渠道不存在或身份重复，请重新选择');
  const provider = candidates[0];
  const baseUrl = String(provider?.baseURL ?? provider?.baseUrl ?? '').trim();
  if (!provider || !baseUrl) throw new Error('专用模型指定的渠道不存在或缺少端点，请重新选择');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('专用模型渠道地址无效');
  if (provider.baseUrl && provider.baseURL) {
    if (endpointIdentity(provider.baseUrl) !== endpointIdentity(provider.baseURL)) throw new Error('渠道地址别名存在冲突，请重新编辑渠道');
  }
  return {model, provider: id, baseUrl,
    apiKey: resolveApiKey({...cfg, api: {...cfg.api, provider: id, apiKey: ''}}), pinned: true};
}

// ---------- chatCompletion（06c §3 单次请求契约）----------
export async function chatCompletion(args) {
  const { messages, tools = null, toolChoice = 'auto', temperature = null, signal = null,
    overrides = null, skillContext = null, maxTokens = 0, cfg, fetchFn = fetch,
    capabilities = null, log = console } = args;
  const providers = (name) => capabilities?.providers?.(name) ?? [];
  async function invoke(name, item, payload) {
    try {
      return typeof item.provider === 'function' ? await item.provider(payload) : null;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      log.warn?.(`[llm] ${name} (${item.ownerId}) 异常，跳过：${err?.message ?? err}`);
      return null;
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  const startedAt = Date.now();
  let poolAccountId = '';
  let api = { ...(overrides ?? {
    baseUrl: cfg?.api?.baseUrl ?? '', apiKey: resolveRequestApiKey(cfg), model: cfg?.api?.model ?? '',
    timeoutMs: cfg?.api?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }) };
  const primary = !overrides || args.useEndpointPool === true;
  const owners = cfg?.api?.provider ? (cfg.providers ?? []).filter(p => p.id === cfg.api.provider) : [];
  const sourceAddress = cfg?.api?.provider ? owners[0]?.baseURL ?? owners[0]?.baseUrl ?? cfg?.api?.baseUrl : api.baseUrl;
  let credentialOrigin = endpointOrigin(sourceAddress), poolPicked = false;
  const aliasConflict = owners[0]?.baseUrl && owners[0]?.baseURL && endpointIdentity(owners[0].baseUrl) !== endpointIdentity(owners[0].baseURL);
  const sourceValid = !!credentialOrigin && owners.length <= 1 && !aliasConflict;
  let selected = null;
  if (primary) {
    try {
      selected = await untilAborted(() => (args.components?.['llm.target'] ?? selectPrimaryModelTarget)({messages, cfg, api, signal}), signal);
      if (selected != null && (typeof selected !== 'object' || Array.isArray(selected))) throw new Error('模型目标解析器需要返回对象或 null');
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw Object.assign(new Error(error?.message || '模型目标解析失败'), {code: 'MODEL_TARGET_INVALID', status: 400, cause: error});
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  if (primary && !selected?.pinned) {
    const picker = providers('llm.endpoint-pick')[0];
    if (picker) {
      const picked = await invoke('llm.endpoint-pick', picker, { model: api.model });
      if (picked?.baseUrl) {
        poolPicked = true;
        poolAccountId = picked.id || '';
        const ownKey = Object.hasOwn(picked, 'apiKey');
        const nextKey = ownKey ? picked.apiKey || '' : endpointOrigin(picked.baseUrl) === credentialOrigin ? api.apiKey : '';
        api = { ...api, baseUrl: picked.baseUrl, apiKey: nextKey, model: picked.model || api.model };
        if (ownKey || !nextKey) credentialOrigin = endpointOrigin(picked.baseUrl);
      }
    }
  }
  if (selected) { const {pinned: _pinned, ...target} = selected; api = {...api, ...target}; if (Object.hasOwn(target,'apiKey')) credentialOrigin = endpointOrigin(api.baseUrl); }
  if (primary && ((!selected?.pinned && !poolPicked && !sourceValid) || api.apiKey && (!endpointOrigin(api.baseUrl) || endpointOrigin(api.baseUrl) !== credentialOrigin))) {
    throw Object.assign(new Error('模型端点与凭据来源不一致，请重新选择完整的渠道配置'), {code:selected?.pinned?'MODEL_TARGET_INVALID':'PRIMARY_CONFIG_INVALID',status:400});
  }
  const ctx = skillContext || { api, model: api.model, messages };
  async function feedback(payload) {
    if (!poolAccountId) return;
    const item = providers('llm.endpoint-feedback')[0];
    if (item) await invoke('llm.endpoint-feedback', item, { accountId: poolAccountId, ...payload });
  }

  let body = {
    model: api.model,
    messages,
    stream: typeof args.onDelta==='function',
  };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = toolChoice; }
  if(body.stream)body.stream_options={include_usage:true};
  if (maxTokens > 0) body.max_tokens = Math.floor(maxTokens);
  const temp = temperature === null ? Number(cfg?.api?.temperature ?? 0.8) : Number(temperature);
  if (Number.isFinite(temp)) body.temperature = temp;

  // 思考参数（方言适配）
  let removedTemperature = null;
  const thinking = await untilAborted(() => (args.components?.['llm.thinking'] ?? resolveThinkingPolicy)({
    api: { ...cfg?.api, ...api }, context: ctx, signal,
  }), signal);
  if (!thinking || !['default', 'on', 'off'].includes(thinking.mode)
    || thinking.on !== (thinking.mode === 'on') || typeof thinking.effort !== 'string') {
    throw new Error('思考策略需要返回有效的 mode/on/effort');
  }
  const dialectProvider = providers('llm.dialect')[0]?.provider;
  let tp = { params: {}, omitTemperature: false };
  if (typeof dialectProvider?.detect === 'function' && typeof dialectProvider?.build === 'function') {
    try {
      const dialect = await dialectProvider.detect(api.baseUrl, api.model);
      const built = await dialectProvider.build({
        mode: thinking.mode, effort: thinking.effort, on: thinking.on,
        budget: thinking.budget ?? 0, dialect,
      });
      if (built && typeof built === 'object' && !Array.isArray(built)) {
        tp = { params: built.params && typeof built.params === 'object' && !Array.isArray(built.params) ? built.params : {}, omitTemperature: Boolean(built.omitTemperature) };
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      log.warn?.(`[llm] llm.dialect 异常，使用标准请求：${err?.message ?? err}`);
    }
  }
  Object.assign(body, tp.params);
  if (tp.omitTemperature && 'temperature' in body) {
    removedTemperature = body.temperature;
    delete body.temperature; // 思考与 temperature 互斥（06c §3.6）
  }

  for (const item of providers('llm.request-params')) {
    const next = await invoke('llm.request-params', item, {
      body, api, model: api.model, messages, tools, temperature: temp, context: ctx,
    });
    if (!next || typeof next !== 'object' || Array.isArray(next)) continue;
    body = next.body || next;
    if (next.omitTemperature && 'temperature' in body) {
      removedTemperature = body.temperature;
      delete body.temperature;
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('已中止');
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Number(api.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) { controller.abort(signal.reason); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`模型请求超时（${timeoutMs}ms）`)), timeoutMs);

  const headers = { 'content-type': 'application/json' };
  if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`; // Authorization Bearer（非 api-key 头）
  if (/opencode\.ai/i.test(api.baseUrl) || String(api.model).startsWith('opencode-go/')) {
    headers['x-opencode-session'] = OPENCODE_SESSION;
    headers['user-agent'] = 'qq-agent/0.5';
  }

  const url = `${String(api.baseUrl).replace(/\/$/, '')}/chat/completions`;
  const doFetch = fetchFn;
  let degraded = false;
  let degradeNote = null;
  let receivedResult = null;
  let streamFallback=false,streamOptionsFallback=false;
  const progress=value=>{if(controller.signal.aborted)return;try{args.onDelta?.(value);}catch{/* Display observers cannot replay or fail a paid model request. */}};

  async function attemptOnce(reqBody) {
    if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    let res, requestJson;
    try {
      args.onRequest?.({ api: { ...api }, model: reqBody.model });
      if(reqBody.stream)progress({reset:true,content:'',reasoning:''});
      requestJson = JSON.stringify(reqBody);
      res = await doFetch(url, { method: 'POST', headers, body: requestJson, signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err; // 外部中止原样上抛
      if (controller.signal.aborted && /模型请求超时/.test(String(controller.signal.reason?.message ?? ''))) {
        throw controller.signal.reason;
      }
      if (/abort/i.test(String(err?.name ?? err?.message ?? '')) && controller.signal.aborted) {
        throw controller.signal.reason ?? err;
      }
      throw new Error(`模型请求失败：${err?.message ?? err}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Explicit protocol rejection is safe to retry before any response delta.
      if(reqBody.stream&&[400,415,422,501].includes(res.status)&&/stream|流式/i.test(text)){
        if(!streamOptionsFallback&&reqBody.stream_options&&/stream_options|include_usage/i.test(text)){
          streamOptionsFallback=true;const next={...reqBody};delete next.stream_options;return attemptOnce(next);
        }
        if(!streamFallback){streamFallback=true;const next={...reqBody,stream:false};delete next.stream_options;return attemptOnce(next);}
      }
      // 400/422 参数被拒的一次性降级重试（06c §3.7）
      if ((res.status === 400 || res.status === 422) && !degraded) {
        let rejected = false;
        if (typeof dialectProvider?.looksLikeRejection === 'function') {
          try { rejected = await untilAborted(() => dialectProvider.looksLikeRejection(text), controller.signal); }
          catch (err) {
            if (controller.signal.aborted) throw controller.signal.reason ?? err;
            log.warn?.(`[llm] llm.dialect 拒绝判定异常：${err?.message ?? err}`);
          }
        }
        if (rejected) {
          const stripped = typeof dialectProvider.strip === 'function'
            ? await untilAborted(() => dialectProvider.strip(reqBody), controller.signal)
            : { ...reqBody };
          if (typeof dialectProvider.strip !== 'function') {
            for (const key of Object.keys(tp.params)) delete stripped[key];
          }
          // Compare wire values only on a rejected request. The saved JSON also
          // observes a selected provider which mutates reqBody in place.
          let changed = false;
          if (stripped && typeof stripped === 'object' && !Array.isArray(stripped)) {
            try { changed = !isDeepStrictEqual(JSON.parse(requestJson), JSON.parse(JSON.stringify(stripped))); }
            catch { /* Invalid strip output cannot justify another request. */ }
          }
          if (changed) {
            degraded = true;
            degradeNote = '思考参数被网关拒绝，已摘除后重试';
            if (removedTemperature !== null) stripped.temperature = removedTemperature;
            return attemptOnce(stripped);
          }
        }
      }
      if (!degraded && [400, 422, 415].includes(res.status)) {
        for (const item of providers('llm.retry-advisor')) {
          const advice = await invoke('llm.retry-advisor', item, { body: reqBody, errorText: text, status: res.status, ...ctx });
          if (!advice?.body || typeof advice.body !== 'object' || Array.isArray(advice.body)) continue;
          degraded = true;
          degradeNote = String(advice.reason || `已按 ${item.ownerId} 建议降级重试`);
          return attemptOnce(advice.body);
        }
      }
      const err = new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    if(/text\/event-stream/i.test(res.headers.get('content-type')||''))return readChatStream(res,{signal:controller.signal,onDelta:progress,reasoningOf:extractReasoning});
    let data;
    const rawText = await res.text();
    try { data = JSON.parse(rawText); }
    catch (e) {
      throw new Error(`模型 API 返回了无法解析的 JSON：${e?.message}。content-type=${res.headers.get('content-type')}，长度=${rawText.length}，内容预览：${rawText.slice(0, 200)}`);
    }
    if (!Array.isArray(data?.choices) || data.choices.length === 0) {
      throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  try {
    const data = await attemptOnce(body);
    const choice = data.choices[0];
    const message = choice?.message ?? {};
    const result = {
      message,
      finishReason: choice?.finish_reason ?? null,
      usage: data.usage ?? null, // snake_case 原始对象（camelCase 归一在 addUsage 侧）
      model: data.model ?? api.model,
      raw: data,
      degraded,
      degradeNote,
      reasoning: extractReasoning(message),
      extraUsage: { reasoningTokens: extractReasoningTokens(data.usage) },
      _usedApi: api,
    };
    receivedResult = result; // 已收到的响应/账单即使后处理被取消也必须交回 runner。
    for (const item of providers('llm.response')) {
      const next = await invoke('llm.response', item, { result, ...ctx });
      if (next?.result && typeof next.result === 'object') Object.assign(result, next.result);
    }
    const extra = { reasoningTokens: extractReasoningTokens(result.usage) };
    for (const item of providers('llm.usage')) {
      const add = await invoke('llm.usage', item, { result, usage: result.usage, ...ctx });
      if (!add || typeof add !== 'object') continue;
      for (const [key, value] of Object.entries(add)) {
        const n = Number(value);
        if (Number.isFinite(n) && n) extra[key] = (extra[key] || 0) + n;
      }
    }
    result.extraUsage = { ...result.extraUsage, ...extra };
    result._usedApi = api;
    await feedback({ ok: true, latencyMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    if (receivedResult && signal?.aborted) return receivedResult;
    await feedback({ ok: false, error: String(err?.message ?? err), latencyMs: Date.now() - startedAt });
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------- chatCompletionWithRetry（06c §4：候选降级 + 同模型退避）----------
export async function chatCompletionWithRetry(args, retries = 2) {
  const { cfg } = args;
  const candidates = [];
  candidates.push({
    baseUrl: cfg?.api?.baseUrl ?? '', apiKey: resolveRequestApiKey(cfg), model: cfg?.api?.model ?? '',
    timeoutMs: cfg?.api?.timeoutMs ?? DEFAULT_TIMEOUT_MS, provider: cfg?.api?.provider ?? '',
  });
  if (args.overrides) candidates[0] = { ...candidates[0], ...args.overrides };
  for (const fb of args.overrides ? [] : cfg?.api?.fallbackModels ?? []) {
    if (!fb?.model) continue;
    if (fb.provider) {
      const p = (cfg?.providers ?? []).find((x) => x && x.id === fb.provider);
      const baseUrl = p?.baseURL ?? p?.baseUrl;
      const key = resolveApiKey({ ...cfg, api: { ...cfg?.api, provider: fb.provider, apiKey: '' } });
      if (!baseUrl) continue; // 找不到 baseUrl 跳过该候选
      candidates.push({ baseUrl, apiKey: key && key !== '******' ? key : '', model: fb.model, timeoutMs: cfg?.api?.timeoutMs ?? DEFAULT_TIMEOUT_MS, provider: fb.provider });
    } else {
      candidates.push({ ...candidates[0], model: fb.model });
    }
  }

  let lastError = null;
  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    if (ci > 0) console.warn?.(`[llm] 主模型重试仍失败，切换到备选模型 ${ci}/${candidates.length - 1}：${cand.model}`);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (args.signal?.aborted) throw args.signal.reason ?? new Error('已中止');
      try {
        const r = await chatCompletion({ ...args, overrides: cand, useEndpointPool: ci === 0 && !args.overrides });
        r._usedModel = r.model ?? cand.model; // 网关回显真名
        r._usedApi = r._usedApi ?? cand;                    // 实际端点（渠道与模型同源，成本报表依据）
        return r;
      } catch (err) {
        lastError = err;
        if (err?.code === 'MODEL_TARGET_INVALID') throw err;
        if (args.signal?.aborted || !isRetryableError(err)) break; // 4xx 换下一个候选（SUSPECT 复刻：注释与代码不符，以代码为准）
        if (attempt < retries) {
          const wait = RETRY_BACKOFF[Math.min(attempt, RETRY_BACKOFF.length - 1)];
          console.warn?.(`[llm] 请求失败（${cand.model}，第 ${attempt + 1} 次尝试），${wait}ms 后重试：${err?.message}`);
          try {
            await new Promise((resolve, reject) => {
              const complete = () => { args.signal?.removeEventListener('abort', onAbort); resolve(); };
              const onAbort = () => { clearTimeout(t); args.signal?.removeEventListener('abort', onAbort); reject(args.signal.reason ?? new Error('已中止')); };
              const t = setTimeout(complete, wait);
              if (args.signal?.aborted) onAbort();
              else args.signal?.addEventListener('abort', onAbort, { once: true });
            });
          } catch (e) { throw e; }
        }
      }
    }
  }
  throw lastError ?? new Error('模型请求失败（主模型与全部备选均不可用）');
}

// listModels（06c §6：无缓存无失败兜底，15s 超时）
export async function listModels({ baseUrl, apiKey, fetchFn = fetch }) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/models`;
  const res = await fetchFn(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return arr.map((m) => ({ id: String(m?.id ?? m?.model ?? m) })).filter((x) => x.id);
}
