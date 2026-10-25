import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectProtocolLayouts, configureProtocolConnection, protocolAccounts } from '../src/protocols/adapters.js';

const windows = { platform: 'win32', arch: 'x64' };
const napFiles = ['node.exe', 'index.js', 'wrapper.node', 'QQNT.dll', 'package.json', 'config.json',
  'napcat/napcat.mjs', 'napcat/NapCatWinBootMain.exe', 'napcat/launcher-user.bat'];
const snowFiles = ['node.exe', 'index.mjs', 'package.json', 'release.json', 'check-node-version.cjs',
  'EULA.md', 'PRIVACY.md', 'client/index.html', 'native/snowluma-win32-x64.dll', 'native/snowluma-win32-x64.node',
  'native/websocket-win32-x64.node', 'native/ffmpeg/ffmpegAddon.win32.x64.node',
  'native/sqlite/manifest.json', 'native/sqlite/LICENSE.sqlite3', 'native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node'];
const prefix = (root, files) => files.map(file => `${root}/${file}`);

let results = detectProtocolLayouts(prefix('NapCat', [...napFiles, 'napcat/config/onebot11_23456.json']), windows);
assert.equal(results.length, 1, 'do not offer embedded Shell as a second runnable provider');
assert.deepEqual(results[0], { provider: 'napcat', variant: 'node', root: 'NapCat', entry: 'index.js',
  executable: 'node.exe', ready: true, reason: '', configDir: 'napcat/config', accounts: ['23456'], webUiPort: 6099 });
assert.equal(detectProtocolLayouts(napFiles.filter(file => file !== 'wrapper.node'), windows)[0].ready, false);
assert.match(detectProtocolLayouts(napFiles.filter(file => file !== 'wrapper.node'), windows)[0].reason, /wrapper.node/);
assert.equal(detectProtocolLayouts(napFiles, { platform: 'linux', arch: 'x64' })[0].ready, false);
results = detectProtocolLayouts(prefix('Snow', [...snowFiles, 'config/onebot_34567.json', 'config/onebot_12345.json']), windows);
assert.equal(results[0].ready, true);
assert.deepEqual(results[0].accounts, ['12345', '34567']);
assert.equal(results[0].root, 'Snow');
assert.equal(results[0].webUiPort, 5099);
results = detectProtocolLayouts(snowFiles.filter(file => file !== 'node.exe'), windows);
assert.equal(results[0].variant, 'lite');
assert.equal(results[0].ready, false);
assert.match(results[0].reason, /Lite/);
assert.match(detectProtocolLayouts(snowFiles.filter(file => !file.includes('sqlite/prebuilds')), windows)[0].reason, /sqlite/);
assert.equal(detectProtocolLayouts(snowFiles, { platform: 'win32', arch: 'arm64' })[0].ready, false);
const linuxFiles = snowFiles.filter(file => !file.endsWith('.node') && !file.endsWith('.dll') && file !== 'node.exe');
linuxFiles.push('node', 'native/snowluma-linux-arm64.node', 'native/snowluma-linux-arm64.so',
  'native/websocket-linux-arm64.node', 'native/ffmpeg/ffmpegAddon.linux.arm64.node',
  'native/sqlite/prebuilds/linux-arm64/@appthreat+sqlite3.glibc.node',
  'native/sqlite/prebuilds/linux-arm64/@appthreat+sqlite3.musl.node');
assert.equal(detectProtocolLayouts(linuxFiles, { platform: 'linux', arch: 'arm64' })[0].ready, true);
assert.equal(detectProtocolLayouts(['napcat.mjs', 'launcher-user.bat', 'NapCatWinBootMain.exe'], windows)[0].variant, 'shell');
assert.match(detectProtocolLayouts(['napcat.mjs', 'napcat.cjs', 'nativeLoader.cjs', 'preload.cjs'], windows)[0].reason, /框架插件/);
assert.match(detectProtocolLayouts(['NapCatInstaller.exe'], windows)[0].reason, /安装器/);
assert.deepEqual(detectProtocolLayouts(['package.json', 'index.js', 'node.exe', 'launcher.bat', 'index.mjs'], windows), []);
assert.deepEqual(detectProtocolLayouts(['../napcat/napcat.mjs', '/index.js', 'a\\napcat.mjs'], windows), []);
assert.equal(detectProtocolLayouts(['package.json', 'packages/napcat-shell/napcat.ts',
  'packages/napcat-onebot/config/config.ts'], windows)[0].variant, 'source');
assert.equal(detectProtocolLayouts(['package.json', 'packages/core/src/index.ts', 'packages/onebot/src/config.ts',
  'packages/runtime/package.json'], windows)[0].variant, 'source');

const temporaryPrefix = path.resolve(os.tmpdir(), 'qq-agent-protocol-adapters-');
const temporaryRoot = await fs.mkdtemp(temporaryPrefix);
const token = 'test-random-connection-token-123456';
const options = (root, provider = 'napcat', configDir = 'config') => ({
  root, provider, configDir, httpPort: 13000, wsPort: 13001, token,
});
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, data) => fs.writeFile(file, JSON.stringify(data), 'utf8');
const makeRoot = async name => { const root = path.join(temporaryRoot, name); await fs.mkdir(root); return root; };
try {
  const napRoot = await makeRoot('nap');
  assert.deepEqual(await protocolAccounts(napRoot, 'napcat/config', 'napcat'), []);
  assert.deepEqual(await fs.readdir(napRoot), [], 'account discovery must not create files');
  const napOptions = options(napRoot, 'napcat', 'napcat/config');
  let result = await configureProtocolConnection(napOptions);
  const napDir = path.join(napRoot, 'napcat', 'config');
  const napGlobal = path.join(napDir, 'onebot11.json');
  let document = await read(napGlobal);
  assert.equal(document.network.httpServers[0].enable, true);
  assert.equal(document.network.httpServers[0].token, token);
  assert.equal(document.network.websocketServers[0].host, '127.0.0.1');
  assert.equal(document.network.websocketServers[0].messagePostFormat, 'array');
  assert.equal(document.network.websocketServers[0].port, 13001);
  assert.equal(document.networks, undefined);
  assert.deepEqual(result.changedFiles, [napGlobal]);
  assert.equal(result.accessToken, result.httpAccessToken);
  assert.equal(result.wsUrl, 'ws://127.0.0.1:13001');
  assert.equal(result.httpUrl, 'http://127.0.0.1:13000');
  assert.deepEqual((await configureProtocolConnection(napOptions)).changedFiles, [], 'idempotent saves do not rewrite');

  const untouched = { name: 'other-framework', enable: true, host: '127.0.0.1', port: 4567, token: 'other-token' };
  document = { musicSignUrl: 'https://example.invalid/sign', custom: { keep: true }, network: {
    httpServers: [untouched, { name: 'qq-agent-http', debug: true, token: 'old' }],
    websocketServers: [{ name: 'qq-agent-ws', heartInterval: 12345, token: 'old' }],
    websocketClients: [{ name: 'external-client', url: 'ws://example.invalid/' }],
  } };
  const accountFile = path.join(napDir, 'onebot11_12345.json');
  await write(accountFile, document);
  const originalAccount = await fs.readFile(accountFile, 'utf8');
  const originalGlobal = await fs.readFile(napGlobal, 'utf8');
  result = await configureProtocolConnection(napOptions);
  const configured = await read(accountFile);
  assert.deepEqual(result.changedFiles, [accountFile], 'one account is selected automatically');
  assert.deepEqual(configured.custom, { keep: true });
  assert.equal(configured.musicSignUrl, document.musicSignUrl);
  assert.deepEqual(configured.network.httpServers[0], untouched);
  assert.equal(configured.network.httpServers[1].debug, true);
  assert.equal(configured.network.httpServers[1].token, token);
  assert.equal(configured.network.websocketServers[0].heartInterval, 12345);
  assert.deepEqual(configured.network.websocketClients, document.network.websocketClients);
  assert.equal(await fs.readFile(napGlobal, 'utf8'), originalGlobal, 'selected account does not modify global template');
  const backups = (await fs.readdir(napDir)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(napDir, backups[0]), 'utf8'), originalAccount);

  const secondFile = path.join(napDir, 'onebot11_23456.json');
  await write(secondFile, { untouched: true });
  const beforeAmbiguous = await fs.readdir(napDir);
  await assert.rejects(configureProtocolConnection(napOptions), /多个.*选择/);
  assert.deepEqual(await fs.readdir(napDir), beforeAmbiguous, 'ambiguity is rejected before creating a lock or backup');
  const otherBefore = await fs.readFile(accountFile, 'utf8');
  await configureProtocolConnection({ ...napOptions, account: '23456' });
  assert.equal(await fs.readFile(accountFile, 'utf8'), otherBefore);
  assert.equal((await read(secondFile)).untouched, true);
  assert.deepEqual(await protocolAccounts(napRoot, 'napcat/config', 'napcat'), ['12345', '23456']);
  const rememberedBeforeTemplate = await Promise.all([accountFile, secondFile].map(file => fs.readFile(file, 'utf8')));
  const genericOptions = { ...napOptions, templateOnly: true, httpPort: 13100, wsPort: 13101, token: 'separate-new-login-template-token' };
  result = await configureProtocolConnection(genericOptions);
  assert.deepEqual(result.changedFiles, [napGlobal], 'explicit generic setup changes only the global login template');
  assert.deepEqual(await Promise.all([accountFile, secondFile].map(file => fs.readFile(file, 'utf8'))), rememberedBeforeTemplate, 'no remembered QQ listener or credential changes');
  assert.equal((await read(napGlobal)).network.httpServers[0].port, 13100);
  assert.deepEqual((await configureProtocolConnection(genericOptions)).changedFiles, [], 'template setup remains idempotent');
  const beforeInvalidTemplate = await fs.readdir(napDir);
  for (const templateOnly of ['true', 1, null, {}, []]) await assert.rejects(configureProtocolConnection({ ...napOptions, templateOnly }), /必须为开关/);
  await assert.rejects(configureProtocolConnection({ ...genericOptions, account: '12345' }), /不能同时指定/);
  assert.deepEqual(await fs.readdir(napDir), beforeInvalidTemplate, 'invalid template intent writes no lock or backup');
  await configureProtocolConnection({ ...napOptions, account: '34567' });
  assert.ok((await protocolAccounts(napRoot, 'napcat/config', 'napcat')).includes('34567'));
  assert.equal((await read(path.join(napDir, 'onebot11_34567.json'))).network.httpServers[0].token, token);

  const snowRoot = await makeRoot('snow');
  await fs.mkdir(path.join(snowRoot, 'config'));
  const snowGlobal = path.join(snowRoot, 'config', 'onebot.json');
  const snowAccount = path.join(snowRoot, 'config', 'onebot_12345.json');
  await write(snowGlobal, { legacyGlobal: true, networks: { wsServers: [{ name: 'global-other', port: 4568 }] } });
  await write(snowAccount, { mode: 'snapshot', historySync: { enabled: true }, networks: {
    wsServers: [{ name: 'account-other', port: 4569 }, { name: 'qq-agent-ws', custom: 'keep' }],
    httpClients: [{ name: 'reporter', url: 'http://example.invalid' }],
  } });
  const snowOptions = options(snowRoot, 'snowluma');
  const snowGlobalBefore = await fs.readFile(snowGlobal, 'utf8');
  await configureProtocolConnection(snowOptions);
  const snowConfigured = await read(snowAccount);
  assert.equal(snowConfigured.mode, 'snapshot');
  assert.equal(snowConfigured.historySync.enabled, true);
  assert.equal(snowConfigured.networks.wsServers[0].name, 'account-other');
  assert.equal(snowConfigured.networks.wsServers[1].custom, 'keep');
  assert.equal(snowConfigured.networks.wsServers[1].enabled, true);
  assert.equal(snowConfigured.networks.wsServers[1].accessToken, token);
  assert.equal(snowConfigured.networks.wsServers[1].role, 'Universal');
  assert.equal(snowConfigured.networks.wsServers[1].path, '/');
  assert.equal(snowConfigured.networks.httpServers[0].messageFormat, 'array');
  assert.equal(snowConfigured.networks.httpClients[0].name, 'reporter');
  assert.equal(snowConfigured.network, undefined);
  assert.equal(await fs.readFile(snowGlobal, 'utf8'), snowGlobalBefore);
  assert.ok(!(await fs.readdir(path.join(snowRoot, 'config'))).some(name => /consent|runtime|webui/.test(name)));
  await configureProtocolConnection({ ...snowOptions, account: '23456' });
  assert.equal((await read(path.join(snowRoot, 'config', 'onebot_23456.json'))).legacyGlobal, true,
    'a new account materializes its global template without discarding unrelated settings');
  assert.equal((await read(path.join(snowRoot, 'config', 'onebot_23456.json'))).networks.wsServers[0].name, 'global-other');
  const snowSaved = [snowAccount, path.join(snowRoot, 'config', 'onebot_23456.json')], snowSavedBefore = await Promise.all(snowSaved.map(file => fs.readFile(file, 'utf8')));
  result = await configureProtocolConnection({ ...snowOptions, templateOnly: true, httpPort: 13200, wsPort: 13201 });
  assert.deepEqual(result.changedFiles, [snowGlobal]);
  assert.deepEqual(await Promise.all(snowSaved.map(file => fs.readFile(file, 'utf8'))), snowSavedBefore, 'Snow generic setup cannot modify saved account snapshots');
  assert.equal((await read(snowGlobal)).legacyGlobal, true);
  assert.equal((await read(snowGlobal)).networks.wsServers.find(row => row.name === 'qq-agent-ws').port, 13201);

  const brokenRoot = await makeRoot('broken');
  await fs.mkdir(path.join(brokenRoot, 'config'));
  const brokenFile = path.join(brokenRoot, 'config', 'onebot.json');
  await fs.writeFile(brokenFile, '{invalid');
  await assert.rejects(configureProtocolConnection(options(brokenRoot, 'snowluma')), /有效 JSON/);
  assert.equal(await fs.readFile(brokenFile, 'utf8'), '{invalid');
  assert.deepEqual(await fs.readdir(path.dirname(brokenFile)), ['onebot.json']);
  await write(brokenFile, { networks: { httpServers: 'invalid' } });
  await assert.rejects(configureProtocolConnection(options(brokenRoot, 'snowluma')), /不是数组/);
  await write(brokenFile, []);
  await assert.rejects(configureProtocolConnection(options(brokenRoot, 'snowluma')), /根节点不是对象/);

  const linkedRoot = await makeRoot('linked');
  const outside = await makeRoot('link-target');
  await fs.symlink(outside, path.join(linkedRoot, 'config'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(configureProtocolConnection(options(linkedRoot)), /普通目录/);
  assert.deepEqual(await fs.readdir(outside), [], 'a directory link must not be followed');
  await assert.rejects(protocolAccounts(linkedRoot, 'config', 'napcat'), /普通目录/);
  const linkedProvider = path.join(temporaryRoot, 'linked-provider');
  await fs.symlink(outside, linkedProvider, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(configureProtocolConnection(options(linkedProvider)), /普通目录/);
  const wrongAccountRoot = await makeRoot('directory-as-account');
  await fs.mkdir(path.join(wrongAccountRoot, 'config'));
  await fs.mkdir(path.join(wrongAccountRoot, 'config', 'onebot11_12345.json'));
  await assert.rejects(configureProtocolConnection(options(wrongAccountRoot)), /账号配置不是普通文件/);
  assert.deepEqual(await fs.readdir(path.join(wrongAccountRoot, 'config')), ['onebot11_12345.json']);
  const fileLinkRoot = await makeRoot('file-link');
  await fs.mkdir(path.join(fileLinkRoot, 'config'));
  const targetFile = path.join(outside, 'untouched.json');
  await write(targetFile, { untouched: true });
  try {
    await fs.symlink(targetFile, path.join(fileLinkRoot, 'config', 'onebot11.json'), 'file');
    await assert.rejects(configureProtocolConnection(options(fileLinkRoot)), /非普通配置文件/);
    assert.deepEqual(await read(targetFile), { untouched: true });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('File symlink creation unavailable; directory junction refusal was verified.');
  }

  const parallelRoot = await makeRoot('parallel');
  await Promise.all([configureProtocolConnection(options(parallelRoot)),
    configureProtocolConnection({ ...options(parallelRoot), httpPort: 14000, wsPort: 14001 })]);
  const parallel = await read(path.join(parallelRoot, 'config', 'onebot11.json'));
  assert.equal(parallel.network.httpServers[0].port, 14000);
  assert.equal(parallel.network.websocketServers[0].port, 14001);
  assert.ok(!(await fs.readdir(path.join(parallelRoot, 'config'))).some(name => /\.tmp$|\.lock$/.test(name)));
  await fs.writeFile(path.join(parallelRoot, 'config', '.qq-agent-connection.lock'), 'another-process');
  await assert.rejects(configureProtocolConnection(options(parallelRoot)), /另一项/);
  assert.equal(await fs.readFile(path.join(parallelRoot, 'config', '.qq-agent-connection.lock'), 'utf8'), 'another-process');

  for (const patch of [{ configDir: '../outside' }, { configDir: '/config' }, { configDir: 'config/NUL' },
    { httpPort: 0 }, { wsPort: 13000 }, { token: '' }, { token: 'with\nnewline' }, { account: '../1' }]) {
    await assert.rejects(configureProtocolConnection({ ...options(napRoot), ...patch }), error => {
      assert.equal(error.status, 400); assert.equal(error.expose, true); return true;
    });
  }
  await assert.rejects(configureProtocolConnection(options(path.join(temporaryRoot, 'missing-root'))), error => {
    assert.equal(error.code, 'ENOENT'); assert.equal(error.expose, undefined); assert.equal(error.status, undefined); return true;
  });
  console.log('Protocol adapters: layout detection, account selection, preservation, backups, atomic writes, concurrency and link refusal passed.');
} finally {
  const resolved = path.resolve(temporaryRoot);
  assert.ok(resolved.startsWith(temporaryPrefix) && resolved !== path.resolve(os.tmpdir()));
  await fs.rm(resolved, { recursive: true, force: true });
}
