// Disposable dialogs only. This module has no panel client, storage or host APIs.
// Native close events are queued; explicit close and Escape must release state
// before another dialog can be opened in the same JavaScript task.
import {createIcon} from './icons.js';
let nextDialogId=0;
export function prepareDialog(dialog){
  dialog.dataset.managedDialog='';
  for(const control of dialog.querySelectorAll('.dialog-head > button,.settings-dialog-head > button')){
    const label=control.getAttribute('aria-label')||control.textContent.trim();
    if(!/^关闭/.test(label))continue;
    control.classList.add('dialog-close-button');
    control.setAttribute('aria-label',label);control.setAttribute('aria-keyshortcuts','Escape');control.title='关闭（Esc）';
    if(!control.querySelector('svg'))control.replaceChildren(createIcon('close',{size:18}));
  }
  if(!dialog.hasAttribute('aria-label')&&!dialog.hasAttribute('aria-labelledby')){
    const heading=dialog.querySelector('h1,h2,h3,h4');
    if(heading){heading.id||=`dialog-title-${++nextDialogId}`;dialog.setAttribute('aria-labelledby',heading.id);}
  }
  if(!dialog.querySelector('.dialog-dismiss,.dialog-head button,.settings-dialog-head button')){
    const close=dialog.ownerDocument.createElement('button');close.type='button';close.className='dialog-dismiss dialog-close-button';
    close.setAttribute('aria-label','关闭弹窗');close.setAttribute('aria-keyshortcuts','Escape');close.title='关闭（Esc）';close.append(createIcon('close',{size:18}));
    close.addEventListener('click',()=>{const EventType=dialog.ownerDocument.defaultView.Event;if(dialog.dispatchEvent(new EventType('cancel',{cancelable:true})))dialog.close();});
    dialog.prepend(close);
  }
  // Floats do not align inside flex/grid dialogs. A shared header keeps the
  // dismiss control beside the heading in every layout and during scrolling.
  const dismiss=dialog.querySelector(':scope > .dialog-dismiss');
  const heading=dialog.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > article > h3:first-child');
  if(dismiss&&heading){
    const head=dialog.ownerDocument.createElement('div');head.className='dialog-standard-head';heading.before(head);head.append(heading,dismiss);
  }
  if(dialog.open&&dialog.ownerDocument.activeElement===dialog.querySelector('.dialog-dismiss')){
    const target=[...dialog.querySelectorAll('input:not([type="hidden"]),textarea,select,button:not(.dialog-dismiss),a[href]')].find(node=>!node.matches(':disabled,[hidden],[inert]')&&node.getClientRects().length);
    target?.focus({preventScroll:true});
  }
  return dialog;
}
export function installDisposableDialog(dialog, { onClosed, canClose, beforeClose, dismissOnBackdrop = false } = {}) {
  prepareDialog(dialog);
  // Some editors install cleanup before populating their heading/body.
  queueMicrotask(()=>{if(dialog.isConnected)prepareDialog(dialog);});
  const nativeClose = dialog.close.bind(dialog);
  const doc = dialog.ownerDocument;
  const parent = [...(doc?.querySelectorAll?.('dialog:modal') ?? [])].at(-1);
  const returnFocus = doc?.activeElement;
  let closed = false;
  let closing = null;
  let backdropPointer = null;
  function isBackdrop(event) {
    if (event.target !== dialog || !dialog.open) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  function pointerDown(event) {
    backdropPointer = event.button === 0 && event.isPrimary !== false && isBackdrop(event) ? event.pointerId : null;
  }
  function pointerCancel() { backdropPointer = null; }
  function backdropClick(event) {
    // A drag or text selection starting in the content must not dismiss it.
    const outside = backdropPointer !== null && (event.pointerId === undefined || event.pointerId === backdropPointer) && event.button === 0 && !event.defaultPrevented && isBackdrop(event);
    backdropPointer = null;
    if (outside) close();
  }
  function restoreParentFocus() {
    if (!parent?.isConnected || !parent.open || [...doc.querySelectorAll('dialog:modal')].at(-1) !== parent || parent.contains(doc.activeElement)) return;
    // Async parent actions may disable their button before opening a nested
    // confirmation, so native close cannot focus it. Use a live parent field
    // instead, without taking focus from a newly opened modal or valid target.
    const usable = (node) => node && parent.contains(node) && !node.matches(':disabled') && node.tabIndex >= 0 && node.getClientRects().length > 0;
    const target = usable(returnFocus) ? returnFocus : [...parent.querySelectorAll('input, textarea, select, button, a[href], [tabindex]')].find(usable);
    (target || parent).focus({ preventScroll: true });
  }
  function finish() {
    if (closed) return;
    closed = true;
    backdropPointer = null;
    dialog.removeEventListener('close', finish);
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('pointerdown', pointerDown);
    dialog.removeEventListener('pointercancel', pointerCancel);
    dialog.removeEventListener('click', backdropClick);
    dialog.remove();
    onClosed?.();
    restoreParentFocus();
  }
  function close(...args) {
    if (closed || canClose?.() === false) return;
    if(beforeClose){
      if(closing)return closing;
      let pending;try{pending=beforeClose();}catch(error){dialog.dispatchEvent(new CustomEvent('settings-save-error',{bubbles:true,detail:error}));return;}
      if(pending?.then){closing=Promise.resolve(pending).then(()=>{if(!closed){nativeClose(...args);finish();}},error=>{
        dialog.dispatchEvent(new CustomEvent('settings-save-error',{bubbles:true,detail:error}));
      }).finally(()=>{closing=null;});return closing;}
    }
    nativeClose(...args);
    finish();
  }
  function cancel(event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    close();
  }
  dialog.close = close;
  dialog.addEventListener('close', finish);
  dialog.addEventListener('cancel', cancel);
  if (dismissOnBackdrop) {
    dialog.addEventListener('pointerdown', pointerDown);
    dialog.addEventListener('pointercancel', pointerCancel);
    dialog.addEventListener('click', backdropClick);
  }
  return Object.freeze({ close, dispose: finish, get closed() { return closed; } });
}
