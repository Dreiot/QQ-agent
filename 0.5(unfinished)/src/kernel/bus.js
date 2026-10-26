// 进程内事件总线：强类型事件名（白名单），监听器异常不打崩。
// 出处：DSH §3.1 模块 3；SSE 事件类型全表 SPEC §9.2；插件可订阅的白名单事件 DSH §4.2。
const NAMES = new Set([
  // 日志与生命周期
  'log', 'server.ready', 'plugin.loaded', 'plugin.unloaded', 'plugin.error',
  // 消息链路（M1 接线）
  'message.in', 'message.out', 'message.sent', 'wake',
  // 会话与存档（M1）
  'session.start', 'session.update', 'session.delta', 'session.end', 'chat.update', 'memory.update',
  // 传输与外部进程状态（M1/M4）
  'onebot.status', 'transport.status', 'local-protocols', 'protocol-login', 'accounts', // 工具与权限
  'tool.call', 'tool.result', 'permission.ask', 'permission.decision',
  // LLM / 遥测 / 其它周期行为
  'llm.call', 'telemetry.tick', 'reminder.fire', 'market.install', 'vision.scan', 'feedback', 'status',
  // 周期同步结果（价格源 / 云端屏蔽名单，2026-10-06）：内核 emit，面板与日志可观察
  'price-update', 'blocklist-sync', 'management.update',
]);

// 插件可订阅的子集：只读观察类事件。写操作类事件（message.out 等）不开放给插件——
// 插件的出站动作必须走 ctx.send（内核发送队列 + 权限闸），不得旁路监听总线自行触发。
const PLUGIN_SUBSCRIBABLE = new Set([
  'log', 'server.ready', 'plugin.loaded', 'plugin.unloaded',
  'message.in', 'session.start', 'session.update', 'session.end', 'chat.update',
  'onebot.status', 'transport.status', 'reminder.fire', 'feedback',
]);

export class Bus {
  constructor(log) {
    this._log = log ?? console;
    this._listeners = new Map(); // name -> Set<fn>
  }

  // internal=true：内核内部订阅（校验 NAMES 全集）；默认（插件经 ctx.events.on）：只允许
  // PLUGIN_SUBSCRIBABLE 白名单（写操作类事件不开放给插件——出站动作必须走 ctx.send + 权限闸）
  on(name, fn, { internal = false } = {}) {
    const allowed = internal ? NAMES.has(name) : PLUGIN_SUBSCRIBABLE.has(name);
    if (!allowed) {
      this._log.warn?.(`[bus] 拒绝订阅事件 "${name}"（${internal ? '未注册事件名' : '写操作类事件不对插件开放'}）`);
      return () => {};
    }
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(fn);
    return () => this._listeners.get(name)?.delete(fn);
  }

  once(name, fn, opts) {
    const off = this.on(name, (payload) => { off(); fn(payload); }, opts);
    return off;
  }

  emit(name, payload) {
    if (!NAMES.has(name)) {
      // 白名单外 = 事件名打错字，记 error 不抛（打崩主流程比丢一条事件更糟）
      this._log.error?.(`[bus] 试图 emit 未注册事件 "${name}"，已丢弃`);
      return false;
    }
    const set = this._listeners.get(name);
    if (!set || set.size === 0) return true;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        // 监听器异常不打崩（DSH §3.1 模块 3 禁止项）
        this._log.error?.(`[bus] "${name}" 监听器异常：${err?.stack || err}`);
      }
    }
    return true;
  }

  listenerCount(name) {
    return this._listeners.get(name)?.size ?? 0;
  }
}
