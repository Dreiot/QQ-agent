import { createOneBotProvider } from './provider.js';
import { createOneBotConnectionResolver } from './connection.js';
export default {
  setup(ctx) {
    const config = ctx.capability('host.config');
    let active = null;
    ctx.registerTransport({ id: 'onebot', default: true, scopes: ['net.outbound'],
      create({ onEvent, onStatus, signal, current = () => true }) {
        const provider = createOneBotProvider({ cfg: () => config.get(), log: ctx.log, onEvent, onStatus,
          connectionResolver: createOneBotConnectionResolver() });
        const start = provider.start.bind(provider), stop = provider.stop.bind(provider);
        let offConfig = null, generation = 0, running = false, startPromise = null;
        const instance = Object.assign(provider, {
          async start() {
            if (running) return;
            if (startPromise) return startPromise;
            if (signal?.aborted || !current()) return;
            const epoch = ++generation;
            active = instance;
            offConfig = config.onChange?.(() => {
              if (active === instance && epoch === generation && !signal?.aborted && current()) provider.refreshConfig();
            }) ?? (() => {});
            startPromise = (async () => {
              try { await start(); if (epoch === generation && active === instance) running = true; }
              catch (error) { if (epoch === generation) { offConfig?.(); offConfig = null; if (active === instance) active = null; } throw error; }
            })();
            try { await startPromise; } finally { if (epoch === generation) startPromise = null; }
          },
          async stop() {
            ++generation; running = false; startPromise = null;
            offConfig?.(); offConfig = null;
            if (active === instance) active = null;
            await stop();
          },
        });
        return instance;
      },
    });
    ctx.lifecycle.onStop(() => active?.stop());
  },
};
