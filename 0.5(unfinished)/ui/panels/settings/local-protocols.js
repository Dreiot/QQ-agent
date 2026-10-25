import {createIcon} from '../icons.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createLiveRefresh} from '../live-refresh.js';
import {createAutoSave} from './auto-save.js';
import {localProtocolLoginUrl} from '../local-protocol-links.js';
import {createProtocolLogin} from './protocol-login.js';
import {createAccountConnections} from './account-connections.js';

const PROVIDERS=[{id:'napcat',title:'NapCatQQ'},{id:'snowluma',title:'SnowLuma'}];
const ACTIVE=new Set(['preparing','starting','running','stopping']);
export function createLocalProtocols({request,subscribe,openPage,beforeStart=async()=>{},beforeDisconnect=beforeStart,onConnected=()=>{},doc=document}){
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const action=(label,run,cls='')=>{const el=node('button',cls,label);el.type='button';el.addEventListener('click',()=>{void Promise.resolve().then(run).catch(reason=>showError(reason.message));});return el;};
  const root=node('section','local-protocols full');root.setAttribute('aria-label','本地协议端');root.dataset.localProtocols='';
  const serviceDetails=node('details','local-protocol-service'),serviceSummary=node('summary'),serviceLabel=node('span','','连接方式与诊断'),serviceStatus=node('small','muted','检测中…'),serviceChevron=node('span','settings-fold-chevron'),serviceBody=node('div','local-protocol-service-body');serviceChevron.setAttribute('aria-hidden','true');serviceChevron.append(createIcon('chevron',{size:14}));serviceSummary.append(serviceLabel,serviceStatus,serviceChevron);serviceDetails.append(serviceSummary,serviceBody);
  const head=node('div','local-protocol-head'),title=node('h4','','本地连接服务'),rescan=action('',()=>operate('rescan',{}));rescan.disabled=true;rescan.append(createIcon('refresh',{size:18}));rescan.setAttribute('aria-label','重新检测协议端');rescan.title='重新检测';head.append(title,rescan);
  const note=node('p','muted local-protocol-note','将官方发行版放到下方目录，ZIP 无需解压。');
  const pathRow=node('div','local-protocol-path'),path=node('input'),folderOpen=action('',openFolder);path.readOnly=true;path.setAttribute('aria-label','协议端放置位置');folderOpen.disabled=true;folderOpen.append(createIcon('folder',{size:17}));folderOpen.setAttribute('aria-label','打开协议端文件夹');folderOpen.title='打开文件夹';pathRow.append(path,folderOpen);
  const feedback=node('p','local-protocol-feedback');feedback.setAttribute('role','status');feedback.hidden=true;
  const assist=node('div','local-protocol-assist'),assistText=node('small'),assistAction=action('继续接入',()=>addAccount(),'primary');assist.hidden=true;assistText.setAttribute('role','status');assist.setAttribute('aria-label','下一步连接操作');assist.append(assistText,assistAction);
  const error=node('p','field-error local-protocol-error');error.setAttribute('role','alert');error.hidden=true;
  const state=node('div','local-protocol-state'),stateText=node('strong','','检测中…'),stateActions=node('div','actions');
  const accountLogin=action('选择 QQ',()=>addAccount(),'primary'),login=action('打开协议端页面',()=>open('local-protocol-login',snapshot?.running?.id)),stop=action('停止共享协议端',confirmStop,'local-protocol-stop'),output=action('启动输出',showOutput),stopHint=node('small','muted local-protocol-stop-hint','停止服务会断开全部关联账号。单个账号请用上方卡片。');accountLogin.hidden=login.hidden=stop.hidden=output.hidden=stopHint.hidden=true;stateActions.append(accountLogin,login,output,stop);state.append(stateText,stateActions);
  const list=node('div','local-protocol-providers'),providerViews=new Map(),items=new Map();
  for(const provider of PROVIDERS){
    const card=node('article','local-protocol-provider'),header=node('div','local-protocol-provider-head'),heading=node('strong','',provider.title),download=action('官方发行版',()=>open(provider.id+'-releases'));card.hidden=true;download.title=provider.title+' · GitHub Releases';header.append(heading,download);
    const body=node('div','local-protocol-items'),empty=node('p','muted','尚未检测到可运行包');card.dataset.provider=provider.id;card.append(header,body,empty);
    if(provider.id==='snowluma')card.append(node('p','muted local-protocol-note','先登录桌面 QQ；首次接入需完成 SnowLuma 的确认与密码设置。'));
    list.append(card);providerViews.set(provider.id,{card,body,empty});
  }
  // Match the existing card's DOM immediately, including before its document
  // enhancer observes this asynchronously mounted section.
  const autoLabel=node('label','local-protocol-auto settings-toggle-card'),autoTitle=node('span','field-title','启动时恢复连接'),auto=node('input'),autoMark=node('span','settings-toggle-indicator');auto.type='checkbox';auto.disabled=true;auto.setAttribute('aria-label','随QQ-Agent启动');autoMark.setAttribute('aria-hidden','true');autoMark.append(createIcon('check',{size:14}),createIcon('warning',{size:14}));autoLabel.dataset.checked='false';autoLabel.dataset.disabled='true';autoLabel.append(autoTitle,auto,autoMark);
  const startup=node('div','local-protocol-startup'),startupHint=node('small','muted','所有账号共用，仅恢复已勾选的账号。');startup.append(autoLabel,startupHint);serviceBody.append(head,note,pathRow,state,stopHint,list);root.append(feedback,error,startup,serviceDetails);
  let snapshot=null,disposed=false,busy=false,folderOpening=false,revision=0,readPending=false,mounted=false,desiredAuto=false,operationError='',readError='',choiceDialog=null,choiceLife=null,choiceMethods=null,choiceSetup=null,stopDialog=null,stopLife=null,dialog=null,dialogLife=null,outputRead=0,outputVersion=null,outputText=null,outputStatus=null,outputRefresh=null;
  const connections=createAccountConnections({request,subscribe,beforeDisconnect,connectNew:connectAccount,reconnect:account=>connectAccount(account,true),addAccount,onChange:()=>render(),doc});connections.mount(root);root.prepend(root.lastElementChild);root.insertBefore(assist,startup);
  const protocolLogin=createProtocolLogin({request,subscribe,beforeDisconnect,onAccounts:value=>connections.accept(value),onDetected:value=>connections.setDetected(value),openNative:id=>openPage('protocol-login-native',id),onConnected:()=>{connections.refresh();onConnected();live.request();},doc});
  const autoSave=createAutoSave({root,delay:350,save:async()=>{const value=desiredAuto;const result=await request('POST','/api/local-protocols/settings',{autoStart:value});if(!disposed){accept(result);showError('');}},onError:reason=>showError(reason.message)});
  auto.addEventListener('change',()=>{desiredAuto=auto.checked;autoLabel.dataset.checked=String(auto.checked);autoSave.schedule();});
  function showError(message){if(disposed)return;operationError=message||'';renderError();if(choiceDialog){let notice=choiceDialog.querySelector('.local-protocol-choice-error');if(!notice){notice=node('p','field-error local-protocol-choice-error');notice.setAttribute('role','alert');choiceDialog.append(notice);}notice.textContent=operationError;notice.hidden=!operationError;}}
  function renderError(){error.textContent=operationError||readError||(!busy?snapshot?.running?.error:'')||'';error.hidden=!error.textContent;}
  function message(text,state=''){if(disposed)return;feedback.textContent=text;feedback.hidden=!text;feedback.dataset.state=state;if(choiceSetup)choiceSetup.feedback.textContent=text;}
  const startMessage=item=>item?.archive?'正在准备连接服务… 首次使用 ZIP 需要解压。':'正在启动连接服务…';
  async function openFolder(){
    if(disposed||folderOpening||!snapshot?.root)return;folderOpening=true;showError('');render();
    try{await request('POST','/api/local-protocols/open-folder',{});}catch{showError('无法打开文件夹，请手动打开上方路径。');}
    finally{if(!disposed){folderOpening=false;render();}}
  }
  async function open(target,id){try{await openPage(target,id);}catch(reason){showError(reason.message);}}
  const currentActive=()=>snapshot?.running&&ACTIVE.has(snapshot.running.status);
  function accept(value){if(disposed||!value||!Array.isArray(value.providers))return; snapshot=value;connections.setPackages(value);render();}
  function render(){
    if(disposed)return;const running=snapshot?.running,active=currentActive();
    path.value=String(snapshot?.root||'');path.title=path.value;folderOpen.disabled=!path.value||folderOpening;rescan.disabled=busy||!snapshot;auto.disabled=busy||!snapshot;
    if(!autoSave.dirty){desiredAuto=snapshot?.settings?.autoStart===true;auto.checked=desiredAuto;}
    autoLabel.dataset.checked=String(auto.checked);autoLabel.dataset.disabled=String(auto.disabled);
    const title=PROVIDERS.find(provider=>provider.id===running?.provider)?.title||'';
    const pending=connections.accounts.some(account=>account.workspace&&(account.wanted===true||account.wanted===undefined&&account.status==='running')&&!account.connected);
    assist.hidden=!snapshot||!connections.loaded||busy||!pending||['preparing','starting','stopping'].includes(running?.status);
    assistText.textContent=active?'连接服务已启动，等待 QQ 接入':'连接服务尚未启动';assistAction.textContent=active?'继续接入':'连接 QQ';assist.dataset.state=active?'ready':'waiting';
    const names={preparing:'准备中…',starting:'启动中…',running:'运行中',stopping:'停止中…',error:'启动失败',stopped:'已停止'};
    const runtimePresent=!!running&&(active||snapshot?.providers.some(provider=>provider.items.some(item=>item.id===running.id)));
    state.hidden=serviceStatus.hidden=!runtimePresent;
    stateText.textContent=!snapshot?'检测中…':running?`${title} · ${names[running.status]||running.status||'尚未启动'}`:'尚未启动';state.dataset.state=running?.status||'idle';
    serviceStatus.textContent=!snapshot?'检测中…':running?`${title} · ${names[running.status]||'尚未启动'}`:'未启动';serviceSummary.dataset.state=running?.status||'idle';stopHint.hidden=!active;
    stop.hidden=!active;stop.disabled=busy||['preparing','stopping'].includes(running?.status);output.hidden=!runtimePresent;output.disabled=busy&&!running;
    accountLogin.hidden=!['starting','running'].includes(running?.status)||!PROVIDERS.some(provider=>provider.id===running?.provider);accountLogin.disabled=busy;
    login.hidden=!['starting','running'].includes(running?.status)||!localProtocolLoginUrl(running?.webUiUrl);login.disabled=busy;
    renderError();
    const seen=new Set();
    for(const provider of PROVIDERS){
      const view=providerViews.get(provider.id),found=snapshot?.providers.find(value=>value.id===provider.id)?.items||[];view.empty.hidden=found.length>0;view.card.hidden=found.length===0;
      for(const item of found){
        const key=provider.id+':'+item.id;seen.add(key);let entry=items.get(key);
        if(!entry){
          const card=node('div','local-protocol-item'),details=node('div','local-protocol-item-details'),name=node('strong'),description=node('small','muted'),reason=node('small','field-error'),start=action('启动并连接',()=>startItem(key),'primary');
          details.append(name,description,reason);card.append(details,start);entry={card,name,description,reason,start,item};items.set(key,entry);view.body.append(card);
        }
        entry.item=item;entry.name.textContent=item.name;entry.card.title=item.location||'';
        entry.description.textContent=[item.archive?'ZIP · 启动时解压':'已解压',item.variant].filter(Boolean).join(' · ');
        entry.reason.textContent=item.ready?'':String(item.reason||'此包暂不可运行；请使用官方发行版，源码 ZIP 无法直接启动。');entry.reason.hidden=item.ready===true;
        const choices=[...new Set((item.accounts||[]).filter(value=>/^\d+$/.test(String(value))).map(String))];
        const thisRunning=active&&running.id===item.id;entry.start.textContent=thisRunning?'运行中':'启动并连接';entry.start.hidden=false;entry.start.disabled=busy||!!active||item.ready!==true;
      }
    }
    for(const [key,entry] of items)if(!seen.has(key)){entry.card.remove();items.delete(key);}
    const providerCount=(snapshot?.providers||[]).filter(provider=>provider.items.length).length;list.hidden=providerCount===0;list.dataset.count=String(providerCount);
    if(choiceMethods)for(const [provider,view]of choiceMethods){const ready=!!readyItem(provider);view.textContent=ready?'已准备好':'首次使用需下载';view.dataset.ready=String(ready);}
    if(choiceSetup){
      const found=snapshot?.providers.find(row=>row.id===choiceSetup.provider)?.items||[],item=readyItem(choiceSetup.provider),invalid=!item&&found[0];
      choiceSetup.status.textContent=item?'已识别，可以连接':invalid?'这个文件暂时无法使用':'等待发行包';choiceSetup.detection.dataset.state=item?'ready':invalid?'error':'waiting';
      choiceSetup.file.textContent=item?.name||invalid?.name||'';choiceSetup.file.hidden=!choiceSetup.file.textContent;
      choiceSetup.reason.textContent=invalid?String(invalid.reason||'请使用官方完整发行版，源码 ZIP 无法直接启动。'):'';choiceSetup.reason.hidden=!choiceSetup.reason.textContent;
      choiceSetup.next.hidden=!item;choiceSetup.next.disabled=busy||!!active;choiceSetup.refresh.disabled=busy;choiceSetup.path.value=String(snapshot?.root||'');
      choiceSetup.path.title=choiceSetup.path.value;choiceSetup.recovery.hidden=!!item;choiceSetup.helpSummary.hidden=!item;
      choiceSetup.folder.disabled=!choiceSetup.path.value||folderOpening;
      if(choiceSetup.ready!==!!item){const focusInside=choiceSetup.help.contains(doc.activeElement)||choiceSetup.recovery.contains(doc.activeElement);choiceSetup.help.open=!item;choiceSetup.ready=!!item;if(item&&focusInside&&choiceDialog.open)choiceSetup.next.focus();}
    }
    if(dialog&&outputStatus&&outputVersion!==running?.outputVersion){outputStatus.textContent='有新输出 · 点击刷新查看';}
  }
  async function startItem(key){const entry=items.get(key);if(!entry||entry.start.disabled)return;await startAndChoose(entry.item);}
  async function startAndChoose(item,accountId='',otherAccount=false){
    const provider=item.provider||snapshot?.providers.find(row=>row.items.some(value=>value.id===item.id))?.id,accounts=[...new Set((item.accounts||[]).map(String).filter(value=>/^\d{5,20}$/.test(value)))];
    if(provider==='napcat'&&!accountId&&!otherAccount&&accounts.length){
      if(choiceDialog){choiceDialog.focus();return;}
      choiceDialog=node('dialog','local-protocol-choice');choiceDialog.dataset.protocolChoice='napcat-accounts';const heading=node('h3','','选择登录的 QQ'),choices=node('div','local-protocol-saved-accounts');
      for(const id of accounts){const account=connections.getAccount(id),option=action('',async()=>{choiceLife.close();await startAndChoose(item,id);},'local-protocol-saved-account'),identity=node('span'),name=node('strong','',account?.nickname||'QQ '+id),detail=node('small','muted',account?.nickname?id:'已保存的账号');identity.append(name,detail);option.append(createIcon('community',{size:24}),identity,createIcon('chevron',{size:16}));choices.append(option);}
      const other=action('其他 QQ 扫码',async()=>{choiceLife.close();await startAndChoose(item,'',true);},'local-protocol-existing');choiceDialog.append(heading,choices,other);choiceLife=installDisposableDialog(choiceDialog,{dismissOnBackdrop:true,onClosed:()=>{choiceDialog=null;choiceLife=null;}});doc.body.append(choiceDialog);choiceDialog.showModal();return;
    }
    const started=await operate('start',{id:item.id,...(accountId?{account:accountId}:{}),deferConnection:true});
    if(started&&!disposed)protocolLogin.open(snapshot.running,accountId?{accountId,autoConnect:true}:{});
  }
  async function openExisting(accountId=''){await autoSave.flush();await beforeStart();if(!disposed){choiceLife?.close();protocolLogin.open(undefined,accountId?{accountId,autoConnect:true}:{});}}
  async function addAccount(accountId){
    if(disposed||busy)return;if(!snapshot)await read();if(!snapshot||disposed)return;
    const target=typeof accountId==='string'?connections.getAccount(accountId):null;
    if(target)return connectAccount(target,true);
    if(currentActive()){await autoSave.flush();await beforeStart();if(!disposed)protocolLogin.open(snapshot.running);return;}
    if(choiceDialog){choiceDialog.focus();return;}
    choiceDialog=node('dialog','local-protocol-choice');choiceDialog.dataset.protocolChoice='';choiceMethods=new Map();const heading=node('h3','','连接 QQ'),choices=node('div','local-protocol-choices');
    for(const provider of [{id:'snowluma',title:'Snowluma',detail:'选择已登录的账号',icon:'community'},{id:'napcat',title:'Napcat',detail:'用手机 QQ 扫码',icon:'qrcode'}]){
      const option=action('',async()=>{const item=readyItem(provider.id);choiceLife.close();if(item)await startAndChoose(item);else showSetup(provider);}),icon=node('span','local-protocol-method-icon'),text=node('span','local-protocol-method-text'),label=node('strong','',provider.title),detail=node('small','muted',provider.detail),availability=node('small','local-protocol-method-availability'),arrow=node('span','local-protocol-method-arrow');
      icon.setAttribute('aria-hidden','true');arrow.setAttribute('aria-hidden','true');icon.append(createIcon(provider.icon,{size:26}));arrow.append(createIcon('chevron',{size:14}));option.append(icon,text,arrow);text.append(label,detail,availability);choices.append(option);choiceMethods.set(provider.id,availability);
    }
    const existing=action('连接已运行的协议端',openExisting,'local-protocol-existing');choiceDialog.append(heading,choices,existing);choiceLife=installDisposableDialog(choiceDialog,{dismissOnBackdrop:true,onClosed:()=>{choiceDialog=null;choiceLife=null;choiceMethods=null;}});doc.body.append(choiceDialog);render();choiceDialog.showModal();
  }
  const readyItem=provider=>snapshot?.providers.find(row=>row.id===provider)?.items.find(row=>row.ready);
  function showSetup(provider,accountId=''){
    if(disposed||choiceDialog)return;
    const title=PROVIDERS.find(row=>row.id===provider.id)?.title||provider.id;
    choiceDialog=node('dialog','local-protocol-choice local-protocol-setup');choiceDialog.dataset.protocolChoice='setup';const heading=node('h3','','准备'+provider.title),steps=node('ol','local-protocol-setup-steps'),downloadRow=node('li'),download=action('下载 '+title,()=>open(provider.id+'-releases')),downloadHint=node('small','muted'),placeRow=node('li'),placeLabel=node('span','','放入这个目录'),pathRow=node('div','local-protocol-path'),setupPath=node('input'),folder=action('打开文件夹',openFolder),placeHint=node('small','muted','ZIP 无需解压，放入后会自动识别。'),copyFeedback=node('small','local-protocol-setup-copy-feedback'),detection=node('div','local-protocol-setup-detection'),status=node('p','local-protocol-setup-status'),file=node('strong','local-protocol-setup-file'),reason=node('p','field-error local-protocol-setup-reason'),recovery=node('div','local-protocol-setup-recovery'),refreshHint=node('small','muted','未识别？'),refresh=action('重新检测',()=>operate('rescan',{})),next=action('继续连接',async()=>{const item=readyItem(provider.id);if(!item||busy)return;choiceLife.close();await startAndChoose(item,accountId);},'primary'),back=action('其他方式',async()=>{choiceLife.close();await addAccount();},'local-protocol-existing');
    downloadHint.textContent=provider.id==='napcat'?'选择带 Node 的完整包；Windows 使用 NapCat.Shell.Windows.Node.zip。':'选择当前系统的完整包，勿选 Lite 或 Source code。';
    const help=node('details','local-protocol-setup-help'),helpSummary=node('summary','','下载与放置');help.append(helpSummary,steps);
    setupPath.readOnly=true;setupPath.setAttribute('aria-label','发行包放置目录');folder.setAttribute('aria-label','打开协议端文件夹');copyFeedback.setAttribute('role','status');status.setAttribute('role','status');reason.setAttribute('role','alert');downloadRow.append(download,downloadHint);pathRow.append(setupPath,folder);placeRow.append(placeLabel,pathRow,placeHint,copyFeedback);steps.append(downloadRow,placeRow);detection.append(status,file,reason);recovery.append(refreshHint,refresh);choiceSetup={provider:provider.id,accountId,detection,status,file,reason,next,refresh,path:setupPath,feedback:copyFeedback,help,helpSummary,recovery,folder};choiceDialog.append(heading,help,detection,next,recovery,back);
    if(accountId)choiceDialog.append(action('使用已运行的服务',()=>openExisting(accountId),'local-protocol-existing'));
    choiceLife=installDisposableDialog(choiceDialog,{dismissOnBackdrop:true,onClosed:()=>{choiceDialog=null;choiceLife=null;choiceSetup=null;}});doc.body.append(choiceDialog);render();choiceDialog.showModal();
  }
  function confirmStop(){
    if(disposed||busy||!currentActive())return;if(stopDialog){stopDialog.focus();return;}
    const target=snapshot.running.id;stopDialog=node('dialog','local-protocol-choice local-protocol-stop-confirm');stopDialog.dataset.protocolStop='';const heading=node('h3','','停止连接服务？'),notice=node('p','','使用此服务的所有账号都会断开，账号开关保持原样。'),actions=node('div','actions'),cancel=action('取消',()=>stopLife.close()),confirm=action('停止服务',async()=>{stopLife.close();if(!disposed&&snapshot?.running?.id===target&&currentActive())await operate('stop',{});},'danger');actions.append(cancel,confirm);stopDialog.append(heading,notice,actions);stopLife=installDisposableDialog(stopDialog,{dismissOnBackdrop:true,onClosed:()=>{stopDialog=null;stopLife=null;}});doc.body.append(stopDialog);stopDialog.showModal();cancel.focus();
  }
  async function connectAccount(account,reconnect=false){
    if(disposed||busy)throw Error('正在更新协议端，请稍候。');busy=true;++revision;showError('');render();
    let preparing=false;try{
    await autoSave.flush();await beforeStart();if(disposed)return;
    const active=currentActive(),provider=account.provider||snapshot?.running?.provider;
    if(active&&snapshot.running.provider!==provider)throw Error('此账号使用其他协议端，请先停止当前协议端。');
    if(!active){
      const choices=snapshot?.providers.find(row=>row.id===provider)?.items||[],item=choices.find(row=>row.id===account.itemId&&row.ready)||choices.find(row=>row.ready);
      if(!item){if(PROVIDERS.some(row=>row.id===provider)){showSetup({id:provider,title:provider==='snowluma'?'Snowluma':'Napcat'},account.accountId);return;}if(account.workspace){connections.accept(await request('POST','/api/accounts/start',{id:account.id}));return;}throw Error('请先放入此账号使用的协议端发行包。');}
      preparing=true;message(startMessage(item),'working');const started=await request('POST','/api/local-protocols/start',{id:item.id,account:account.accountId,deferConnection:true});if(disposed)return;accept(started);
      protocolLogin.open(snapshot.running,{accountId:account.accountId,autoConnect:true});return;
    }
    if(account.workspace&&!reconnect){connections.accept(await request('POST','/api/accounts/start',{id:account.id}));return;}
    protocolLogin.open(snapshot.running,{accountId:account.accountId,autoConnect:true});
    }finally{if(!disposed){if(preparing)message('');busy=false;render();if(readPending){readPending=false;live.request();}}}
  }
  async function read(){
    if(disposed)return;if(busy){readPending=true;return;}const ticket=revision;
    try{const result=await request('GET','/api/local-protocols');if(!disposed&&ticket===revision){readError='';renderError();accept(result);}}
    catch(reason){if(ticket===revision&&!disposed){readError=reason.message;renderError();if(!snapshot)stateText.textContent='未能读取协议端状态';}}
  }
  const live=createLiveRefresh(read,{doc});
  const off=subscribe((name)=>{if(name==='local-protocols'||name==='hello')live.request();});
  async function operate(operation,body){
    if(disposed||busy)return;busy=true;++revision;showError('');message(operation==='start'?startMessage(snapshot?.providers.flatMap(row=>row.items).find(item=>item.id===body.id)):'',operation==='start'?'working':'');render();
    try{if(operation==='start'){await autoSave.flush();await beforeStart();}const result=await request('POST','/api/local-protocols/'+operation,body);if(disposed)return;accept(result);return result;}
    catch(reason){showError(reason.message);}
    finally{if(!disposed){if(operation==='start')message('');busy=false;render();if(readPending){readPending=false;live.request();}}}
  }
  async function refreshOutput(){
    if(!dialog||disposed)return;const ticket=++outputRead;outputRefresh.disabled=true;outputStatus.textContent='读取中…';
    try{const result=await request('GET','/api/local-protocols/output');if(disposed||!dialog||ticket!==outputRead)return;outputText.textContent=result?.text||'暂无启动输出';outputVersion=snapshot?.running?.outputVersion;outputStatus.textContent='';}
    catch(reason){if(!disposed&&dialog&&ticket===outputRead)outputStatus.textContent=reason.message;}
    finally{if(!disposed&&dialog&&ticket===outputRead)outputRefresh.disabled=false;}
  }
  function showOutput(){
    if(disposed)return;if(dialog){dialog.focus();return;}
    dialog=node('dialog','local-protocol-output');dialog.dataset.localProtocolOutput='';const head=node('div','settings-dialog-head'),heading=node('h3','','协议端启动输出'),close=action('',()=>dialogLife.close());close.append(createIcon('close',{size:18}));close.setAttribute('aria-label','关闭启动输出');head.append(heading,close);
    outputText=node('pre','pre');outputStatus=node('p','muted');outputStatus.setAttribute('role','status');outputRefresh=action('刷新输出',refreshOutput);dialog.append(head,outputText,outputStatus,outputRefresh);
    dialogLife=installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed:()=>{++outputRead;dialog=null;dialogLife=null;outputText=null;outputStatus=null;outputRefresh=null;}});doc.body.append(dialog);dialog.showModal();void refreshOutput();
  }
  return{mount(host){if(disposed)return;host.append(root);if(!mounted){mounted=true;void read();}},openLogin:addAccount,openExisting,get outputOpen(){return !!dialog?.open||!!choiceDialog?.open||!!stopDialog?.open||protocolLogin.isOpen;},dispose(){if(disposed)return;disposed=true;++revision;++outputRead;live.dispose();off?.();autoSave.dispose();protocolLogin.dispose();connections.dispose();choiceLife?.close();stopLife?.close();dialogLife?.close();root.remove();}};
}
