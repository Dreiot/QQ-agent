import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { safeFetch } from '../../src/kernel/safe-fetch.js';
import { APP_ROOT } from '../../src/kernel/env.js';

export const COMMUNITY_BASE_URL = 'https://www.kondius.cn/api/community';
export const MARKET_MAX_ZIP_BYTES = 8 * 1024 * 1024;
export const MARKET_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MARKET_MAX_FILES = 100;
export const MARKET_MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const ACCOUNT_FILE = 'account.json';
const BLOCKLIST_FILE = 'cloud-global-blocklist.json';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const QQ_ID = /^\d{1,15}$/;
const BLOCKLIST_WRITE_BUDGET = 20_000;
const INSTALL_CODE = /^[A-Z0-9]{4,12}$/;
const EXECUTABLE = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

function atomicJson(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fsImpl.renameSync(tmp, file);
}

function readJson(file, fallback, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function normalizedIds(value) {
  // A read never truncates existing data. The write budget is checked before
  // adding new IDs, not enforced by silently dropping a different person's ID.
  return [...new Set((Array.isArray(value) ? value : []).map((item) => {try{return String(item).trim();}catch{return '';}}).filter((id) => QQ_ID.test(id)))].sort((a, b) => a.localeCompare(b));
}

function assertBlocklistBudget(before, after) {
  const previous=new Set(normalizedIds(before)),next=new Set(normalizedIds(after));
  if(next.size>BLOCKLIST_WRITE_BUDGET&&[...next].some(id=>!previous.has(id)))throw Object.assign(new Error(`名单增量超出 ${BLOCKLIST_WRITE_BUDGET} 项安全预算；没有裁剪已保存号码，请先明确删除条目`),{status:400,expose:true});
}
function patchBlocklistStorage(value,changes,{exempt=false}={}) {
  if(value!==undefined&&!Array.isArray(value))throw Object.assign(new Error('名单原始结构异常；请在高级配置中明确处理，未清洗历史数据'),{status:400,expose:true});
  const original=value??[];let next=[...original];
  const represents=(entry,uid)=>{try{return String(entry).trim()===uid;}catch{return false;}};
  const canonical=entry=>(typeof entry==='string'||typeof entry==='number')&&QQ_ID.test(String(entry));
  for(const item of changes){
    const include=exempt?!item.blocked:item.blocked;
    if(include){if(!next.some(entry=>represents(entry,item.uid)))next.push(item.uid);}
    else{
      if(next.some(entry=>represents(entry,item.uid)&&!canonical(entry)))throw Object.assign(new Error(`${item.uid} 由异常历史条目表示；请在高级配置中明确处理，未清洗原条目`),{status:400,expose:true});
      next=next.filter(entry=>!represents(entry,item.uid));
    }
  }
  assertBlocklistBudget(original,next);return next;
}

function accountsView(accounts) {
  return accounts.filter((item) => typeof item?.username === 'string' && typeof item?.token === 'string' && item.token).map(({ username, savedAt }) => ({ username, savedAt: Number(savedAt) || 0 }));
}

function accountRecord(accounts, username) {
  return accounts.find((item) => item.username === username && typeof item.token === 'string' && item.token) ?? null;
}

function publicFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.filter((field) => ['string', 'number', 'boolean'].includes(typeof value[field])).map((field) => [field, value[field]]));
}

function publicAccount(account) {
  return publicFields(account, ['id', 'loginId', 'username', 'displayName', 'createdAt']);
}

function publicItem(item) {
  return publicFields(item, ['code', 'ok', 'id', 'name', 'title', 'description', 'category', 'categoryName', 'version', 'author', 'createdAt', 'updatedAt', 'type', 'status', 'installCode', 'size']);
}

function textBody(response, fallback) {
  try { return JSON.parse(response.body); } catch { throw new Error(fallback); }
}

function zipError(message) {
  const error = new Error(message);
  error.status = 502;
  error.expose = true;
  return error;
}

function safeZipName(name) {
  const normalized = String(name ?? '').replaceAll('\\', '/');
  const parts = normalized.replace(/\/$/, '').split('/');
  if (!normalized || normalized.startsWith('/') || /[\x00-\x1f\x7f:]/.test(normalized) || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw zipError('安装包含不安全路径');
  return normalized;
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw zipError('安装包不是有效 ZIP');
  const endStart = Math.max(0, buffer.length - 0xffff - 22);
  let end = -1;
  for (let i = buffer.length - 22; i >= endStart; i--) if (buffer.readUInt32LE(i) === ZIP_END) { end = i; break; }
  if (end < 0) throw zipError('安装包缺少 ZIP 目录');
  const entries = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (entries > MARKET_MAX_FILES) throw zipError(`文件数量过多（>${MARKET_MAX_FILES}）`);
  let offset = centralOffset;
  const result = [];
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) throw zipError('安装包 ZIP 目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 1) throw zipError('安装包包含加密文件');
    if (![0, 8].includes(method)) throw zipError('安装包包含不支持的压缩方式');
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw zipError('安装包 ZIP 文件名损坏');
    const name = safeZipName(buffer.toString('utf8', offset + 46, nameEnd));
    const unixType = (external >>> 16) & 0o170000;
    if (unixType === 0o120000) throw zipError(`安装包包含符号链接：${name}`);
    if (EXECUTABLE.test(name)) throw zipError(`安装包包含可执行文件：${name}`);
    if (size > MARKET_MAX_FILE_BYTES) throw zipError(`安装包单文件超过 ${MARKET_MAX_FILE_BYTES / 1024 / 1024}MB 上限`);
    if (size > MARKET_MAX_UNPACKED_BYTES) throw zipError(`安装包单文件超过 ${MARKET_MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限`);
    total += size;
    if (total > MARKET_MAX_UNPACKED_BYTES) throw zipError(`安装包解压后超过 ${MARKET_MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限`);
    if (compressedSize > MARKET_MAX_ZIP_BYTES || size > MARKET_MAX_FILE_BYTES) throw zipError(`安装包文件大小声明无效：${name}`);
    result.push({ name, flags, method, crc, compressedSize, size, localOffset, directory: name.endsWith('/') });
    offset = nameEnd + extraLength + commentLength;
  }
  return result;
}

function archiveContent(buffer, entry) {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== ZIP_LOCAL) throw zipError(`ZIP 本地头损坏：${entry.name}`);
  const localFlags = buffer.readUInt16LE(at + 6);
  const localMethod = buffer.readUInt16LE(at + 8);
  const localCompressedSize = buffer.readUInt32LE(at + 18);
  const localSize = buffer.readUInt32LE(at + 22);
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const localName = buffer.toString('utf8', at + 30, at + 30 + nameLength);
  if (localName !== entry.name || localMethod !== entry.method || Boolean(localFlags & 1) !== Boolean(entry.flags & 1)) throw zipError(`ZIP 本地头与目录不一致：${entry.name}`);
  if (!(localFlags & 8) && (localCompressedSize !== entry.compressedSize || localSize !== entry.size)) throw zipError(`ZIP 文件大小声明不一致：${entry.name}`);
  const start = at + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > buffer.length || end > buffer.length) throw zipError(`ZIP 数据越界：${entry.name}`);
  const compressed = buffer.subarray(start, end);
  let data;
  try {
    data = entry.method === 0
      ? compressed
      : zlib.inflateRawSync(compressed, { maxOutputLength: entry.size });
  } catch { throw zipError(`ZIP 解压失败或超过单文件上限：${entry.name}`); }
  if (data.length !== entry.size) throw zipError(`ZIP 文件大小不匹配：${entry.name}`);
  if (crc32(data) !== entry.crc) throw zipError(`ZIP 文件校验失败：${entry.name}`);
  return data;
}

function stripCommonRoot(entries) {
  const files = entries.filter((entry) => !entry.directory);
  if (!files.length) throw zipError('安装包不包含文件');
  const paths = files.map((entry) => entry.name.split('/'));
  const prefix = [];
  // Old exports can wrap an extension twice. Strip only directory segments
  // shared by every file; mixed packages never select an arbitrary manifest.
  while (paths.every(parts => parts.length > prefix.length + 1 && parts[prefix.length] === paths[0][prefix.length])) prefix.push(paths[0][prefix.length]);
  return prefix.length ? prefix.join('/') : null;
}

export function extractZipSafely(buffer, destinationRoot, { fsImpl = fs } = {}) {
  const entries = readZipEntries(buffer);
  const root = stripCommonRoot(entries);
  const temp = path.join(destinationRoot, `.market-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  fsImpl.mkdirSync(temp, { recursive: false });
  try {
    for (const entry of entries) {
      let relative = entry.name;
      if (root && relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1);
      if (!relative || entry.directory) continue;
      const destination = path.resolve(temp, ...relative.split('/'));
      const rel = path.relative(temp, destination);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw zipError(`安装包路径越界：${entry.name}`);
      fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
      fsImpl.writeFileSync(destination, archiveContent(buffer, entry), { flag: 'wx' });
    }
    return temp;
  } catch (err) {
    fsImpl.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function collectPublishFiles(dir, fsImpl = fs) {
  const files = [];
  let total = 0;
  const walk = (current, prefix = '') => {
    for (const name of fsImpl.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fsImpl.lstatSync(full);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (stat.isSymbolicLink()) throw zipError(`发布目录包含符号链接：${relative}`);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile()) {
        if (EXECUTABLE.test(name)) throw zipError(`发布目录包含可执行文件：${relative}`);
        const data = fsImpl.readFileSync(full);
        if (data.length > MARKET_MAX_FILE_BYTES) throw zipError(`发布单文件超过 ${MARKET_MAX_FILE_BYTES / 1024 / 1024}MB 上限`);
        total += data.length;
        if (total > MARKET_MAX_UNPACKED_BYTES) throw zipError(`发布目录总量超过 ${MARKET_MAX_UNPACKED_BYTES / 1024 / 1024}MB 上限`);
        files.push({ name: safeZipName(relative), data });
      }
    }
  };
  walk(dir);
  if (files.length > MARKET_MAX_FILES) throw zipError(`文件数量过多（>${MARKET_MAX_FILES}）`);
  return files;
}

export function createStoredZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(ZIP_LOCAL, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(ZIP_CENTRAL, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += header.length + name.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

export function createCommunityMarketAdapters({ dataDir, config, fetchImpl = fetch, dnsLookup, appRoot = APP_ROOT, extensionRoot = appRoot, communityKey, fsImpl = fs, installZip, signal = () => null } = {}) {
  const cacheFile = path.join(dataDir, BLOCKLIST_FILE);
  const accountsFile = path.join(dataDir, ACCOUNT_FILE);
  const request = async (pathname, { method = 'GET', headers = {}, body, timeoutMs = 30_000, maxBytes = MARKET_MAX_ZIP_BYTES, followRedirects = true, requestSignal = signal() } = {}) => {
    const url = new URL(pathname.replace(/^\//, ''), `${COMMUNITY_BASE_URL}/`).toString();
    const response = await safeFetch(url, {
      method, headers, body, timeoutMs, maxBytes, followRedirects, expectBinary: true, browseLocked: true,
      allowedHosts: ['www.kondius.cn'], fetchImpl, dnsLookup, signal: requestSignal,
    });
    return response;
  };
  const key = () => {
    if (typeof communityKey === 'function') return String(communityKey() ?? '').trim();
    if (communityKey !== undefined) return String(communityKey ?? '').trim();
    if (process.env.QQ_AGENT_COMMUNITY_KEY !== undefined) return String(process.env.QQ_AGENT_COMMUNITY_KEY ?? '').trim();
    try { return fsImpl.readFileSync(path.join(appRoot, 'community.key'), 'utf8').trim(); } catch { return ''; }
  };
  const accounts = () => {
    const parsed = readJson(accountsFile, { accounts: [] }, fsImpl);
    return Array.isArray(parsed?.accounts) ? parsed.accounts.filter((item) => item && typeof item === 'object') : [];
  };
  const saveAccounts = (items) => atomicJson(accountsFile, { accounts: items }, fsImpl);
  let remotePreview = null;
  const cacheSnapshot = () => {
    try { const signature=fsImpl.readFileSync(cacheFile,'utf8');return{data:JSON.parse(signature),signature}; }
    catch { return{data:{ids:[]},signature:null}; }
  };
  const cloudIds = () => {
    const disk = cacheSnapshot();
    // A non-persisting synchronization stays fresh in this client instance.
    // External cache replacement invalidates it; local config is always read
    // afresh by effective(), including local additions and exemptions.
    if (remotePreview && remotePreview.cacheSignature === disk.signature) return remotePreview.ids;
    remotePreview = null;
    return normalizedIds(disk.data?.ids);
  };
  const saveCloud = (ids) => { atomicJson(cacheFile, { ids: normalizedIds(ids), fetchedAt: Date.now() }, fsImpl); remotePreview = null; };
  const effective = () => {
    const cfg = config.get();
    const exemptions = new Set(normalizedIds(cfg.communityExemptions));
    return [...new Set([...cloudIds(), ...normalizedIds(cfg.globalBlocklist)])].filter((id) => !exemptions.has(id));
  };

  // All entry points share this queue. A UI lock cannot protect the community
  // panel, settings panel and background synchronization from one another.
  const membershipSource = crypto.randomUUID();
  let blocklistTail = Promise.resolve();
  const serializeBlocklist = (action) => {
    const result = blocklistTail.then(action, action);
    blocklistTail = result.catch(() => {});
    return result;
  };
  const membershipRevision = (cloud, local, exempt) => crypto.createHash('sha256').update(JSON.stringify([cloud, local, exempt])).digest('hex');
  const membershipView = () => {
    const cfg = config.get(), cloud = new Set(cloudIds()), local = new Set(normalizedIds(cfg.globalBlocklist)), exempt = new Set(normalizedIds(cfg.communityExemptions));
    return {
      source: membershipSource, empty: membershipRevision(false, false, false),
      entries: [...new Set([...cloud, ...local, ...exempt])].sort((a,b)=>a.localeCompare(b)).map(uid => ({ uid, blocked: (cloud.has(uid) || local.has(uid)) && !exempt.has(uid), revision: membershipRevision(cloud.has(uid), local.has(uid), exempt.has(uid)) })),
    };
  };
  const blocklistView = () => ({ ok: true, ids: effective(), membership: membershipView(), remoteCAS: false });
  const blocklistError = (message, status) => Object.assign(new Error(message), { expose: true, status });
  const cancelledBlocklist = error => error?.name === 'AbortError' || ['PERMISSION_DENIED','CAPABILITY_REVOKED','CAPABILITY_MISSING'].includes(error?.code) || /授权|未声明权限|插件.*(?:停止|失效)/.test(String(error?.message ?? ''));

  function syncGlobalBlocklist({ pushLocal = true } = {}) { const operationSignal=signal(); return serializeBlocklist(async () => {
    try {
      if(operationSignal?.aborted)throw operationSignal.reason??new Error('社区客户端已停止');
      const response = await request('/blocklist', { method: 'GET',requestSignal:operationSignal });
      const payload = textBody(response, '云端屏蔽名单响应异常');
      if (response.status < 200 || response.status >= 300 || !Array.isArray(payload?.ids)) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      if (operationSignal?.aborted) throw operationSignal.reason ?? new Error('社区客户端已停止');
      if (pushLocal) saveCloud(payload.ids);
      else remotePreview = { ids: normalizedIds(payload.ids), cacheSignature: cacheSnapshot().signature };
      // Synchronization never uploads local IDs. Both modes expose the fresh
      // remote/local union minus the latest local exemptions.
      return blocklistView();
    } catch (err) {
      if(operationSignal?.aborted||cancelledBlocklist(err))throw operationSignal?.reason??err;
      // 网络失败沿用本地缓存，不清空已知名单
      return { ok: false, ids: effective(), error: String(err?.message ?? err) };
    }
  }); }

  function updateBlocklist(input = {}) { const operationSignal=signal(); return serializeBlocklist(async () => {
    if (operationSignal?.aborted) throw blocklistError('社区客户端已停止；未提交本机名单', 503);
    const blockRequest=(url,options={})=>{
      if(operationSignal?.aborted)throw blocklistError('社区客户端已停止；没有发起后续远端写入',503);
      return request(url,{...options,requestSignal:operationSignal});
    };
    const before = blocklistView(), revisionOf = (view, uid) => view.membership.entries.find(item => item.uid === uid)?.revision ?? view.membership.empty;
    const scoped = Array.isArray(input.changes), seen = new Set();
    let changes,legacyMode,legacyIncoming;
    if (scoped) {
      if (input.source !== membershipSource) throw blocklistError('全局名单来源已改变；草稿保留，请重新读取并比较', 409);
      if (!input.changes.length || input.changes.length > 64) throw blocklistError('需提供 1~64 项名单变更', 400);
      changes = input.changes.map(item => {
        if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['uid', 'blocked', 'expected'].includes(key)) || typeof item.uid !== 'string' || !QQ_ID.test(item.uid) || typeof item.blocked !== 'boolean' || typeof item.expected !== 'string' || seen.has(item.uid)) throw blocklistError('名单变更需为不同数字 QQ 号及原版本', 400);
        seen.add(item.uid);
        if (item.expected !== revisionOf(before, item.uid)) throw blocklistError(`${item.uid} 全局屏蔽已被其它操作修改；草稿保留`, 409);
        return { ...item };
      });
    } else {
      const mode = ['add', 'remove', 'replace'].includes(input.mode) ? input.mode : 'replace';
      const incoming = new Set(normalizedIds(input.ids));
      legacyMode=mode;legacyIncoming=incoming;
      // Explicit add also clears this UID's exemption, even when it is already
      // present in the remote cache. Unrelated exemptions remain untouched.
      const targets = mode === 'replace' ? new Set([...before.ids, ...incoming]) : incoming;
      changes = [...targets].map(uid => ({ uid, blocked: mode === 'remove' ? false : incoming.has(uid), expected: revisionOf(before, uid) }));
    }
    const checkStorage = current => ({globalBlocklist:patchBlocklistStorage(current.globalBlocklist,changes),communityExemptions:patchBlocklistStorage(current.communityExemptions,changes,{exempt:true})});
    // Reject a known over-budget increment before either remote or local writes.
    // Existing over-budget data remains readable and can be reduced explicitly.
    checkStorage(config.get());
    const remote = new Map(changes.map(item => [item.uid, 'unavailable']));
    let warning = '', uncertain = false, cacheIds = null;
    try {
      const adminKey = key();
      // Never describe an old cache as this request's remote receipt. A fresh
      // read also preserves remote-only IDs that appeared since our last sync.
      // The server has no CAS: another instance may still race its whole PUT.
      const observed = await blockRequest('/blocklist', { method: 'GET' });
      const observedPayload = textBody(observed, '云端屏蔽名单响应异常');
      if (observed.status < 200 || observed.status >= 300 || !Array.isArray(observedPayload?.ids)) throw new Error('云端名单未确认');
      cacheIds = normalizedIds(observedPayload.ids);
      if(!scoped&&legacyMode==='replace')for(const uid of cacheIds)if(!changes.some(item=>item.uid===uid)){
        changes.push({uid,blocked:legacyIncoming.has(uid),expected:revisionOf(before,uid)});remote.set(uid,'unavailable');
      }
      const cloudSet = new Set(cacheIds), desiredRemote = new Set(cacheIds);
      const additions = changes.filter(item => item.blocked && !cloudSet.has(item.uid)).map(item => item.uid);
      const removals = changes.filter(item => !item.blocked && cloudSet.has(item.uid)).map(item => item.uid);
      for (const item of changes) {
        if (cloudSet.has(item.uid) === item.blocked) remote.set(item.uid, 'confirmed');
        item.blocked ? desiredRemote.add(item.uid) : desiredRemote.delete(item.uid);
      }
      checkStorage(config.get());
      assertBlocklistBudget(cacheIds,[...desiredRemote]);
      let response;
      if (removals.length && adminKey) response = await blockRequest('/blocklist', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-community-key': adminKey }, body: JSON.stringify({ ids: normalizedIds([...desiredRemote]) }) });
      else if (additions.length) response = await blockRequest('/blocklist/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: additions }) });
      if (response) {
        const payload = textBody(response, '云端屏蔽名单响应异常');
        if (response.status < 200 || response.status >= 300 || !Array.isArray(payload?.ids)) {
          const rejectedKey = [401, 403].includes(response.status);
          if (!rejectedKey) uncertain = true;
          warning = rejectedKey ? '社区管理密钥无效；仅应用本机变更，云端未解除屏蔽。' : '云端提交未确认；本机结果和云端结果分别列出，可重试未确认项。';
          for (const uid of [...additions, ...removals]) remote.set(uid, rejectedKey ? 'failed' : 'uncertain');
        } else {
          cacheIds = normalizedIds(payload.ids);
          const returned = new Set(cacheIds);
          for (const item of changes) remote.set(item.uid, returned.has(item.uid) === item.blocked ? 'confirmed' : 'failed');
        }
      }
      if (removals.length && !adminKey) warning = '本机已解除屏蔽；云端移除需要有效的社区管理密钥，其它实例仍可能屏蔽这些号码。';
    } catch (error) {
      if(error?.status===400)throw error;
      if(operationSignal?.aborted||cancelledBlocklist(error))throw Object.assign(blocklistError(`${error?.message??'社区请求已取消'}；未提交本机名单，远端请求可能已发生，请重新读取后比较`,error?.status??503),{cause:error});
      uncertain = true; warning = '云端提交未确认；本机变更仍可生效，重试只针对未确认项。';
      for (const item of changes) remote.set(item.uid, 'uncertain');
    }
    // The network may await arbitrary code. Read the current configuration and
    // check the submitted fields again, then commit without another await.
    if (operationSignal?.aborted) throw blocklistError('社区客户端已停止；未提交本机名单，远端请求可能已发生，请重新读取', 503);
    const current = blocklistView();
    const conflicts = changes.filter(item => revisionOf(current, item.uid) !== item.expected);
    if (conflicts.length) return { ...current, ok: false, partial: true, uncertain, warning: '等待云端期间本机名单已改变；没有覆盖本机新值。', receipts: changes.map(item => ({ uid: item.uid, blocked: current.ids.includes(item.uid), revision: revisionOf(current,item.uid), local: 'conflict', remote: remote.get(item.uid) })) };
    const cfg = config.get();
    let localError = '';
    try {
      const patch=checkStorage(cfg);
      if (JSON.stringify(patch.globalBlocklist) !== JSON.stringify(cfg.globalBlocklist??[]) || JSON.stringify(patch.communityExemptions) !== JSON.stringify(cfg.communityExemptions??[])) {
        if(typeof config.updateRawFields==='function')config.updateRawFields(patch);else config.update(patch);
      }
    } catch (error) { localError = String(error?.message ?? error); }
    if (cacheIds) try { saveCloud(cacheIds); } catch { warning += ' 云端已回执，但本机缓存写入失败。'; }
    const view = blocklistView(), receipts = changes.map(item => ({ uid: item.uid, blocked: view.ids.includes(item.uid), revision: revisionOf(view, item.uid), local: localError ? 'failed' : 'applied', remote: remote.get(item.uid) }));
    const complete = !localError && receipts.every(item => item.remote === 'confirmed');
    return { ...view, ok: complete, partial: !complete, uncertain, receipts, warning: [warning, localError && `本机保存失败：${localError}`].filter(Boolean).join(' '), remoteCAS: false };
  }); }

  async function login(input = {}) {
    const { loginId, password, displayName, mode = 'login' } = input ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || !['login', 'register'].includes(mode)) throw Object.assign(new Error('登录模式无效'), { expose: true, status: 400 });
    if (typeof loginId !== 'string' || !loginId.trim() || typeof password !== 'string' || !password) throw Object.assign(new Error('请填写登录 ID 和密码'), { expose: true, status: 400 });
    if (mode === 'register' && (typeof displayName !== 'string' || !displayName.trim())) throw Object.assign(new Error('请填写展示用户名'), { expose: true, status: 400 });
    const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
    let returnedToken = '';
    try {
      // The official auth contract has no CAPTCHA proof field. Do not replay a
      // password body across redirects; only these fixed auth endpoints own it.
      const response = await request(endpoint, { method: 'POST', followRedirects: false, headers: { 'content-type': 'application/json' }, body: JSON.stringify(mode === 'register' ? { loginId: loginId.trim(), password, displayName: displayName.trim() } : { loginId: loginId.trim(), password }) });
      const payload = textBody(response, mode === 'register' ? '注册失败（服务器响应异常）' : '登录失败（服务器响应异常）');
      returnedToken = typeof payload?.token === 'string' ? payload.token : '';
      if (response.status < 200 || response.status >= 300 || payload?.ok !== true || !returnedToken.trim()) throw new Error(payload?.error ?? `${mode === 'register' ? '注册' : '登录'}失败（服务器响应异常）`);
      const account = publicAccount(payload.account);
      const accountUsername = account?.username ?? account?.loginId;
      if (typeof accountUsername !== 'string' || !accountUsername.trim()) throw new Error('登录失败（服务器未返回账号）');
      const username = accountUsername.trim();
      const savedAt = Date.now();
      saveAccounts([...accounts().filter((item) => item.username !== username), { username, token: returnedToken, savedAt }]);
      return { ok: true, account, accounts: accountsView(accounts()) };
    } catch (err) {
      const secrets = [password, returnedToken].filter(Boolean).sort((a, b) => b.length - a.length);
      const message = secrets.reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), String(err?.message ?? err));
      throw Object.assign(new Error(message), { expose: true, status: 502 });
    }
  }

  async function logout({ username } = {}) {
    if (!String(username ?? '').trim()) throw Object.assign(new Error('缺少 username'), { expose: true, status: 400 });
    const record = accountRecord(accounts(), username);
    if (record) {
      try { await request('/auth/logout', { method: 'POST', headers: { 'x-account-token': record.token }, body: '{}' }); } catch { /* 远端吊销失败不阻塞本地移除 */ }
    }
    saveAccounts(accounts().filter((item) => item.username !== username));
    return { ok: true, accounts: accountsView(accounts()) };
  }

  // Official public markets use these two collection endpoints. Their search
  // and category filters run locally; no account or arbitrary URL is needed.
  async function listCatalog({ kind } = {}) {
    if (!['skill', 'plugin'].includes(kind)) throw Object.assign(new Error('市场类型必须是 skill 或 plugin'), { expose: true, status: 400 });
    try {
      const response = await request(kind === 'skill' ? '/skills' : '/plugins', { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
      const payload = textBody(response, '市场目录响应异常');
      if (response.status < 200 || response.status >= 300 || response.truncated || payload?.ok !== true || !Array.isArray(payload.items)) throw new Error(`市场目录暂时不可用（HTTP ${response.status}）`);
      const categories = Object.fromEntries(Object.entries(payload.categories && typeof payload.categories === 'object' && !Array.isArray(payload.categories) ? payload.categories : {}).filter(([id, name]) => SAFE_ID.test(id) && typeof name === 'string').slice(0, 50).map(([id, name]) => [id, name.slice(0, 100)]));
      const items = payload.items.filter(item => SAFE_ID.test(String(item?.id ?? '')) && (!item.type || item.type === kind)).slice(0, 2000).map(item => {
        const entry = { ...publicItem(item), type: kind };
        entry.categoryName = categories[entry.category] || entry.categoryName || entry.category || '其他';
        if (entry.status !== 'approved' || !INSTALL_CODE.test(String(entry.installCode ?? ''))) delete entry.installCode;
        return entry;
      });
      return { ok: true, kind, categories, items };
    } catch (err) {
      throw Object.assign(new Error(`无法加载在线市场：${err?.message ?? err}`), { expose: true, status: 502 });
    }
  }

  async function publish({ kind, id, displayName, description, accountUsername, captchaVerifyParam } = {}) {
    const normalizedKind = kind === 'plugin' ? 'plugin' : kind === 'skill' ? 'skill' : '';
    if (!normalizedKind || !SAFE_ID.test(String(id ?? ''))) throw Object.assign(new Error(`无效的 ${normalizedKind || kind} id：${id}`), { expose: true, status: 400 });
    const record = accountRecord(accounts(), accountUsername);
    if (!record) throw Object.assign(new Error('请先选择一个已登录的账号'), { expose: true, status: 401 });
    const dir = path.join(extensionRoot, normalizedKind === 'plugin' ? 'plugins' : 'skills', id);
    if (!fsImpl.existsSync(dir) || !fsImpl.statSync(dir).isDirectory()) throw Object.assign(new Error(`目录不存在：${dir}`), { expose: true, status: 502 });
    let current = path.parse(path.resolve(dir)).root;
    for (const part of path.resolve(dir).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fsImpl.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('发布目录及父路径不接受符号链接'), { expose: true, status: 403 });
    }
    let zip;
    try { zip = createStoredZip(collectPublishFiles(dir, fsImpl)); }
    catch (err) { throw Object.assign(new Error(err?.message ?? err), { expose: true, status: 502 }); }
    if (zip.length > MARKET_MAX_ZIP_BYTES) throw Object.assign(new Error('安装包超过 8MB 上限'), { expose: true, status: 502 });
    const boundary = `----qqagent${crypto.randomBytes(12).toString('hex')}`;
    const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value ?? '')}\r\n`);
    const file = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${id}.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from('\r\n')]);
    const body = Buffer.concat([field('kind', normalizedKind === 'plugin' ? 'plugin' : 'skill'), field('name', displayName ?? id), field('description', description ?? ''), ...(captchaVerifyParam ? [field('captchaVerifyParam', captchaVerifyParam)] : []), file, Buffer.from(`--${boundary}--\r\n`)]);
    try {
      const response = await request('/market/publish', { method: 'POST', followRedirects: false, timeoutMs: 120_000, maxBytes: 1024 * 1024, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-account-token': record.token }, body });
      const payload = textBody(response, '发布失败（服务器响应异常）');
      if (response.status < 200 || response.status >= 300 || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      const redact=value=>[record.token,captchaVerifyParam].filter(Boolean).reduce((text,secret)=>text.replaceAll(String(secret),'[已隐藏]'),String(value));
      const item=publicItem(payload.item);
      return { ok: true, item: item&&Object.fromEntries(Object.entries(item).map(([key,value])=>[key,typeof value==='string'?redact(value):value])), renamedTo: typeof payload.renamedTo==='string'?redact(payload.renamedTo):null, note: typeof payload.note==='string'?redact(payload.note):'' };
    } catch (err) {
      const message=[record.token,captchaVerifyParam].filter(Boolean).reduce((text,secret)=>text.replaceAll(String(secret),'[已隐藏]'),String(err?.message ?? err));
      throw Object.assign(new Error(message), { expose: true, status: 502 });
    }
  }

  // Upstream still uses a download reference. Only a fresh approved catalog
  // entry can supply it; this helper is private and has no public code API.
  async function verifyCatalogEntry(value) {
    try {
      const response = await request('/install/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codes: [value] }) });
      const payload = textBody(response, '市场条目校验响应异常');
      if (response.status < 200 || response.status >= 300 || !payload?.ok) throw new Error(payload?.error ?? '市场条目校验响应异常');
      return Array.isArray(payload.results) ? payload.results.find(item => item?.ok !== false && item?.code === value) : null;
    } catch (err) { throw Object.assign(new Error(String(err?.message ?? err)), { expose: true, status: 502 }); }
  }

  async function install({ id, kind, code } = {}) {
    if (code !== undefined || !SAFE_ID.test(String(id ?? '')) || !['skill', 'plugin'].includes(kind)) throw Object.assign(new Error('请选择市场目录中的技能或插件'), { expose: true, status: 400 });
    const entries = (await listCatalog({ kind })).items.filter(item => item.id === id);
    if (entries.length !== 1 || !entries[0].installCode) throw Object.assign(new Error('市场条目已下架或暂不可安装，请刷新目录后重试'), { expose: true, status: 409 });
    const value = entries[0].installCode;
    const verified = await verifyCatalogEntry(value);
    if (!verified || !['skill', 'plugin'].includes(verified.type)) throw Object.assign(new Error('市场条目校验未返回有效类型'), { expose: true, status: 502 });
    if (verified.type !== kind || verified.id !== id) throw Object.assign(new Error('市场条目或类型已变化，请刷新目录后重试'), { expose: true, status: 409 });
    if (typeof installZip !== 'function') throw Object.assign(new Error('核心未提供安全安装服务'), { expose: true, status: 503 });
    let response;
    try { response = await request(`/install/${encodeURIComponent(value)}/download`, { timeoutMs: 120_000, maxBytes: MARKET_MAX_ZIP_BYTES }); }
    catch (err) { throw Object.assign(new Error(`下载失败：${err?.message ?? err}`), { expose: true, status: 502 }); }
    if (response.status < 200 || response.status >= 300) {
      let message = `HTTP ${response.status}`;
      try { message = textBody(response, message)?.error ?? message; } catch { /* binary/non-json error */ }
      throw Object.assign(new Error(`下载失败：${message}`), { expose: true, status: 502 });
    }
    if (response.truncated || response.body.length > MARKET_MAX_ZIP_BYTES) throw Object.assign(new Error('安装包超过 8MB 上限'), { expose: true, status: 502 });
    try {
      // 市场条目名可被服务器改名；执行身份只来自校验后的包内清单。
      const result = await installZip(response.body, { kind });
      return { ...result, kind, id: result.installed, dir: path.join(extensionRoot, result.root, result.installed) };
    } catch (err) {
      if (err?.expose && [403, 409, 500, 503].includes(err.status)) throw err;
      throw Object.assign(new Error(String(err?.message ?? err)), { expose: true, status: 502 });
    }
  }

  return { getBlocklist: blocklistView, syncGlobalBlocklist, updateBlocklist, listAccounts: () => ({ ok: true, accounts: accountsView(accounts()) }), listCatalog, login, logout, publish, install, __test: { readZipEntries, extractZipSafely } };
}
