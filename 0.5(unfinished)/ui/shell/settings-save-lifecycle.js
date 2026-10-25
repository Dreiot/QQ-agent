// Host-only lifecycle support for the provenance-checked default settings UI.
// Payloads remain document RAM; only the fixed authenticated config route writes.
import {accountStorageKey,resolveAccountScope,currentAccountScope} from '../panels/account-scope.js';
export const SETTINGS_KEEPALIVE_BYTES=60*1024;
export const SETTINGS_LEASE_KEY='qq-agent.settings-save-lease.v1';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const leaseId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function checkedPatch(patch){
  if(!object(patch))throw Object.assign(Error('设置保存必须是对象'),{status:400});
  if(Object.hasOwn(patch,'__replace__')||Object.hasOwn(patch,'server')&&(!object(patch.server)||Object.hasOwn(patch.server,'token')||Object.hasOwn(patch.server,'__replace__')))throw Object.assign(Error('控制台令牌只能在宿主窗口管理'),{status:403});
  return patch;
}
export function settingsSaveIdentity(manifest){
  return manifest?.kind==='bundled'&&manifest.id==='settings'&&manifest.saveLifecycle?.kind==='settings-v1'&&
    /^[A-Za-z0-9._-]{1,64}$/.test(manifest.stateOwner||'')&&/^[a-f0-9]{64}$/.test(manifest.stateGeneration||'')
    ?{owner:manifest.stateOwner,generation:manifest.stateGeneration}:null;
}
export function createSettingsSaveLifecycle({api,manifest,notify=()=>{},storage,now=()=>Date.now()}={}){
  const identity=settingsSaveIdentity(manifest);if(!identity)return null;
  const leaseScope=typeof api?.base==='string'?resolveAccountScope({pathname:api.base.startsWith('/accounts/')?api.base:'/'}):currentAccountScope;
  const storageKey=accountStorageKey(SETTINGS_LEASE_KEY,leaseScope);
  let latest=null,closed=false,lease=null,expiresAt=0,opening=null,storageAvailable=false;
  try{storage??=globalThis.sessionStorage;if(storage){const value=storage.getItem(storageKey);storage.setItem(storageKey,value??'null');storageAvailable=true;}}catch{storageAvailable=false;}
  function previous(){try{const row=JSON.parse(storage.getItem(storageKey)||'null');return object(row)&&leaseId(row.lease)&&typeof row.retired==='boolean'?row:null;}catch{return null;}}
  const body=state=>({...identity,lease,revision:state.revision,patch:state.patch});
  function ensureLease(){
    if(closed)return Promise.reject(Error('设置界面已卸载'));
    if(lease&&expiresAt>now()+1000)return Promise.resolve(lease);
    if(opening)return opening;
    // Renewal belongs to this instance, unlike an active ticket copied into a
    // new tab. Always fence our own old ticket before switching to its successor.
    const parent=lease?{lease,retired:true}:storageAvailable?previous():null;
    opening=(async()=>{
      const result=await api.request('POST','/api/config/lifecycle/open',{...identity,parentLease:parent?.lease??null,retireParent:parent?.retired===true});
      if(closed){if(leaseId(result?.lease))await api.request('POST','/api/config/lifecycle/open',{...identity,parentLease:result.lease,retireParent:true,retireOnly:true});throw Error('设置界面已卸载');}
      if(!leaseId(result?.lease)||!Number.isFinite(result.expiresAt)||result.expiresAt<=now())throw Error('设置保存租约响应无效');
      lease=result.lease;expiresAt=result.expiresAt;
      if(storageAvailable)try{storage.setItem(storageKey,JSON.stringify({lease,retired:false}));}catch{storageAvailable=false;}
      return lease;
    })().finally(()=>{opening=null;});return opening;
  }
  // Register before the editor's first input, without writing config or drafts.
  const ready=ensureLease();void ready.catch(error=>notify(`设置离开保护尚未就绪：${error.message}`));
  function stage(state){
    if(closed||!object(state)||!Number.isSafeInteger(state.revision)||state.revision<1||state.revision<=(latest?.revision??0)||state.patch!==null&&!object(state.patch)||typeof state.error!=='string'||state.error.length>1024||typeof state.guard!=='string'||state.guard.length>1024)throw Error('保存状态无效');
    const serialized=JSON.stringify(state);if(new TextEncoder().encode(serialized).length>1024*1024)throw Error('设置草稿超过1MiB；请分批保存');
    const copy=JSON.parse(serialized);if(copy.patch!==null)checkedPatch(copy.patch);latest=copy;
    return{ok:true};
  }
  async function save(state){
    if(closed||!object(state)||!object(state.patch)||!Number.isSafeInteger(state.revision)||state.revision<1)throw Error('保存请求无效');
    checkedPatch(state.patch);
    await ensureLease();if(closed)throw Error('设置界面已卸载');
    const result=await api.request('POST','/api/config/lifecycle',body(state));
    return result;
  }
  function beforeUnload(event){
    if(closed||!latest||latest.patch===null&&!latest.error&&!latest.guard)return false;
    const bytes=latest.patch===null?0:new TextEncoder().encode(JSON.stringify(body(latest))).length;
    if(!latest.error&&latest.patch&&bytes<=SETTINGS_KEEPALIVE_BYTES&&storageAvailable&&lease&&expiresAt>now()){
      // Duplicate revisions are idempotent at the endpoint. Never abort this
      // request when removing the iframe or disposing ordinary RPC controllers.
      void api.request('POST','/api/config/lifecycle',body(latest),undefined,{keepalive:true}).catch(error=>notify(`最后保存未确认：${error.message}；请留在页面重试`));
    }else if(latest.patch||latest.error)notify(latest.error||(!storageAvailable?'浏览器临时租约存储不可用；请先点击保存再离开':!lease||expiresAt<=now()?'设置离开保护尚未就绪；请先点击保存再离开':'未保存设置超过关页发送上限；请留在页面点击保存'));
    if(latest.guard)notify(latest.guard);
    event?.preventDefault?.();if(event)event.returnValue='';return true;
  }
  return{ready,stage,save,beforeUnload,get dirty(){return Boolean(latest&&(latest.patch!==null||latest.error||latest.guard));},close(){if(lease&&storageAvailable){const row=previous();if(row?.lease===lease)try{storage.setItem(storageKey,JSON.stringify({lease,retired:true}));}catch{storageAvailable=false;}}closed=true;latest=null;}};
}
