// Motion lifecycle and theme consumption. No snapshots of CSS or backend/RPC mutations.
import assert from 'node:assert/strict';
import { animateMount, installMotion } from '../ui/panels/motion.js';
import { applyTheme, DEFAULT_THEME, DARK_BASE, LIGHT_BASE, holdThemeColorTransitions, publicPanelTheme, readableAccentInk, resolveScheme } from '../ui/panels/theme.js';
import { createThemePreviewQueue } from '../ui/panels/theme-preview.js';
import { FormState } from '../ui/panels/settings/form-state.js';
import { RpcBridge } from '../ui/shell/rpc-bridge.js';

class Events {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, target = this) { for (const fn of [...(this.listeners.get(name) || [])]) fn({ type: name, target }); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

function fixture() {
  const media = new Events(); media.matches = false;
  let time = 1000, frameRequests = 0;
  const view = new Events(); view.matchMedia = () => media;
  const tokens=new Map();view.getComputedStyle=()=>({getPropertyValue:name=>tokens.get(name)||''});
  view.performance = { now: () => time };
  view.requestAnimationFrame = () => { frameRequests++; throw new Error('Motion must not create a permanent frame loop'); };
  const observers = [];
  view.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    change(records) { if (!this.disconnected) this.callback(records); }
  };
  const doc = new Events(); doc.nodeType = 9; doc.defaultView = view; doc.visibilityState = 'visible'; doc.readyState = 'complete';
  doc.initial = []; doc.querySelectorAll = () => doc.initial; doc.documentElement = {};doc.body={dataset:{}};
  class Node extends Events {
    constructor({ tag = 'DIV', className = '', id = '', parent = null, motion = '' } = {}) {
      super(); this.nodeType = 1; this.tagName = tag; this.ownerDocument = doc; this.className = className;
      this.id = id; this.parentElement = parent; this.children = []; this.dataset = { motion };
      this.hidden = false; this.open = false; this.isConnected = true; this.animations = []; this.returnValue = 'unchanged';
      this.style = new Proxy({}, { set() { throw new Error('Motion must not write inline layout styles'); } });
      parent?.children.push(this);
    }
    hasClass(name) { return this.className.split(/\s+/).includes(name); }
    hasAttribute(name) { return name === 'data-collapsible' && Object.hasOwn(this.dataset, 'collapsible'); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    getClientRects() { return this.rects === false ? [] : [{}]; }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector.includes('[hidden]')) {
          if (node.hidden || node.hasClass('hidden') || node.hasClass('is-hidden') || (node.tagName === 'DIALOG' && !node.open) || node.dataset.motion === 'off') return node;
        } else if (selector.includes('#detail')) {
          if (node.id === 'detail' || node.dataset.motion === 'view') return node;
        } else if (node.hasClass('list-item') || node.hasClass('tab-button')) return node;
      }
      return null;
    }
    matches() { return ['message', 'toast', 'permission-ask', 'permission-card', 'list-item', 'settings-section'].some(name => this.hasClass(name)) || this.dataset.motion === 'append'; }
    querySelectorAll() { return this.children.flatMap(child => [...(child.matches() ? [child] : []), ...child.querySelectorAll()]); }
    animate(keyframes, options) {
      let resolve, reject;
      const animation = {
        keyframes, options, cancelled: false, finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
        cancel() { this.cancelled = true; reject(new Error('Animation cancelled')); },
        finish() { resolve(); },
      };
      this.animations.push(animation); return animation;
    }
  }
  const change = records => observers.filter(observer => !observer.disconnected).forEach(observer => observer.change(records));
  return { doc, view, media, Node, tokens, observers, change, advance: amount => { time += amount; }, frameRequests: () => frameRequests };
}

const childList = (target, addedNodes = [], removedNodes = []) => ({ type: 'childList', target, addedNodes, removedNodes });
const attribute = (target, attributeName, oldValue = null) => ({ type: 'attributes', target, attributeName, oldValue });

assert.equal(typeof installMotion(), 'function', 'Node imports without a document remain safe');
assert.equal(animateMount(null), null);
{
  const env = fixture();
  env.doc.initial = Array.from({ length: 30 }, () => new env.Node());
  const dispose = installMotion(env.doc);
  assert.equal(installMotion(env.doc), dispose, 'Installing twice is idempotent');
  assert.equal(env.observers.length, 2, 'One subtree observer and one bounded theme-root observer');
  assert.equal(env.doc.initial.reduce((sum, node) => sum + node.animations.length, 0), 12, 'Large first paints have a bounded animation budget');
  for (const node of env.doc.initial.slice(0, 12)) {
    const animation = node.animations[0];
    assert.ok(animation.options.delay <= 180 && animation.options.duration <= 400);
    assert.equal(animation.options.fill, 'backwards', 'Staggered entrances hide before their start and leave no lasting styles after finish');
    assert.deepEqual(Object.keys(animation.keyframes[0]).sort(), ['opacity', 'transform']);
    assert.equal(node.hidden, false); assert.equal(node.returnValue, 'unchanged');
  }
  dispose(); dispose();
  assert.ok(env.doc.initial.slice(0, 12).every(node => node.animations[0].cancelled));
  assert.equal(env.observers[0].disconnected, true);
  assert.equal(env.doc.count() + env.view.count() + env.media.count(), 0, 'Explicit teardown removes document listeners');
  assert.equal(env.frameRequests(), 0);
}
console.log('✓ 137 bounded first paint, idempotent install and complete teardown');

for(const panel of ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']){
  const env=fixture();env.doc.body={dataset:{panel}};const first=new env.Node();env.doc.initial=[first];const dispose=installMotion(env.doc);
  assert.equal(first.animations.length,1,'page entry still animates');
  const detail=new env.Node({id:'detail'}),card=new env.Node({className:'list-item',parent:detail});
  env.doc.emit('click',{target:card});env.change([childList(detail,[card])]);assert.equal(card.animations.length,0,panel+' data changes do not enter again');assert.equal(detail.animations.length,0,panel+' selection does not replay the whole reading surface');
  const explicit=new env.Node({parent:detail,motion:'append'});env.change([childList(detail,[explicit])]);assert.equal(explicit.animations.length,1,'explicit opt-in effects remain available');dispose();
}
console.log('✓ 137 all nine built-in reading surfaces suppress automatic data entrances while preserving page entry and explicit effects');

{
  const env = fixture(), list = new env.Node();
  const dispose = installMotion(env.doc);
  const rows = Array.from({ length: 30 }, () => new env.Node({ className: 'message', parent: list }));
  env.change([childList(list, rows)]);
  assert.equal(rows.reduce((sum, row) => sum + row.animations.length, 0), 12);
  const replacement = new env.Node({ className: 'message', parent: list });
  rows.forEach(row => { row.isConnected = false; });
  env.change([childList(list, [replacement], rows)]);
  assert.equal(replacement.animations.length, 0, 'Polling replacement does not replay all rows');
  assert.ok(rows.slice(0, 12).every(row => row.animations[0].cancelled), 'Detached nodes lose active effects immediately');
  rows[0].isConnected = true;
  env.change([childList(list, [rows[0]])]);
  assert.equal(rows[0].animations.length, 1, 'Reusing existing history rows does not replay their entrances');
  const append = new env.Node({ className: 'message', parent: list });
  env.change([childList(list, [append])]);
  assert.equal(append.animations.length, 1, 'A genuinely new message enters once');
  const retainedAppend = new env.Node({ className: 'message', parent: list });
  env.change([childList(list, [rows[0], append, retainedAppend], [rows[0], append])]);
  assert.equal(retainedAppend.animations.length, 1, 'History replaceChildren animates only new identities among retained messages');
  assert.equal(rows[0].animations.length, 1); assert.equal(append.animations.length, 1);
  dispose();
}
console.log('✓ 137 incremental messages, polling replacements and detach cancellation');

{
  const env = fixture(); installMotion(env.doc);
  const dialog = new env.Node({ tag: 'DIALOG' }), child = new env.Node({ parent: dialog });
  assert.equal(animateMount(dialog), null); assert.equal(animateMount(child), null, 'Closed native dialogs never become visible for motion');
  dialog.open = true; env.change([attribute(dialog, 'open')]);
  assert.equal(dialog.animations.length, 1);
  dialog.open = false; env.change([attribute(dialog, 'open', '')]);
  assert.equal(dialog.animations[0].cancelled, true); assert.equal(dialog.returnValue, 'unchanged', 'Closing results are never intercepted');
  const tab = new env.Node(); tab.hidden = true;
  assert.equal(animateMount(tab), null);
  tab.hidden = false; env.change([attribute(tab, 'hidden', '')]);
  assert.equal(tab.animations.length, 1, 'Revealed tab content enters without altering hidden state');
  tab.hidden = true; env.change([attribute(tab, 'hidden')]);
  assert.equal(tab.animations[0].cancelled, true);
  const excluded = new env.Node({ motion: 'off' });
  assert.equal(animateMount(new env.Node({ parent: excluded })), null, 'Plugins can exclude a subtree');
  const details = new env.Node({ tag: 'DETAILS' });
  new env.Node({ tag: 'SUMMARY', parent: details }); const body = new env.Node({ parent: details });
  details.open = true; env.doc.emit('toggle', details);
  assert.equal(body.animations.length, 1); assert.equal(details.children[0].animations.length, 0);
  details.open = false; env.doc.emit('toggle', details);
  assert.equal(body.animations[0].cancelled, true);
  const owned = new env.Node({tag: 'DETAILS'}); owned.dataset.collapsible = ''; owned.open = true;
  const ownedBody = new env.Node({parent: owned}); env.doc.emit('toggle', owned);
  assert.equal(ownedBody.animations.length, 0, 'Fold-owned details must not also play a mount effect');
  const detail = new env.Node({ id: 'detail' }), choice = new env.Node({ className: 'list-item' });
  env.doc.emit('click', choice); env.change([childList(detail, [new env.Node()], [new env.Node()])]);
  assert.equal(detail.animations.length, 1, 'A selected detail can enter after its asynchronous data arrives');
  env.advance(700); env.change([childList(detail, [new env.Node()], [new env.Node()])]);
  assert.equal(detail.animations.length, 1, 'Background detail refreshes stay still');
  env.view.emit('pagehide');
  assert.ok(env.observers.every(observer => observer.disconnected));
  assert.equal(env.doc.count() + env.view.count() + env.media.count(), 0);
}
console.log('✓ 137 native dialog, details and tabs preserve semantics; selection differs from polling');

{
  const env = fixture(), first = new env.Node();
  const animation = animateMount(first, { duration: 9000, delay: 9000, offset: 9000 });
  assert.equal(animation.options.duration, 400); assert.equal(animation.options.delay, 180);
  env.doc.visibilityState = 'hidden'; env.doc.emit('visibilitychange');
  assert.equal(animation.cancelled, true, 'Standalone entrance also cancels when the document is hidden');
  assert.equal(animateMount(new env.Node()), null);
  env.doc.visibilityState = 'visible'; const next = animateMount(new env.Node());
  env.media.matches = true; env.media.emit('change');
  assert.equal(next.cancelled, true);
  assert.equal(animateMount(new env.Node()), null);
  env.media.matches = false; const last = animateMount(new env.Node());
  last.finish(); await Promise.resolve();
  assert.equal(env.doc.count() + env.media.count(), 0, 'One-off effects release policy listeners when finished');
  assert.equal(env.frameRequests(), 0);
}
console.log('✓ 137 reduced motion, background visibility and one-off animation cleanup');

{
  const env=fixture();env.tokens.set('--motion-duration-factor','2');env.tokens.set('--motion-scale','1.75');
  const first=animateMount(new env.Node(),{delay:20});
  assert.equal(first.options.duration,440);assert.equal(first.options.delay,40);assert.match(first.keyframes[0].transform,/14px/);
  env.tokens.set('--motion-duration-factor','.5');env.tokens.set('--motion-scale','.5');env.change([attribute(env.doc.documentElement,'style')]);
  assert.equal(first.cancelled,true,'changing visual preferences cancels an old entrance safely');
  const next=animateMount(new env.Node());assert.equal(next.options.duration,110);assert.match(next.keyframes[0].transform,/4px/);
  env.doc.body.dataset.interfaceMotion='off';env.change([attribute(env.doc.body,'data-interface-motion')]);
  assert.equal(next.cancelled,true);assert.equal(animateMount(new env.Node()),null,'the interface switch disables WAAPI entrances');
  env.doc.body.dataset.interfaceMotion='on';env.tokens.set('--motion-scale','0');
  const fade=animateMount(new env.Node());assert.match(fade.keyframes[0].transform,/0px/,'zero motion amplitude retains only the non-spatial fade');
  env.media.matches=true;env.media.emit('change');assert.equal(fade.cancelled,true);assert.equal(animateMount(new env.Node()),null,'system reduced motion takes priority');
  await Promise.resolve();assert.equal(env.doc.count()+env.media.count(),0);assert.ok(env.observers.every(observer=>observer.disconnected));
}
console.log('✓ 137 personalized duration and displacement, live cancellation, interface off and reduced-motion priority');

{
  assert.equal(readableAccentInk(DARK_BASE.accent, DARK_BASE.accentInk), DARK_BASE.accentInk);
  assert.equal(readableAccentInk(LIGHT_BASE.accent, LIGHT_BASE.accentInk), LIGHT_BASE.accentInk);
  assert.equal(readableAccentInk('#101010', '#101408'), '#ffffff');
  assert.equal(readableAccentInk('#ffff00', '#ffffff'), '#000000');
  assert.equal(readableAccentInk('#111', '#111'), '#ffffff');
  assert.equal(readableAccentInk('var(--custom)', '#abcdef'), '#abcdef', 'Unparsed legacy CSS colors retain the explicit fallback');
  const exposed = publicPanelTheme({ ...DEFAULT_THEME, accent: '#987654', bgImage: 'https://private.test/image?token=HOST-SECRET', apiKey: 'HOST-SECRET', custom: { private: true }, radius: 500, density: -200, preset: 'PRIVATE-PRESET', line: 'url(https://private.test/secret)' });
  assert.equal(exposed.accent, '#987654'); assert.equal(exposed.radius, 16); assert.equal(exposed.density, 0.7);
  assert.equal(exposed.line, DEFAULT_THEME.line); assert.equal(exposed.preset, DEFAULT_THEME.preset);
  assert.ok(!JSON.stringify(exposed).includes('HOST-SECRET') && !JSON.stringify(exposed).includes('private.test'));
  assert.ok(!Object.hasOwn(exposed, 'bgImage') && !Object.hasOwn(exposed, 'apiKey') && !Object.hasOwn(exposed, 'custom'));
  const copy = publicPanelTheme(DEFAULT_THEME); copy.accent = '#abcdef';
  assert.equal(DEFAULT_THEME.accent, DARK_BASE.accent, 'Public theme DTO is a fresh value, never a shared config reference');
  const priorDocument = globalThis.document;
  const vars = new Map(), dataset = {};
  const storage = globalThis.localStorage;
  globalThis.document = { documentElement: { style: { setProperty: (key, value) => vars.set(key, value) } }, body: { dataset } };
  globalThis.localStorage = { getItem() { throw new Error('Opaque origin'); }, setItem() { throw new Error('Opaque origin'); } };
  try {
    const scheme = resolveScheme({ mode: 'custom:industrial', custom: { industrial: { tokens: { ...DEFAULT_THEME, accent: '#101010', accentInk: '#101408' } } } });
    const before = structuredClone(scheme);
    applyTheme(scheme);
    assert.equal(vars.get('--accent'), '#101010'); assert.equal(vars.get('--accent-ink'), '#ffffff');
    assert.deepEqual(scheme, before, 'Readable ink does not overwrite the user scheme or saved config');
    assert.equal(dataset.styleMode, 'endfield');
    applyTheme({ ...DEFAULT_THEME, ...LIGHT_BASE, preset: 'light' });
    assert.equal(vars.get('color-scheme'), 'light'); assert.equal(vars.get('--accent'), LIGHT_BASE.accent);
    applyTheme(DEFAULT_THEME);
    assert.equal(vars.get('color-scheme'), 'dark'); assert.equal(vars.get('--accent'), DARK_BASE.accent);
  } finally { globalThis.document = priorDocument; globalThis.localStorage = storage; }
}
console.log('✓ 137 isolated panel theme consumption and readable custom accent ink retain saved schemes');

{
  const previousWindow = globalThis.window;
  const windowEvents = new Events(), sent = [], calls = [], configurations = [];
  globalThis.window = windowEvents;
  const frame = { contentWindow: { postMessage: message => sent.push(structuredClone(message)) }, addEventListener() {} };
  const manifest = { id: 'industrial_panel', ownerId: 'industrial', kind: 'user', generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', permissions: ['ui.panel'], api: [] };
  let applied = 0, rawApi = 0, sequence = 0;
  const bridge = new RpcBridge({ frame, manifest,
    onTheme() { applied++; },
    api: { request() { rawApi++; } },
    onUserCall: async (...args) => { calls.push(args); return { ok: true }; },
    onUserConfig: async (...args) => { configurations.push(args); return { label: 'own-config' }; },
  });
  const event = (method, params = {}, meta = {}) => ({ source: frame.contentWindow, origin: 'null', data: {
    jsonrpc: '2.0', id: String(++sequence), method, params,
    meta: { panel: manifest.id, nonce: bridge.nonce, ...meta },
  } });
  try {
    bridge.event('theme', { ...DEFAULT_THEME, apiKey: 'HOST-SECRET' });
    assert.equal(sent.length, 0, 'No theme event is delivered before the source/nonce handshake');
    await bridge.handle(event('panel.ready', {}, { nonce: 'wrong' }));
    const spoofReady = event('panel.ready'); spoofReady.source = {}; await bridge.handle(spoofReady);
    assert.equal(bridge.ready, false);
    await bridge.handle(event('panel.ready'));
    assert.equal(bridge.ready, true);
    const scheme = { ...DEFAULT_THEME, accent: '#12abcd', line: 'url(https://private.test/line)', bgImage: 'https://private.test/bg?token=HOST-SECRET', apiKey: 'HOST-SECRET', config: { server: { token: 'HOST-SECRET' } } };
    bridge.event('theme', scheme);
    const message = sent.at(-1);
    assert.equal(message.params.name, 'theme');
    assert.deepEqual(message.params.payload, publicPanelTheme(scheme));
    assert.equal(message.params.payload.accent, '#12abcd');
    assert.ok(!JSON.stringify(message).includes('HOST-SECRET') && !JSON.stringify(message).includes('private.test'));
    const before = sent.length;
    bridge.event('chat-update', { chatKey: 'PRIVATE' }); bridge.event('log', { text: 'PRIVATE' });
    bridge.event('plugin-loaded', { id: 'foreign', password: 'PRIVATE' });
    assert.equal(sent.length, before, 'Sharing paint does not expose global events or other plugin data');
    await bridge.handle(event('theme.apply', { theme: { accent: '#ffffff' } }));
    assert.ok(sent.at(-1).error); assert.equal(applied, 0);
    await bridge.handle(event('appearance.open',{}));assert.ok(sent.at(-1).error,'user panels cannot open the host appearance editor');
    await bridge.handle(event('appearance.select',{selector:'button',kind:'button'}));assert.ok(sent.at(-1).error,'user panels cannot drive host element selection');
    await bridge.handle(event('api.request', { method: 'GET', path: '/api/config' }));
    assert.ok(sent.at(-1).error); assert.equal(rawApi, 0, 'A themed user panel still cannot consume ordinary host API');
    await bridge.handle(event('ctx.call', { tool: 'industrial__run', args: { sample: true }, ownerId: 'forged', generation: 'forged' }));
    assert.deepEqual(calls, [['industrial__run', { sample: true }, manifest.id, manifest.generation]]);
    await bridge.handle(event('ctx.getConfig', { key: 'label' }));
    assert.deepEqual(configurations, [['label', manifest.id, manifest.generation]]);
    assert.deepEqual(sent.at(-1).result, { label: 'own-config' });
    await bridge.handle(event('ctx.call', {}, { nonce: 'wrong' }));
    await bridge.handle(event('ctx.call', {}, { panel: 'foreign' }));
    const spoofCall = event('ctx.call'); spoofCall.source = {}; await bridge.handle(spoofCall);
    const badOrigin = event('ctx.call'); badOrigin.origin = 'https://foreign.test'; await bridge.handle(badOrigin);
    assert.equal(calls.length, 1, 'Theme consumption preserves source, origin, nonce and panel identity validation');
    bridge.close(); const closedCount = sent.length;
    bridge.event('theme', DEFAULT_THEME); await bridge.handle(event('ctx.call'));
    assert.equal(sent.length, closedCount); assert.equal(calls.length, 1);
    assert.equal(windowEvents.count(), 0, 'Unloading the bridge removes the message listener');
  } finally { bridge.close(); globalThis.window = previousWindow; }
}
console.log('✓ 137 real user-panel bridge receives only paint, retains three RPC methods and rejects stale/spoofed identities');

function themeFrameFixture() {
  const doc = new Events(), view = new Events(), media = new Events(), frames = new Map(), properties = new Map();
  let sequence = 0;
  doc.visibilityState = 'visible'; doc.defaultView = view; view.document = doc; media.matches = false;
  view.matchMedia = () => media;
  view.requestAnimationFrame = fn => { const id = ++sequence; frames.set(id, fn); return id; };
  view.cancelAnimationFrame = id => frames.delete(id);
  doc.documentElement = { style: {
    getPropertyValue: key => properties.get(key)?.value || '', getPropertyPriority: key => properties.get(key)?.priority || '',
    setProperty: (key, value, priority = '') => properties.set(key, { value, priority }), removeProperty: key => properties.delete(key),
  } };
  const step = () => { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(); };
  return { doc, view, media, frames, properties, step };
}

{
  holdThemeColorTransitions(null);
  const e = themeFrameFixture(); holdThemeColorTransitions(e.doc);
  assert.equal(e.properties.get('--theme-color-duration').value, '0ms'); assert.equal(e.frames.size, 1);
  holdThemeColorTransitions(e.doc); assert.equal(e.frames.size, 1, 'Repeated theme writes keep only one bounded restore chain');
  e.step(); assert.equal(e.frames.size, 1); e.step(); assert.equal(e.frames.size, 0); assert.equal(e.properties.size, 0);
  assert.equal(e.doc.count() + e.view.count() + e.media.count(), 0);
  e.properties.set('--theme-color-duration', { value: '90ms', priority: 'important' }); holdThemeColorTransitions(e.doc);
  e.doc.visibilityState = 'hidden'; e.doc.emit('visibilitychange'); assert.equal(e.frames.size, 0);
  assert.deepEqual(e.properties.get('--theme-color-duration'), { value: '90ms', priority: 'important' });
  e.doc.visibilityState = 'visible'; holdThemeColorTransitions(e.doc); e.media.matches = true; e.media.emit('change');
  assert.equal(e.frames.size, 0); assert.equal(e.doc.count() + e.view.count() + e.media.count(), 0);
  e.media.matches = false; holdThemeColorTransitions(e.doc); e.view.emit('pagehide');
  assert.equal(e.frames.size, 0); assert.equal(e.doc.count() + e.view.count() + e.media.count(), 0);
}
console.log('✓ 137 color gate has two bounded frames and restores on background, reduced motion and unload');

{
  const e = themeFrameFixture(), calls = [];
  const preview = createThemePreviewQueue(theme => { calls.push(theme); return { ok: true, theme }; }, e.view);
  const form = new FormState({ ui: { uikit: { dark: { accent: '#000000' } } } });
  form.set('ui.uikit.dark.accent', '#112233'); const olderSave = form.snapshot();
  const first = preview({ accent: form.value('ui.uikit.dark.accent') });
  form.set('ui.uikit.dark.accent', '#abcdef'); const second = preview({ accent: form.value('ui.uikit.dark.accent') });
  form.accept(olderSave, { ui: { uikit: { dark: { accent: '#112233' } } } });
  assert.equal(form.value('ui.uikit.dark.accent'), '#abcdef'); assert.equal(form.dirty, true);
  assert.equal(e.frames.size, 1); e.step(); assert.deepEqual(await first, await second);
  assert.deepEqual(calls, [{ accent: '#abcdef' }]);
  const currentSave = form.snapshot(); form.accept(currentSave, { ui: { uikit: { dark: { accent: '#abcdef' } } } });
  assert.equal(form.dirty, false);
  const change = preview({ accent: '#789abc' }); await preview.flush(); assert.equal((await change).theme.accent, '#789abc');
  assert.equal(e.frames.size, 0);
  const hidden = preview({ accent: '#555555' }); e.doc.visibilityState = 'hidden'; e.doc.emit('visibilitychange');
  assert.equal((await hidden).theme.accent, '#555555'); assert.equal(e.frames.size, 0);
  e.doc.visibilityState = 'visible'; const pending = preview({ accent: '#666666' }).catch(error => error.message); e.view.emit('pagehide');
  assert.equal(await pending, '主题预览已卸载'); assert.equal(e.frames.size, 0);
  assert.equal(e.doc.count() + e.view.count() + e.media.count(), 0);
  const nodePreview = createThemePreviewQueue(theme => ({ result: theme }), null);
  assert.equal((await nodePreview('node-safe')).result, 'node-safe'); nodePreview.dispose();
  const failed = createThemePreviewQueue(() => { throw new Error('Preview only failure'); }, null);
  await assert.rejects(failed({}), /Preview only failure/); failed.dispose();
}
console.log('✓ 137 preview RPC coalescing retains latest color and every result without changing dirty/save versions');
