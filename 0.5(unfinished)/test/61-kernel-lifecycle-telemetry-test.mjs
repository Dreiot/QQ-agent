import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel/kernel.js';
import { createTelemetry } from '../src/kernel/telemetry.js';
import { createSessionRegistry } from '../src/kernel/sessions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-t61-isolated-'));
const dir = (name) => { const value = path.join(root, name); fs.mkdirSync(value, { recursive: true }); return value; };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fakeKernel = (dataDir, { price = Promise.resolve({ ok: true }), blocklist = Promise.resolve({ ok: true, ids: [] }), connect = Promise.resolve() } = {}) => {
  const calls = { transportStart:0,transportStop: 0, close: 0 };
  const transport = { id: 'fixture', start: () => {calls.transportStart++;return connect;}, actions: {}, toPlatformSegments: (x) => x,
    stop: async () => { calls.transportStop++; },
  };
  const kernel = createKernel({
    env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '48061' },
    transport,
    priceUpdates: { refresh: () => price }, communityMarket: { syncGlobalBlocklist: () => blocklist },
  });
  kernel.config.update({ telemetry: { enabled: false }, proactive: { enabled: false } });
  kernel.httpServer.listen = async () => 48061;
  kernel.httpServer.close = async () => { calls.close++; };
  kernel.loader.loadAll = async () => {};
  kernel.loader.startWatchers = () => {};
  kernel.loader.stopAll = () => {};
  kernel.orchestrator.startReminderLoop = () => {};
  kernel.orchestrator.stop = () => {};
  return { kernel, calls, transport };
};

try {
  {
    const dataDir = dir('same-pid');
    const first = fakeKernel(dataDir);
    const second = fakeKernel(dataDir);
    const base = process.listenerCount('exit');
    await first.kernel.start();
    assert.equal(fs.readFileSync(path.join(dataDir, 'qq-agent.lock'), 'utf8'), String(process.pid));
    await assert.rejects(second.kernel.start(), /已有实例/);
    await second.kernel.stop();
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), true);
    await first.kernel.stop();
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
    assert.equal(process.listenerCount('exit'), base);
  }
  {
    const dataDir = dir('background-stop');
    const price = deferred(); const blocklist = deferred();
    const { kernel } = fakeKernel(dataDir, { price: price.promise, blocklist: blocklist.promise });
    let events = 0;
    const emit = kernel.bus.emit.bind(kernel.bus);
    kernel.bus.emit = (name, payload) => {
      if (['price-update', 'blocklist-sync'].includes(name)) { events++; return true; }
      return emit(name, payload);
    };
    await kernel.start();
    await kernel.stop();
    price.resolve({ ok: true }); blocklist.resolve({ ok: true, ids: ['fixture'] });
    await new Promise(setImmediate);
    assert.equal(kernel.scheduler.count(), 0);
    assert.equal(events, 0);
  }
  {
    const dataDir = dir('failed-start');
    const connect = deferred();
    const { kernel, calls } = fakeKernel(dataDir, { connect: connect.promise });
    const start = kernel.start();
    const failed = assert.rejects(start, /测试启动失败/);
    // Startup includes asynchronous account-registry reads; one immediate turn
    // is not evidence that the injected transport has received the promise.
    for(let i=0;i<1000&&!calls.transportStart;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls.transportStart,1);
    connect.reject(new Error('测试启动失败'));
    await failed;
    assert.equal(kernel.scheduler.count(), 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
    assert.equal(calls.close, 1);
  }
  {
    const dataDir = dir('cancel-start');
    const connect = deferred();
    const { kernel } = fakeKernel(dataDir, { connect: connect.promise });
    const start = kernel.start();
    const cancelled = assert.rejects(start, /启动已取消/);
    await new Promise(setImmediate);
    const stop = kernel.stop();
    connect.resolve();
    await cancelled; await stop;
    assert.equal(kernel.scheduler.count(), 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
  }
  {
    const dataDir = dir('stop-error');
    const { kernel, calls, transport } = fakeKernel(dataDir);
    await kernel.start();
    transport.stop = async () => { throw new Error('测试停止失败'); };
    await assert.rejects(kernel.stop(), /测试停止失败/);
    assert.equal(kernel.scheduler.count(), 0);
    assert.equal(calls.close, 1);
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-agent.lock')), false);
  }
  {
    const dataDir = dir('telemetry');
    const sessions = createSessionRegistry({ dataDir, log: {} });
    const telemetry = createTelemetry({ dataDir, sessions, fetchImpl: async () => ({ ok: true }), log: {} });
    assert.equal(telemetry.totals().totalTokens, 0);
    const session = sessions.create('private:fixture');
    session.usage = { calls: 99, promptTokens: 10, completionTokens: 4, totalTokens: 14 };
    session.messages = [{ raw: { usage: { prompt_tokens: 10, completion_tokens: 4 } } }, { toolCall: { name: 'send_message' } }];
    sessions.finish(session.id, 'done');
    assert.deepEqual(telemetry.totals(), { calls: 1, promptTokens: 10, completionTokens: 4, totalTokens: 14, toolCounts: { send_message: 1 } });
    sessions.finish(session.id, 'done');
    assert.equal(telemetry.totals().calls, 1);
    assert.equal(sessions.todayUsage().runs, 1);
    sessions.flushIndexCache();
    const reloaded = createSessionRegistry({ dataDir, log: {} });
    fs.rmSync(path.join(dataDir, 'telemetry-totals.json'));
    const rebuilt = createTelemetry({ dataDir, sessions: reloaded, log: {} }).totals();
    assert.equal(rebuilt.calls, 1);
    assert.equal(rebuilt.toolCounts.send_message, 1);
    // 缓存被清零时，重建会用留档把下限抬回去（累计不得因覆盖写而回退）。
    fs.writeFileSync(path.join(dataDir, 'telemetry-totals.json'), JSON.stringify({ calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} }));
    assert.equal(telemetry.totals({ verify: true }).totalTokens, 14);
    assert.equal(telemetry.totals({ verify: true }).toolCounts.send_message, 1);
    const next = reloaded.create('private:fixture');
    next.usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    next.messages = [{ raw: { usage: { prompt_tokens: 2, completion_tokens: 1 } } }];
    reloaded.finish(next.id, 'error');
    assert.equal(telemetry.totals().totalTokens, 17);
    sessions.delete(session.id);
    assert.equal(telemetry.totals().totalTokens, 17);
    sessions.stop(); reloaded.stop();
  }
  {
    const dataDir = dir('finish-first');
    const sessions = createSessionRegistry({ dataDir, log: {} });
    const session = sessions.create('private:fixture');
    session.usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
    session.messages = [{ raw: { usage: { prompt_tokens: 3, completion_tokens: 2 } } }];
    sessions.finish(session.id, 'done');
    assert.equal(read(path.join(dataDir, 'telemetry-totals.json')).totalTokens, 5);
    const modern = sessions.create('private:fixture');
    modern.usage = { calls: 2, promptTokens: 7, completionTokens: 3, totalTokens: 10 };
    modern.messages = [{ role: 'assistant', tool_calls: [{ function: { name: 'send_message' } }] }];
    sessions.finish(modern.id, 'done');
    const current = read(path.join(dataDir, 'telemetry-totals.json'));
    assert.equal(current.calls, 3);
    assert.equal(current.toolCounts.send_message, 1);
    sessions.stop();
  }
  {
    const dataDir = dir('telemetry-timer');
    // Keep the stop/restart race about an actual pending report, not zero usage.
    fs.writeFileSync(path.join(dataDir, 'telemetry-totals.json'), JSON.stringify({ calls: 1, promptTokens: 1, completionTokens: 0, totalTokens: 1, toolCounts: {} }));
    const callbacks = [];
    const active = new Set();
    const request = deferred(); let reports = 0;
    const telemetry = createTelemetry({ dataDir, fetchImpl: () => { reports++; return request.promise; }, log: {},
      setTimeoutFn: (callback) => { const timer = { callback, unref() {} }; callbacks.push(timer); active.add(timer); return timer; },
      clearTimeoutFn: (timer) => active.delete(timer),
    });
    telemetry.start(); telemetry.start();
    assert.equal(callbacks.length, 1);
    const first = callbacks[0]; active.delete(first);
    const reporting = first.callback();
    telemetry.stop();
    telemetry.start();
    request.resolve({ ok: true }); await reporting;
    assert.equal(callbacks.length, 2);
    await first.callback();
    assert.equal(reports, 1);
    telemetry.stop();
    assert.equal(active.size, 0);
  }
  {
    const dataDir = dir('session-stop');
    const sessions = createSessionRegistry({ dataDir, log: {} });
    const session = sessions.create('private:fixture');
    sessions.update(session, { promptChars: 44 });
    sessions.reconcileInBackground();
    sessions.stop();
    assert.equal(read(path.join(dataDir, 'sessions', `${session.id}.json`)).promptChars, 44);
    assert.equal(session._throttleTimer, undefined);
  }
  console.log('61 内核生命周期与遥测隔离回归：全部通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
