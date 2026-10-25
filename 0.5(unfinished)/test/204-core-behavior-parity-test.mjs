// Offline business regressions: real config/message/session stores, tool registry,
// prompt construction and agent runner. No application boot, sockets or accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadComposition } from '../src/kernel/composition.js';
import { defaultComponents } from '../bundled/runtime-defaults/components.js';
import { resolveContextTier } from '../src/kernel/wake.js';
import coreTools from '../bundled/core-tools/index.js';
import { fixtureCapability } from './bundled-fixture-sdk.mjs';

const log = { info() {}, warn() {}, error() {} };
const groupA = 'group:20401', groupB = 'group:20402';
const immediate = () => new Promise(setImmediate);
async function settle() { for (let i = 0; i < 4; i++) await immediate(); }
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, 'controlled business operation completed'); await new Promise(r => setTimeout(r, 5)); }
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function finish(args = {}) {
  return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'finish-204', type: 'function', function: { name: 'finish', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-core-parity-204-'));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('qqa-core-parity-204-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}
function runtime(t, { patch = {}, components = defaultComponents, llm, getMuted = async () => ({ muted: false }) } = {}) {
  const dataDir = temporary(t);
  const config = components['runtime.config']({ dataDir, defaults: components['runtime.config.defaults']({ personaText: 'fixture persona' }), log });
  config.load();
  config.update({
    api: { model: 'offline-204', maxRounds: 2 },
    allow: { groups: ['20401', '20402'], private: [] },
    store: { contextSliderPos: 10, historyCount: 20, promptAnchor: { enabled: false } },
    persona: { botName: 'fixture bot' }, memory: { consolidateEnabled: false },
    chatActive: { enabled: false }, proactive: { enabled: false },
    sessionRetryAttempts: 0, wakeDelayMs: 200, drainDelayMs: 200,
  });
  config.update(patch);
  const cfg = () => config.get();
  const save = value => {
    config.update(value);
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    config.load(); // Actual saved configuration, not the caller's mutable object.
    assert.deepEqual(config.get().store, disk.store);
    assert.deepEqual(config.get().chatActive, disk.chatActive);
    return disk;
  };
  save({});
  const store = components['data.messages']({ dataDir, log });
  const sessions = components['data.sessions']({ dataDir, log });
  const registry = components['runtime.tools']({ log });
  const requests = [], sends = [], banChecks = [], events = [];
  const transport = { selfId: '20499', actions: { async getSelfMemberInfo(key) { banChecks.push(key); return getMuted(key); } }, async send(key, segments) { sends.push({ key, segments }); return { msgId: sends.length }; } };
  const send = components['core.send']({ cfg, store, transport, log });
  coreTools.setup({ capability: fixtureCapability({ cfg, store, send }), registerTool: def => registry.register({ ...def, bundled: true, ownerId: 'core-tools' }) });
  const loader = { isActive: () => true, hooksOf: () => [], promptSections: () => [] };
  const timers = new Map();
  const clock = { value: Date.now() };
  const orch = components['core.orchestrator']({
    cfg, store, sessions, memory: {}, send, registry, loader, transport, log, components,
    bus: { emit: (name, payload) => events.push({ name, payload }) },
    now: () => clock.value, random: () => 0,
    setTimeoutFn: (fn, delay) => { const timer = { unref() {} }; timers.set(timer, { fn, delay }); return timer; },
    clearTimeoutFn: timer => timers.delete(timer),
    buildToolsFor: args => components['core.tools.bundle'](args, { registry, loader }),
    execContextFor: ({ chatKey, session }) => ({ chatKey, session, send }),
    llmInvoker: async args => { requests.push(structuredClone(args.messages)); return llm ? llm(args, requests.length) : finish({ reason: 'fixture complete' }); },
  });
  t.after(() => { orch.stop(); sessions.stop(); assert.equal(timers.size, 0, 'all captured proactive timers stopped'); });
  let mid = 0;
  const append = (text, { key = groupA, atMe = false, ts = Date.now() } = {}) => store.appendIncoming(key, { mid: ++mid, ts, senderId: '20410', senderName: 'fixture member', text, atMe });
  return { dataDir, config, save, store, sessions, requests, sends, banChecks, events, orch, clock, timers, append,
    async incoming(text, options) { const entry = append(text, options); await orch.onIncoming(options?.key ?? groupA, entry); return entry; },
    async run(text, options) {
      await this.incoming(text, options);
      const session = sessions.current(options?.key ?? groupA);
      assert.ok(session, 'real incoming entry creates the default waiting session');
      await until(() => !['waiting', 'running'].includes(sessions.peek(session.id)?.status));
      return sessions.get(session.id);
    },
    async fireProactive() {
      assert.equal(timers.size, 1, 'one next proactive check is scheduled');
      const [timer, task] = [...timers][0]; timers.delete(timer); clock.value += task.delay; task.fn(); await settle();
    },
  };
}

test('restored unread backlog archives mechanical prefix misses once, including equal timestamps', async t => {
  const counts = new Map();
  const components = { ...defaultComponents, 'core.wake.resolve': args => {
    const count = (counts.get(args.entry.text) ?? 0) + 1; counts.set(args.entry.text, count);
    return resolveContextTier({ ...args, roll: args.entry.text === 'PREFIX-MISS' ? (count === 1 ? 90 : 10) : null });
  } };
  const e = runtime(t, { patch: { store: { contextSliderPos: 55 } }, components });
  await e.run('INITIAL', { atMe: true });
  const sameTs = Date.now();
  // Model an unread archive restored before scheduling recovery. Messages arriving
  // during a running session are now read immediately (spreadsheet flow, test 305).
  const prefix = e.append('PREFIX-MISS', { ts: sameTs });
  const trigger = e.append('MECHANICAL-TRIGGER', { ts: sameTs, atMe: true });
  const tail = e.append('BATCH-TAIL', { ts: sameTs + 1 });
  assert.equal(counts.has(prefix.text), false, 'restored backlog has not yet been judged');
  e.orch.scheduleWake(groupA, 200, { verified: false });
  await until(() => e.requests.length === 2 && e.sessions.running().length === 0);
  assert.equal(counts.get(prefix.text), 1, 'the first miss can never be rerolled into a later hit');
  assert.equal(counts.get(trigger.text), 1);
  assert.equal(counts.has(tail.text), false, 'post-trigger entries remain a batch, not extra judgments');
  const second = e.sessions.listSummaries().map(s => e.sessions.get(s.id)).find(s => s.triggerEntryIds.includes(trigger.id));
  assert.deepEqual(second.triggerEntryIds, [trigger.id, tail.id], 'equal timestamp does not reinclude a rejected prefix');
  assert.match(second.userPrompt, /PREFIX-MISS/);
  assert.equal(second.pastStateCount, 2, 'initial message and missed prefix are read history');
  assert.equal(e.store.unread(groupA).length, 0);
  assert.equal(defaultComponents['data.messages']({ dataDir: e.dataDir, log }).unread(groupA).length, 0, 'read decisions survive a fresh disk read');
  assert.equal(e.orch.status().waiting.length, 0);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(e.requests.length, 2, 'no drain timer can start an extra model run');
  assert.equal(e.sends.length, 0);
});

test('saved active disable takes effect at incoming time and while an active waiting batch is pending', async t => {
  for (const whileWaiting of [false, true]) await t.test(`waiting=${whileWaiting}`, async t => {
    const e = runtime(t, { patch: { chatActive: { enabled: true } }, llm: () => finish({ reason: 'continue', activeTopic: 'TOPIC-204' }) });
    const first = await e.run('SEED', { atMe: true });
    assert.equal(first.status, 'noreply');
    assert.equal(e.orch.status().activeTopics[0].topic, 'TOPIC-204', 'real registered finish tool creates active state');
    let waiting;
    if (whileWaiting) {
      await e.incoming('UNMENTIONED-WAITING');
      waiting = e.sessions.current(groupA);
      assert.equal(waiting.status, 'waiting');
    }
    const disk = e.save({ chatActive: { enabled: false } });
    assert.equal(disk.chatActive.enabled, false);
    if (whileWaiting) {
      await until(() => e.sessions.peek(waiting.id) === null);
      assert.equal(e.sessions.get(waiting.id), null, 'a canceled preflight leaves no discarded archive');
    } else await e.incoming('UNMENTIONED-AFTER-DISABLE');
    assert.equal(e.requests.length, 1, 'disabled active mode cannot override tier one');
    assert.equal(e.orch.status().activeTopics.length, 0);
    assert.equal(e.store.unread(groupA).length, 0);
    e.save({ chatActive: { enabled: true } });
    await e.incoming('NO-RESURRECTION');
    assert.equal(e.sessions.current(groupA), null);
    const after = await e.run('CALLED-AFTER-DISABLE', { atMe: true });
    assert.doesNotMatch(after.userPrompt, /TOPIC-204/, 'cleared active topic is not injected into the next real prompt');
  });
});

test('saved unified/per-group scope follows all four peak quadrants, private global inheritance and 90 boundary', async t => {
  const e = runtime(t, { patch: { store: { groupSliderPos: { 20401: 100 }, groupPeakPos: { 20401: { peak: 100, valley: 100 } }, peakSchedule: { peak: { start: '00:00', end: '00:00', sliderPos: 10 }, valley: { sliderPos: 10 } } } } });
  for (const peak of [false, true]) {
    e.save({ store: { unifiedTier: true, peakSchedule: { enabled: peak } } });
    for (const key of [groupA, groupB]) await e.incoming(`UNIFIED-${peak}`, { key });
    assert.equal(e.requests.length, peak ? 1 : 0, 'both groups follow global tier one while unified');
    e.save({ store: { unifiedTier: false } });
    const before = e.requests.length;
    const session = await e.run(`GROUP-A-${peak}`);
    await e.incoming(`GROUP-B-${peak}`, { key: groupB });
    assert.equal(session.contextTier, 4);
    assert.equal(e.requests.length, before + 1, 'only independently configured A responds');
  }
  const privateBefore=e.requests.length;await e.incoming('PRIVATE-SPLIT-ORDINARY',{key:'private:20403'});assert.equal(e.requests.length,privateBefore);assert.equal(e.sessions.current('private:20403'),null);
  assert.equal((await e.run('PRIVATE-SPLIT-CALLED',{key:'private:20403',atMe:true})).contextTier,1);
  e.save({store:{unifiedTier:true}});
  const privateSession = await e.run('PRIVATE-UNIFIED', { key: 'private:20403' });
  assert.equal(privateSession.contextTier, 4);
  e.save({ store: { contextSliderPos: 90, unifiedTier: true, peakSchedule: { enabled: false } } });
  assert.equal((await e.run('NINETY-IS-FOUR', { key: groupB })).contextTier, 4);
});

test('proactive timer checks self mute before model work, keeps its next check, then recovers after unmute', async t => {
  let muted = true;
  const e = runtime(t, { patch: { proactive: { enabled: true, probability: 1, idleThresholdMs: 300000, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000 } }, getMuted: async () => ({ muted }) });
  e.append('OLD-READ', { ts: e.clock.value - 400000 }); e.store.markAllRead(groupA);
  e.orch.startProactiveLoop(); await e.fireProactive();
  assert.equal(e.banChecks.length, 1);
  assert.equal(e.requests.length, 0); assert.equal(e.sends.length, 0);
  assert.equal(e.sessions.listSummaries().length, 0, 'muted proactive check creates no model session');
  assert.equal(e.timers.size, 1, 'mute does not stop future proactive checks');
  muted = false; await e.fireProactive();
  assert.equal(e.banChecks.length, 2, 'next check expires the previous mute cache');
  assert.equal(e.requests.length, 1);
  assert.equal(e.sessions.listSummaries()[0].proactive, true);
  assert.equal(e.timers.size, 1);
});

test('pause/resume or stop revokes a proactive mute query even if its reply arrives after resume', async t => {
  for (const action of ['pause-resume', 'stop']) for (const muted of [false, true]) await t.test(`${action}, muted=${muted}`, async t => {
    const gate = deferred(); let checks = 0;
    const e = runtime(t, { patch: { proactive: { enabled: true, probability: 1, idleThresholdMs: 300000, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000 } }, getMuted: () => ++checks === 1 ? gate.promise : { muted: false } });
    e.append('OLD-READ', { ts: e.clock.value - 400000 }); e.store.markAllRead(groupA);
    e.orch.startProactiveLoop(); await e.fireProactive();
    assert.equal(checks, 1);
    const pending = e.append('ARRIVED-DURING-QUERY', { atMe: true });
    if (action === 'pause-resume') { e.orch.pause(); e.orch.resume({ skipBacklog: true }); } else e.orch.stop();
    gate.resolve({ muted }); await settle();
    assert.equal(e.requests.length, 0); assert.equal(e.sends.length, 0);
    assert.equal(e.sessions.listSummaries().length, 0);
    assert.deepEqual(e.store.unread(groupA).map(m => m.id), [pending.id], 'late mute reply cannot mark newly arrived data read');
    assert.equal(e.timers.size, action === 'pause-resume' ? 1 : 0, 'only a resumed generation owns a next timer');
    if (action === 'pause-resume') {
      await e.orch.wake(groupA);
      assert.equal(checks, 2, 'cancelled query must not publish its cache into the resumed generation');
      assert.equal(e.requests.length, 1);
    }
  });
});

test('appended core.orchestrator file changes the actual default incoming path and removal restores it', async t => {
  const appRoot = temporary(t), layer = path.join(appRoot, 'overrides', 'parity204');
  fs.mkdirSync(layer, { recursive: true });
  fs.writeFileSync(path.join(layer, 'orchestrator.mjs'), `export default previous => options => previous({ ...options, components: { ...options.components, 'core.wake.resolve': args => args.entry.text === 'OVERRIDE-204' ? { shouldRespond: true, tier: 1, reason: 'appended orchestration' } : options.components['core.wake.resolve'](args) } });`);
  const manifest = { version: 2, id: 'parity204', components: { 'core.orchestrator': { module: 'orchestrator.mjs', mode: 'wrap' } } };
  fs.writeFileSync(path.join(layer, 'composition.json'), JSON.stringify(manifest));
  const selected = await loadComposition({ appRoot });
  assert.notEqual(selected.components['core.orchestrator'], defaultComponents['core.orchestrator']);
  assert.equal(selected.components['core.prompt.user'], defaultComponents['core.prompt.user']);
  const replaced = runtime(t, { components: selected.components });
  const session = await replaced.run('OVERRIDE-204');
  assert.equal(session.contextReason, 'appended orchestration'); assert.match(session.userPrompt, /OVERRIDE-204/);
  replaced.orch.stop();
  fs.writeFileSync(path.join(layer, 'composition.json'), JSON.stringify({ ...manifest, enabled: false }));
  const restored = runtime(t, { components: (await loadComposition({ appRoot })).components });
  await restored.incoming('OVERRIDE-204');
  assert.equal(restored.requests.length, 0); assert.equal(restored.store.unread(groupA).length, 0);
});
