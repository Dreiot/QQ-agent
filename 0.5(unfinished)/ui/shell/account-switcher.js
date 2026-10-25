import {createIcon} from '../panels/icons.js';
import {installDisposableDialog} from '../panels/dialog-lifecycle.js';
import {currentAccountScope,normalizeAccountId} from '../panels/account-scope.js';
import {SseClient} from './sse-client.js';
import {accountNavigationUrl} from './account-navigation.js';

const labels={napcat:'NapCat',snowluma:'SnowLuma'};
const nameOf=account=>account.nickname||account.accountId||(account.id==='primary'?'主账号':'QQ 账号');
const enabledOf=account=>typeof account.wanted==='boolean'?account.wanted:account.status==='running';
const availableOf=account=>account?.id==='primary'||account?.status==='running';
const stateOf=account=>account.status==='error'?'连接失败':account.status==='starting'?'连接中…':account.status==='stopping'?'断开中…':!enabledOf(account)?'未连接':account.connected?account.paused?'已连接 · 已暂停':'已连接':account.paused?'等待连接 · 已暂停':'等待连接';

// This host-only controller always receives the unscoped control API. Selecting
// an account replaces the document only after its current editor has saved.
export function createAccountSwitcher({host,api,currentId=currentAccountScope.id,beforeSwitch=async()=>{},beforeDisconnect=beforeSwitch,getCurrentPanel=()=>null,navigate=url=>window.location.assign(url),openConnections=()=>{},onAccounts=()=>{},notify=()=>{},metadataFactory=options=>new SseClient(options),doc=document}={}){
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
  const action=(text,run,cls='')=>{const el=node('button',cls,text);el.type='button';el.addEventListener('click',()=>{void run();});return el;};
  const root=node('div','account-switcher'),caption=node('span','account-view-caption','查看'),choices=node('div','account-choice-list'),tools=node('div','account-switcher-tools'),add=action('',addAccount,'account-add'),manage=action('',()=>openManagement(),'account-manage');caption.setAttribute('aria-hidden','true');choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label','切换 QQ 账号');add.title='添加 QQ 账号';add.setAttribute('aria-label','添加 QQ 账号');add.append(createIcon('plus',{size:18}));manage.title='管理账号连接';manage.setAttribute('aria-label','账号管理');manage.append(createIcon('community',{size:18}));tools.append(manage,add);root.append(caption,choices,tools);host?.append(root);
  let accounts=[{id:currentId,status:'running'}],disposed=false,busy=false,operation=null,reading=false,again=false,readController=null,dialog=null,dialogLife=null,views=null,revision=0,metadata=null,operationError='',operationAccountId='',readError='';
  const accountCards=new Map();
  function error(message){if(views){views.error.textContent=message||'';views.error.hidden=!message;}else if(message)notify(message,'error');}
  function render(){
    if(disposed)return;const current=accounts.find(account=>account.id===currentId),shown=accounts.filter(account=>account.connected===true&&account.wanted!==false&&/^\d{5,20}$/.test(String(account.accountId||''))),present=new Set();
    const tabStop=shown.some(account=>account.id===currentId)?currentId:shown[0]?.id;
    caption.hidden=choices.hidden=shown.length===0;root.dataset.empty=String(shown.length===0);
    let cardIndex=0;for(const account of shown){
      present.add(account.id);let card=accountCards.get(account.id);
      if(!card){const button=action('',()=>switchTo(account.id),'account-choice'),dot=node('span','account-current-indicator'),identity=node('span','account-choice-identity'),name=node('strong'),number=node('small'),viewMark=node('span','account-view-mark');button.setAttribute('role','radio');button.dataset.accountId=account.id;dot.setAttribute('aria-hidden','true');viewMark.setAttribute('aria-hidden','true');viewMark.append(createIcon('panel',{size:14}));identity.append(name,number);button.append(dot,identity,viewMark);card={button,dot,name,number,viewMark};accountCards.set(account.id,card);choices.append(button);}
      if(choices.children[cardIndex]!==card.button)choices.insertBefore(card.button,choices.children[cardIndex]||null);++cardIndex;
      const selected=account.id===currentId,active=operation?.id===account.id;setText(card.name,nameOf(account));setText(card.number,account.nickname?account.accountId||'':'');card.number.hidden=!card.number.textContent;card.button.setAttribute('aria-label',[nameOf(account),account.nickname&&account.accountId,selected?'正在查看':'',stateOf(account),availableOf(account)?'':'点此连接'].filter(Boolean).join(' · '));card.button.setAttribute('aria-checked',String(selected));card.button.setAttribute('aria-busy',String(active));card.button.tabIndex=account.id===tabStop?0:-1;card.button.disabled=busy;card.button.title=[selected?'正在查看':'查看 '+nameOf(account),stateOf(account),availableOf(account)?'':'点此连接'].filter(Boolean).join(' · ');card.dot.dataset.state=active?'waiting':account.status==='error'?'error':account.connected?'connected':enabledOf(account)?'waiting':'stopped';
    }
    let lostFocus=false;for(const[id,card]of accountCards)if(!present.has(id)){lostFocus||=doc.activeElement===card.button;card.button.remove();accountCards.delete(id);}
    if(lostFocus)(accountCards.get(tabStop)?.button||add).focus({preventScroll:true});
    add.disabled=busy;manage.disabled=busy;root.title=current?stateOf(current):'当前账号不可用';root.setAttribute('aria-busy',String(busy));
    if(!views)return;const seen=new Set();
    for(const account of accounts){
      seen.add(account.id);let entry=views.rows.get(account.id);
      if(!entry){const row=node('article','account-manager-row'),dot=node('span','account-current-indicator'),identity=node('span','account-manager-identity'),name=node('strong'),detail=node('small','muted'),status=node('small','account-manager-state'),switchMark=node('span','account-connection-mark'),actions=node('div','account-manager-actions'),mark=node('small','account-manager-current','正在查看'),choose=action('查看',()=>switchTo(account.id)),connectView=action('连接并查看',()=>connectAndView(account.id),'primary account-connect-view'),retry=action('重连',()=>addAccount(entry.account)),toggle=action('',()=>operate(enabledOf(entry.account)?'stop':'start',account.id),'account-connection-card');dot.setAttribute('aria-hidden','true');switchMark.setAttribute('aria-hidden','true');switchMark.append(createIcon('check',{size:16}));toggle.setAttribute('role','switch');identity.append(name,detail,status);status.setAttribute('role','status');toggle.append(dot,identity,switchMark);actions.append(mark,choose,connectView,retry);row.dataset.accountId=account.id;row.append(toggle,actions);entry={row,dot,name,detail,status,mark,choose,connectView,retry,toggle,account};views.rows.set(account.id,entry);views.list.append(row);}
      const active=operation?.id===account.id,progress=active?operation.kind==='start'||operation.kind==='start-view'?'连接中…':operation.kind==='stop'?'断开中…':'切换中…':'';entry.account=account;entry.row.dataset.attention=String(views.targetId===account.id);entry.dot.dataset.state=active?'waiting':account.status==='error'?'error':account.connected?'connected':enabledOf(account)?'waiting':'stopped';setText(entry.name,nameOf(account));setText(entry.detail,[account.accountId,labels[account.provider]].filter(Boolean).join(' · '));entry.detail.hidden=!entry.detail.textContent;setText(entry.status,progress||stateOf(account));entry.mark.hidden=account.id!==currentId;entry.choose.hidden=account.id===currentId||!availableOf(account);entry.choose.disabled=busy;entry.choose.setAttribute('aria-label','查看 '+nameOf(account));entry.connectView.hidden=views.targetId!==account.id||availableOf(account);entry.connectView.disabled=busy;entry.connectView.setAttribute('aria-label','连接并查看 '+nameOf(account));entry.retry.hidden=!enabledOf(account)||(account.status!=='error'&&(account.connected||!availableOf(account)));entry.retry.disabled=busy;entry.retry.setAttribute('aria-label','重新连接 '+nameOf(account));entry.toggle.disabled=busy;entry.toggle.title=operationError&&operationAccountId===account.id?operationError:account.error||(enabledOf(account)?'断开':'连接')+' '+nameOf(account);entry.toggle.setAttribute('aria-checked',String(enabledOf(account)));entry.toggle.setAttribute('aria-busy',String(active));entry.toggle.setAttribute('aria-label','连接 '+nameOf(account));
    }
    for(const entry of views.rows.values())entry.toggle.dataset.state=entry.dot.dataset.state;
    for(const[id,entry]of views.rows)if(!seen.has(id)){entry.row.remove();views.rows.delete(id);}
    setText(views.count,accounts.filter(account=>account.connected).length+' / '+accounts.length+' 已连接');views.refresh.disabled=busy||reading;views.add.disabled=busy;views.close.disabled=busy;error(operationError||readError);
  }
  function accept(value){if(!Array.isArray(value?.accounts))throw Error('账号列表响应无效');root.hidden=false;accounts=value.accounts.filter(account=>account&&normalizeAccountId(account.id)).map(account=>({...account,id:normalizeAccountId(account.id)}));onAccounts(accounts);render();}
  async function refresh(){
    if(disposed)return;if(reading||busy){again=true;return;}reading=true;const ticket=revision;readController=new AbortController();
    try{const result=await api.request('GET','/api/accounts',undefined,undefined,{signal:readController.signal});if(disposed||ticket!==revision)return;readError='';accept(result);}
    catch(reason){if(!disposed&&ticket===revision){if(currentId==='primary'&&[404,501].includes(reason.status)){root.hidden=true;metadata?.close();}else{readError=reason.message||'无法读取账号列表';error(operationError||readError);}}}
    finally{if(ticket===revision){reading=false;readController=null;render();if(again){again=false;void refresh();}}}
  }
  async function switchTo(value){
    const id=normalizeAccountId(value);if(disposed||busy||!id)return;const account=accounts.find(account=>account.id===id);if(!account)return;
    if(!availableOf(account)){openManagement(id);return;}if(id===currentId)return;
    busy=true;operation={id,kind:'switch'};operationError='';operationAccountId='';readError='';error('');render();
    try{await beforeSwitch(id);if(disposed)return;await navigate(accountNavigationUrl(id,getCurrentPanel()));}
    catch(reason){if(!disposed){operationAccountId=id;operationError='未切换 · '+(reason.message||'请先保存当前设置');error(operationError);}}
    finally{if(!disposed){busy=false;operation=null;render();if(again){again=false;void refresh();}}}
  }
  async function operate(action,id){
    if(disposed||busy)return;busy=true;operation={id,kind:action};++revision;readController?.abort();readController=null;reading=false;again=false;operationError='';operationAccountId='';readError='';error('');render();
    let rollback,committed=false;
    try{if(action==='stop'&&id===currentId&&id!=='primary')rollback=await beforeDisconnect('primary');if(disposed)return;const result=await api.request('POST','/api/accounts/'+action,{id},undefined,{timeout:action==='start'?90000:30000});committed=true;if(disposed)return;if(Array.isArray(result?.accounts))accept(result);if(action==='stop'&&id===currentId&&id!=='primary'){await navigate(accountNavigationUrl('primary',getCurrentPanel()));}else if(action==='start'&&id===currentId&&id!=='primary'){/* A stopped backend cannot save its old editor; reload to acquire a new lease. */await navigate(accountNavigationUrl(id,getCurrentPanel()));}else notify(action==='start'?'账号连接已启用':'账号已断开');}
    catch(reason){if(!disposed){operationAccountId=id;operationError=reason.message||'账号状态更新失败';if(!committed&&typeof rollback==='function'){try{await rollback();}catch{operationError+=' · 页面恢复失败，请刷新重试';}}error(operationError);}}
    finally{if(!disposed){busy=false;operation=null;render();void refresh();}}
  }
  async function connectAndView(value){
    const id=normalizeAccountId(value),account=accounts.find(item=>item.id===id);if(disposed||busy||!account)return;if(availableOf(account)){await switchTo(id);return;}
    busy=true;operation={id,kind:'start-view'};++revision;readController?.abort();readController=null;reading=false;again=false;operationError='';operationAccountId='';readError='';error('');render();let ready=false;
    try{
      const result=await api.request('POST','/api/accounts/start',{id},undefined,{timeout:90000});if(disposed)return;
      const state=Array.isArray(result?.accounts)?result:await api.request('GET','/api/accounts');if(disposed)return;accept(state);
      if(!availableOf(accounts.find(item=>item.id===id)))throw Error('账号工作区尚未就绪，请稍后重试');ready=true;operation={id,kind:'switch'};render();
      // A stopped current backend cannot save its editor; starting it acquires a
      // fresh document lease, as the independent connection switch already does.
      if(id!==currentId)await beforeSwitch(id);if(disposed)return;await navigate(accountNavigationUrl(id,getCurrentPanel()));
    }catch(reason){if(!disposed){operationAccountId=id;operationError=(ready?'连接已启用，未切换 · ':'未切换 · ')+(reason.message||'账号连接失败');error(operationError);}}
    finally{if(!disposed){busy=false;operation=null;render();void refresh();}}
  }
  async function addAccount(account){
    if(disposed||busy)return;dialogLife?.close();busy=true;render();
    try{await openConnections(account);}catch(reason){if(!disposed){operationError=reason.message||'无法打开账号连接';error(operationError);}}finally{if(!disposed){busy=false;render();}}
  }
  function focusManagedAccount(id){const entry=views?.rows.get(id);if(!entry)return;entry.toggle.focus({preventScroll:true});entry.row.scrollIntoView({block:'nearest'});}
  function openManagement(targetId=''){
    if(disposed)return;if(dialog){views.targetId=targetId;render();if(targetId)focusManagedAccount(targetId);else dialog.focus();return;}
    dialog=node('dialog','account-manager-dialog');dialog.dataset.accountManager='';const head=node('div','dialog-head account-manager-head'),title=node('h2','','QQ 账号'),headActions=node('div','account-manager-head-actions'),close=action('',()=>dialogLife.close()),refreshButton=action('',refresh);close.append(createIcon('close',{size:18}));close.setAttribute('aria-label','关闭账号管理');refreshButton.append(createIcon('refresh',{size:17}));refreshButton.setAttribute('aria-label','刷新账号');refreshButton.title='刷新账号';headActions.append(refreshButton,close);head.append(title,headActions);
    const body=node('div','account-manager-body'),section=node('div','account-manager-section'),sectionTitle=node('h3','','连接'),count=node('small','muted account-manager-count'),list=node('div','account-manager-list'),message=node('p','field-error');message.setAttribute('role','alert');message.hidden=true;section.append(sectionTitle,count);
    const addNote=node('p','muted account-manager-note','设置各自保存 · 新账号先暂停回复'),actions=node('div','account-manager-footer'),add=action('添加 QQ 账号',addAccount,'primary');add.prepend(createIcon('plus',{size:16}));actions.append(addNote,add);body.append(section,list,message,actions);dialog.append(head,body);views={list,rows:new Map(),error:message,count,targetId,close,refresh:refreshButton,add};
    dialogLife=installDisposableDialog(dialog,{dismissOnBackdrop:true,canClose:()=>!busy,onClosed:()=>{dialog=null;dialogLife=null;views=null;}});doc.body.append(dialog);dialog.showModal();render();if(targetId)focusManagedAccount(targetId);void refresh();
  }
  choices.addEventListener('keydown',event=>{
    if(busy||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    const buttons=[...choices.children],index=buttons.indexOf(event.target);if(index<0||buttons.length<2)return;event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length,target=buttons[next];target.focus();void switchTo(target.dataset.accountId);
  });
  choices.addEventListener('focusin',()=>{void refresh();});
  const visibility=()=>{if(!doc.hidden)void refresh();};doc.addEventListener('visibilitychange',visibility);render();
  metadata=metadataFactory({token:api.token,base:'',endpoint:'/api/accounts/events',onEvent:name=>{if(name==='accounts')void refresh();},onState:(_state,reason)=>{if([404,501].includes(reason?.status))metadata?.close();},recoverAuth:async notice=>{if(typeof api.recoverAuth!=='function')return false;const restored=await api.recoverAuth(notice);if(restored&&metadata.token!==api.token)metadata.setToken(api.token);return restored;}});metadata.connect();void refresh();
  return Object.freeze({refresh,switchTo,openManagement,setToken:token=>metadata?.setToken(token),get currentId(){return currentId;},dispose(){if(disposed)return;disposed=true;++revision;readController?.abort();metadata?.close();doc.removeEventListener('visibilitychange',visibility);dialogLife?.dispose();root.remove();}});
}
