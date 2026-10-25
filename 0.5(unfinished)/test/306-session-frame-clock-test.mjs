import assert from 'node:assert/strict';
import { installSessionActivity } from '../ui/panels/sessions/session-activity.js';

const originalNow = Date.now;
let wall = 1000, mono = 0, sequence = 0, reads = 0;
const frames = new Map(), intervals = new Map();
const doc = new EventTarget(), view = new EventTarget();
doc.hidden = false; doc.defaultView = view;
view.performance = { now: () => mono };
view.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
view.cancelAnimationFrame = id => frames.delete(id);
view.setInterval = (callback, delay) => { const id = ++sequence; intervals.set(id, { callback, delay, at: mono + delay }); return id; };
view.clearInterval = id => intervals.delete(id);
view.MutationObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} };
Date.now = () => wall;
const nodes = [];
const root = { ownerDocument: doc, querySelectorAll: () => nodes };
function clock(dataset) {
  let value = ''; const history = [];
  return { dataset, isConnected: true, history, closest: () => null,
    hasAttribute: name => name === 'data-elapsed-start' && dataset.elapsedStart !== undefined,
    get textContent() { return value; }, set textContent(next) { value = next; history.push({ at: mono, text: next }); },
  };
}
function frame(at, wallAt = 1000 + at) {
  mono = at; wall = wallAt;
  for (const [id, timer] of [...intervals]) if (at >= timer.at && intervals.has(id)) { timer.at = at + timer.delay; timer.callback(); }
  const pending = [...frames]; frames.clear();
  for (const [, callback] of pending) callback(at);
}
let activity;
try {
  activity = installSessionActivity({ list: root, getSessions: () => [], refresh: () => { reads++; } });
  assert.equal(frames.size + intervals.size, 0, 'idle owns no scheduled clock work');
  const wait = clock({ wait: '1251' }); nodes.push(wait); activity.sync();
  // A normal 117ms timer delivery skips .2 when only 251ms remained. Browser
  // paints still occur during that interval, so each tenth must be observable.
  for (const at of [17, 34, 51, 68, 85, 102, 117, 134, 151, 168, 185, 202, 219, 236, 253]) frame(at);
  assert.deepEqual(wait.history.map(item => item.text), ['等待 0.3 秒', '等待 0.2 秒', '等待 0.1 秒', '等待 0.0 秒', '等待调度…'], 'visible tenths survive timer delivery jitter');
  assert.equal(reads, 0, 'painting a clock does not perform server reads');
  assert.equal(frames.size + intervals.size, 0, 'expired wait does not keep painting or claim a run started');

  nodes.length = 0;
  const a = clock({ wait: '3000' }), b = clock({ wait: '3000' }); nodes.push(a, b);
  frame(300, 1300); activity.sync(); activity.sync();
  frame(400, 1400); const beforeJump = a.textContent;
  frame(420, -5000);
  assert.equal(a.textContent, beforeJump, 'wall clock adjustment does not extend a running countdown');
  assert.equal(a.textContent, b.textContent, 'list and detail share the same deadline clock');
  assert.equal(frames.size, 1, 'repeated synchronization keeps one visual frame scheduled');
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size + intervals.size, 0, 'hidden view suspends clock work');
  frame(900, -4520);
  const hidden = a.textContent;
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  assert.notEqual(a.textContent, hidden, 'returning to the panel catches up elapsed monotonic time');
  assert.equal(a.textContent, b.textContent);

  nodes.length = 0;
  const elapsed = clock({ elapsedStart: '-5000', elapsedBase: '0' }); nodes.push(elapsed); activity.sync();
  frame(950, -4470); const firstElapsed = elapsed.textContent;
  frame(1000, -9000); assert.notEqual(elapsed.textContent, firstElapsed, 'running elapsed continues across wall clock changes');
  assert.equal(frames.size, 1);
  nodes.length = 0; activity.sync();
  assert.equal(frames.size + intervals.size, 0, 'terminal and removed clocks release their visual work');
  activity.dispose(); frame(1100); activity.sync();
  assert.equal(frames.size + intervals.size, 0, 'disposed panel cannot schedule late visual work');
  console.log('✓ 306 visible countdown tenths, monotonic wait/elapsed, shared deadlines, hidden/idle/terminal cleanup and no clock polling');
} finally { activity?.dispose(); Date.now = originalNow; }
