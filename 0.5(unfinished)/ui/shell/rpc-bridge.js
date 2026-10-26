import { publicPanelTheme } from '../panels/theme.js';
import { hostApiRequestTimeout } from '../panels/request-timeouts.js';
import {createSettingsSaveLifecycle} from './settings-save-lifecycle.js';
import {LOCAL_PROTOCOL_RELEASES,localProtocolPageUrl,localProtocolLoginUrl} from '../panels/local-protocol-links.js';
import {currentAccountScope,normalizeAccountId} from '../panels/account-scope.js';
import {accountNavigationUrl} from './account-navigation.js';

const RPC={INVALID:-32600,NOT_FOUND:-32601,FORBIDDEN:-32003,INTERNAL:-32603};
const RPC_METHODS=new Set(['settings.saveState','settings.save','api.request','ctx.call','ctx.getConfig','ctx.notify','ui.confirm','ui.notify','ui.openExternal','ui.destructiveProgress','console.manageToken','console.update','ui.captchaDiagnostics','community.authenticateMarket','community.cancelMarketAuthentication','community.publishMarket','community.cancelMarketPublish','community.publishQuote','community.cancelQuotePublish','community.publishFeedback','community.cancelFeedbackPublish','theme.apply','appearance.open','appearance.select','panel.ready','panel.contentReady','panel.flushed']);
const PROTOCOL_LOGIN_POSTS=new Set(['connect','refresh','inject','close','visibility'].map(action=>'/api/local-protocols/login/'+action));
const validProtocolSession=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const EXTERNAL_TARGETS_BY_PANEL=new Map([
  ['community',new Set(['persona-plaza-btn','feedback-btn','plugin-market-btn','open-site-btn'])],
  ['skills',new Set(['skill-market-btn'])],
  ['plugins',new Set(['plugin-market-btn'])],
  ['settings',new Set([...Object.keys(LOCAL_PROTOCOL_RELEASES),'local-protocol-login','protocol-login-native'])],
]);

function routePattern(path) {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/:([A-Za-z][A-Za-z0-9_]*)/g,'[^/]+')}$`);
}

/** Opaque-origin iframes require targetOrigin="*"; source + panel id + one-time nonce authenticate every message. */
export class RpcBridge {
  constructor({frame,api,controlApi=api,manifest,timeout=15000,onUserCall=async()=>{throw new Error('当前运行环境未提供该能力');},onUserConfig=async()=>({}),onNotify=()=>{},onReady=null,onTheme=null,onOpenExternal=null,onPublishQuote=null,onPublishFeedback=null,onManageConsoleToken=null,onUpdateAction=null,onPublishMarket=null,onAuthenticateMarket=null,onCaptchaDiagnostics=null,onDestructiveProgress=null,viewState=null,onAccountStopped=id=>{if(id===currentAccountScope.id&&id!=='primary')window.location.assign(accountNavigationUrl('primary',manifest?.id));}}={}) {
    this.frame=frame; this.api=api; this.controlApi=controlApi;this.onAccountStopped=onAccountStopped;this.manifest=manifest??{}; this.timeout=timeout; this.onUserCall=onUserCall; this.onUserConfig=onUserConfig; this.onNotify=onNotify; this.onReady=onReady; this.onTheme=onTheme; this.onOpenExternal=onOpenExternal;this.onPublishQuote=onPublishQuote;this.quoteController=null;
    this.onPublishFeedback=onPublishFeedback;this.feedbackController=null;
    this.onManageConsoleToken=onManageConsoleToken;this.onUpdateAction=onUpdateAction;
    this.onPublishMarket=onPublishMarket;this.marketController=null;this.onCaptchaDiagnostics=onCaptchaDiagnostics;
    this.onAuthenticateMarket=onAuthenticateMarket;this.authenticationController=null;
    this.onDestructiveProgress=onDestructiveProgress;this.destructiveProgressActive=false;this.leaving=false;
    this.protocolLoginSession=null;this.protocolLoginReleased=new Set();
    this.backgroundUploads=new Set();
    this.nonce=crypto.randomUUID().replaceAll('-',''); this.controllers=new Set(); this.closed=false; this.ready=false;this.flushed=false; this.flushPromise=null; this.flushResolve=null;this.flushReject=null;this.flushTimer=null;this.flushId=null;this.viewState=viewState;
    this.contentState=null;this.contentReadyPromise=new Promise(resolve=>{this.resolveContentReady=resolve;});
    this.settingsSave=createSettingsSaveLifecycle({api:this.api,manifest:this.manifest,notify:this.onNotify});
    this.listener=event=>this.handle(event); window.addEventListener('message',this.listener);
    frame.addEventListener('load',()=>this.send({jsonrpc:'2.0',method:'panel.init',params:{nonce:this.nonce,panel:this.manifest.id,...(this.settingsSave?{settingsSave:true}:{}),...(this.viewState?{viewState:this.viewState.read()}:{})}}),{once:true});
  }
  allowed(method,path) { return !['/api/console/bootstrap','/api/config/lifecycle','/api/config/lifecycle/open'].includes(path) && this.manifest.kind==='bundled' && (this.manifest.api??[]).some(rule=>rule.method===method&&routePattern(rule.path).test(path)); }
  valid(event,message) {
    return !this.closed && event.source===this.frame.contentWindow && event.origin==='null' && message && message.jsonrpc==='2.0' && message.meta?.nonce===this.nonce && message.meta?.panel===this.manifest.id && typeof message.method==='string' && RPC_METHODS.has(message.method);
  }
  async handle(event) {
    const message=event.data; if(!this.valid(event,message))return;
    if(message.method==='panel.ready') { this.ready=true; this.onReady?.();if(this.manifest.kind!=='bundled')this.finishContentReady('unsupported'); return; }
    if(message.method==='panel.contentReady'){
      if(this.manifest.kind!=='bundled'){if(Object.hasOwn(message,'id'))this.fail(message.id,RPC.FORBIDDEN,'此通知仅供内置面板使用');return;}
      if(!this.ready||message.params!==undefined||Object.hasOwn(message,'id'))return;
      this.finishContentReady('ready');return;
    }
    if(['settings.saveState','settings.save'].includes(message.method)){
      if(!this.settingsSave)return this.fail(message.id,RPC.FORBIDDEN,'当前面板未获默认设置保存合同');
      try{const result=message.method==='settings.saveState'?this.settingsSave.stage(message.params):await this.settingsSave.save(message.params);this.reply(message.id,result);}
      catch(error){this.fail(message.id,RPC.INTERNAL,error.message,error.status);}return;
    }
    if(message.method==='ui.destructiveProgress'){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='settings'||!this.allowed('POST','/api/reset-data'))return this.fail(message.id,RPC.FORBIDDEN,'此面板不能设置全窗口删除反馈');
      const params=message.params;
      if(!params||Object.keys(params).some(key=>!['progress','phase'].includes(key))||!Object.hasOwn(params,'progress')||!Number.isFinite(params.progress)||params.progress<0||params.progress>1||params.phase!==undefined&&!['charging','pending','complete','cancelled'].includes(params.phase))return this.fail(message.id,RPC.INVALID,'删除进度无效');
      if(this.leaving&&params.progress>0)return;
      this.destructiveProgressActive=params.progress>0||params.phase==='complete';this.onDestructiveProgress?.(params.progress,params.phase);
      if(Object.hasOwn(message,'id'))this.reply(message.id,{ok:true});return;
    }
    if(['community.authenticateMarket','community.cancelMarketAuthentication'].includes(message.method)){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='community'||!this.allowed('POST','/api/market/login'))return this.fail(message.id,RPC.FORBIDDEN,'此面板不能管理社区登录');
      if(message.method==='community.cancelMarketAuthentication'){this.authenticationController?.abort(new Error('已取消登录等待；若认证请求已发出，请刷新账号状态'));return this.reply(message.id,{ok:true});}
      if(this.authenticationController)return this.fail(message.id,RPC.INTERNAL,'社区认证正在进行，请勿重复操作',409);
      const controller=new AbortController();this.authenticationController=controller;this.controllers.add(controller);
      try{if(typeof this.onAuthenticateMarket!=='function')throw new Error('当前环境未提供社区人机验证与登录能力');this.reply(message.id,await this.onAuthenticateMarket(message.params,{signal:controller.signal}));}
      catch(error){this.fail(message.id,RPC.INTERNAL,error.message,error.status);}
      finally{this.controllers.delete(controller);if(this.authenticationController===controller)this.authenticationController=null;}
      return;
    }
    if(message.method==='ui.captchaDiagnostics'){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='community')return this.fail(message.id,RPC.FORBIDDEN,'此面板不能打开验证码诊断');
      if(message.params!==undefined&&(!message.params||typeof message.params!=='object'||Array.isArray(message.params)||Object.keys(message.params).length))return this.fail(message.id,RPC.INVALID,'诊断仅检测固定网络目标');
      try{if(typeof this.onCaptchaDiagnostics!=='function')throw new Error('验证码诊断尚未就绪');this.onCaptchaDiagnostics();return this.reply(message.id,{ok:true});}
      catch(error){return this.fail(message.id,RPC.INTERNAL,error.message);}
    }
    if(['community.publishMarket','community.cancelMarketPublish'].includes(message.method)){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='community'||!this.allowed('POST','/api/market/publish'))return this.fail(message.id,RPC.FORBIDDEN,'此面板不能发布扩展');
      if(message.method==='community.cancelMarketPublish'){this.marketController?.abort(new Error('已取消发布等待；若已开始上传，请到市场确认结果'));return this.reply(message.id,{ok:true});}
      if(this.marketController)return this.fail(message.id,RPC.INTERNAL,'扩展正在发布，请勿重复操作',409);
      const controller=new AbortController();this.marketController=controller;this.controllers.add(controller);
      try{if(typeof this.onPublishMarket!=='function')throw new Error('当前环境未提供人机验证与扩展发布能力');this.reply(message.id,await this.onPublishMarket(message.params,{signal:controller.signal}));}
      catch(error){this.fail(message.id,RPC.INTERNAL,error.message,error.status);}
      finally{this.controllers.delete(controller);if(this.marketController===controller)this.marketController=null;}
      return;
    }
    if(message.method==='console.manageToken'){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='settings')return this.fail(message.id,RPC.FORBIDDEN,'此面板不能管理控制台令牌');
      if(message.params!==undefined&&(!message.params||typeof message.params!=='object'||Array.isArray(message.params)||Object.keys(message.params).length))return this.fail(message.id,RPC.INVALID,'令牌管理请求不能携带凭据');
      try{
        if(typeof this.onManageConsoleToken!=='function')throw new Error('控制台令牌管理尚未就绪');
        this.onManageConsoleToken();return this.reply(message.id,{ok:true});
      }catch(error){return this.fail(message.id,RPC.INTERNAL,error.message);}
    }
    if(message.method==='console.update'){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='settings')return this.fail(message.id,RPC.FORBIDDEN,'此面板不能控制版本检查');
      const params=message.params;
      if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==1||!['status','check','reveal'].includes(params.action))return this.fail(message.id,RPC.INVALID,'版本操作参数无效');
      try{
        if(typeof this.onUpdateAction!=='function')throw new Error('版本检查尚未就绪');
        return this.reply(message.id,await this.onUpdateAction(params));
      }catch(error){return this.fail(message.id,RPC.INTERNAL,error.message);}
    }
    if(['community.publishFeedback','community.cancelFeedbackPublish'].includes(message.method)){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='community'||!this.allowed('POST','/api/community/feedback'))return this.fail(message.id,RPC.FORBIDDEN,'此面板不能提交意见');
      if(message.method==='community.cancelFeedbackPublish'){this.feedbackController?.abort(new Error('已取消投稿'));return this.reply(message.id,{ok:true});}
      if(this.feedbackController)return this.fail(message.id,RPC.INTERNAL,'意见正在提交，请勿重复操作',409);
      const controller=new AbortController();this.feedbackController=controller;this.controllers.add(controller);
      try{
        if(typeof this.onPublishFeedback!=='function')throw new Error('当前环境未提供人机验证与意见提交能力');
        this.reply(message.id,await this.onPublishFeedback(message.params,{signal:controller.signal}));
      }catch(error){this.fail(message.id,RPC.INTERNAL,error.message,error.status);}
      finally{this.controllers.delete(controller);if(this.feedbackController===controller)this.feedbackController=null;}
      return;
    }
    if(['community.publishQuote','community.cancelQuotePublish'].includes(message.method)){
      if(this.manifest.kind!=='bundled'||this.manifest.id!=='chats'||!this.allowed('POST','/api/community/quotes'))return this.fail(message.id,RPC.FORBIDDEN,'此面板不能发布金句');
      if(message.method==='community.cancelQuotePublish'){this.quoteController?.abort(new Error('已取消投稿'));return this.reply(message.id,{ok:true});}
      if(this.quoteController)return this.fail(message.id,RPC.INTERNAL,'金句正在提交，请勿重复操作',409);
      const controller=new AbortController();this.quoteController=controller;this.controllers.add(controller);
      try{
        if(typeof this.onPublishQuote!=='function')throw new Error('当前环境未提供人机验证与金句发布能力');
        this.reply(message.id,await this.onPublishQuote(message.params,{signal:controller.signal}));
      }catch(error){this.fail(message.id,RPC.INTERNAL,error.message,error.status);}
      finally{this.controllers.delete(controller);if(this.quoteController===controller)this.quoteController=null;}
      return;
    }
    if(message.method==='ui.openExternal') {
      const targets=EXTERNAL_TARGETS_BY_PANEL.get(this.manifest.id);
      if(this.manifest.kind!=='bundled'||!targets)return this.fail(message.id,RPC.FORBIDDEN,'此面板不能打开公共网页');
      const target=message.params?.target;
      if(!targets.has(target))return this.fail(message.id,RPC.INVALID,'不支持的公共网页');
      try {
        if(typeof this.onOpenExternal!=='function')throw new Error('当前环境未提供打开网页能力');
        if(this.manifest.id==='settings'){
          const native=target==='protocol-login-native';
          if(!this.allowed('GET',native?'/api/local-protocols/login':'/api/local-protocols'))return this.fail(message.id,RPC.FORBIDDEN,'此设置面板不能管理协议端');
          const params=message.params;
          if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!['target','id'].includes(key))||['local-protocol-login','protocol-login-native'].includes(target)&&(typeof params.id!=='string'||!params.id||params.id.length>256))return this.fail(message.id,RPC.INVALID,'协议端页面参数无效');
          const current=native?await this.api.request('GET','/api/local-protocols/login',undefined,{sessionId:params.id,nativeOnly:1}):target==='local-protocol-login'?await this.api.request('GET','/api/local-protocols'):null;
          if(this.closed||this.leaving)return this.fail(message.id,RPC.INTERNAL,'面板已离开');
          const url=native?current?.sessionId===params.id?localProtocolLoginUrl(current.nativeUrl):null:localProtocolPageUrl(target,current,params.id);
          if(!url)throw new Error('当前实例没有可打开的本机登录页');
          return this.reply(message.id,await this.onOpenExternal(target,{protocolUrl:url}));
        }
        return this.reply(message.id,await this.onOpenExternal(target));
      }catch(error){return this.fail(message.id,RPC.INTERNAL,error.message);}
    }
    if(message.method==='appearance.open'||message.method==='appearance.select') {
      if(this.manifest.kind!=='bundled'||message.method==='appearance.open'&&this.manifest.id!=='settings')return this.fail(message.id,RPC.FORBIDDEN,'此面板不能打开外观编辑器');
      if(typeof this.onAppearance!=='function')return this.fail(message.id,RPC.INTERNAL,'外观编辑器尚未就绪');
      try{return this.reply(message.id,await this.onAppearance(message.method,message.params,this.manifest.id));}
      catch(error){return this.fail(message.id,RPC.INTERNAL,error.message);}
    }
    if(message.method==='theme.apply') {
      if(this.manifest.kind!=='bundled')return this.fail(message.id,RPC.FORBIDDEN,'用户面板不能修改宿主主题');
      // bundled 面板请求宿主换肤：外观参数由 shell 校验后落地并广播（面板不直接碰宿主 DOM）。
      const theme=message.params?.theme;
      if(!theme||typeof theme!=='object')return this.fail(message.id,RPC.INVALID,'主题参数缺失');
      try { this.onTheme?.(theme); return this.reply(message.id,{ok:true}); }
      catch(error){ return this.fail(message.id,RPC.INTERNAL,error.message); }
    }
    if(message.method==='panel.flushed'&&!Object.prototype.hasOwnProperty.call(message,'id')) { this.finishFlush(message.params); return; }
    if(!Object.prototype.hasOwnProperty.call(message,'id'))return;
    if(this.manifest.kind==='user')return this.handleUser(message);
    if(message.method==='ui.notify') { this.onNotify(String(message.params?.text??'')); return this.reply(message.id,{ok:true}); }
    if(message.method==='ui.confirm')return this.fail(message.id,RPC.FORBIDDEN,'Bundled 面板不能直接请求确认');
    if(message.method==='panel.flushed')return this.reply(message.id,{ok:true});
    if(message.method!=='api.request')return this.fail(message.id,RPC.NOT_FOUND,'方法不存在');
    const method=String(message.params?.method??'GET').toUpperCase(),path=message.params?.path;
    if(typeof path!=='string'||!path.startsWith('/api/')||path.includes('..')||!this.allowed(method,path))return this.fail(message.id,RPC.FORBIDDEN,'未授权的面板 API');
    if(method==='POST'&&path==='/api/market/publish')return this.fail(message.id,RPC.FORBIDDEN,'扩展发布需要宿主人机验证，请使用发布按钮');
    if(method==='POST'&&path==='/api/market/login')return this.fail(message.id,RPC.FORBIDDEN,'社区登录需要宿主人机验证，请使用登录或注册按钮');
    if(path==='/api/config'&&method==='POST'){
      const body=message.params?.body;
      if(body&&typeof body==='object'&&(Object.hasOwn(body,'__replace__')||Object.hasOwn(body,'server')&&(!body.server||typeof body.server!=='object'||Array.isArray(body.server)||Object.hasOwn(body.server,'token')||Object.hasOwn(body.server,'__replace__'))))return this.fail(message.id,RPC.FORBIDDEN,'控制台令牌只能在宿主窗口管理');
    }
    const controller=new AbortController(); this.controllers.add(controller);
    const protocolLogin=this.manifest.kind==='bundled'&&this.manifest.id==='settings'&&(method==='GET'&&path==='/api/local-protocols/login'||method==='POST'&&PROTOCOL_LOGIN_POSTS.has(path));
    const accountControl=this.manifest.kind==='bundled'&&this.manifest.id==='settings'&&(method==='GET'&&path==='/api/accounts'||method==='POST'&&['/api/accounts/start','/api/accounts/stop','/api/accounts/remove'].includes(path));
    const removalByQq=path==='/api/accounts/remove'&&message.params?.body?.id===undefined&&/^\d{5,10}$/.test(message.params?.body?.accountId||'');
    if(accountControl&&method==='POST'&&!normalizeAccountId(message.params?.body?.id)&&!removalByQq){this.controllers.delete(controller);return this.fail(message.id,RPC.INVALID,'账号标识无效');}
    const timeout=hostApiRequestTimeout(method,path,this.timeout);
    const timer=setTimeout(()=>controller.abort(new DOMException('请求超时','TimeoutError')),timeout);
    try {
      const result=await (accountControl?this.controlApi:this.api).request(method,path,message.params?.body,message.params?.query,{signal:controller.signal,timeout});
      if(this.manifest.id==='settings'){
        if(method==='POST'&&path==='/api/uikit/background/uploads'&&/^[a-f0-9]{32}$/.test(result?.id||'')){
          if(this.closed||this.leaving)this.releaseBackgroundUpload(result.id);else this.backgroundUploads.add(result.id);
        }
        const completed=/^\/api\/uikit\/background\/uploads\/([a-f0-9]{32})(?:\/complete)?$/.exec(path);
        if(completed&&(method==='DELETE'||method==='POST'&&path.endsWith('/complete')))this.backgroundUploads.delete(completed[1]);
      }
      if(protocolLogin){
        if(path==='/api/local-protocols/login/close'){
          if(message.params?.body?.sessionId===this.protocolLoginSession)this.protocolLoginSession=null;
        }else if(validProtocolSession(result?.sessionId)){
          if(this.closed||this.leaving)this.releaseProtocolLogin(result.sessionId);
          else this.protocolLoginSession=result.sessionId;
        }
        // Dispose can race a successful response after headers have arrived.
        // Close its native session before honoring the ordinary RPC abort.
        if(this.closed||this.leaving)return;
      }
      // A JSON decoder may normalize its body-read error. The host cancellation
      // remains authoritative even when HTTP 200 headers arrived before abort.
      if(controller.signal.aborted)throw controller.signal.reason;
      this.reply(message.id,result);
      if(accountControl&&['/api/accounts/stop','/api/accounts/remove'].includes(path)&&message.params.body.id)this.onAccountStopped?.(message.params.body.id);
    }
    catch(error) { this.fail(message.id,error.name==='TimeoutError'||error.name==='AbortError'?RPC.INTERNAL:RPC.FORBIDDEN,error.name==='AbortError'?'面板已卸载':error.message,error.status); }
    finally { clearTimeout(timer);this.controllers.delete(controller); }
  }
  async handleUser(message) {
    if(!['ctx.call','ctx.getConfig','ctx.notify'].includes(message.method))return this.fail(message.id,RPC.NOT_FOUND,'用户面板仅允许 ctx.call、ctx.getConfig、ctx.notify');
    try {
      let result;
      if(message.method==='ctx.call')result=await this.onUserCall(message.params?.tool,message.params?.args??{},this.manifest.id,this.manifest.generation);
      else if(message.method==='ctx.getConfig')result=await this.onUserConfig(message.params?.key,this.manifest.id,this.manifest.generation);
      else {this.onNotify(String(message.params?.text??''));result={ok:true};}
      this.reply(message.id,result);
    } catch(error) { this.fail(message.id,RPC.FORBIDDEN,error.message); }
  }
  reply(id,result) { this.send({jsonrpc:'2.0',id,result}); }
  fail(id,code,message,httpStatus) { this.send({jsonrpc:'2.0',id,error:{code,message,data:httpStatus?{httpStatus}:undefined}}); }
  event(name,payload) {
    if(!this.ready)return;
    // 用户 iframe 不接收全局日志、会话、聊天、权限与带密钥的 SSE。
    if(this.manifest.kind==='user'){
      // Theme is host -> panel paint data only, never a new user RPC capability.
      if(name==='theme')payload=publicPanelTheme(payload);
      else{
        if(!['plugin-loaded','plugin-unloaded','plugin-error'].includes(name)||payload?.id!==this.manifest.ownerId)return;
        payload={id:payload.id};
      }
    }
    this.send({jsonrpc:'2.0',method:'shell.event',params:{name,payload}});
  }
  send(message) { if(!this.closed)this.frame.contentWindow?.postMessage({...message,meta:{nonce:this.nonce,panel:this.manifest.id}},'*'); }
  finishContentReady(status){
    if(this.contentState)return;
    this.contentState={status};this.resolveContentReady?.(this.contentState);this.resolveContentReady=null;
  }
  whenContentReady({timeout=4000}={}){
    if(this.contentState)return Promise.resolve(this.contentState);
    const duration=Number.isFinite(timeout)?Math.max(0,Math.min(15000,timeout)):4000;
    return new Promise(resolve=>{const timer=setTimeout(()=>resolve({status:'timeout'}),duration);this.contentReadyPromise.then(value=>{clearTimeout(timer);resolve(value);});});
  }
  flush() {
    this.leaving=true;this.clearDestructiveProgress();
    if(this.closed||!this.ready||this.flushed)return Promise.resolve();
    if(this.flushPromise)return this.flushPromise;
    this.flushId=crypto.randomUUID();this.viewState?.leave(this.flushId);
    this.flushPromise=new Promise((resolve,reject)=>{this.flushResolve=resolve;this.flushReject=reject;this.flushTimer=setTimeout(()=>this.finishFlush(null,true),this.timeout);});
    this.send({jsonrpc:'2.0',method:'panel.leave',params:{flushId:this.flushId}});return this.flushPromise;
  }
  finishFlush(params,expired=false) {
    if(!this.flushResolve)return;
    if(!expired&&params?.flushId!==this.flushId)return;
    const failed=expired||params?.ok===false;
    if(!failed)this.viewState?.finish(this.flushId,params?.viewState);
    clearTimeout(this.flushTimer);this.flushTimer=null;const resolve=this.flushResolve,reject=this.flushReject;this.flushResolve=null;this.flushReject=null;this.flushPromise=null;
    if(failed){this.leaving=false;this.viewState?.cancel?.(this.flushId);this.send({jsonrpc:'2.0',method:'panel.leaveCancelled',params:{flushId:this.flushId}});reject(new Error(expired?'等待面板保存超时；当前编辑仍保留，请稍后重试':String(params.error||'面板保存失败；当前编辑仍保留')));}else{this.flushed=true;resolve();}
  }
  clearDestructiveProgress(){if(this.destructiveProgressActive){this.destructiveProgressActive=false;this.onDestructiveProgress?.(0,'cancelled');}}
  releaseProtocolLogin(sessionId){
    if(!validProtocolSession(sessionId)||this.protocolLoginReleased.has(sessionId))return;
    this.protocolLoginReleased.add(sessionId);
    try{void Promise.resolve(this.api.request('POST','/api/local-protocols/login/close',{sessionId})).catch(()=>{});}catch{}
  }
  beforeUnload(event){return this.settingsSave?.beforeUnload(event)??false;}
  releaseBackgroundUpload(id){
    if(!/^[a-f0-9]{32}$/.test(id||''))return;this.backgroundUploads.delete(id);
    try{void Promise.resolve(this.api.request('DELETE',`/api/uikit/background/uploads/${id}`)).catch(()=>{});}catch{}
  }
  close() { if(this.closed)return;this.leaving=true;this.finishContentReady('closed');this.clearDestructiveProgress();this.finishFlush(null,true);this.viewState?.expire();this.settingsSave?.close();this.closed=true;this.releaseProtocolLogin(this.protocolLoginSession);this.protocolLoginSession=null;for(const id of [...this.backgroundUploads])this.releaseBackgroundUpload(id);window.removeEventListener('message',this.listener);for(const controller of this.controllers)controller.abort();this.controllers.clear(); }
}
