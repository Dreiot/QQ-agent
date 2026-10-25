// Production createApplication -> disk composition -> real kernel -> real HTTP.
// Only copied application code, synthetic messages and ephemeral loopback ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const tick = () => new Promise(setImmediate);

test('production entrypoint consumes appended UI/controller/core layers and a new generation restores defaults', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-application174-'));
  const dataDir = path.join(root, 'data'), applications = [];
  const calls = { network: [], starts: 0, stops: 0, sends: [], model: 0 };
  t.after(async () => {
    const errors = [];
    for (const application of applications) {
      try {
        await application.stop();
        assert.equal(application.scheduler.count(), 0);
      } catch (error) { errors.push(error); }
    }
    assert.equal(calls.network.length, 0, 'no remote service or real account is contacted');
    assert.equal(calls.model, 0, 'passive ingest does not run a model/agent');
    assert.equal(calls.sends.length, 0, 'no message is sent');
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('qqa-application174-'));
    fs.rmSync(target, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  });
  for (const name of ['src', 'bundled', 'ui']) fs.cpSync(path.join(workspace, name), path.join(root, name), { recursive: true });
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.cpSync(path.join(workspace,'scripts/lib'),path.join(root,'scripts/lib'),{recursive:true});
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { createApplication } = await import(pathToFileURL(path.join(root, 'src/kernel/composition.js')));
  const { defaultComponents } = await import(pathToFileURL(path.join(root, 'bundled/runtime-defaults/components.js')));
  const defaults = {
    sessions: fs.readFileSync(path.join(root, 'ui/panels/sessions/index.html'), 'utf8'),
    icons: fs.readFileSync(path.join(root, 'ui/panels/icons.js'), 'utf8'),
    shell: fs.readFileSync(path.join(root, 'ui/shell/index.html'), 'utf8'),
    settings: fs.readFileSync(path.join(root, 'ui/panels/settings/index.html'), 'utf8'),
  };
  const layer = path.join(root, 'overrides', '20-fixture');
  fs.mkdirSync(path.join(layer, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(layer, 'shell'));
  fs.writeFileSync(path.join(layer, 'sessions/index.html'), '<!doctype html><h1>composed-sessions-174</h1>');
  fs.writeFileSync(path.join(layer, 'shell/index.html'), '<!doctype html><h1>composed-shell-174</h1>');
  fs.writeFileSync(path.join(layer, 'icons.js'), 'export const iconSource = "composed-icons-174";');
  fs.writeFileSync(path.join(layer, 'implementation.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
import { createChatStore } from '../../src/kernel/store.js';
export function messages(options) {
  const store = createChatStore(options), append = store.appendIncoming;
  store.appendIncoming = (chatKey, entry) => append(chatKey, { ...entry, text: 'composed-store-174:' + entry.text });
  return store;
}
export async function register(http, context, config) {
  const cleanup = path.join(context.dataDir, 'composition-cleanup-174.txt');
  http.onDispose(() => fs.appendFileSync(cleanup, 'resource\\n'));
  await Promise.resolve();
  http.route('GET', '/api/status', () => ({ ok: true, composition: config.label }), { replace: true });
  http.route('GET', '/api/composed-fixture', () => ({ label: config.label, text: context.store.recent('private:174', 10).at(-1)?.text ?? null }));
  return () => fs.appendFileSync(cleanup, 'module\\n');
}
`);
  fs.writeFileSync(path.join(layer, 'composition.json'), JSON.stringify({
    version: 1, id: 'application-fixture', order: 20,
    components: { 'data.messages': { module: './implementation.mjs', export: 'messages' } },
    routes: [{ id: 'controllers', module: './implementation.mjs', export: 'register', config: { label: 'composed-controller-174' } }],
    ui: {
      shell: './shell',
      panels: [{ id: 'sessions', title: 'Composed sessions', assetRoot: './sessions', permissions: [], api: [{ method: 'GET', path: '/api/composed-fixture' }] }],
      assets: { 'panels/icons.js': './icons.js' },
    },
  }));

  async function boot() {
    let callbacks;
    const transport = {
      id: 'passive-fixture-174', selfId: '9174', everConnected: true, segmentSupport: ['text'], actions: {},
      bind(context) { callbacks = context; },
      start() { calls.starts++; callbacks.onStatus({ connected: true, selfId: '9174' }); },
      stop() { calls.stops++; },
      status: () => ({ id: 'passive-fixture-174', connected: true, selfId: '9174' }),
      toPlatformSegments: segments => segments,
      send(chatKey, segments) { calls.sends.push({ chatKey, segments }); return { msgId: 174 }; },
    };
    const application = await createApplication({
      appRoot: root, headless: true, transport,
      env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(root, 'absent-migration-source') },
      fetchImpl: async url => { calls.network.push(String(url)); throw new Error('fixture forbids external HTTP'); },
      priceUpdates: { resolve: () => null, refresh: async () => ({ ok: true, remote: false }) },
      communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }), getBlocklist: () => ({ ok: true, ids: [] }), listAccounts: () => ({ ok: true, accounts: [] }) },
      components: { 'llm.complete': async () => { calls.model++; throw new Error('fixture forbids agent/model execution'); } },
    });
    applications.push(application);
    application.log.setLevel('error');
    application.config.update({
      server: { token: 'synthetic-application-174-token' }, allowAllWhenEmpty: true,
      telemetry: { enabled: false }, proactive: { enabled: false }, memory: { consolidateEnabled: false }, });
    // Keep the real ingest, store and controllers active while model work stays passive.
    application.orchestrator.pause();
    const port = await application.start();
    await application.services.idle();
    assert.equal(application.components['runtime.kernel'], defaultComponents['runtime.kernel']);
    assert.equal(application.components['runtime.http'], defaultComponents['runtime.http']);
    assert.equal(port, application.httpServer.port);
    assert.ok(Number.isInteger(port) && port > 0);
    const base = `http://127.0.0.1:${port}`;
    async function request(url, { authorized = true, headers = {}, ...options } = {}) {
      const response = await fetch(base + url, { ...options, headers: { ...(authorized ? { 'x-console-token': 'synthetic-application-174-token' } : {}), ...headers } });
      return { status: response.status, text: await response.text(), headers: response.headers };
    }
    async function incoming(messageId, text) {
      assert.ok(callbacks, 'the passive transport was bound by the real service host');
      callbacks.onEvent({ kind: 'private', id: '174', type: 'message', event: {
        message_id: messageId, user_id: '174', sender: { nickname: 'Synthetic member' }, message: [{ type: 'text', data: { text } }],
      } });
      for (let attempt = 0; attempt < 100 && !application.store.findByMid('private:174', messageId); attempt++) await tick();
      const stored = application.store.findByMid('private:174', messageId);
      assert.ok(stored, 'a transport event traverses the default ingest into the selected store');
      return stored;
    }
    return { application, request, incoming, base };
  }

  const selected = await boot();
  assert.equal(selected.application.composition.layers[0].id, 'application-fixture');
  assert.equal(selected.application.composition.owners['data.messages'], 'application-fixture');
  assert.notEqual(selected.application.components['data.messages'], defaultComponents['data.messages']);
  assert.match((await selected.request('/')).text, /composed-shell-174/);
  assert.match((await selected.request('/panels/sessions/index.html')).text, /composed-sessions-174/);
  assert.match((await selected.request('/panels/icons.js')).text, /composed-icons-174/);
  assert.equal((await selected.request('/panels/settings/index.html')).text, defaults.settings, 'replacing the shell does not redirect unchanged panel roots');
  const publicPanels = JSON.parse((await selected.request('/api/panels')).text).panels;
  assert.equal(publicPanels.find(panel => panel.id === 'sessions').title, 'Composed sessions');
  assert.equal(publicPanels.find(panel => panel.id === 'sessions').kind, 'bundled');
  assert.deepEqual(JSON.parse((await selected.request('/api/status')).text), { ok: true, composition: 'composed-controller-174' });
  assert.equal((await selected.request('/api/status', { authorized: false })).status, 401);
  assert.equal((await selected.request('/api/composed-fixture', { authorized: false })).status, 401);
  assert.equal((await selected.request('/api/status', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await selected.incoming(17401, 'first-message')).text, 'composed-store-174:first-message');
  assert.equal(JSON.parse((await selected.request('/api/composed-fixture')).text).text, 'composed-store-174:first-message');
  let messages = JSON.parse((await selected.request('/api/chats/private_174/messages')).text).messages;
  assert.equal(messages.at(-1).text, 'composed-store-174:first-message', 'the unchanged HTTP controller consumes the selected real store');

  await selected.application.stop();
  assert.equal(selected.application.scheduler.count(), 0);
  assert.equal(fs.readFileSync(path.join(dataDir, 'composition-cleanup-174.txt'), 'utf8'), 'module\nresource\n');
  assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
  // Moving the complete appended layer out of overrides requires no base-file edits.
  const archived = path.join(root, 'archived-fixture-layer');
  assert.equal(path.dirname(layer), path.join(root, 'overrides'));
  assert.equal(path.dirname(archived), root);
  fs.renameSync(layer, archived);
  const restored = await boot();
  assert.deepEqual(restored.application.composition.layers, []);
  assert.equal(restored.application.composition.owners['data.messages'], 'defaults');
  assert.equal(restored.application.components['data.messages'], defaultComponents['data.messages']);
  assert.equal((await restored.request('/')).text, defaults.shell);
  assert.equal((await restored.request('/panels/sessions/index.html')).text, defaults.sessions);
  assert.equal((await restored.request('/panels/icons.js')).text, defaults.icons);
  assert.equal((await restored.request('/api/composed-fixture')).status, 404);
  const status = JSON.parse((await restored.request('/api/status')).text);
  assert.equal(status.version, '0.5.0');
  assert.equal(status.composition, undefined);
  assert.equal(status.onebot.id, 'passive-fixture-174');
  const restoredPanels = JSON.parse((await restored.request('/api/panels')).text).panels;
  assert.notEqual(restoredPanels.find(panel => panel.id === 'sessions').title, 'Composed sessions');
  assert.equal((await restored.incoming(17402, 'second-message')).text, 'second-message');
  messages = JSON.parse((await restored.request('/api/chats/private_174/messages')).text).messages;
  assert.equal(messages.at(-1).text, 'second-message');
  assert.ok(messages.some(message => message.text === 'composed-store-174:first-message'), 'generation selection does not rewrite existing synthetic data');
  await restored.application.stop();
  assert.equal(calls.starts, 2);
  assert.equal(calls.stops, 2);
  assert.equal(fs.readFileSync(path.join(dataDir, 'composition-cleanup-174.txt'), 'utf8'), 'module\nresource\n', 'removed layers acquire no resources in the following generation');

  // Secondary launcher wiring checks complement the running entrypoint regression.
  const server = fs.readFileSync(path.join(workspace, 'src/server.js'), 'utf8');
  const desktop = fs.readFileSync(path.join(workspace, 'electron/main.js'), 'utf8');
  assert.match(server, /import\s*\{\s*createApplication\s*\}\s*from\s*['"]\.\/kernel\/composition\.js['"]/);
  assert.match(server, /await createApplication\(/);
  assert.match(desktop, /await import\(['"]\.\.\/src\/kernel\/composition\.js['"]\)/);
  assert.match(desktop, /factory\s*=\s*application\.createApplication/);
  assert.match(desktop, /kernel\s*=\s*await factory\(/);
});
