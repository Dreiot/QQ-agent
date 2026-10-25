import {ApiClient} from './api-client.js';
import {installDisposableDialog} from '../panels/dialog-lifecycle.js';
import {createAutoSave,mountSaveFeedback} from '../panels/settings/auto-save.js';

export function consoleTokenValue(value) {
  const token=String(value ?? '').trim();
  if(!token||token.length>8192)throw new Error('请输入非空访问令牌（最多8192字符）');
  try{if(new Headers({'x-console-token':token}).get('x-console-token')!==token)throw new Error();}
  catch{throw new Error('访问令牌包含无法用于HTTP请求头的字符');}
  return token;
}

// Sensitive state stays in the root document. RPC callers receive only {ok:true}.
export function createTokenManagement({api,auth,sse,win=window,doc=document}={}) {
  let dialog=null,busy=false;
  const adopt=token=>{api.setToken(token);auth.adopt(token);sse?.setToken(token);};
  async function write(value) {
    const token=consoleTokenValue(value),old=auth.token;
    if(token===old)return {ok:true,unchanged:true};
    try{await api.post('/api/config',{server:{token}});}catch{/* confirmation below handles an unknown commit */}
    // A committed write can lose its response. Authenticate the candidate before
    // changing shared credentials; an unauthenticated empty-token server is no proof.
    const candidate=new ApiClient({token,base:api.base,timeout:api.timeout});
    try{
      const config=await candidate.get('/api/config');
      if(config?.server?.hasToken!==true)throw new Error('新令牌未生效');
    }catch{throw new Error('令牌未能保存或确认，已保留当前凭据，请重试');}
    adopt(token);return {ok:true};
  }
  function open() {
    if(dialog?.open){dialog.querySelector('#console-token-current')?.focus();return {ok:true};}
    dialog=doc.createElement('dialog');dialog.id='console-token-dialog';dialog.className='console-token-dialog';
    const title=doc.createElement('h2');title.id='console-token-title';title.textContent='控制台访问令牌';dialog.setAttribute('aria-labelledby',title.id);
    const explanation=doc.createElement('p');explanation.textContent='访问令牌用于后台鉴权。本机控制台会自动认证，刷新或断线后无需手动输入；此处可管理令牌。';
    const current=doc.createElement('input');current.id='console-token-current';current.type='password';current.readOnly=true;current.value=auth.token;current.autocomplete='off';current.setAttribute('aria-label','当前访问令牌');
    const reveal=doc.createElement('button');reveal.type='button';reveal.textContent='显示';reveal.addEventListener('click',()=>{current.type=current.type==='password'?'text':'password';reveal.textContent=current.type==='password'?'显示':'隐藏';});
    const copy=doc.createElement('button');copy.type='button';copy.textContent='复制';
    const next=doc.createElement('input');next.id='console-token-new';next.type='password';next.autocomplete='new-password';next.setAttribute('aria-label','新访问令牌');next.placeholder='输入非空新令牌';
    const feedback=doc.createElement('p');feedback.id='console-token-status';feedback.setAttribute('role','status');
    copy.addEventListener('click',async()=>{try{await win.navigator.clipboard.writeText(auth.token);feedback.textContent='访问令牌已复制';}catch{feedback.textContent='复制失败，可显示后手动复制';}});
    const save=doc.createElement('button');save.type='button';save.textContent='保存新令牌';save.className='primary';
    const ownDialog=dialog;
    const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='关闭';cancel.addEventListener('click',()=>ownDialog.close());
    save.addEventListener('click',async()=>{
      if(busy)return;busy=true;save.disabled=cancel.disabled=next.disabled=true;feedback.textContent='正在保存…';
      try{await write(next.value);current.value=auth.token;current.type='password';reveal.textContent='显示';next.value='';feedback.textContent='访问令牌已保存，连接已更新';}
      catch(error){feedback.textContent=error.message;}
      finally{busy=false;save.disabled=cancel.disabled=next.disabled=false;}
    });
    const present=doc.createElement('div');present.className='console-token-row';present.append(current,reveal,copy);
    const autoSave=createAutoSave({root:ownDialog,save:async()=>{
      const value=next.value;if(!value.trim())return;busy=true;feedback.textContent='';
      try{await write(value);current.value=auth.token;current.type='password';reveal.textContent='显示';if(next.value===value)next.value='';}finally{busy=false;}
    }});
    next.addEventListener('input',()=>autoSave.schedule());
    const guardUnload=event=>{if(autoSave.dirty){event.preventDefault();event.returnValue='';}};win.addEventListener?.('beforeunload',guardUnload);
    const disposeFeedback=mountSaveFeedback(doc);
    const actions=doc.createElement('div');actions.className='dialog-actions';save.hidden=true;actions.append(cancel,save);
    dialog.append(title,explanation,present,next,feedback,actions);
    installDisposableDialog(ownDialog,{canClose:()=>!busy||autoSave.dirty,beforeClose:()=>autoSave.dirty?autoSave.flush():undefined,onClosed:()=>{win.removeEventListener?.('beforeunload',guardUnload);autoSave.dispose();disposeFeedback();current.value='';next.value='';if(dialog===ownDialog)dialog=null;}});
    doc.body.append(dialog);dialog.showModal();next.focus();return {ok:true};
  }
  return Object.freeze({open,write});
}
