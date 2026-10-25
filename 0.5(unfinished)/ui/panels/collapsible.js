// Opt-in native details enhancement. No host API, storage or permanent frame loop.
import {interfaceMotion,observeInterfaceMotion} from './motion.js';

const installed = new WeakMap();
const targets = new WeakMap();
export const collapsibleExpanded = details => !!details.open && (targets.get(details) ?? true);
export function installCollapsibles(doc = document) {
  if (installed.has(doc)) return installed.get(doc);
  const view = doc.defaultView, active = new Map(), media = view.matchMedia('(prefers-reduced-motion: reduce)');
  function settle(details, state) {
    if (active.get(details) !== state) return;
    active.delete(details);
    targets.delete(details);
    state.animation?.cancel();
    if (!state.want) details.open = false;
    for (const [node, inert] of state.inert) node.inert = inert;
    if (state.overflow) details.style.setProperty('overflow', state.overflow, state.priority);
    else details.style.removeProperty('overflow');
    state.summary.setAttribute('aria-expanded', String(details.open));
  }
  function toggle(details, summary) {
    const old = active.get(details), want = !(old ? old.want : details.open);
    const from = details.getBoundingClientRect().height;
    if (old) settle(details, old);
    const children = [...details.children].filter(node => node !== summary);
    if (!want && children.some(node => node.contains(doc.activeElement))) summary.focus({preventScroll: true});
    // Measure natural endpoints before installing the effect. Keep open while
    // closing so Chromium does not hide the UA details slot halfway through.
    details.open = want;
    const to = details.getBoundingClientRect().height;
    summary.setAttribute('aria-expanded', String(want));
    const preference=interfaceMotion(doc,media);
    if (!preference.enabled || preference.scale===0 || doc.visibilityState === 'hidden' || !details.animate || !from || from === to) return;
    details.open = true;
    const state = {want, summary, inert: children.map(node => [node, node.inert]),
      overflow: details.style.getPropertyValue('overflow'), priority: details.style.getPropertyPriority('overflow'), animation: null};
    for (const node of children) if (!want) node.inert = true;
    details.style.overflow = 'hidden'; active.set(details, state); targets.set(details, want);
    try {
      state.animation = details.animate([{height: `${from}px`}, {height: `${to}px`}], {
        duration: 220 * preference.duration, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'both',
      });
      state.animation.finished.then(() => settle(details, state), () => settle(details, state));
    } catch { settle(details, state); }
  }
  function click(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    const summary = event.target?.closest?.('details[data-collapsible] > summary');
    if (!summary) return;
    const control = event.target.closest('a,button,input,select,textarea,label,[contenteditable]');
    if (control && control !== summary && summary.contains(control)) return;
    event.preventDefault(); toggle(summary.parentElement, summary);
  }
  const finishAll = () => { for (const [details, state] of [...active]) settle(details, state); };
  const policy = () => { if (!interfaceMotion(doc,media).enabled || doc.visibilityState === 'hidden') finishAll(); };
  const unobservePolicy=observeInterfaceMotion(doc,finishAll);
  const observer = new view.MutationObserver(() => {
    for (const [details, state] of active) if (!details.isConnected || !details.open) settle(details, state);
  });
  observer.observe(doc, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']});
  doc.addEventListener('click', click);
  doc.addEventListener('visibilitychange', policy);
  media.addEventListener('change', policy);
  function dispose() {
    finishAll(); observer.disconnect(); unobservePolicy(); doc.removeEventListener('click', click);
    doc.removeEventListener('visibilitychange', policy); media.removeEventListener('change', policy);
    view.removeEventListener('pagehide', dispose); installed.delete(doc);
  }
  view.addEventListener('pagehide', dispose, {once: true}); installed.set(doc, dispose); return dispose;
}
