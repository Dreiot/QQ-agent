// Orchestrator：唤醒调度 + 会话状态机（§6.4/§6.5/§6.8/§6.9/§6.11/§6.12/§6.13）。
// 关键不变量：
// - 逐条判定一次定生死；防抖不重置（窗口内新消息只入库）
// - 运行期间普通新消息标已读；首次 @我起保留未读，收尾后合并为下一批
// - 等待会话复用必须用 sessions.current() 活对象（get() 是克隆）
// - 机械批逐条补判定（不能用"有没有等待会话"区分——tier 0 垃圾会话事故）
// - 会话重试硬前提 sent.length===0（R-08：群里不会出现两遍同样的话）
// - 并发满 → 跟踪式 3s 重排（必须入 wakeTimers，否则 stop() 后幽灵唤醒）
import { resolveContextTier, triggerLabels } from './wake.js';
import { buildSystemPrompt, buildUserPrompt, buildPastState, resolvePromptAnchor, resolveHistoryLimit, formatEntry } from './prompt.js';
import { runAgent } from './agent-runner.js';
import { isRetryableError } from './llm.js';
import { mdToPlain, splitText, prepareTextBatch } from './send-text.js';
import { requestMemoryConsolidation } from '../console/memory-media-adapters.js';
import { personaForChat } from './persona.js';
import { effectiveGlobalBlocklist, resolveGlobalBlocklist } from './ingest.js';
import { isChatQuiet } from './command-mute-state.js';

const BATCH_FLOOR_MS = 60_000;   // verified 批：waiting.startedAt - 60s 之后的进批
const DRAIN_MIN_MS = 200;        // drain 下限（§5.1）
const REQUEUE_MS = 3000;         // 并发满重排（§13 T-15）
const BAN_CACHE_MS = 60_000;     // 禁言缓存 60s（§13 T-16 非定时器周期行为）
const ACTIVE_TOPIC_MAX = 60;     // activeTopic ≤60 字（§6.8）
const DISCOVERY_SCAN_WINDOW = 2000; // 与记忆服务身份窗口一致；每位候选实际提炼仍只取最近40条。

function awaitDiscovery(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', cancel); action(value);
    };
    const cancel = () => finish(reject, signal.reason ?? new Error('记忆发现已取消'));
    if (signal.aborted) { cancel(); Promise.resolve(operation).catch(() => {}); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function createOrchestrator({
  cfg, store, sessions, memory, send, registry, loader, capability = null, transport: transportArg, onebot: onebotArg, log = console, bus = null,
  isPaused = () => false, buildToolsFor = null, execContextFor = null,
  transcribe = null, now = () => Date.now(), llmInvoker = null, components = null, lifecycle = null,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random,
  globalBlocklistOf = null, serviceLeaseOf = null,
} = {}) {
  const systemPromptFor = components?.['core.prompt.system'] ?? buildSystemPrompt;
  const userPromptFor = components?.['core.prompt.user'] ?? buildUserPrompt;
  const pastStateFor = components?.['core.prompt.pastState'] ?? buildPastState;
  const promptAnchorFor = components?.['core.prompt.anchor'] ?? resolvePromptAnchor;
  const agentRunner = components?.['core.agentRunner'] ?? runAgent;
  const resolveWake = components?.['core.wake.resolve'] ?? resolveContextTier;
  const consolidateMemory = components?.['core.memory.consolidate'] ?? requestMemoryConsolidation;
  const plainText = components?.['core.text.plain'] ?? mdToPlain;
  const splitForSend = components?.['core.text.split'] ?? splitText;
  const chatPersonaFor = components?.['core.prompt.persona'] ?? personaForChat;
  const retryableError = components?.['core.session.retryable'] ?? isRetryableError;
  const transport = transportArg ?? onebotArg ?? null; // 兼容键：存量调用方仍传 onebot
  const pendingWake = new Map();  // chatKey -> { timer, sessionId, proactive }
  const wakeTimers = new Set();   // 全部排程定时器（重排/等待，stop 时全清）
  const active = new Map();       // chatKey -> { topic, until }
  const activeTimers = new Map(); // chatKey -> expiry timer (one timer per topic)
  const banCache = new Map();     // chatKey -> { muted, checkedAt }
  const aborters = new Map();     // sessionId -> AbortController
  const mentionedDuringRun = new Set(); // sessionId：忙时已收到 @我，此后的消息留给下一批
  const wakeChecks = new Set();   // 正在等禁言查询的唤醒；此时尚未创建运行控制器
  let paused = false;
  let discoveryGeneration = 0;
  let discoveryController = new AbortController();
  const pendingDiscovery = new Map();
  function cancelDiscovery() {
    ++discoveryGeneration;
    pendingDiscovery.clear();
    if (!discoveryController.signal.aborted) discoveryController.abort(new Error('记忆发现已暂停或停止'));
  }
  function discoverAfterConversation(chatKey) {
    if (pendingDiscovery.has(chatKey)) return;
    const generation = discoveryGeneration, signal = discoveryController.signal;
    const pending = Promise.resolve().then(() => maybeConsolidate(chatKey, {
      signal, current: () => generation === discoveryGeneration && !isPausedNow(),
    })).catch(error => {
      if (!signal.aborted) log.warn?.(`[memory] 自动发现失败：${error?.message ?? error}`);
    }).finally(() => {
      if (pendingDiscovery.get(chatKey) === pending) pendingDiscovery.delete(chatKey);
    });
    pendingDiscovery.set(chatKey, pending);
  }
  let proactiveTimer = null;
  let proactiveRunning = false;
  let reminderTimer = null;
  let reminderStore = null;
  let suspendedLoops = null;
  let reminderGeneration = 0;
  let reminderController = null;
  const reminderProgress = new Map(); // 部分发送成功后的剩余内容，避免下一 tick 重发已送达部分。
  const reminderFiring = new Set();

  const isPausedNow = () => paused || isPaused();
  const unreadForWake = (chatKey) => store.unread(chatKey, { includePokes: true });
  let contextWatch = null;
  function watchContext() {
    if (contextWatch || !store.onContextInvalidated) return;
    contextWatch = store.onContextInvalidated(chatKey => {
      promptAnchors.delete(chatKey);
      promptAnchorLimits.delete(chatKey);
    });
  }
  const activeFor = (chatKey) => {
    const state = active.get(chatKey);
    if (state && (cfg().chatActive?.enabled !== true || state.until <= now() || isChatQuiet(cfg().commandMute,chatKey,now()))) {
      active.delete(chatKey);
      const timer = activeTimers.get(chatKey);
      if (timer) { clearTimeout(timer); wakeTimers.delete(timer); }
      activeTimers.delete(chatKey);
      return null;
    }
    return state;
  };

  function retryDelay(ms, signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (ready) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(ready); };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  // ---------- 会话级配置（档位/禁言/峰谷/分群四象限）----------
  function storeConfigForChat(chatKey, isPrivate) {
    const c = cfg();
    const s = c.store ?? {};
    const parts = String(chatKey).split(':');
    const gid = parts[parts.length - 1];
    let sliderPos = s.contextSliderPos;
    let tier = s.contextTier ?? 4;
    let randomPercent = s.randomPercent ?? 10;

    if (!isPrivate && s.unifiedTier === false && s.groupSliderPos?.[gid] !== undefined) {
      sliderPos = s.groupSliderPos[gid];
      const t = tierFromSlider(sliderPos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 峰谷（跨零点支持）
    const ps = s.peakSchedule;
    const peakOn = ps?.enabled === true;
    const inPeak = peakOn && withinWindow(ps.peak?.start, ps.peak?.end, new Date(now()));
    if (peakOn) {
      const pos = inPeak ? (ps.peak?.sliderPos ?? 10) : (ps.valley?.sliderPos ?? 100);
      const t = tierFromSlider(pos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 分群峰谷叠加（四象限：分群档位之上再取峰谷）
    if (!isPrivate && s.unifiedTier === false && peakOn && s.groupPeakPos?.[gid]) {
      const gp = s.groupPeakPos[gid];
      const pos = inPeak ? (gp.peak ?? pos0(ps, inPeak)) : (gp.valley ?? pos0(ps, inPeak));
      const t = tierFromSlider(pos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 指令禁言强制 1 档
    const commandMuteTier = isChatQuiet(c.commandMute,chatKey,now()) ? 1 : null;
    return {
      contextTier: tier, randomPercent, keywords: s.keywords ?? [], historyCount: s.historyCount ?? 80,
      unifiedTier: s.unifiedTier !== false,
      botName: c.persona?.botName, selfNickname: c.persona?.selfNickname, selfId: transport?.selfId,
      commandMuteTier,
    };
  }

  function pos0(ps, inPeak) { return inPeak ? (ps.peak?.sliderPos ?? 10) : (ps.valley?.sliderPos ?? 100); }

  function tierFromSlider(pos) {
    const p = Math.max(0, Math.min(100, Number(pos) ?? 100));
    if (p <= 10) return { tier: 1, percent: 10 };
    if (p <= 20) return { tier: 2, percent: 10 };
    if (p < 90) return { tier: 3, percent: Math.round(((p - 20) / 70) * 100) };
    return { tier: 4, percent: 100 };
  }

  function withinWindow(start, end, date) {
    const toMin = (value) => {
      const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const hour = Number(m[1]); const minute = Number(m[2]);
      return hour > 23 || minute > 59 ? null : hour * 60 + minute;
    };
    const s = toMin(start); const e = toMin(end);
    if (s === null || e === null || s === e) return false;
    const cur = date.getHours() * 60 + date.getMinutes();
    if (s < e) return cur >= s && cur < e;
    return cur >= s || cur < e; // 跨零点（22:00~06:00）
  }

  // ---------- 入站：逐条判定一次定生死（§6.4）----------
  async function onIncoming(chatKey, entry) {
    watchContext();
    if (entry.recalled) return;
    if (isPausedNow()) return;
    const runningSession = sessions.current(chatKey);
    if (runningSession?.status === 'running') {
      // 本轮触发批已经固定；首次真正的 @我及其后续消息，等本轮结束后统一处理。
      // 拍一拍也带 atMe 标记，但不属于本条 @ 规则。
      if (entry.atMe === true && !entry.isPoke) mentionedDuringRun.add(runningSession.id);
      if (mentionedDuringRun.has(runningSession.id)) return;
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      return;
    }
    if (!cfg().api?.model) return;         // 模型未设置：不判定（消息留未读，配好后自动补处理）
    if (pendingWake.has(chatKey)) return;  // 倒计时中：只入库，不重置倒计时（防抖不重置）
    if (activeFor(chatKey)) { // 活跃期必响应
      scheduleWake(chatKey, null, { verified: false, proactive: false });
      return;
    }
    const isPrivate = chatKey.startsWith('private:');
    const c = storeConfigForChat(chatKey, isPrivate);
    const verdict = resolveWake({ entry, cfg: c, isPrivate, roll: null });
    if (!verdict.shouldRespond) {
      // 不触发 → 当场标已读（未读一闪即已读）
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      return;
    }
    entry._tier = verdict.tier;
    entry._reason = verdict.reason;
    scheduleWake(chatKey, null, { verified: true });
  }

  // ---------- 等待倒计时（固定不重置）----------
  function scheduleWake(chatKey, delayOverride = null, { verified = false, proactive = false, sessionId = null, reuse = false } = {}) {
    if (pendingWake.has(chatKey)) return pendingWake.get(chatKey).sessionId;
    const delay = delayOverride ?? Math.max(200, Number(cfg().wakeDelayMs) || 2000);
    let sid = sessionId;
    if (!sid && !reuse) {
      const unread = unreadForWake(chatKey);
      const first = unread[0];
      const trigger = first ? `${first.senderName}：${String(first.text).slice(0, 40)}` : '（补充处理）';
      const s = sessions.create(chatKey, { trigger, waitUntil: now() + delay });
      sessions.update(s, { status: 'waiting', waitUntil: now() + delay, verified, proactive });
      sid = s.id;
    }
    const timer = setTimeout(() => {
      pendingWake.delete(chatKey);
      wakeTimers.delete(timer);
      wake(chatKey, { waitingSessionId: sid, verified, proactive }).catch((err) => {
        log.error?.(`[orch] wake(${chatKey}) 异常：${err?.stack || err}`);
      });
    }, delay);
    wakeTimers.add(timer);
    pendingWake.set(chatKey, { timer, sessionId: sid, proactive, verified });
    bus?.emit('session.update', sessions.peek(sid) ?? {});
    return sid;
  }

  // ---------- 自己被禁言查询（§6.5.3；判据必须"到期时刻在未来"）----------
  async function checkSelfMuted(chatKey, isCancelled = () => false) {
    const gid = chatKey.split(':').pop();
    const cached = banCache.get(chatKey);
    if (cached && now() - cached.checkedAt < BAN_CACHE_MS) return cached.muted;
    // 快路径：chat.ban-state 能力（有通知记录直接用）
    let muted = false;
    try {
      const p = banStateProvider?.();
      if (p?.check) muted = !!(await p.check(gid));
    } catch { /* 回落慢路径 */ }
    if (isCancelled()) return false;
    if (!muted) {
      // 慢路径走 transport 归一化动作（平台语义在 provider 内消化，transport.js:2 架构约束）。
      // SUSPECT 判据（"到期时刻在未来"）已随实现移入 OneBot provider 的 getSelfMemberInfo。
      try {
        const r = await transport?.actions?.getSelfMemberInfo?.(chatKey);
        if (r) muted = !!r.muted; // null = 平台无法判定，按未禁言处理
      } catch { muted = false; }
    }
    if (isCancelled()) return false;
    banCache.set(chatKey, { muted, checkedAt: now() });
    return muted;
  }
  let banStateProvider = null;

  // ---------- wake：取触发批与运行（§6.5 顺序闸）----------
  async function wake(chatKey, { waitingSessionId = null, verified = false, proactive = false } = {}) {
    watchContext();
    activeFor(chatKey); // 事件循环拥塞或时钟跳变时也遵守绝对到期时刻。
    const c = cfg();
    const isPrivate = chatKey.startsWith('private:');
    let waiting = waitingSessionId ? sessions.peek(waitingSessionId) : sessions.current(chatKey);
    if (waitingSessionId && (!waiting || !['waiting', 'running'].includes(waiting.status))) return;
    const abortWaiting = (reason) => {
      if (waiting) sessions.finish(waiting.id, 'aborted', { error: reason });
    };
    // 闸 1
    if (isPausedNow()) return abortWaiting('全局暂停');
    // 闸 2：模型未设置 → 消息保留未读（配好后自动补处理）
    if (!c.api?.model) return abortWaiting('模型未设置');
    if (proactive && isChatQuiet(c.commandMute,chatKey,now())) return;
    // 闸 3：自己被禁言（群聊）
    if (!isPrivate) {
      const check = { waiting, cancelled: false };
      const waitingInvalid = () => waiting && (sessions.peek(waiting.id) !== waiting || !['waiting', 'running'].includes(waiting.status));
      wakeChecks.add(check);
      let muted;
      try {
        muted = await checkSelfMuted(chatKey, () => check.cancelled || isPausedNow() || waitingInvalid());
      } finally {
        wakeChecks.delete(check);
      }
      // 查询期间 waiting 可以已被丢弃；暂停后立刻恢复也不能复活旧唤醒。
      // 必须在标读/重排/转 running 之前检查，禁言结果为 true 时也同样适用。
      if (check.cancelled || waitingInvalid()) return;
      if (isPausedNow()) return abortWaiting('全局暂停');
      if (muted) {
        store.markAllRead(chatKey); // 消息不丢，解除后可作历史
        bus?.emit('chat.update', chatKey);
        if (waiting) sessions.finish(waiting.id, 'aborted', { error: '机器人被禁言' });
        return;
      }
    }
    activeFor(chatKey); // 查询禁言期间也可能保存了关闭活跃期，取批前重新校正。
    // 闸 4：并发满 → 跟踪式 3s 重排
    const maxConcurrent = Math.max(1, Number(c.maxConcurrentRuns) || 2);
    if (sessions.running().length >= maxConcurrent) {
      if (waiting) sessions.update(waiting, { waitUntil: now() + REQUEUE_MS, status: 'waiting' });
      const t = setTimeout(() => {
        reminderTimersDelete(t);
        wake(chatKey, { waitingSessionId: waiting?.id ?? null, verified, proactive }).catch(() => {});
      }, REQUEUE_MS);
      wakeTimers.add(t); // 必须入表——否则 stop() 后幽灵唤醒
      return;
    }

    // 闸 5：取触发批
    const quietNow = isChatQuiet(cfg().commandMute,chatKey,now());
    if (proactive && quietNow) return;
    const unreadAll = unreadForWake(chatKey);
    if (unreadAll.length === 0 && !proactive) {
      if (waiting) sessions.discard(waiting.id);
      return;
    }
    let batch = [];
    if (proactive) {
      batch = [];
    } else if (waiting?.retryTriggerIds?.length && !quietNow) {
      const ids = new Set(waiting.retryTriggerIds);
      batch = unreadAll.filter((m) => ids.has(m.id));
    } else if (active.has(chatKey) && !quietNow) {
      batch = unreadAll; // 活跃期忽略档位，不重掷随机判定
    } else if (verified && waiting && !quietNow) {
      const floor = (waiting.startedAt ?? now()) - BATCH_FLOOR_MS;
      const fresh = unreadAll.filter((m) => m.ts >= floor);
      const stale = unreadAll.filter((m) => m.ts < floor);
      for (const m of stale) store.markEntryRead(chatKey, m.id); // 旧积压标已读沉历史
      batch = fresh;
    } else {
      // 机械批：逐条补判定（与 onIncoming 同口径）找最早触发消息
      const cfgChat = storeConfigForChat(chatKey, isPrivate);
      let firstTrigger = null;
      const rejectedIds = new Set();
      for (const m of unreadAll) {
        const v = resolveWake({ entry: m, cfg: cfgChat, isPrivate, roll: null });
        // 3 档掷过骰了，结果随手带在 entry 上供第 6 步固定复用（同一条消息只骰一次）
        m._tier = v.tier;
        m._reason = v.reason;
        if (v.shouldRespond) { firstTrigger = m; break; }
        // 补判定同样一次定生死：前缀沉历史，不能留给下一轮 drain 重掷。
        store.markEntryRead(chatKey, m.id);
        rejectedIds.add(m.id);
      }
      if (rejectedIds.size) bus?.emit('chat.update', chatKey);
      if (!firstTrigger) {
        store.markAllRead(chatKey); // 全不触发 → 全部标已读
        if (waiting) sessions.discard(waiting.id); // 没有实际运行，不保留内部控制状态。
        return;
      }
      batch = unreadAll.filter((m) => !rejectedIds.has(m.id) && m.ts >= firstTrigger.ts);
    }
    if (batch.length === 0 && !proactive) { if (waiting) sessions.discard(waiting.id); return; }
    // 触发批一旦被运行消费即标已读；失败时按本批 id 恢复。
    for (const entry of batch) store.markEntryRead(chatKey, entry.id);

    // 6. 档位固定（SPEC §6.5 第 6 点）
    // 用户钦定语义（2026-10-06）：单条消息的随机判定**全程只骰一次**。
    // 首次判定（onIncoming / 机械批补判定）已经把骰子结果写进 entry._reason，
    // 这里直接复用，不再调用 resolveContextTier —— 避免同一条消息被掷第二次。
    const cfgChat = storeConfigForChat(chatKey, isPrivate);
    const first = batch[0];
    const verdict = waiting?.retryTriggerIds?.length && typeof waiting.contextTier === 'number' && waiting.contextReason
      ? { tier: waiting.contextTier, reason: waiting.contextReason }
      : active.has(chatKey) && !proactive
      ? { tier: cfgChat.commandMuteTier ?? Math.min(4, Math.max(1, Number(cfgChat.contextTier) || 4)), reason: '活跃期' }
      : first
      ? (typeof first._tier === 'number' && first._reason
          ? { tier: first._tier, reason: first._reason }
          : resolveWake({ entry: first, cfg: cfgChat, isPrivate, roll: null }))
      : { tier: 0, reason: '主动' };

    // 7. 会话状态机：等待会话原地转 running
    // waiting 摘要仍是首条未读快照（§6.4）；运行时以实际消费批为准，
    // 旧积压被过滤后不能继续把它显示为本次触发消息。
    const trigger = batch[0] ? `${batch[0].senderName}：${String(batch[0].text).slice(0, 40)}` : '主动开话题';
    let session = waiting;
    if (!session || session.status === 'discarded') {
      session = sessions.create(chatKey, { trigger });
    }
    sessions.update(session, {
      status: 'running', trigger, verified, proactive, contextReason: verdict.reason, contextTier: verdict.tier,
      startedAt: now(), triggerEntryIds: batch.map((m) => m.id), retryTriggerIds: null,
    });

    // 同一个控制器覆盖所有尝试和退避；中止后不能为重试创建新信号。
    const controller = new AbortController();
    aborters.set(session.id, controller);
    const contextScope = store.watchContext?.(session.id, () => {
      if (session.status !== 'running' || controller.signal.aborted) return;
      const error = Object.assign(new Error('消息撤回或删除，当前上下文已失效'), { __aborted: true, __contextInvalidated: true });
      controller.abort(error);
      sessions.finish(session.id, 'aborted', { error: error.message });
    });
    contextScope?.capture(chatKey, batch);
    // 显式 0 关闭会话重试；缺省/非有限值才沿用默认 2 次。
    const retryBudget = Number(c.sessionRetryAttempts ?? 2);
    const maxAttempts = 1 + (Number.isFinite(retryBudget) ? Math.min(5, Math.max(0, Math.floor(retryBudget))) : 2);
    let attempt = 0;
    while (attempt < maxAttempts) {
      if (controller.signal.aborted || session.status === 'aborted' || isPausedNow()) {
        sessions.finish(session.id, 'aborted', { error: String(controller.signal.reason?.message ?? '已中止') });
        break;
      }
      attempt += 1;
      try {
        const result = await runOnce({ chatKey, session, batch, cfgChat, isPrivate, proactive, signal: controller.signal, contextScope });
        if (result.error) throw result.error;
        // 收尾：sent>0 → done；否则 noreply（正常选项不是错误）
        sessions.finish(session.id, result.sent.length > 0 ? 'done' : 'noreply', {
          sent: result.sent, usage: result.usage, rounds: result.rounds,
          finishReason: result.finishReason, promptChars: result.promptChars, model: result.model, vendor: result.vendor,
        });
        discoverAfterConversation(chatKey);
        break;
      } catch (err) {
        const sentEmpty = !(sessions.peek(session.id)?.sent?.length);
        const canRetry = attempt < maxAttempts && retryableError(err) && sentEmpty && !err?.__aborted && !controller.signal.aborted && session.status === 'running' && !isPausedNow();
        if (canRetry) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          log.warn?.(`[orch] ${chatKey} 第 ${attempt} 次失败，${backoff}ms 后原地重试：${err?.message}`);
          resetForRetry(session);
          if (!await retryDelay(backoff, controller.signal)) {
            sessions.finish(session.id, 'aborted', { error: String(controller.signal.reason?.message ?? '已中止') });
            break;
          }
          continue;
        }
        sessions.finish(session.id, err?.__aborted || controller.signal.aborted ? 'aborted' : 'error', { error: String(err?.message ?? err) });
        break;
      }
    }
    mentionedDuringRun.delete(session.id);
    aborters.delete(session.id);
    contextScope?.stop();
    // 10. 忙时 @我及其后续消息合并接续一轮；其余忙时消息已标读，不能触发补跑。
    // 真正恢复的未消费积压也继续使用同一套机械判定。
    const rest = unreadForWake(chatKey);
    if (rest.length > 0 && !isPausedNow() && (!controller.signal.aborted || controller.signal.reason?.__contextInvalidated)) {
      scheduleWake(chatKey, Math.max(DRAIN_MIN_MS, Number(c.drainDelayMs) || 1200), { verified: false, reuse: false });
    }
  }

  function resetForRetry(session) {
    sessions.update(session, { error: null, finishReason: null, activeTopic: null });
  }

  // ---------- 单轮运行（prompt 组装 → agent 循环 → 收尾）----------
  async function runOnce({ chatKey, session, batch, cfgChat, isPrivate, proactive, signal, contextScope }) {
    const c = cfg();
    session.sendImageState = { previewed: [], previews: 0, sent: 0 }; // 图片预览/发送额度属于一次运行，工具轮次内共享。
    // 组装前允许确定性插件加工上下文；之后的 before-llm-messages 仍只处理标准消息。
    const callbackContext = { session, chatKey, triggerEntries: batch, signal, botName: c.persona?.botName };
    for (const { fn, ownerId, recordError, managesTimeout } of loader?.hooksOf?.('before-context') ?? []) {
      let timer;
      try {
        const call = Promise.resolve().then(() => fn(callbackContext));
        await (managesTimeout ? call : Promise.race([
          call,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('before-context 超时')), 5000); }),
        ]));
      } catch (err) { if (!managesTimeout && /before-context 超时/.test(err?.message ?? '')) recordError?.(err); log.error?.(`[orch] before-context (${ownerId})：${err?.message ?? err}`); }
      finally { clearTimeout(timer); }
      if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    }
    const globalBlocklist = await resolveGlobalBlocklist(c, globalBlocklistOf, signal);
    const validEntries = store.recent(chatKey, Infinity, { forContext: true });
    const validIds = new Map(validEntries.map(entry => [entry.id, entry]));
    batch = batch.filter(entry => !entry.recalled && validIds.has(entry.id)).map(entry => ({ ...entry, reply: validIds.get(entry.id).reply }));
    const keywordHit = batch.length > 0;
    void keywordHit;
    // 历史与触发批
    // Reuse the valid projection already read after before-context. A fixed
    // archive slice loses configured history and spends its budget on triggers.
    const all = validEntries;
    const excludeIds = new Set(batch.map((m) => m.id));
    const pastLimit = resolveHistoryLimit(cfgChat.historyCount);
    const past = pastStateFor(all, {
      excludeIds, limit: pastLimit,
      globalBlocklist,
      blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
      memberNotes: c.memberNotes ?? {},
      speakerFormat: speakerFormatFn,
    });
    // 锚点（前缀缓存）
    const anchorCfg = c.store?.promptAnchor ?? {};
    let anchorState = null; let pastForPrompt = past; let newReadForPrompt = null;
    if (anchorCfg.enabled === false || pastLimit === 0 || promptAnchorLimits.get(chatKey) !== pastLimit) {
      promptAnchors.delete(chatKey);
      promptAnchorLimits.delete(chatKey);
    }
    session.promptAnchorState = null;
    session.promptAnchorMode = null;
    if (anchorCfg.enabled !== false && pastLimit > 0) {
      const prevAnchor = promptAnchors.get(chatKey);
      const allRead = pastStateFor(all, {
        excludeIds, limit: Infinity, globalBlocklist,
        blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
        memberNotes: c.memberNotes ?? {}, speakerFormat: speakerFormatFn,
      }).messages;
      const decision = promptAnchorFor({
        readMessages: past.messages,
        allReadMessages: allRead,
        prevAnchor,
        maxExtraRead: Number(anchorCfg.maxExtraRead) || 5,
        newUserIds: new Set(),
        triggerEntries: batch,
      });
      promptAnchors.set(chatKey, decision.anchor);
      promptAnchorLimits.set(chatKey, pastLimit);
      anchorState = decision;
      session.promptAnchorState = decision.anchor;
      session.promptAnchorMode = decision.mode;
      // 锚定成立时已读 = 锚点 + 追加（可超 historyCount——2026-09-26 修的事故）
      if (decision.mode === 'anchor') {
        const extra = decision.extraMessages;
        const fullPast = pastStateFor(decision.anchorMessages, {
          excludeIds: new Set(), limit: Math.max(decision.anchorMessages.length, 1),
          globalBlocklist,
          blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
          memberNotes: c.memberNotes ?? {},
          speakerFormat: speakerFormatFn,
        });
        pastForPrompt = fullPast;
        newReadForPrompt = extra;
      }
    }
    contextScope?.capture(chatKey, [...batch, ...pastForPrompt.messages, ...(newReadForPrompt ?? [])]);
    // 相关成员集（锚定模式 → 锚点成员集）
    const memberIds = anchorState?.anchor?.memberIds ?? [...new Set(batch.map((m) => String(m.senderId)))];
    const memText = memory?.formatForPrompt?.(chatKey, { userIds: memberIds }) ?? '';
    const newMemberIds = newReadForPrompt
      ? [...new Set(newReadForPrompt.map((m) => String(m.senderId)).filter((id) => id && id !== 'self'))]
      : [];
    const newMemberText = newMemberIds.length > 0
      ? (memory?.formatForPrompt?.(chatKey, { userIds: newMemberIds }) ?? '')
      : '';
    // 表情库清单（M2 落 sticker-tools 后接真数据；此处读取注入点）
    const stickerListText = stickerListProvider ? await stickerListProvider(chatKey, c.sticker?.promptMaxTokens ?? c.sticker?.promptMaxStickers ?? 10, {signal}) : '';

    let chatPersona = chatPersonaFor(c, chatKey);
    // 主人识别（SPEC §7.5 message.owner-check）：触发批里有没有主人在说话（只按 QQ 号），
    // 有 → 换主人专属人设 + 追加主人规则（priority 72）。能力缺省 = 完全回退全局人设。
    let ownerRules = [];
    const ownerChecker = capability?.providers?.('message.owner-check')?.[0]?.provider;
    if (typeof ownerChecker === 'function') {
      try {
        const verdict = await ownerChecker({ chatKey, entries: batch, cfg: c });
        if (verdict?.persona) chatPersona = { ...chatPersona, ...verdict.persona, botName: chatPersona.botName, selfNickname: c.persona?.selfNickname };
        if (Array.isArray(verdict?.rules)) ownerRules = verdict.rules;
      } catch (err) { log.warn?.(`[orchestrator] message.owner-check 异常（回退全局人设）：${err?.message ?? err}`); }
    }
    const userPrompt = await userPromptFor({
      lifecycle, chatPersona, triggerEntries: batch, pastState: pastForPrompt, memText, newMemberText, stickerListText,
      activeTopic: activeFor(chatKey)?.topic ?? null,
      anchorState, memberNotes: c.memberNotes ?? {}, speakerFormat: speakerFormatFn, now: new Date(now()), proactive,
    });
    const skillSections = await loader?.promptSections?.(callbackContext) ?? [];
    if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    const systemPrompt = await systemPromptFor({ lifecycle, cfg: { ...c, persona: chatPersona }, skillSections, extraSections: ownerRules });
    session.promptChars = systemPrompt.length + userPrompt.length;

    // 工具集（唯一口径；excludedTools 可解释）
    const toolBundle = buildToolsFor ? buildToolsFor({ chatKey, session, c, cfgChat }) : { tools: [], excludedTools: [] };
    session.excludedTools = toolBundle.excludedTools ?? [];

    const previousMessages = session.messages ?? [];
    const previousRounds = session.rounds ?? 0;
    const execContext = { ...(execContextFor ? execContextFor({ chatKey, session }) : {}), signal };
    sessions.update(session, { systemPrompt, userPrompt, pastStateCount: pastForPrompt.count + (anchorState?.mode === 'anchor' ? anchorState.extraMessages.length : 0), traceVersion: 1, activeStep: null });
    const result = await agentRunner({
      session, systemPrompt, userPrompt, tools: toolBundle.tools, triggerEntries: batch,
      execContext,
      cfg: c, log, signal, llmInvoker, components, lifecycle, capabilities: capability, skipBeforeContext: true,
      invokeTool: toolBundle.invoke, hooksOf: (name) => loader?.hooksOf?.(name, { chatKey, signal, botName: chatPersona.botName }) ?? [],
      onStream: ({step,delta}) => {
        const activeStep={...step,messageIndex:previousMessages.length+step.messageIndex};
        if(sessions.stream)sessions.stream(session,activeStep,delta);
        else sessions.update(session,{activeStep});
      },
      onRound: ({ round, messages, sent, usage, providerId, provider, model, vendor, activeStep }) => {
        sessions.update(session, { messages: [...previousMessages, ...messages], sent, usage, rounds: previousRounds + round, providerId, provider, model, vendor,
          activeStep: activeStep ? { ...activeStep, messageIndex: previousMessages.length + activeStep.messageIndex } : null });
      },
    });
    if (result.error) throw result.error;
    // 8. 活跃模式状态机（finish 时）
    applyChatActive({ session, result, cfgChat, chatKey, isPrivate });
    return {
      sent: result.sent, rounds: previousRounds + result.rounds, usage: result.usage,
      finishReason: result.finishReason, promptChars: session.promptChars,
      model: session.model, vendor: session.vendor,
    };
  }

  let stickerListProvider = null;
  const promptAnchors = new Map();
  const promptAnchorLimits = new Map();
  let speakerFormatFn = null;

  // ---------- 活跃模式状态机（§6.8）----------
  function applyChatActive({ session, result, cfgChat, chatKey, isPrivate }) {
    void isPrivate;
    const c = cfg();
    if (c.chatActive?.enabled !== true) { activeFor(chatKey); return; }
    const ttl = Math.max(60_000, (Number(c.chatActive.ttlMinutes) || 30) * 60_000);
    const topic = session.activeTopic;
    const reason = String(result.finishReason ?? '');
    if (/话题(结束|终止|偏离)/.test(reason)) { active.delete(chatKey); const old=activeTimers.get(chatKey); if(old)clearTimeout(old); activeTimers.delete(chatKey); return; }
    if (topic && String(topic).length <= ACTIVE_TOPIC_MAX && session.contextTier >= 1 && session.contextTier <= 3) {
      const old=activeTimers.get(chatKey); if(old){clearTimeout(old);wakeTimers.delete(old);}
      const until=now()+ttl;
      active.set(chatKey, { topic: String(topic), until }); // 换话题延续
      const t = setTimeout(() => { active.delete(chatKey); activeTimers.delete(chatKey); wakeTimers.delete(t); }, ttl);
      activeTimers.set(chatKey, t);
      return;
    }
    if (active.has(chatKey)) {
      const old=activeTimers.get(chatKey); if(old){clearTimeout(old);wakeTimers.delete(old);}
      const until=now()+ttl;
      active.set(chatKey, { ...active.get(chatKey), until });
      const t=setTimeout(()=>{active.delete(chatKey);activeTimers.delete(chatKey);wakeTimers.delete(t);},ttl);
      activeTimers.set(chatKey, t);
    }
  }

  // ---------- 记忆整理触发（§6.9；实际整理在 M4）----------
  async function maybeConsolidate(chatKey, { signal = null, current = () => true } = {}) {
    let c = cfg();
    const eligible = () => !signal?.aborted && current() && !isPausedNow()
      && cfg().memory?.consolidateEnabled !== false
      && !(cfg().memory?.useChatModel === false ? !cfg().memory.model || !cfg().memory.provider : !cfg().api?.model)
      && now() - (memory?.lastConsolidatedAt?.(chatKey) ?? 0) >= Math.max(1_800_000, Number(cfg().memory?.consolidateMinIntervalMs) || 21_600_000);
    if (!eligible()) return;
    const sourceLease = serviceLeaseOf?.('community.client', { signal });
    try {
      let globalIds = [];
      if (Number(c.memory?.discoverMaxMembers ?? 3) !== 0) {
        const reader = typeof sourceLease?.provider?.getBlocklist === 'function'
          ? options => sourceLease.provider.getBlocklist(options) : globalBlocklistOf;
        const sourceSignal = sourceLease?.signal ?? signal;
        globalIds = typeof reader === 'function'
          ? await awaitDiscovery(resolveGlobalBlocklist(c, () => reader({ signal: sourceSignal })), sourceSignal)
          : effectiveGlobalBlocklist(c);
        if (sourceLease?.isValid?.() === false) return;
      }
      // A background lookup may outlive settings, cooldown or the worker that
      // requested it. Re-read every dispatch gate before selecting archived rows.
      if (!eligible()) return;
      c = cfg();
      const st = memory?.stats?.(chatKey) ?? { totalImpressions: 0, maxPerMember: 0 };
      const configuredMinImpr = Number(c.memory?.consolidateMinImpressions ?? 4);
      const minImpr = Number.isFinite(configuredMinImpr) ? Math.max(0, Math.floor(configuredMinImpr)) : 4;
      const maxPer = Number(c.memory?.maxImpressionsPerMember) || 5;
      const consolidating = st.totalImpressions > minImpr || st.maxPerMember > maxPer;
      const configuredMax = Number(c.memory?.discoverMaxMembers ?? 3);
      const discoverMax = Number.isFinite(configuredMax) ? Math.max(0, Math.floor(configuredMax)) : 3;
      const configuredMin = Number(c.memory?.discoverMinMessages ?? 20);
      const discoverMin = Number.isFinite(configuredMin) ? Math.max(1, Math.floor(configuredMin)) : 20;
      const discovered = [];
      if (discoverMax) {
        const blocked = new Set([...globalIds, ...(c.blocklist?.[chatKey.split(':').pop()] ?? [])].map(String));
        const history = (store?.recent?.(chatKey, DISCOVERY_SCAN_WINDOW) ?? []).filter((entry) => !entry.self && !entry.isPoke && !entry.recalled && String(entry.text ?? '').trim() && /^\d{1,15}$/.test(String(entry.senderId)) && Number(entry.senderId) > 0 && !blocked.has(String(entry.senderId)));
        const known = new Set();
        for (const member of memory?.query?.(chatKey) ?? []) {
          if (!member.impressions?.length) continue;
          if (/^\d{1,15}$/.test(String(member.userId ?? ''))) { known.add(String(member.userId)); continue; }
          const name = String(member.name ?? '');
          if (!name) continue;
          const matches = new Set([
            ...Object.entries(c.memberNotes ?? {}).filter(([id, note]) => note === name && /^\d{1,15}$/.test(id)).map(([id]) => id),
            ...history.filter((entry) => entry.senderName === name).map((entry) => String(entry.senderId)),
          ]);
          if (matches.size === 1) known.add([...matches][0]);
        }
        const counts = new Map();
        history.forEach((entry, index) => { const id = String(entry.senderId); if (known.has(id)) return; const item = counts.get(id) ?? { id, count: 0 }; item.count++; item.last = index; counts.set(id, item); });
        discovered.push(...[...counts.values()].filter((item) => item.count >= discoverMin).sort((a, b) => b.last - a.last).slice(0, discoverMax).map((item) => item.id));
      }
      if (!consolidating && !discovered.length) return;
      // 自动与控制台手动整理共用 memory-consolidate adapter；缺少 provider 时只记录事件，
      // 不阻塞本轮聊天，也不在此处另起第二套整理循环。
      if (!eligible() || sourceLease?.isValid?.() === false) return;
      const result = consolidateMemory({ memory, chatKey, userIds: consolidating ? null : discovered, create: discovered.length > 0, createUserIds: discovered.length ? discovered : null, signal });
      if (result?.status !== 202 && result?.status !== 409) {
        bus?.emit('memory.update', {
          phase: 'consolidate-error', chatKey,
          error: result?.body?.reason ?? '记忆整理能力不可用',
        });
      }
    } finally { sourceLease?.dispose?.(); }
  }

  // ---------- 主动开话题（§6.11）----------
  function startProactiveLoop() {
    stopProactiveLoop();
    proactiveRunning = true;
    scheduleNextProactive();
  }
  async function tickProactive() {
    // 排程先行：即使本 tick 被任一闸挡住，下次检查仍已安排。
    scheduleNextProactive();
    const c = cfg();
    if (c.proactive?.enabled !== true || isPausedNow()) return;
    const maxConcurrent = Math.max(1, Number(c.maxConcurrentRuns) || 2);
    if (sessions.running().length >= maxConcurrent) return;
    const probability = Number(c.proactive?.probability);
    if (random() >= Math.max(0, Math.min(1, Number.isFinite(probability) ? probability : 0.25))) return;
    const idleMs = Math.max(300_000, Number(c.proactive?.idleThresholdMs) || 1_800_000);
    const candidates = (c.allow?.groups ?? []).filter((gid) => {
      const key = `group:${gid}`;
      if (unreadForWake(key).length > 0 || sessions.current(key)) return false;
      const last = store.recent(key, 1)[0];
      return !last || (now() - last.ts) >= idleMs;
    });
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(random() * candidates.length)];
    await wake(`group:${pick}`, { proactive: true });
  }
  function scheduleNextProactive() {
    const c = cfg();
    const min = Math.max(60_000, Number(c.proactive?.checkIntervalMinMs) || 1_800_000);
    const max = Math.max(min, Number(c.proactive?.checkIntervalMaxMs) || 5_400_000);
    const delay = min + Math.floor(random() * (max - min));
    proactiveTimer = setTimeoutFn(() => {
      const firedTimer = proactiveTimer;
      proactiveTimer = null;
      if (firedTimer) wakeTimers.delete(firedTimer);
      tickProactive().catch(() => {});
    }, delay);
    if (typeof proactiveTimer.unref === 'function') proactiveTimer.unref();
    wakeTimers.add(proactiveTimer);
  }
  function stopProactiveLoop() {
    proactiveRunning = false;
    if (proactiveTimer) { clearTimeoutFn(proactiveTimer); wakeTimers.delete(proactiveTimer); proactiveTimer = null; }
  }

  // ---------- 提醒循环（§6.12；reminders 仓在 M2）----------
  function startReminderLoop(reminders) {
    stopReminderLoop();
    reminderStore = reminders;
    const generation = reminderGeneration;
    const controller = new AbortController();
    reminderController = controller;
    const tick = async () => {
      if (generation !== reminderGeneration) return;
      if (reminderTimer) wakeTimers.delete(reminderTimer);
      reminderTimer = null;
      const due = reminders?.due?.(now()) ?? [];
      for (const r of due) {
        if (generation !== reminderGeneration || isPausedNow()) break;
        if (reminderFiring.has(r.id)) continue;
        if (reminders.pending && !reminders.pending(r.chatKey).some((item) => item.id === r.id)) continue;
        reminderFiring.add(r.id);
        try {
          // 走 SendQueue 完整管道；发送成功才 markFired（反过来断线会永久丢提醒）
          // Persisted fragments have already been prepared. Reusing them must
          // neither run a non-idempotent converter again nor trim split edges.
          const previous = reminderProgress.get(r.id) ?? r.pendingTexts;
          const remaining = previous ?? prepareTextBatch(r.text, {
            plainText, split: splitForSend, limit: cfg().send?.hardSplitAt ?? 4000,
          });
          if (previous == null) {
            // Save the plan before its first external effect. Even a rejected
            // first chunk must retry the same output of a stateful converter.
            if (reminders.updatePendingTexts?.(r.id, remaining) === false) throw new Error('提醒已取消，未发送');
            reminderProgress.set(r.id, remaining);
          }
          const result = await send.sendTextBatch(r.chatKey, remaining, { signal: controller.signal, textFormat: 'prepared' });
          if (result?.failed?.length) {
            const pending = remaining.slice(result.failed[0].index);
            reminderProgress.set(r.id, pending);
            reminders.updatePendingTexts?.(r.id, pending);
            throw new Error(result.failed.map((item) => item.error).join('；'));
          }
          if (!result?.sent?.length && result?.deduped !== true) throw new Error('提醒没有成功发送');
          reminders.markFired(r.id);
          reminderProgress.delete(r.id);
        } catch (err) {
          log.warn?.(`[orch] 提醒发送失败（保留待发）：${err?.message}`);
        } finally {
          reminderFiring.delete(r.id);
        }
      }
      if (generation !== reminderGeneration) return;
      reminderTimer = setTimeoutFn(tick, 20_000);
      if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
      wakeTimers.add(reminderTimer);
    };
    reminderTimer = setTimeoutFn(tick, 5_000); // 启动 5 秒首查
    if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
    wakeTimers.add(reminderTimer);
  }
  function stopReminderLoop() {
    reminderStore = null;
    reminderGeneration++;
    reminderController?.abort(Object.assign(new Error('提醒调度已停止'), { __aborted: true }));
    reminderController = null;
    if (reminderTimer) { clearTimeoutFn(reminderTimer); wakeTimers.delete(reminderTimer); reminderTimer = null; }
  }
  function reminderTimersDelete(t) { wakeTimers.delete(t); }

  // ---------- 会话控制（§6.13）----------
  function retrySession(id) {
    const s = sessions.peek(id);
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.status !== 'error') return { ok: false, error: '只有失败的会话才能重试' };
    if (s.sent?.length > 0) return { ok: false, error: '该会话已发出过消息，重试会导致重复发言' };
    if (sessions.current(s.chatKey)?.status === 'running') return { ok: false, error: '该会话正在运行中' };
    const from = s.startedAt ?? now();
    const to = s.endedAt ?? now();
    const ids = Array.isArray(s.triggerEntryIds) && s.triggerEntryIds.length ? s.triggerEntryIds : null;
    const restored = ids && store.markEntriesUnread
      ? store.markEntriesUnread(s.chatKey, ids)
      : store.markUnreadInWindow(s.chatKey, from, to);
    if (restored === 0) return { ok: false, error: '触发消息已无法定位（时间窗内没有可恢复的消息）' };
    // 原地复用同一会话 id（新开一条会在页面上出现两条记录）。
    const delay = Math.max(200, Number(cfg().wakeDelayMs) || 2000);
    sessions.update(s, {
      status: 'waiting', waitUntil: now() + delay, error: null,
      finishReason: null, activeTopic: null, endedAt: null, retryTriggerIds: ids,
    });
    scheduleWake(s.chatKey, delay, { verified: Boolean(ids), sessionId: id, reuse: true });
    return { ok: true, restored };
  }

  function abortSession(id) {
    const s = sessions.peek(id);
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.status === 'waiting') {
      const pw = pendingWake.get(s.chatKey);
      if (pw && pw.sessionId === id) {
        clearTimeout(pw.timer);
        wakeTimers.delete(pw.timer);
        pendingWake.delete(s.chatKey);
      }
      sessions.discard(id); // 干净消失（内存与持久化文件均删除）
      return { ok: true };
    }
    if (s.status === 'running') {
      mentionedDuringRun.delete(id);
      const ac = aborters.get(id);
      if (ac) ac.abort(Object.assign(new Error('用户中止'), { __aborted: true }));
      sessions.finish(id, 'aborted', { error: null, finishReason: '用户中止' });
      return { ok: true, status: 'aborted' };
    }
    // A run can finish between painting the button and receiving this request.
    // Acknowledge that race without changing the actual terminal outcome.
    return { ok: true, alreadyFinished: true, status: s.status };
  }

  function abortAll() {
    mentionedDuringRun.clear();
    for (const check of wakeChecks) {
      check.cancelled = true;
      const s = check.waiting;
      if (!s || sessions.peek(s.id) !== s) continue;
      if (s.status === 'waiting') sessions.discard(s.id);
      else if (s.status === 'running') sessions.finish(s.id, 'aborted', { error: '全局中止' });
    }
    wakeChecks.clear();
    for (const [chatKey, pw] of pendingWake) {
      clearTimeout(pw.timer);
      wakeTimers.delete(pw.timer);
      if (pw.sessionId) sessions.discard(pw.sessionId);
      pendingWake.delete(chatKey);
    }
    for (const ac of aborters.values()) ac.abort(Object.assign(new Error('全局中止'), { __aborted: true }));
    for (const t of [...wakeTimers]) {
      if (t === proactiveTimer || t === reminderTimer) continue;
      clearTimeout(t);
      wakeTimers.delete(t);
    }
  }

  function drainBacklogAfterResume() {
    for (const chat of store.listChats?.() ?? []) {
      if (unreadForWake(chat.chatKey).length === 0) continue;
      if (sessions.current(chat.chatKey) || pendingWake.has(chat.chatKey)) continue;
      scheduleWake(chat.chatKey, null, { verified: false, proactive: false });
    }
  }

  function pause() {
    if (!paused) suspendedLoops = { proactive: proactiveRunning, reminders: reminderStore };
    paused = true;
    cancelDiscovery();
    stopProactiveLoop(); stopReminderLoop(); abortAll();
  }
  function resume({ skipBacklog = false } = {}) {
    const wasPaused = paused;
    paused = false;
    if (discoveryController.signal.aborted) { ++discoveryGeneration; discoveryController = new AbortController(); }
    if (wasPaused && suspendedLoops) {
      const loops = suspendedLoops; suspendedLoops = null;
      if (loops.proactive) startProactiveLoop();
      if (loops.reminders) startReminderLoop(loops.reminders);
    }
    if (wasPaused && !skipBacklog) drainBacklogAfterResume();
  }
  function stop() { cancelDiscovery(); suspendedLoops = null; contextWatch?.(); contextWatch = null; abortAll(); stopProactiveLoop(); stopReminderLoop(); for(const timer of activeTimers.values()){clearTimeout(timer);wakeTimers.delete(timer);} activeTimers.clear(); active.clear(); }

  function status() {
    for (const chatKey of active.keys()) activeFor(chatKey);
    return {
      paused: isPausedNow(),
      running: sessions.running().map((s) => ({ id: s.id, chatKey: s.chatKey, startedAt: s.startedAt })),
      waiting: [...pendingWake.entries()].map(([chatKey, pw]) => ({ chatKey, sessionId: pw.sessionId })),
      wakeTimers: wakeTimers.size,
      activeTopics: [...active.entries()].map(([chatKey, v]) => ({ chatKey, ...v })),
    };
  }

  return {
    onIncoming, wake, scheduleWake, abortAll, pause, resume, drainBacklogAfterResume, stop, status, isPaused:isPausedNow,
    retrySession, abortSession, startProactiveLoop, stopProactiveLoop, startReminderLoop, stopReminderLoop,
    storeConfigForChat,
    // 注入点（M1 装配 / M2 插件接线）
    _inject: {
      setBanStateProvider: (fn) => { banStateProvider = fn; },
      setStickerListProvider: (fn) => { stickerListProvider = fn; },
      setSpeakerFormat: (fn) => { speakerFormatFn = fn; },
    },
    _active: active,
    _applyChatActive: applyChatActive,
    _tickProactive: tickProactive,
  };
}

export { formatEntry, triggerLabels, personaForChat };
