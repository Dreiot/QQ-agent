// 简易会话流程.xlsx / Sheet1!A1:C36: actual default event ingress, stores,
// prompts, agent runner and finish tool; only dice and model replies are controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultComponents } from '../bundled/runtime-defaults/components.js';
import coreTools from '../bundled/core-tools/index.js';
import { fixtureCapability } from './bundled-fixture-sdk.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const numbers = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const text = number => `FLOW_MESSAGE_${String(number).padStart(3, '0')}`;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, label); await sleep(10); }
}

function runtime(t, { key = 'group:30501', hit = number => number === 2 || number === 32, fail = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-session-flow-305-'));
  const errors = [], log = { error: error => errors.push(String(error)), warn() {}, info() {} };
  const components = { ...defaultComponents, 'core.wake.resolve': args => {
    const number = Number(args.entry.mid);
    dice.push(number);
    return defaultComponents['core.wake.resolve']({ ...args, roll: hit(number) ? 20 : 90 });
  } };
  const config = {
    api: { model: 'offline-305', maxRounds: 2 },
    store: { contextTier: 3, randomPercent: 50, keywords: [], historyCount: 80, promptAnchor: { enabled: false } },
    persona: { botName: 'fixture bot' }, memory: { consolidateEnabled: false },
    allow: { groups: ['30501', '30502'], private: ['30503'] },
    chatActive: { enabled: false }, proactive: { enabled: false },
    wakeDelayMs: 500, drainDelayMs: 200, sessionRetryAttempts: 0,
    send: { minGapMs: 0, maxGapMs: 0, byLengthMs: 0, dedupeWindowMs: 0 },
  };
  const cfg = () => config, dice = [], requests = [], gates = [], updates = [], sends = [];
  const bus = components['runtime.bus']({ log });
  const store = components['data.messages']({ dataDir, log });
  const sessions = components['data.sessions']({ dataDir, log, bus });
  bus.on('chat.update', chatKey => updates.push({ chatKey, unread: store.unread(chatKey).map(entry => Number(entry.mid)) }));
  const transport = { selfId: '30599', actions: { getSelfMemberInfo: async () => ({ muted: false }) }, async send(chatKey, segments) { sends.push({ chatKey, segments }); return { msgId: sends.length }; } };
  const send = components['core.send']({ cfg, store, transport, log, bus });
  const registry = components['runtime.tools']({ log });
  coreTools.setup({ capability: fixtureCapability({ cfg, store, send }), registerTool: definition => registry.register({ ...definition, bundled: true, ownerId: 'core-tools' }) });
  const loader = { isActive: () => true, hooksOf: () => [], promptSections: () => [] };
  const ingest = components['core.ingest']({ cfg, store, bus, log, selfIdOf: () => transport.selfId });
  const orch = components['core.orchestrator']({ cfg, store, sessions, memory: {}, send, registry, loader, transport, log, bus, components,
    buildToolsFor: args => components['core.tools.bundle'](args, { registry, loader }),
    execContextFor: ({ chatKey, session }) => ({ chatKey, session, send }),
    llmInvoker: async args => {
      const gate = deferred(); gates.push(gate);
      requests.push(structuredClone(args.messages));
      await gate.promise;
      if (fail) throw new Error('305 controlled model failure');
      return { message: { role: 'assistant', content: '', tool_calls: [{ id: `finish-305-${requests.length}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ reason: '305 flow complete' }) } }] }, finishReason: 'tool_calls' };
    },
  });
  t.after(async () => {
    orch.stop(); for (const gate of gates) gate.resolve();
    await until(() => sessions.running().length === 0, 'all model gates closed');
    sessions.stop();
    const target = path.resolve(dataDir);
    assert.equal(path.dirname(target).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('qqa-session-flow-305-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const entry = number => store.findByMid(key, number);
  const unread = () => store.unread(key, { includePokes: true }).map(message => Number(message.mid));
  return { dataDir, key, config, store, sessions, orch, dice, requests, gates, updates, sends, errors, entry, unread,
    async incoming(number, { atMe = false, atQQ = null, key: targetKey = key } = {}) {
      const [kind, id] = targetKey.split(':');
      const mention = atQQ ?? (atMe ? transport.selfId : null);
      await components['core.events']({ kind, id, type: 'message', event: {
        message_id: number, time: Math.floor(Date.now() / 1000), user_id: 30510,
        sender: { user_id: 30510, nickname: 'flow member' },
        message: [...(mention !== null ? [{ type: 'at', data: { qq: mention } }] : []), { type: 'text', data: { text: text(number) } }],
      } }, { ingest, orchestrator: orch, cfg, config: { update: () => assert.fail('unexpected config mutation') }, store, bus, log, forwardMedia: async () => {} });
      const received = store.findByMid(targetKey, number);
      assert.ok(received, `message ${number} passed actual default ingress`);
      return received;
    },
  };
}

test('complete spreadsheet flow: 1–34, busy arrivals become history and do not cause a drain run', async t => {
  // Busy messages would all hit if accidentally judged. They must never be judged.
  const e = runtime(t, { hit: number => number === 2 || number === 32 || number >= 13 && number <= 29 });
  await e.incoming(1);
  assert.equal(e.entry(1).read, true);
  assert.equal(e.sessions.current(e.key), null);
  assert.deepEqual(e.dice, [1]);

  await e.incoming(2);
  const first = e.sessions.current(e.key), deadline = first.waitUntil;
  assert.equal(first.status, 'waiting');
  assert.equal(e.entry(2).read, false);
  for (const number of numbers(3, 12)) {
    await e.incoming(number);
    assert.equal(e.entry(number).read, false);
    assert.equal(e.sessions.current(e.key).id, first.id);
    assert.equal(first.waitUntil, deadline, 'arrivals never extend the aggregation window');
  }
  assert.deepEqual(e.unread(), numbers(2, 12));
  assert.deepEqual(e.dice, [1, 2], 'aggregation arrivals do not roll dice');

  await until(() => e.requests.length === 1, 'first actual agent/model call');
  assert.equal(first.status, 'running');
  assert.deepEqual(first.triggerEntryIds, numbers(2, 12).map(number => e.entry(number).id));
  assert.deepEqual(e.unread(), [], 'all batch entries are read before the first model call');
  const firstPrompt = e.requests[0].find(message => message.role === 'user').content;
  const firstTriggers = firstPrompt.split('【未读信息】')[1].split('【当前时间】')[0];
  for (const number of numbers(2, 12)) assert.ok(firstTriggers.includes(text(number)));
  assert.ok(!firstTriggers.includes(text(1)), 'missed entry is historical context, not a trigger');

  for (const number of numbers(13, 29)) {
    await e.incoming(number);
    assert.equal(e.entry(number).read, true, `busy message ${number} becomes read immediately`);
    assert.deepEqual(e.updates.at(-1), { chatKey: e.key, unread: [] }, 'the final event exposes the saved read state to the UI');
    assert.deepEqual(e.unread(), []);
    assert.deepEqual(e.dice, [1, 2]);
    assert.deepEqual(first.triggerEntryIds, numbers(2, 12).map(n => e.entry(n).id));
  }
  const reopened = defaultComponents['data.messages']({ dataDir: e.dataDir, log: {} });
  assert.deepEqual(reopened.unread(e.key), [], 'busy read state survives a fresh disk read');
  assert.deepEqual(reopened.recent(e.key, Infinity).map(message => Number(message.mid)), numbers(1, 29), 'all busy messages remain in the archive');
  for (const number of numbers(13, 29)) assert.ok(!firstPrompt.includes(text(number)));

  e.gates[0].resolve();
  await until(() => first.status === 'noreply', 'first conversation completed');
  // Observe beyond both the 200ms drain and a hypothetical new 500ms window.
  await sleep(800);
  assert.equal(e.sessions.current(e.key), null);
  assert.equal(e.requests.length, 1, 'finishing never reruns messages 13–29');
  assert.equal(e.sessions.listSummaries().length, 1, 'no empty waiting session is created either');
  assert.deepEqual(e.orch.status().waiting, []);
  assert.equal(e.orch.status().wakeTimers, 0);
  assert.deepEqual(e.dice, [1, 2]);

  for (const number of [30, 31]) {
    await e.incoming(number);
    assert.equal(e.entry(number).read, true);
    assert.equal(e.sessions.current(e.key), null);
  }
  await e.incoming(32);
  const second = e.sessions.current(e.key), secondDeadline = second.waitUntil;
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'waiting');
  for (const number of [33, 34]) {
    await e.incoming(number);
    assert.equal(e.sessions.current(e.key).id, second.id);
    assert.equal(second.waitUntil, secondDeadline);
  }
  assert.deepEqual(e.unread(), [32, 33, 34], 'last spreadsheet rows remain unread during the next window');
  assert.deepEqual(e.dice, [1, 2, 30, 31, 32]);

  // Complete that window as a positive control: normal triggering still works,
  // and busy arrivals may appear as read history, never as this round's triggers.
  await until(() => e.requests.length === 2, 'second ordinary aggregation completed');
  assert.deepEqual(second.triggerEntryIds, [32, 33, 34].map(number => e.entry(number).id));
  const secondPrompt = e.requests[1].find(message => message.role === 'user').content;
  const history = secondPrompt.split('【已读信息】')[1].split('【未读信息】')[0];
  const triggers = secondPrompt.split('【未读信息】')[1].split('【当前时间】')[0];
  for (const number of numbers(13, 29)) { assert.ok(history.includes(text(number))); assert.ok(!triggers.includes(text(number))); }
  for (const number of [32, 33, 34]) assert.ok(triggers.includes(text(number)));
  e.gates[1].resolve();
  await until(() => second.status === 'noreply', 'second ordinary conversation completed');
  assert.deepEqual(e.unread(), []);
  assert.deepEqual(e.dice, [1, 2, 30, 31, 32]);
  assert.equal(e.sessions.listSummaries().length, 2);
  assert.deepEqual(e.sends, []);
  assert.deepEqual(e.errors, []);
});

test('ordinary busy arrivals stay read after a failed run and when the current model setting changes', async t => {
  for (const key of ['group:30501', 'private:30503']) await t.test(key, async t => {
    const e = runtime(t, { key, hit: () => true, fail: true });
    await e.incoming(1, { atMe: true });
    const session = e.sessions.current(key);
    await until(() => e.requests.length === 1, 'model run entered');
    e.config.api.model = '';
    await e.incoming(2);
    assert.equal(e.entry(2).read, true, 'an already running session still archives a busy arrival');
    e.config.api.model = 'offline-305';
    e.gates[0].resolve();
    await until(() => session.status === 'error', 'controlled run failure');
    await sleep(800);
    assert.equal(e.requests.length, 1);
    assert.equal(e.sessions.listSummaries().length, 1);
    assert.deepEqual(e.unread(), []);
    assert.deepEqual(e.orch.status().waiting, []);
    assert.deepEqual(e.dice, [1], 'ordinary busy messages are not reconsidered after failure');
  });
});

test('busy mentions retain the first mention and its tail for one follow-up, then reset at the next batch', async t => {
  for (const key of ['group:30501', 'private:30503']) await t.test(key, async t => {
    const e = runtime(t, { key, hit: () => false });
    await e.incoming(1, { atMe: true });
    const first = e.sessions.current(key);
    await until(() => e.requests.length === 1, 'first model run entered');
    for (const [number, options] of [[2, {}], [3, { atQQ: '30588' }], [4, { atQQ: 'all' }]]) {
      await e.incoming(number, options);
      assert.equal(e.entry(number).atMe, false);
      assert.equal(e.entry(number).read, true, 'ordinary messages and other/all mentions remain read');
    }
    await e.incoming(5, { atMe: true });
    assert.equal(e.entry(5).read, false, 'the first actual mention remains unread');
    assert.deepEqual(e.updates.at(-1), { chatKey: key, unread: [5] });
    await e.incoming(6);
    e.config.api.model = '';
    await e.incoming(7, { atMe: true });
    await e.incoming(8);
    e.config.api.model = 'offline-305';
    assert.deepEqual(e.unread(), [5, 6, 7, 8], 'all later arrivals remain unread, including repeated mentions');
    assert.deepEqual(e.dice, [1], 'busy arrivals do not run the wake strategy');
    assert.deepEqual(first.triggerEntryIds, [e.entry(1).id], 'the running prompt batch stays frozen');
    assert.equal(e.requests.length, 1);
    assert.deepEqual(e.orch.status().waiting, [], 'follow-up waits for the current run to finish');
    const reopened = defaultComponents['data.messages']({ dataDir: e.dataDir, log: {} });
    assert.deepEqual(reopened.unread(key).map(message => Number(message.mid)), [5, 6, 7, 8], 'queued messages survive a fresh disk read');

    // A pending mention in this chat must not change another chat's read policy.
    if (key === 'group:30501') {
      const other = await e.incoming(90, { key: 'group:30502' });
      assert.equal(other.read, true);
      assert.equal(e.sessions.current('group:30502'), null);
    }

    e.gates[0].resolve();
    await until(() => first.status === 'noreply' && e.orch.status().waiting.length === 1, 'one follow-up queued after completion');
    const second = e.sessions.current(key), deadline = second.waitUntil;
    assert.notEqual(second.id, first.id);
    await e.incoming(9);
    assert.equal(second.waitUntil, deadline);
    assert.deepEqual(e.unread(), [5, 6, 7, 8, 9]);
    await until(() => e.requests.length === 2, 'follow-up model run entered');
    assert.deepEqual(second.triggerEntryIds, [5, 6, 7, 8, 9].map(number => e.entry(number).id));
    const prompt = e.requests[1].find(message => message.role === 'user').content;
    const history = prompt.split('【已读信息】')[1].split('【未读信息】')[0];
    const triggers = prompt.split('【未读信息】')[1].split('【当前时间】')[0];
    for (const number of [2, 3, 4]) { assert.ok(history.includes(text(number))); assert.ok(!triggers.includes(text(number))); }
    for (const number of [5, 6, 7, 8, 9]) assert.ok(triggers.includes(text(number)));
    assert.deepEqual(e.unread(), []);
    assert.equal(e.sessions.listSummaries().length, 2, 'multiple mentions produce one follow-up session');
    assert.equal(e.dice.filter(number => number === 5).length, 1);
    assert.ok(!e.dice.includes(6) && !e.dice.includes(7) && !e.dice.includes(8));

    await e.incoming(10);
    assert.equal(e.entry(10).read, true, 'a new running batch starts with the ordinary read policy again');
    await e.incoming(11, { atMe: true });
    await e.incoming(12);
    assert.deepEqual(e.unread(), [11, 12]);
    e.gates[1].resolve();
    await until(() => e.requests.length === 3, 'next batch can independently queue another mention');
    const third = e.sessions.current(key);
    assert.deepEqual(third.triggerEntryIds, [11, 12].map(number => e.entry(number).id));
    e.gates[2].resolve();
    await until(() => third.status === 'noreply', 'last follow-up completed');
    await sleep(800);
    assert.equal(e.requests.length, 3, 'consumed mentions never create a duplicate follow-up');
    assert.deepEqual(e.orch.status().waiting, []);
    assert.deepEqual(e.unread(), []);
    assert.deepEqual(e.errors, []);
  });
});

test('a failed current batch still processes the pending mention and tail exactly once', async t => {
  const e = runtime(t, { hit: () => false, fail: true });
  await e.incoming(1, { atMe: true });
  const first = e.sessions.current(e.key);
  await until(() => e.requests.length === 1, 'first controlled model failure entered');
  await e.incoming(2);
  await e.incoming(3, { atMe: true });
  await e.incoming(4);
  assert.equal(e.entry(2).read, true);
  assert.deepEqual(e.unread(), [3, 4]);
  e.gates[0].resolve();
  await until(() => e.requests.length === 2, 'pending mention runs after failure');
  assert.equal(first.status, 'error');
  const second = e.sessions.current(e.key);
  assert.deepEqual(second.triggerEntryIds, [3, 4].map(number => e.entry(number).id));
  e.gates[1].resolve();
  await until(() => second.status === 'error', 'follow-up failure completed');
  await sleep(800);
  assert.equal(e.requests.length, 2);
  assert.deepEqual(e.unread(), []);
  assert.deepEqual(e.dice, [1, 3]);
});

test('pause cancels scheduling, resume retains the unread mention batch and resets busy read policy', async t => {
  const e = runtime(t, { hit: () => false });
  await e.incoming(1, { atMe: true });
  const first = e.sessions.current(e.key);
  await until(() => e.requests.length === 1, 'current batch entered');
  await e.incoming(2, { atMe: true });
  await e.incoming(3);
  e.orch.pause(); e.gates[0].resolve();
  await until(() => first.status === 'aborted', 'paused batch stopped');
  await sleep(250);
  assert.equal(e.requests.length, 1);
  assert.deepEqual(e.orch.status().waiting, []);
  assert.deepEqual(e.unread(), [2, 3]);
  e.orch.resume();
  await e.incoming(4);
  assert.deepEqual(e.unread(), [2, 3, 4]);
  await until(() => e.requests.length === 2, 'resumed mention backlog entered');
  const second = e.sessions.current(e.key);
  assert.deepEqual(second.triggerEntryIds, [2, 3, 4].map(number => e.entry(number).id));
  await e.incoming(5);
  assert.equal(e.entry(5).read, true);
  e.gates[1].resolve();
  await until(() => second.status === 'noreply', 'resumed batch completed');
  assert.deepEqual(e.unread(), []);
  assert.equal(e.requests.length, 2);
});
