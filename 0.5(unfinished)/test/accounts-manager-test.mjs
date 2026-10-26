import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAccountManager } from '../src/accounts/manager.js';
import { startAccountWorker } from '../src/accounts/worker.js';

const cases = [], roots = [], keepAlive = setInterval(() => {}, 1000);
const test = (name, run) => cases.push({ name, run });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const qq1 = '12345678', qq2 = '87654321', primaryQQ = '55555555';
const protocolToken = 'fixture-protocol-token-private';
const initialServerToken = 'fixture-primary-console-private';
let nextPid = 900000, nextPort = 21101;
const binding = (accountId = qq1, overrides = {}) => ({ accountId, nickname: '测试账号', provider: 'napcat', httpPort: 19101, wsPort: 19102, token: protocolToken, ...overrides });
async function harness({ root: existingRoot, behavior = [] } = {}) {
  const root = existingRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-account-manager-')); if (!existingRoot) roots.push(root);
  const appRoot = path.join(root, 'app'), dataDir = path.join(root, 'main-data'); await fs.mkdir(appRoot, { recursive: true }); await fs.mkdir(dataDir, { recursive: true });
  const events = [], children = [], spawns = [], terminations = [], emitter = new EventEmitter();
  const bus = { emit(name, payload) { events.push({ name, payload: structuredClone(payload) }); emitter.emit(name, payload); },
    on(name, handler) { emitter.on(name, handler); return () => emitter.off(name, handler); } };
  const settings = { api: { model: 'fixture-model', apiKey: 'fixture-model-key-private' }, store: { maxMessagesPerChat: 100 },
    skills: { custom: { enabled: true } }, extensions: { hotReload: false, providers: { 'transport.provider': 'not-installed-third-party' } }, server: { token: initialServerToken, port: 3210, autoStart: true }, desktop: { autoStart: true },
    localProtocols: { selectedId: 'primary-protocol', account: primaryQQ, autoStart: true }, onebot: { httpUrl: 'http://127.0.0.1:18501', wsUrl: 'ws://127.0.0.1:18502', accessToken: 'primary-only-token' } };
  let primaryTransportEnabled = true;
  const primarySwitches = [];
  const primary = { config: { get: () => settings }, transport: { selfId: primaryQQ, selfNickname: '主账号', id: 'onebot', status: () => ({ connected: primaryTransportEnabled, selfId: primaryQQ }) },
    services: { async setEnabled(name, enabled) { assert.equal(name, 'transport.provider'); primarySwitches.push(enabled); primaryTransportEnabled = enabled; } },
    orchestrator: { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; }, status() { return { paused: this.paused }; } }, httpServer: { port: 3210 } };
  const manager = createAccountManager({ appRoot, dataDir, config: { get: () => settings }, getPrimary: () => primary,
    bus,
    startTimeoutMs: 100, stopTimeoutMs: 50, requestTimeoutMs: 100,
    spawnImpl(module, args, options) {
      const mode = behavior.shift() || {};
      if (mode.throwSpawn) throw new Error('fixture-private-spawn-error');
      const child = new EventEmitter(); Object.assign(child, { pid: ++nextPid, exitCode: null, signalCode: null,
        stdout: new PassThrough(), stderr: new PassThrough(), connected: true, messages: [], generation: '', paused: true, mode });
      const exit = signal => { if (child.exitCode != null) return; child.exitCode = 0; child.signalCode = signal || null; child.connected = false; child.emit('exit', 0, signal); };
      child.kill = signal => { exit(signal); return true; };
      child.send = (message, callback) => {
        child.messages.push(structuredClone(message)); callback?.(null);
        void (async () => {
          if (message.type === 'account.initialize') {
            child.generation = message.generation; child.init = message;
            if (mode.noReady) return;
            if (mode.error) { child.emit('message', { type: 'account.error', generation: child.generation }); return; }
            const file = path.join(message.dataDir, 'config.json'), config = await read(file);
            await fs.writeFile(file, JSON.stringify({ ...config, server: { ...config.server, token: message.serverToken, port: 0 } }));
            child.emit('message', { type: 'account.ready', port: ++nextPort, generation: child.generation });
            child.emit('message', { type: 'account.status', accountId: message.accountId, connected: true, paused: child.paused, generation: child.generation });
          } else if (message.type === 'account.configure') {
            if (!mode.configureFail) { const file = path.join(child.init.dataDir, 'config.json'), config = await read(file); await fs.writeFile(file, JSON.stringify({ ...config, onebot: message.onebot })); }
            child.emit('message', { type: 'account.response', generation: child.generation, requestId: message.requestId, ok: !mode.configureFail });
          } else if (message.type === 'account.pause') {
            if (!mode.pauseFail) child.paused = message.paused;
            child.emit('message', { type: 'account.response', generation: child.generation, requestId: message.requestId, ok: !mode.pauseFail });
          } else if (message.type === 'account.generation') child.generation = message.generation;
          else if (message.type === 'account.stop' && !mode.ignoreStop) exit();
        })().catch(error => child.emit('error', error));
      };
      children.push(child); spawns.push({ module, args, options }); return child;
    }, terminateImpl: async child => { terminations.push(child.pid); child.kill('SIGKILL'); } });
  return { root, appRoot, dataDir, manager, primary, primarySwitches, settings, events, children, spawns, terminations, bus,
    manifest: () => read(path.join(dataDir, 'accounts.json')), childConfig: id => read(path.join(dataDir, 'accounts', id, 'data', 'config.json')) };
}
function privateFree(value, tokens = []) {
  const text = JSON.stringify(value); for (const secret of [protocolToken, initialServerToken, 'fixture-model-key-private', ...tokens]) assert.equal(text.includes(secret), false, 'public metadata contains a credential');
}

test('primary identity never creates a second worker', async () => {
  const h = await harness(); try { assert.deepEqual(await h.manager.registerConnection(binding(primaryQQ)), { workspaceId: 'primary' }); assert.equal(h.children.length, 0);
    const snapshot = await h.manager.snapshot(); assert.equal(snapshot.accounts.length, 1); assert.equal(snapshot.accounts[0].connected, true); assert.equal(snapshot.accounts[0].accountId, primaryQQ); privateFree(snapshot);
  } finally { await h.manager.close(); }
});

test('concurrent status binding is persisted before restore reports ready', async () => {
  const h = await harness(); try {
    await h.manager.snapshot();
    const persisted = await h.manifest();
    assert.equal(persisted.primaryAccount.accountId, primaryQQ);
    h.primary.transport.selfId = '';
    h.primary.transport.status = () => ({ connected: false, selfId: '' });
    const other = createAccountManager({ appRoot: h.appRoot, dataDir: path.join(h.root, 'event-bound'),
      config: { get: () => h.settings }, bus: h.bus, getPrimary: () => h.primary });
    try {
      await other.snapshot();
      h.primary.transport.selfId = primaryQQ;
      h.primary.transport.status = () => ({ connected: true, selfId: primaryQQ });
      h.bus.emit('onebot.status', { connected: true, selfId: primaryQQ });
      await other.restore();
      assert.equal((await read(path.join(h.root, 'event-bound', 'accounts.json'))).primaryAccount.accountId, primaryQQ);
      assert.equal((await fs.readdir(path.join(h.root, 'event-bound'))).some(name => name.endsWith('.tmp')), false);
    } finally { await other.close(); }
  } finally { await h.manager.close(); }
});

test('primary binding persists and an empty identity during disconnect never duplicates it', async () => {
  const h = await harness(); try {
    await h.manager.snapshot(); assert.equal((await h.manifest()).primaryAccount.accountId, primaryQQ);
    h.primary.transport.selfId = ''; h.primary.transport.status = () => ({ connected: false, selfId: '' });
    assert.deepEqual(await h.manager.registerConnection(binding(primaryQQ)), { workspaceId: 'primary' }); assert.equal(h.children.length, 0);
    const primary = (await h.manager.snapshot()).accounts[0]; assert.equal(primary.accountId, primaryQQ); assert.equal(primary.connected, false);
    await assert.rejects(h.manager.setPaused(false), /部分账号/);
    assert.equal((await h.manifest()).primaryAccount.accountId, primaryQQ);
  } finally { await h.manager.close(); }
});

test('wrong primary QQ is synchronously fenced and never relabels the existing workspace', async () => {
  const h = await harness(); try {
    await h.manager.snapshot(); h.primary.transport.selfId = qq2; h.primary.transport.status = () => ({ connected: true, selfId: qq2 });
    h.bus.emit('onebot.status', { connected: true, selfId: qq2 }); assert.equal(h.primary.orchestrator.paused, true, 'fence must not await a snapshot');
    const primary = (await h.manager.snapshot()).accounts[0]; assert.equal(primary.accountId, primaryQQ); assert.equal(primary.connected, false); assert.equal(primary.status, 'error'); assert.ok(primary.error); assert.equal(primary.paused, true);
    await assert.rejects(h.manager.setPaused(false), /部分账号/); assert.equal(h.primary.orchestrator.paused, true);
    h.primary.orchestrator.resume(); h.bus.emit('status', { paused: false }); assert.equal(h.primary.orchestrator.paused, true, 'direct primary resume is fenced by its status event');
    assert.deepEqual(await h.manager.registerConnection(binding(primaryQQ)), { workspaceId: 'primary' });
    const other = await h.manager.registerConnection(binding(qq2)); assert.notEqual(other.workspaceId, 'primary'); assert.equal((await h.manifest()).primaryAccount.accountId, primaryQQ);
  } finally { await h.manager.close(); }
});

test('persisted primary binding survives application restart with a different live QQ', async () => {
  const h = await harness(); await h.manager.snapshot(); await h.manager.close();
  const next = await harness({ root: h.root }); try {
    next.primary.transport.selfId = qq2; next.primary.transport.status = () => ({ connected: true, selfId: qq2 });
    const primary = (await next.manager.snapshot()).accounts[0]; assert.equal(primary.accountId, primaryQQ); assert.equal(primary.connected, false); assert.equal(next.primary.orchestrator.paused, true);
    assert.equal((await next.manifest()).primaryAccount.accountId, primaryQQ);
  } finally { await next.manager.close(); }
});

test('two accounts get independent data/extensions/cache, console tokens and paused workers', async () => {
  const h = await harness(); try {
    const a = await h.manager.registerConnection(binding()), b = await h.manager.registerConnection(binding(qq2, { provider: 'snowluma', httpPort: 19201, wsPort: 19202 }));
    assert.notEqual(a.workspaceId, b.workspaceId); assert.equal(h.children.length, 2);
    const backA = h.manager.backend(a.workspaceId), backB = h.manager.backend(b.workspaceId); assert.ok(backA.port); assert.notEqual(backA.port, backB.port); assert.notEqual(backA.token, backB.token);
    for (const [index, { workspaceId }] of [a, b].entries()) {
      const spawn = h.spawns[index], childConfig = await h.childConfig(workspaceId), child = h.children[index];
      assert.equal(spawn.options.env.QQ_AGENT_DATA_DIR, path.join(h.dataDir, 'accounts', workspaceId, 'data'));
      assert.equal(spawn.options.env.QQ_AGENT_EXTENSION_ROOT, path.join(h.dataDir, 'accounts', workspaceId, 'extensions'));
      assert.equal(spawn.options.env.QQ_AGENT_RUNTIME_CACHE_ROOT, path.join(h.dataDir, 'accounts', workspaceId, 'extension-cache'));
      assert.equal(spawn.options.env.QQ_AGENT_ACCOUNT_PREFIX, '/accounts/' + workspaceId); assert.equal(spawn.options.env.QQ_AGENT_PORT, '0');
      assert.equal(spawn.options.env.QQ_AGENT_ACCOUNTS_CHILD, '1'); assert.equal(spawn.options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(spawn.options.windowsHide, true);
      assert.equal(childConfig.api.model, 'fixture-model'); assert.equal(childConfig.server.autoStart, false); assert.equal(childConfig.desktop.autoStart, false); assert.equal(childConfig.localProtocols.autoStart, false);
      assert.deepEqual(childConfig.extensions.providers, {}, 'new workspace must not select unavailable third-party providers');
      assert.equal(childConfig.extensions.hotReload, false);
      assert.equal(childConfig.localProtocols.selectedId, ''); assert.equal(child.paused, true); assert.equal(childConfig.server.token, h.manager.backend(workspaceId).token);
    }
    privateFree(await h.manifest(), [backA.token, backB.token]); privateFree(await h.manager.snapshot(), [backA.token, backB.token]); privateFree(h.events, [backA.token, backB.token]);
  } finally { await h.manager.close(); }
});

test('new account backgrounds copy local and legacy references into independent files only once', async () => {
  const h = await harness(), source = path.join(h.dataDir, 'ui', 'backgrounds'); await fs.mkdir(source, { recursive: true });
  const original = Buffer.from('fixture-picture-original'), legacy = Buffer.from('fixture-legacy-picture');
  await fs.writeFile(path.join(source, 'bg-local.png'), original); await fs.writeFile(path.join(source, 'bg-legacy.jpg'), legacy);
  h.settings.ui = { uikit: { dark: { surface: '#123456', bgImage: '/ui/backgrounds/bg-local.png' }, light: { bgImage: '/api/uikit/background/bg-legacy.jpg' },
    variants: [{ image: '/ui/backgrounds/bg-local.png', color: '#abcdef' }], external: 'https://example.test/background.png', inline: 'data:image/png;base64,eA==' } };
  const expected = structuredClone(h.settings.ui);
  try {
    const { workspaceId } = await h.manager.registerConnection(binding()), dir = path.join(h.dataDir, 'accounts', workspaceId, 'data', 'ui', 'backgrounds');
    assert.deepEqual((await h.childConfig(workspaceId)).ui, expected); assert.deepEqual(h.settings.ui, expected);
    assert.deepEqual(await fs.readFile(path.join(dir, 'bg-local.png')), original); assert.deepEqual(await fs.readFile(path.join(dir, 'bg-legacy.jpg')), legacy);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['bg-legacy.jpg', 'bg-local.png']);
    await fs.writeFile(path.join(dir, 'bg-local.png'), 'child-independent-change'); assert.deepEqual(await fs.readFile(path.join(source, 'bg-local.png')), original);
    await fs.writeFile(path.join(source, 'bg-legacy.jpg'), 'primary-independent-change'); assert.deepEqual(await fs.readFile(path.join(dir, 'bg-legacy.jpg')), legacy);
    await h.manager.stop(workspaceId);
    const configFile = path.join(h.dataDir, 'accounts', workspaceId, 'data', 'config.json'), custom = await read(configFile);
    custom.ui.uikit.dark.bgImage = '/ui/backgrounds/child-custom.png'; await fs.writeFile(path.join(dir, 'child-custom.png'), 'custom-only'); await fs.writeFile(configFile, JSON.stringify(custom));
    await h.manager.registerConnection(binding(qq1, { httpPort: 19301, wsPort: 19302 }));
    assert.equal((await h.childConfig(workspaceId)).ui.uikit.dark.bgImage, '/ui/backgrounds/child-custom.png');
    assert.equal(await fs.readFile(path.join(dir, 'bg-local.png'), 'utf8'), 'child-independent-change'); assert.deepEqual(await fs.readFile(path.join(dir, 'bg-legacy.jpg')), legacy);
  } finally { await h.manager.close(); }
});

test('missing, oversized, malformed, linked and other-account background references clear without losing colors', async () => {
  const h = await harness(), source = path.join(h.dataDir, 'ui', 'backgrounds'), outside = path.join(h.root, 'outside-images');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.png'), 'must-not-copy');
  await fs.symlink(outside, path.join(source, 'bg-linked.png'), process.platform === 'win32' ? 'junction' : 'dir');
  const oversized = await fs.open(path.join(source, 'bg-large.png'), 'w'); await oversized.truncate(8 * 1024 * 1024 + 1); await oversized.close();
  h.settings.ui = { uikit: { accent: '#12abcd', values: [
    '/ui/backgrounds/missing.png', '/ui/backgrounds/bg-large.png', '/ui/backgrounds/bg-linked.png', '/ui/backgrounds/../private.png',
    '/ui/backgrounds/bg.png?secret=x', '/api/uikit/background/bg.png/extra', '/accounts/other-account/ui/backgrounds/private.png',
    '/ui/backgrounds/%2e%2e', '/api/uikit/background/..',
  ], external: 'https://example.test/bg.png', inline: 'data:image/png;base64,eA==' } };
  try {
    const { workspaceId } = await h.manager.registerConnection(binding()), ui = (await h.childConfig(workspaceId)).ui;
    assert.equal(ui.uikit.accent, '#12abcd'); assert.deepEqual(ui.uikit.values, Array(9).fill('')); assert.equal(ui.uikit.external, h.settings.ui.uikit.external); assert.equal(ui.uikit.inline, h.settings.ui.uikit.inline);
    const target = path.join(h.dataDir, 'accounts', workspaceId, 'data', 'ui', 'backgrounds'); await assert.rejects(fs.stat(target), error => error.code === 'ENOENT');
    assert.equal(await fs.readFile(path.join(outside, 'private.png'), 'utf8'), 'must-not-copy');
  } finally { await h.manager.close(); }
});

test('a linked primary backgrounds directory is never followed during account seed', async () => {
  const h = await harness(), outside = path.join(h.root, 'outside-backgrounds'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'bg-private.png'), 'private-picture');
  await fs.mkdir(path.join(h.dataDir, 'ui')); await fs.symlink(outside, path.join(h.dataDir, 'ui', 'backgrounds'), process.platform === 'win32' ? 'junction' : 'dir');
  h.settings.ui = { uikit: { bgImage: '/ui/backgrounds/bg-private.png', surface: '#334455' } };
  try { const { workspaceId } = await h.manager.registerConnection(binding()), ui = (await h.childConfig(workspaceId)).ui;
    assert.equal(ui.uikit.bgImage, ''); assert.equal(ui.uikit.surface, '#334455'); assert.equal(await fs.readFile(path.join(outside, 'bg-private.png'), 'utf8'), 'private-picture');
  } finally { await h.manager.close(); }
});

test('concurrent registration of one QQ creates one stable workspace', async () => {
  const h = await harness(); try { const entries = await Promise.all([h.manager.registerConnection(binding()), h.manager.registerConnection(binding())]);
    assert.equal(entries[0].workspaceId, entries[1].workspaceId); assert.equal(h.children.length, 1); assert.equal((await h.manifest()).accounts.length, 1);
  } finally { await h.manager.close(); }
});

test('existing running worker rebinds through IPC without overwriting its personalized settings', async () => {
  const h = await harness(); try {
    const { workspaceId } = await h.manager.registerConnection(binding());
    const file = path.join(h.dataDir, 'accounts', workspaceId, 'data', 'config.json'), current = await read(file); current.api.model = 'account-custom-model'; current.extensions.providers = { 'web.search': 'account-installed-provider' }; await fs.writeFile(file, JSON.stringify(current));
    const second = await h.manager.registerConnection(binding(qq1, { nickname: '新名称', httpPort: 19301, wsPort: 19302 }));
    assert.equal(second.workspaceId, workspaceId); assert.equal(h.children.length, 1); assert.equal((await h.childConfig(workspaceId)).api.model, 'account-custom-model');
    assert.equal((await h.childConfig(workspaceId)).onebot.httpUrl, 'http://127.0.0.1:19301'); assert.equal(h.settings.api.model, 'fixture-model');
    assert.deepEqual((await h.childConfig(workspaceId)).extensions.providers, { 'web.search': 'account-installed-provider' }, 'existing account selections stay independent');
    assert.ok(h.children[0].messages.some(message => message.type === 'account.configure'));
  } finally { await h.manager.close(); }
});

test('failed IPC rebinding keeps the existing worker reachable for pause and recovery', async () => {
  const h = await harness({ behavior: [{ configureFail: true }] }); try {
    const { workspaceId } = await h.manager.registerConnection(binding()), original = h.manager.backend(workspaceId);
    await assert.rejects(h.manager.registerConnection(binding(qq1, { httpPort: 19301, wsPort: 19302 })));
    assert.deepEqual(h.manager.backend(workspaceId), original);
    assert.equal((await h.manager.snapshot()).accounts.find(item => item.id === workspaceId).status, 'running');
    await h.manager.setPaused(true); assert.equal(h.children[0].paused, true);
  } finally { await h.manager.close(); }
});

test('a stop queued after start wins both the process state and persisted restore intention', async () => {
  const h = await harness(); try {
    const { workspaceId } = await h.manager.registerConnection(binding()); await h.manager.stop(workspaceId);
    await Promise.all([h.manager.start(workspaceId), h.manager.stop(workspaceId)]);
    assert.equal(h.manager.backend(workspaceId), null);
    assert.equal((await h.manifest()).accounts.find(item => item.id === workspaceId).wanted, false);
  } finally { await h.manager.close(); }
});

test('explicit stop clears wanted while application close preserves desired running state', async () => {
  const h = await harness(); const a = await h.manager.registerConnection(binding()), b = await h.manager.registerConnection(binding(qq2));
  const old = h.manager.backend(a.workspaceId); await h.manager.stop(a.workspaceId); assert.equal(h.manager.backend(a.workspaceId), null);
  assert.equal((await h.manifest()).accounts.find(item => item.id === a.workspaceId).wanted, false);
  await h.manager.start(a.workspaceId); assert.notEqual(h.manager.backend(a.workspaceId).generation, old.generation); await h.manager.stop(b.workspaceId); await h.manager.close();
  assert.equal((await h.manifest()).accounts.find(item => item.id === a.workspaceId).wanted, true);
  const restored = await harness({ root: h.root }); try { await restored.manager.restore(); assert.equal(restored.children.length, 1); assert.ok(restored.manager.backend(a.workspaceId)); assert.equal(restored.manager.backend(b.workspaceId), null);
  } finally { await restored.manager.close(); }
});

test('one restore failure remains visible and does not prevent another account from starting', async () => {
  const h = await harness(); const a = await h.manager.registerConnection(binding()), b = await h.manager.registerConnection(binding(qq2)); await h.manager.close();
  const restored = await harness({ root: h.root, behavior: [{ error: true }, {}] }); try { await restored.manager.restore();
    const snapshot = await restored.manager.snapshot(); assert.equal(snapshot.accounts.find(item => item.id === a.workspaceId).status, 'error'); assert.ok(snapshot.accounts.find(item => item.id === a.workspaceId).error); assert.ok(restored.manager.backend(b.workspaceId));
  } finally { await restored.manager.close(); }
});

test('startup timeout closes only its retained child and reports no usable backend', async () => {
  const h = await harness({ behavior: [{ noReady: true }] }); try {
    await assert.rejects(h.manager.registerConnection(binding()), error => error.status === 504);
    const row = (await h.manager.snapshot()).accounts.find(item => !item.primary); assert.equal(row.status, 'error'); assert.equal(h.manager.backend(row.id), null);
    assert.ok(h.children[0].messages.some(message => message.type === 'account.stop')); assert.notEqual(h.children[0].exitCode, null);
  } finally { await h.manager.close(); }
});

test('child crashes revoke its backend and preserve the restore intention', async () => {
  const h = await harness(); try { const { workspaceId } = await h.manager.registerConnection(binding()); h.children[0].kill('SIGKILL');
    assert.equal(h.manager.backend(workspaceId), null); const row = (await h.manager.snapshot()).accounts.find(item => item.id === workspaceId); assert.equal(row.status, 'error'); assert.equal(row.wanted, true);
  } finally { await h.manager.close(); }
});

test('stale worker messages are ignored and token rotation revokes the previous generation', async () => {
  const h = await harness(); try { const { workspaceId } = await h.manager.registerConnection(binding()), old = h.manager.backend(workspaceId), child = h.children[0];
    child.emit('message', { type: 'account.status', generation: 'stale', paused: false, connected: false }); assert.equal((await h.manager.snapshot()).accounts.find(item => item.id === workspaceId).connected, true);
    const replacement = 'fixture-new-worker-console-token'; child.emit('message', { type: 'account.credential', generation: old.generation, token: replacement });
    const fresh = h.manager.backend(workspaceId); assert.equal(fresh.token, replacement); assert.notEqual(fresh.generation, old.generation); assert.equal(fresh.port, old.port);
    privateFree(await h.manager.snapshot(), [old.token, replacement]); privateFree(h.events, [old.token, replacement]);
  } finally { await h.manager.close(); }
});

test('a live account instance lock is retained and its config is never rewritten', async () => {
  const h = await harness(); try { const { workspaceId } = await h.manager.registerConnection(binding()); await h.manager.stop(workspaceId);
    const dir = path.join(h.dataDir, 'accounts', workspaceId, 'data'), file = path.join(dir, 'config.json'), original = await fs.readFile(file, 'utf8'); await fs.writeFile(path.join(dir, 'qq-agent.lock'), String(process.pid));
    await assert.rejects(h.manager.registerConnection(binding(qq1, { httpPort: 19401, wsPort: 19402 })), error => error.status === 409);
    assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(await fs.readFile(path.join(dir, 'qq-agent.lock'), 'utf8'), String(process.pid)); assert.equal(h.children.length, 1);
  } finally { await h.manager.close(); }
});

test('malformed registry is preserved and cannot be overwritten by a new registration', async () => {
  const h = await harness(); const file = path.join(h.dataDir, 'accounts.json'); await fs.writeFile(file, '{invalid registry');
  try { const snapshot = await h.manager.snapshot(); assert.ok(snapshot.error); assert.equal(snapshot.accounts.length, 1);
    await assert.rejects(h.manager.registerConnection(binding())); assert.equal(await fs.readFile(file, 'utf8'), '{invalid registry'); assert.equal(h.children.length, 0);
  } finally { await h.manager.close(); }
});

test('symlinked account workspace is rejected before any config or child is created', async () => {
  const h = await harness(); const id = '2bee208a-3f6f-46a8-8145-fb1111111111', outside = path.join(h.root, 'outside');
  await fs.mkdir(outside); await fs.mkdir(path.join(h.dataDir, 'accounts')); await fs.symlink(outside, path.join(h.dataDir, 'accounts', id), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(h.dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id, accountId: qq1, nickname: '', provider: 'napcat', wanted: true }] }));
  try { await h.manager.restore(); assert.equal(h.children.length, 0); assert.deepEqual(await fs.readdir(outside), []); assert.equal((await h.manager.snapshot()).accounts.find(item => item.id === id).status, 'error');
  } finally { await h.manager.close(); }
});

test('global pause and resume acknowledge every worker and primary', async () => {
  const h = await harness(); try { await h.manager.registerConnection(binding()); await h.manager.registerConnection(binding(qq2));
    assert.deepEqual(await h.manager.setPaused(true), { ok: true }); assert.equal(h.primary.orchestrator.paused, true); assert.ok(h.children.every(child => child.paused));
    await h.manager.setPaused(false); assert.equal(h.primary.orchestrator.paused, false); assert.ok(h.children.every(child => !child.paused));
    assert.ok((await h.manager.snapshot()).accounts.every(item => !item.paused));
  } finally { await h.manager.close(); }
});

test('primary connection switch closes only its transport and reconnects paused', async () => {
  const h = await harness(); try {
    const { workspaceId } = await h.manager.registerConnection(binding()), backend = h.manager.backend(workspaceId), config = structuredClone(h.settings);
    await h.manager.stop('primary');
    const stopped = await h.manager.snapshot();
    assert.equal(stopped.accounts[0].wanted, false); assert.equal(stopped.accounts[0].status, 'stopped'); assert.equal(stopped.accounts[0].connected, false); assert.equal(stopped.accounts[0].paused, true);
    assert.equal(stopped.accounts.find(row => row.id === workspaceId).connected, true); assert.deepEqual(h.manager.backend(workspaceId), backend);
    assert.equal(h.primary.httpServer.port, 3210); assert.deepEqual(h.settings, config); assert.equal((await h.manifest()).primaryWanted, false);
    await h.manager.setPaused(false); assert.equal(h.primary.orchestrator.paused, true); assert.equal(h.children[0].paused, false, 'global resume skips the disconnected primary only');
    await h.manager.start('primary');
    const started = (await h.manager.snapshot()).accounts[0]; assert.equal(started.wanted, true); assert.equal(started.status, 'running'); assert.equal(started.connected, true); assert.equal(started.paused, true);
    assert.deepEqual(h.primarySwitches, [false, true]); assert.equal((await h.manifest()).primaryWanted, true); assert.equal(h.children.length, 1);
  } finally { await h.manager.close(); }
});

test('disconnected primary stays gated across restart before services start', async () => {
  const h = await harness(); await h.manager.snapshot(); await h.manager.stop('primary'); await h.manager.close();
  const next = await harness({ root: h.root }); try {
    const primary = (await next.manager.snapshot()).accounts[0]; assert.equal(primary.wanted, false); assert.equal(primary.connected, false); assert.equal(primary.status, 'stopped');
    assert.deepEqual(next.primarySwitches, [false]); await next.manager.restore(); assert.deepEqual(next.primarySwitches, [false]); assert.equal(next.children.length, 0);
    await next.manager.start('primary'); assert.deepEqual(next.primarySwitches, [false, true]); assert.equal((await next.manager.snapshot()).accounts[0].connected, true);
  } finally { await next.manager.close(); }
});

test('primary switch does not fake a successful disconnect on unsupported or failing lifecycle', async () => {
  const h = await harness(); try {
    await h.manager.snapshot(); const implementation = h.primary.services;
    delete h.primary.services; await assert.rejects(h.manager.stop('primary'), error => error.status === 409);
    assert.equal((await h.manager.snapshot()).accounts[0].wanted, true);
    h.primary.services = { setEnabled: async () => { throw new Error('private adapter failure'); } };
    await assert.rejects(h.manager.stop('primary'), error => error.status === 502);
    const failed = (await h.manager.snapshot()).accounts[0]; assert.equal(failed.status, 'error'); assert.equal(failed.wanted, false); assert.equal(failed.connected, true); assert.ok(failed.error); assert.equal(failed.error.includes('private adapter'), false);
    h.primary.services = implementation; await h.manager.stop('primary'); assert.equal((await h.manager.snapshot()).accounts[0].connected, false);
  } finally { await h.manager.close(); }
});

test('concurrent primary switches serialize and preserve the final requested state', async () => {
  const h = await harness(); try {
    await Promise.all([h.manager.stop('primary'), h.manager.start('primary'), h.manager.stop('primary')]);
    assert.deepEqual(h.primarySwitches, [false, true, false]); const primary = (await h.manager.snapshot()).accounts[0]; assert.equal(primary.wanted, false); assert.equal(primary.status, 'stopped'); assert.equal(primary.connected, false);
    assert.equal((await h.manifest()).primaryWanted, false); assert.equal(h.children.length, 0);
  } finally { await h.manager.close(); }
});

test('global pause never claims full success if any worker refuses', async () => {
  const h = await harness({ behavior: [{ pauseFail: true }] }); try { await h.manager.registerConnection(binding()); await assert.rejects(h.manager.setPaused(false), /部分账号/);
    assert.equal((await h.manager.snapshot()).accounts.find(item => !item.primary).paused, true);
  } finally { await h.manager.close(); }
});

test('unresponsive stop uses only the injected owned-child termination and retains lock files', async () => {
  const h = await harness({ behavior: [{ ignoreStop: true }] }); const { workspaceId } = await h.manager.registerConnection(binding());
  const lock = path.join(h.dataDir, 'accounts', workspaceId, 'data', 'qq-agent.lock'); await fs.writeFile(lock, 'fixture-lock-preserved'); await h.manager.close();
  assert.deepEqual(h.terminations, [h.children[0].pid]); assert.equal(await fs.readFile(lock, 'utf8'), 'fixture-lock-preserved'); assert.equal(h.manager.backend(workspaceId), null);
});

test('invalid connection values or workspace IDs never spawn a child', async () => {
  const h = await harness(); try { for (const invalid of [binding('1234'), binding('12345/other'), binding(qq1, { provider: 'other' }), binding(qq1, { wsPort: 19101 }), binding(qq1, { token: 'bad token' })]) await assert.rejects(h.manager.registerConnection(invalid));
    await assert.rejects(h.manager.start('../primary')); assert.equal(h.manager.backend('../primary'), null); assert.equal(h.children.length, 0);
  } finally { await h.manager.close(); }
});

test('worker boots a paused non-desktop kernel, restricts IPC configuration and stops on parent disconnect', async () => {
  const h = await harness(), id = '2bee208a-3f6f-46a8-8145-fb2222222222', generation = '3bee208a-3f6f-46a8-8145-fb2222222222';
  const workspace = path.join(h.dataDir, 'accounts', id), dataDir = path.join(workspace, 'data'), extensionRoot = path.join(workspace, 'extensions'), cacheRoot = path.join(workspace, 'extension-cache');
  for (const dir of [dataDir, extensionRoot, cacheRoot]) await fs.mkdir(dir, { recursive: true });
  const runtime = new EventEmitter(); runtime.connected = true; runtime.env = { QQ_AGENT_ACCOUNTS_CHILD: '1', QQ_AGENT_ACCOUNT_ID: qq1,
    QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_EXTENSION_ROOT: extensionRoot, QQ_AGENT_RUNTIME_CACHE_ROOT: cacheRoot };
  const sent = [], exits = [], changes = new Set(), bus = new EventEmitter(); runtime.send = (message, callback) => { sent.push(message); callback?.(); };
  let settings = { server: { token: 'initial-fixture-worker-token' } }, options, stops = 0, liveAccount = qq1;
  const kernel = { config: { get: () => settings, update(patch) { settings = { ...settings, ...patch }; for (const listener of changes) listener(); }, onChange(listener) { changes.add(listener); return () => changes.delete(listener); } },
    orchestrator: { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; }, status() { return { paused: this.paused }; } },
    transport: { status: () => ({ connected: true, selfId: liveAccount }) },
    bus: { on(name, listener) { bus.on(name, listener); return () => bus.off(name, listener); } },
    async start() { assert.equal(this.orchestrator.paused, true, 'pause occurs before transport/services start'); return 25101; }, async stop() { stops++; }, };
  const worker = startAccountWorker({ runtimeProcess: runtime, createApplicationImpl: async value => { options = value; return kernel; }, exit: code => { exits.push(code); runtime.connected = false; } });
  const until = async (check, label) => { for (let i = 0; i < 80; i++) { if (check()) return; await wait(5); } assert.fail(label); };
  try {
    runtime.emit('message', { type: 'account.initialize', generation, workspaceId: id, accountId: qq1, appRoot: h.appRoot, dataDir, extensionRoot, cacheRoot, serverToken: 'fixture-startup-worker-token' });
    await until(() => sent.some(message => message.type === 'account.ready'), 'worker did not become ready');
    assert.equal(options.headless, false); assert.equal(options.components['runtime.migration.detect']().eligible, false);
    const local = options.components['runtime.localProtocols']({ appRoot: h.appRoot }); await assert.rejects(async () => local.launch()); assert.equal(local.loginContext(), null);
    assert.equal(options.env.QQ_AGENT_DATA_DIR, dataDir); assert.equal(settings.server.token, 'fixture-startup-worker-token');
    const requestId = '4bee208a-3f6f-46a8-8145-fb2222222222';
    runtime.emit('message', { type: 'account.pause', generation, requestId, paused: false }); assert.equal(kernel.orchestrator.paused, false);
    runtime.emit('message', { type: 'account.configure', generation, requestId, onebot: { httpUrl: 'http://127.0.0.1:19101', wsUrl: 'ws://127.0.0.1:19102', accessToken: protocolToken, httpAccessToken: protocolToken } });
    assert.equal(settings.onebot.httpUrl, 'http://127.0.0.1:19101');
    runtime.emit('message', { type: 'account.configure', generation, requestId, onebot: { httpUrl: 'https://evil.example/', wsUrl: 'ws://127.0.0.1:19102', accessToken: protocolToken, httpAccessToken: protocolToken } });
    assert.equal(sent.at(-1).ok, false); assert.equal(settings.onebot.httpUrl, 'http://127.0.0.1:19101');
    settings = { ...settings, server: { token: 'fixture-rotated-worker-token' } }; for (const listener of changes) listener();
    assert.ok(sent.some(message => message.type === 'account.credential' && message.token === 'fixture-rotated-worker-token'));
    liveAccount = qq2; bus.emit('onebot.status', {}); assert.equal(kernel.orchestrator.paused, true, 'wrong live QQ identity forces pause synchronously');
    runtime.emit('message', { type: 'account.pause', generation, requestId, paused: false });
    assert.equal(kernel.orchestrator.paused, true); assert.equal(sent.at(-1).ok, false, 'a wrong-account kernel cannot be resumed');
    runtime.emit('disconnect'); await until(() => exits.length > 0, 'worker did not stop when parent disconnected');
    assert.equal(stops, 1); assert.deepEqual(exits, [0]); assert.equal(changes.size, 0); assert.equal(bus.listenerCount('onebot.status'), 0);
  } finally { await worker.stop(); await h.manager.close(); }
});

test('removing one account preserves private data, other connections and explicit reconnection identity',async()=>{
  const h=await harness();try{
    const first=await h.manager.registerConnection(binding()),second=await h.manager.registerConnection(binding(qq2));
    const original=await h.childConfig(first.workspaceId),otherBackend=h.manager.backend(second.workspaceId),marker=path.join(h.dataDir,'accounts',first.workspaceId,'data','retained-history.txt');await fs.writeFile(marker,'retained');
    await assert.rejects(h.manager.remove({id:first.workspaceId,accountId:qq2}),/身份/);assert.ok(h.manager.backend(first.workspaceId));
    await h.manager.remove({id:first.workspaceId,accountId:qq1});const state=await h.manager.snapshot();assert.equal(state.accounts.some(a=>a.id===first.workspaceId),false);assert.ok(state.removedAccounts.some(a=>a.accountId===qq1));assert.equal(h.manager.backend(first.workspaceId),null);assert.deepEqual(h.manager.backend(second.workspaceId),otherBackend);assert.equal(await fs.readFile(marker,'utf8'),'retained');assert.equal((await h.childConfig(first.workspaceId)).api.apiKey,original.api.apiKey);
    await assert.rejects(h.manager.start(first.workspaceId),/移除/);const restored=await h.manager.registerConnection(binding());assert.equal(restored.workspaceId,first.workspaceId);assert.equal(await fs.readFile(marker,'utf8'),'retained');assert.equal((await h.manager.snapshot()).removedAccounts.some(a=>a.accountId===qq1),false);
    await h.manager.remove({id:'primary',accountId:primaryQQ});assert.equal((await h.manager.snapshot()).accounts[0].accountId,'');assert.equal(h.primarySwitches.at(-1),false);assert.ok(h.manager.backend(second.workspaceId));await h.manager.registerConnection(binding(primaryQQ));assert.equal((await h.manager.snapshot()).accounts[0].accountId,primaryQQ);
  }finally{await h.manager.close();}
});
test('removed native candidates remain hidden after restart without deleting a directory',async()=>{
  const h=await harness();try{await h.manager.remove({accountId:'456789'});assert.ok((await h.manifest()).removedAccounts.includes('456789'));await h.manager.close();const next=createAccountManager({appRoot:h.appRoot,dataDir:h.dataDir,config:{get:()=>h.settings},getPrimary:()=>h.primary,bus:h.bus});try{await next.restore();assert.ok((await next.snapshot()).removedAccounts.some(a=>a.accountId==='456789'));}finally{await next.close();}}finally{await h.manager.close();}
});
test('new accounts never inherit enabled group management; existing account rules survive reconnection',async()=>{
  const h=await harness();try{
    h.settings.management={version:1,rules:[{id:'primary-rule',enabled:true}]};
    const a=await h.manager.registerConnection(binding());assert.deepEqual((await h.childConfig(a.workspaceId)).management,{version:1,rules:[]});
    const file=path.join(h.children[0].init.dataDir,'config.json'),config=await read(file);const own={version:1,rules:[{id:'own-rule',enabled:false}]};await fs.writeFile(file,JSON.stringify({...config,management:own}));
    await h.manager.registerConnection(binding());assert.deepEqual((await h.childConfig(a.workspaceId)).management,own);
    const b=await h.manager.registerConnection(binding(qq2));assert.deepEqual((await h.childConfig(b.workspaceId)).management,{version:1,rules:[]});assert.equal(h.settings.management.rules[0].enabled,true);
  }finally{await h.manager.close();}
});
test('failed registry writes leave no phantom account and preserve existing account intent',async()=>{
 const h=await harness();let blocked=false;const file=path.join(h.dataDir,'accounts.json'),backup=file+'.audit-backup';
 try{const first=await h.manager.registerConnection(binding());await h.manager.stop(first.workspaceId);const before=await h.manager.snapshot();await fs.rename(file,backup);await fs.mkdir(file);blocked=true;
   await assert.rejects(h.manager.registerConnection(binding(qq2)));await assert.rejects(h.manager.registerConnection(binding(qq1,{nickname:'must-not-be-retained',provider:'snowluma'})));await assert.rejects(h.manager.start(first.workspaceId));
   await fs.rmdir(file);await fs.rename(backup,file);blocked=false;const after=await h.manager.snapshot();assert.equal(after.accounts.length,before.accounts.length);const row=after.accounts.find(a=>a.id===first.workspaceId);assert.equal(row.wanted,false);assert.equal(row.nickname,'测试账号');assert.equal(row.provider,'napcat');assert.equal(h.children.length,1);
 }finally{if(blocked){await fs.rmdir(file);await fs.rename(backup,file);}await h.manager.close();}
});
test('failed disconnect persistence keeps the running connection and its enabled intent',async()=>{
 const h=await harness();let blocked=false;const file=path.join(h.dataDir,'accounts.json'),backup=file+'.audit-backup';
 try{const first=await h.manager.registerConnection(binding()),backend=h.manager.backend(first.workspaceId);await fs.rename(file,backup);await fs.mkdir(file);blocked=true;await assert.rejects(h.manager.stop(first.workspaceId));await fs.rmdir(file);await fs.rename(backup,file);blocked=false;const row=(await h.manager.snapshot()).accounts.find(a=>a.id===first.workspaceId);assert.equal(row.wanted,true);assert.equal(row.connected,true);assert.deepEqual(h.manager.backend(first.workspaceId),backend);
 }finally{if(blocked){await fs.rmdir(file);await fs.rename(backup,file);}await h.manager.close();}
});

let passed = 0; const failures = [];
try { for (const { name, run } of cases) { try { await run(); passed++; console.log('PASS accounts manager ' + name); } catch (error) { failures.push(error); console.error('FAIL accounts manager ' + name + ': ' + error.message); } } }
finally { clearInterval(keepAlive); for (const root of roots) { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('qqa-account-manager-')); await fs.rm(root, { recursive: true, force: true }); } }
console.log(`accounts-manager: ${passed}/${cases.length} isolated checks passed; no real worker or QQ process spawned`);
if (failures.length) throw new AggregateError(failures, 'Accounts manager checks failed');
