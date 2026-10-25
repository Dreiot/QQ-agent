// SessionRegistry：data/sessions/<id>.json 会话仓。
// 契约：notes/12-data.md §3.5/§3.6；SPEC §6.4（peek 活对象）/§6.5（状态机）/§2.3（status 枚举）。
// - id = Date.now().toString(36)-<4B hex>
// - 运行中 2 秒节流写；finish 立即写；索引缓存 5s 防抖（version 1 闸门；运行中不进缓存）
// - 僵尸回收：启动时 waiting/running → aborted + abortedOnBoot
// - peek 不克隆（SSE 富载荷必须随推）/ get 克隆（改副本不丢活对象更新——§6.4 实现细节）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionTelemetryTotals } from './telemetry.js';

const PERSIST_THROTTLE_MS = 2000;     // 12-data §3.5：每会话 2 秒最多写一次
const INDEX_DEBOUNCE_MS = 5000;       // 12-data §3.6：索引缓存防抖
const SUMMARY_FIELDS = ['id', 'chatKey', 'startedAt', 'endedAt', 'status', 'waitUntil', 'activity',
  'webSearchCount', 'outcome', 'usage', 'vendor', 'model', 'trigger', 'promptChars', 'rounds',
  'sent', 'error', 'finishReason', 'excludedTools', 'contextReason', 'contextTier', 'verified', 'proactive', 'providerId', 'provider', 'background'];

function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return fallback; }
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

export function createSessionRegistry({ dataDir, log = console, keepSessionFiles = () => 0, bus = null, onFinishedSession = null } = {}) {
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map(); // id -> session（活对象）
  const persistTimers = new Map(); // 定时器属于仓库，不能进入 JSON 或 structuredClone 的会话数据。
  const streamBatches = new Map();
  const unarchived = new Set(); // 日档失败时保留会话文件，下一次成功后解除；不写入会话正文。
  let keepOverride;
  let indexCacheTimer = null;
  let indexDirty = false;
  let reconcileTimer = null;
  let reconcileComplete = false;
  let totalsFloor = null; // 同进程内保留下限，留档清理后缓存损坏也不能抹掉已累计值。

  function fileOf(id) { return path.join(dir, `${id}.json`); }

  function summary(s) {
    const out = {};
    for (const k of SUMMARY_FIELDS) out[k] = s[k] ?? null;
    return out;
  }

  function persistNow(s) {
    if (byId.get(s.id) !== s) return;
    try { atomicWrite(fileOf(s.id), s); } catch (err) { log.error?.(`[sessions] 写 ${s.id} 失败：${err?.message}`); }
  }

  function cancelPersist(id) {
    const timer = persistTimers.get(id);
    if (timer) clearTimeout(timer);
    persistTimers.delete(id);
  }

  function schedulePersist(s){
    if(persistTimers.has(s.id))return;
    const timer=setTimeout(()=>{persistTimers.delete(s.id);persistNow(s);},PERSIST_THROTTLE_MS);
    persistTimers.set(s.id,timer);timer.unref?.();
  }
  function flushStream(id){
    const batch=streamBatches.get(id);if(!batch)return;
    clearTimeout(batch.timer);streamBatches.delete(id);
    bus?.emit('session.delta',batch.payload);
  }
  // Persist a recoverable snapshot, but transport only the new text. Batch tiny
  // token frames once per 50 ms; a normal update always drains them first.
  function stream(s,step,delta){
    if(byId.get(s.id)!==s||s.status!=='running')return;
    s.activeStep=step;schedulePersist(s);
    let batch=streamBatches.get(s.id);
    if(batch&&(batch.payload.step.streamId!==step.streamId||delta.reset||batch.payload.delta.content.length+batch.payload.delta.reasoning.length>65536)){flushStream(s.id);batch=null;}
    const {content,reasoning,...metadata}=step;
    if(batch){batch.payload.step=metadata;batch.payload.delta.content+=delta.content;batch.payload.delta.reasoning+=delta.reasoning;batch.payload.delta.revision=delta.revision;}
    else{
      const payload={id:s.id,chatKey:s.chatKey,step:metadata,delta:{...delta}};
      const timer=setTimeout(()=>flushStream(s.id),50);timer.unref?.();streamBatches.set(s.id,{timer,payload});
    }
  }

  function recordFinished(s, previousAccountedUsage) {
    if (typeof onFinishedSession !== 'function') return;
    // 今日/遥测的累计可以先成功；日档失败时仍需记住最初基线，重启补写不能从较新的 accountedUsage 起算。
    s.usageArchiveBaseline ??= structuredClone(previousAccountedUsage);
    const saved = () => { unarchived.delete(s.id); delete s.usageArchiveBaseline; };
    const failed = (error) => {
      if (byId.get(s.id) === s) unarchived.add(s.id);
      log.warn?.(`[sessions] 写入历史用量失败：${error?.message ?? '日档未保存'}`);
    };
    try {
      const result = onFinishedSession(s, s.usageArchiveBaseline);
      if (result && typeof result.then === 'function') {
        if (byId.get(s.id) === s) unarchived.add(s.id);
        result.then((result) => result === false ? failed() : saved(), failed);
      } else if (result === false) failed();
      else saved();
    } catch (err) {
      failed(err);
    }
  }

  function trimCompleted() {
    const configured = keepOverride ?? (typeof keepSessionFiles === 'function' ? keepSessionFiles() : keepSessionFiles);
    const limit = Math.max(0, Math.floor(Number(configured) || 0));
    if (!limit) return;
    const completed = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        if (unarchived.has(id)) continue;
        const session = byId.get(id) ?? readJsonSafe(fileOf(id), null);
        if (session?.id !== id || ['running', 'waiting'].includes(session.status)) continue;
        completed.push(session);
      }
    } catch (err) { log.warn?.(`[sessions] 扫描保留上限失败：${err?.message}`); return; }
    completed.sort((a, b) => (Number(b.endedAt) || Number(b.startedAt) || 0) - (Number(a.endedAt) || Number(a.startedAt) || 0) || (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    for (const session of completed.slice(limit)) removeSession(session.id);
  }

  function writeIndexCacheSoon() {
    indexDirty = true;
    if (indexCacheTimer) return;
    indexCacheTimer = setTimeout(() => {
      indexCacheTimer = null;
      if (!indexDirty) return;
      indexDirty = false;
      const entries = [...byId.values()]
        .filter((s) => s.status !== 'running' && s.status !== 'waiting') // 运行中不进缓存
        .map(summary);
      try {
        atomicWrite(path.join(dataDir, 'session-index-cache.json'), { version: 1, savedAt: Date.now(), entries });
      } catch { /* 缓存失败不影响功能 */ }
    }, INDEX_DEBOUNCE_MS);
    if (typeof indexCacheTimer.unref === 'function') indexCacheTimer.unref();
  }

  function bumpTodayUsage(s) {
    // 会话终态落盘的同一时刻（12-data §3.7）：零消耗会话不计 runs
    if (s.status === 'running' || s.status === 'waiting') return;
    const u = s.usage ?? {};
    const accounted = s.accountedUsage ?? {};
    const zero = !u.calls && !u.totalTokens;
    if (zero) return;
    const file = path.join(dataDir, 'usage-today.json');
    const cur = readJsonSafe(file, null);
    const day = localDayKey();
    const acc = cur && cur.dayKey === day ? cur
      : { dayKey: day, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens']) acc[key] += Math.max(0, (Number(u[key]) || 0) - (Number(accounted[key]) || 0));
    if (!accounted.counted) acc.runs += 1;
    acc.webSearchCount = (acc.webSearchCount ?? 0) + Math.max(0, (Number(s.webSearchCount) || 0) - (Number(accounted.webSearchCount) || 0));
    try {
      const tmp = path.join(dataDir, 'usage-today.json.tmp'); // 固定 tmp 名（12-data §3.7 兼容注意）
      fs.writeFileSync(tmp, JSON.stringify(acc), 'utf8');
      fs.renameSync(tmp, file);
      s.accountedUsage = { ...u, webSearchCount: Number(s.webSearchCount) || 0, counted: true };
    } catch { /* 尽力 */ }
  }

  function create(chatKey, { trigger = null, waitUntil = null, background = false } = {}) {
    const s = {
      id: newSessionId(),
      chatKey, startedAt: Date.now(), endedAt: null,
      status: waitUntil ? 'waiting' : 'running',
      messages: [], sent: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
      trigger, promptChars: 0, rounds: 0, waitUntil, background: background === true,
      excludedTools: [], contextReason: null, vendor: null, model: null,
      error: null, finishReason: null, promptAnchorState: null, promptAnchorMode: null,
      accountedUsage: {}, accountedTotals: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} },
    };
    byId.set(s.id, s);
    persistNow(s); // create 立即写（12-data §3.5）
    bus?.emit('session.start', summary(s));
    return s;
  }

  /** 运行中节流写（2s）；其它状态立即写。 */
  function update(s, patch) {
    flushStream(s.id);
    // 旧终态文件已经计过账；重试沿用同一 ID 时，仅累加新尝试的差值。
    if (!['running', 'waiting'].includes(s.status)) {
      s.accountedUsage ??= { ...s.usage, webSearchCount: Number(s.webSearchCount) || 0, counted: Boolean(s.usage?.calls || s.usage?.totalTokens) };
      s.accountedTotals ??= sessionTelemetryTotals(s);
    }
    const previousAccountedUsage = { ...structuredClone(s.accountedUsage ?? {}), toolCounts: { ...(s.accountedTotals?.toolCounts ?? {}) } };
    if (patch) Object.assign(s, patch);
    if (byId.get(s.id) !== s) {
      // 中止后的模型响应仍可能带来新增用量，但删除/保留清理不能被晚到回写撤销。
      cancelPersist(s.id);
      if (!['running', 'waiting'].includes(s.status)) {
        bumpTodayUsage(s);
        bumpTelemetryTotals(s);
        recordFinished(s, previousAccountedUsage);
      }
      return s;
    }
    if (s.status === 'running' || s.status === 'waiting') {
      schedulePersist(s);
    } else {
      cancelPersist(s.id);
      bumpTodayUsage(s);
      bumpTelemetryTotals(s);
      recordFinished(s, previousAccountedUsage);
      persistNow(s);
    }
    bus?.emit('session.update', summary(s));
    return s;
  }

  function finish(id, status, extra = {}) {
    const s = byId.get(id);
    if (!s) return null;
    flushStream(id);
    // 终态只记一次：重复 finish（例如重试后再收尾）不得二次累加遥测/今日用量。
    if (!['running', 'waiting'].includes(s.status)) return s;
    const previousAccountedUsage = { ...structuredClone(s.accountedUsage ?? {}), toolCounts: { ...(s.accountedTotals?.toolCounts ?? {}) } };
    cancelPersist(s.id);
    s.status = status;
    s.endedAt = Date.now();
    Object.assign(s, extra);
    delete s._throttleTimer;
    bumpTodayUsage(s);    // 同一时刻汇总今日用量
    bumpTelemetryTotals(s); // 同一时刻累加匿名遥测累计（SPEC C-tel-01）
    recordFinished(s, previousAccountedUsage); // 日档必须先于会话留档清理；晚到终态更新也会补写。
    persistNow(s);        // finish 立即写，包含已累计快照与失败日档基线供重试/重启使用
    writeIndexCacheSoon();
    bus?.emit('session.end', summary(s));
    trimCompleted();
    return s;
  }

  /** 匿名遥测累计：读缓存 → 累加本会话 → 原子写回（与 bumpTodayUsage 同构，增量而非全量重算）。 */
  function bumpTelemetryTotals(s) {
    try {
      const file = path.join(dataDir, 'telemetry-totals.json');
      const cached = readJsonSafe(file, null);
      const validCache = cached && typeof cached === 'object' && !Array.isArray(cached)
        && ['calls', 'promptTokens', 'completionTokens', 'totalTokens'].every((key) => Number.isFinite(cached[key]) && cached[key] >= 0)
        && cached.toolCounts && typeof cached.toolCounts === 'object' && !Array.isArray(cached.toolCounts)
        && Object.values(cached.toolCounts).every((count) => Number.isFinite(count) && count >= 0);
      const totals = validCache
        ? { calls: Number(cached.calls) || 0, promptTokens: Number(cached.promptTokens) || 0, completionTokens: Number(cached.completionTokens) || 0, totalTokens: Number(cached.totalTokens) || 0, toolCounts: { ...(cached.toolCounts || {}) } }
        : { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
      if (!validCache) {
        // 用已记账快照恢复，而非把刚结束的当前会话全量计入再加一次差值。
        const records = new Map(byId);
        records.set(s.id, s);
        for (const name of fs.readdirSync(dir)) {
          if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
          const id = name.slice(0, -5);
          if (!records.has(id)) {
            const record = readJsonSafe(fileOf(id), null);
            if (record?.id === id) records.set(id, record);
          }
        }
        for (const record of records.values()) {
          const previous = record.accountedTotals ?? (record !== s && !['running', 'waiting'].includes(record.status) ? sessionTelemetryTotals(record) : null);
          if (!previous) continue;
          for (const key of ['calls', 'promptTokens', 'completionTokens', 'totalTokens']) totals[key] += Number(previous[key]) || 0;
          for (const [tool, count] of Object.entries(previous.toolCounts ?? {})) totals.toolCounts[tool] = (totals.toolCounts[tool] ?? 0) + (Number(count) || 0);
        }
      }
      for (const key of ['calls', 'promptTokens', 'completionTokens', 'totalTokens']) totals[key] = Math.max(totals[key], Number(totalsFloor?.[key]) || 0);
      for (const [tool, count] of Object.entries(totalsFloor?.toolCounts ?? {})) totals.toolCounts[tool] = Math.max(Number(totals.toolCounts[tool]) || 0, count);
      const item = sessionTelemetryTotals(s);
      const accounted = s.accountedTotals ?? {};
      for (const key of ['calls', 'promptTokens', 'completionTokens', 'totalTokens']) totals[key] += Math.max(0, item[key] - (Number(accounted[key]) || 0));
      for (const [tool, count] of Object.entries(item.toolCounts)) {
        totals.toolCounts[tool] = (Number(totals.toolCounts[tool]) || 0) + Math.max(0, count - (Number(accounted.toolCounts?.[tool]) || 0));
      }
      atomicWrite(file, totals);
      totalsFloor = totals;
      s.accountedTotals = item;
    } catch (err) {
      log.warn?.(`[sessions] 写入遥测累计失败：${err?.message}`);
    }
  }

  /** peek 不克隆：SSE 富载荷必须随推（sent/finishReason/error/endedAt）——否则"已发送"徽标要等轮询。 */
  function peek(id) { return byId.get(id) ?? null; }
  /** get 克隆：调用方改副本不丢活对象更新（§6.4 实现细节事故注）。 */
  function get(id) {
    const s = byId.get(id);
    if (s) return structuredClone(s);
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) return null;
    const disk = readJsonSafe(fileOf(id), null);
    return disk?.id === id ? structuredClone(disk) : null;
  }

  function current(chatKey) {
    // 当前活跃（waiting/running）会话——返回活对象（§6.4：复用等待会话必须用活对象）
    for (const s of byId.values()) {
      if (!s.background && s.chatKey === chatKey && (s.status === 'waiting' || s.status === 'running')) return s;
    }
    return null;
  }

  function running() {
    return [...byId.values()].filter((s) => s.status === 'running' && !s.background);
  }

  function listSummaries() {
    // 磁盘 + 内存合并（磁盘为准先读索引缓存，快路径）
    const out = [];
    const seen = new Set();
    for (const s of byId.values()) {
      out.push(summary(s));
      seen.add(s.id);
    }
    if (reconcileComplete) return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const cache = readJsonSafe(path.join(dataDir, 'session-index-cache.json'), null);
    if (cache && cache.version === 1 && Array.isArray(cache.entries)) {
      for (const e of cache.entries) {
        if (e?.id && !seen.has(e.id) && fs.existsSync(fileOf(e.id))) out.push(e);
      }
    } else {
      // 慢路径：扫盘（缓存丢了自动重建，只影响速度）
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const id = f.slice(0, -5);
          if (seen.has(id)) continue;
          const s = readJsonSafe(fileOf(id), null);
          if (s?.id) { out.push(summary(s)); seen.add(id); }
        }
      } catch { /* 空目录 */ }
    }
    return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  function reconcileInBackground() {
    // 僵尸回收：上次进程退出遗留的 waiting/running 磁盘会话 → aborted + abortedOnBoot（12-data §3.5）
    if (reconcileTimer) return;
    let files, cursor = 0;
    const batch = () => {
      reconcileTimer = null;
      try {
        files ??= fs.readdirSync(dir).filter(file => file.endsWith('.json'));
        const started = Date.now(); let processed = 0;
        while (cursor < files.length && processed++ < 8 && Date.now() - started < 8) {
          const f = files[cursor++];
          if (!f.endsWith('.json')) continue;
          const id = f.slice(0, -5);
          if (byId.has(id)) continue;
          const s = readJsonSafe(fileOf(id), null);
          if (s?.id && (s.status === 'waiting' || s.status === 'running')) {
            s.status = 'aborted';
            s.endedAt = Date.now();
            s.abortedOnBoot = true;
            s.error = '进程退出遗留，启动时改判中止';
            try { fs.writeFileSync(fileOf(id), JSON.stringify(s), 'utf8'); } catch { /* 裸写尽力（12-data：僵尸写回非原子） */ }
          }
          if (s?.id) {
            byId.set(id, s); // 载入内存供列表展示；迁移旧留档必须先固化历史再允许保留清理。
            if (!['running', 'waiting'].includes(s.status)) {
              const previous = s.accountedUsage ?? { ...s.usage, counted: Boolean(s.usage?.calls || s.usage?.totalTokens), webSearchCount: Number(s.webSearchCount) || 0 };
              const baseline = s.usageArchiveBaseline;
              recordFinished(s, { ...previous, toolCounts: (s.accountedTotals ?? sessionTelemetryTotals(s)).toolCounts });
              if (typeof onFinishedSession === 'function' && s.usageArchiveBaseline !== baseline) persistNow(s);
            }
          }
        }
      } catch { /* 空目录 */ }
      if (files && cursor < files.length) reconcileTimer = setImmediate(batch);
      else reconcileComplete = true;
    };
    reconcileTimer = setImmediate(batch);
  }

  function todayUsage(dayKey = localDayKey()) {
    // 12-data §3.7：先读本文件，再叠加内存中运行中的会话
    const file = path.join(dataDir, 'usage-today.json');
    const cur = readJsonSafe(file, null);
    const acc = cur && cur.dayKey === dayKey
      ? { ...cur }
      : { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    for (const s of byId.values()) {
      if (s.status === 'running' || s.status === 'waiting') {
        for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens']) {
          acc[key] += Math.max(0, (Number(s.usage?.[key]) || 0) - (Number(s.accountedUsage?.[key]) || 0));
        }
      }
    }
    return acc;
  }

  function removeSession(id, { allowPending = false, eventStatus = 'deleted' } = {}) {
    const s = byId.get(id) ?? get(id);
    if (!s) return false;
    if (!allowPending && (s.status === 'running' || s.status === 'waiting')) return false;
    flushStream(id);
    cancelPersist(id);
    byId.delete(id);
    unarchived.delete(id);
    try { fs.unlinkSync(fileOf(id)); } catch { /* best effort */ }
    writeIndexCacheSoon();
    // summary 的旧终态不得覆盖控制事件的 deleted/discarded 状态。
    bus?.emit('session.end', { ...summary(s), sessionId: id, status: eventStatus, [eventStatus]: true });
    return true;
  }

  function deleteSession(id) {
    return removeSession(id);
  }

  /** waiting 会话取消后不保留磁盘记录或内存记录；SSE 仅通知 UI 摘除该条。 */
  function discardSession(id) {
    return removeSession(id, { allowPending: true, eventStatus: 'discarded' });
  }

  function clearFinished() {
    const ids = new Set([...byId.values()].filter((s) => !['running', 'waiting'].includes(s.status)).map((s) => s.id));
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        if (ids.has(id)) continue;
        const s = readJsonSafe(fileOf(id), null);
        if (s?.id && !['running', 'waiting'].includes(s.status)) ids.add(s.id);
      }
    } catch { /* empty or unavailable */ }
    let count = 0;
    for (const id of ids) if (deleteSession(id)) count++;
    // 逐条 deleted 事件保证详情面板即时摘除；聚合事件驱动列表批量刷新。
    bus?.emit('session.end', { status: 'cleared', removed: count });
    return count;
  }

  function flushIndexCache() {
    if (indexCacheTimer) { clearTimeout(indexCacheTimer); indexCacheTimer = null; }
    if (!indexDirty) return;
    indexDirty = false;
    const entries = [...byId.values()]
      .filter((s) => s.status !== 'running' && s.status !== 'waiting')
      .map(summary);
    try {
      atomicWrite(path.join(dataDir, 'session-index-cache.json'), { version: 1, savedAt: Date.now(), entries });
    } catch { /* 尽力 */ }
  }

  return {
    create, update, stream, finish, peek, get, current, running,
    listSummaries, reconcileInBackground, todayUsage, flushIndexCache,
    stop() {
      for(const id of [...streamBatches.keys()])flushStream(id);
      if (reconcileTimer) { clearImmediate(reconcileTimer); reconcileTimer = null; }
      for (const id of [...persistTimers.keys()]) {
        cancelPersist(id);
        const session = byId.get(id);
        if (session) persistNow(session);
      }
      flushIndexCache();
    },
    delete: deleteSession, discard: discardSession, clearFinished,
    setKeepFiles(value) { keepOverride = value == null ? undefined : Math.max(0, Math.floor(Number(value) || 0)); trimCompleted(); },
  };
}
