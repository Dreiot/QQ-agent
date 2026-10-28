// 0.4 createSkillApi 兼容垫片：把旧插件 API 映射到窄的 0.5 ctx，不暴露内核对象。
// 权限映射（2026-10-04，docs/gap-closure-design.md §二）：
//   web_fetch → net.outbound（本文件 fetch 路径）；scheduler / fs.namespace → 0.5 user 域默认 allow，无需动作；
//   proc.exec / net.raw / mcp.connect → 永不映射（deny 类或白名单外，安全基线优先）。
//   清单 legacyTrusted 不参与授权。宿主权限决定保存到独立文件，绑定插件指纹，
//   setup 请求与运行请求都要经过 loader 的窄权限门；管理员撤销优先。
import util from 'node:util';
const denyFetch = () => Promise.reject(new Error('该 Skill 未声明 web_fetch/net.outbound 权限'));

function format(args) { return util.format(...args); }

function normalizeLegacyResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok === 'boolean'
    || (!Object.hasOwn(value, 'content') && !Object.hasOwn(value, 'isError'))) return value;
  const parts = Array.isArray(value.content) ? value.content : null;
  const media = parts?.filter(part => ['image_url', 'video_url'].includes(part?.type)) ?? [];
  const other = parts?.filter(part => !['image_url', 'video_url'].includes(part?.type));
  const content = parts ? (other.every(part => part?.type === 'text') ? other.map(part => part.text ?? '').join('\n') : other) : (value.content === undefined ? '' : value.content);
  const result = { ...value, ok: !value.isError, result: content };
  if (media.length) result.mediaParts = [...(Array.isArray(value.mediaParts) ? value.mediaParts : []), ...media];
  if (value.isError) {
    try { result.error = typeof content === 'string' ? content : JSON.stringify(content); }
    catch { result.error = String(content); }
    result.error ||= '旧工具返回错误';
  }
  return result;
}

export function createCompatApi(ctx, manifest = {}, { skillId = manifest.id ?? ctx?.id ?? 'legacy-skill', automatic = false, onLegacyUse = () => {} } = {}) {
  const declared = new Set(Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : []);
  // 兼容旧声明：web_fetch 仅映射到受控的 net.outbound 能力，
  // 不会获得 net.raw 或其它网络入口。
  const outboundAllowed = declared.has('net.outbound') || declared.has('web_fetch');
  const legacyToolIds = [];
  const legacyFeatures = new Set();
  const legacyUse = feature => {
    if (!automatic || legacyFeatures.has(feature)) return;
    legacyFeatures.add(feature); onLegacyUse(feature);
  };
  const logger = ctx?.log ?? console;
  const logWith = (method, args) => logger?.[method]?.(`[${skillId}] ${format(args)}`);
  const config = () => { legacyUse('config()'); return ctx?.config?.all?.() ?? {}; };
  const log = (...args) => { legacyUse('log()'); return logWith('info', args); };
  // An unmarked apiVersion:1 package may use either SDK. Keep the current
  // methods and recognize old calls as they happen, without inspecting or
  // rewriting source, retrying setup, or changing the permission boundary.
  if (automatic) {
    Object.assign(config, ctx?.config);
    for (const name of ['info', 'warn', 'error', 'debug', 'trace', 'child']) {
      if (typeof logger?.[name] === 'function') log[name] = logger[name].bind(logger);
    }
  }
  const isSkillActive = (id) => {
    if (String(id) === String(skillId)) return true;
    return ctx?.capability?.('extensions.state')?.isActive(id) === true;
  };
  const capability = (name, ...args) => ctx?.capability?.(name, ...args);
  const hasCapability = (name) => {
    if (typeof ctx?.hasCapability === 'function') return ctx.hasCapability(name) === true;
    return typeof ctx?.capability === 'function' && ctx.capability(name) !== undefined;
  };

  const registerTool = (def) => {
    if (!def || typeof def !== 'object') throw new Error('工具定义必须是对象');
    const execute = def.execute ?? def.handler;
    if (typeof execute !== 'function') throw new Error('旧工具缺少 execute/handler');
    // Explicit params always selects the current argument convention. In auto
    // mode only parameters selects the old one: a sibling old tool or log call
    // must not change a schema-less native tool's argument order.
    const nativeContract = Object.hasOwn(def, 'params') || (automatic && !Object.hasOwn(def, 'parameters'));
    if (!nativeContract) legacyUse(Object.hasOwn(def, 'parameters') ? 'tool.parameters' : 'tool.context-first');
    const mapped = {
      ...def,
      id: def.id ?? def.name,
      params: def.params ?? def.parameters,
      execute: async (args, context) => {
        const result = await (nativeContract ? execute.call(def, args, context) : execute.call(def, context, args));
        return automatic && nativeContract ? result : normalizeLegacyResult(result);
      },
    };
    const finalId = ctx.registerTool(mapped);
    legacyToolIds.push(finalId);
    return finalId;
  };

  const fetch = outboundAllowed
    ? (url, init = {}) => {
      const bridge = ctx?.capability?.('compat04.http');
      return typeof bridge?.fetchFor === 'function'
        ? bridge.fetchFor(String(url), init, { pluginId: skillId, scope: 'net.outbound' })
        : denyFetch();
    }
    : denyFetch;

  return {
    ...(automatic ? ctx : {}),
    registerTool,
    config,
    isSkillActive,
    capability,
    hasCapability,
    log,
    warn: (...args) => { legacyUse('warn()'); return logWith('warn', args); },
    error: (...args) => { legacyUse('error()'); return logWith('error', args); },
    fetch,
    utils: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
      safeJsonParse: (value, fallback = null) => {
        try { return JSON.parse(value); } catch { return fallback; }
      },
    },
    __legacyToolIds: legacyToolIds,
  };
}

export async function adaptLegacySkill(ctx, legacy, manifest = {}, { deferSetup = false } = {}) {
  const impl = legacy?.default ?? legacy;
  if (!impl || typeof impl !== 'object') throw new Error('0.4 Skill 入口必须导出对象');
  const skillId = manifest.id ?? ctx.id;
  const api = createCompatApi(ctx, manifest, { skillId });
  let active = false, suspended = false, disposed = false, activatedOnce = false, setupPromise;
  const lifecycleContext = (context, fallback) => ({ ...api, skillId, reason: typeof context?.reason === 'string' ? context.reason : fallback });
  const cleanup = (name, context) => {
    const result = impl[name]?.call(impl, context);
    if (result && typeof result.then === 'function') return result.catch(error => ctx.log?.warn?.('[compat-04] ' + name + '：' + (error?.message ?? error)));
    return result;
  };
  const instance = {
    ...impl,
    async activate(context) {
      if (disposed || active) return;
      active = true; suspended = false;
      try { await impl.activate?.call(impl, lifecycleContext(context, activatedOnce ? 'reload-failed' : 'active')); activatedOnce = true; }
      catch (error) { active = false; throw error; }
    },
    deactivate(context) {
      if (disposed || suspended) return;
      suspended = true; active = false;
      return cleanup('deactivate', lifecycleContext(context, 'stopped'));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      return cleanup('dispose');
    },
  };
  const setup = () => setupPromise ??= (async () => {
    if (typeof impl.setup === 'function') await impl.setup(api);
    else if (typeof impl.register === 'function') await impl.register(api);
    else if (!impl.hooks && !impl.providers && typeof impl.activate !== 'function') throw new Error('0.4 Skill 入口未导出 setup/register/hooks/providers/activate');
    // The old local policy ran after delivery, not before the next model call.
    // A distinct capability preserves modern preflight invocation counts.
    for (const [name, provider] of Object.entries(impl.providers ?? {})) ctx.registerCapability?.(name === 'reply.local-policy' ? 'reply.after-tool-batch' : name, provider);
    for (const [name, declared] of Object.entries(impl.hooks ?? {})) {
      for (const fn of Array.isArray(declared) ? declared : [declared]) if (typeof fn === 'function') ctx.hooks?.on?.(name, fn);
    }
    await instance.activate();
  })();
  const adapted = { api, instance, setup, deactivate: instance.deactivate, toolIds: api.__legacyToolIds };
  if (!deferSetup) await setup();
  return adapted;
}

export default {
  setup(ctx) {
    // compat-04 本身只注册能力；loader 传入目标 ctx 与旧入口。
    ctx.registerCapability?.('compat-04.createSkillApi', ({ targetCtx, legacy, manifest, deferSetup = false } = {}) => adaptLegacySkill(targetCtx ?? ctx, legacy, manifest, { deferSetup }));
    ctx.registerCapability?.('compat-04.createAutomaticApi', ({ targetCtx, manifest, onLegacyUse } = {}) => createCompatApi(targetCtx ?? ctx, manifest, { automatic: true, onLegacyUse }));
  },
};
