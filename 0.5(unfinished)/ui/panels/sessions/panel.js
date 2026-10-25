import {request,onShellEvent,onLeave,getViewState,onViewStateSnapshot,contentReady} from '/panels/panel-client.js';
import {createSelectionState} from '../selection-state.js';
import {installListLayout} from '../list-layout.js';
import {createSessionEvents} from './session-events.js';
import {formatSessionChat} from './chat-title.js';
import {installSessionActivity,formatWaitDeadline} from './session-activity.js';
import {createSessionDetailScrollPolicy} from './scroll-policy.js';
import {applySessionDelta} from './stream-state.js';
import * as sessionTrace from './trace-view.js';
import {sessionCacheRate,formatCacheRate,cacheTone} from './metrics.js';
installListLayout(document.querySelector('section.grid'));
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {$,clear,text,row,selectableRow,button,destructiveButton,bindDestructiveAction,error,dateTime,confirmAction} from '../ui.js';
const {renderSessionTrace}=sessionTrace;
// Existing replacement views only need their original renderer. The incremental
// renderer is an optional optimization; every streamed snapshot can use either.
const renderStreamingStep=typeof sessionTrace.renderStreamingStep==='function'?sessionTrace.renderStreamingStep:renderSessionTrace;
const list=$('#list'),detail=$('#detail'),labels={waiting:'等待中',running:'运行中',done:'已回复',noreply:'未回复',error:'失败',aborted:'已中止'};
let selected=null,rendered=null,listVersion=0,detailVersion=0,items=[],shown=100,initialized=false,activity=null,leaving=false;
const detailReads=new Map();
let currentDetail=null;const pendingDeltas=[];let pendingBytes=0;
function streamEvent(payload){
  if(payload?.id!==selected)return;
  if(detailReads.has(selected)){pendingDeltas.push(payload);pendingBytes+=(payload.delta?.content?.length||0)+(payload.delta?.reasoning?.length||0);if(pendingDeltas.length>128||pendingBytes>1048576){pendingDeltas.length=0;pendingBytes=0;detailReads.get(selected).again=true;}}
  const result=applySessionDelta(currentDetail,payload);
  if(result==='gap'){eventReads.push(selected);return;}
  if(result!=='applied')return;
  const scroll=detailScroll.capture(detail,{id:selected,renderedId:rendered,status:currentDetail.status});
  renderStreamingStep(detail.querySelector('.session-body'),currentDetail,{waiting,delta:payload.delta});
  const raw=detail.querySelector('.raw-json');if(raw&&!raw.hidden)setText(raw,JSON.stringify(currentDetail,null,2));
  detailScroll.restore(detail,scroll,{isCurrent:()=>!leaving&&selected===currentDetail?.id});
}
const sessionRows=new Map();
const setText=(node,value)=>{const next=String(value??'');if(node.textContent!==next)node.textContent=next;};
const setHidden=(node,value)=>{if(node.hidden!==value)node.hidden=value;};
const emptyList=Object.assign(document.createElement('div'),{className:'empty',textContent:'没有匹配的会话'});
// Session details own their live updates; do not replay the generic whole-view
// entrance whenever a response lands shortly after selecting a list row.
detail.dataset.motion='off';
const detailScroll=createSessionDetailScrollPolicy();
const navigation=createSelectionState({read:()=>getViewState('navigation'),register:provider=>onViewStateSnapshot('navigation',provider),getId:()=>selected,
  validId:id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id),getFollow:()=>$('#follow').checked,
  restore:async(id,options)=>{if(typeof options.follow==='boolean')$('#follow').checked=options.follow;if(id){await show(id,{restored:true});renderList();}}});
onLeave(()=>navigation.dispose());
function followPending(){const pending=items.find(session=>['waiting','running'].includes(session.status));if($('#follow').checked&&pending&&pending.id!==selected)void show(pending.id);}
function waiting(session){const node=document.createElement('small');node.className='wait-countdown';node.dataset.wait=String(session.waitUntil);node.textContent=formatWaitDeadline(session.waitUntil);return node;}
function selectRows(){for(const [id,entry]of sessionRows){if(entry.item.classList.contains('selected')!==(id===selected))entry.item.classList.toggle('selected',id===selected);entry.open.setAttribute('aria-current',String(id===selected));}}
function sessionRow(id){
  const item=row('',''),actions=document.createElement('div');actions.className='actions session-row-actions';actions.hidden=true;item.dataset.session=id;
  const title=item.querySelector('strong'),summary=item.querySelector('.muted'),heading=document.createElement('div'),titleText=document.createElement('span'),status=document.createElement('span'),chatName=document.createElement('span'),info=document.createElement('span'),cache=document.createElement('span'),metrics=document.createElement('span');
  heading.className='session-row-title';titleText.className='session-title-text';status.className='session-state-label';chatName.className='session-chat-name';cache.className='session-cache cache-rate';
  metrics.className='session-row-metrics';cache.title='缓存命中率';metrics.append(status,cache);
  title.replaceWith(heading);heading.append(actions,titleText);titleText.append(title,chatName);summary.replaceChildren(info,document.createTextNode(' · '),metrics);
  const open=selectableRow(item,()=>{$('#follow').checked=false;void show(id);selectRows();});
  const entry={item,title,titleText,summary,status,chatName,info,cache,actions,open,retry:null,abort:null,wait:null,phase:null};
  item.addEventListener('click',event=>{if(!event.target.closest('button')){$('#follow').checked=false;void show(id);selectRows();}});
  sessionRows.set(id,entry);return entry;
}
function renderList(){
  const query=$('#search').value.trim().toLowerCase(),status=$('#status-filter').value,chat=$('#chat-filter').value;
  const filtered=items.filter(s=>(!status||s.status===status)&&(!chat||s.chatKey===chat)&&`${s.id} ${s.chatKey} ${s.trigger||''} ${s.error||''}`.toLowerCase().includes(query));setText($('#meta'),`${filtered.length} 条匹配 · 共 ${items.length} 条会话`);
  const context=$('#list-context');setHidden(context,!chat);setText(context,chat?formatSessionChat(items.find(s=>s.chatKey===chat&&s.chatName)||{chatKey:chat}):'');
  const next=[],live=new Set(filtered.slice(0,shown).map(session=>session.id));
  for(const [id,entry]of sessionRows)if(!live.has(id)){entry.item.remove();sessionRows.delete(id);}
  for(const session of filtered.slice(0,shown)){
    const entry=sessionRows.get(session.id)||sessionRow(session.id),item=entry.item;
    for(const [key,label,suffix,visible]of [['retry','重试','retry',session.status==='error'&&!session.sent?.length],['abort','中止','abort',['waiting','running'].includes(session.status)]]){
      if(visible){entry[key]??=button(label,async()=>{await request('POST',`/api/sessions/${encodeURIComponent(session.id)}/${suffix}`);await load();if(suffix==='abort'&&items.some(s=>s.id===session.id)){$('#follow').checked=false;await show(session.id,{refresh:selected===session.id});}});if(entry[key].parentNode!==entry.actions)entry.actions.append(entry[key]);}
      else entry[key]?.remove();
    }
    setHidden(entry.actions,!entry.actions.children.length);
    let title=String(session.trigger||'会话');
    if(chat&&session.chatName){const suffix=` · ${session.chatName}`;if(title.endsWith(suffix))title=title.slice(0,-suffix.length);}
    setText(entry.status,labels[session.status]||session.status);setText(entry.title,title);
    const name=!chat&&session.chatName&&!title.endsWith(session.chatName)?` · ${session.chatName}`:'';setText(entry.chatName,name);setHidden(entry.chatName,!name);
    if(entry.titleText.title!==title+name)entry.titleText.title=title+name;
    setText(entry.info,`${dateTime(session.startedAt)} · ${session.usage?.totalTokens||0} tokens · ${session.rounds||0} 轮${session.webSearchCount?` · 搜索 ${session.webSearchCount} 次`:``}`);
    const rate=formatCacheRate(session.usage),rateLabel=`缓存命中率 ${rate}`;setText(entry.cache,rate);if(entry.cache.getAttribute('aria-label')!==rateLabel)entry.cache.setAttribute('aria-label',rateLabel);const tone=cacheTone(sessionCacheRate(session.usage));if(entry.cache.dataset.tone!==tone)entry.cache.dataset.tone=tone;
    if(item.dataset.status!==session.status)item.dataset.status=session.status;
    if(session.status==='waiting'&&session.waitUntil){entry.wait??=waiting(session);if(entry.wait.dataset.wait!==String(session.waitUntil))entry.wait.dataset.wait=String(session.waitUntil);if(entry.wait.parentNode!==item)item.append(entry.wait);}else{entry.wait?.remove();entry.wait=null;}
    if(session.status==='running'&&session.activity){entry.phase??=Object.assign(document.createElement('small'),{className:'session-activity'});setText(entry.phase,session.activity);if(entry.phase.parentNode!==item)item.append(entry.phase);}else{entry.phase?.remove();entry.phase=null;}
    next.push(item);
  }
  if(!filtered.length)next.push(emptyList);
  const desiredNodes=new Set(next);for(const node of [...list.children])if(!desiredNodes.has(node))node.remove();next.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);});
  selectRows();setHidden($('#more'),filtered.length<=shown);activity?.sync();
}
async function load({followCurrent=false}={}){
  const version=++listVersion,selectionRevision=detailVersion;
  try{
    const data=await request('GET','/api/sessions',undefined,{limit:1048576});if(version!==listVersion)return;
    // Background model work remains in usage accounting, not the conversation
    // stream. Old persisted discard markers are internal control events too.
    items=(data.sessions||[]).filter(s=>!s.background&&!['deleted','discarded'].includes(s.status)).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));const value=$('#chat-filter').value;
    const chatTitles=new Map();for(const session of items)if(session.chatKey&&(!chatTitles.has(session.chatKey)||session.chatName))chatTitles.set(session.chatKey,formatSessionChat(session));
    const filter=$('#chat-filter'),options=new Map([...filter.options].map(option=>[option.value,option]));for(const option of options.values())if(option.value&&!chatTitles.has(option.value))option.remove();
    for(const [key,title]of chatTitles){const option=options.get(key);if(option)setText(option,title);else filter.append(new Option(title,key));}
    filter.value=value;renderList();
    await navigation.accept(items.map(item=>item.id),{isCurrent:()=>!leaving&&version===listVersion});if(leaving||version!==listVersion)return;
    // SSE is intentionally withheld until the iframe handshake. Recover any
    // pending run created during that window from the first accepted snapshot.
    // A newer SSE/manual selection always wins over this request's older intent.
    if((!initialized&&!selected)||(followCurrent&&detailVersion===selectionRevision))followPending();
    initialized=true;$('#follow').disabled=false;$('#sessions-panel').dataset.ready='true';$('#sessions-panel').setAttribute('aria-busy','false');void contentReady();return true;
  }catch(e){if(!leaving&&version===listVersion){error(list,e.message);if(!initialized){text($('#meta'),'会话加载失败，请刷新重试');$('#sessions-panel').setAttribute('aria-busy','false');}void contentReady();}}
}
function renderTrace(data){
  const id=String(data.id??selected);if(detail.dataset.sessionId!==id)detail.dataset.sessionId=id;
  const title=detail.querySelector('h3');if(title)setText(title,formatSessionChat(data));
  renderSessionTrace(detail.querySelector('.session-body'),data,{waiting});const raw=detail.querySelector('.raw-json');if(!raw.hidden)setText(raw,JSON.stringify(data,null,2));
}
async function show(id,{refresh=false,restored=false}={}){
  if(leaving||refresh&&selected!==id)return;
  if(!refresh&&!restored)navigation.touch();
  if(!refresh&&selected===id&&rendered===id&&detail.querySelector('.session-body'))return;
  if(refresh&&detailReads.has(id)){detailReads.get(id).again=true;return;}
  if(selected!==id){currentDetail=null;pendingDeltas.length=0;pendingBytes=0;}selected=id;selectRows();const version=++detailVersion,read={again:false};detailReads.set(id,read);try{const data=await request('GET',`/api/sessions/${encodeURIComponent(id)}`);if(leaving||selected!==id||version!==detailVersion)return;const scroll=detailScroll.capture(detail,{id,renderedId:detail.querySelector('.session-body')?rendered:null,status:data.status});
    if(rendered!==id||!detail.querySelector('.session-body')){clear(detail);const head=document.createElement('div');head.className='row';const title=document.createElement('h3');title.textContent=formatSessionChat(data);const label=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.id='json-mode';label.append(toggle,document.createTextNode(' 原始 JSON'));const body=document.createElement('div');body.className='session-body';const pre=document.createElement('pre');pre.className='pre raw-json';pre.hidden=true;toggle.addEventListener('change',()=>{body.hidden=toggle.checked;pre.hidden=!toggle.checked;if(toggle.checked&&currentDetail)setText(pre,JSON.stringify(currentDetail,null,2));});head.append(title,label,destructiveButton('删除',async()=>{await request('DELETE',`/api/sessions/${encodeURIComponent(id)}`);if(selected===id){navigation.touch();selected=rendered=null;++detailVersion;text(detail,'已删除');}await load();},{clicks:2,target:()=>selected===id?[detail]:[],key:()=>id,canActivate:()=>selected===id,impact:'删除此会话的流水记录、提示词、调用详情与发送记录。'}));detail.append(head,body,pre);rendered=id;}
    currentDetail=data;let gap=false;for(const event of pendingDeltas)if(applySessionDelta(data,event)==='gap')gap=true;pendingDeltas.length=0;pendingBytes=0;if(gap)read.again=true;
    renderTrace(data);detailScroll.restore(detail,scroll,{isCurrent:()=>!leaving&&selected===id&&version===detailVersion});
  }catch(e){if(!leaving&&selected===id&&version===detailVersion){rendered=null;error(detail,e.message);}}
  finally{if(detailReads.get(id)===read){detailReads.delete(id);if(read.again&&!leaving&&selected===id)void show(id,{refresh:true});}}
}
async function reconcile(){
  if(leaving)return;const id=selected,version=detailVersion;await load();
  if(!leaving&&id&&selected===id&&version===detailVersion)await show(id,{refresh:true});
}
async function broadcast(){
  const results=await Promise.allSettled([request('GET','/api/onebot/groups'),request('GET','/api/onebot/friends')]),targets=[];for(const [i,result] of results.entries()){if(result.status!=='fulfilled')continue;for(const item of result.value[i?'friends':'groups']||[]){const id=String(i?item.user_id??item.id:item.group_id??item.id);if(/^\d+$/.test(id))targets.push({key:`${i?'private':'group'}_${id}`,name:item.name||item.group_name||item.remark||item.nickname||id});}}if(!targets.length)throw new Error('未获取到可发送的群或好友');
  const dialog=document.createElement('dialog'),heading=document.createElement('h3');heading.textContent='群发测试消息';const input=document.createElement('textarea');input.placeholder='输入要发送的消息';input.maxLength=4000;const choices=document.createElement('div');choices.className='list';for(const target of targets){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=target.key;label.append(check,document.createTextNode(`${target.name} · ${target.key}`));choices.append(label);}const feedback=document.createElement('p');feedback.className='muted';dialog.append(heading,input,choices,feedback,button('发送到选中目标',async()=>{const keys=[...choices.querySelectorAll('input:checked')].map(n=>n.value);if(!input.value.trim()||!keys.length){feedback.textContent='请填写消息并选择目标';return;}if(!await confirmAction(`确认向 ${keys.length} 个目标发送消息？`))return;const failures=[];let sent=0;for(const key of keys){try{await request('POST',`/api/chats/${key}/test-send`,{text:input.value.trim()});sent++;}catch(e){failures.push(`${key}：${e.message}`);}}feedback.textContent=`已发送 ${sent}/${keys.length}${failures.length?` · ${failures.join('；')}`:''}`;}),button('关闭',()=>dialog.close()));installDisposableDialog(dialog);document.body.append(dialog);dialog.showModal();
}
$('#reload').addEventListener('click',()=>{void load();if(selected)void show(selected,{refresh:true});});bindDestructiveAction($('#clear'),{clicks:4,target:()=>[list,detail],impact:'删除所有已结束会话的流水记录与调用详情，保留等待中、运行中的会话。',action:async()=>{const id=selected,deletesCurrent=id&&items.some(session=>session.id===id&&!['waiting','running'].includes(session.status));await request('POST','/api/sessions/clear-finished');if(deletesCurrent&&selected===id){navigation.touch();selected=rendered=null;++detailVersion;text(detail,'请选择会话');}await load();}});$('#broadcast').addEventListener('click',()=>broadcast().catch(e=>error(detail,e.message)));
for(const selector of ['#search','#status-filter','#chat-filter'])$(selector).addEventListener(selector==='#search'?'input':'change',()=>{shown=100;renderList();});$('#more').addEventListener('click',()=>{shown+=200;renderList();});
$('#follow').addEventListener('change',()=>{navigation.touch();if($('#follow').checked){followPending();void load({followCurrent:true});}});
const eventReads=createSessionEvents({run:async({ids,follow,followId})=>{
  if(leaving)return;const id=selected,version=detailVersion;const accepted=await load();if(leaving||!accepted)return;
  if(follow&&$('#follow').checked){const pending=items.find(s=>s.id===followId&&['waiting','running'].includes(s.status))||items.find(s=>['waiting','running'].includes(s.status));if(pending&&pending.id!==selected){void show(pending.id);return;}}
  if(id&&selected===id&&version===detailVersion&&(ids.has('*')||ids.has(id)))void show(id,{refresh:true});
}});
onShellEvent((name,payload)=>{if(name==='session-delta'){streamEvent(payload);return;}if(name==='hello'){activity?.heartbeat?.(true);return;}if(!name.startsWith('session-'))return;const id=payload?.sessionId??payload?.id;if(['done','noreply','error','aborted','deleted','discarded'].includes(payload?.status)){++listVersion;if(!id||id===selected)++detailVersion;}if(id===selected&&['deleted','discarded'].includes(payload?.status)){navigation.touch();selected=rendered=null;++detailVersion;text(detail,'会话已移除');}eventReads.push(id,{follow:!!id&&['waiting','running'].includes(payload?.status)});});onLeave(()=>eventReads.dispose());void load();
activity=installSessionActivity({list,detail,getSessions:()=>items,refresh:reconcile});onLeave(()=>{leaving=true;activity.dispose();});
