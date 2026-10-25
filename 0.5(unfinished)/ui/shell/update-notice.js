import {createIcon} from '../panels/icons.js';

export const UPDATE_INTERVAL_MS=3600000;
const VERSION=/^\d+(?:\.\d+){2,3}(?:[-+][A-Za-z0-9.-]+)?$/;
export function updateDownloadUrl(value){
  try{const u=new URL(String(value));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}
}

// Default host-only update policy. The backend implementation remains selected
// through runtime.priceUpdates; no installer, executable or credential crosses UI.
export function createUpdateNotice({api,doc=document,win=window,onStatus=()=>{}}){
  let disposed=false,pending=null,timer=null,last=null,error='',checkedAt=0,dismissed=false,visible=false,revision=0;
  const style=doc.createElement('style');style.textContent=`.update-notice{position:fixed;right:20px;bottom:20px;z-index:95;width:min(380px,calc(100vw - 40px));padding:16px;background:var(--surface,#202427);color:var(--text,#eee);border:1px solid var(--accent,#d2e343);box-shadow:0 8px 32px #0005}.update-notice[hidden]{display:none}.update-notice header{display:flex;align-items:center;justify-content:space-between;gap:12px}.update-notice p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.update-notice a{color:var(--accent,#d2e343)}.update-notice button{cursor:pointer}.update-available .nav-label::after{content:'•';color:var(--accent,#d2e343);margin-left:8px}`;
  doc.head.append(style);
  style.textContent+='@keyframes qqa-update-enter{from{opacity:0;transform:translateY(calc(8px * var(--motion-scale,1)))}to{opacity:1;transform:translateY(0)}}.update-notice{animation:qqa-update-enter calc(180ms * var(--motion-duration-factor,1)) cubic-bezier(.2,.7,.2,1)}@media(prefers-reduced-motion:reduce){.update-notice{animation:none}}';
  const box=doc.createElement('section');box.className='update-notice';box.hidden=true;box.setAttribute('aria-label','版本更新');box.setAttribute('role','status');
  const header=doc.createElement('header'),title=doc.createElement('strong'),close=doc.createElement('button'),notes=doc.createElement('p'),link=doc.createElement('a');
  close.type='button';close.append(createIcon('close',{size:18}));close.setAttribute('aria-label','关闭更新提示');link.textContent='查看下载页面';link.target='_blank';link.rel='noopener noreferrer';header.append(title,close);box.append(header,notes,link);doc.body.append(box);
  function snapshot(){return {result:last?structuredClone(last):null,error,checkedAt,busy:!!pending,revision};}
  function paint(){
    box.hidden=!visible||!last?.hasUpdate;title.textContent=last?`发现新版本 ${last.latest}（当前 ${last.current}）`:'';notes.textContent=last?.notes||'';
    const url=updateDownloadUrl(last?.url);link.hidden=!url;if(url)link.href=url;else link.removeAttribute('href');
    const nav=doc.querySelector('#nav button[data-panel=settings]');nav?.classList.toggle('update-available',!!last?.hasUpdate);
  }
  function publish(){if(disposed)return;++revision;paint();onStatus(snapshot());}
  close.addEventListener('click',()=>{dismissed=true;visible=false;publish();});
  function schedule(){win.clearTimeout(timer);if(!disposed)timer=win.setTimeout(()=>{void check();},UPDATE_INTERVAL_MS);}
  async function check({manual=false}={}){
    if(disposed)return snapshot();
    if(pending){const state=await pending;if(manual&&!disposed&&last?.hasUpdate){visible=true;publish();}return state;}
    let task;
    task=(async()=>{
      // Yield before publishing busy so callbacks cannot observe a null pending.
      await Promise.resolve();publish();
      try{
        const result=await api.get('/api/update-check');if(disposed)return snapshot();
        if(result?.ok!==true)throw new Error(result?.error||'版本检查失败');
        if(typeof result.current!=='string'||typeof result.latest!=='string'||result.current.length>128||result.latest.length>128||!VERSION.test(result.current)||!VERSION.test(result.latest)||typeof result.hasUpdate!=='boolean')throw new Error('版本检查响应无效');
        last={ok:true,current:result.current.slice(0,128),latest:result.latest.slice(0,128),hasUpdate:result.hasUpdate,url:updateDownloadUrl(result.url),notes:String(result.notes||'').slice(0,12000)};
        checkedAt=Date.now();error='';visible=last.hasUpdate&&(manual||!dismissed);
      }catch(reason){if(!disposed)error=String(reason?.message||reason).slice(0,1000);}
      finally{if(pending===task)pending=null;if(!disposed){publish();schedule();}}
      return snapshot();
    })();pending=task;return task;
  }
  function action(params={}){
    if(params.action==='status')return snapshot();
    if(params.action==='check')return check({manual:true});
    if(params.action==='reveal'){visible=!!last?.hasUpdate;publish();return snapshot();}
    throw new Error('不支持的版本操作');
  }
  function dispose(){if(disposed)return;disposed=true;win.clearTimeout(timer);box.remove();style.remove();doc.querySelector('#nav button[data-panel=settings]')?.classList.remove('update-available');}
  return {check,action,snapshot,repaint:paint,dispose};
}

