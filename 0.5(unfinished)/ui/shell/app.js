import {getRefreshInterval,setRefreshInterval} from '../panels/refresh-policy.js';
import {createUpdateNotice} from './update-notice.js';
import {PanelRegistry} from './panel-registry.js';
import {ApiClient} from './api-client.js';
import {SseClient} from './sse-client.js';
import {StateStore} from './state-store.js';
import {createConsoleAuth} from './console-auth.js';
import {verifyPublicCaptcha} from './public-captcha.js';
import {createTokenManagement} from './token-management.js';
import {createCaptchaDiagnostics} from './captcha-diagnostics.js';
import {publishMarketFromHost} from './market-publication.js';
import {authenticateMarketFromHost} from './market-authentication.js';
import {publishQuoteFromHost} from './quote-publication.js';
// ui.uikit 是结构化的（mode + light/dark/custom），要先解析出当前生效方案再应用
import {resolveScheme} from '../panels/theme.js';
import {createIcon} from '../panels/icons.js';
import {LOCAL_PROTOCOL_RELEASES,localProtocolLoginUrl} from '../panels/local-protocol-links.js';
import {installMotion,observeInterfaceMotion} from '../panels/motion.js';
import {createRefreshQueue} from './refresh-queue.js';
import {createPanelRecovery} from './panel-recovery.js';
import {createStartupNavigation} from './startup-navigation.js';
import {createDestructiveFeedback} from './destructive-feedback.js';
import {createPauseControls} from './pause-controls.js';
import {createAccountSwitcher} from './account-switcher.js';
import {createVisualEditor} from './visual-editor.js';
import {readPanelTarget,panelLocationUrl} from './account-navigation.js';
import {accountStorageKey,currentAccountScope} from '../panels/account-scope.js';

installMotion(document);
// Preference edits settle existing shell transitions at their real layout
// endpoints. New navigation gestures use the updated CSS duration tokens.
const stopShellMotion=observeInterfaceMotion(document,()=>{
  const shell=document.querySelector('.app-shell');
  for(const animation of shell?.getAnimations?.({subtree:true})||[]){
    if(typeof animation.transitionProperty==='string')animation.cancel();
  }
  for(const notice of document.querySelectorAll('.update-notice'))for(const animation of notice.getAnimations?.()||[])if(animation.animationName==='qqa-update-enter')animation.cancel();
});
window.addEventListener('pagehide',stopShellMotion,{once:true});
document.querySelector('#brand-emblem')?.append(createIcon('emblem',{size:36}));
document.querySelector('#navigation-dismiss')?.append(createIcon('close',{size:16}));
const readinessNames={onebot:'OneBot',model:'模型配置'};
for(const [id,name] of Object.entries(readinessNames)){
  const item=document.querySelector('#ready-'+id);
  item.querySelector('.readiness-icon').append(createIcon('status-'+id+'-pending',{size:24}));
  item.dataset.icon='pending';
  item.title=name+'：正在读取状态。';
  item.disabled=true;
  item.addEventListener('click',()=>open('settings',{section:id==='model'?'models':'onebot'}));
}

// Local shell layout only: resizing navigation never remounts a plugin or writes config.
const collapseButton=document.querySelector('#brand-emblem');
const compactViewport=window.matchMedia('(max-width: 640px)');
const collapseKey=accountStorageKey('qq-agent.sidebar-collapsed');
let collapsePreference=null;
let compactCollapsePreference=null;
try{const saved=localStorage.getItem(collapseKey);if(saved==='true'||saved==='false')collapsePreference=saved==='true';}catch{}
function syncNavigationCollapse(){
  const collapsed=compactViewport.matches?(compactCollapsePreference??true):(collapsePreference??false);
  document.body.dataset.railCollapsed=String(collapsed);
  const hidden=document.body.dataset.sidebar==='hidden';
  collapseButton.setAttribute('aria-expanded',String(hidden?document.body.classList.contains('navigation-peek'):!collapsed));
  const label=hidden?'收起导航':collapsed?'展开侧栏':'收起侧栏';
  collapseButton.setAttribute('aria-label',label);collapseButton.title=label;
}
collapseButton.addEventListener('click',()=>{
  if(document.body.dataset.sidebar==='hidden'){setNavigationPeek(false,{restoreFocus:true});return;}
  const next=document.body.dataset.railCollapsed!=='true';
  if(compactViewport.matches)compactCollapsePreference=next;
  else{collapsePreference=next;try{localStorage.setItem(collapseKey,String(collapsePreference));}catch{}}
  syncNavigationCollapse();
});
compactViewport.addEventListener('change',syncNavigationCollapse);
syncNavigationCollapse();

const consoleAuth=await createConsoleAuth(),token=consoleAuth.token;
const api=new ApiClient({token}),state=new StateStore();
const controlApi=new ApiClient({token,base:'',onTokenChange:next=>{api.setToken(next);accountSwitcher?.setToken(next);}});
let panelTransition=Promise.resolve(),accountSwitcher=null,currentPanelId=null;
let visualEditor=null;
let sse=null;
api.recoverAuth=async({token:failedToken})=>{
  if(!await consoleAuth.recover(failedToken))return false;
  api.setToken(consoleAuth.token);
  controlApi.setToken(consoleAuth.token);
  if(sse&&sse.token!==consoleAuth.token)sse.setToken(consoleAuth.token);
  return true;
};
controlApi.recoverAuth=api.recoverAuth;
let tokenManagement=null;
const captchaDiagnostics=createCaptchaDiagnostics();
const host=document.querySelector('#panel-host'),nav=document.querySelector('#nav'),indicator=document.querySelector('#sse'),dot=document.querySelector('#status-dot');
const toastRegion=document.querySelector('#toast-region'),dialog=document.querySelector('#confirm-dialog'),confirmTitle=document.querySelector('#confirm-title'),confirmText=document.querySelector('#confirm-text'),permissionHost=document.querySelector('#permission-asks');
const pauseButton=document.querySelector('#pause-btn'),runtimeLabel=document.querySelector('#runtime-state'),cacheHitLabel=document.querySelector('#cache-hit-rate');
const navigationToggle=document.querySelector('#navigation-toggle');
function setControlContent(button,label,icon){
  let text=button.querySelector('.button-label');
  if(!text){text=document.createElement('span');text.className='button-label';button.replaceChildren(text);}
  if(button.dataset.icon!==icon){button.querySelector('.button-icon')?.remove();const mark=document.createElement('span');mark.className='button-icon';mark.append(createIcon(icon,{size:14}));button.prepend(mark);button.dataset.icon=icon;}
  if(text.textContent!==label)text.textContent=label;
}
function setNavigationPeek(show,{restoreFocus=false}={}){
  const hidden=document.body.dataset.sidebar==='hidden',visible=Boolean(show&&hidden);
  document.body.classList.toggle('navigation-peek',visible);
  navigationToggle.setAttribute('aria-expanded',String(visible));
  syncNavigationCollapse();
  setControlContent(navigationToggle,visible?'收起导航':'显示导航',visible?'close':'menu');
  if(visible)(nav.querySelector('button.active')||nav.querySelector('button'))?.focus();
  else if(restoreFocus&&hidden)navigationToggle.focus();
}
navigationToggle.addEventListener('click',()=>setNavigationPeek(!document.body.classList.contains('navigation-peek'),{restoreFocus:true}));
document.querySelector('#navigation-dismiss')?.addEventListener('click',()=>setNavigationPeek(false,{restoreFocus:true}));
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&document.body.classList.contains('navigation-peek')){
    event.preventDefault();setNavigationPeek(false,{restoreFocus:true});
  }
});
const navigationPreferenceObserver=new MutationObserver(()=>{
  if(document.body.dataset.sidebar!=='hidden')setNavigationPeek(false);
  syncNavigationCollapse();
});
navigationPreferenceObserver.observe(document.body,{attributes:true,attributeFilter:['data-sidebar']});
setNavigationPeek(false);
let runtimeStatus={},runtimeConfig=null,runtimeConfigGeneration=-1,pauseBusy=false,pauseControls=null,statusRevision=0,configGeneration=0,statusPollAgain=false,statusPollClosed=false,hasMultipleAccounts=currentAccountScope.id!=='primary';
function setText(node,value){const text=String(value);if(node.textContent!==text)node.textContent=text;}
function setAttribute(node,name,value){const text=String(value);if(node.getAttribute(name)!==text)node.setAttribute(name,text);}
function setReadiness(id,kind,label,detail){
  const item=document.querySelector(`#ready-${id}`);
  setAttribute(item,'data-state',kind);setText(item.querySelector('small'),label);setAttribute(item,'title',detail);
  setAttribute(item,'aria-label',readinessNames[id]+'：'+label);
  const variant=kind==='good'?'ready':'pending';
  if(item.dataset.icon!==variant){item.querySelector('.readiness-icon').replaceChildren(createIcon('status-'+id+'-'+variant,{size:24}));item.dataset.icon=variant;}
  setText(document.querySelector(`#ready-${id}-detail`),detail);
}
function renderRuntime(){
  const paused=runtimeStatus.orchestrator?.paused;
  pauseButton.disabled=pauseBusy||typeof paused!=='boolean';
  setControlContent(pauseButton,pauseBusy?'正在更新…':paused?hasMultipleAccounts?'恢复当前账号':'恢复运行':hasMultipleAccounts?'暂停当前账号':'全局暂停',paused?'play':'pause');
  setAttribute(pauseButton,'aria-pressed',paused===true);
  pauseButton.classList.toggle('is-paused',paused===true);
  setAttribute(pauseButton,'title',(hasMultipleAccounts?'仅影响当前 QQ 账号。':'')+(paused?'恢复自动响应；暂停期间的消息保留为未读。':'暂停自动响应；新消息继续接收并保留为未读。'));
  setText(runtimeLabel,typeof paused!=='boolean'?'读取运行状态…':paused?hasMultipleAccounts?'当前账号已暂停 · 保留未读':'全局已暂停 · 保留未读':hasMultipleAccounts?'当前账号自动响应已启用':'自动响应已启用');
  setAttribute(runtimeLabel,'data-state',typeof paused!=='boolean'?'unknown':paused?'warn':'good');
  runtimeLabel.classList.toggle('is-paused',paused===true);
  pauseControls?.sync();
  const rate=runtimeStatus.cacheHitRate,usage=runtimeStatus.usage;
  if(typeof rate==='number'&&Number.isFinite(rate)){
    setText(cacheHitLabel,`今日缓存命中 ${(Math.max(0,Math.min(1,rate))*100).toFixed(1)}%`);
    setAttribute(cacheHitLabel,'title',usage?`今日缓存输入 ${Number(usage.cachedTokens)||0} / 总输入 ${Number(usage.promptTokens)||0} Tokens`:'今日输入 Tokens 的缓存命中比例');
  }else{setText(cacheHitLabel,'今日缓存命中 —');setAttribute(cacheHitLabel,'title','等待今日用量统计');}
  const onebot=runtimeStatus.onebot;
  if(onebot){
    const ready=onebot.connected&&(typeof onebot.transportReady==='boolean'?onebot.transportReady:true);
    const reason=onebot.diagnosis||(onebot.error&&/401|unauthor|令牌不匹配/i.test(onebot.error)?'接入认证失败，令牌不匹配，请检查对应协议的令牌':onebot.error)||'请先自行启动协议端并登录账号，再检查 OneBot 地址与令牌';
    setReadiness('onebot',ready?'good':'warn',ready?'已连接':onebot.connected?'验证中':'未连接',ready?'协议服务与账号验证已通过，可以收发消息。':`${onebot.connected?'连接待验证':'协议服务未连接'}：${reason}。`);
  }
  if(runtimeConfig){
    const api=runtimeConfig.api||{},missing=[];
    let validAddress=false;try{validAddress=['http:','https:'].includes(new URL(String(api.baseUrl||'').trim()).protocol);}catch{}
    if(!validAddress)missing.push(String(api.baseUrl||'').trim()?'接口地址无效':'尚未填写接口地址');
    if(!String(api.model||'').trim())missing.push('尚未选择模型');
    setReadiness('model',missing.length?'bad':'good',missing.length?'未完成':'已配置',missing.length?`模型配置未完成：${missing.join('；')}。请在设置中补齐。`:'接口地址和模型已配置，尚未验证模型服务连通；可在设置中进行模型测试。');
  }
}
function applyRuntimeStatus(patch){
  if(!patch||typeof patch!=='object')return;
  const next={...runtimeStatus,...patch};
  // Config changes are one-shot SSE notifications, not cached runtime state.
  delete next.configUpdated;delete next.extensionUpdates;delete next.available;
  // Transport notifications are provider snapshots. Optional readiness fields
  // from a previous provider must not survive its replacement or reset.
  for(const key of ['orchestrator','usage'])if(patch[key]&&typeof patch[key]==='object')next[key]={...runtimeStatus[key],...patch[key]};
  if(typeof patch.paused==='boolean')next.orchestrator={...next.orchestrator,paused:patch.paused};
  runtimeStatus=next;++statusRevision;state.set({status:runtimeStatus});renderRuntime();
}
pauseControls=createPauseControls({api,button:pauseButton,getPaused:()=>runtimeStatus.orchestrator?.paused,
  onBusy:value=>{pauseBusy=value;renderRuntime();},commitStatus:applyRuntimeStatus,notify:toast,refresh:()=>pollStatus()});
window.addEventListener('pagehide',event=>{if(!event.persisted)pauseControls.dispose();});
const externalLinks={
  'feedback-btn':'https://kondius.cn/qq-agent/comments',
  'quote-btn':'https://kondius.cn/qq-agent/holyshits',
  'skill-market-btn':'https://www.kondius.cn/qq-agent/skill-market/',
  'plugin-market-btn':'https://www.kondius.cn/qq-agent/plugin-market/',
  'persona-plaza-btn':'https://www.kondius.cn/qq-agent/persona-plaza/',
  'open-site-btn':'https://kondius.cn/qq-agent',
};
for(const [id,url] of Object.entries(externalLinks))document.querySelector(`#${id}`)?.addEventListener('click',()=>{window.open(url,'_blank','noopener');});

function toast(text,kind='info') { const item=document.createElement('div');item.className=`toast ${kind}`;item.textContent=String(text);toastRegion.append(item);setTimeout(()=>item.remove(),4500); }
function confirm({title='请确认操作',text='此操作可能影响现有数据。',accept='确认'}={}) { return new Promise(resolve=>{confirmTitle.textContent=title;confirmText.textContent=text;document.querySelector('#confirm-accept').textContent=accept;dialog.addEventListener('close',()=>resolve(dialog.returnValue==='accept'),{once:true});dialog.showModal();}); }
let panelLoadError=null,panelRecovery=null,updateNotice=null;
const destructiveFeedback=createDestructiveFeedback();
const startupNavigation=createStartupNavigation();
// Startup and the first runtime poll share this one read. A slow or failed
// config never holds the initial page indefinitely or adds a second host poll.
const initialConfigGeneration=configGeneration,initialConfigRead=api.get('/api/config');initialConfigRead.catch(()=>{});
let initialConfigPollPending=true;
let configSnapshotRead=null;
function readConfigForStatus(){
 const generation=configGeneration;
 if(initialConfigPollPending&&initialConfigGeneration!==generation)initialConfigPollPending=false;
 if(runtimeConfig&&runtimeConfigGeneration===generation)return{promise:Promise.resolve(runtimeConfig),generation};
 if(configSnapshotRead?.generation===generation)return configSnapshotRead;
 const promise=initialConfigPollPending?(initialConfigPollPending=false,initialConfigRead):api.get('/api/config');
 const read={promise,generation};configSnapshotRead=read;
 promise.finally(()=>{if(configSnapshotRead===read)configSnapshotRead=null;}).catch(()=>{});return read;
}
const registry=new PanelRegistry({
  onDestructiveProgress:(progress,phase)=>destructiveFeedback.update(progress,phase),
  frameHost:host,api,controlApi,onNotify:text=>toast(text),
  onUpdateAction:params=>{if(!updateNotice)throw new Error('版本检查尚未就绪');return updateNotice.action(params);},
  onManageConsoleToken:()=>{if(!tokenManagement)throw new Error('控制台尚未就绪');return tokenManagement.open();},
  onCaptchaDiagnostics:()=>captchaDiagnostics.open(),
  onPublishMarket:(payload,options)=>publishMarketFromHost(api,payload,options),
  onAuthenticateMarket:(payload,options)=>authenticateMarketFromHost(api,payload,options),
  onUserCall:(tool,args,panel,generation)=>api.post(`/api/panels/${encodeURIComponent(panel)}/call`,{tool,args,generation}),
  onUserConfig:(key,panel,generation)=>api.post(`/api/panels/${encodeURIComponent(panel)}/config`,{key,generation}),
  onPublishQuote:(payload,options)=>publishQuoteFromHost(api,payload,options),
  onPublishFeedback:async(payload,{signal})=>{
    const ready=await api.get('/api/community/feedback/status');
    if(ready?.available!==true)throw new Error(ready?.reason||'意见提交服务未就绪，请稍后重试');
    const captchaVerifyParam=await verifyPublicCaptcha({signal});
    if(signal.aborted)throw signal.reason;
    return api.request('POST','/api/community/feedback',{nickname:payload?.nickname,text:payload?.text,images:payload?.images,captchaVerifyParam},undefined,{signal});
  },
  onOpenExternal:(target,context)=>{
    const url=['local-protocol-login','protocol-login-native'].includes(target)?localProtocolLoginUrl(context?.protocolUrl):LOCAL_PROTOCOL_RELEASES[target]||externalLinks[target];
    if(!url)throw new Error('不支持的社区网页');
    window.open(url,'_blank','noopener,noreferrer');
    return {ok:true};
  },
});
visualEditor=createVisualEditor({api,registry,notify:toast,navigate:id=>open(id),getPanel:()=>currentPanelId});
registry.onAppearance=(method,payload,page)=>visualEditor.handle(method,payload,page);
registry.visualEditorState=()=>visualEditor.getState();
window.addEventListener('pagehide',event=>{if(!event.persisted)visualEditor.dispose();});
updateNotice=createUpdateNotice({api:controlApi,onStatus:status=>registry.emit('update-status',status)});
function renderNav(){
  const existing=new Map([...nav.querySelectorAll('button[data-panel]')].map(button=>[button.dataset.panel,button]));
  const panels=registry.list(),ids=new Set(panels.map(panel=>panel.id));
  for(const id of Object.keys(readinessNames))document.querySelector('#ready-'+id).disabled=!ids.has('settings');
  for(const [id,button] of existing)if(!ids.has(id))button.remove();
  for(const [index,panel] of panels.entries()){
    let button=existing.get(panel.id);
    if(!button){
      button=document.createElement('button');button.type='button';button.dataset.panel=panel.id;
      const icon=document.createElement('span');icon.className='nav-icon';icon.append(createIcon(panel.id,{size:28}));
      const label=document.createElement('span');label.className='nav-label';
      const number=document.createElement('small');number.className='nav-index';number.setAttribute('aria-hidden','true');
      button.append(icon,label,number);button.addEventListener('click',()=>open(button.dataset.panel));
    }
    const label=button.querySelector('.nav-label'),number=button.querySelector('.nav-index');
    if(label.textContent!==panel.title)label.textContent=panel.title;
    const count=String(index+1).padStart(2,'0');if(number.textContent!==count)number.textContent=count;
    setAttribute(button,'aria-label',panel.title);
    setAttribute(button,'title',panel.description?`${panel.title} · ${panel.description}`:panel.title);setNavActive(button,registry.current?.id===panel.id);
    // Keep unchanged nodes in place so status/permission refreshes preserve keyboard focus.
    if(nav.children[index]!==button)nav.insertBefore(button,nav.children[index]||null);
  }
  const count=document.querySelector('#panel-count');if(count)setText(count,String(panels.length).padStart(2,'0'));
  updateWorkspace();updateNotice?.repaint();
}
function setNavActive(button,active){button.classList.toggle('active',active);if(active)setAttribute(button,'aria-current','page');else if(button.hasAttribute('aria-current'))button.removeAttribute('aria-current');}
function updateWorkspace(){
  const panels=registry.list(),index=panels.findIndex(panel=>panel.id===registry.current?.id),panel=panels[index];
  if(panel){
    currentPanelId=panel.id;
    const url=panelLocationUrl(window.location,panel.id);
    if(url!==window.location.pathname+window.location.search+window.location.hash){try{history.replaceState(history.state,'',url);}catch{}}
  }
  const title=document.querySelector('#workspace-title'),description=document.querySelector('#workspace-description'),number=document.querySelector('#workspace-index');
  // User panels may provide a canvas without their own heading; retain their
  // registered title in the compact host toolbar without inspecting the iframe.
  document.querySelector('.workspace-context').classList.toggle('visually-hidden',panel?.kind!=='user');
  if(title)setText(title,panel?.title||'控制台');
  if(description)setText(description,panel?.description||(panel?.kind==='user'?'扩展工作面板':panel?'本地工作面板':panels.length?'选择工作面板':panelLoadError?(panelLoadError.status===401?'控制台认证已失效':'工作面板加载失败'):'暂无已注册面板'));
  if(number)setText(number,index<0?'00':String(index+1).padStart(2,'0'));
}
function validatePanelManifest(data){if(!data||!Array.isArray(data.panels))throw new Error('工作面板清单响应异常，请重试加载');return data;}
function panelFailed(error){
  if(error?.credentialCurrent===false)return;
  panelLoadError=error;consoleAuth.invalidate(error);
  if(!registry.current&&!registry.list().length)panelRecovery?.show(error);
  updateWorkspace();
}
const manifest=await api.get('/api/panels').then(data=>{validatePanelManifest(data);consoleAuth.confirm();return data;}).catch(error=>{panelFailed(error);toast(error.message,'error');return {panels:[]};});
for(const panel of manifest.panels||[]){try{registry.register(panel);}catch(error){toast(`已拒绝不安全面板：${error.message}`,'error');}}
renderNav();
function open(id,options={}) {
  if(options.automatic!==true)startupNavigation.navigate();
  const {automatic,...mountOptions}=options;
  panelTransition=panelTransition.then(async()=>{try { await registry.mount(id,mountOptions);for(const button of nav.querySelectorAll('button'))setNavActive(button,button.dataset.panel===id);updateWorkspace();if(document.body.classList.contains('navigation-peek'))setNavigationPeek(false,{restoreFocus:true}); }catch(error) { toast(error.message,'error'); }});
  return panelTransition;
}
async function initialTarget(isCurrent=()=>true){
  const current=()=>!statusPollClosed&&isCurrent();
  const first=registry.list()[0];if(!first||!current())return null;
  const requested=readPanelTarget(window.location.search,registry.list());
  if(requested){startupNavigation.navigate();return requested;}
  const firstDecision=!startupNavigation.attempted;
  const selected=await startupNavigation.select({panels:registry.list(),readConfig:async()=>{
    const fresh=()=>runtimeConfig&&runtimeConfigGeneration===configGeneration?runtimeConfig:null;
    if(fresh())return fresh();
    if(initialConfigGeneration!==configGeneration)return null;
    try{const initial=await initialConfigRead;return fresh()??(initialConfigGeneration===configGeneration?initial:null);}
    catch(error){if(fresh())return fresh();throw error;}
  },isCurrent:current});
  if(!current()||(firstDecision&&startupNavigation.interacted))return null;
  return selected&&registry.defs.has(selected.id)?selected:{id:registry.list()[0]?.id};
}
if(registry.list()[0]){const target=await initialTarget();if(target?.id)await open(target.id,{...target,automatic:true});}
async function applyPanelManifest(data,{isCurrent=()=>true}={}){
  validatePanelManifest(data);if(statusPollClosed||!isCurrent())return;
  await registry.replace(data.panels,{isCurrent});if(!isCurrent())return;
  const recovering=panelLoadError!==null;
  panelLoadError=null;panelRecovery?.clear();if(recovering)consoleAuth.confirm();
  if(!registry.current&&registry.list()[0]){const target=await initialTarget(isCurrent);if(target?.id&&!statusPollClosed&&isCurrent())await registry.mount(target.id,target);}
  if(isCurrent())renderNav();
}
const panelRefresh=createRefreshQueue(({isCurrent})=>{
  panelTransition=panelTransition.then(async()=>{
    if(!isCurrent())return;
    try{const data=await api.get('/api/panels');await applyPanelManifest(data,{isCurrent});}
    catch(error){if(isCurrent()){panelFailed(error);toast(error.message,'error');}}
  });
  return panelTransition;
});
function refreshPanels(){return panelRefresh.request();}
function renderPermissionCard(request){if(!request?.id||document.querySelector(`[data-permission-id="${CSS.escape(request.id)}"]`))return;const card=document.createElement('article');card.className='permission-card';card.dataset.permissionId=request.id;const title=document.createElement('strong');title.textContent=`${request.pluginId||'未知插件'} 请求权限：${request.scope||'未知范围'}`;const detail=document.createElement('p');detail.textContent=String(request.detail||request.reason||'需要管理员确认').slice(0,500);const actions=document.createElement('div');actions.className='dialog-actions';for(const [decision,label] of [['once','本次允许'],['always','始终允许'],['deny','拒绝']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',async()=>{button.disabled=true;try{await api.post('/api/permissions/resolve',{requestId:request.id,decision});card.remove();}catch(error){button.disabled=false;toast(error.message,'error');}});actions.append(button);}card.append(title,detail,actions);permissionHost.append(card);}
async function refreshPermissionRequests(){try{const result=await api.get('/api/permissions/pending');for(const request of result.requests||[])renderPermissionCard(request);}catch(error){if(error.status!==404)toast(error.message,'error');}}
function applyRuntimeConfig(config,generation=configGeneration){
  runtimeConfig=config;runtimeConfigGeneration=generation;state.set({config:runtimeConfig});const previous=getRefreshInterval(),interval=setRefreshInterval(runtimeConfig.ui?.refreshMs);
  if(previous!==interval)registry.emit('refresh-policy',{interval});
  syncThemeFromConfig(runtimeConfig);renderRuntime();
}
const configRefresh=createRefreshQueue(async({isCurrent})=>{const {generation,promise}=readConfigForStatus(),config=await promise;if(isCurrent()&&!statusPollClosed&&generation===configGeneration)applyRuntimeConfig(config,generation);});
async function navigateAccount(url){
  try{
    if(window.navigation?.navigate)await window.navigation.navigate(url).committed;
    else window.location.assign(url);
  }catch(error){
    // Navigation can be cancelled before the new document commits. The old
    // panel has already saved and left, so reacquire its own account lease.
    document.querySelector('.app-shell').inert=false;
    registry.dispose();
    if(currentPanelId)await registry.mount(currentPanelId);
    renderNav();throw error;
  }
}
accountSwitcher=createAccountSwitcher({host:document.querySelector('#account-controls'),api:controlApi,notify:toast,navigate:navigateAccount,getCurrentPanel:()=>currentPanelId,onAccounts:rows=>{registry.emit('accounts',{});const multiple=rows.length>1;if(multiple!==hasMultipleAccounts){hasMultipleAccounts=multiple;renderRuntime();}},openConnections:account=>open('settings',{section:'onebot',connectQQ:account?.accountId||true}),beforeDisconnect:async()=>{
  await visualEditor?.close();
  await panelTransition;const previous=registry.current?.id;await registry.unmount();return async()=>{if(previous)await registry.mount(previous);};
},beforeSwitch:async()=>{
  await visualEditor?.close();
  await panelTransition;await registry.flush();
  // Retain the rendered account until the browser captures it. Pagehide owns
  // disposal, keeping all old requests and events bound to the old document.
  document.querySelector('.app-shell').inert=true;
}});
const seenExtensionUpdates=new Set();
let extensionUpdateToast=null,extensionUpdateToastTimer=null;
function notifyExtensionUpdates(available=[]){
  const fresh=available.filter(row=>row&&typeof row.id==='string'&&typeof row.version==='string'&&!seenExtensionUpdates.has(row.id+'@'+row.version));
  for(const row of available)seenExtensionUpdates.add(row.id+'@'+row.version);
  for(const kind of ['skill','plugin']){const button=nav.querySelector('[data-panel="'+(kind==='skill'?'skills':'plugins')+'"]');if(button)button.title=available.some(row=>row.kind===kind)?'有可用更新':'';}
  if(!available.length){extensionUpdateToast?.remove();return;}
  if(!fresh.length&&!extensionUpdateToast?.isConnected)return;
  if(!extensionUpdateToast?.isConnected){extensionUpdateToast=document.createElement('div');extensionUpdateToast.className='toast';extensionUpdateToast.setAttribute('role','status');extensionUpdateToast.append(document.createElement('span'),document.createElement('button'));toastRegion.append(extensionUpdateToast);}
  const item=extensionUpdateToast,label=item.querySelector('span'),view=item.querySelector('button');label.textContent=available.length===1?(available[0].name||available[0].id)+' 有新版 '+available[0].version:'发现 '+available.length+' 个扩展更新';
  view.textContent='查看更新';view.onclick=()=>{void open(available[0].kind==='plugin'?'plugins':'skills');item.remove();};clearTimeout(extensionUpdateToastTimer);extensionUpdateToastTimer=setTimeout(()=>item.remove(),12000);
}
async function readAvailableExtensionUpdates(){try{const result=await api.get('/api/extensions/updates');notifyExtensionUpdates((result.updates||[]).filter(row=>row.status==='available').map(row=>({...row,version:row.latestVersion})));}catch{/* Older or replaced consoles can keep local reload controls. */}}
sse=new SseClient({token:api.token,base:api.base,recoverAuth:api.recoverAuth,onEvent:(name,payload)=>{if(['accounts','hello','onebot-status','local-protocols'].includes(name))void accountSwitcher?.refresh();if(name==='session-delta'){registry.emit(name,payload);return;}if(['hello','session-end'].includes(name))scheduleStatusPoll();if(name==='hello'){void refreshPermissionRequests();void readAvailableExtensionUpdates();}if(name==='status'&&payload?.extensionUpdates)notifyExtensionUpdates(payload.available||[]);if(name==='status'&&payload?.configUpdated){++configGeneration;void configRefresh.request().catch(()=>{});}if(name==='status')applyRuntimeStatus(payload);else{state.set({[name]:payload});const runtimeKey={'onebot-status':'onebot'}[name];if(runtimeKey)applyRuntimeStatus({[runtimeKey]:payload});}registry.emit(name,payload);if(['plugin-loaded','plugin-unloaded','plugin-error','permission-decision'].includes(name)||(name==='hello'&&!registry.list().length))refreshPanels();if(name==='permission-ask')renderPermissionCard(payload);if(name==='permission-decision'&&payload?.decision!=='ask'){const card=document.querySelector(`[data-permission-id="${CSS.escape(payload.requestId||'')}"]`);card?.remove();}},onState:(status,error)=>{consoleAuth.invalidate(error);if(error?.status===401&&!registry.list().length){panelFailed(error);if(!consoleAuth.automatic)sse.close();}const labels={connecting:'正在连接',connected:'实时同步',reconnecting:'正在重连'};indicator.textContent=error?`${labels[status]||'连接异常'}：${error.message}`:labels[status]||'SSE 异常';dot.classList.toggle('online',status==='connected');}});
tokenManagement=createTokenManagement({api:controlApi,auth:consoleAuth,sse});
panelRecovery=createPanelRecovery({host,api,auth:consoleAuth,onRecovered:async data=>{
  if(statusPollClosed)return;
  const task=panelTransition.catch(()=>{}).then(()=>applyPanelManifest(data));panelTransition=task.catch(()=>{});await task;
  if(statusPollClosed)return;
  if(sse.token!==consoleAuth.token)sse.setToken(consoleAuth.token);if(sse.closed)sse.connect();
  void pollStatus();void refreshPermissionRequests();
}});
if(panelLoadError&&!registry.list().length)panelRecovery.show(panelLoadError);
sse.connect();
refreshPermissionRequests();
let statusPollTimer=0;
let statusPollBusy=false;
// 启动时把 config.json 里的外观偏好灌进主题引擎（真源是 config，localStorage 只是 shell 侧缓存）。
// 只在值真的变了才写：轮询反复写会把用户在设置面板里正在预览的颜色回滚掉。
let lastThemeJson = '';
function syncThemeFromConfig(config) {
  const uikit = config?.ui?.uikit;
  if (!uikit || !Object.keys(uikit).length) return;
  const json = JSON.stringify(uikit);
  if (json === lastThemeJson) return;
  lastThemeJson = json;
  try {
    visualEditor?.configChanged(config);
    const theme=resolveScheme(uikit);
    registry.applyThemeEverywhere(visualEditor?.mergeTheme(theme)||theme);
  } catch (err) {
    console.warn('[theme] 应用配置里的外观失败:', err?.message ?? err);
  }
}

async function pollStatus(){
  if(statusPollClosed)return;
  if(statusPollBusy){statusPollAgain=true;return;}
  clearTimeout(statusPollTimer);
  statusPollBusy=true;
  const revision=statusRevision,configRead=readConfigForStatus();
  try {
    const [statusResult,configResult]=await Promise.allSettled([api.get('/api/status'),configRead.promise]);
    if(statusPollClosed)return;
    // A status request started before a pause or SSE update must not undo that newer state.
    if(statusResult.status==='fulfilled'&&revision===statusRevision){applyRuntimeStatus(statusResult.value);registry.emit('status',runtimeStatus);}
    if(configResult.status==='fulfilled'&&configRead.generation===configGeneration)applyRuntimeConfig(configResult.value,configRead.generation);
    if(statusResult.status==='rejected'){consoleAuth.invalidate(statusResult.reason);throw statusResult.reason;}
    if(configResult.status==='rejected')throw configResult.reason;
    if(panelLoadError&&!registry.list().length)void refreshPanels();
  } catch (error) {
    // SSE 已经提供连接状态；轮询失败不弹 toast，避免后台网络抖动刷屏。
    state.set({statusError: error.message});
  } finally { statusPollBusy=false;if(!statusPollClosed&&statusPollAgain){statusPollAgain=false;scheduleStatusPoll();} }
}
function scheduleStatusPoll(){
  clearTimeout(statusPollTimer);
  if(statusPollClosed||document.hidden)return;
  statusPollTimer=setTimeout(pollStatus,120);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleStatusPoll();});
const initialRuntimeReady=pollStatus();
void Promise.allSettled([initialRuntimeReady,registry.whenContentReady({timeout:5000})]).then(()=>window.dispatchEvent(new Event('qqa-account-content-ready')));
void updateNotice.check();
window.addEventListener('beforeunload',event=>registry.beforeUnload(event));
window.addEventListener('pagehide',event=>{if(event.persisted)return;statusPollClosed=true;startupNavigation.dispose();configRefresh.close();updateNotice.dispose();consoleAuth.dispose();clearTimeout(statusPollTimer);panelRefresh.close();panelRecovery?.dispose();destructiveFeedback.dispose();navigationPreferenceObserver.disconnect();compactViewport.removeEventListener('change',syncNavigationCollapse);sse.close();registry.dispose();accountSwitcher?.dispose();});
window.qqAgentShell?.onPrepareLeave?.(async()=>{try{await registry.flush();return{ok:true};}catch(error){toast(error.message,'error');return{ok:false,error:error.message};}});
export {confirm,toast,state};
