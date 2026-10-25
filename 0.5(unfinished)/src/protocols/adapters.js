import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const queues = new Map();
const ownNames = { http: 'qq-agent-http', ws: 'qq-agent-ws' };

/** Inspect names only; this does not authenticate an archive or execute its contents. */
export function detectProtocolLayouts(paths, { platform = process.platform, arch = process.arch } = {}) {
  const names = new Set((Array.isArray(paths) ? paths : []).filter(name => typeof name === 'string'
    && name && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/')
    && !name.split('/').some(part => part === '..' || part === '.' || part.includes(':')))
    .map(name => name.replace(/\/$/, '')));
  const candidates = [];
  const at = (root, file) => names.has(root ? `${root}/${file}` : file);
  const rootsFor = suffix => [...names].filter(name => name === suffix || name.endsWith(`/${suffix}`))
    .map(name => name.slice(0, -suffix.length).replace(/\/$/, ''));
  const add = (provider, variant, root, entry, ready, reason, configDir) => {
    const prefix = [root, configDir, provider === 'napcat' ? 'onebot11_' : 'onebot_'].filter(Boolean).join('/');
    const accounts = [...names].filter(name => name.startsWith(prefix))
      .map(name => name.slice(prefix.length).match(/^([0-9]+)\.json$/)?.[1]).filter(Boolean).sort(compareAccounts);
    candidates.push({ provider, variant, root, entry, executable: platform === 'win32' ? 'node.exe' : 'node',
      ready, reason, configDir, accounts, webUiPort: provider === 'napcat' ? 6099 : 5099 });
  };
  const napNodeRoots = rootsFor('napcat/napcat.mjs').filter(root => at(root, 'index.js') || at(root, 'napcat.bat'));
  for (const root of napNodeRoots) {
    const missing = ['node.exe', 'index.js', 'wrapper.node', 'QQNT.dll', 'package.json', 'config.json']
      .filter(file => !at(root, file));
    const compatible = platform === 'win32' && arch === 'x64';
    add('napcat', 'node', root, 'index.js', compatible && !missing.length,
      !compatible ? '此 NapCat Node 发行包仅支持 Windows x64。'
        : missing.length ? `NapCat Node 发行包不完整，缺少：${missing.join('、')}` : '', 'napcat/config');
  }
  for (const root of rootsFor('napcat.mjs')) {
    if (napNodeRoots.some(parent => root === (parent ? `${parent}/napcat` : 'napcat'))) continue;
    if (at(root, 'NapCatWinBootMain.exe') || at(root, 'launcher-user.bat')) {
      add('napcat', 'shell', root, 'launcher-user.bat', false,
        '这是依赖已安装 QQ 的 Shell 包；请使用上游启动器，或放入 Windows.Node 完整发行包。', 'config');
    } else if (at(root, 'napcat.cjs') && at(root, 'nativeLoader.cjs') && at(root, 'preload.cjs')) {
      add('napcat', 'shell', root, '', false, '这是框架插件包，不能作为独立协议端直接运行。', 'config');
    }
  }
  for (const root of rootsFor('NapCatInstaller.exe')) {
    if (!candidates.some(item => item.provider === 'napcat' && item.root === root)) {
      add('napcat', 'shell', root, '', false, '这是一键安装器；请先自行安装，或放入 Windows.Node 完整发行包。', 'config');
    }
  }
  for (const root of rootsFor('index.mjs')) {
    const triple = `${platform}-${arch}`;
    // release.json and the native manifest distinguish release packages from arbitrary Node projects.
    if (!at(root, 'release.json') || !at(root, 'package.json')
      || ![...names].some(name => name.startsWith(root ? `${root}/native/snowluma-` : 'native/snowluma-'))) continue;
    const native = platform === 'win32'
      ? [`native/snowluma-${triple}.dll`, `native/snowluma-${triple}.node`]
      : [`native/snowluma-${triple}.so`, `native/snowluma-${triple}.node`];
    const sqliteFiles = platform === 'linux'
      ? ['@appthreat+sqlite3.glibc.node', '@appthreat+sqlite3.musl.node'] : ['@appthreat+sqlite3.node'];
    const required = ['check-node-version.cjs', 'EULA.md', 'PRIVACY.md', 'client/index.html',
      'native/sqlite/manifest.json', 'native/sqlite/LICENSE.sqlite3',
      ...native, `native/websocket-${triple}.node`, `native/ffmpeg/ffmpegAddon.${platform}.${arch}.node`,
      ...sqliteFiles.map(file => `native/sqlite/prebuilds/${triple}/${file}`)];
    const missing = required.filter(file => !at(root, file));
    const executable = platform === 'win32' ? 'node.exe' : 'node';
    const bundled = at(root, executable);
    const compatible = (platform === 'win32' && arch === 'x64')
      || (platform === 'linux' && ['x64', 'arm64'].includes(arch));
    add('snowluma', bundled ? 'node' : 'lite', root, 'index.mjs', compatible && bundled && !missing.length,
      !compatible ? '该平台暂不支持本地托管 SnowLuma。'
        : missing.length ? `SnowLuma 发行包不完整或架构不匹配，缺少：${missing.join('、')}`
          : !bundled ? '这是 Lite 包，未包含 Node.js；请放入对应平台的完整发行包。' : '', 'config');
  }
  for (const [provider, suffix, required] of [
    ['napcat', 'packages/napcat-shell/napcat.ts', ['package.json', 'packages/napcat-onebot/config/config.ts']],
    ['snowluma', 'packages/core/src/index.ts', ['package.json', 'packages/onebot/src/config.ts', 'packages/runtime/package.json']],
  ]) {
    for (const root of rootsFor(suffix)) {
      if (required.every(file => at(root, file)) && !candidates.some(item => item.provider === provider && item.root === root)) {
        add(provider, 'source', root, '', false, '这是源代码，尚未构建；请下载 Releases 中的完整发行包。', 'config');
      }
    }
  }
  return candidates.sort((a, b) => a.root.localeCompare(b.root) || a.provider.localeCompare(b.provider));
}

const digest = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const noFollow = constants.O_NOFOLLOW || 0;
const compareAccounts = (a, b) => a.length - b.length || a.localeCompare(b);
// Only deliberately classified validation errors are exposed to the settings
// page. Native filesystem failures and unexpected exceptions retain HTTP 500.
const invalid = message => Object.assign(new Error(message), { status: 400, expose: true });

function validateLocation({ provider, root, configDir }) {
  if (!['napcat', 'snowluma'].includes(provider)) throw invalid('不支持的协议端');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw invalid('协议端根目录必须是绝对路径');
  if (typeof configDir !== 'string' || !configDir || configDir.includes('\\')
    || configDir.split('/').some(part => !/^[A-Za-z0-9_-]+$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part))) throw invalid('无效的协议端配置目录');
}

/** Read only; missing configuration directories mean that no account has been configured yet. */
export async function protocolAccounts(root, configDir, provider) {
  validateLocation({ provider, root, configDir });
  await assertDirectory(root);
  let directory = root;
  for (const part of configDir.split('/')) {
    directory = path.join(directory, part);
    try { await assertDirectory(directory); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  const prefix = provider === 'napcat' ? 'onebot11' : 'onebot';
  const matcher = new RegExp(`^${prefix}_([0-9]+)\\.json$`);
  const accounts = [];
  for (const name of await fs.readdir(directory)) {
    const match = matcher.exec(name);
    if (!match) continue;
    const stat = await fs.lstat(path.join(directory, name));
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid(`账号配置不是普通文件：${name}`);
    accounts.push(match[1]);
  }
  return accounts.sort(compareAccounts);
}

function selectedAccount(accounts, account, templateOnly = false) {
  if (account !== undefined && (typeof account !== 'string' || !/^[0-9]+$/.test(account))) {
    throw invalid('QQ 账号必须是纯数字字符串');
  }
  if (templateOnly) {
    if (account !== undefined) throw invalid('通用连接模板不能同时指定 QQ 账号');
    return undefined;
  }
  if (account !== undefined) return account;
  if (accounts.length > 1) throw invalid('发现多个 QQ 账号，请先选择要连接的账号');
  return accounts[0];
}

async function assertDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid(`协议端配置路径不是普通目录：${directory}`);
}

async function ensureConfigDirectory(root, relative) {
  await assertDirectory(root);
  let directory = root;
  for (const part of relative.split('/')) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await assertDirectory(directory);
  }
  return directory;
}

async function readRegular(file, { missing = false } = {}) {
  let before;
  try { before = await fs.lstat(file); } catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw invalid(`拒绝读取非普通配置文件：${file}`);
  const handle = await fs.open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(file);
    if (after.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino
      || after.dev !== opened.dev || after.ino !== opened.ino) throw invalid(`配置文件在读取期间发生变化：${file}`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function writeExclusive(file, text) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

function mergeService(list, name, desired) {
  if (list !== undefined && !Array.isArray(list)) throw invalid(`连接列表不是数组：${name}`);
  let found = false;
  const result = [];
  for (const item of list || []) {
    if (isObject(item) && item.name === name) {
      if (!found) result.push({ ...item, ...desired, name });
      found = true;
    } else result.push(item);
  }
  if (!found) result.push({ name, ...desired });
  return result;
}

export function mergeProtocolConnection(document, { provider, httpPort, wsPort, token }) {
  if (!isObject(document) || !['napcat', 'snowluma'].includes(provider)) throw invalid('无效的协议端连接配置');
  if (![httpPort, wsPort].every(port => Number.isInteger(port) && port > 0 && port < 65536) || httpPort === wsPort) throw invalid('HTTP 与 WebSocket 必须使用两个不同的有效端口');
  if (typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw invalid('连接令牌无效');
  const key = provider === 'napcat' ? 'network' : 'networks';
  if (document[key] !== undefined && !isObject(document[key])) throw invalid(`${key} 不是配置对象`);
  const networks = { ...(document[key] || {}) };
  const common = provider === 'napcat'
    ? { enable: true, host: '127.0.0.1', messagePostFormat: 'array', token, reportSelfMessage: false }
    : { enabled: true, host: '127.0.0.1', messageFormat: 'array', accessToken: token, reportSelfMessage: false, path: '/' };
  networks.httpServers = mergeService(networks.httpServers, ownNames.http, { ...common, port: httpPort });
  const wsKey = provider === 'napcat' ? 'websocketServers' : 'wsServers';
  networks[wsKey] = mergeService(networks[wsKey], ownNames.ws,
    { ...common, port: wsPort, ...(provider === 'snowluma' ? { role: 'Universal' } : {}) });
  return { ...document, [key]: networks };
}

/**
 * The caller must stop this protocol process before configuring it and validate root ownership.
 * Only this adapter's named connections are merged. Package code, consent and login state are untouched.
 */
export async function configureProtocolConnection(options) {
  const { provider, root, configDir, httpPort, wsPort, token } = options || {};
  validateLocation({ provider, root, configDir });
  if (options.templateOnly !== undefined && typeof options.templateOnly !== 'boolean') throw invalid('通用连接模板设置必须为开关');
  if (![httpPort, wsPort].every(port => Number.isInteger(port) && port > 0 && port < 65536)
    || httpPort === wsPort) throw invalid('HTTP 与 WebSocket 必须使用两个不同的有效端口');
  if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) {
    throw invalid('连接令牌不能为空或包含空白控制字符');
  }
  const absoluteRoot = path.resolve(root);
  // Refuse ambiguous multi-account writes before creating even a lock file.
  selectedAccount(await protocolAccounts(absoluteRoot, configDir, provider), options.account, options.templateOnly);
  const key = path.resolve(absoluteRoot, configDir);
  const queueKey = process.platform === 'win32' ? key.toLowerCase() : key;
  const previous = queues.get(queueKey) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => configureLocked({ ...options, root: absoluteRoot }));
  queues.set(queueKey, operation);
  try { return await operation; } finally { if (queues.get(queueKey) === operation) queues.delete(queueKey); }
}

async function configureLocked(options) {
  const { provider, root, configDir, httpPort, wsPort, token } = options;
  const directory = await ensureConfigDirectory(root, configDir);
  const lock = path.join(directory, '.qq-agent-connection.lock');
  const identity = `${process.pid}-${randomBytes(12).toString('hex')}`;
  try { await writeExclusive(lock, identity); } catch (error) {
    if (error.code === 'EEXIST') throw invalid('另一项协议端配置操作正在进行，请稍后重试');
    throw error;
  }
  const staged = [];
  const committed = [];
  try {
    const prefix = provider === 'napcat' ? 'onebot11' : 'onebot';
    const account = selectedAccount(await protocolAccounts(root, configDir, provider), options.account, options.templateOnly);
    const files = [account === undefined ? `${prefix}.json` : `${prefix}_${account}.json`];
    for (const name of files) {
      const file = path.join(directory, name);
      const original = await readRegular(file, { missing: true });
      // Materialize a new account from its global template, just as the providers do on first login.
      const templateName = `${prefix}.json`;
      const template = original === null && account !== undefined
        ? await readRegular(path.join(directory, templateName), { missing: true }) : null;
      const source = original ?? template;
      const sourceName = original === null && template !== null ? templateName : name;
      let document = {};
      try { document = source === null ? {} : JSON.parse(source); } catch {
        throw invalid(`配置文件不是有效 JSON，未覆盖：${sourceName}`);
      }
      if (!isObject(document)) throw invalid(`配置文件根节点不是对象，未覆盖：${sourceName}`);
      const next = mergeProtocolConnection(document, options);
      if (original !== null && JSON.stringify(document) === JSON.stringify(next)) continue;
      staged.push({ file, name, original, text: `${JSON.stringify(next, null, 2)}\n`, temporary: null });
    }
    // Validate every document before writing any replacement or backup.
    for (const item of staged) {
      await ensureConfigDirectory(root, configDir);
      item.temporary = path.join(directory, `.${item.name}.${identity}.tmp`);
      await writeExclusive(item.temporary, item.text);
    }
    for (const item of staged) {
      const current = await readRegular(item.file, { missing: true });
      if (current !== item.original) throw invalid(`配置文件已被其他程序修改，未覆盖：${item.name}`);
      if (item.original !== null) {
        const backup = path.join(directory, `${item.name}.qq-agent-${Date.now()}-${randomBytes(6).toString('hex')}.bak`);
        await writeExclusive(backup, item.original);
      }
    }
    for (const item of staged) {
      await ensureConfigDirectory(root, configDir);
      const current = await readRegular(item.file, { missing: true });
      if (current !== item.original) throw invalid(`配置文件已被其他程序修改，未覆盖：${item.name}`);
      await fs.rename(item.temporary, item.file);
      item.temporary = null;
      committed.push(item);
    }
    return { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}`,
      accessToken: token, httpAccessToken: token, changedFiles: staged.map(item => item.file) };
  } catch (error) {
    const rollbackErrors = [];
    for (const item of committed.reverse()) {
      try {
        await ensureConfigDirectory(root, configDir);
        const current = await readRegular(item.file);
        // Do not undo a concurrent edit made after our replacement.
        if (digest(current) !== digest(item.text)) throw new Error(`回滚时配置已变化：${item.name}`);
        if (item.original === null) await fs.unlink(item.file);
        else {
          const temporary = path.join(directory, `.${item.name}.${identity}.rollback`);
          await writeExclusive(temporary, item.original);
          await fs.rename(temporary, item.file);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '配置失败；部分文件未能自动回滚，请使用备份恢复');
    throw error;
  } finally {
    for (const item of staged) if (item.temporary) await fs.unlink(item.temporary).catch(() => {});
    // Never remove a lock replaced by another actor.
    const currentLock = await readRegular(lock).catch(() => null);
    if (currentLock === identity) await fs.unlink(lock).catch(() => {});
  }
}
