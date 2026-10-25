// Owns selected provider instances, not their business implementations.
// Registration, enable/disable, permission changes and provider selection all
// reconcile through the same queue. A stopped generation cannot publish events.
const SERVICE_EVENTS = new Set(['transport.status', 'blocklist-sync', 'telemetry.tick']);
export function createServiceHost({ capability, config, bus, log = console, authorize = async () => true, contextFor = (_name, context) => context, onState = () => {}, runInHostContext = action => action() } = {}) {
  const instances = new Map();
  const errors = new Map();
  const pending = new Set();
  // Host-owned connection switches can suspend one service without stopping
  // the console, scheduler or the other selected providers.
  const disabled = new Set();
  const stopFailures = [];
  let running = false, epoch = 0, queue = Promise.resolve();
  const stops = new Set();

  async function dispose(entry) {
    if (!entry) return;
    if (!entry.disposed) {
      entry.disposed = true;
      entry.controller.abort(new Error('能力提供者已停止'));
      if (instances.get(entry.name) === entry) {
        instances.delete(entry.name);
        onState(entry.name, null);
      }
    }
    if (!entry.instance || entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = Promise.resolve().then(() => runInHostContext(() => entry.instance.stop?.())).catch((error) => {
      entry.stopError = error;
      stopFailures.push(error);
      errors.set(entry.name, String(error?.message ?? error));
      log.warn?.(`[services] ${entry.name}/${entry.ownerId} 停止失败：${error?.message ?? error}`);
    });
    return entry.stopPromise;
  }

  function trackDispose(entry) {
    const stop = dispose(entry);
    stops.add(stop);
    stop.then(() => stops.delete(stop), () => stops.delete(stop));
    return stop;
  }

  function awaitActive(entry, operation) {
    return new Promise((resolve, reject) => {
      const signal = entry.controller.signal;
      const abort = () => reject(signal.reason ?? new Error('能力提供者已停止'));
      if (signal.aborted) { abort(); Promise.resolve(operation).catch(() => {}); return; }
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  const selected = (name) => capability.providers(name)[0] ?? null;
  const managed = (name, item) => capability.options(name, item?.ownerId)?.lifecycle === true;
  function current(entry) {
    const candidate = selected(entry.name);
    return running && !disabled.has(entry.name) && !entry.disposed && !entry.controller.signal.aborted && entry.epoch === epoch
      && candidate?.ownerId === entry.ownerId && candidate.provider === entry.definition
      && (capability.version?.(entry.name, entry.ownerId) ?? null) === entry.version;
  }

  async function reconcile() {
    if (!running) return;
    const generation = epoch;
    for (const entry of [...instances.values()]) {
      if (!current(entry)) { await dispose(entry); continue; }
      try {
        if (!await awaitActive(entry, authorize(entry.name, { ownerId: entry.ownerId, provider: entry.definition }, { recheck: true }))) await dispose(entry);
      } catch (error) {
        if (current(entry)) throw error;
        await dispose(entry);
      }
    }
    for (const name of capability.names()) {
      if (!running || generation !== epoch) return;
      const candidate = selected(name);
      if (disabled.has(name) || !candidate || !managed(name, candidate) || instances.has(name)) continue;
      const entry = { name, ownerId: candidate.ownerId, definition: candidate.provider, version: capability.version?.(name, candidate.ownerId) ?? null, controller: new AbortController(), epoch: generation, instance: null, disposed: false, started: false };
      pending.add(entry);
      try {
        if (!await awaitActive(entry, authorize(name, candidate, { recheck: false }))) {
          if (current(entry)) errors.set(name, '能力提供者尚未获得授权');
          await dispose(entry);
          continue;
        }
        if (!current(entry)) { await dispose(entry); continue; }
        const context = contextFor(name, {
          signal: entry.controller.signal,
          current: () => current(entry),
          emit: (event, payload) => { if (SERVICE_EVENTS.has(event) && current(entry)) bus?.emit(event, structuredClone(payload)); },
        });
        const creation = Promise.resolve().then(() => runInHostContext(() => typeof candidate.provider?.create === 'function'
          ? candidate.provider.create(context) : candidate.provider)).then((instance) => {
          entry.instance = instance;
          // A factory may ignore cancellation. Its eventual result is still
          // owned here, but it can never replace state from a newer instance.
          if (!current(entry)) void trackDispose(entry);
          return instance;
        });
        await awaitActive(entry, creation);
        if (!current(entry)) { await dispose(entry); continue; }
        instances.set(name, entry);
        onState(name, entry.instance);
        await awaitActive(entry, runInHostContext(() => entry.instance?.start?.({ ...context, signal: entry.controller.signal })));
        if (!current(entry)) { await dispose(entry); continue; }
        entry.started = true;
        errors.delete(name);
      } catch (error) {
        if (!current(entry)) { await dispose(entry); continue; }
        errors.set(name, String(error?.message ?? error));
        await dispose(entry);
        log.error?.(`[services] ${name}/${candidate.ownerId} 启动失败：${error?.message ?? error}`);
        if (name === 'transport.provider') throw error;
      } finally { pending.delete(entry); }
    }
  }

  function refresh() {
    if (!running) return Promise.resolve();
    const result = queue.then(reconcile);
    queue = result.catch((error) => { log.warn?.(`[services] 更新失败：${error?.message ?? error}`); });
    return result;
  }
  function cancelStale() {
    for (const entry of new Set([...instances.values(), ...pending])) {
      if (!current(entry)) void trackDispose(entry);
    }
  }
  const wake = () => { cancelStale(); void refresh().catch(() => {}); };
  const subscriptions = [];
  let subscribed = false;
  function permissionChanged(event) {
    // Routine authorization checks also emit audit records. Only decisions that
    // change authorization state should reconcile providers again.
    if (event?.detail !== '管理员显式决定' && (!event?.resolution || event.resolution === 'pending')) return;
    // Recheck outside the reconciliation queue: start() may still be waiting on
    // this provider when an administrator revokes its authorization.
    const affected = [...new Set([...instances.values(), ...pending])].filter((entry) => entry.ownerId === event.pluginId);
    if (!affected.length) { wake(); return; }
    void Promise.all(affected.map(async (entry) => {
      if (!current(entry)) { await trackDispose(entry); return; }
      try {
        if (!await awaitActive(entry, authorize(entry.name, { ownerId: entry.ownerId, provider: entry.definition }, { recheck: true }))) await trackDispose(entry);
      } catch (error) { if (current(entry)) throw error; }
    })).catch((error) => log.warn?.(`[services] 授权更新失败：${error?.message ?? error}`)).finally(wake);
  }
  function subscribe() {
    if (subscribed) return;
    subscribed = true;
    const keep = off => { if (typeof off === 'function') subscriptions.push(off); };
    try {
      keep(capability.onChange?.(wake));
      keep(config.onChange?.(wake));
      for (const event of ['plugin.loaded', 'plugin.unloaded', 'plugin.error']) keep(bus?.on(event, wake, { internal: true }));
      keep(bus?.on('permission.decision', permissionChanged, { internal: true }));
    } catch (error) { unsubscribe(); throw error; }
  }
  function unsubscribe() {
    subscribed = false;
    for (const off of subscriptions.splice(0).reverse()) {
      try { off(); } catch (error) { stopFailures.push(error); }
    }
  }
  subscribe();

  function invalidate() {
    running = false; epoch++;
    for (const entry of new Set([...instances.values(), ...pending])) void trackDispose(entry);
  }
  return {
    async start() { if (!running) { subscribe(); running = true; epoch++; } await refresh(); },
    async setEnabled(name, enabled) {
      if (typeof name !== 'string' || !name || typeof enabled !== 'boolean') throw new TypeError('服务开关参数无效');
      if (enabled) { disabled.delete(name); await refresh(); return; }
      // Fence synchronous get/token/event calls before awaiting any stop. This
      // also cancels a provider whose factory or start is still pending.
      disabled.add(name);
      const entries = [...new Set([...instances.values(), ...pending])].filter(entry => entry.name === name);
      await Promise.all(entries.map(trackDispose));
      const failures = entries.map(entry => entry.stopError).filter(Boolean);
      if (failures.length) throw new AggregateError(failures, '所选服务未能完全停止');
    },
    refresh,
    invalidate,
    async stop() {
      unsubscribe();
      invalidate(); await Promise.allSettled([...stops]);
      const failures = stopFailures.splice(0);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, `服务停止失败：${failures.map((error) => error?.message ?? error).join('；')}`);
    },
    idle: () => queue,
    get(name) {
      if (disabled.has(name)) return undefined;
      const item = selected(name);
      if (!item) return undefined;
      if (!managed(name, item)) return item.provider;
      const entry = instances.get(name);
      return entry && current(entry) ? entry.instance : undefined;
    },
    // Host-only identity for completion guards. This is never part of a plugin
    // facet and changes even when an owner re-registers the same definition.
    token(name) {
      if (disabled.has(name)) return null;
      const item = selected(name);
      if (!item) return null;
      if (!managed(name, item)) return capability.version?.(name, item.ownerId) ?? item.provider;
      const entry = instances.get(name);
      return entry && current(entry) ? entry : null;
    },
    status: () => capability.names().filter((name) => capability.providers(name).some((item) => managed(name, item))).map((name) => ({
      name, ownerId: selected(name)?.ownerId ?? null, running: Boolean(instances.get(name)?.started && current(instances.get(name))), error: errors.get(name) ?? null,
    })),
  };
}

// Resolve on every call: callers never keep a stopped provider's method handle.
export function serviceFacade(resolve, methods, { label = '服务', properties = [] } = {}) {
  const facade = {};
  for (const name of methods) facade[name] = (...args) => {
    const current = resolve();
    if (typeof current?.[name] !== 'function') throw Object.assign(new Error(`${label}能力未就绪：${name}`), { code: 'CAPABILITY_MISSING', status: 503, expose: true });
    return current[name](...args);
  };
  for (const name of properties) Object.defineProperty(facade, name, { enumerable: true, get: () => resolve()?.[name] });
  return Object.freeze(facade);
}
