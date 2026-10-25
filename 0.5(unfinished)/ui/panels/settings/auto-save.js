// Settings controllers keep their transaction contracts; this queue only owns
// timing, navigation flushing and feedback after an acknowledged commit.
import {createIcon} from '../icons.js';

const tasks = new Set();
let feedback;
export function saveFeedback(kind, message, retry) { if(kind==='saved'&&[...tasks].some(task=>task.dirty))return;feedback?.({kind,message,retry}); }
export function mountSaveFeedback(doc = document) {
  const toast = doc.createElement('div'); toast.className = 'settings-save-toast';
  toast.setAttribute('role','status'); toast.setAttribute('aria-live','polite');
  toast.setAttribute('popover','manual'); toast.hidden = true;
  const icon=doc.createElement('span'),label=doc.createElement('span'),again=doc.createElement('button');
  icon.setAttribute('aria-hidden','true');again.type='button';again.append(createIcon('refresh',{size:16}));again.setAttribute('aria-label','重试保存');
  toast.append(icon,label,again);doc.body.append(toast);let timer,retry;
  again.addEventListener('click',()=>{void retry?.();});
  const failed=event=>saveFeedback('error',`未保存 · ${event.detail?.message||'请检查输入'}`);
  doc.addEventListener('settings-save-error',failed);
  feedback = detail => {
    clearTimeout(timer);retry=detail.retry;again.hidden=!retry;
    toast.dataset.state=detail.kind;icon.dataset.iconActive=String(detail.kind==='saving');icon.replaceChildren(createIcon(detail.kind==='error'?'warning':detail.kind==='saving'?'loading':'check',{size:18}));
    label.textContent=detail.message||(detail.kind==='error'?'未保存':detail.kind==='saving'?'保存中…':'已保存');
    toast.hidden=false;if(toast.showPopover&&!toast.matches(':popover-open'))toast.showPopover();
    if(detail.kind==='saved')timer=setTimeout(()=>{toast.hidePopover?.();toast.hidden=true;},2200);
  };
  return()=>{clearTimeout(timer);feedback=null;doc.removeEventListener('settings-save-error',failed);toast.remove();};
}
export function createAutoSave({root,save,dirty=()=>false,delay=600,onError=()=>{},savedMessage}) {
  let timer,flight=null,pending=false,disposed=false;
  const task={root,flush,get dirty(){return pending||!!flight||dirty();}};tasks.add(task);
  const changed=()=>root?.ownerDocument?.dispatchEvent(new Event('settings-autosave-state'));
  function fail(error){onError(error);saveFeedback('error',`未保存 · ${error.message||'请重试'}`,()=>flush().catch(fail));}
  function schedule(){if(disposed)return;pending=true;clearTimeout(timer);changed();saveFeedback('saving');timer=setTimeout(()=>{void flush().catch(fail);},delay);}
  async function flush(){
    clearTimeout(timer);
    if(flight){await flight;if(pending||dirty())return flush();return;}
    if(!pending&&!dirty())return;
    pending=false;
    flight=(async()=>{saveFeedback('saving');const result=await save();if(result===false)throw Error('请检查输入后重试');})();
    try{await flight;}catch(error){pending=true;throw error;}finally{flight=null;changed();}
    if(pending||dirty())return flush();
    saveFeedback('saved',savedMessage);
  }
  function dispose(){disposed=true;clearTimeout(timer);tasks.delete(task);root?.removeEventListener('close',dispose);changed();}
  if(root?.tagName==='DIALOG')root.addEventListener('close',dispose,{once:true});
  return {schedule,flush,get dirty(){return task.dirty;},dispose};
}
export async function flushAutoSaves(root) {
  for(const task of [...tasks])if(!root||task.root===root||root.contains(task.root))await task.flush();
}
export function hasAutoSaves(root) { return [...tasks].some(task=>(!root||task.root===root||root.contains(task.root))&&task.dirty); }
export function bindAutoSave(root,save,{dirty,delay,onError,events=['input','change'],accept=event=>!event.target.matches('input[type=search]')}={}) {
  const queue=createAutoSave({root,save,dirty,delay,onError});
  const edited=event=>{if(accept(event))queue.schedule();};
  for(const name of events)root.addEventListener(name,edited);
  return {schedule:queue.schedule,flush:queue.flush,get dirty(){return queue.dirty;},dispose(){for(const name of events)root.removeEventListener(name,edited);queue.dispose();}};
}
