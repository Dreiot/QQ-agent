// 内核装配：把内核模块连成可启动的整体。
// M0 底座 + M1 消息链路（transport/ingest/wake/orchestrator/prompt/llm/send/agent-runner/memory/sessions）。
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, resolveDataDir, resolveProfile } from './env.js';
import { sanitizeLlmRequestNotice } from './sdk-services.js';
import { resolveRequestApiKey } from './llm.js';
import { createCompositionLifecycle } from './composition-lifecycle.js';
import { createResetGuards } from './reset-guards.js';
import { defaultComponents } from '../../bundled/runtime-defaults/components.js';

const VERSION = '0.5.0';
const APP_ID = 'cn.kondius.qq-agent'; // 沿用（覆盖安装检测/备份还原/更新提示依赖，DSH §0）

export function createKernel({
  env = process.env,
  appRoot = APP_ROOT,
  fetchImpl = null,
  headless = true,
  transport: injectedTransport = null,
  transportFactory = null,
  priceUpdates: injectedPriceUpdates = null,
  communityMarket: injectedCommunityMarket = null,
  components: selectedComponents = {},
  composition = null,
  lifecycle: suppliedLifecycle = null,
} = {}) {
  // Bind trusted startup choices once. Disk plugin hot reload continues through
  // the existing capability/service host and does not mutate this object.
  const components = Object.freeze({ ...defaultComponents, ...selectedComponents });
  for (const [name, implementation] of Object.entries(components)) {
    if (typeof implementation !== 'function') throw new TypeError(`运行时组件 ${name} 必须是函数`);
  }
  const lifecycle = suppliedLifecycle ?? createCompositionLifecycle();
  let businessSealed = false, resetCoordinator, quiescingConsole = false, accounts=null,accountGateway=null;
  const guards = createResetGuards({ isSealed: () => businessSealed, canConfigure: () => !resetCoordinator || resetCoordinator.canConfigure() });
  const resourceDisposers = new Map();
  const cleanupMethods = {
    'runtime.capability': 'close', 'runtime.permissions': 'close', 'runtime.scheduler': 'stop',
    'runtime.plugins': 'stopAll', 'runtime.services': 'stop', 'runtime.http': 'close',
    'data.sessions': 'stop', 'core.orchestrator': 'stop', 'console.sse': 'close', 'runtime.localProtocols': 'close', 'runtime.protocolLogin': 'close',
    'runtime.accounts': 'close', 'runtime.accountGateway': 'close', 'core.management':'close',
  };
  const release = (name, ...args) => resourceDisposers.get(name)?.(...args);
  const construct = (name, options) => {
    const value = components[name]({ ...options, components, composition, lifecycle });
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError(`组件 ${name} 必须同步构造；异步装配请替换 runtime.kernel`);
    }
    const method = cleanupMethods[name];
    if (method && typeof value?.[method] === 'function') {
      let disposal, unregister;
      const dispose = (...args) => {
        if (!disposal) {
          unregister?.();
          disposal = Promise.resolve().then(() => value[method](...args));
        }
        return disposal;
      };
      resourceDisposers.set(name, dispose);
      unregister = lifecycle.onStop(() => {
        // Reset retains HTTP and SSE until the response has reached the shell.
        // Final stop still calls their same one-shot disposers explicitly.
        if (quiescingConsole && ['runtime.http', 'console.sse'].includes(name)) return;
        return dispose();
      });
    }
    return value;
  };
  try {
  const serviceFacade = components['runtime.serviceFacade'];
  const profile = resolveProfile(env);
  const dataDir = resolveDataDir(env, appRoot);
  const extensionRoot=env.QQ_AGENT_EXTENSION_ROOT?path.resolve(env.QQ_AGENT_EXTENSION_ROOT):appRoot;
  const runtimeCacheRoot=env.QQ_AGENT_RUNTIME_CACHE_ROOT?path.resolve(env.QQ_AGENT_RUNTIME_CACHE_ROOT):undefined;
  const personaText = construct('runtime.persona.text', { appRoot });

  const defaults = construct('runtime.config.defaults', { portOffset: profile.portOffset, personaText });
  // Finish reset before logging, config loading, migration or cached stores can
  // open/recreate anything in the old data directory.
  construct('runtime.reset.complete', { dataDir, defaults });
  const logPolicy = construct('runtime.log.policy', { dataDir });
  const log = construct('runtime.logger', { dataDir, mirrorConsole: true, policy: logPolicy });
  const bus = construct('runtime.bus', { log });
  log.setBus?.(bus);
  // A launch override belongs to this process, never to the persisted defaults.
  // Match HTTP's port contract: 0 requests a system-assigned port.
  const portOverride = String(env.QQ_AGENT_PORT ?? '').trim();
  const parsedPort = Number(portOverride);
  const envPort = portOverride && Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : null;
  if (portOverride && envPort === null) log.warn('[app] 忽略非法 QQ_AGENT_PORT：端口必须为 0–65535 的整数；沿用已保存的端口或 PROFILE 默认值');
  const config = guards.config(construct('runtime.config', { dataDir, defaults, log }));
  config.load();
  const cfg = () => config.get();
  const localProtocols = construct('runtime.localProtocols', { appRoot, dataDir, config, bus, log, env });
  const protocolLogin = construct('runtime.protocolLogin', { config, localProtocols, bus, fetchImpl,
    getAccounts:async()=>accounts?accounts.snapshot():{accounts:[]},
    onVerifiedAccount:async input=>{
      if(!accounts)return null;
      const workspace=await accounts.registerConnection(input);
      if(workspace.workspaceId==='primary')return workspace;
      // A listening worker is not yet proof of its own authenticated transport.
      for(let attempt=0;attempt<80;attempt++){
        const row=(await accounts.snapshot()).accounts.find(item=>item.id===workspace.workspaceId);
        if(row?.connected&&row.accountId===input.accountId)return workspace;
        if(row?.status==='error'||row?.status==='stopped')break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Object.assign(new Error('账号工作区已创建，连接尚未就绪，请在账号管理中检查。'),{status:503,expose:true});
    } });

  const capability = construct('runtime.capability', { log, selection: () => cfg().extensions?.providers ?? {},
    subscribeSelection: listener => config.onChange?.(listener) });
  const permissions = construct('runtime.permissions', { log, bus, headless, dataDir });
  const registry = construct('runtime.tools', { log, bus, permissions, capabilities: capability });
  const scheduler = construct('runtime.scheduler', { log });
  const storage = guards.storage(construct('runtime.storage', { dataDir, log }));
  const priceUpdates = injectedPriceUpdates ?? construct('runtime.priceUpdates', { dataDir, config, version: VERSION });
  const usageDays = construct('data.usage', { dataDir, log, costFor: (session) => components['console.usageCost'](session.usage ?? {}, session.model, session.startedAt, cfg(), { resolveModelPrice: (model, current) => priceUpdates.resolve?.(model, current) ?? null }) });

  // ---- 数据仓 ----
  const store = guards.methods(construct('data.messages', { dataDir, log, maxMessagesPerChat: () => cfg().store?.maxMessagesPerChat ?? 0 }),
    ['appendIncoming', 'appendSelf', 'markRecalled', 'updateByMid', 'markEntryRead', 'markAllRead', 'markEntriesUnread', 'markUnreadInWindow', 'removeByLocalIds', 'clearChat']);
  const memory = guards.methods(construct('data.memory', { dataDir, log, cfg }), ['append', 'remove', 'markConsolidated', 'replaceMember', 'removeMember', 'clearChat']);
  const sessions = guards.methods(guards.methods(construct('data.sessions', {
    dataDir, log, bus, keepSessionFiles: () => cfg().store?.keepSessionFiles ?? 0,
    onFinishedSession: (session, previous) => usageDays.record(session, previous),
  }), ['create', 'delete', 'discard', 'clearFinished', 'setKeepFiles']),
  ['update', 'finish', 'flushIndexCache', 'reconcileInBackground', 'stop'], { quiet: true });
  const reminders = guards.methods(construct('data.reminders', { dataDir, log }), ['add', 'markFired', 'cancel', 'updatePendingTexts', 'prune']);
  let services;
  const mediaReader = serviceFacade(() => services?.get('media.reader'), ['image', 'imageParts', 'probe', 'framesAvailable'], { label: '媒体读取' });
  const providerLease = (ownerId, scopes = ['net.outbound']) => {
    if (ownerId === 'kernel') return {isValid:()=>!lifecycle.signal.aborted};
    try {
      const entry=loader.hostEntry(ownerId),fingerprint=entry?.fingerprint;
      if(!entry||entry.status!=='active'||!loader.contentCurrent(ownerId))return {isValid:()=>false};
      const receipts=scopes.map(scope=>permissions.check(ownerId,scope,{
        kind:entry.rootKind==='bundled'?'bundled':'user',fingerprint,notify:false,auditAsk:false,
      }));
      return {isValid:()=>!lifecycle.signal.aborted&&loader.hostEntry(ownerId)===entry
        &&entry.status==='active'&&loader.contentCurrent(ownerId)
        &&receipts.every(receipt=>receipt.decision==='allow'&&receipt.isValid?.()!==false)};
    } catch {return {isValid:()=>false};}
  };
  const stickers = guards.methods(construct('data.stickers', { dataDir, log, capability, cfg, providerLease, mediaReader: () => mediaReader }),
    ['note', 'markUsed', 'collect', 'mergeFromQQ', 'collectIntoQQ', 'renameInQQ', 'removeFromQQ']);
  const serviceLeaseOf = construct('runtime.serviceLease', { services: () => services, capability, providerLease, bus });
  let priceRefreshStop = null;
  let lifecycleGeneration = 0, lifecycleActive = false, lifecycleController = null;
  let startPromise = null, stopPromise = null, running = false;
  let selfId = null;
  let transportStatusSnapshot = { id: 'transport', connected: false, selfId: null, error: null, everConnected: false };
  const transportStatus = (status = {}) => {
    if (status.selfId !== undefined) selfId = status.selfId == null || status.selfId === '' ? null : String(status.selfId);
    transportStatusSnapshot = { ...transportStatusSnapshot, ...status, id: status.id ?? services?.get('transport.provider')?.id ?? 'transport', selfId, error: status.error ?? (status.connected ? null : transportStatusSnapshot.error), everConnected: status.connected === true || transportStatusSnapshot.everConnected };
    bus.emit('transport.status', transportStatusSnapshot);
    bus.emit('onebot.status', transportStatusSnapshot);
  };
  const actionFacade = serviceFacade(() => services?.get('transport.provider')?.actions, ['poke', 'recall', 'getChatInfo', 'getMembers', 'getGroupMemberInfo', 'getForward', 'getVideo', 'getFile', 'getRecord', 'getImage', 'listGroups', 'listFriends', 'getGroupMembers', 'getGroupName', 'getSelfMemberInfo', 'addCustomFace', 'modifyCustomFace', 'deleteCustomFace', 'fetchCustomFaces', 'fetchCustomFaceDetails','getModerationMember','getModerationMembers','moderateGroup'], { label: '协议动作' });
  const transport = serviceFacade(() => services?.get('transport.provider'), ['send', 'toPlatformSegments', 'reconnect'], { label: '传输', properties: ['id', 'selfId', 'selfNickname', 'segmentSupport', 'everConnected'] });
  const currentSelfId = () => transport.selfId === undefined ? selfId : transport.selfId;
  const transportView = Object.freeze({ ...transport, actions: actionFacade,
    get id() { return transport.id; }, get selfId() { return transport.selfId; }, get selfNickname() { return transport.selfNickname; },
    get segmentSupport() { return transport.segmentSupport; }, get everConnected() { return transport.everConnected; },
    status: () => services?.get('transport.provider')?.status?.() ?? transportStatusSnapshot,
  });
  const send = construct('core.send', { transport: transportView, store, log, cfg, bus, mediaReader: () => mediaReader });
  const management=construct('core.management',{config,transport:transportView,send,dataDir,bus,isPaused:()=>orchestrator.isPaused?.()??orchestrator.status?.().paused??false,identityOf:()=>services?.token?.('transport.provider'),log});
  const pick = (target, names, properties = []) => serviceFacade(() => target, names, { properties });
  const memoryAccess = { ...pick(memory, ['append', 'remove', 'query', 'stats', 'markConsolidated', 'lastConsolidatedAt', 'replaceMember', 'removeMember', 'clearChat', 'listFiles']) };
  for (const method of ['append', 'remove', 'replaceMember', 'removeMember', 'clearChat']) {
    memoryAccess[method] = (...args) => {
      const result = memory[method](...args);
      if (result && result.ok !== false && result.deduped !== true) bus.emit('memory.update', { chatKey: args[0] });
      return result;
    };
  }
  Object.freeze(memoryAccess);
  let installZip = null;
  const facets = {
    'host.config': {},
    'host.environment': Object.freeze({ appRoot, dataDir, version: VERSION, profile, ...(extensionRoot!==appRoot?{extensionRoot}:{}) }),
    'host.defaults': Object.freeze({ communityMarket: injectedCommunityMarket }),
    'data.messages': pick(store, ['recent', 'findByMid', 'updateByMid', 'listChats']),
    'data.memory': memoryAccess,
    'data.sessions': pick(sessions, ['create', 'update', 'finish', 'peek', 'get', 'current', 'running', 'listSummaries', 'todayUsage']),
    'data.reminders': pick(reminders, ['add', 'due', 'pending', 'markFired', 'cancel', 'updatePendingTexts', 'prune']),
    'data.stickers': pick(stickers, ['all', 'get', 'list', 'note', 'markUsed', 'collect', 'mergeFromQQ', 'controlledLocal', 'ensureSendable', 'collectIntoQQ', 'syncFromQQ'], ['imagesDir']),
    'core.send': pick(send, ['sendTextBatch', 'sendImage', 'sendSticker', 'sendSegments', 'poke']),
    'transport.actions': actionFacade,
    'media.reader': mediaReader,
    'web.search': serviceFacade(() => services?.get('web.search'), ['search', 'fetchPage', 'lockState'], { label: '联网搜索' }),
    'process.mcp': serviceFacade(() => services?.get('process.mcp'), ['startServer', 'stopAll', 'redactError'], { label: 'MCP进程' }),
    'host.feedback': Object.freeze({ report(payload) { bus.emit('feedback', structuredClone(payload)); return { ok: true }; } }),
    'extensions.state': Object.freeze({
      isActive: (id) => loader.isActive(id),
      isEnabled: (id) => typeof cfg().skills?.[id]?.enabled === 'boolean' ? cfg().skills[id].enabled : loader.isEnabled(id),
      videoFrames: () => ({
        enabled: cfg().skills?.['video-frames']?.enabled !== false,
        frames: Math.max(1, Math.min(12, Math.floor(Number(cfg().skills?.['video-frames']?.settings?.frames) || 3))),
      }),
    }),
    'extensions.installZip': Object.freeze({ install(...args) { if (!installZip) throw new Error('扩展安装服务未就绪'); return installZip(...args); } }),
    'tools.catalog': Object.freeze({ list: () => registry.list().map(({ id, ownerId, name, category, scopes }) => ({ id, ownerId, name, category, scopes: [...(scopes ?? [])] })) }),
    'runtime.reminders': Object.freeze({ start: (data) => orchestrator.startReminderLoop(data), stop: () => orchestrator.stopReminderLoop() }),
    'llm.client': Object.freeze({ complete(args = {}) {
      const current = cfg();
      let overrides = args.overrides ? { ...args.overrides } : null;
      if (overrides) {
        const selected = Object.hasOwn(overrides,'provider') ? String(overrides.provider ?? '') : current.api?.provider || '';
        const provider = (current.providers ?? []).find((item) => item.id === selected);
        if(selected && !provider)throw Object.assign(new Error('指定的模型渠道不存在'),{status:400});
        const baseUrl = provider?.baseURL ?? provider?.baseUrl ?? current.api?.baseUrl;
        if (overrides.baseUrl && overrides.baseUrl !== baseUrl) throw new Error('模型端点必须来自宿主配置');
        overrides = { ...overrides, provider:selected, baseUrl, apiKey: resolveRequestApiKey({ ...current, api: { ...current.api, provider:selected } }) };
      }
      const onRequest = typeof args.onRequest === 'function' ? notice => args.onRequest(sanitizeLlmRequestNotice(notice)) : undefined;
      return components['llm.complete']({ messages: args.messages, tools: args.tools, signal: args.signal, onRequest, cfg: current, overrides, capabilities: capability, log, components, composition, lifecycle });
    } }),
    'compat04.http': Object.freeze({ async fetchFor(url, init = {}, detail = {}) {
      if (!detail.authorized || !permissions.isCurrent(detail.pluginId, detail.fingerprint) || permissions.status(detail.pluginId, 'net.outbound').override === 'deny') throw new Error('旧插件网络请求未取得有效宿主授权');
      return publicFetch(url, init);
    } }),
  };
  async function publicFetch(url, options = {}) {
    const consumerSignal = sdk.consumerSignal();
    if (consumerSignal) options = { ...options, signal: options.signal && options.signal !== consumerSignal
      ? AbortSignal.any([options.signal, consumerSignal]) : consumerSignal };
    if (fetchImpl) return fetchImpl(url, options);
    const { fetchImpl: _fetch, dnsLookup: _dns, ...controlled } = options;
    const security = cfg().security ?? {};
    const lock = security.browseLock ?? {};
    const dto = await components['runtime.fetch'](url, { ...controlled, expectBinary: true, followRedirects: options.redirect !== 'manual',
      allowPrivate: controlled.allowPrivate === true && security.allowPrivateImageHosts === true,
      ...(lock.enabled ? { browseLocked: true, allowedHosts: lock.hosts ?? [] } : {}),
    });
    const response = new Response([204, 205, 304].includes(dto.status) ? null : dto.body, { status: dto.status, statusText: dto.statusText ?? '', headers: dto.headers });
    Object.defineProperties(response, { url: { value: dto.finalUrl ?? String(url) }, truncated: { value: dto.truncated === true }, redirected: { value: (dto.hops?.length ?? 0) > 1 } });
    return response;
  }
  const sdk = construct('runtime.sdk', { config, permissions, facets, bus, loaderOf: () => loader, resolveProvider: (name) => services?.get(name) });
  const loader = construct('runtime.plugins', {
    log, bus, appRoot, extensionRoot, runtimeCacheRoot, registry, capabilityRegistry: capability, permissions, scheduler, storage, config,
    sdkHost: { ...sdk, send: (chatKey, segments, options) => send.sendSegments(chatKey, segments, options), fetch: publicFetch,
      emit(name, payload, { entry, bundled }) {
        if (!bundled || entry.suspended || entry.controller.signal.aborted || name !== 'blocklist-sync') throw new Error('事件发布超出公共接口范围');
        bus.emit(name, { ok: Boolean(payload?.ok), count: Math.max(0, Number(payload?.count) || 0), error: payload?.error == null ? null : String(payload.error).slice(0, 500) });
      },
    },
  });
  capability._setActiveProbe(loader.isActive.bind(loader));
  for (const [name, provider] of Object.entries(facets)) {
    if (!['media.reader', 'web.search', 'process.mcp'].includes(name)) capability.register(name, 'kernel', provider);
  }
  const leases = new WeakMap();
  services = construct('runtime.services', { capability, config, bus, log,
    runInHostContext: sdk.withoutConsumerContext,
    async authorize(name, candidate, { recheck }) {
      if (candidate.ownerId === 'kernel') return true;
      const entry = loader.hostEntry(candidate.ownerId);
      if (!entry || !loader.isActive(candidate.ownerId)) return false;
      const scopes = capability.options(name, candidate.ownerId).scopes ?? (name === 'memory.consolidate' || name === 'media.reader' || name === 'market.client' || name === 'community.client' || name === 'telemetry.service' ? ['net.outbound'] : []);
      if (recheck) return (leases.get(candidate.provider) ?? []).every((lease) => lease.isValid?.() !== false) && (entry.rootKind === 'bundled' || permissions.isCurrent(candidate.ownerId, entry.fingerprint));
      const allowed = [];
      for (const scope of scopes) {
        if (!entry.manifest.permissions.includes(scope)) return false;
        const verdict = await permissions.checkAsync(candidate.ownerId, scope, { kind: entry.rootKind === 'bundled' ? 'bundled' : 'user', fingerprint: entry.fingerprint });
        if (verdict.decision !== 'allow' || verdict.isValid?.() === false || !loader.isActive(candidate.ownerId)) return false;
        allowed.push(verdict);
      }
      leases.set(candidate.provider, allowed);
      return true;
    },
    contextFor(name, context) {
      if (name !== 'transport.provider') return context;
      return { ...context,
        emit: (event, payload) => {
          if (['transport.status'].includes(event)) context.emit(event, payload);
        },
        onStatus: (status) => { if (context.current()) transportStatus(status); },
        onEvent: (event) => {
          if (!context.current()) return;
          return Promise.resolve().then(() => context.current() && handleProviderEvent(event, context)).catch((error) => {
            if (context.current() && !context.signal.aborted) log.error?.(`[kernel] 事件处理异常：${error?.stack ?? error}`);
          });
        },
      };
    },
    onState(name, instance) {
      if (name !== 'transport.provider') return;
      selfId = instance?.selfId ? String(instance.selfId) : null;
      transportStatusSnapshot = { id: instance?.id ?? 'transport', connected: false, selfId, error: null, everConnected: false };
      transportStatus(transportStatusSnapshot);
    },
  });
  // Constructor injection remains a trusted host test seam. Runtime replacement
  // follows the very same registration and lifecycle path as disk plugins.
  if (injectedTransport || transportFactory) capability.register('transport.provider', 'kernel', {
    create(context) {
      const instance = injectedTransport ?? transportFactory({ ...context, cfg, log });
      instance?.bind?.({ onEvent: context.onEvent, onStatus: context.onStatus });
      return instance;
    },
  }, { lifecycle: true, default: true });

  // ---- ingest ----
  const globalBlocklistOf = async ({ signal } = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const provider = services?.get('community.client'), token = services?.token?.('community.client');
      if (typeof provider?.getBlocklist !== 'function') return null;
      const candidate = capability.providers('community.client')[0], lease = providerLease(candidate?.ownerId, ['net.outbound']);
      if (!lease.isValid()) throw new Error('社区提供者授权已失效');
      const result = await provider.getBlocklist({ signal });
      if (signal?.aborted) throw signal.reason ?? new Error('消息处理已取消');
      if (token === services?.token?.('community.client') && lease.isValid()) return result;
    }
    throw new Error('社区提供者已换代，未使用迟到名单');
  };
  const ingest = construct('core.ingest', {
    cfg, store, bus, log,
    selfIdOf: currentSelfId,
    selfNicknameOf: () => transport.selfNickname,
    globalBlocklistOf,
    nameScopeOf: () => {
      const provider = services?.get('transport.provider');
      return { provider: services?.token?.('transport.provider') ?? provider, account: provider?.actions?.getAccountIdentity?.() ?? provider?.selfId ?? null, signal: lifecycleController?.signal };
    },
    resolveAtName: async (groupId, userId, options) => {
      const provider = services?.get('transport.provider'), token = services?.token?.('transport.provider');
      if (typeof provider?.actions?.getGroupMemberInfo !== 'function') return null;
      const candidate = capability.providers('transport.provider')[0], lease = providerLease(candidate?.ownerId, ['net.outbound']);
      if (!lease.isValid()) throw new Error('群成员查询所属提供者授权已失效');
      const result = await provider.actions.getGroupMemberInfo(groupId, userId, options);
      if (options?.signal?.aborted || token !== services?.token?.('transport.provider') || !lease.isValid()) throw new Error('群成员查询所属提供者或授权已失效');
      return result;
    },
    transcribe: async (seg) => {
      const provider = capability.providers('media.transcribe')[0]?.provider;
      if (!provider) return null;
      try { return await provider(seg); } catch { return null; } // 失败退 [语音] 占位
    },
  });

  // ---- orchestrator ----
  const orchestrator = guards.methods(construct('core.orchestrator', {
    cfg, store, sessions, memory, send, registry, loader, capability, transport: transportView, log, bus, components, globalBlocklistOf, serviceLeaseOf,
    buildToolsFor: (a) => buildToolBundle(a),
    execContextFor: ({ chatKey, session }) => ({
      chatKey, session, send, store, memory, transport: transportView, stickers, reminders, capability, mediaReader,
      cfg: cfg(), botName: cfg().persona?.botName,
    }),
  }), ['onIncoming', 'wake', 'scheduleWake', 'resume', 'retrySession', 'startProactiveLoop', 'startReminderLoop']);
  // Install the lazy selected-store consumer during composition, not only when
  // HTTP starts. Merely constructing the application performs no remote sync.
  orchestrator._inject?.setStickerListProvider?.(async (chatKey, max, {signal} = {}) => {
    if (cfg().sticker?.enabled === false) return '';
    await stickers.syncFromQQ?.({signal});
    if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    return stickers.buildPromptContext(max);
  });

  // ---- 核心工具说明 ----
  // 28 个工具全部落捆绑插件（DSH §3.2 / A-2 裸 id）：core-tools（send_message/send_to/send_poke/finish/report_feedback）
  // + query-tools/memory-tools/sticker-tools/web-tools/media-tools/system-tools。内核注册表不带任何业务工具。

  // ---- 工具集装配（唯一口径 getToolAvailability + excludedTools 可解释）----
  function buildToolBundle(args) {
    return components['core.tools.bundle'](args, { registry, loader, components, composition, lifecycle });
  }

  function forwardLinkedMedia(chatKey, entry, source = {}) {
    const signals = [...new Set([lifecycleController?.signal, source.signal].filter(Boolean))];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return components['core.media.forward'](chatKey, entry, {
      capability, cfg, send, components, composition, lifecycle,
      runtimeState: () => ({ active: lifecycleActive && !signal?.aborted && (!source.current || source.current()), generation: lifecycleGeneration, signal }),
    });
  }

  function handleProviderEvent(event, source = {}) {
    management.handleEvent(event,source);
    return components['core.events'](event, {
      ingest, orchestrator, cfg, config, store, bus, log, capability, components, composition, lifecycle,
      selfIdOf: currentSelfId, forwardMedia: forwardLinkedMedia,
      signal: source.signal, current: source.current,
    });
  }

  // ---- HTTP ----
  const httpServer = construct('runtime.http', {
    // Keep config listeners and live token reads. Only listen() sees the launch
    // port override; settings edits/load() do not rewrite it or move the socket.
    config: { ...config, onChange: config.onChange?.bind(config), get: () => {
      const current = cfg();
      return envPort === null ? current : { ...current, server: { ...current.server, port: envPort } };
    } }, log, bus,
    apiGuard: (request) => resetCoordinator?.apiGuard(request),
    accountGateway:env.QQ_AGENT_ACCOUNTS_CHILD==='1'?null:request=>accountGateway.handle(request),
    staticDir: path.join(appRoot, 'ui', 'shell'),
    uiAssetResolver: (pathname) => panelAdapters?.resolveUiAsset?.(pathname) ?? null,
    // resolver 每次核验 active/代际/授权，只能访问 dedicated ui/，不暴露插件源码。
    panelAssetResolver: (pathname) => panelAdapters.resolveAsset(pathname),
    // 背景图走静态别名而不是 /api/*：图片要当 CSS background / <img src> 用，
    // 而 <img> 无法携带 x-console-token header，走 API 会 401（图片裂图）。
    // 这里只暴露 data/ui/backgrounds，且 safeJoinStatic 仍做两段式防穿越。
    extraStaticRoots: [{ prefix: '/ui/backgrounds/', root: path.join(dataDir ?? '', 'ui', 'backgrounds'), minSegments: 1 }],
  });
  if(env.QQ_AGENT_ACCOUNTS_CHILD!=='1'){
    accounts=construct('runtime.accounts',{appRoot,dataDir,config,bus,env,getPrimary:()=>({config,transport:transportView,orchestrator,httpServer,services})});
    accountGateway=construct('runtime.accountGateway',{accounts,bus,config,getPrimaryBackend:()=>({port:httpServer.port,token:cfg().server?.token||'',generation:'primary:'+String(cfg().server?.token||'')})});
    components['console.accounts'](httpServer,{accounts,bus,config});
  }
  const sseBridge = construct('console.sse', { bus, http: httpServer });
  const startedAt = Date.now();

  // ---- 面板运行时聚合（bundled 清单 + active 插件 panels[] 声明）----
  const panelAdapters = construct('console.panels', {
    loader, permissions, registry, config, log, ui: composition?.ui ?? {},
    staticRoot:path.join(appRoot,'ui'),uiSelection:composition?.selection?.ui??{},
    bundledManifest: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(appRoot, 'ui', 'panels', 'manifest.json'), 'utf8')); }
      catch { return { panels: [] }; }
    })(),
  });
  components['console.panelRoutes'](httpServer, panelAdapters);

  // M3 console routes are the single source of truth. Legacy aliases were deliberately
  // removed rather than left behind as unreachable first-match shadows: maintaining both
  // tables lets registration order silently change public DTOs and bypass new side effects.
  const consoleRouteContext = {
    config, sessions, store, memory, loader, orchestrator, log, bus, capability, registry, permissions, priceUpdates,
    serviceLeaseOf, globalBlocklistOf,
    settingsSaveIdentity: () => {
      const settings = panelAdapters.listPanels().find(panel => panel.id === 'settings');
      return settings?.saveLifecycle?.kind === 'settings-v1'
        ? { owner: settings.stateOwner, generation: settings.stateGeneration } : null;
    },
    startedAt, version: VERSION, appId: APP_ID, dataDir, transport: transportView, profile, appRoot, extensionRoot, publicPrefix:env.QQ_AGENT_ACCOUNT_PREFIX||'', personaText, services, components, composition, lifecycle, localProtocols, protocolLogin,management,
    resetData: async () => {
      try { return await resetCoordinator.request(); }
      finally { bus.emit('status', { reset: resetCoordinator.status() }); }
    }, resetStatus: () => resetCoordinator.status(),
    marketClient: serviceFacade(() => services.get('market.client'), ['listCatalog', 'listAccounts', 'login', 'logout', 'publish', 'install'], { label: '扩展市场' }),
    communityClient: serviceFacade(() => services.get('community.client'), ['getBlocklist', 'syncGlobalBlocklist', 'updateBlocklist'], { label: '社区' }),
    bindInstallZip: (fn) => { installZip = fn; },
    selfId: currentSelfId,
    transportStatus: () => transportStatusSnapshot,
  };
  let consoleRoutesReady = null;
  let disposeConsoleRoutes = null;
  function prepareConsoleRoutes() {
    if (consoleRoutesReady) return consoleRoutesReady;
    // Synchronous registrars still populate routes during createKernel().
    // Async trusted contributions must settle before a socket is opened.
    const registration = components['console.routes'](httpServer, consoleRouteContext);
    consoleRoutesReady = Promise.resolve(registration).then((dispose) => {
      disposeConsoleRoutes = typeof dispose === 'function' ? dispose : null;
    });
    // The caller may inspect a kernel before start(); retain the rejection for
    // start() without creating a process-level unhandled rejection meanwhile.
    consoleRoutesReady.catch(() => {});
    return consoleRoutesReady;
  }
  prepareConsoleRoutes();
  async function cleanupConsoleRoutes({ quiesce = false } = {}) {
    if (!consoleRoutesReady) return;
    try { await consoleRoutesReady; }
    catch { /* registration owns rollback on failure */ }
    if (quiesce) {
      // Keep the default diagnostic/reset controllers available until exit.
      // Custom registrars can opt into this phase through dispose.quiesce().
      await disposeConsoleRoutes?.quiesce?.();
      return;
    }
    const dispose = disposeConsoleRoutes;
    disposeConsoleRoutes = null;
    consoleRoutesReady = null;
    await dispose?.();
  }
  // Route modules may acquire resources before a later constructor fails.
  // The application boundary awaits this cleanup even without a kernel result.
  lifecycle.onStop(() => cleanupConsoleRoutes({ quiesce: quiescingConsole }));

  // ---- 单实例锁 ----
  const lockFile = path.join(dataDir, 'qq-agent.lock');
  let lockHeld = false;
  function acquireInstanceLock() {
    if (lockHeld) return true;
    fs.mkdirSync(dataDir, { recursive: true });
    return components['runtime.instanceLock'](dataDir, () => {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockHeld = true;
      for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, releaseLock);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        let ownerPid = 0;
        try { ownerPid = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch {}
        let alive = false;
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try { process.kill(ownerPid, 0); alive = true; } catch (probeError) { alive = probeError?.code === 'EPERM'; }
        }
        if (!alive) {
          try {
            fs.rmSync(lockFile, { force: true });
            const fd = fs.openSync(lockFile, 'wx');
            fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
            lockHeld = true;
            for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, releaseLock);
            log.warn?.(`[kernel] 清理了失效实例锁（pid=${ownerPid || 'unknown'}）：${lockFile}`);
            return true;
          } catch (retryError) {
            if (retryError.code !== 'EEXIST') throw retryError;
          }
        }
        throw new Error(`已有实例正在运行（数据目录被锁定：${lockFile}，pid=${ownerPid || 'unknown'}）。DATA_DIR=${dataDir}`);
      }
      throw err;
    }
    });
  }
  function releaseLock() {
    if (!lockHeld) return;
    lockHeld = false;
    for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.removeListener(sig, releaseLock);
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile, { force: true });
    } catch { /* 尽力 */ }
  }

  function start() {
    if (businessSealed) return Promise.reject(new Error('当前实例已提交或尝试重置，请彻底退出并重新打开应用'));
    if (lifecycle.signal.aborted) return Promise.reject(new Error('当前组合实例已停止，请创建新的应用实例或重新启动进程'));
    if (startPromise) return startPromise;
    if (running) return Promise.resolve(httpServer.port);
    if (stopPromise) return Promise.reject(new Error('内核正在停止'));
    startPromise = startInternal().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function startInternal() {
    acquireInstanceLock();
    lifecycleController = new AbortController();
    lifecycleActive = true;
    const epoch = ++lifecycleGeneration;
    const active = () => lifecycleActive && epoch === lifecycleGeneration;
    const checkActive = () => { if (!active()) throw new Error('内核启动已取消'); };
    try {
      log.info(`QQ Agent ${VERSION}（profile=${profile.n}，data=${dataDir}）`);
    // 首启迁移检测（D-4：detect + selfDataEmpty 双闸，0.4 只读导入）
    const mig = components['runtime.migration.detect'](dataDir, env.QQ_AGENT_MIGRATE_FROM ?? null);
    if (mig.eligible) {
      log.info(`检测到 0.4 数据目录（${mig.source}），执行只读迁移…`);
      const report = construct('runtime.migration.run', { source: mig.source, targetDataDir: dataDir, appRoot, profile: profile.n, log });
      log.info(`迁移完成：${Object.entries(report.sections).map(([k, v]) => `${k}=${v.ok ? '✓' : '✗'}`).join(' ')}`);
      config.load(); // 迁移进来的 config 重新装载
    }
    await prepareConsoleRoutes();
    checkActive();
    const port = await httpServer.listen();
    checkActive();
    sessions.reconcileInBackground();   // 僵尸会话改判（后台）
    await loader.loadAll({ reason: 'boot' });
    checkActive();
    loader.startWatchers?.();
    // 价格源 tick：启动即拉；成功后 24h，失败后 3h 重试（SPEC §13 T-04）。
    const refreshPrices = async () => {
      if (!active()) return;
      let result;
      try { result = await priceUpdates.refresh(cfg().api?.model); }
      catch (err) { result = { ok: false }; if (active()) log.warn?.(`[price-feed] ${err?.message ?? err}`); }
      if (!active()) return;
      bus.emit('price-update', { ok: result.ok, remote: result.remote });
      if (priceRefreshStop) priceRefreshStop.stop();
      priceRefreshStop = scheduler.every(result.ok ? 86_400_000 : 10_800_000, refreshPrices, { ownerId: 'kernel', name: 'price-feed' });
    };
    void refreshPrices();
    await accounts?.snapshot();
    checkActive();
    await services.start();
    management.start();
    checkActive();
    await localProtocols.start();
    checkActive();
    await accounts?.restore();
    checkActive();
    running = true;
    if (cfg().proactive?.enabled) orchestrator.startProactiveLoop();
    bus.emit('server.ready', { port, version: VERSION });
    log.info(`控制台：http://127.0.0.1:${port}/`);
    log.info(`协议提供者：${transportView.id ?? '(未配置)'}`);
      log.info(`模型：${cfg().api?.model || '(未设置)'}`);
      return port;
    } catch (err) {
      invalidateLifecycle();
      const cleanupError = await cleanup();
      if (cleanupError) throw new AggregateError([err, cleanupError], '内核启动与清理失败', { cause: err });
      throw err;
    }
  }

  function invalidateLifecycle() {
    void release('core.management');
    lifecycleActive = false;
    lifecycleController?.abort(new Error('内核已停止'));
    lifecycle.cancel?.();
    lifecycleGeneration++;
    running = false;
    services.invalidate();
    priceRefreshStop?.stop?.(); priceRefreshStop = null;
  }

  resetCoordinator = construct('runtime.reset', { dataDir, log, quiesce: async () => {
    quiescingConsole = true;
    invalidateLifecycle();
    const errors = [];
    // Child account data is inside dataDir. Stop its writers before reset can
    // back up that tree; HTTP and the instance lock survive to deliver the DTO.
    for (const action of [() => orchestrator.pause(), () => release('runtime.accountGateway'), () => release('runtime.accounts'),
      () => release('runtime.protocolLogin'), () => release('runtime.localProtocols'), () => release('core.management'),
      () => release('runtime.services'), () => release('runtime.plugins'),
      () => release('core.orchestrator'), () => release('runtime.permissions', '重置前停止'), () => release('runtime.scheduler'),
      () => release('data.sessions'), () => lifecycle.close(), () => log.flush()]) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    businessSealed = true;
    log.stopWrites?.();
    transportStatus({ connected: false, error: '当前实例业务已暂停，请彻底退出并重新打开应用' });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, '重置前组合清理失败');
  } });

  async function cleanup() {
    const errors = [];
    for (const action of [
      () => release('runtime.accountGateway'),
      () => release('runtime.accounts'),
      () => release('runtime.protocolLogin'),
      () => release('runtime.localProtocols'),
      () => release('core.management'),
      () => release('runtime.services'),
      () => release('runtime.plugins'),
      () => release('core.orchestrator'),
      () => release('runtime.permissions', '内核已停止'),
      () => release('console.sse'),
      () => release('data.sessions'),
      () => release('runtime.scheduler'),
      () => release('runtime.http'),
      cleanupConsoleRoutes,
      () => lifecycle.close(),
      () => log.flush(),
    ]) {
      try { await action(); }
      catch (err) { errors.push(err); }
    }
    releaseLock();
    return errors.length > 1 ? new AggregateError(errors, '内核组合清理失败') : errors[0] ?? null;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    invalidateLifecycle();
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      const error = await cleanup();
      if (error) throw error;
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return {
    VERSION, APP_ID, dataDir, profile, components, composition, lifecycle,
    log, bus, config, capability, permissions, registry, scheduler, storage, loader, httpServer,
    store, memory, sessions, send, ingest, orchestrator, transport: transportView, services, localProtocols, protocolLogin, accounts,management,
    /** @deprecated 使用 transport；0.5.x 保留兼容 */
    get onebot() { return transportView; },
    start, stop,
  };
  } catch (error) {
    // The async createApplication boundary awaits this same idempotent close
    // and reports cleanup errors. Direct synchronous callers still get prompt
    // cancellation and best-effort release before their constructor error.
    Promise.resolve(lifecycle.close()).catch(() => {});
    throw error;
  }
}
