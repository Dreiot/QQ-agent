import {createIcon} from '../icons.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';

const safeQr=value=>typeof value==='string'&&/^data:image\/png;base64,[a-z0-9+/=\r\n]+$/i.test(value)&&value.length<=2*1024*1024?value:'';
const WAITING=new Set(['waiting','scanned','initializing']);
const STATUS={unavailable:'未检测到支持的协议端',credentials:'验证管理密码',native:'完成首次设置',waiting:'等待扫码',scanned:'已扫码 · 请在手机上确认',initializing:'核对账号…',connected:'已连接',error:'连接未完成'};
const PROCESS_STATUS={ready:'可连接',available:'可连接',hooked:'可连接',injected:'可连接',loaded:'可连接',connected:'可连接',online:'可连接',loading:'接入中…',connecting:'连接中…',disconnected:'可重新连接',error:'可重试',running:'运行中',logged_in:'可连接',loggedIn:'可连接',offline:'未登录',denied:'权限不同'};
const accountInitial=(name,id)=>[...String(name||'')].find(char=>/[\p{L}\p{N}]/u.test(char))||String(id||'').slice(-2)||'Q';
function localAddress(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}

// Credentials, QR images and account candidates live only in this disposable
// dialog. A closed or hidden window never keeps a login status timer alive.
export function createProtocolLogin({request,subscribe,openNative,onConnected=()=>{},beforeDisconnect=async()=>{},onDisconnected=()=>{},onAccounts=()=>{},onDetected=()=>{},doc=document}){
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const button=(text,run,cls='')=>{const el=node('button',cls,text);el.type='button';el.addEventListener('click',()=>{void run();});return el;};
  const field=(title,type,autocomplete,tag='label')=>{const label=node(tag,'protocol-login-field'),caption=node(tag==='label'?'span':'label','',title),input=node('input');input.type=type;input.autocomplete=autocomplete;label.append(caption,input);return{label,input,caption};};
  let dialog=null,life=null,instance=null,snapshot=null,disposed=false,revision=0,timer=null,eventTimer=null,reading=false,again=false,busy=false,requestError='',connectedKey='',views=null,off=null,accountState=null,targetAccount='',pendingPid='',autoConnect=false,pendingActivation=null,operationPhase='',queuedIntent=null;
  const closedSessions=new Set(),clear=()=>{if(timer!==null)clearTimeout(timer);if(eventTimer!==null)clearTimeout(eventTimer);timer=eventTimer=null;};
  const visible=()=>!disposed&&!!dialog?.open&&!doc.hidden;
  function release(sessionId){if(!sessionId||closedSessions.has(sessionId))return;closedSessions.add(sessionId);void request('POST','/api/local-protocols/login/close',{sessionId}).catch(()=>{});}
  function close(){life?.close();}
  function cleanup(){clear();++revision;release(snapshot?.sessionId);off?.();off=null;doc.removeEventListener('visibilitychange',visibility);dialog=null;life=null;instance=null;snapshot=null;views=null;requestError='';connectedKey='';accountState=null;targetAccount='';pendingPid='';autoConnect=false;pendingActivation=null;operationPhase='';queuedIntent=null;reading=false;again=false;busy=false;}
  function schedule(){clear();if(!visible()||busy||reading||!snapshot||snapshot.provider!=='napcat'||!WAITING.has(snapshot.stage))return;timer=setTimeout(()=>{timer=null;void read();},Math.max(500,Math.min(10000,Number(snapshot.pollAfterMs)||3000)));}
  function pause(){if(snapshot?.sessionId)void request('POST','/api/local-protocols/login/visibility',{sessionId:snapshot.sessionId,visible:false}).catch(()=>{});}
  function visibility(){clear();if(!dialog)return;if(doc.hidden){queuedIntent=null;autoConnect=false;pendingActivation=null;views.qr.removeAttribute('src');views.qr.hidden=true;pause();render();}else void read();}
  function fail(reason){if(!views)return;requestError=reason?.message||String(reason||'无法读取账号连接状态');autoConnect=false;pendingActivation=null;queuedIntent=null;views.error.textContent=requestError;views.error.hidden=false;if(snapshot)render();else{views.status.textContent='无法读取账号';views.status.dataset.state='error';}}
  function queueRead(){if(!visible())return;if(reading||busy){again=true;return;}if(eventTimer===null){clear();eventTimer=setTimeout(()=>{eventTimer=null;void read();},80);}}
  function render(){
    if(!views||!snapshot)return;const value=snapshot,provider=value.provider||instance.provider,success=value.stage==='connected',credentials=value.needsCredentials===true||value.stage==='credentials';
    const progress=operationPhase||(queuedIntent?queuedIntent.enabled?'准备连接…':'准备断开…':''),service=provider==='napcat'?'NapCat':provider==='snowluma'?'SnowLuma':'协议端',target=value.processes?.find(item=>String(item.pid)===(pendingPid||queuedIntent?.pid))||value.processes?.find(item=>String(item.accountId)===targetAccount),targetId=target?.accountId||targetAccount;
    views.title.textContent=credentials?'连接 QQ':provider==='napcat'?'扫码连接 QQ':provider==='snowluma'?'选择 QQ':'连接 QQ';
    views.summary.textContent=[service,target?.nickname,targetId?'QQ '+targetId:''].filter(Boolean).join(' · ');
    views.credentialHint.textContent=`输入 ${service} 的管理密码${targetId?'，继续连接 QQ '+targetId:'，查看可连接的 QQ'}。`;
    let host='';try{const url=new URL(value.nativeUrl);if(localAddress(url.href))host=url.host;}catch{}
    views.serviceAddress.textContent=host?'本机服务 · '+host:'';views.serviceAddress.hidden=!host;
    views.error.textContent=requestError||value.error||'';views.error.hidden=!views.error.textContent;dialog.dataset.state=success?'connected':value.stage||'waiting';
    const detectedIds=new Set((Array.isArray(value.processes)?value.processes:[]).map(item=>String(item.accountId))),connectedCount=accountState?.accounts.filter(account=>detectedIds.has(String(account.accountId))&&account.connected&&account.wanted!==false).length||0,snowReady=provider==='snowluma'&&!credentials&&value.needsNative!==true;
    views.status.textContent=progress||((requestError||value.error)?'连接未完成':snowReady?connectedCount?`${connectedCount} 个 QQ 已连接`:'点选卡片连接 QQ':STATUS[value.stage]||value.message||'读取中…');views.status.dataset.state=progress?'working':requestError||value.error?'error':snowReady?connectedCount?'connected':'waiting':success?'connected':value.stage||'waiting';views.status.setAttribute('aria-busy',String(busy||!!queuedIntent));
    views.status.hidden=credentials;
    views.account.hidden=!success||provider==='snowluma';views.accountName.textContent=value.account?.nickname||'QQ';views.accountId.textContent=value.account?.id||'';
    views.credentials.hidden=!credentials;views.address.label.hidden=value.needsAddress!==true;views.twoFactor.open=value.needsTotp===true||views.twoFactor.open;views.connect.disabled=busy||reading;views.connect.textContent=busy&&credentials?'验证中…':'验证并继续';views.passwordToggle.disabled=busy;
    if(success){views.password.input.value='';views.password.input.type='password';views.passwordToggle.setAttribute('aria-pressed','false');views.passwordToggle.setAttribute('aria-label','显示管理密码');views.passwordToggle.textContent='显示';views.totp.input.value='';views.recovery.input.value='';}
    const savedNapSelection=provider==='napcat'&&(requestError||value.error)==='这是已保存的 QQ，请返回选择该账号后连接';
    views.qrArea.hidden=provider!=='napcat'||success||value.needsNative===true||credentials||savedNapSelection;
    const qr=safeQr(value.qrImage);if(qr&&visible()&&!views.qrArea.hidden){if(views.qr.getAttribute('src')!==qr)views.qr.src=qr;views.qr.hidden=false;}else{views.qr.hidden=true;views.qr.removeAttribute('src');}
    views.qrPlaceholder.hidden=!!qr;views.qrHint.textContent=value.stage==='scanned'?'在手机 QQ 上确认登录，随后会自动核对账号。':value.stage==='initializing'?'登录已完成，正在核对 QQ 连接。':qr?'打开手机 QQ，扫一扫上方二维码。':value.message||'正在获取二维码，请稍候…';
    const processes=Array.isArray(value.processes)?[...value.processes]:[];views.snow.hidden=provider!=='snowluma'||value.needsNative===true||credentials;
    if(targetAccount)processes.sort((a,b)=>Number(String(b.accountId)===targetAccount)-Number(String(a.accountId)===targetAccount));
    const previous=new Map([...views.processes.children].map(el=>[el.dataset.processId,el]));
    let processIndex=0;for(const item of processes){const id=String(item.pid);if(!/^\d+$/.test(id))continue;let card=previous.get(id);if(!card){card=node('button','protocol-login-process');card.type='button';card.dataset.processId=id;card.setAttribute('role','switch');const avatar=node('span','protocol-login-avatar'),text=node('span','protocol-login-process-text'),name=node('strong'),detail=node('small','muted'),stateLabel=node('small','protocol-login-process-state'),mark=node('span','protocol-login-process-mark settings-toggle-indicator');avatar.setAttribute('aria-hidden','true');mark.append(createIcon('check',{size:17}));mark.setAttribute('aria-hidden','true');text.append(name,detail);card.append(avatar,text,stateLabel,mark);card.addEventListener('click',()=>{if(busy||card.disabled)return;void toggleProcess(id);});}
      previous.delete(id);const account=/^\d{5,10}$/.test(String(item.accountId))?accountState?.accounts.find(account=>String(account.accountId)===String(item.accountId)):null,enabled=!!account&&(account.wanted===true||account.wanted!==false&&account.status==='running');
      const working=busy&&pendingPid===id||queuedIntent?.pid===id,state=working?progress:requestError?'状态待确认':account?account.error?'连接失败':enabled?account.connected?'已连接':'等待连接':'未连接':item.selectable===false?PROCESS_STATUS[item.status]||'暂不可连接':'未连接';
      const name=item.nickname||account?.nickname||(item.accountId?`QQ ${item.accountId}`:'桌面 QQ');card.querySelector('strong').textContent=name;card.querySelector('.protocol-login-process-text>small').textContent=item.accountId||'';card.querySelector('.protocol-login-avatar').textContent=accountInitial(name,item.accountId);const stateLabel=card.querySelector('.protocol-login-process-state');stateLabel.textContent=state;stateLabel.hidden=!(working||account?.error||item.selectable===false||enabled&&!account?.connected);stateLabel.dataset.state=account?.error?'error':working?'working':'waiting';card.setAttribute('aria-label',name+(item.accountId?' · '+item.accountId:''));card.title=[`PID ${item.pid}`,account?.error||item.reason||state].filter(Boolean).join(' · ');card.dataset.target=String(String(item.accountId)===targetAccount);card.dataset.connected=String(enabled&&account?.connected===true);card.dataset.unavailable=String(!account&&item.selectable===false);card.setAttribute('aria-checked',String(enabled));card.setAttribute('aria-busy',String(working));card.disabled=!accountState||!account&&item.selectable===false;card.setAttribute('aria-disabled',String(card.disabled||busy||!!queuedIntent));card.tabIndex=0;const position=views.processes.children[processIndex++];if(position!==card)views.processes.insertBefore(card,position||null);}
    if(requestError)for(const card of views.processes.children){card.dataset.connected='false';const label=card.querySelector('.protocol-login-process-state');label.textContent='状态待确认';label.hidden=false;const item=processes.find(item=>String(item.pid)===card.dataset.processId),account=accountState?.accounts.find(account=>String(account.accountId)===String(item?.accountId));if(!account||account.wanted===false){card.disabled=true;card.setAttribute('aria-disabled','true');}}
    for(const card of previous.values())card.remove();views.empty.hidden=processes.length>0;
    views.native.hidden=value.needsNative!==true&&!requestError&&!value.error;views.native.textContent='打开 '+service;views.nativeNote.hidden=value.needsNative!==true;views.nativeNote.textContent=`先在 ${service} 完成首次确认和密码设置，再回到此处点“已完成，继续”。`;
    views.nextStep.hidden=!requestError&&!value.error;views.nextStep.textContent=savedNapSelection?'关闭此窗口，在“连接服务”中停止 NapCat，再重新添加并选择已保存的 QQ。停止会断开使用 NapCat 的账号。':credentials?'检查管理密码后重试；首次使用可先打开 '+service+'。':'可刷新重试，或打开 '+service+' 检查登录状态。';
    views.refresh.disabled=busy||reading;views.refresh.textContent=reading?'刷新中…':value.needsNative?'已完成，继续':provider==='napcat'&&value.canRefresh?'刷新二维码':'刷新状态';views.refresh.hidden=provider==='napcat'&&success||credentials||savedNapSelection;views.done.hidden=provider==='snowluma'?!connectedCount:!success;
  }
  function accept(value){if(!value||typeof value!=='object')throw Error('协议端返回了无效的接入状态');requestError='';snapshot=value;if(value.provider==='snowluma'&&Array.isArray(value.processes)&&!value.needsCredentials&&!value.needsNative)onDetected(value.processes.map(({pid,accountId,nickname,status,selectable})=>({pid,accountId,nickname,status,selectable})));render();if(doc.hidden)pause();const key=value.stage==='connected'?value.provider+':'+String(value.account?.id||''):'';if(key&&key!==connectedKey)onConnected(value);connectedKey=key;}
  async function loadAccounts(ticket){const value=await request('GET','/api/accounts');if(ticket!==revision||!dialog)return;if(!Array.isArray(value?.accounts))throw Error('无法读取账号连接状态');accountState=value;onAccounts(value);}
  async function read(){
    if(!visible())return;if(reading||busy){again=true;return;}clear();reading=true;const ticket=revision;render();views.refresh.disabled=true;views.connect.disabled=true;
    try{const query=snapshot?.sessionId?{sessionId:snapshot.sessionId}:instance.id!=='external'?{id:instance.id}:undefined;const result=await request('GET','/api/local-protocols/login',undefined,query);if(ticket!==revision||!dialog){release(result?.sessionId);return;}snapshot=result;if(result.provider==='snowluma')await loadAccounts(ticket);if(ticket!==revision||!dialog){release(result?.sessionId);return;}accept(result);}
    catch(reason){if(ticket===revision&&dialog){if(snapshot?.provider==='snowluma')try{await loadAccounts(ticket);}catch{accountState=null;}if(ticket===revision&&dialog)fail(reason);}}
    finally{if(ticket===revision&&dialog){reading=false;render();if(queuedIntent)void drainIntent();else if(again){again=false;void read();}else{schedule();void continueConnect();}}}
  }
  async function operate(operation,body={}){
    if(!visible()||busy||reading||!snapshot?.sessionId)return;clear();busy=true;requestError='';operationPhase=operation==='connect'?'验证管理密码…':operation==='inject'?'正在连接…':operation==='refresh'?'获取二维码…':'核对账号…';++revision;again=false;views.error.hidden=true;render();const ticket=revision;
    try{const result=await request('POST','/api/local-protocols/login/'+operation,{sessionId:snapshot.sessionId,...body});if(ticket!==revision||!dialog){release(result?.sessionId);return;}snapshot=result;if(result.provider==='snowluma')await loadAccounts(ticket);if(ticket!==revision||!dialog){release(result?.sessionId);return;}accept(result);if(operation==='connect'&&!result.needsCredentials&&!result.needsTotp&&result.stage!=='credentials'){views.password.input.value='';views.totp.input.value='';views.recovery.input.value='';}}
    catch(reason){if(operation==='inject')pendingActivation=null;if(ticket===revision&&dialog)fail(reason);}
    finally{if(ticket===revision&&dialog){busy=false;operationPhase='';render();if(again){again=false;void read();}else{schedule();void continueConnect();}}}
  }
  async function continueConnect(){
    if(!visible()||busy||reading||requestError||!snapshot||snapshot.needsCredentials||snapshot.needsNative)return;
    if(snapshot.provider==='napcat'&&autoConnect&&snapshot.stage==='connected'){
      if(String(snapshot.account?.id)!==targetAccount){fail(Error('NapCat 当前登录的 QQ 与所选账号不同，请先在协议端登录所选账号。'));return;}
      if(!snapshot.workspaceId){fail(Error('此账号尚未完成 QQA 连接核验，请刷新状态后重试。'));return;}
      autoConnect=false;pendingActivation={accountId:targetAccount,pid:''};
    }
    if(pendingActivation&&snapshot.stage==='connected'&&snapshot.workspaceId&&String(snapshot.account?.id)===pendingActivation.accountId){
      const target=pendingActivation;pendingActivation=null;clear();busy=true;operationPhase='核对账号…';++revision;again=false;pendingPid=target.pid;render();const ticket=revision;
      try{const result=await request('POST','/api/accounts/start',{id:snapshot.workspaceId});if(ticket!==revision||!dialog)return;if(!Array.isArray(result?.accounts))throw Error('无法读取账号连接状态');accountState=result;onAccounts(result);}
      catch(reason){if(ticket===revision&&dialog)fail(reason);}
      finally{if(ticket===revision&&dialog){busy=false;operationPhase='';pendingPid='';render();if(again){again=false;void read();}}}
      return;
    }
    if(snapshot.provider!=='snowluma'||!autoConnect||!targetAccount||!Array.isArray(snapshot.processes))return;
    const process=snapshot.processes.find(item=>String(item.accountId)===targetAccount);
    if(!process){fail(Error(`未检测到 QQ ${targetAccount}，请确认该账号已在桌面 QQ 登录`));return;}
    if(process.selectable===false){fail(Error(process.reason||'该 QQ 暂时无法连接，请检查桌面 QQ 后刷新'));return;}
    autoConnect=false;const account=accountState?.accounts.find(account=>String(account.accountId)===targetAccount);
    if(account?.wanted!==false&&account?.connected)return;
    await toggleProcess(String(process.pid),{connectOnly:true});
  }
  async function toggleProcess(pid,{connectOnly=false}={}){
    const item=snapshot?.processes?.find(item=>String(item.pid)===pid);if(!visible()||!item||!accountState||busy||queuedIntent)return;
    const account=/^\d{5,10}$/.test(String(item.accountId))?accountState.accounts.find(account=>String(account.accountId)===String(item.accountId)):null,enabled=!!account&&(account.wanted===true||account.wanted!==false&&account.status==='running');
    queuedIntent={pid,accountId:String(item.accountId),enabled:connectOnly||!enabled};requestError='';render();if(!reading)await drainIntent();
  }
  async function drainIntent(){
    const intent=queuedIntent;queuedIntent=null;if(!intent||!visible()||busy||reading)return;
    try{await applyIntent(intent);}catch(reason){if(visible())fail(reason);}
    finally{if(visible()&&!busy&&!reading){render();if(again){again=false;void read();}else{schedule();void continueConnect();}}}
  }
  async function applyIntent({pid,accountId,enabled:desired}){
    const item=snapshot?.processes?.find(item=>String(item.pid)===pid);if(!visible()||!accountState||busy||reading)return;
    if(!item||String(item.accountId)!==accountId)throw Error('此 QQ 账号已变化，请刷新后重新选择。');
    const account=accountState.accounts.find(account=>String(account.accountId)===accountId),enabled=!!account&&(account.wanted===true||account.wanted!==false&&account.status==='running');
    // The click owns a desired state, never a future toggle of a newer snapshot.
    if(desired&&requestError)throw Error('账号状态尚未确认，请先刷新后连接。');
    if(desired===enabled&&(!desired||account.connected))return;
    pendingPid=pid;
    if(desired&&(!account||!account.connected)){pendingActivation={accountId,pid};try{await operate('inject',{pid:Number(pid)});}finally{if(dialog&&!busy){pendingPid='';render();}}return;}
    clear();busy=true;operationPhase=desired?'正在连接…':'保存设置…';++revision;again=false;requestError='';render();const ticket=revision;let changed=false;
    try{if(!desired)await beforeDisconnect(account.id);if(ticket!==revision||!dialog)return;if(!desired){operationPhase='正在断开…';render();}const result=await request('POST','/api/accounts/'+(desired?'start':'stop'),{id:account.id});if(ticket!==revision||!dialog)return;if(!Array.isArray(result?.accounts))throw Error('无法读取账号连接状态');accountState=result;changed=true;onAccounts(result);render();if(!desired)await onDisconnected(account.id);}
    catch(reason){if(ticket===revision&&dialog)fail(reason);}
    finally{if(ticket===revision&&dialog){busy=false;operationPhase='';pendingPid='';render();if(changed||again){again=false;void read();}}}
  }
  async function connect(){
    if(!views)return;const password=views.password.input.value,webUiUrl=views.address.input.value.trim(),totp=views.totp.input.value.trim(),recoveryCode=views.recovery.input.value.trim();
    if(snapshot?.needsAddress&&!localAddress(webUiUrl)){fail(Error('请输入本机协议端管理地址，如 http://127.0.0.1:5099/'));views.address.input.focus();return;}
    if(!password){fail(Error('请输入协议端管理密码'));views.password.input.focus();return;}
    await operate('connect',{password,...(snapshot?.needsAddress?{webUiUrl}:{}),...(totp?{totp}:{}),...(recoveryCode?{recoveryCode}:{})});
  }
  function open(value={},options={}){
    if(disposed)return;const key=value.id||'external';if(dialog){if(instance.id===key){if(options.accountId!==undefined){const nextTarget=/^\d{5,10}$/.test(String(options.accountId))?String(options.accountId):'';if(nextTarget!==targetAccount){queuedIntent=null;pendingActivation=null;}targetAccount=nextTarget;autoConnect=!!targetAccount&&options.autoConnect===true;render();void read();}dialog.focus();return;}close();}
    instance={id:key,provider:value.provider};targetAccount=/^\d{5,10}$/.test(String(options.accountId))?String(options.accountId):'';autoConnect=!!targetAccount&&options.autoConnect===true;++revision;dialog=node('dialog','protocol-login-dialog');dialog.dataset.protocolLogin=value.provider||'detect';
    const head=node('div','settings-dialog-head'),title=node('h3','',value.provider==='napcat'?'扫码连接 QQ':value.provider==='snowluma'?'选择 QQ':'连接 QQ'),dismiss=button('',close);dismiss.setAttribute('aria-label','关闭账号接入');dismiss.append(createIcon('close',{size:18}));head.append(title,dismiss);
    const body=node('div','protocol-login-body'),stage=node('div','protocol-login-stage'),summary=node('p','protocol-login-summary',value.provider==='napcat'?'NapCat':value.provider==='snowluma'?'SnowLuma':''),status=node('p','protocol-login-status','读取中…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');stage.append(summary,status);const error=node('p','field-error protocol-login-error');error.hidden=true;error.setAttribute('role','alert');const nextStep=node('p','muted protocol-login-next-step');nextStep.hidden=true;
    const credentials=node('form','protocol-login-credentials'),credentialHint=node('p','protocol-login-credential-hint'),serviceAddress=node('p','muted protocol-login-service-address'),address=field('本机管理地址','url','off'),password=field('协议端管理密码','password','current-password','div'),passwordWrap=node('span','protocol-login-password-wrap'),passwordToggle=button('显示',async()=>{const shown=password.input.type==='password';password.input.type=shown?'text':'password';passwordToggle.textContent=shown?'隐藏':'显示';passwordToggle.setAttribute('aria-label',shown?'隐藏管理密码':'显示管理密码');passwordToggle.setAttribute('aria-pressed',String(shown));}),twoFactor=node('details','protocol-login-two-factor'),twoFactorTitle=node('summary','','两步验证'),totp=field('动态验证码','text','one-time-code'),recovery=field('恢复码','password','off');password.input.id='protocol-login-password-'+revision;password.caption.htmlFor=password.input.id;passwordToggle.setAttribute('aria-label','显示管理密码');passwordToggle.setAttribute('aria-controls',password.input.id);passwordToggle.setAttribute('aria-pressed','false');passwordWrap.append(password.input,passwordToggle);password.label.append(passwordWrap);address.input.placeholder='http://127.0.0.1:5099/';address.label.hidden=true;totp.input.inputMode='numeric';totp.input.placeholder='可选';recovery.input.placeholder='使用恢复码时填写';twoFactor.append(twoFactorTitle,totp.label,recovery.label);const connectButton=button('验证并继续',connect,'primary');connectButton.disabled=true;credentials.addEventListener('submit',event=>{event.preventDefault();});credentials.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();void connect();}});credentials.append(credentialHint,serviceAddress,address.label,password.label,twoFactor,connectButton);credentials.hidden=true;
    const qrArea=node('div','protocol-login-qr-area'),qrWrap=node('div','protocol-login-qr-wrap'),qr=node('img','protocol-login-qr'),qrPlaceholder=node('span','protocol-login-qr-placeholder'),qrHint=node('p','muted','使用手机 QQ 扫码');qr.alt='NapCat 登录二维码';qr.hidden=true;qr.referrerPolicy='no-referrer';qrPlaceholder.append(createIcon('loading',{size:36}));qrWrap.append(qrPlaceholder,qr);qrArea.append(qrWrap,qrHint);qrArea.hidden=true;
    const snow=node('div','protocol-login-snow'),processes=node('div','protocol-login-processes'),empty=node('p','muted protocol-login-empty','未找到桌面 QQ · 先打开 QQ 并登录，再刷新');empty.hidden=true;processes.setAttribute('role','group');processes.setAttribute('aria-label','QQ 连接开关');processes.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)||busy)return;const cards=[...processes.children].filter(card=>!card.disabled);if(!cards.length)return;event.preventDefault();const current=cards.indexOf(doc.activeElement),index=event.key==='Home'?0:event.key==='End'?cards.length-1:(current+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+cards.length)%cards.length;cards[index].focus();});snow.append(processes,empty);snow.hidden=true;
    const account=node('div','protocol-login-account'),accountMark=node('span','protocol-login-avatar'),accountText=node('span'),accountName=node('strong'),accountId=node('small','muted');accountMark.append(createIcon('check',{size:26}));accountText.append(accountName,accountId);account.append(accountMark,accountText);account.hidden=true;
    const nativeNote=node('p','muted protocol-login-native-note');nativeNote.hidden=true;const actions=node('div','protocol-login-actions'),native=button('打开协议端页面',async()=>{try{await openNative(snapshot?.sessionId);}catch(reason){fail(reason);}}),refresh=button('刷新状态',()=>snapshot?.provider==='napcat'&&snapshot.canRefresh?operate('refresh'):read()),done=button('完成',close,'primary');native.hidden=true;done.hidden=true;actions.append(native,refresh,done);body.append(stage,error,nextStep,credentials,qrArea,snow,account,nativeNote,actions);dialog.append(head,body);
    views={title,summary,status,error,nextStep,credentials,credentialHint,serviceAddress,address,password,passwordToggle,twoFactor,totp,recovery,connect:connectButton,qrArea,qr,qrPlaceholder,qrHint,snow,processes,empty,account,accountName,accountId,nativeNote,native,refresh,done};
    life=installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed:cleanup});doc.body.append(dialog);dialog.showModal();doc.addEventListener('visibilitychange',visibility);off=subscribe?.(name=>{if(['protocol-login','local-protocols','accounts','hello'].includes(name))queueRead();});void read();
  }
  return{open,close,get isOpen(){return !!dialog?.open;},dispose(){if(disposed)return;disposed=true;close();}};
}
