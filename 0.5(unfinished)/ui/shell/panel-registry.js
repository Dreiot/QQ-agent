import {getRefreshInterval} from '../panels/refresh-policy.js';
import { RpcBridge } from './rpc-bridge.js';
import { createPanelViewState } from './panel-view-state.js';
import {settingsSaveIdentity} from './settings-save-lifecycle.js';
import {currentAccountScope} from '../panels/account-scope.js';
// 相对路径（而非 /panels/theme.js）：浏览器解析为 /panels/theme.js，
// Node 侧也能解析到 ui/panels/theme.js —— 用绝对路径会让 Node 找 C:\panels\theme.js。
import { getCurrentTheme, writeTheme, writeVisualTheme } from '../panels/theme.js';
import { animateMount } from '../panels/motion.js';

const ID=/^[A-Za-z0-9_-]{1,64}$/;
const OWNER=/^[a-z0-9][a-z0-9._-]*$/i;
const VALID_KINDS=new Set(['bundled','user']);
const VALID_METHODS=new Set(['GET','POST','PUT','DELETE','PATCH']);
const SAFE_PATH=/^\/api(?:\/[A-Za-z0-9._~-]+|\/:id|\/:key|\/:uid)*$/;

function normalize(def) {
  if(!def||typeof def!=='object'||!ID.test(def.id||''))throw new Error('面板 id 无效');
  if(!VALID_KINDS.has(def.kind))throw new Error('面板 kind 无效');
  if(typeof def.title!=='string'||!def.title.trim())throw new Error('面板标题无效');
  if(def.entry!==undefined&&(typeof def.entry!=='string'||def.entry.includes('..')||def.entry.startsWith('/')||!def.entry.endsWith('.html')))throw new Error('面板入口路径无效');
  if(!Array.isArray(def.permissions)||!def.permissions.every(p=>typeof p==='string'))throw new Error('面板权限无效');
  if(def.kind==='user'&&!def.permissions.includes('ui.panel'))throw new Error('用户面板缺少 ui.panel 权限');
  if(def.kind==='user'&&(!OWNER.test(def.ownerId||'')||!/^[a-f0-9-]{36}$/.test(def.generation||'')))throw new Error('用户面板缺少有效宿主身份');
  if(!Array.isArray(def.api)||!def.api.every(rule=>VALID_METHODS.has(rule?.method)&&SAFE_PATH.test(rule.path||'')))throw new Error('面板 API allowlist 无效');
  const panel={...def,entry:def.entry||'index.html',api:def.api.map(rule=>Object.freeze({...rule}))};
  if(def.kind==='user'){delete panel.navigation;delete panel.viewState;delete panel.saveLifecycle;}
  else{
    if(panel.viewState)panel.viewState=Object.freeze({...panel.viewState,keys:Object.freeze([...(panel.viewState.keys??[])])});
    if(panel.navigation)panel.navigation=Object.freeze({...panel.navigation,...(Array.isArray(panel.navigation.sections)?{sections:Object.freeze([...panel.navigation.sections])}:{})});
  }
  return Object.freeze(panel);
}

export class PanelRegistry {
  constructor({root=currentAccountScope.base+'/panels',frameHost,api,controlApi=api,onNotify,onUserCall,onUserConfig,onOpenExternal,onPublishQuote,onPublishFeedback,onManageConsoleToken,onUpdateAction,onPublishMarket,onAuthenticateMarket,onCaptchaDiagnostics,onDestructiveProgress,viewState=createPanelViewState()}={}) {
    this.root=root.replace(/\/$/,'');this.frameHost=frameHost;this.api=api;this.controlApi=controlApi;this.onNotify=onNotify;this.onUserCall=onUserCall;this.onUserConfig=onUserConfig;this.onOpenExternal=onOpenExternal;this.onPublishQuote=onPublishQuote;
    this.onPublishFeedback=onPublishFeedback;
    this.onManageConsoleToken=onManageConsoleToken;this.onUpdateAction=onUpdateAction;
    this.onPublishMarket=onPublishMarket;this.onCaptchaDiagnostics=onCaptchaDiagnostics;
    this.onAuthenticateMarket=onAuthenticateMarket;
    this.onDestructiveProgress=onDestructiveProgress;
    this.defs=new Map();this.current=null;this.viewState=viewState;
    this.viewportWindow=frameHost?.ownerDocument?.defaultView??globalThis.window;
    this.viewportFrame=0;
    this.viewportResize=()=>{
      if(this.viewportFrame)return;
      if(this.viewportWindow?.requestAnimationFrame)this.viewportFrame=this.viewportWindow.requestAnimationFrame(()=>{this.viewportFrame=0;this.publishViewport();});
      else this.publishViewport();
    };
    this.viewportWindow?.addEventListener?.('resize',this.viewportResize);
  }
  viewportSize(){const win=this.viewportWindow;return{width:Math.max(1,Math.round(win?.innerWidth||1)),height:Math.max(1,Math.round(win?.innerHeight||1))};}
  publishViewport(){if(this.current?.definition?.kind==='bundled'&&this.current.id==='settings')this.current.bridge.event('viewport-size',this.viewportSize());}
  register(def) { const panel=normalize(def);if(this.defs.has(panel.id))throw new Error(`重复面板 id：${panel.id}`);this.defs.set(panel.id,panel);return panel; }
  async mount(id,{force=false,section=null,connectQQ=null}={}) {
    const definition=this.defs.get(id);if(!definition)throw new Error('未知面板');
    // A host shortcut targets the existing settings UI without inspecting its sandbox
    // or replacing an open form. Other panels receive no settings navigation event.
    const settingsSection=definition.kind==='bundled'&&(id==='settings'||definition.navigation?.role==='configuration')&&['models','access','onebot'].includes(section)?section:null;
    const settingsTarget={section:settingsSection,...(settingsSection==='onebot'&&(connectQQ===true||typeof connectQQ==='string'&&/^\d{5,20}$/.test(connectQQ))?{connectQQ}: {})};
    const active=this.current;
    if(!force&&active?.id===id&&active.definition===definition&&active.bridge.ready&&!active.bridge.closed&&active.frame.isConnected!==false){
      if(settingsSection)active.bridge.event('settings-section',settingsTarget);
      return active.frame;
    }
    await this.unmount();
    const frame=document.createElement('iframe');frame.title=definition.title;
    // Animate the host-owned frame only; a plugin's sandbox remains opaque.
    frame.addEventListener('load',()=>{if(this.current?.frame===frame&&document.documentElement?.dataset?.accountHandoff!=='incoming')animateMount(frame);},{once:true});
    // user URL 绑定面板 id 和加载代际；宿主只服务其专用 ui/ 资产。
    const src=(definition.kind==='user'&&definition.ownerId)
      ?`${this.root}/u/${encodeURIComponent(definition.id)}/${encodeURIComponent(definition.generation)}/${definition.entry}`
      :`${this.root}/${encodeURIComponent(definition.id)}/${definition.entry}`;
    frame.src=src+(settingsSection?'#'+settingsSection:'');
    // Only the proven default editor may ask for the browser's native unload
    // confirmation before its last queued mirror reaches the host. No origin,
    // storage, token, navigation or backend authority is added to the iframe.
    frame.sandbox='allow-scripts'+(settingsSaveIdentity(definition)?' allow-modals':'');frame.setAttribute('referrerpolicy','no-referrer');this.frameHost.replaceChildren(frame);
    // 面板是 opaque origin，读不到 localStorage、也拿不到宿主 DOM，
    // 所以主题必须由宿主推给它：ready 时推一次，之后变更再广播。
    // 面板请求换肤走 theme.apply RPC（tokens 经此校验后落地）。
    const stateLease=this.viewState.open(definition);
    const viewState=stateLease?{read:()=>this.viewState.read(stateLease),leave:id=>this.viewState.leave(stateLease,id),finish:(id,data)=>this.viewState.finish(stateLease,id,data),expire:()=>this.viewState.expire(stateLease),cancel:id=>this.viewState.cancel?.(stateLease,id)}:null;
    const bridge=new RpcBridge({
      viewState,controlApi:this.controlApi,
      frame,api:this.api,manifest:definition,onNotify:this.onNotify,onUserCall:this.onUserCall,onUserConfig:this.onUserConfig,onOpenExternal:this.onOpenExternal,onPublishQuote:this.onPublishQuote,onPublishFeedback:this.onPublishFeedback,onManageConsoleToken:this.onManageConsoleToken,onUpdateAction:this.onUpdateAction,onPublishMarket:this.onPublishMarket,onAuthenticateMarket:this.onAuthenticateMarket,onCaptchaDiagnostics:this.onCaptchaDiagnostics,onDestructiveProgress:this.onDestructiveProgress,
      onReady:()=>{ try{ bridge.event('theme',getCurrentTheme());if(definition.kind==='bundled'&&id==='settings')bridge.event('viewport-size',this.viewportSize());bridge.event('refresh-policy',{interval:getRefreshInterval()});this.onAppearance?.('appearance.ready',null,definition.id);if(this.visualEditorState)bridge.event('visual-editor',this.visualEditorState());if(settingsSection)bridge.event('settings-section',settingsTarget); }catch{/* 推送失败不影响面板功能 */} },
      onTheme:(tokens)=>{ this.applyThemeEverywhere(tokens); },
    });
    bridge.onAppearance=this.onAppearance;
    this.current={id,frame,bridge,definition};return frame;
  }
  emit(name,payload) { if(this.current)this.current.bridge.event(name,payload); }
  /** 落地主题并同步到当前面板（shell 自己 + 面板 iframe）。 */
  applyThemeEverywhere(tokens) {
    const t=writeTheme(tokens);
    this.emit('theme',t);
    return t;
  }
  applyVisualEverywhere(visual){
    const t=writeVisualTheme(visual);
    this.emit(this.current?.definition?.kind==='user'?'theme':'visual-style',this.current?.definition?.kind==='user'?t:t.visual);
    return t;
  }
  async replace(definitions,{isCurrent=()=>true}={}) {
    if(!isCurrent())return;
    const next=new Map();
    for(const def of definitions){try{const panel=normalize(def);if(next.has(panel.id))throw new Error('重复面板 id');const existing=this.defs.get(panel.id);next.set(panel.id,existing&&JSON.stringify(existing)===JSON.stringify(panel)?existing:panel);}catch(error){this.onNotify?.(`已拒绝不安全面板：${error.message}`);}}
    const active=this.current&&this.defs.get(this.current.id),replacement=active&&next.get(active.id);
    // Revoke removed/replaced scopes before awaiting an old frame's flush.
    this.viewState.reconcile([...next.values()]);
    if(active&&(!replacement||JSON.stringify(active)!==JSON.stringify(replacement)))await this.unmount({revoke:true});
    if(isCurrent())this.defs=next;
  }
  async flush() { if(this.current)await this.current.bridge.flush(); }
  whenContentReady(options={}) { return this.current?.bridge.whenContentReady(options)??Promise.resolve({status:'empty'}); }
  beforeUnload(event){return this.current?.bridge.beforeUnload(event)??false;}
  dispose(){this.viewportWindow?.removeEventListener?.('resize',this.viewportResize);if(this.viewportFrame)this.viewportWindow?.cancelAnimationFrame?.(this.viewportFrame);this.viewportFrame=0;const current=this.current;this.current=null;if(current){current.bridge.close();current.frame.remove();}}
  async unmount({revoke=false}={}) {
    if(!this.current)return;
    const current=this.current;
    try{await current.bridge.flush();}catch(error){if(!revoke)throw error;this.onNotify?.(`面板来源已撤销：${error.message}`);}
    if(this.current===current)this.current=null;current.bridge.close();current.frame.remove();
  }
  list() { return [...this.defs.values()]; }
}
