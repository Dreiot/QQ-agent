import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLocalProtocols } from '../src/protocols/manager.js';
import { createConfig, buildDefaultConfig, deepMerge, sanitizeConfigForApi } from '../src/kernel/config.js';
import { registerLocalProtocolRoutes } from '../src/console/local-protocols.js';
import { inspectRuntimeArchive, extractRuntimeArchive } from '../scripts/lib/runtime-archive.mjs';
import { filesFor, writeFiles, makeZip, fakeChild } from './local-protocol-fixtures.mjs';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-local-protocol-manager-'));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, message, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) { assert(Date.now() < deadline, message); await pause(15); }
};
const items = state => state.providers.flatMap(provider => provider.items);
const manual = { wsUrl: 'ws://127.0.0.1:19001', httpUrl: 'http://127.0.0.1:19002',
  accessToken: 'test-existing-private-manual-token', httpAccessToken: 'test-existing-private-http-token', keep: true };
function merge(target, update) {
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value);
    else target[key] = value;
  }
  return target;
}
async function fixture(name, options = {}) {
  const appRoot = path.join(base, name), dataDir = path.join(appRoot, 'app-data');
  const root = options.protocolRoot || path.join(appRoot, 'protocols');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const state = { onebot: structuredClone(manual), ...(options.state || {}) }, updates = [];
  let config = { get: () => state, update: update => { updates.push(structuredClone(update)); merge(state, update); } };
  const configDefaults=deepMerge(buildDefaultConfig(),structuredClone(state));
  const bus = new EventEmitter(), events = [], logs = [], children = [], spawnCalls = [];
  const termination = { reject: false, calls: 0 };
  bus.on('local-protocols', event => events.push(structuredClone(event)));
  let serial = 41000, extracts = 0, inspections = 0;
  const ports = [...(options.ports || [])];
  const spawnImpl = (executable, args, settings) => {
    spawnCalls.push({ executable, args, settings });
    if (options.throwSpawn) throw new Error('synthetic thrown spawn failure');
    const child = fakeChild({ fail: options.failSpawn, autoSpawn: options.autoSpawn !== false });
    children.push(child); return child;
  };
  const build = () => {
    if(options.realConfig){
      const disk=createConfig({dataDir,defaults:configDefaults,log:{warn(){},error(){}}});disk.load();
      const mirror=value=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,structuredClone(value));return value;};mirror(disk.get());
      config={get:()=>disk.get(),update:update=>{updates.push(structuredClone(update));return mirror(disk.update(update));}};
    }
    return createLocalProtocols({ appRoot, dataDir, config, bus,
    log: { warn: text => logs.push(text) },
    env: { TEST_SAFE_ENV: 'preserved', NODE_OPTIONS: '--synthetic-do-not-inherit', NODE_PATH: 'synthetic',
      QQ_AGENT_PROTOCOL_DIR: root, QQ_AGENT_API_KEY: 'synthetic-parent-private', SNOWLUMA_ACCEPT_EULA: '1' },
    platform: 'win32', arch: 'x64', spawnImpl,
    terminateImpl: async child => {
      termination.calls++;
      if (termination.reject) { await pause(1); throw new Error('synthetic termination rejection'); }
      if (child.kill('SIGTERM') === false) throw new Error('synthetic kill returned false');
    },
    allocatePort: async () => ports.length ? ports.shift() : ++serial,
    inspectArchive: (...args) => { inspections++; return inspectRuntimeArchive(...args); },
    extractArchive: async (...args) => { extracts++; return extractRuntimeArchive(...args); },
  });};
  return { appRoot, dataDir, root, state, updates, bus, events, logs, children, spawnCalls, build, termination,
    get extracts() { return extracts; }, get inspections() { return inspections; } };
}
const scoped = async (name, options, action) => {
  if (typeof options === 'function') { action = options; options = {}; }
  const f = await fixture(name, options); f.manager = f.build();
  try { await action(f); } finally { await f.manager.close(); }
};

try {
await test('directory detection is read-only, handles nested complete releases and keeps manual connections', async () => {
  await scoped('detect-directories', async f => {
    await writeFiles(f.root, { ...filesFor('napcat', 'NapCat/'), ...filesFor('snowluma', 'release/SnowLuma/'),
      'NapCat/napcat/config/onebot11_23456.json': '{}', 'release/SnowLuma/config/onebot_34567.json': '{}' });
    const before = structuredClone(f.state), first = await f.manager.scan(), next = await f.manager.scan();
    assert.equal(items(first).length, 2); assert(items(first).every(item => item.ready));
    assert.deepEqual(items(first).map(item => item.id), items(next).map(item => item.id));
    assert.deepEqual(items(first).find(item => item.provider === 'napcat').accounts, ['23456']);
    assert.deepEqual(items(first).find(item => item.provider === 'snowluma').accounts, ['34567']);
    assert.deepEqual(f.state, before); assert.deepEqual(f.updates, []); assert.deepEqual(f.spawnCalls, []);
    await assert.rejects(f.manager.launch('../../outside'), /未找到/);
    await assert.rejects(fs.stat(path.join(f.dataDir, 'protocols', 'packages')), { code: 'ENOENT' });
  });
});

await test('source, partial, bad ZIP and wrong target stay unlaunchable without overwriting manual settings', async () => {
  await scoped('invalid-packages', async f => {
    const partial = filesFor('napcat', 'NapCat-incomplete/'); delete partial['NapCat-incomplete/wrapper.node'];
    await writeFiles(f.root, { ...partial, 'NapCat-source/package.json': '{}',
      'NapCat-source/packages/napcat-shell/napcat.ts': '// fixture',
      'NapCat-source/packages/napcat-onebot/config/config.ts': '// fixture',
      'SnowLuma-source/package.json': '{}', 'SnowLuma-source/packages/core/src/index.ts': '// fixture',
      'SnowLuma-source/packages/onebot/src/config.ts': '// fixture',
      'SnowLuma-source/packages/runtime/package.json': '{}' });
    await fs.writeFile(path.join(f.root, 'SnowLuma-broken.zip'), 'not a ZIP');
    await fs.writeFile(path.join(f.root, 'NapCat-source.zip'), makeZip({ 'source/package.json': '{}',
      'source/packages/napcat-shell/napcat.ts': '// fixture', 'source/packages/napcat-onebot/config/config.ts': '// fixture' }));
    const result = items(await f.manager.scan()); assert.equal(result.length, 5);
    assert(result.every(item => !item.ready)); assert.equal(result.filter(item => item.variant === 'source').length, 3);
    for (const item of result) await assert.rejects(f.manager.launch(item.id));
    assert.equal(f.spawnCalls.length, 0); assert.deepEqual(f.state.onebot, manual);
    await writeFiles(f.root, filesFor('snowluma', 'SnowLuma-wrong-target/'));
    await fs.writeFile(path.join(f.root, 'SnowLuma-wrong-target/release.json'), '{"target":"linux-arm64"}');
    const wrong = items(await f.manager.scan()).find(item => item.name === 'SnowLuma-wrong-target');
    assert(wrong?.ready, 'a full release must be scanned before its manifest target is verified at launch');
    await assert.rejects(f.manager.launch(wrong.id), /系统架构/);
    assert.equal(f.spawnCalls.length, 0); assert.deepEqual(f.state.onebot, manual);
  });
});

for (const provider of ['napcat', 'snowluma']) {
await test(`${provider} launch writes matching private credentials and distinct ports to its own schema only`, async () => {
  await scoped('connection-' + provider, { ports: [42101, 42101, 42102] }, async f => {
    await writeFiles(f.root, filesFor(provider, 'release/'));
    const relative = provider === 'napcat' ? 'napcat/config/onebot11_12345.json' : 'config/onebot_12345.json';
    const key = provider === 'napcat' ? 'network' : 'networks';
    const wsKey = provider === 'napcat' ? 'websocketServers' : 'wsServers';
    await writeFiles(path.join(f.root, 'release'), { [relative]: JSON.stringify({ custom: true,
      [key]: { httpServers: [{ name: 'other-client', token: 'unchanged', port: 19009 }],
        [wsKey]: [{ name: 'other-ws', port: 19010 }] } }) });
    const item = items(await f.manager.scan())[0]; assert(item.ready);
    await f.manager.launch(item.id, '12345');
    assert.equal(f.manager.loginContext().preparedConnection, undefined, 'legacy startup never exposes a prepared handoff');
    const connection = structuredClone(f.state.onebot), doc = await readJson(path.join(f.root, 'release', relative));
    assert.equal(connection.httpUrl, 'http://127.0.0.1:42101');
    assert.equal(connection.wsUrl, 'ws://127.0.0.1:42102');
    assert.match(connection.accessToken, /^[a-f0-9]{64}$/);
    assert.equal(connection.httpAccessToken, connection.accessToken); assert.equal(connection.keep, true);
    assert.equal(doc.custom, true); assert.deepEqual(doc[key].httpServers[0], { name: 'other-client', token: 'unchanged', port: 19009 });
    const http = doc[key].httpServers.find(row => row.name === 'qq-agent-http');
    const ws = doc[key][wsKey].find(row => row.name === 'qq-agent-ws');
    assert.equal(http.port, 42101); assert.equal(ws.port, 42102);
    for (const server of [http, ws]) {
      assert.equal(server.host, '127.0.0.1'); assert.equal(server.reportSelfMessage, false);
      assert.equal(server[provider === 'napcat' ? 'token' : 'accessToken'], connection.accessToken);
      assert.equal(server[provider === 'napcat' ? 'enable' : 'enabled'], true);
      assert.equal(server[provider === 'napcat' ? 'messagePostFormat' : 'messageFormat'], 'array');
    }
    assert.equal(doc[provider === 'napcat' ? 'networks' : 'network'], undefined);
    if (provider === 'snowluma') { assert.equal(ws.role, 'Universal'); assert.equal(ws.path, '/'); }
    const { executable, args, settings } = f.spawnCalls[0];
    assert.equal(executable, path.join(f.root, 'release', 'node.exe'));
    assert.deepEqual(args, [path.join(f.root, 'release', provider === 'napcat' ? 'index.js' : 'index.mjs'),
      ...(provider === 'napcat' ? ['-q', '12345'] : [])]);
    assert.equal(settings.shell, undefined); assert.equal(settings.windowsHide, true);
    assert.equal(settings.env.TEST_SAFE_ENV, 'preserved');
    assert(!Object.keys(settings.env).some(name => /^(NODE_OPTIONS|NODE_PATH|QQ_AGENT_|SNOWLUMA_ACCEPT_)/.test(name)));
    await f.manager.launch(item.id, '12345'); assert.equal(f.spawnCalls.length, 1, 'repeated start does not launch duplicate process');
    await f.manager.stop(); assert.deepEqual(f.children[0].kills, ['SIGTERM']);
    await f.manager.launch(item.id, '12345');
    assert.notEqual(f.state.onebot.accessToken, connection.accessToken, 'every fresh process gets a fresh token');
  });
});
}

for (const provider of ['napcat', 'snowluma']) {
await test(`${provider} generic deferred launch leaves all remembered accounts untouched and does not select one`, async () => {
  await scoped('generic-deferred-' + provider, { ports: [42401, 42402] }, async f => {
    const configDir = provider === 'napcat' ? 'napcat/config' : 'config', prefix = provider === 'napcat' ? 'onebot11' : 'onebot';
    const directory = path.join(f.root, 'release', configDir), beforeAccounts = new Map();
    await writeFiles(f.root, filesFor(provider, 'release/'));
    for (const [index, account] of ['12345', '23456'].entries()) {
      const relative = `${configDir}/${prefix}_${account}.json`, text = JSON.stringify({ account,
        [provider === 'napcat' ? 'network' : 'networks']: { httpServers: [{ name: 'qq-agent-http', port: 18000 + index, token: 'saved-' + account, accessToken: 'saved-' + account }] } });
      await writeFiles(path.join(f.root, 'release'), { [relative]: text });beforeAccounts.set(account, text);
    }
    const item = items(await f.manager.scan())[0];assert.deepEqual(item.accounts, ['12345', '23456']);
    const before = structuredClone(f.state.onebot), running = await f.manager.launch(item.id, undefined, { deferConnection: true });
    assert.equal(running.running.status, 'running');assert.equal(running.running.account, '');assert.equal(f.spawnCalls.length, 1);
    assert.deepEqual(f.spawnCalls[0].args, [path.join(f.root, 'release', provider === 'napcat' ? 'index.js' : 'index.mjs')], 'a generic launch never quick-logs a remembered QQ');
    assert.deepEqual(f.state.onebot, before);assert.equal(f.updates.some(update => Object.hasOwn(update, 'onebot')), false);
    assert.equal(f.state.localProtocols.account, '');
    const context = f.manager.loginContext();assert.equal(context.account, '');assert.equal(context.preparedConnection.accountId, '');assert.equal(context.preparedConnection.httpPort, 42401);assert.deepEqual(context.preparedConnection.existingAccounts, ['12345', '23456'], 'the private handoff remembers which accounts must be selected explicitly');
    for (const [account, text] of beforeAccounts) assert.equal(await fs.readFile(path.join(directory, `${prefix}_${account}.json`), 'utf8'), text, 'existing account listeners, tokens and identity remain byte-for-byte unchanged');
    const template = await readJson(path.join(directory, `${prefix}.json`)), networks = template[provider === 'napcat' ? 'network' : 'networks'];
    assert.equal(networks.httpServers.find(row => row.name === 'qq-agent-http').port, 42401);
    assert.equal(networks[provider === 'napcat' ? 'websocketServers' : 'wsServers'].find(row => row.name === 'qq-agent-ws').port, 42402);
    assert.equal(Object.hasOwn(running.running, 'preparedConnection'), false);assert.equal(JSON.stringify(running).includes(context.preparedConnection.token), false);
  });
});
await test(`${provider} deferred launch prepares native connection without rebinding the primary account`, async () => {
  await scoped('deferred-' + provider, { ports: [42201, 42202] }, async f => {
    await writeFiles(f.root, filesFor(provider, 'release/'));
    const item = items(await f.manager.scan())[0], before = structuredClone(f.state.onebot);
    const running = await f.manager.launch(item.id, '23456', { deferConnection: true });
    assert.equal(running.running.status, 'running'); assert.equal(running.running.account, '23456'); assert.equal(f.spawnCalls.length, 1);
    assert.deepEqual(f.state.onebot, before); assert.equal(f.updates.some(update => Object.hasOwn(update, 'onebot')), false, 'deferred launch must not send even a transient primary endpoint update');
    assert.equal(f.state.localProtocols.selectedId, item.id); assert.equal(f.state.localProtocols.account, '23456');
    const context = f.manager.loginContext(); assert.equal(context.provider, provider); assert.equal(context.httpPort, 42201); assert.equal(context.wsPort, 42202);
    assert.equal(context.preparedConnection.accountId, '23456'); assert.equal(context.preparedConnection.httpPort, 42201); assert.match(context.preparedConnection.token, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(running.running, 'preparedConnection'), false); assert.equal(JSON.stringify(running).includes(context.preparedConnection.token), false, 'prepared credentials remain host-only');
    const file = path.join(f.root, 'release', provider === 'napcat' ? 'napcat/config/onebot11_23456.json' : 'config/onebot_23456.json');
    const native = await readJson(file), networks = native[provider === 'napcat' ? 'network' : 'networks'];
    assert.equal(networks.httpServers.find(row => row.name === 'qq-agent-http').port, 42201, 'native account is still configured for the later verified handoff');
    if (provider === 'snowluma') {
      f.manager.commitLoginConnection(context.instanceId, '23456', { httpPort: 42301, wsPort: 42302, token: 'a'.repeat(64) });
      assert.equal(f.state.onebot.httpUrl, 'http://127.0.0.1:42301', 'an explicit verified primary commit retains its existing behavior');
    } else {
      assert.throws(() => f.manager.commitLoginConnection('old-instance', '23456', context.preparedConnection), /实例已变化/);
      assert.throws(() => f.manager.commitLoginConnection(context.instanceId, '34567', context.preparedConnection), /连接已变化/);
      assert.throws(() => f.manager.commitLoginConnection(context.instanceId, '23456', { ...context.preparedConnection, token: 'a'.repeat(64) }), /连接已变化/);
      assert.deepEqual(f.state.onebot, before);
      f.manager.commitLoginConnection(context.instanceId, '23456', context.preparedConnection); assert.equal(f.state.onebot.accessToken, context.preparedConnection.token);
    }
  });
});
}

await test('folder opening uses only the host protocol root and rejects caller-supplied paths', async () => {
  const routes=new Map(),opened=[],root='C:/QQ Agent/protocols';
  registerLocalProtocolRoutes({route(method,url,handler){routes.set(method+' '+url,handler);}},{localProtocols:{snapshot:()=>({root})},openProtocolDirectory:async directory=>{opened.push(directory);return{ok:true,dir:directory};}});
  const open=routes.get('POST /api/local-protocols/open-folder');assert.equal(routes.has('GET /api/local-protocols/open-folder'),false);assert.deepEqual(await open({body:{},query:{}}),{ok:true,dir:root});assert.deepEqual(opened,[root]);
  for(const body of [{path:'C:/other'}, {command:'test'}, [], null, 'C:/other'])assert.throws(()=>open({body}),error=>error.status===400);
  assert.throws(()=>open({body:{},query:{path:'C:/other'}}),error=>error.status===400);assert.deepEqual(opened,[root],'invalid requests never open a directory');
  const absent=new Map();registerLocalProtocolRoutes({route(method,url,handler){absent.set(method+' '+url,handler);}},{openProtocolDirectory:async()=>{throw Error('must not open');}});assert.throws(()=>absent.get('POST /api/local-protocols/open-folder')({body:{}}),error=>error.status===501);
});

await test('deferred launch accepts only a boolean through the HTTP route and preserves legacy default behavior', async () => {
  const routes = new Map(), calls = [];
  registerLocalProtocolRoutes({ route(method, url, handler) { routes.set(method + ' ' + url, handler); } }, {
    localProtocols: { launch: (...args) => { calls.push(args); return { ok: true }; } },
  });
  const start = routes.get('POST /api/local-protocols/start');
  for (const deferConnection of ['true', 1, null, {}, []]) assert.throws(() => start({ body: { id: 'fixture', deferConnection } }), error => error.status === 400);
  assert.equal(calls.length, 0); start({ body: { id: 'fixture', account: '23456', deferConnection: true } });
  assert.deepEqual(calls.pop(), ['fixture', '23456', { deferConnection: true }]);
  start({ body: { id: 'fixture' } }); assert.deepEqual(calls.pop(), ['fixture', undefined, { deferConnection: false }]);
  await scoped('invalid-deferred-option', async f => {
    await writeFiles(f.root, filesFor('snowluma', 'release/')); const item = items(await f.manager.scan())[0];
    for (const options of [{ deferConnection: 'true' }, null, []]) await assert.rejects(f.manager.launch(item.id, '23456', options), /必须为开关/);
    assert.deepEqual(f.state.onebot, manual); assert.equal(f.spawnCalls.length, 0);
  });
});

for (const provider of ['napcat', 'snowluma']) {
await test(`${provider} ZIP extracts once, reuses private cache, and preserves the original downloaded archive`, async () => {
  await scoped('zip-cache-' + provider, async f => {
    const filename = provider === 'napcat' ? 'NapCat-Windows.zip' : 'SnowLuma-Windows.zip';
    const archive = makeZip(filesFor(provider, 'provider-Windows/'));
    const zip = path.join(f.root, filename); await fs.writeFile(zip, archive);
    const item = items(await f.manager.scan())[0]; assert(item.ready); assert.equal(item.archive, true);
    assert.equal(f.extracts, 0); assert.equal(f.spawnCalls.length, 0);
    await f.manager.launch(item.id); assert.equal(f.extracts, 1);
    const firstRoot = f.spawnCalls[0].settings.cwd;
    assert(path.relative(path.join(f.dataDir, 'protocols', 'packages'), firstRoot).split(path.sep).length > 1);
    const doc = await readJson(path.join(firstRoot, provider === 'napcat' ? 'napcat/config/onebot11.json' : 'config/onebot.json'));
    assert.equal((provider === 'napcat' ? doc.network : doc.networks).httpServers[0][provider === 'napcat' ? 'enable' : 'enabled'], true);
    await f.manager.stop(); await f.manager.launch(item.id);
    assert.equal(f.extracts, 1); assert.equal(f.spawnCalls[1].settings.cwd, firstRoot);
    assert.deepEqual(await fs.readFile(zip), archive);
    assert.deepEqual(await fs.readdir(f.root), [filename]);
    const packageJson = await readJson(fileURLToPath(new URL('../package.json', import.meta.url)));
    assert(packageJson.build.files.includes('!protocols/**'), 'user supplied runtime directory is excluded from application distribution');
  });
});
}

await test('archive traversal, drive paths and symbolic-link entries are rejected before extraction', async () => {
  await scoped('unsafe-zips', async f => {
    const cases = [ ['NapCat-traversal.zip', { '../escape.txt': 'escape' }, {}],
      ['NapCat-drive.zip', { 'C:/escape.txt': 'escape' }, {}],
      ['NapCat-symlink.zip', { 'release/linked': '../outside' }, { symlink: 'release/linked' }] ];
    for (const [name, extra, options] of cases) await fs.writeFile(path.join(f.root, name), makeZip({ ...filesFor('napcat', 'release/'), ...extra }, options));
    const result = items(await f.manager.scan()); assert.equal(result.length, 3);
    assert(result.every(item => !item.ready && item.variant === 'invalid'));
    for (const item of result) await assert.rejects(f.manager.launch(item.id), /路径|符号链接/);
    assert.equal(f.extracts, 0); assert.equal(f.spawnCalls.length, 0);
    await assert.rejects(fs.stat(path.join(f.appRoot, 'escape.txt')), { code: 'ENOENT' });
  });
});

await test('CRC failures clean temporary extraction and never spawn or replace the source ZIP', async () => {
  await scoped('crc-error', async f => {
    const zip = path.join(f.root, 'NapCat-CRC.zip');
    const bytes = makeZip(filesFor('napcat', 'release/'), { corrupt: 'release/index.js' });
    await fs.writeFile(zip, bytes); const item = items(await f.manager.scan())[0]; assert(item.ready);
    await assert.rejects(f.manager.launch(item.id), /CRC/);
    assert.equal(f.spawnCalls.length, 0); assert.deepEqual(f.state.onebot, manual);
    assert.deepEqual(await fs.readFile(zip), bytes);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'protocols', 'packages')), []);
  });
});

await test('a symlink in an otherwise valid release cannot escape into another directory', async () => {
  await scoped('linked-directory', async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/'));
    const outside = path.join(f.appRoot, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.root, 'release', 'config-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const item = items(await f.manager.scan())[0]; assert(item.ready);
    await assert.rejects(f.manager.launch(item.id), /符号链接|链接/);
    assert.equal(f.spawnCalls.length, 0); assert.deepEqual(await fs.readdir(outside), []);
    assert.deepEqual(f.state.onebot, manual);
  });
});

for (const failure of ['failSpawn', 'throwSpawn']) {
await test(`${failure} does not leave an owned process or publish failed connection settings`, async () => {
  await scoped('launch-error-' + failure, { [failure]: true }, async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/')); const item = items(await f.manager.scan())[0];
    await assert.rejects(f.manager.launch(item.id), /synthetic/);
    assert.deepEqual(f.state.onebot, manual); assert.equal(f.manager.snapshot().running.status, 'error');
    assert(f.children.every(child => child.exitCode !== null && child.kills.length === 1));
    const kills = f.children.map(child => [...child.kills]); await f.manager.stop();
    assert.deepEqual(f.children.map(child => child.kills), kills, 'dead processes are never killed twice');
  });
});
}

await test('WebUI logs remain private while public state and watch events contain no credentials', async () => {
  await scoped('private-output', async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/')); await f.manager.start();
    const item = items(f.manager.snapshot())[0]; await f.manager.launch(item.id);
    const child = f.children[0], token = f.state.onebot.accessToken;
    child.stdout.write(`WebUI http://127.0.0.1:6099/webui?token=${token}#private\n`);
    child.stderr.write('synthetic-private-qr-output\n');
    await until(() => f.manager.snapshot().running.webUiUrl, 'WebUI URL should be detected');
    assert.equal(f.manager.snapshot().running.webUiUrl, 'http://127.0.0.1:6099/webui');
    const publicJson = JSON.stringify(f.manager.snapshot());
    assert(!publicJson.includes(token)); assert(!publicJson.includes('synthetic-private-qr-output'));
    assert(f.manager.output().text.includes(token)); assert(f.manager.output().text.includes('synthetic-private-qr-output'));
    const count = f.events.length; await fs.writeFile(path.join(f.root, 'new-package.txt'), 'synthetic');
    await until(() => f.events.length > count, 'directory watch emits a refresh');
    assert(f.events.every(event => Object.keys(event).sort().join(',') === 'id,outputVersion,status'));
    assert(!JSON.stringify(f.events).includes(token)); assert(!JSON.stringify(f.events).includes('synthetic-private-qr-output'));
    const url = f.manager.snapshot().running.webUiUrl;
    for (const rejected of ['https://outside.example/?token=bad', 'http://user:secret@127.0.0.1:6099/', f.state.onebot.httpUrl]) {
      child.stdout.write(`WebUI ${rejected}\n`); assert.equal(f.manager.snapshot().running.webUiUrl, url);
    }
    await f.manager.close(); const after = f.events.length;
    child.stdout.write('late child output'); await fs.writeFile(path.join(f.root, 'after-close.txt'), 'synthetic');
    await pause(350); assert.equal(f.events.length, after); assert.equal(f.manager.output().text, '');
    assert.deepEqual(child.kills, ['SIGTERM']); await assert.rejects(f.manager.scan(), /已停止/);
  });
});

await test('startup stays manual by default and explicit auto-start applies on the next application start', async () => {
  await scoped('explicit-autostart', async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/'));
    await f.manager.start(); assert.equal(f.children.length, 0); assert.deepEqual(f.state.onebot, manual);
    const item = items(f.manager.snapshot())[0]; await f.manager.launch(item.id);
    f.manager.saveSettings({ autoStart: true }); assert.equal(f.children.length, 1);
    await f.manager.close(); f.manager = f.build(); await f.manager.start();
    assert.equal(f.children.length, 2); assert.equal(f.manager.snapshot().running.status, 'running');
    f.manager.saveSettings({ autoStart: false }); assert.equal(f.children[1].kills.length, 0, 'disabling future auto-start does not stop an active process');
    await f.manager.close(); f.manager = f.build(); await f.manager.start();
    assert.equal(f.children.length, 2); assert.equal(f.manager.snapshot().running, null);
    await assert.rejects(async () => f.manager.saveSettings({ autoStart: 'yes' }), /开关/);
  });
});

for(const provider of ['napcat','snowluma'])for(const accountCount of [1,2])for(const explicitTarget of [false,true]){
await test(`${provider} ${explicitTarget?'targeted':'generic'} deferred auto-start preserves ${accountCount} saved QQ profiles and primary across disk reload`,async()=>{
  await scoped(`deferred-autostart-${provider}-${accountCount}-${explicitTarget}`,{realConfig:true},async f=>{
    const configDir=provider==='napcat'?'napcat/config':'config',prefix=provider==='napcat'?'onebot11':'onebot',saved=new Map();
    await writeFiles(f.root,filesFor(provider,'release/'));
    for(const account of ['12345','23456'].slice(0,accountCount)){
      const filename=path.join(f.root,'release',configDir,`${prefix}_${account}.json`),text=JSON.stringify({account,custom:'retain',
        [provider==='napcat'?'network':'networks']:{httpServers:[{name:'qq-agent-http',port:18000+saved.size,token:'old-'+account}]}});
      await writeFiles(path.join(f.root,'release'),{[`${configDir}/${prefix}_${account}.json`]:text});saved.set(filename,text);
    }
    const item=items(await f.manager.scan())[0];await f.manager.launch(item.id,explicitTarget?'12345':undefined,{deferConnection:true});
    f.manager.saveSettings({autoStart:true});assert.equal(f.state.localProtocols.deferConnection,true);
    // A selected target may have been intentionally configured above. Reboot
    // must retain the exact endpoints now owned by each existing workspace.
    for(const filename of saved.keys())saved.set(filename,await fs.readFile(filename,'utf8'));
    const before=structuredClone(f.state.onebot),diskBefore=await readJson(path.join(f.dataDir,'config.json'));
    assert.equal(diskBefore.localProtocols.deferConnection,true);assert.equal(sanitizeConfigForApi(diskBefore).localProtocols.deferConnection,true,'the actual public config round trip retains the mode');
    const lastUpdate=f.updates.length;await f.manager.close();f.manager=f.build();await f.manager.start();
    assert.equal(f.children.length,2);assert.equal(f.manager.snapshot().running.status,'running');assert.equal(f.manager.snapshot().running.account,'');
    assert.deepEqual(f.spawnCalls[1].args,[path.join(f.root,'release',provider==='napcat'?'index.js':'index.mjs')],'boot cannot quick-log or pick a remembered identity');
    assert.deepEqual(f.state.onebot,before);assert.equal(f.updates.slice(lastUpdate).some(update=>Object.hasOwn(update,'onebot')),false,'boot must never transiently bind a QQ to primary');
    for(const[filename,text]of saved)assert.equal(await fs.readFile(filename,'utf8'),text,'boot cannot rotate another workspace’s saved listener/token');
    const diskAfter=await readJson(path.join(f.dataDir,'config.json'));assert.equal(diskAfter.localProtocols.deferConnection,true);assert.equal(diskAfter.localProtocols.account,'');assert.deepEqual(diskAfter.onebot,before);
    assert.deepEqual(f.manager.loginContext().preparedConnection.existingAccounts,['12345','23456'].slice(0,accountCount));
  });
});
}

await test('legacy persisted auto-start remains non-deferred when its config lacks the new flag',async()=>{
  await scoped('legacy-disk-autostart',{realConfig:true},async f=>{
    await writeFiles(f.root,filesFor('napcat','release/'));const item=items(await f.manager.scan())[0];
    await fs.writeFile(path.join(f.dataDir,'config.json'),JSON.stringify({onebot:manual,localProtocols:{selectedId:item.id,account:'12345',autoStart:true}}));
    await f.manager.close();f.manager=f.build();await f.manager.start();
    assert.equal(f.children.length,1);assert.deepEqual(f.spawnCalls[0].args,[path.join(f.root,'release','index.js'),'-q','12345']);assert.equal(f.manager.loginContext().preparedConnection,undefined);
    assert.equal(f.state.localProtocols.deferConnection,false);assert.notDeepEqual(f.state.onebot,manual,'legacy primary binding behavior is preserved');
  });
});

await test('stop and close only signal the child owned by this manager', async () => {
  await scoped('owned-lifecycle', async f => {
    const unrelated = fakeChild({ autoSpawn: false });
    await writeFiles(f.root, filesFor('napcat', 'release/')); const item = items(await f.manager.scan())[0];
    await f.manager.stop(); assert.deepEqual(unrelated.kills, []);
    await f.manager.launch(item.id); await f.manager.stop(); await f.manager.stop();
    assert.deepEqual(f.children[0].kills, ['SIGTERM']); assert.deepEqual(unrelated.kills, []);
    await f.manager.launch(item.id); await f.manager.close();
    assert.deepEqual(f.children[1].kills, ['SIGTERM']); assert.deepEqual(unrelated.kills, []);
    await assert.rejects(async () => f.manager.launch(item.id), /已停止/);
  });
});

await test('closing while a process is starting waits for it and terminates it before publishing credentials', async () => {
  await scoped('close-during-spawn', { autoSpawn: false }, async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/')); const item = items(await f.manager.scan())[0];
    const launch = f.manager.launch(item.id);
    const rejected = assert.rejects(launch, /未能保持运行|应用已停止/);
    await until(() => f.children.length === 1, 'spawn requested');
    await assert.rejects(async () => f.manager.launch(item.id), /正在准备/);
    const closed = f.manager.close(); f.children[0].emit('spawn');
    await Promise.all([rejected, closed]);
    assert.deepEqual(f.children[0].kills, ['SIGTERM']); assert.deepEqual(f.state.onebot, manual);
    assert(!f.events.some(event => event.status === 'running'), 'shutdown cannot publish a running process');
  });
});

await test('close releases its filesystem watch handle and cancels queued refresh work', async () => {
  const watcherCount = () => process.getActiveResourcesInfo().filter(name => name === 'FSEventWrap').length;
  await scoped('watch-handle-release', async f => {
    await pause(30); const baseline = watcherCount(); await f.manager.start();
    assert(watcherCount() > baseline, 'the fixture has a real directory watcher');
    await fs.writeFile(path.join(f.root, 'pending-refresh.txt'), 'synthetic'); await pause(30);
    await f.manager.close(); const count = f.events.length;
    await until(() => watcherCount() <= baseline, 'closed watcher must release its event-loop resource');
    await pause(300); assert.equal(f.events.length, count, 'queued refresh is cancelled on close');
  });
});

for (const mode of ['reject', 'kill-false', 'kill-throws']) {
await test(`failed termination (${mode}) keeps ownership and prevents a replacement process`, async () => {
  await scoped('termination-failure-' + mode, async f => {
    await writeFiles(f.root, filesFor('napcat', 'release/')); const item = items(await f.manager.scan())[0];
    await f.manager.launch(item.id); const child = f.children[0], kill = child.kill;
    try {
      if (mode === 'reject') f.termination.reject = true;
      else child.kill = () => { if (mode === 'kill-false') return false; throw new Error('synthetic kill threw'); };
      await assert.rejects(f.manager.stop(), /synthetic/);
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.equal(f.manager.snapshot().running.pid, child.pid, 'failed termination must retain the owned process identity');
      await assert.rejects(async () => f.manager.launch(item.id, '987654'), /停止/);
      await f.manager.launch(item.id);
      assert.equal(f.children.length, 1, 'a failed stop must not launch a duplicate process');
    } finally { child.kill = kill; f.termination.reject = false; }
  });
});
}

for (const phase of ['running', 'starting']) {
await test(`a launcher exiting during ${phase} retains an uncertain lease and never signals a reused PID`, async () => {
  const f = await fixture('unexpected-exit-' + phase, { autoSpawn: phase !== 'starting' });
  f.manager = f.build();
  let second;
  try {
    await writeFiles(f.root, filesFor('napcat', 'release/'));
    await f.manager.start(); const item = items(f.manager.snapshot())[0];
    const launch = f.manager.launch(item.id);
    const launchResult = phase === 'starting' ? assert.rejects(launch, /未能保持运行/) : launch;
    await until(() => f.children.length === 1, 'owned launcher exists');
    if (phase === 'running') await launchResult;
    const child = f.children[0], before = structuredClone(f.state);
    child.exitCode = 1; child.emit('exit', 1, null);
    if (phase === 'starting') { child.emit('spawn'); await launchResult; }
    const lock = path.join(f.root, 'release/.qq-agent-runtime.lock');
    assert.equal((await readJson(lock)).uncertainTree, true);
    assert.equal(f.manager.snapshot().running.status, 'error');
    assert.match(f.manager.snapshot().running.error, /无法确认工作进程/);
    await assert.rejects(f.manager.stop(), /无法确认工作进程/);
    await assert.rejects(f.manager.launch(item.id), /无法确认工作进程/);
    assert.deepEqual(f.state, before, 'an uncertain tree cannot reconfigure the account');
    assert.equal(f.children.length, 1); assert.equal(f.termination.calls, 0);
    assert.deepEqual(child.kills, [], 'never pass an exited launcher PID to taskkill');
    await assert.rejects(f.manager.close(), /无法确认工作进程/);
    assert.equal((await readJson(lock)).uncertainTree, true, 'shutdown must retain the warning for a later app instance');
    second = await fixture('unexpected-exit-second-' + phase, { protocolRoot: f.root }); second.manager = second.build();
    const candidate = items(await second.manager.scan())[0];
    await assert.rejects(second.manager.launch(candidate.id), /上次未能确认/);
    assert.equal(second.children.length, 0);
  } finally {
    await f.manager.close().catch(() => {});
    await second?.manager.close();
  }
});
}

await test('a parent exiting before failed tree termination cannot be signalled again on retry or close', async () => {
  const f = await fixture('stop-failure-after-parent-exit'); f.manager = f.build();
  try {
    await writeFiles(f.root, filesFor('napcat', 'release/'));
    const item = items(await f.manager.scan())[0]; await f.manager.launch(item.id);
    const child = f.children[0];
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); throw new Error('synthetic worker termination failed after parent exit'); };
    await assert.rejects(f.manager.stop(), /synthetic worker termination/);
    assert.equal(f.manager.snapshot().running.status, 'error');
    assert.equal((await readJson(path.join(f.root, 'release/.qq-agent-runtime.lock'))).uncertainTree, true);
    await assert.rejects(f.manager.stop(), /无法确认工作进程/);
    await assert.rejects(f.manager.launch(item.id), /无法确认工作进程/);
    await assert.rejects(f.manager.close(), /无法确认工作进程/);
    assert.equal(f.termination.calls, 1, 'only the original live parent can be passed to the terminator');
    assert.equal(f.children.length, 1);
  } finally { await f.manager.close().catch(() => {}); }
});

await test('two managers sharing one release cannot reconfigure or spawn over the live package owner', async () => {
  await scoped('shared-package-owner', async first => {
    await writeFiles(first.root, filesFor('napcat', 'release/'));
    await writeFiles(path.join(first.root, 'release'), { 'napcat/config/onebot11_12345.json': '{"preserve":true}' });
    const item = items(await first.manager.scan())[0]; await first.manager.launch(item.id, '12345');
    const second = await fixture('shared-package-second-data', { protocolRoot: first.root }); second.manager = second.build();
    try {
      assert.notEqual(first.dataDir, second.dataDir); assert.equal(second.manager.root, first.manager.root);
      const configDir = path.join(first.root, 'release/napcat/config');
      const connectionBefore = await fs.readFile(path.join(configDir, 'onebot11_12345.json'));
      const filesBefore = await fs.readdir(configDir), stateBefore = structuredClone(second.state);
      const lock = path.join(first.root, 'release/.qq-agent-runtime.lock'), leaseBefore = await fs.readFile(lock);
      const duplicate = items(await second.manager.scan())[0]; assert.equal(duplicate.id, item.id);
      for (const account of ['12345', '987654']) {
        await assert.rejects(second.manager.launch(duplicate.id, account), /另一个实例|正在.*运行/);
        assert.deepEqual(await fs.readFile(path.join(configDir, 'onebot11_12345.json')), connectionBefore);
        assert.deepEqual(await fs.readdir(configDir), filesBefore);
        assert.deepEqual(await fs.readFile(lock), leaseBefore, 'a losing manager must not remove or replace the live lease');
      }
      assert.deepEqual(second.state, stateBefore); assert.deepEqual(second.updates, []);
      assert.equal(second.children.length, 0); assert.deepEqual(first.children[0].kills, []);
      assert.equal(first.manager.snapshot().running.status, 'running');
      await first.manager.stop(); await second.manager.launch(duplicate.id, '12345');
      assert.equal(second.children.length, 1, 'the release becomes available only after its owner stops');
    } finally { await second.manager.close(); }
  });
});

await test('cached install and cache-ancestor junctions cannot redirect launch or configuration outside the cache', async () => {
  for (const replace of ['install', 'protocols']) {
    await scoped('cache-junction-' + replace, async f => {
      await fs.writeFile(path.join(f.root, 'NapCat-Windows.zip'), makeZip(filesFor('napcat', 'release/')));
      const item = items(await f.manager.scan())[0]; await f.manager.launch(item.id); await f.manager.stop();
      const installedRoot = f.spawnCalls[0].settings.cwd, install = path.dirname(installedRoot);
      const target = replace === 'install' ? install : path.join(f.dataDir, 'protocols');
      const saved = target + '.safe-test-backup', outside = path.join(f.appRoot, 'outside-cache-' + replace);
      for (const local of [target, saved, outside]) {
        const relative = path.relative(path.resolve(base), path.resolve(local));
        assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
      }
      await fs.cp(target, outside, { recursive: true });
      const relativeRoot = path.relative(target, installedRoot), outsideRoot = path.join(outside, relativeRoot);
      const accountFile = path.join(outsideRoot, 'napcat/config/onebot11.json');
      const beforeConfig = await fs.readFile(accountFile), beforeFiles = await fs.readdir(path.dirname(accountFile));
      await fs.rename(target, saved);
      await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        await f.manager.scan(); await assert.rejects(f.manager.launch(item.id), /链接|越界|普通目录/);
        assert.equal(f.children.length, 1, 'only the original, already-stopped process was launched');
        assert.deepEqual(await fs.readFile(accountFile), beforeConfig);
        assert.deepEqual(await fs.readdir(path.dirname(accountFile)), beforeFiles);
      } finally { await fs.unlink(target); await fs.rename(saved, target); }
    });
  }
});

await test('accounts created inside an extracted ZIP appear after rescan and NapCat selects the requested account', async () => {
  await scoped('zip-created-accounts', async f => {
    const source = makeZip(filesFor('napcat', 'release/')), zip = path.join(f.root, 'NapCat-Windows.zip');
    await fs.writeFile(zip, source); await f.manager.start(); const item = items(f.manager.snapshot())[0];
    await f.manager.launch(item.id); const installed = f.spawnCalls[0].settings.cwd;
    const accountDir = path.join(installed, 'napcat/config');
    await writeFiles(accountDir, { 'onebot11_12345.json': '{"account":"first","custom":true}',
      'onebot11_23456.json': '{"account":"second","custom":true}' });
    const firstBefore = await fs.readFile(path.join(accountDir, 'onebot11_12345.json'));
    const globalBefore = await fs.readFile(path.join(accountDir, 'onebot11.json'));
    assert.deepEqual(items(await f.manager.scan())[0].accounts, ['12345', '23456']);
    assert.equal(f.inspections, 1, 'account refresh reads the cache without re-inspecting the unchanged ZIP');
    await f.manager.stop(); await assert.rejects(f.manager.launch(item.id), /多个.*账号/);
    assert.equal(f.children.length, 1, 'multiple accounts require an explicit selection');
    await f.manager.launch(item.id, '23456');
    assert.deepEqual(f.spawnCalls[1].args, [path.join(installed, 'index.js'), '-q', '23456']);
    assert.equal(f.manager.snapshot().running.account, '23456');
    assert.deepEqual(await fs.readFile(path.join(accountDir, 'onebot11_12345.json')), firstBefore);
    assert.deepEqual(await fs.readFile(path.join(accountDir, 'onebot11.json')), globalBefore);
    const selected = await readJson(path.join(accountDir, 'onebot11_23456.json'));
    assert.equal(selected.account, 'second'); assert.equal(selected.custom, true);
    assert.equal(selected.network.httpServers[0].token, f.state.onebot.accessToken);
    assert.deepEqual(await fs.readFile(zip), source); assert.equal(f.extracts, 1);
  });
});

await test('unchanged ZIP inspection is stat-cached across rescans, snapshots and output events', async () => {
  await scoped('zip-inspection-cache', async f => {
    const zip = path.join(f.root, 'NapCat-Windows.zip');
    await fs.writeFile(zip, makeZip(filesFor('napcat', 'release/')));
    const item = items(await f.manager.scan())[0]; assert.equal(f.inspections, 1);
    for (let i = 0; i < 8; i++) await f.manager.scan();
    assert.equal(f.inspections, 1); await f.manager.launch(item.id);
    const notifications = f.events.length;
    for (let i = 0; i < 20; i++) {
      f.children[0].stdout.write('synthetic output line ' + i + '\n');
      f.manager.snapshot(); f.manager.output();
    }
    await until(() => f.events.length > notifications, 'batched output notification');
    for (let i = 0; i < 5; i++) await f.manager.scan();
    assert.equal(f.inspections, 1, 'output notifications do not re-open the ZIP central directory');
    await f.manager.stop();
    await fs.writeFile(zip, makeZip({ ...filesFor('napcat', 'release/'), 'release/new-release-file.txt': 'new version' }));
    const changed = new Date(Date.now() + 2000); await fs.utimes(zip, changed, changed);
    await f.manager.scan(); assert.equal(f.inspections, 2, 'a changed size/mtime invalidates the archive index');
    await f.manager.scan(); assert.equal(f.inspections, 2);
  });
});
} finally {
  const resolved = path.resolve(base), temporary = path.resolve(os.tmpdir());
  assert(path.dirname(resolved) === temporary && path.basename(resolved).startsWith('qqa-local-protocol-manager-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
