// Shared, opt-in motion for the shell and isolated panel documents.
// Effects never hold up a submit/RPC, write layout styles or run a permanent frame loop.
import {installPressFeedback} from './press-feedback.js';
const installed = new WeakMap();
const documents = new WeakMap();
const MAX_BATCH = 12;
const EASING = 'cubic-bezier(.2,.75,.2,1)';
const INITIAL = '.brand,.rail-heading,#nav,.workspace-context,.head,.toolbar,main > .grid,main > .card,main > .metrics,.settings-aside,.runtime-readiness,[data-motion="mount"]';
const APPEND = '.message,.toast,.permission-ask,.permission-card,.list-item,.settings-section,[data-motion="append"]';
const HIDDEN = '[hidden],.hidden,.is-hidden,dialog:not([open]),[data-motion="off"]';
const DEFAULT_PANELS = new Set(['sessions','chats','rules','memory','usage','skills','plugins','logs','settings','community']);

/** Read only visual preferences; these values never scale behavior timers. */
export function interfaceMotion(doc, media = doc?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')) {
  const style = doc?.defaultView?.getComputedStyle?.(doc.documentElement);
  const value = (name, fallback, max) => {
    const raw = style?.getPropertyValue?.(name)?.trim();
    return raw && Number.isFinite(Number(raw)) ? Math.min(max, Math.max(0, Number(raw))) : fallback;
  };
  const duration = value('--motion-duration-factor', 1, 3), scale = value('--motion-scale', 1, 3);
  return { enabled: !media?.matches && doc?.body?.dataset?.interfaceMotion !== 'off' && duration > 0, duration, scale };
}

/** Observe theme roots, never per-frame element styles or unrelated config. */
export function observeInterfaceMotion(doc, changed) {
  const view = doc?.defaultView;
  let previous = JSON.stringify(interfaceMotion(doc)), observer;
  if (view?.MutationObserver) {
    observer = new view.MutationObserver(() => {
      const next = interfaceMotion(doc), signature = JSON.stringify(next);
      if (signature !== previous) { previous = signature; changed(next); }
    });
    for (const root of [doc.documentElement, doc.body]) if (root) observer.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-interface-motion'] });
  }
  return () => observer?.disconnect();
}

function documentOf(root) {
  return root?.nodeType === 9 ? root : root?.ownerDocument;
}

function runtimeFor(doc) {
  let runtime = documents.get(doc);
  if (!runtime) {
    runtime = { doc, active: new Map(), media: doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)'), users: 0, watching: false };
    documents.set(doc, runtime);
  }
  return runtime;
}

function releasePolicy(runtime) {
  if (!runtime.watching || runtime.users || runtime.active.size) return;
  runtime.doc.removeEventListener('visibilitychange', runtime.policyChanged);
  if (runtime.media?.removeEventListener) runtime.media.removeEventListener('change', runtime.policyChanged);
  else runtime.media?.removeListener?.(runtime.policyChanged);
  runtime.unobservePolicy?.();
  runtime.watching = false;
}

function watchPolicy(runtime) {
  if (runtime.watching) return;
  runtime.policyChanged = () => {
    if (runtime.doc.visibilityState === 'hidden' || !interfaceMotion(runtime.doc, runtime.media).enabled) cancel(runtime);
  };
  runtime.unobservePolicy = observeInterfaceMotion(runtime.doc, () => cancel(runtime));
  runtime.doc.addEventListener('visibilitychange', runtime.policyChanged);
  if (runtime.media?.addEventListener) runtime.media.addEventListener('change', runtime.policyChanged);
  else runtime.media?.addListener?.(runtime.policyChanged);
  runtime.watching = true;
}

function cancel(runtime, predicate = () => true) {
  for(const stop of runtime.pressEffects||[])stop(predicate);
  for (const [node, animation] of runtime.active) {
    if (!predicate(node)) continue;
    runtime.active.delete(node);
    try { animation.cancel(); } catch { /* A detached animation must not affect the panel. */ }
  }
  releasePolicy(runtime);
}

function visible(node, doc) {
  if (!node || node.nodeType !== 1 || node.isConnected === false || doc.visibilityState === 'hidden') return false;
  if (node.closest?.(HIDDEN)) return false;
  // This also excludes a closed details body or a panel hidden by its own stylesheet.
  return !node.getClientRects || node.getClientRects().length > 0;
}

/** Short, cancellable entrance. Returns the Animation, or null when motion is unavailable. */
export function animateMount(node, { delay = 0, duration = 220, offset = 8 } = {}) {
  const doc = documentOf(node);
  if (!doc || typeof node?.animate !== 'function') return null;
  const runtime = runtimeFor(doc);
  const policy = interfaceMotion(doc, runtime.media);
  if (!policy.enabled || !visible(node, doc)) return null;
  cancel(runtime, target => target === node);
  const bounded = (value, fallback, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Number(value))) : fallback;
  let animation;
  try {
    animation = node.animate([
      { opacity: 0, transform: `translate3d(0,${bounded(offset, 8, 20) * policy.scale}px,0)` },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], { duration: bounded(duration, 220, 400) * policy.duration, delay: bounded(delay, 0, 180) * policy.duration, easing: EASING, fill: 'backwards' });
  } catch { return null; }
  runtime.active.set(node, animation);
  watchPolicy(runtime);
  const release = () => {
    if (runtime.active.get(node) === animation) runtime.active.delete(node);
    releasePolicy(runtime);
  };
  // A cancelled WAAPI finished promise rejects; consuming it prevents page errors.
  if (animation.finished?.then) animation.finished.then(release, release);
  else { animation.onfinish = release; animation.oncancel = release; }
  return animation;
}

/** Install only in this document/subtree. User plugins choose whether to import it. */
export function installMotion(root = typeof document !== 'undefined' ? document : null) {
  if (!root || !root.querySelectorAll) return () => {};
  if (installed.has(root)) return installed.get(root);
  const doc = documentOf(root), view = doc?.defaultView;
  if (!doc || !view) return () => {};
  const runtime = runtimeFor(doc);
  const seen = new WeakSet();
  const pressed=installPressFeedback(root,{readPolicy:()=>interfaceMotion(doc,runtime.media)});
  const stopPressed=predicate=>pressed.cancelWhere(predicate);
  (runtime.pressEffects??=new Set()).add(stopPressed);
  // Data changes in built-in pages are reading updates, not fresh entrances.
  // Page entry, explicit dialogs/folds and opt-in appended effects still animate.
  const readingUpdates=DEFAULT_PANELS.has(doc.body?.dataset?.panel);
  let disposed = false, observer, lastSelection = -Infinity;
  const contains = node => root === doc || root === node || root.contains?.(node);
  const cancelWithin = node => cancel(runtime, target => target === node || node?.contains?.(target));
  const now = () => view.performance?.now?.() ?? Date.now();
  const batch = (nodes, { repeat = false, stagger = true } = {}) => {
    if (!interfaceMotion(doc, runtime.media).enabled || doc.visibilityState === 'hidden') return;
    let count = 0;
    for (const node of nodes) {
      if (count >= MAX_BATCH) break;
      if (!contains(node) || (!repeat && seen.has(node)) || !visible(node, doc)) continue;
      seen.add(node);
      animateMount(node, { delay: stagger ? count * 14 : 0 });
      count++;
    }
  };
  const initial = () => { if (!disposed) batch(root.querySelectorAll(INITIAL)); };
  const selection = event => {
    if (event.target?.closest?.('.tabs button,button[data-tab],.list-item,.settings-sidebar a')) lastSelection = now();
  };
  const toggle = event => {
    const details = event.target;
    if (details?.tagName !== 'DETAILS' || !contains(details) || details.hasAttribute('data-collapsible')) return;
    if (!details.open) { cancelWithin(details); return; }
    batch([...details.children].filter(node => node.tagName !== 'SUMMARY'), { repeat: true, stagger: false });
  };
  const close = event => { if (event.target?.tagName === 'DIALOG') cancelWithin(event.target); };
  const changed = records => {
    if (disposed) return;
    const added = [], revealed = [], selectedViews = new Set();
    for (const record of records) {
      if (record.type === 'attributes') {
        const node = record.target;
        if (record.attributeName === 'open') {
          if (node.tagName === 'DIALOG' && node.open) revealed.push(node);
          else if (!node.open) cancelWithin(node);
        } else {
          const wasHidden = record.attributeName === 'hidden' ? record.oldValue !== null : /(?:^|\s)(?:hidden|is-hidden)(?:\s|$)/.test(record.oldValue || '');
          if (node.closest?.(HIDDEN)) cancelWithin(node);
          else if (wasHidden) revealed.push(node);
        }
        continue;
      }
      for (const node of record.removedNodes) cancelWithin(node);
      // Replaced polling tables/lists do not replay the whole entrance sequence.
      // Chat history moves its retained nodes with replaceChildren; in that case
      // only identities that were not present in the removal set are entrances.
      const removed = new Set(record.removedNodes);
      const retainsNodes = [...record.addedNodes].some(node => removed.has(node));
      if ((!removed.size || retainsNodes) && added.length < MAX_BATCH) {
        for (const node of record.addedNodes) {
          if (added.length >= MAX_BATCH) break;
          if (removed.has(node)) continue;
          if (node.nodeType !== 1) continue;
          if (node.matches?.(APPEND)) added.push(node);
          else {
            for (const child of node.querySelectorAll?.(APPEND) || []) {
              added.push(child);
              if (added.length >= MAX_BATCH) break;
            }
          }
        }
      }
      // A user-selected detail may update asynchronously; background polling does not.
      if (!readingUpdates && now() - lastSelection < 500) {
        const detail = record.target.closest?.('#detail,[data-motion="view"]');
        if (detail) selectedViews.add(detail);
      }
    }
    batch(revealed, { repeat: true, stagger: false });
    batch(selectedViews, { repeat: true, stagger: false });
    batch(readingUpdates?added.filter(node=>node.dataset.motion==='append'):added);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    runtime.pressEffects.delete(stopPressed);pressed.dispose();
    observer?.disconnect();
    root.removeEventListener('click', selection, true);
    root.removeEventListener('toggle', toggle, true);
    root.removeEventListener('close', close, true);
    doc.removeEventListener('DOMContentLoaded', initial);
    view.removeEventListener('pagehide', cleanup);
    cancel(runtime, contains);
    installed.delete(root);
    runtime.users--;
    releasePolicy(runtime);
  };
  installed.set(root, cleanup);
  runtime.users++;
  watchPolicy(runtime);
  root.addEventListener('click', selection, true);
  root.addEventListener('toggle', toggle, true);
  root.addEventListener('close', close, true);
  view.addEventListener('pagehide', cleanup, { once: true });
  if (view.MutationObserver) {
    observer = new view.MutationObserver(changed);
    observer.observe(root === doc ? doc.documentElement : root, {
      childList: true, subtree: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['hidden', 'open', 'class'],
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', initial, { once: true });
  else initial();
  return cleanup;
}
