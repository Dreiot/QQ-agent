// Real private kernel/HTTP reset, independent child PIDs and owned temporary
// directories. No Electron window, live QA data, QQ or outside HTTP is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createKernel } from '../src/kernel/kernel.js';
import { buildDefaultConfig } from '../src/kernel/config.js';
import { completePendingDataReset, createDataResetCoordinator } from '../src/kernel/data-reset.js';
import { configureUserData } from '../electron/main.js';
import { detectMigrationSource } from '../src/kernel/migrator.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function tree(dir) {
  const result = {};
  const scan = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile() && entry.name !== 'qq-agent.lock') result[path.relative(dir, file)] = hash(file);
  } };
  scan(dir); return result;
}
function kernelOptions(appRoot, dataDir, calls = {}) {
  let events;
  return { appRoot, env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(appRoot, 'absent') },
    transport: { id: 'qa135-local', selfId: '13599', bind(context) { events = context; },
      start() { calls.starts = (calls.starts || 0) + 1; events.onStatus({ connected: true, selfId: '13599' }); },
      stop() { calls.stops = (calls.stops || 0) + 1; return calls.deferStop?.(); }, send() { assert.fail('135 must never send a QQ message'); },
      status: () => ({ connected: true, selfId: '13599' }), actions: {} },
    fetchImpl: async () => { assert.fail('135 prohibits all external fetch'); },
    priceUpdates: { resolve: () => null, refresh: async () => ({ ok: true }) },
    communityMarket: { syncGlobalBlocklist: async () => ({ ok: true, ids: [] }) },
  };
}

if (process.env.QA135_WORKER === '1') {
  const appRoot = process.env.QA135_APP, dataDir = process.env.QA135_DATA, calls = {};
  let releaseStop;
  if (process.env.QA135_STOP_GATE === '1') calls.deferStop = () => {
    process.send({ type: 'stopping' });
    return new Promise(resolve => { releaseStop = resolve; });
  };
  const { createKernel: workerCreateKernel } = await import(pathToFileURL(path.join(appRoot, 'src', 'kernel', 'kernel.js')).href);
  const kernel = workerCreateKernel(kernelOptions(appRoot, dataDir, calls));
  const skills = Object.fromEntries(fs.readdirSync(path.join(appRoot, 'bundled'), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => [x.name, { enabled: false }]));
  kernel.config.update({ server: { port: 0, token: 'qa135-console' }, api: { apiKey: 'qa135-synthetic-secret', model: 'qa135' },
    persona: { botName: 'QA135 original' }, skills, telemetry: { enabled: false }, proactive: { enabled: false } });
  kernel.store.appendIncoming('group:13501', { mid: 1351, senderId: '13502', senderName: 'QA135', text: 'QA135 original message' });
  kernel.store.markAllRead('group:13501');
  kernel.memory.append('group:13501', { userId: '13502', name: 'QA135', content: 'QA135 original impression' });
  const session = kernel.sessions.create('group:13501', { trigger: 'qa135' });
  kernel.sessions.finish(session.id, 'done', { usage: { promptTokens: 7, totalTokens: 9, completionTokens: 2, calls: 1 } });
  const retainedKv = kernel.storage.namespace('qa135-own'); retainedKv.set('value', 'original');
  fs.writeFileSync(path.join(dataDir, 'plugins', 'qa135-own', 'qq-agent.lock'), 'nested ordinary plugin data');
  const retainedLog = kernel.log.child('qa135-late');
  let managedTimer;
  kernel.capability.register('qa135.managed', 'kernel', { create: () => ({
    start() { calls.managedStarts = (calls.managedStarts || 0) + 1; managedTimer = kernel.scheduler.every(60000, () => {}, { ownerId: 'kernel', name: 'qa135-managed' }); },
    stop() { calls.managedStops = (calls.managedStops || 0) + 1; managedTimer?.stop(); },
  }) }, { lifecycle: true });
  kernel.log.setLevel('error'); await kernel.start();
  const locked = path.join(dataDir, 'electron-user-data', 'Cache', 'Cache_Data', 'data_0');
  fs.mkdirSync(path.dirname(locked), { recursive: true }); fs.writeFileSync(locked, 'QA135 locked Chromium cache');
  const originalRm = fs.rmSync, originalCp = fs.cpSync;
  let rmAttempts = 0;
  fs.rmSync = function (target, ...args) {
    const resolved = path.resolve(String(target));
    if (resolved === dataDir || resolved.startsWith(path.join(dataDir, 'electron-user-data'))) {
      rmAttempts++; throw Object.assign(new Error('QA135 locked Electron cache'), { code: 'EPERM' });
    }
    return originalRm.call(this, target, ...args);
  };
  if (process.env.QA135_BACKUP_FAIL === '1') fs.cpSync = function (source, ...args) {
    if (path.resolve(source) === dataDir) throw Object.assign(new Error('QA135 backup unavailable'), { code: 'EACCES' });
    return originalCp.call(this, source, ...args);
  };
  process.send({ type: 'ready', port: kernel.httpServer.port, pid: process.pid, sessionId: session.id, locked, before: tree(dataDir), calls });
  process.on('message', async message => {
    try {
      if (message.type === 'release-stop') { releaseStop?.(); releaseStop = null; }
      else if (message.type === 'probe') {
        const before = tree(dataDir), blocked = [];
        for (const [name, operation] of Object.entries({
          memory: () => kernel.memory.append('group:13501', { userId: '13502', name: 'QA135', content: 'late write' }),
          store: () => kernel.store.appendIncoming('group:13501', { text: 'late write' }),
          namespace: () => retainedKv.set('value', 'late write'),
          config: () => kernel.config.update({ persona: { botName: 'late write' } }),
          configRaw: () => kernel.config.updateRawFields({ globalBlocklist: ['13599'] }),
          resume: () => kernel.orchestrator.resume(),
        })) { try { operation(); blocked.push([name, false]); } catch (error) { blocked.push([name, error.status === 409]); } }
        kernel.sessions.update(session, { usage: { calls: 99, totalTokens: 999 } });
        kernel.sessions.finish(session.id, 'done', { error: 'late write' });
        retainedLog.error('QA135 late callback must not persist');
        await delay(2200);
        process.send({ type: 'probe', blocked, unchanged: JSON.stringify(tree(dataDir)) === JSON.stringify(before), calls, timers: kernel.scheduler.count(), rmAttempts,
          runningServices: kernel.services.status().filter(x => x.running), status: kernel.orchestrator.status() });
      } else if (message.type === 'stop') {
        fs.rmSync = originalRm; fs.cpSync = originalCp;
        await kernel.stop(); process.send({ type: 'stopped', calls, lock: fs.existsSync(path.join(dataDir, 'qq-agent.lock')) }); process.disconnect();
      }
    } catch (error) { process.send({ type: 'error', error: String(error.stack || error) }); }
  });
} else {
  function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-reset135-')), appRoot = path.join(root, 'app'), dataDir = path.join(root, 'data');
    fs.mkdirSync(appRoot);
    const copySource = process.env.QA135_SOURCE_ROOT || sourceRoot;
    for (const name of ['src', 'bundled', 'assets']) fs.cpSync(path.join(copySource, name), path.join(appRoot, name), { recursive: true });
    fs.cpSync(path.join(copySource, 'scripts', 'lib'), path.join(appRoot, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(appRoot, 'package.json'));
    fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(appRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const cleanup = () => { assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.match(path.basename(root), /^qqa-reset135-/); fs.rmSync(root, { recursive: true, force: true }); };
    return { root, appRoot, dataDir, cleanup, kernels: [] };
  }
  async function worker(t, options = {}) {
    const f = temporary(t), messages = [];
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, QA135_WORKER: '1', QA135_APP: f.appRoot, QA135_DATA: f.dataDir, QA135_BACKUP_FAIL: options.backupFail ? '1' : '0', QA135_STOP_GATE: options.stopGate ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.on('message', message => messages.push(message));
    const wait = async type => { for (let i = 0; i < 400; i++) { const at = messages.findIndex(x => x.type === type || x.type === 'error'); if (at >= 0) { const m = messages.splice(at, 1)[0]; assert.notEqual(m.type, 'error', m.error); return m; } assert.equal(child.exitCode, null, output); await delay(20); } assert.fail(`worker missing ${type}: ${output}`); };
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stopped = false;
    const stop = async () => { if (!stopped) { stopped = true; child.send({ type: 'release-stop' }); child.send({ type: 'stop' }); const details = await wait('stopped'); const result = await exited; assert.equal(result.code, 0, output); assert.equal(details.lock, false); return details; } };
    t.after(async () => { await stop(); for (const kernel of f.kernels) await kernel.stop(); f.cleanup(); });
    const ready = await wait('ready'), base = `http://127.0.0.1:${ready.port}`;
    const api = async (method, endpoint, body) => { const response = await fetch(base + endpoint, { method, headers: { 'x-console-token': 'qa135-console', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
    return { ...f, base, child, ready, api, wait, stop };
  }
  const marker = f => f.dataDir + '.reset-pending.json';

  test('real kernel reset defers locked cache deletion, stops owners, fences old warehouses, and retains lock', async t => {
    const f = await worker(t);
    const reset = await f.api('POST', '/api/reset-data');
    assert.equal(reset.status, 200, JSON.stringify({ reset, configExists: fs.existsSync(path.join(f.dataDir, 'config.json')), lockedCacheExists: fs.existsSync(f.ready.locked) }));
    assert.equal(reset.body.ok, true); assert.equal(reset.body.resetAccepted, true); assert.equal(reset.body.resetCompleted, false); assert.equal(reset.body.restartRequired, true);
    assert.match(reset.body.message, /退出.*重新打开.*全部数据清理/);
    assert.ok(fs.existsSync(f.ready.locked)); assert.ok(fs.existsSync(marker(f)));
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'qq-agent.lock'), 'utf8'), String(f.ready.pid));
    assert.equal(fs.existsSync(path.join(reset.body.backupDir, 'qq-agent.lock')), false);
    assert.equal(fs.readFileSync(path.join(reset.body.backupDir, 'plugins', 'qa135-own', 'qq-agent.lock'), 'utf8'), 'nested ordinary plugin data');
    assert.equal(JSON.parse(fs.readFileSync(path.join(reset.body.backupDir, 'config.json'))).api.apiKey, 'qa135-synthetic-secret');
    const status = await f.api('GET', '/api/status'); assert.equal(status.body.onebot.connected, false); assert.equal(status.body.orchestrator.paused, true);
    assert.equal(status.body.reset.backupDir, reset.body.backupDir); assert.equal(status.body.reset.resetCompleted, false);
    for (const [method, endpoint, body] of [['POST', '/api/config', {}], ['POST', '/api/config/lifecycle', {}], ['POST', '/api/config/lifecycle/open', {}], ['POST', '/api/orchestrator/resume'], ['GET', '/api/update-check'], ['GET', '/api/models'], ['GET', '/api/chats'], ['GET', '/api/api-key']]) assert.equal((await f.api(method, endpoint, body)).status, 409, endpoint);
    f.child.send({ type: 'probe' }); const probe = await f.wait('probe');
    assert.deepEqual(probe.blocked, [['memory', true], ['store', true], ['namespace', true], ['config', true], ['configRaw', true], ['resume', true]]);
    assert.equal(probe.unchanged, true, 'late session usage, timers, old KV and child log do not write'); assert.equal(probe.rmAttempts, 0);
    assert.equal(probe.calls.stops, 1); assert.equal(probe.calls.managedStops, 1); assert.equal(probe.timers, 0); assert.deepEqual(probe.runningServices, []);
    assert.throws(() => createKernel(kernelOptions(f.appRoot, f.dataDir)), /旧进程仍在运行/);
    assert.ok(fs.existsSync(f.ready.locked)); await f.stop();
    const next = createKernel(kernelOptions(f.appRoot, f.dataDir)); f.kernels.push(next);
    assert.equal(fs.existsSync(marker(f)), false); assert.equal(fs.existsSync(f.ready.locked), false);
    assert.equal(next.config.get().api.apiKey, ''); assert.equal(next.config.get().persona.botName, buildDefaultConfig().persona.botName);
    assert.deepEqual(next.store.listChats(), []); assert.deepEqual(next.memory.listFiles(), []); assert.deepEqual(next.sessions.listSummaries(), []);
    assert.equal(detectMigrationSource(f.dataDir, reset.body.backupDir).eligible, false, 'written defaults prevent old-data import');
    assert.equal(JSON.parse(fs.readFileSync(path.join(reset.body.backupDir, 'config.json'))).api.apiKey, 'qa135-synthetic-secret');
    next.config.update({ server: { port: 0 }, skills: Object.fromEntries(fs.readdirSync(path.join(f.appRoot, 'bundled')).map(id => [id, { enabled: false }])) });
    await next.start(); assert.equal(fs.readFileSync(path.join(f.dataDir, 'qq-agent.lock'), 'utf8'), String(process.pid));
  });

  test('lifecycle draft recovery is permitted only after failure, never while preparing', async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-reset135-guard-')),dataDir=path.join(root,'data');
    fs.mkdirSync(dataDir);t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^qqa-reset135-guard-/);fs.rmSync(root,{recursive:true,force:true});});
    let rejectStop;const coordinator=createDataResetCoordinator({dataDir,log:{error(){}},quiesce:()=>new Promise((_resolve,reject)=>{rejectStop=reject;})});
    const pending=coordinator.request();assert.equal(coordinator.status().phase,'preparing');
    const endpoints=['/api/config','/api/config/lifecycle','/api/config/lifecycle/open'];
    for(const pathname of endpoints)assert.equal(coordinator.apiGuard({method:'POST',pathname}).status,409,pathname);
    rejectStop(Error('synthetic guarded stop failure'));await assert.rejects(pending,/synthetic guarded stop failure/);assert.equal(coordinator.status().phase,'failed');
    for(const pathname of endpoints){assert.equal(coordinator.apiGuard({method:'POST',pathname}),null,pathname);assert.equal(coordinator.apiGuard({method:'PUT',pathname}).status,409,pathname);}
    assert.equal(coordinator.apiGuard({method:'POST',pathname:'/api/config/lifecycle/open/other'}).status,409);
    assert.equal(coordinator.apiGuard({method:'POST',pathname:'/api/orchestrator/resume'}).status,409);
  });
  test('backup failure returns honest 500 without deleting keys or archives; only original config draft remains writable', async t => {
    const f = await worker(t, { backupFail: true });
    const before = tree(f.dataDir), response = await f.api('POST', '/api/reset-data');
    assert.equal(response.status, 500); assert.equal(response.body.ok, false); assert.match(response.body.error, /重置未提交，原数据未删除.*QA135 backup unavailable.*业务已暂停/);
    for (const file of Object.keys(before).filter(x => !/session-index|usage|sessions|logs/.test(x))) assert.equal(hash(path.join(f.dataDir, file)), before[file], file);
    assert.equal(fs.existsSync(marker(f)), false); assert.ok(fs.existsSync(f.ready.locked));
    const status = await f.api('GET', '/api/status'); assert.equal(status.body.reset.phase, 'failed'); assert.equal(status.body.onebot.connected, false);
    assert.equal((await f.api('POST', '/api/config', { persona: { botName: 'recovered draft' } })).status, 200);
    assert.equal((await f.api('POST', '/api/orchestrator/resume')).status, 409);
    await f.stop(); const restored = createKernel(kernelOptions(f.appRoot, f.dataDir)); f.kernels.push(restored);
    assert.equal(restored.config.get().api.apiKey, 'qa135-synthetic-secret'); assert.equal(restored.config.get().persona.botName, 'recovered draft'); assert.equal(restored.store.listChats().length, 1);
  });
  test('a new authenticated SSE client during preparing receives the actual final reset state', async t => {
    const f = await worker(t, { stopGate: true });
    const request = f.api('POST', '/api/reset-data'); await f.wait('stopping');
    assert.equal((await f.api('GET', '/api/status')).body.reset.phase, 'preparing');
    const controller = new AbortController(); t.after(() => controller.abort());
    const stream = await fetch(f.base + '/api/events', { headers: { 'x-console-token': 'qa135-console' }, signal: controller.signal });
    assert.equal(stream.status, 200); const reader = stream.body.getReader(), decoder = new TextDecoder(); let frames = '';
    frames += decoder.decode((await reader.read()).value); assert.match(frames, /event: hello/);
    f.child.send({ type: 'release-stop' }); assert.equal((await request).body.resetAccepted, true);
    const observed = (async () => { while (!frames.includes('"resetAccepted":true')) { const chunk = await reader.read(); assert.equal(chunk.done, false); frames += decoder.decode(chunk.value); } })();
    let timeout; try { await Promise.race([observed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('final reset SSE was not delivered')), 5000); })]); } finally { clearTimeout(timeout); controller.abort(); }
    assert.match(frames, /"phase":"accepted"/); assert.match(frames, /"resetCompleted":false/);
  });

  async function pending(t) { const f = await worker(t); f.reset = (await f.api('POST', '/api/reset-data')).body; await f.stop(); return f; }
  test('concurrent pending consumers are serialized outside the target, then fresh defaults are written once', async t => {
    const f = await pending(t), originalRm = fs.rmSync; let concurrent = false;
    const guardedFs = { ...fs, rmSync(target, ...args) {
      if (path.resolve(target) === f.dataDir) {
        concurrent = true;
        const script = `import {createKernel} from ${JSON.stringify(pathToFileURL(path.join(f.appRoot, 'src/kernel/kernel.js')).href)};
          try {createKernel({appRoot:${JSON.stringify(f.appRoot)},env:{QQ_AGENT_DATA_DIR:${JSON.stringify(f.dataDir)}}});process.exitCode=9}
          catch(error){if(!/清理锁无法独占/.test(error.message))throw error;console.log(JSON.stringify({pid:process.pid,blocked:true}))}`;
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 0, child.stderr); const observation = JSON.parse(child.stdout.trim()); assert.equal(observation.blocked, true); assert.notEqual(observation.pid, process.pid);
        assert.ok(fs.existsSync(f.ready.locked), 'second PID cannot remove old cache while first holds claim');
      }
      return originalRm(target, ...args);
    } };
    assert.equal(completePendingDataReset({ dataDir: f.dataDir, defaults: buildDefaultConfig(), fsImpl: guardedFs }).completed, true);
    assert.equal(concurrent, true); assert.equal(fs.existsSync(marker(f) + '.claim'), false); assert.equal(fs.existsSync(marker(f)), false);
    assert.equal(completePendingDataReset({ dataDir: f.dataDir, defaults: buildDefaultConfig() }).completed, false);
  });
  test('pending cleanup failure retains verified backup and marker and rejects boot before stores/logging', async t => {
    const f = await pending(t), before = tree(f.dataDir);
    const lockedFs = { ...fs, rmSync(target, ...args) { if (path.resolve(target) === f.dataDir) throw Object.assign(new Error('QA135 cache remains locked'), { code: 'EPERM' }); return fs.rmSync(target, ...args); } };
    assert.throws(() => completePendingDataReset({ dataDir: f.dataDir, defaults: buildDefaultConfig(), fsImpl: lockedFs }), /保留备份与标记.*QA135 cache remains locked/);
    assert.deepEqual(tree(f.dataDir), before); assert.ok(fs.existsSync(marker(f))); assert.ok(fs.existsSync(f.reset.backupDir)); assert.equal(fs.existsSync(marker(f) + '.claim'), false);
    assert.equal(completePendingDataReset({ dataDir: f.dataDir, defaults: buildDefaultConfig() }).completed, true);
  });
  test('pending path/PID/backup integrity gates never clear unvalidated data', async t => {
    const f = await pending(t), original = fs.readFileSync(marker(f), 'utf8'), before = tree(f.dataDir);
    const record = JSON.parse(original);
    for (const change of [{ dataDir: path.dirname(f.dataDir) }, { backupDir: path.dirname(f.dataDir) }, { pid: -1 }, { nonce: 'invalid' }]) {
      fs.writeFileSync(marker(f), JSON.stringify({ ...record, ...change })); assert.throws(() => createKernel(kernelOptions(f.appRoot, f.dataDir)), /拒绝启动/); assert.deepEqual(tree(f.dataDir), before);
    }
    fs.writeFileSync(marker(f), original);
    fs.writeFileSync(path.join(f.reset.backupDir, 'config.json'), '{}');
    assert.throws(() => createKernel(kernelOptions(f.appRoot, f.dataDir)), /备份校验失败/); assert.deepEqual(tree(f.dataDir), before);
  });
  test('a crash-left cleanup claim fails closed with an explicit recovery path and no directory mutation', async t => {
    const f = await pending(t), before = tree(f.dataDir), claim = marker(f) + '.claim';
    fs.writeFileSync(claim, '999999999');
    assert.throws(() => createKernel(kernelOptions(f.appRoot, f.dataDir)), /清理锁无法独占.*确认其进程已退出.*管理员移除/);
    assert.deepEqual(tree(f.dataDir), before); assert.ok(fs.existsSync(marker(f))); assert.ok(fs.existsSync(f.reset.backupDir));
    fs.rmSync(claim); assert.equal(completePendingDataReset({ dataDir: f.dataDir, defaults: buildDefaultConfig() }).completed, true);
  });
  test('Electron consumes pending before selecting or opening its userData, and uses the actual profile defaults', async t => {
    const f = await pending(t), setPaths = [];
    const app = { isPackaged: false, getPath: key => key === 'appData' ? path.join(f.root, 'own-appdata') : path.join(f.appRoot, 'electron.exe'), setPath(key, value) { assert.equal(fs.existsSync(f.ready.locked), false); assert.equal(fs.existsSync(marker(f)), false); setPaths.push([key, value]); } };
    configureUserData(app, { QQ_AGENT_DATA_DIR: f.dataDir, QQ_AGENT_PROFILE: '3' }, f.appRoot);
    assert.deepEqual(setPaths, [['userData', path.join(f.dataDir, 'electron-user-data')]]);
    const defaults = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'))); assert.equal(defaults.server.port, 3410); assert.equal(defaults.api.apiKey, ''); assert.equal(fs.existsSync(f.ready.locked), false);
  });
}
