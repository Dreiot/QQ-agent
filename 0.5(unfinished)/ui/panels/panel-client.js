import {setRefreshInterval} from './refresh-policy.js';
import {panelApiRequestTimeout} from './request-timeouts.js';
import {resetDestructiveActions} from './destructive-action.js';
import {createVisualPicker} from './visual-picker.js';

let nonce='',panel='',sequence=0,leaving=false,leaveId=null,initialViewState={},settingsSave=false,contentAnnounced=false;
const waiters=new Map(),events=new Set(),beforeLeaveHandlers=new Set(),leaveHandlers=new Set(),stateProviders=new Map();
const shellOrigin='*'; // sandbox iframe has opaque origin; source + panel + nonce remain mandatory validation.
const visualPicker=createVisualPicker(document,{select:selection=>{if(nonce&&!leaving)void rpc('appearance.select',selection).catch(()=>{});}});
let visualEditorState=null,visualEditorTicket=null;
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&visualEditorState?.active===true&&visualEditorState.picking===false){event.preventDefault();event.stopPropagation();void rpc('appearance.select',{exit:true}).catch(()=>{});}});
const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('安全握手超时')),15000);window.addEventListener('panel-ready',()=>{clearTimeout(timer);resolve();},{once:true});});
function settle(id,kind,value){const waiter=waiters.get(id);if(!waiter)return;clearTimeout(waiter.timer);waiters.delete(id);waiter[kind](value);}
function send(message){parent.postMessage({...message,meta:{nonce,panel}},shellOrigin);}
window.addEventListener('destructive-window-progress',event=>{
  const progress=event.detail?.progress;
  if(!nonce||panel!=='settings'||!Number.isFinite(progress)||progress<0||progress>1||leaving&&progress>0)return;
  const phase=event.detail?.phase;
  send({jsonrpc:'2.0',method:'ui.destructiveProgress',params:{progress,...(['charging','pending','complete','cancelled'].includes(phase)?{phase}:{})}});
});
window.addEventListener('message',event=>{
  if(event.source!==parent||event.origin!==location.origin)return;
  const m=event.data;if(m?.jsonrpc!=='2.0')return;
  if(m.method==='panel.init'&&!nonce&&/^[a-f0-9]{32}$/.test(m.params?.nonce||'')&&/^[A-Za-z0-9_-]{1,64}$/.test(m.params?.panel||'')){
    nonce=m.params.nonce;panel=m.params.panel;settingsSave=m.params.settingsSave===true;initialViewState=m.params.viewState??{};send({jsonrpc:'2.0',method:'panel.ready'});window.dispatchEvent(new Event('panel-ready'));return;
  }
  if(!nonce||m.meta?.nonce!==nonce||m.meta?.panel!==panel)return;
  if(m.method==='shell.event'){
    if(m.params?.name==='refresh-policy')setRefreshInterval(m.params.payload?.interval);
    // 主题推送由 theme.js 统一消费（shell 在面板 ready 时推一次，之后变更再广播）。
    if(m.params?.name==='theme')window.dispatchEvent(new CustomEvent('qq-theme',{detail:m.params.payload}));
    if(m.params?.name==='visual-style')window.dispatchEvent(new CustomEvent('qq-visual-style',{detail:m.params.payload}));
    if(m.params?.name==='visual-editor'){const state=m.params.payload;visualEditorState=state;visualPicker.set(state?.active===true&&state?.picking===true);visualPicker.preview(state?.page===panel?state.state:null);if(state?.command==='parent'&&state?.page===panel)visualPicker.parent();if(state?.active&&typeof state.ticket==='string'&&state.ticket!==visualEditorTicket){visualEditorTicket=state.ticket;void rpc('appearance.select',{ack:state.ticket}).catch(()=>{});}}
    for(const fn of events)fn(m.params?.name,m.params?.payload);
    return;
  }
  if(m.method==='panel.leaveCancelled'){if(m.params?.flushId===leaveId){leaving=false;leaveId=null;}return;}
  if(m.method==='panel.leave'){
    if(leaving)return;leaving=true;leaveId=m.params?.flushId;
    // Capture synchronously before asynchronous leave work or late RPC replies.
    let viewState;
    try{viewState=Object.fromEntries([...stateProviders].map(([key,provider])=>[key,provider()]));viewState=JSON.parse(JSON.stringify(viewState));}catch{viewState=undefined;/* Host retains its last valid snapshot. */}
    resetDestructiveActions();
    (async()=>{
      try{
        // Saving is a precondition: failed writes keep the live editor usable.
        for(const fn of beforeLeaveHandlers)await fn();
        if(leaveId!==m.params?.flushId)return;
        const results=await Promise.allSettled([...leaveHandlers].map(fn=>Promise.resolve().then(fn)));
        const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
        send({jsonrpc:'2.0',method:'panel.flushed',params:{flushId:m.params?.flushId,ok:true,viewState}});
      }catch(error){leaving=false;send({jsonrpc:'2.0',method:'panel.flushed',params:{flushId:m.params?.flushId,ok:false,error:String(error?.message||'保存未完成').slice(0,512)}});}
    })();return;
  }
  if(Object.prototype.hasOwnProperty.call(m,'id'))m.error?settle(m.id,'reject',Object.assign(new Error(m.error.message),m.error)):settle(m.id,'resolve',m.result);
});
export async function rpc(method,params={},timeout=15000){
  await ready;
  return new Promise((resolve,reject)=>{const id=`p${++sequence}`,timer=setTimeout(()=>settle(id,'reject',new Error('请求超时')),timeout);waiters.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params});});
}
/** First real content (including a visible error), separate from the secure handshake. */
export async function contentReady(){
  try{await ready;}catch{return false;}
  if(leaving||contentAnnounced)return false;
  contentAnnounced=true;send({jsonrpc:'2.0',method:'panel.contentReady'});return true;
}
export const request=(method,path,body,query)=>rpc('api.request',{method,path,body,query},panelApiRequestTimeout(method,path));
/** 面板向宿主申请换肤：shell 校验后落地并广播（面板自身无宿主存储与 DOM 的访问权）。 */
export const applyHostTheme=(theme)=>rpc('theme.apply',{theme});
export const openVisualEditor=()=>rpc('appearance.open');
export const openCommunityPage=target=>rpc('ui.openExternal',{target});
export const openLocalProtocolPage=(target,id)=>rpc('ui.openExternal',{target,...(id?{id}:{})});
export const consoleUpdate=payload=>rpc('console.update',payload);
export const openConsoleTokenManager=()=>rpc('console.manageToken');
export const openCaptchaDiagnostics=()=>rpc('ui.captchaDiagnostics');
export const authenticateMarket=payload=>rpc('community.authenticateMarket',payload,180000);
export const cancelMarketAuthentication=()=>rpc('community.cancelMarketAuthentication');
export const publishMarket=payload=>rpc('community.publishMarket',payload,300000);
export const cancelMarketPublish=()=>rpc('community.cancelMarketPublish');
export const publishQuote=payload=>rpc('community.publishQuote',payload,180000);
export const cancelQuotePublish=()=>rpc('community.cancelQuotePublish');
export const publishFeedback=payload=>rpc('community.publishFeedback',payload,150000);
export const cancelFeedbackPublish=()=>rpc('community.cancelFeedbackPublish');
export const confirmAction=(text)=>rpc('ui.confirm',{text},120000);
export const notify=(text)=>rpc('ui.notify',{text});
export const ctx={call:(tool,args)=>rpc('ctx.call',{tool,args}),getConfig:(key)=>rpc('ctx.getConfig',{key}),notify:(text)=>rpc('ctx.notify',{text})};
export const onShellEvent=fn=>{events.add(fn);return()=>events.delete(fn);};
export const onLeave=fn=>{leaveHandlers.add(fn);return()=>leaveHandlers.delete(fn);};
export const onBeforeLeave=fn=>{beforeLeaveHandlers.add(fn);return()=>beforeLeaveHandlers.delete(fn);};
export async function settingsSaveAvailable(){await ready;return settingsSave;}
export const settingsSaveState=state=>rpc('settings.saveState',state);
export const saveSettings=state=>rpc('settings.save',state);
/** Own-scope initial snapshot and synchronous leave provider; never durable storage. */
export async function getViewState(key){await ready;const value=initialViewState?.[key];return value===undefined?null:JSON.parse(JSON.stringify(value));}
export function onViewStateSnapshot(key,provider){if(typeof key!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)||typeof provider!=='function'||stateProviders.has(key))throw new Error('视图状态声明无效');stateProviders.set(key,provider);return()=>stateProviders.delete(key);}
window.addEventListener('pagehide',()=>{leaving=true;resetDestructiveActions();for(const [id] of waiters)settle(id,'reject',new Error('面板已卸载'));events.clear();beforeLeaveHandlers.clear();leaveHandlers.clear();stateProviders.clear();initialViewState={};});
