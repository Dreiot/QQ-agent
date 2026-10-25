import { createCommunityMarketAdapters } from './client.js';

/** The injected client is a test seam; production requests use the owner's HTTP API. */
export function createDefaultMarketClient(ctx, { signal = () => null, config = { get: () => ({}) } } = {}) {
  const injected = ctx.capability('host.defaults')?.communityMarket;
  if (injected) return injected;
  const environment = ctx.capability('host.environment');
  if (!environment?.dataDir) throw new Error('扩展市场缺少 host.environment');
  return createCommunityMarketAdapters({
    dataDir: environment.dataDir, appRoot: environment.appRoot, extensionRoot: environment.extensionRoot, config,
    signal,
    installZip: (...args) => {
      const installer = ctx.capability('extensions.installZip');
      if (typeof installer?.install !== 'function') throw Object.assign(new Error('扩展安装服务未就绪'), { status: 503, expose: true });
      return installer.install(...args);
    },
    fetchImpl: (url, options = {}) => {
      const signals = [options.signal, signal()].filter(Boolean);
      return ctx.http.fetch(url, { ...options, ...(signals.length ? { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] } : {}) });
    },
  });
}

export function createMarketService(ctx) {
  let controller = new AbortController();
  const client = createDefaultMarketClient(ctx, { signal: () => controller.signal });
  const service = {};
  for (const name of ['listCatalog', 'listAccounts', 'login', 'logout', 'publish', 'install']) {
    service[name] = (...args) => {
      if (typeof client[name] !== 'function') throw Object.assign(new Error(`扩展市场未提供 ${name}`), { status: 503, expose: true });
      return client[name](...args);
    };
  }
  // A client has no background work, but shares the managed-service lifecycle.
  service.start = () => { if (controller.signal.aborted) controller = new AbortController(); };
  service.stop = () => { controller.abort(new Error('扩展市场服务已停止')); };
  return service;
}

export default {
  setup(ctx) {
    const service = createMarketService(ctx);
    ctx.registerCapability('market.client', service, { default: true, lifecycle: true });
    ctx.lifecycle.onStop(() => service.stop());
  },
};
