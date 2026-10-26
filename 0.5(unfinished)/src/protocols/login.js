import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import QRCode from 'qrcode';
import {verifyProtocolWebSocket} from './verify-connection.js';
import {authenticateNative,readNativeLogin,refreshNativeQr,injectNativeProcess,prepareSnowConnection} from './native-login-client.js';

const bad=(message,status=400)=>Object.assign(new Error(message),{status,expose:true});
const loopback=new Set(['127.0.0.1','localhost','[::1]']);
const nativePaths=/^\/api\/(?:auth\/(?:login|state)|login|agreements|processes(?:\/[1-9]\d*\/(?:load|refresh))?|config\/\d{5,10}|QQLogin\/(?:CheckLoginStatus|GetQQLoginInfo|RefreshQRcode))$/;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const allocatePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});

/** Explicit loopback control origins only. Never infer an admin port or accept an API URL. */
export function protocolControlUrl(value){
  try{
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||!loopback.has(url.hostname)||url.username||url.password||url.search||url.hash||!['/','/webui','/webui/'].includes(url.pathname))return null;
    return url;
  }catch{return null;}
}

async function boundedJson(response,max=2*1024*1024){
  if(Number(response.headers?.get?.('content-length'))>max){await response.body?.cancel?.();throw bad('协议端响应过大',502);}
  if(!response.body){try{return JSON.parse(await response.text());}catch{throw bad('协议端返回了无效响应',502);}}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw bad('协议端响应过大',502);chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch(error){if(error.expose)throw error;throw bad('协议端返回了无效响应',502);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

async function ownedNapPassword(root){
  // This exact host-owned file is the only credential source. Never search
  // browser storage or read SnowLuma password hashes as login credentials.
  let current=root;
  for(const segment of ['', 'napcat','config','webui.json']){
    if(segment)current=path.join(current,segment);
    const stat=await fs.lstat(current);
    if(stat.isSymbolicLink()||(segment==='webui.json'?!stat.isFile():!stat.isDirectory()))throw bad('协议端管理配置路径不可用');
  }
  const file=await fs.open(current,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{const before=await file.stat();if(!before.isFile()||before.size>65536)throw bad('协议端管理配置不可用');const value=JSON.parse(await file.readFile('utf8'));const after=await fs.lstat(current);if(after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev)throw bad('协议端管理配置已变化');return typeof value.token==='string'&&value.token.length<=8192?value.token:'';}
  finally{await file.close();}
}

/** Native login bridge. Credentials stay here; public state contains only the
 * requested account controls. Closing a view cancels its I/O and SSE stream. */
export function createProtocolLogin({config,localProtocols,bus,fetchImpl=globalThis.fetch,allocatePort:freePort=allocatePort,qrImageFor=null,verifyConnection=verifyProtocolWebSocket,onVerifiedAccount=null,getAccounts=null}={}){
  const fetchFn=fetchImpl||globalThis.fetch;
  let view=null,closed=false,authCache=null,pending=null,revision=0,openEpoch=0,eventTimer=null,externalIdentity=null,versionCache=null,committing=false;
  const qrCache=new Map();
  const onebotKey=()=>digest(JSON.stringify(config.get().onebot||{}));
  const current=v=>!closed&&view===v&&!v.closed;
  const assertCurrent=v=>{if(!current(v))throw bad('账号接入窗口已失效，请重新打开',409);};
  function notify(v){if(!current(v)||eventTimer)return;eventTimer=setTimeout(()=>{eventTimer=null;if(current(v))bus?.emit('protocol-login',{sessionId:v.id,revision:++revision});},60);eventTimer.unref?.();}
  function abortView(v){if(!v)return;v.closed=true;clearTimeout(v.pendingTimer);clearTimeout(v.streamRetry);v.stream?.abort();v.stream=null;for(const controller of v.controllers)controller.abort();v.controllers.clear();}
  function invalidate(){++openEpoch;abortView(view);view=null;authCache=null;pending=null;clearTimeout(eventTimer);eventTimer=null;}
  function state(v,patch={}){
    return{sessionId:v?.id||'',provider:v?.ctx?.provider||null,source:v?.ctx?.source||null,stage:'unavailable',qrImage:'',account:null,processes:[],error:'',message:'',canRefresh:false,needsNative:false,needsCredentials:false,needsAddress:false,needsTotp:false,pollAfterMs:0,nativeUrl:v?.ctx?.webUiUrl||null,...(v?.workspaceId?{workspaceId:v.workspaceId}:{}),...patch};
  }
  async function fetchLocal(v,url,options={},max=2*1024*1024){
    assertCurrent(v);const controller=new AbortController();v.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),Math.max(100,Math.min(35000,options.timeoutMs||8000)));timer.unref?.();
    try{
      const response=await fetchFn(url,{method:options.method||'GET',headers:{...options.headers,...(options.body===undefined?{}:{'content-type':'application/json'})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),redirect:'error',signal:controller.signal});
      assertCurrent(v);const body=await boundedJson(response,max);assertCurrent(v);
      if(!response.ok)throw Object.assign(bad(response.status===401?'协议端认证已失效':'协议端未接受此请求',response.status),{body:{consentRequired:body?.consentRequired===true,mustChangePassword:body?.mustChangePassword===true}});
      return body;
    }catch(error){if(error.expose)throw error;assertCurrent(v);throw bad('无法连接协议端管理页面，请检查地址和运行状态',502);}
    finally{clearTimeout(timer);v.controllers.delete(controller);}
  }
  function requestFor(v){return async(endpoint,options={})=>{
    if(!nativePaths.test(endpoint))throw bad('不支持此协议端管理操作');
    const base=protocolControlUrl(v.ctx.webUiUrl);if(!base)throw bad('请先填写本机协议端管理地址');
    return fetchLocal(v,new URL(endpoint,base),options);
  };}
  async function context(preferredId){
    const managed=localProtocols?.loginContext?.(),ob=config.get().onebot||{};
    const matchesManaged=managed&&[[ob.httpUrl,managed.httpPort,'http:','https:'],[ob.wsUrl,managed.wsPort,'ws:','wss:']].every(([value,port,...schemes])=>{try{const url=new URL(value);return loopback.has(url.hostname)&&schemes.includes(url.protocol)&&Number(url.port)===port;}catch{return false;}});
    if(managed&&(preferredId===managed.id||!preferredId&&matchesManaged)){
      const url=protocolControlUrl(managed.webUiUrl);
      return{...managed,source:'managed',key:'managed:'+managed.instanceId,webUiUrl:url?.href||''};
    }
    if(preferredId)throw bad('协议端实例已停止，请先启动',409);
    const signature=onebotKey();
    if(!externalIdentity||externalIdentity.signature!==signature)externalIdentity={signature,id:crypto.randomUUID()};
    let provider=null;
    if(versionCache?.signature===signature&&Date.now()-versionCache.at<15000)provider=versionCache.provider;
    else{
      try{
        const base=new URL(ob.httpUrl);if(!['http:','https:'].includes(base.protocol)||!loopback.has(base.hostname)||base.username||base.password||base.search||base.hash)throw Error();
        const response=await fetchFn(new URL('get_version_info',base.href.replace(/\/?$/,'/')),{headers:{Authorization:'Bearer '+String(ob.httpAccessToken||ob.accessToken||'')},redirect:'error',signal:AbortSignal.timeout(2500)});
        const body=await boundedJson(response,65536);const name=body?.data?.app_name;
        if(response.ok&&body?.retcode===0&&body?.status==='ok')provider=name==='NapCat.Onebot'?'napcat':name==='SnowLuma'?'snowluma':null;
      }catch{/* Unsupported or not yet ready: no admin URL is guessed. */}
      versionCache={signature,provider,at:Date.now()};
    }
    return{provider,source:'external',key:'external:'+externalIdentity.id,webUiUrl:authCache?.key==='external:'+externalIdentity.id?authCache.webUiUrl:'',account:externalIdentity.account||''};
  }
  async function resolveView(query={}){
    if(closed)throw bad('账号接入服务已停止',409);
    if(query.sessionId){if(!view||view.id!==query.sessionId)throw bad('账号接入窗口已失效，请重新打开',409);
      const v=view,ctx=await context(v.preferredId);assertCurrent(v);if(ctx.key!==v.ctx.key){invalidate();throw bad('协议端实例已变化，请重新打开账号接入',409);}v.ctx={...v.ctx,...ctx,...(v.attachedAccount?{account:v.attachedAccount}:{})};return v;}
    const epoch=++openEpoch,ctx=await context(query.id);if(closed||epoch!==openEpoch)throw bad('账号接入窗口已失效，请重新打开',409);
    abortView(view);pending=null;clearTimeout(eventTimer);eventTimer=null;
    if(authCache?.key!==ctx.key){authCache=null;pending=null;}
    view={id:crypto.randomUUID(),ctx,preferredId:query.id,controllers:new Set(),stream:null,streamFailed:false,closed:false,busy:false,read:null,hidden:false};
    return view;
  }
  async function encodeQr(raw){
    if(typeof raw!=='string'||raw.length>2048||!/^https?:\/\//i.test(raw))throw bad('登录二维码暂不可用');
    const key=digest(raw);if(qrCache.has(key))return qrCache.get(key);
    const image=qrImageFor?await qrImageFor(raw):await QRCode.toDataURL(raw,{type:'image/png',width:256,margin:3,errorCorrectionLevel:'M'});
    if(typeof image!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>512*1024)throw bad('登录二维码暂不可用');
    qrCache.clear();qrCache.set(key,image);return image;
  }
  async function ensureCredential(v){
    assertCurrent(v);if(authCache?.key===v.ctx.key&&authCache.credential&&authCache.expires>Date.now())return authCache.credential;
    if(authCache?.key===v.ctx.key&&authCache.needsTotp)return{needsTotp:true};
    if(authCache?.key!==v.ctx.key)authCache={key:v.ctx.key,webUiUrl:v.ctx.webUiUrl,credential:'',expires:0,autoTried:false};
    if(v.ctx.source==='managed'&&v.ctx.provider==='napcat'&&!authCache.autoTried&&v.ctx.webUiUrl){
      authCache.autoTried=true;
      try{const password=await ownedNapPassword(v.ctx.root);assertCurrent(v);const auth=await authenticateNative({provider:'napcat',request:requestFor(v),password});assertCurrent(v);if(auth.needsTotp){authCache.needsTotp=true;return{needsTotp:true};}authCache.credential=auth.credential;authCache.expires=Date.now()+55*60000;return auth.credential;}
      catch(error){assertCurrent(v);if(error.status===429)throw error;}
    }
    return '';
  }
  function credentials(v,patch={}){return state(v,{stage:'credentials',needsCredentials:true,needsAddress:!v.ctx.webUiUrl,...patch});}
  function startSnowStream(v,credential){
    if(v.ctx.provider!=='snowluma'||v.stream||v.streamRetry||v.hidden||!current(v))return;
    const controller=new AbortController();v.stream=controller;
    void(async()=>{
      let reader;
      try{
        const response=await fetchFn(new URL('/api/state/stream',v.ctx.webUiUrl),{headers:{'x-snowluma-token':credential,accept:'text/event-stream'},redirect:'error',signal:controller.signal});
        if(!current(v)||v.stream!==controller){await response.body?.cancel?.();return;}
        if(!response.ok||!response.body){if(response.status===401){authCache=null;notify(v);}throw Error();}
        reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
        while(current(v)&&v.stream===controller){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw Error();let match;
          while((match=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);for(const line of block.split(/\r?\n/))if(line.startsWith('data:'))try{const event=JSON.parse(line.slice(5));if(event.kind==='ready'||['processes','qq-list',...(getAccounts?['connections']:[])].includes(event.resource)){const recovered=v.streamFailed;v.streamFailed=false;v.streamRetries=0;if(recovered||event.resource)notify(v);}}catch{/* Ignore malformed native metadata. */}}
        }
      }catch{/* Retry an interrupted stream only while this exact visible login session exists. */}
      finally{if(reader){await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}if(v.stream===controller){v.stream=null;if(current(v)&&!v.hidden&&!controller.signal.aborted){v.streamFailed=true;notify(v);if(authCache?.key===v.ctx.key&&authCache.credential===credential){v.streamRetries=(v.streamRetries||0)+1;v.streamRetry=setTimeout(()=>{v.streamRetry=null;if(current(v)&&!v.hidden&&authCache?.credential===credential)startSnowStream(v,credential);},Math.min(30000,1000*2**Math.min(v.streamRetries-1,5)));v.streamRetry.unref?.();}}}}
    })();
  }
  async function probeSnow(v,target){
    try{
      const body=await fetchLocal(v,`http://127.0.0.1:${target.httpPort}/get_login_info`,{headers:{Authorization:'Bearer '+target.token},timeoutMs:1500},65536);
      if(body.status!=='ok'||body.retcode!==0||String(body.data?.user_id)!==target.accountId)return false;
      assertCurrent(v);const controller=new AbortController();v.controllers.add(controller);
      try{return await verifyConnection({...target,signal:controller.signal});}finally{v.controllers.delete(controller);}
    }catch(error){assertCurrent(v);if(error.status===409)throw error;return false;}
  }
  function savedSnowTarget(v){
    if(!v.ctx.account)return null;
    try{const ob=config.get().onebot||{},http=new URL(ob.httpUrl),ws=new URL(ob.wsUrl),token=ob.accessToken;
      if(http.protocol!=='http:'||ws.protocol!=='ws:'||http.hostname!=='127.0.0.1'||ws.hostname!=='127.0.0.1'||http.username||http.password||ws.username||ws.password||ob.httpAccessToken&&ob.httpAccessToken!==token)return null;
      return{accountId:v.ctx.account,httpPort:Number(http.port),wsPort:Number(ws.port),token};
    }catch{return null;}
  }
  async function snowWorkspaceConnected(v,target){
    if(typeof getAccounts==='function'){
      const accounts=await getAccounts();assertCurrent(v);
      return accounts?.accounts?.some(row=>String(row.accountId)===target.accountId&&row.connected===true&&row.wanted!==false&&(!v.workspaceId||row.id===v.workspaceId))===true;
    }
    // Standalone adapters have no registry. They verify both endpoints during a
    // read and exclude their own connection notifications from the refresh stream.
    return probeSnow(v,target);
  }
  async function settlePending(v){
    if(!pending||pending.key!==v.ctx.key)return;
    const target=pending;
    if(target.until&&Date.now()>target.until)return;
    if(target.settling)return;target.settling=true;
    try{const body=await fetchLocal(v,`http://127.0.0.1:${target.httpPort}/get_login_info`,{headers:{Authorization:'Bearer '+target.token},timeoutMs:1500},65536);
      if(body.status!=='ok'||body.retcode!==0||String(body.data?.user_id)!==target.accountId)return;
      assertCurrent(v);if(pending!==target)return;
      const controller=new AbortController();v.controllers.add(controller);
      let wsReady;try{wsReady=await verifyConnection({...target,signal:controller.signal});}finally{v.controllers.delete(controller);}
      assertCurrent(v);if(pending!==target||!wsReady)return;
      // Endpoint probes may wait for the DLL. Workspace registration is a single explicit attempt.
      target.registering=true;
      const workspace=typeof onVerifiedAccount==='function'?await onVerifiedAccount({accountId:target.accountId,nickname:target.nickname,httpPort:target.httpPort,wsPort:target.wsPort,token:target.token,provider:'snowluma'}):null;
      assertCurrent(v);if(pending!==target)return;
      if(workspace?.workspaceId){v.workspaceId=workspace.workspaceId;v.attachedAccount=target.accountId;}
      if(workspace?.workspaceId&&workspace.workspaceId!=='primary'){/* A separate worker owns this connection; the primary QQ keeps running. */}
      else if(v.ctx.source==='managed')localProtocols.commitLoginConnection(v.ctx.instanceId,target.accountId,target);
      else{committing=true;try{config.update({onebot:{httpUrl:`http://127.0.0.1:${target.httpPort}`,wsUrl:`ws://127.0.0.1:${target.wsPort}`,accessToken:target.token,httpAccessToken:target.token}});externalIdentity.signature=onebotKey();externalIdentity.account=target.accountId;versionCache={signature:onebotKey(),provider:'snowluma',at:Date.now()};}finally{committing=false;}bus?.emit('status',{configUpdated:true});}
      v.ctx.account=target.accountId;v.snowTarget=target;v.verifiedSnow=target.accountId;pending=null;
    }catch(error){assertCurrent(v);if(target.registering){pending=null;v.pendingError='QQ 连接已核验，但账号工作区未能就绪。请检查账号连接状态后重试。';notify(v);return;}if(error.status===409)throw error;}finally{target.settling=false;}
  }
  function followPending(v){
    if(!current(v)||v.hidden||v.pendingTimer||!pending||pending.key!==v.ctx.key)return;
    const target=pending;if(!target.until)target.until=Date.now()+30000;
    if(Date.now()>target.until){if(target.expiring)return;target.expiring=true;void(async()=>{let message='所选 QQ 的连接尚未就绪，请检查协议端状态后重试。';try{await target.rollback?.();}catch{message='连接超时，且未能恢复原配置，请打开协议端检查。';}if(!current(v)||pending!==target)return;pending=null;v.pendingError=message;notify(v);})();return;}
    v.pendingTimer=setTimeout(async()=>{v.pendingTimer=null;if(!current(v)||v.hidden||pending!==target)return;try{await settlePending(v);if(pending!==target)notify(v);else followPending(v);}catch{/* Closed views cannot commit or schedule further work. */}},750);v.pendingTimer.unref?.();
  }
  async function settlePreparedNap(v,result){
    const prepared=v.ctx.source==='managed'&&v.ctx.provider==='napcat'&&v.ctx.preparedConnection;
    // Legacy Nap reads remain read-only. Only an explicit deferred launch
    // owns credentials that can be handed to a new isolated account worker.
    if(!prepared||result.stage!=='connected')return result;
    const accountId=String(result.account?.id||''),expected=prepared.accountId||v.ctx.account||'';
    if(!/^\d{5,10}$/.test(accountId)||expected&&accountId!==expected)return{...result,stage:'error',account:null,error:'登录的 QQ 与所选账号不一致，请切换至所选账号后重试。',pollAfterMs:1500};
    // A generic QR flow prepares only the template for a new QQ. A remembered
    // QQ owns its saved listeners, so its connection needs explicit selection.
    if(!expected&&Array.isArray(prepared.existingAccounts)&&prepared.existingAccounts.includes(accountId))return{...result,stage:'error',account:null,error:'这是已保存的 QQ，请返回选择该账号后连接',pollAfterMs:0};
    if(![prepared.httpPort,prepared.wsPort].every(port=>Number.isInteger(port)&&port>0&&port<65536)||prepared.httpPort===prepared.wsPort||!/^[a-f0-9]{64}$/.test(prepared.token||''))throw bad('协议端准备的账号连接无效，请重新启动协议端',409);
    const signature=digest(JSON.stringify({...prepared,accountId}));
    if(v.napVerified===signature&&v.workspaceId&&v.attachedAccount===accountId)return result;
    const verifying=()=>({...result,stage:'initializing',account:null,message:'登录已完成，正在验证 QQ 连接…',pollAfterMs:700});
    const target={accountId,nickname:result.account.nickname||'',httpPort:prepared.httpPort,wsPort:prepared.wsPort,token:prepared.token};
    const body=await fetchLocal(v,`http://127.0.0.1:${target.httpPort}/get_login_info`,{headers:{Authorization:'Bearer '+target.token},timeoutMs:1500},65536);
    if(body.status!=='ok'||body.retcode!==0||String(body.data?.user_id)!==accountId)return verifying();
    assertCurrent(v);const controller=new AbortController();v.controllers.add(controller);
    let ready;try{ready=await verifyConnection({...target,signal:controller.signal});}finally{v.controllers.delete(controller);}
    assertCurrent(v);if(!ready)return verifying();
    const workspace=typeof onVerifiedAccount==='function'?await onVerifiedAccount({...target,provider:'napcat'}):null;
    assertCurrent(v);
    if(!workspace?.workspaceId||workspace.workspaceId==='primary')localProtocols.commitLoginConnection(v.ctx.instanceId,accountId,target);
    v.workspaceId=workspace?.workspaceId||'primary';v.attachedAccount=accountId;v.napVerified=signature;v.ctx.account=accountId;
    return result;
  }
  async function read(v){
    assertCurrent(v);if(v.read)return v.read;
    v.read=(async()=>{
      if(!v.ctx.provider)return state(v,{message:'当前 OneBot 不是 NapCat 或 SnowLuma，或尚未就绪。'});
      if(!v.ctx.webUiUrl)return v.ctx.source==='managed'?state(v,{stage:'initializing',message:'正在等待协议端管理页面启动…',pollAfterMs:700}):credentials(v);
      const credential=await ensureCredential(v);assertCurrent(v);
      if(typeof credential!=='string')return credentials(v,{needsTotp:credential.needsTotp});
      if(!credential)return credentials(v);
      try{
        let result=await readNativeLogin({provider:v.ctx.provider,request:requestFor(v),credential,qrImageFor:encodeQr});assertCurrent(v);
        result=await settlePreparedNap(v,result);assertCurrent(v);
        await settlePending(v);assertCurrent(v);
        if(v.ctx.provider==='snowluma'&&!result.needsNative){
          result.processes=result.processes.map(item=>!/^\d{5,10}$/.test(item.accountId)?{...item,selectable:false,reason:'请先在桌面 QQ 登录'}:item.status==='online'?{...item,selectable:true,reason:''}:item);
          if(pending?.key===v.ctx.key){result.stage='initializing';result.account=null;result.message='所选 QQ 正在接入，等待连接就绪…';followPending(v);}
          else{const target=v.snowTarget||savedSnowTarget(v),chosen=target&&result.processes.find(item=>item.accountId===target.accountId&&item.status==='online'),verified=chosen&&!v.pendingError&&await snowWorkspaceConnected(v,target);assertCurrent(v);if(!chosen)v.snowProof='';result.stage=verified?'connected':result.processes.some(item=>['loading','connecting'].includes(item.status))?'initializing':'waiting';result.account=verified?{id:chosen.accountId,nickname:chosen.nickname}:null;}
          if(v.pendingError){result.stage='error';result.error=v.pendingError;result.account=null;}
          else if(v.streamFailed)result.error='实时更新暂时中断，正在重新连接；也可手动刷新。';
          startSnowStream(v,credential);
        }
        return state(v,{...result,pollAfterMs:v.ctx.provider==='snowluma'?0:result.pollAfterMs});
      }catch(error){assertCurrent(v);if(error.needsCredentials){authCache=null;v.stream?.abort();v.stream=null;return credentials(v,{error:error.message});}if(error.needsNative)return state(v,{stage:'native',needsNative:true,message:'请在协议端页面完成首次确认及凭据设置。'});throw bad(error.expose?error.message:'暂时无法读取协议端登录状态',error.status===429?429:502);}
    })().finally(()=>{v.read=null;});return v.read;
  }
  async function action(body,run){if(typeof body?.sessionId!=='string'||!body.sessionId)throw bad('请先打开账号接入窗口');const v=await resolveView({sessionId:body.sessionId});if(v.busy||v.read)throw bad('账号接入操作正在进行，请稍候',409);v.busy=true;try{await run(v);assertCurrent(v);if(v.authResult){const result=v.authResult;v.authResult=null;return result;}return await read(v);}finally{v.busy=false;}}
  async function connect(body){return action(body,async v=>{
    if(!v.ctx.provider)throw bad('尚未检测到支持的协议端');
    v.stream?.abort();v.stream=null;clearTimeout(v.streamRetry);v.streamRetry=null;v.streamFailed=false;v.streamRetries=0;
    if(body.webUiUrl!==undefined){if(v.ctx.source!=='external')throw bad('托管协议端无需另填管理地址');const url=protocolControlUrl(body.webUiUrl);if(!url)throw bad('请输入有效的本机协议端管理地址');v.ctx.webUiUrl=url.href;authCache=null;}
    if(!v.ctx.webUiUrl)throw bad('请输入本机协议端管理地址');
    try{const auth=await authenticateNative({provider:v.ctx.provider,request:requestFor(v),password:body.password,totp:body.totp,recoveryCode:body.recoveryCode});assertCurrent(v);
      authCache={key:v.ctx.key,webUiUrl:v.ctx.webUiUrl,credential:auth.credential||'',expires:Date.now()+(v.ctx.provider==='napcat'?55*60000:23*3600000),autoTried:true,needsTotp:auth.needsTotp};
      if(auth.needsTotp){v.authResult=credentials(v,{needsTotp:true,message:auth.message});return;}
    }catch(error){throw bad(error.status===429?'协议端暂时限制了登录尝试，请稍后再试。':'访问口令或验证码不正确，请检查后重试。',error.status===429?429:401);}
  });}
  async function refresh(body){return action(body,async v=>{if(v.ctx.provider!=='napcat')throw bad('当前协议端不提供二维码');const credential=await ensureCredential(v);if(typeof credential!=='string'||!credential)throw bad('请先连接协议端管理页面',401);await refreshNativeQr({request:requestFor(v),credential});});}
  async function inject(body){return action(body,async v=>{
    if(v.ctx.provider!=='snowluma')throw bad('当前协议端不提供进程接入');
    if(pending?.key===v.ctx.key)throw bad('所选 QQ 正在接入，请等待核验完成',409);
    v.pendingError='';v.verifiedSnow='';
    const credential=await ensureCredential(v);if(typeof credential!=='string'||!credential)throw bad('请先连接协议端管理页面',401);
    const native=await readNativeLogin({provider:'snowluma',request:requestFor(v),credential});assertCurrent(v);
    const process=native.processes.find(item=>item.pid===body.pid&&(item.selectable||item.status==='online'));if(!process||!/^\d{5,10}$/.test(process.accountId))throw bad('请选择已在桌面 QQ 登录且可接入的账号');
    const httpPort=await freePort();let wsPort=await freePort();while(wsPort===httpPort)wsPort=await freePort();assertCurrent(v);
    let prepared;try{prepared=await prepareSnowConnection({request:requestFor(v),credential,accountId:process.accountId,httpPort,wsPort,token:crypto.randomBytes(32).toString('hex'),reuseExisting:true,verifySaved:true});assertCurrent(v);}catch(error){assertCurrent(v);v.pendingError=error instanceof Error&&error.name==='NativeLoginError'?error.message:'未能保存此 QQ 的连接配置，请刷新后重试。';notify(v);throw bad(v.pendingError,502);}
    const target={key:v.ctx.key,accountId:process.accountId,nickname:process.nickname,httpPort:prepared.httpPort,wsPort:prepared.wsPort,token:prepared.token,rollback:prepared.rollback};pending=target;
    try{if(process.status==='online'){const latest=await readNativeLogin({provider:'snowluma',request:requestFor(v),credential});assertCurrent(v);if(!latest.processes.some(item=>item.pid===body.pid&&item.status==='online'&&item.accountId===process.accountId))throw bad('所选 QQ 账号已变化，请重新选择',409);}else await injectNativeProcess({request:requestFor(v),credential,pid:body.pid,expectedAccountId:process.accountId});assertCurrent(v);await settlePending(v);followPending(v);notify(v);}
    catch(error){if(pending===target)pending=null;v.pendingError='未能接入所选 QQ 账号，请刷新列表后重试';if(current(v)&&prepared.rollback)try{await prepared.rollback();}catch{v.pendingError='接入未完成，且未能恢复原连接配置，请打开协议端检查。';}notify(v);throw bad(v.pendingError,502);}
  });}
  async function get(query={}){const v=await resolveView(query);if(query.nativeOnly==='1')return state(v);v.hidden=false;if(v.authResult){const value=v.authResult;v.authResult=null;return value;}return read(v);}
  function closeView(body={}){if(view?.id===body.sessionId){++openEpoch;pending=null;abortView(view);view=null;clearTimeout(eventTimer);eventTimer=null;}return{ok:true};}
  function visibility(body={}){if(view?.id===body.sessionId&&body.visible===false){view.hidden=true;clearTimeout(view.pendingTimer);view.pendingTimer=null;clearTimeout(view.streamRetry);view.streamRetry=null;view.stream?.abort();view.stream=null;}return{ok:true};}
  const off=config.onChange?.(()=>{if(!committing&&view?.ctx.source==='external'&&externalIdentity?.signature!==onebotKey())invalidate();});
  const offRuntime=bus?.on?.('local-protocols',()=>{if(view?.ctx.source!=='managed')return;const ctx=localProtocols?.loginContext?.();if(!ctx||ctx.instanceId!==view.ctx.instanceId)invalidate();},{internal:true});
  function close(){closed=true;invalidate();qrCache.clear();off?.();offRuntime?.();}
  return{get,connect,refresh,inject,closeView,visibility,close};
}
