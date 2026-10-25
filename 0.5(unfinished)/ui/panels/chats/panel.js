import {request,onShellEvent,onLeave,getViewState,onViewStateSnapshot,contentReady} from '/panels/panel-client.js';
import {createSelectionState} from '../selection-state.js';
import {installListLayout} from '../list-layout.js';
import {createMessageSweep} from './message-sweep.js';
import {$,clear,row,selectableRow,button,destructiveButton,bindDestructiveAction} from '../ui.js';
import {createQuoteMode} from './quote-mode.js';
import {createChatHistory,captureMessageAnchor,restoreMessageAnchor} from './history.js';
import {createMessageView} from './message-view.js';
import {createLiveRefresh} from '../live-refresh.js';

installListLayout(document.querySelector('section.grid'));
const list=$('#list'),detail=$('#detail');
// Reading surfaces own their lifecycle; selection must not replay a full-pane
// entrance. Explicit folds and destructive effects remain independent.
detail.dataset.motion='off';
const putText=(node,value)=>{value=String(value??'');if(node.textContent!==value)node.textContent=value;};
let current=null,rendered=null,listVersion=0,whitelistVersion=0,items=[],messages=[],hasMore=false,selectionMode=false,sweep=null,pendingRestore=null,selectionPending=false;
let shell=null,deleteSelectionAction=null,deleteSelectionKey='';
const expandedForwards=new Map(),chatRows=new Map(),messageViews=new Map(),readingStates=new Map();
const navigation=createSelectionState({read:()=>getViewState('navigation'),register:provider=>onViewStateSnapshot('navigation',provider),getId:()=>current,
  validId:id=>typeof id==='string'&&/^(?:group|private)_\d{1,20}$/.test(id),restore:id=>id?show(id,{restored:true}):undefined});
onLeave(()=>navigation.dispose());
const quote=createQuoteMode({preview:$('#quote-preview'),status:$('#quote-status'),getMessages:()=>messages,selectionActive:()=>selectionMode,onPreviewChange:()=>deleteSelectionAction?.refresh(),onModeChange:()=>{
  sweep?.reset();selectionMode=false;
  for(const check of detail.querySelectorAll('.messages input[type=checkbox]')){check.checked=false;check.hidden=!quote.active;}
  for(const control of detail.querySelectorAll('.delete-selection'))control.disabled=quote.active;
  updateSelection();
}});
sweep=createMessageSweep({root:detail,enabled:()=>current===rendered&&(selectionMode||quote.active),changed:updateSelection});
const history=createChatHistory({request:async(key,query)=>{const version=whitelistVersion,result=await request('GET',`/api/chats/${encodeURIComponent(key)}/messages`,undefined,{...query,scope:'allowlist'});if(version!==whitelistVersion)throw new DOMException('聊天白名单已变化','AbortError');return result;},onChange:commitHistory,onError:historyError});
let eventAll=false;const eventKeys=new Set();

function renderList(){
  const query=$('#search').value.toLowerCase(),unread=$('#unread-only').checked;
  const shown=items.filter(c=>(!unread||c.unread>0)&&`${c.chatName} ${c.key} ${c.lastText}`.toLowerCase().includes(query));
  putText($('#meta'),`${shown.length}/${items.length} 个聊天`);
  const live=new Set(items.map(chat=>chat.key||chat.chatKey?.replace(':','_'))),next=[];
  for(const [key,entry] of chatRows)if(!live.has(key)){entry.item.remove();chatRows.delete(key);readingStates.delete(key);}
  for(const chat of shown){
    const key=chat.key||chat.chatKey?.replace(':','_');let entry=chatRows.get(key);
    if(!entry){
      entry={chat,item:null};
      const item=row('','',[
        button('标读',async()=>{await request('POST',`/api/chats/${key}/mark-read`);await load();if(current===key)await show(key,{refresh:true});}),
        button('忽略当前未读',async()=>{await request('POST',`/api/chats/${key}/mute`);await load();if(current===key)await show(key,{refresh:true});}),
        destructiveButton('清空',async()=>{await request('POST',`/api/chats/${key}/clear`);if(current===key)await show(key,{refresh:true});await load();},{clicks:4,target:()=>[entry.item,...(current===key&&rendered===key?[detail]:[])],key:()=>key,canActivate:()=>items.some(chat=>(chat.key||chat.chatKey?.replace(':','_'))===key),impact:()=>`清空 ${entry.chat.chatName||key} 的全部聊天存档（当前 ${entry.chat.total??0} 条）。`}),
      ]);
      entry.item=item;entry.title=item.querySelector('strong');entry.summary=item.querySelector('.muted');item.dataset.chat=key;
      entry.open=selectableRow(item,()=>void show(key));item.addEventListener('click',event=>{if(!event.target.closest('button'))void show(key);});chatRows.set(key,entry);
    }
    entry.chat=chat;putText(entry.title,chat.chatName||key);putText(entry.summary,`${chat.total??0} 条 · ${chat.lastText||''}`);
    entry.item.classList.toggle('selected',key===current);entry.open.setAttribute('aria-current',String(key===current));next.push(entry.item);
  }
  const empty=list.querySelector('.empty');if(!shown.length&&empty)next.push(empty);
  for(const node of [...list.children])if(!next.includes(node))node.remove();
  next.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);});
  if(!shown.length&&!list.querySelector('.empty')){const empty=document.createElement('div');empty.className='empty';empty.textContent='没有匹配的聊天';list.append(empty);}
  if(shell&&current===rendered)putText(shell.title,chatRows.get(current)?.chat.chatName||current);
}
async function load(){
  const version=++listVersion;
  try{const data=await request('GET','/api/chats',undefined,{scope:'allowlist'});if(version!==listVersion)return;items=data.chats||[];if(current&&!items.some(chat=>(chat.key||chat.chatKey?.replace(':','_'))===current)){
    history.reset();sweep.reset();quote.exit();deleteSelectionAction?.dispose();deleteSelectionAction=null;current=rendered=null;messages=[];hasMore=false;selectionMode=false;pendingRestore=null;selectionPending=false;messageViews.clear();readingStates.clear();expandedForwards.clear();shell=null;detail.inert=false;detail.removeAttribute('aria-busy');putText(detail,'此聊天不在聊天白名单中');
  }renderList();await navigation.accept(items.map(chat=>chat.key||chat.chatKey?.replace(':','_')),{isCurrent:()=>version===listVersion});if(version===listVersion)void contentReady();}
  catch(reason){if(version===listVersion){let notice=list.querySelector('.refresh-error');if(!notice){notice=document.createElement('p');notice.className='error refresh-error';list.append(notice);}putText(notice,reason.message);void contentReady();}}
}
function selectedIds(){return [...detail.querySelectorAll('.messages input[type=checkbox]:checked')].map(x=>Number(x.value));}
function selectionKey(){return `${current||''}:${quote.active?'quote':'delete'}:${selectedIds().sort((a,b)=>a-b).join(',')}`;}
function updateSelection(){
  const key=selectionKey();if(key!==deleteSelectionKey){deleteSelectionKey=key;deleteSelectionAction?.reset({preserveCommittedLayout:true});}
  deleteSelectionAction?.refresh();shell?.host.classList.toggle('is-selecting',selectionMode||quote.active);
  quote.setSelected(selectedIds());
  if(shell){const selecting=selectionMode||quote.active,pressed=String(selecting);putText(shell.select,selecting?'取消选择':'选择消息');if(shell.select.getAttribute('aria-pressed')!==pressed)shell.select.setAttribute('aria-pressed',pressed);if(shell.remove.hidden===selecting)shell.remove.hidden=!selecting;if(shell.hint.hidden===selecting)shell.hint.hidden=!selecting;putText(shell.hint,`${quote.active?'金句':''}已选 ${selectedIds().length} 条`);}
}
function rememberReading(){
  if(!shell||current!==rendered)return;
  const anchor=captureMessageAnchor(shell.host),bounds=shell.host.getBoundingClientRect();
  const folds=[...shell.host.querySelectorAll('.message')].map(node=>({id:node.dataset.message,details:[...node.querySelectorAll(':scope > details')].map(fold=>({open:fold.open,scroll:fold.querySelector('pre')?.scrollTop||0}))}));
  readingStates.delete(current);
  readingStates.set(current,{floor:messages.length?Number(messages[0].id):null,anchor:anchor&&{...anchor,top:anchor.top-bounds.top},detailScroll:detail.scrollTop,checked:new Set(selectedIds().map(String)),selectionMode,quote:quote.active,draft:shell.input.value,folds});
  // Cache only reading state for eight recent chats, never message payloads or
  // host storage. Authoritative reads restore even a previously loaded prefix.
  while(readingStates.size>8){const oldest=readingStates.keys().next().value;readingStates.delete(oldest);for(const key of expandedForwards.keys())if(key.startsWith(oldest+':'))expandedForwards.delete(key);}
}
function ensureDetail(){
  if(shell)return;
  clear(detail);
  const head=document.createElement('div');head.className='row';const title=document.createElement('h3'),refresh=button('刷新',async()=>{await load();if(current)await show(current,{refresh:true});});refresh.id='chat-refresh';head.append(title,refresh);
  const tools=document.createElement('div');tools.className='toolbar archive-toolbar';
  const actions=document.createElement('div'),sendTools=document.createElement('div');actions.className='archive-actions';sendTools.className='archive-test-send';
  const input=document.createElement('input');input.id='test-send-text';input.placeholder='输入测试消息';input.maxLength=4000;
  const hint=document.createElement('small');hint.className='selection-count';hint.hidden=true;
  const removeSelected=document.createElement('button');removeSelected.type='button';removeSelected.textContent='删除选中消息';removeSelected.className='danger';removeSelected.hidden=true;
  deleteSelectionAction=bindDestructiveAction(removeSelected,{clicks:2,key:selectionKey,canActivate:()=>current===rendered&&selectionMode&&!quote.active&&!quote.previewing&&selectedIds().length>0,
    target:()=>[...detail.querySelectorAll('.messages input[type=checkbox]:checked')].map(check=>check.closest('.message')),
    impact:()=>`从此聊天存档中删除选中的 ${selectedIds().length} 条消息。`,action:async()=>{
      const key=rendered,ids=selectedIds();await request('POST',`/api/chats/${key}/delete-messages`,{ids});
      if(current===key){messages=messages.filter(m=>!ids.includes(m.id));await show(key,{refresh:true});}
    }});
  sendTools.append(input,button('测试发送',async()=>{
    if(current!==rendered)return;const key=current,draft=input.value;if(!draft.trim())return;
    await request('POST',`/api/chats/${key}/test-send`,{text:draft.trim()});
    if(current===key&&rendered===key){if(input.value===draft)input.value='';await show(key,{refresh:true});}
    else if(readingStates.get(key)?.draft===draft)readingStates.get(key).draft='';
  },'primary'));
  const select=button('选择消息',()=>{
    if(quote.active){quote.exit();return;}
    sweep.reset();selectionMode=!selectionMode;for(const check of detail.querySelectorAll('.messages input[type=checkbox]')){if(!selectionMode)check.checked=false;check.hidden=!selectionMode;}updateSelection();
  });
  select.className='selection-toggle';select.setAttribute('aria-pressed','false');removeSelected.classList.add('delete-selection');
  const preview=$('#quote-preview');preview.textContent='上传金句';actions.append(select,preview,removeSelected,hint);tools.append(actions,sendTools);
  const older=button('加载更早消息',()=>show(current,{older:true}));older.className='load-older';
  const host=document.createElement('div');host.className='messages';
  host.addEventListener('scroll',()=>{if(current===rendered&&host.scrollTop<=80&&hasMore&&!history.loading)void show(current,{older:true});});
  detail.append(head,tools,older,host);shell={title,input,hint,host,older,select,remove:removeSelected};
}
function renderMessages(restoreChecked){
  quote.updateMessages(messages);
  const host=shell.host,checked=restoreChecked||(quote.active?quote.selected:new Set(selectedIds().map(String))),live=new Set(messages.map(m=>String(m.id))),next=[];
  for(const [id,view]of messageViews)if(!live.has(id)){view.node.remove();messageViews.delete(id);expandedForwards.delete(`${current}:${id}`);}
  for(const message of messages){
    const id=String(message.id);let view=messageViews.get(id);
    if(!view){view=createMessageView({key:current,request,onSelection:updateSelection,expandedForwards});messageViews.set(id,view);}
    view.update(message,{checked:checked.has(id),selecting:selectionMode||quote.active});next.push(view.node);
  }
  const empty=host.querySelector('.empty');if(!messages.length&&empty)next.push(empty);
  for(const node of [...host.children])if(!next.includes(node))node.remove();
  next.forEach((node,index)=>{if(host.children[index]!==node)host.insertBefore(node,host.children[index]||null);});
  if(!messages.length&&!host.querySelector('.empty')){const empty=document.createElement('div');empty.className='empty';empty.textContent='暂无消息';host.append(empty);}
  if(shell.older.hidden===hasMore)shell.older.hidden=!hasMore;updateSelection();
}
function commitHistory({key,messages:next,hasMore:nextHasMore}){
  if(current!==key)return;
  const switched=rendered!==key,restoring=selectionPending,state=restoring?pendingRestore:null,anchor=restoring?null:captureMessageAnchor(shell?.host),scroll=detail.scrollTop;
  detail.querySelector('.refresh-error')?.remove();ensureDetail();
  if(switched)messageViews.clear();
  if(restoring){selectionMode=Boolean(state?.selectionMode);shell.input.value=state?.draft||'';if(state?.quote)quote.enter();}
  messages=next;hasMore=nextHasMore;rendered=key;detail.inert=false;detail.setAttribute('aria-busy','false');
  putText(shell.title,chatRows.get(key)?.chat.chatName||key);renderMessages(restoring?state?.checked||new Set():undefined);
  if(restoring&&state){
    for(const record of state.folds){const node=messageViews.get(record.id)?.node;if(node)[...node.querySelectorAll(':scope > details')].forEach((fold,index)=>{const saved=record.details[index];if(saved){fold.open=saved.open;const pre=fold.querySelector('pre');if(pre)pre.scrollTop=saved.scroll;}});}
    if(state.anchor)restoreMessageAnchor(shell.host,{...state.anchor,top:state.anchor.top+shell.host.getBoundingClientRect().top});
    detail.scrollTop=state.detailScroll;
  }else{if(anchor)restoreMessageAnchor(shell.host,anchor);else shell.host.scrollTop=shell.host.scrollHeight;detail.scrollTop=scroll;}
  pendingRestore=null;selectionPending=false;renderList();
}
function historyError(reason,{key}){
  if(current!==key)return;
  let notice=detail.querySelector('.refresh-error');if(!notice){notice=document.createElement('p');notice.className='error refresh-error';detail.append(notice);}putText(notice,reason.message);
  // Failed switches keep the old surface inert; a late action cannot address
  // the wrong chat. Another list selection can retry.
  detail.setAttribute('aria-busy','false');
}
function show(key,{refresh=false,older=false,restored=false}={}){
  if(!key||!items.some(chat=>(chat.key||chat.chatKey?.replace(':','_'))===key)||(refresh||older)&&current!==key)return;
  const changed=current!==key;
  if(!refresh&&!older&&!restored)navigation.touch();
  if(changed){
    rememberReading();sweep.reset();deleteSelectionAction?.reset();quote.exit();current=key;
    pendingRestore=readingStates.get(key)||null;selectionPending=true;detail.inert=true;detail.setAttribute('aria-busy','true');renderList();
    return history.select(key,{floor:pendingRestore?.floor});
  }
  if(!refresh&&!older&&rendered===key)return;
  return older?history.older():history.refresh();
}
$('#search').addEventListener('input',renderList);$('#unread-only').addEventListener('change',renderList);
onShellEvent((name,payload)=>{
  if(name!=='hello'&&name!=='chat-update'&&!(name==='status'&&payload?.configUpdated))return;
  if(name==='status'&&payload?.configUpdated){++whitelistVersion;++listVersion;}
  const normalized=typeof payload==='string'?payload.replace(':','_'):payload?.chatKey?.replace(':','_');
  if(name==='hello'||name==='status'||!payload||payload==='*'||eventKeys.size>=256){eventAll=true;eventKeys.clear();}else if(normalized&&!eventAll)eventKeys.add(normalized);
  recovery.request();
});
const recovery=createLiveRefresh(async()=>{const key=current,refreshCurrent=eventAll||eventKeys.has(current)||!eventKeys.size;eventAll=false;eventKeys.clear();await load();if(current&&current===key&&refreshCurrent)await show(current,{refresh:true});});
function dispose(){recovery.dispose();history.dispose();sweep.dispose();deleteSelectionAction?.dispose();readingStates.clear();expandedForwards.clear();}
onLeave(dispose);window.addEventListener('pagehide',dispose,{once:true});void load();
