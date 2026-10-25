import { createMediaReader } from './reader.js';
export default {
  setup(ctx) {
    const config = ctx.capability('host.config');
    const transport = ctx.capability('transport.actions');
    const extensions = ctx.capability('extensions.state');
    let reader = null;
    ctx.registerCapability('media.reader', {
      create() {
        reader = createMediaReader({ cfg: () => {
          const frames = extensions.videoFrames();
          return { ...config.get(), skills: { 'video-frames': { enabled: frames.enabled, settings: { frames: frames.frames } } } };
        }, transport: { actions: transport },
          capability: { providers: (name) => ctx.hasCapability(name) ? [{ provider: (...args) => ctx.capability(name, ...args) }] : [] }, log: ctx.log });
        return { ...reader, start() {}, stop() { reader.close(); } };
      },
    }, { default: true, lifecycle: true, scopes: ['net.outbound', 'proc.exec'] });
    ctx.lifecycle.onStop(() => reader?.close());
  },
};
