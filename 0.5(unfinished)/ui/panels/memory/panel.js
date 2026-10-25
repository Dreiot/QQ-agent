import {createLiveRefresh} from '../live-refresh.js';
import {request,onShellEvent,onLeave,getViewState,onViewStateSnapshot,contentReady} from '/panels/panel-client.js';
import {installListLayout} from '../list-layout.js';
import {createActiveTaskTicker} from '../active-task-ticker.js';
import {collapsibleExpanded} from '../collapsible.js';
installListLayout(document.querySelector('section.grid'));
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {$,clear,text,row,selectableRow,button,destructiveButton,error,formDialog} from '../ui.js';
const list=$('#list'),detail=$('#detail');
let current=null,rendered=null,listVersion=0,detailVersion=0,taskVersion=0,ticker=null;const tasks=new Map();
const fileRows=new Map(),memberCards=new Map(),memberFolds=new Map();
let chatNames=new Map(),namesVersion=0,disposed=false,navigationReady=false;
const chatKey=value=>typeof value==='string'&&/^(?:group|private):\d{1,15}$/.test(value);
function forgetChatFolds(key){for(const foldKey of memberFolds.keys())if(foldKey.startsWith(key+'\0'))memberFolds.delete(foldKey);}
function navigationSnapshot(){
  if(!navigationReady)throw new Error('视图状态尚未就绪');
  rememberMemberFolds();
  return{schema:1,currentChatKey:chatKey(current)?current:null,folds:[...memberFolds].slice(-128).map(([key,expanded])=>{const [chat,uid]=key.split('\0');return[chat,uid,expanded];})};
}
onViewStateSnapshot('navigation',navigationSnapshot);
async function initializeNavigation(){
  const snapshot=await getViewState('navigation');if(disposed)return;
  const files=await load();if(disposed||!Array.isArray(files))return;
  const live=new Set(files.map(file=>file.chatKey));
  if(snapshot?.schema===1&&Array.isArray(snapshot.folds)){
    for(const fold of snapshot.folds.slice(-128))if(Array.isArray(fold)&&fold.length===3&&chatKey(fold[0])&&live.has(fold[0])&&typeof fold[1]==='string'&&/^\d{1,15}$/.test(fold[1])&&typeof fold[2]==='boolean')memberFolds.set(`${fold[0]}\0${fold[1]}`,fold[2]);
  }
  navigationReady=true;
  if(snapshot?.schema===1&&chatKey(snapshot.currentChatKey)&&live.has(snapshot.currentChatKey)&&current===null)await show(snapshot.currentChatKey);
}
function impressionText(item){return typeof item==='string'?item:String(item?.content??'');}
function memoryUpdatedAt(value){const ts=Number(value),date=new Date(ts);return Number.isFinite(ts)&&ts>0&&Number.isFinite(date.getTime())?`更新于 ${date.toLocaleString('zh-CN',{hour12:false})}`:'暂无更新';}
function chatTitle(key){return chatNames.get(key)||key;}
function syncChatTitles(){
  for(const [key,entry] of fileRows){entry.title.textContent=chatTitle(key);entry.title.title=key;}
  const title=detail.querySelector('.memory-chat-title');if(title&&rendered){title.textContent=`${chatTitle(rendered)} · 成员印象`;title.title=rendered;}
}
async function loadChatNames(){
  const version=++namesVersion;
  try{const data=await request('GET','/api/chats',undefined,{scope:'allowlist'});if(version!==namesVersion)return;chatNames=new Map((data.chats||[]).map(chat=>[String(chat.chatKey||chat.key||'').replace(/^(group|private)_(\d+)$/,'$1:$2'),String(chat.chatName||'').trim()]));syncChatTitles();}
  catch{/* Names are optional: a failed lookup retains the last successful titles. */}
}
function syncSelection(){for(const [key,entry] of fileRows){entry.item.classList.toggle('selected',current===key);entry.open.setAttribute('aria-current',String(current===key));}}
function rememberMemberFolds(){if(rendered)for(const [uid,entry] of memberCards)memberFolds.set(`${rendered}\0${uid}`,collapsibleExpanded(entry.fold));}
async function saveMemberNote(uid,note,expected){
  try{return await request('PUT',`/api/member-notes/${encodeURIComponent(uid)}`,{note:note.trim(),expected});}
  catch(error){if((error.data?.httpStatus??error.status)===409)error.message+='；输入已保留，请关闭后重新打开备注，核对最新值再保存。';throw error;}
}
async function verifyConfirmedNote(uid,expected){
  const current=await request('GET',`/api/member-notes/${encodeURIComponent(uid)}`);
  if(current.note!==expected)throw new Error('备注已被其他操作更新；输入已保留，请关闭后重新打开，核对最新值再保存。');
}
function editorSnapshot(value,uid){
  if(!value||typeof value.note!=='string'||!/^[a-f0-9]{64}$/.test(value.memberVersion??'')||value.member!==null&&(!value.member||String(value.member.userId)!==uid))throw new Error('成员编辑原值响应异常，请重新打开后再保存。');
  return value;
}
async function editMember(key,member=null){
  const uid=String(member?.userId||''),pathFor=id=>`/api/memory-files/${key.replace(':','_')}/members/${encodeURIComponent(id)}`;
  const [cfg,opened]=await Promise.all([request('GET','/api/config'),uid?request('GET',pathFor(uid)).then(value=>editorSnapshot(value,uid)):null]);
  const notesAtOpen={...(cfg.memberNotes||{})},confirmedNotes=new Map(),manualStates=new Map();
  if(opened){notesAtOpen[uid]=opened.note;manualStates.set(uid,{expected:{memberVersion:opened.memberVersion,note:opened.note},savedMemberDraft:null});}
  const shown=opened?.member??member;
  const originalNote=id=>typeof notesAtOpen[id]==='string'?notesAtOpen[id].trim():'';
  return formDialog(member?'编辑成员印象':'新增成员印象',[
    {key:'userId',label:'QQ 号',value:uid,required:true,readOnly:!!member,pattern:'[0-9]{1,15}'},
    {key:'name',label:member?'名字':'名字（手工填写时使用）',value:shown?.name||'',maxLength:60},
    {key:'note',label:'备注名',value:originalNote(uid),maxLength:300},
    ...(!member?[{key:'mode',label:'新增方式',type:'select',value:'manual',options:[{value:'manual',label:'手工填写印象'},{value:'create',label:'提炼最近发言'}]}]:[]),
    {key:'impressions',label:'印象（一行一条，最多20条；留空清除印象）',type:'textarea',value:(shown?.impressions||[]).map(impressionText).join('\n')},
  ],async values=>{
    if(!/^\d{1,15}$/.test(values.userId))throw new Error('请输入有效 QQ 号');
    const impressions=values.impressions.split('\n').map(s=>s.trim()).filter(Boolean);
    if(impressions.length>20||impressions.some(s=>s.length>300))throw new Error('最多20条印象，每条不超过300字');
    const note=values.note.trim(),original=originalNote(values.userId);
    if(values.mode==='create'){
      const expected=confirmedNotes.get(values.userId)??original;
      if(note&&note!==expected){
        const saved=await saveMemberNote(values.userId,note,expected);
        // An accepted note is independent of a later failed task submission.
        // Only our own successful receipt advances this dialog's baseline.
        confirmedNotes.set(values.userId,saved.note);
      }else if(confirmedNotes.has(values.userId)){
        // A retry does not repeat the note write. A fresh read only compares
        // with our receipt; it must never silently adopt another writer's note.
        await verifyConfirmedNote(values.userId,expected);
      }
      await startConsolidate(key,[values.userId],true);
    }else{
      let state=manualStates.get(values.userId);
      if(!state){
        const current=editorSnapshot(await request('GET',pathFor(values.userId)),values.userId);
        if(current.member)throw new Error('该成员已有印象；输入已保留，请关闭后使用该成员的“编辑印象”。');
        state={expected:{memberVersion:current.memberVersion,note:original},savedMemberDraft:null};manualStates.set(values.userId,state);
      }
      const draft={name:values.name.trim(),impressions},signature=JSON.stringify(draft);
      const parts=[...(state.savedMemberDraft===signature?[]:['member']),...(note!==state.expected.note?['note']:[])];
      const body={expected:{...state.expected},parts,...(parts.includes('member')?draft:{}),...(parts.includes('note')?{note}:{})};
      let saved;
      try{saved=await request('PUT',pathFor(values.userId),body);}
      catch(reason){
        const conflict=(reason.data?.httpStatus??reason.status)===409;
        if(state.savedMemberDraft!==null)reason.message=`上次成员印象已保存；${reason.message}`;
        if(conflict)reason.message+='；输入已保留，请重新打开核对最新内容后保存。';
        throw reason;
      }
      if(typeof saved?.ok!=='boolean'||!saved.steps)throw new Error('保存回执异常；输入已保留，请重新打开核对已保存内容。');
      if(saved.steps.member?.state==='saved'){
        const receipt=saved.steps.member;
        if(!/^[a-f0-9]{64}$/.test(receipt.memberVersion??'')||String(receipt.member?.userId)!==values.userId)throw new Error('印象保存回执异常；输入已保留，请重新打开核对已保存内容。');
        state.expected.memberVersion=receipt.memberVersion;state.savedMemberDraft=signature;
      }
      if(parts.includes('note')&&['saved','unchanged'].includes(saved.steps.note?.state)){
        if(typeof saved.steps.note.note!=='string')throw new Error('备注保存回执异常；输入已保留，请重新打开核对已保存内容。');
        state.expected.note=saved.steps.note.note;
      }
      // 207 is a successful HTTP transport response, not a complete save.
      // Keep this form and its receipt baseline until every requested part saves.
      if(!saved.ok||saved.partial)throw new Error(saved.error||'部分内容尚未保存；输入已保留，再次保存仅重试未保存部分。');
      if(parts.some(part=>!['saved','unchanged'].includes(saved.steps[part]?.state)))throw new Error('保存回执不完整；输入已保留，请重新打开核对已保存内容。');
    }
    await show(key,{refresh:true});await load();
  });
}
async function editNote(uid,name='',onSaved=null){
  const {note:expected}=await request('GET',`/api/member-notes/${encodeURIComponent(uid)}`);return formDialog(`备注 · ${name||uid}`,[{key:'note',label:'备注名（留空删除）',value:expected,maxLength:300}],async value=>{const saved=await saveMemberNote(uid,value.note,expected);onSaved?.(saved.note);if(current)await show(current,{refresh:true});});
}
async function groupMembers(key){
  const [data,cfg]=await Promise.all([request('GET',`/api/groups/${key.split(':').pop()}/members`),request('GET','/api/config')]);
  const notes={...(cfg.memberNotes||{})},dialog=document.createElement('dialog'),title=document.createElement('h3'),filter=document.createElement('input'),membersList=document.createElement('div');
  dialog.className='group-members-dialog';membersList.className='group-members-list';title.textContent='群成员';filter.type='search';filter.placeholder='搜索备注、昵称、群名片或 QQ 号';filter.setAttribute('aria-label','搜索群成员');
  const render=()=>{
    clear(membersList);
    for(const member of data.members||[]){
      const uid=String(member.userId??member.user_id??member.id??''),nickname=String(member.nickname||member.name||''),card=String(member.card||''),original=String(member.name||''),note=String(notes[uid]||''),name=card||nickname||original||uid;
      if(!`${uid} ${nickname} ${card} ${original} ${note}`.toLowerCase().includes(filter.value.trim().toLowerCase()))continue;
      const item=row(note||name,'',[
        button('编辑备注',()=>editNote(uid,name,value=>{if(value)notes[uid]=value;else delete notes[uid];render();})),
        button('添加印象',async()=>{const memories=await request('GET',`/api/memory-files/${key.replace(':','_')}`);await editMember(key,(memories.members||[]).find(m=>String(m.userId)===uid)||{userId:uid,name,impressions:[]});}),
      ]),identities=document.createElement('dl');item.dataset.groupMember=uid;identities.className='member-identities';
      for(const [label,value] of [['QQ 号',uid],['QQ 昵称',nickname],['群名片',card],...(original&&original!==nickname?[['原名',original]]:[]),['备注',note]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value||'—';identities.append(dt,dd);}
      item.querySelector('.muted').replaceWith(identities);membersList.append(item);
    }
    if(!membersList.childElementCount)membersList.append(Object.assign(document.createElement('div'),{className:'empty',textContent:'没有匹配的群成员'}));
  };
  filter.addEventListener('input',render);dialog.append(title,filter,membersList,button('关闭',()=>dialog.close()));installDisposableDialog(dialog);document.body.append(dialog);dialog.showModal();render();
}
function taskStatus(key,message){if(current===key){const status=detail.querySelector('.task-status');if(status)text(status,message);}}
function syncTaskButtons(){for(const control of document.querySelectorAll('[data-consolidate-chat]'))control.disabled=tasks.has(control.dataset.consolidateChat);ticker?.sync();}
function consolidateButton(label,key,userIds=null,kind=''){
  const control=document.createElement('button');control.type='button';control.textContent=label;control.className=kind;control.dataset.consolidateChat=key;control.disabled=tasks.has(key);
  control.addEventListener('click',async()=>{try{await startConsolidate(key,userIds);}catch{/* startConsolidate displays the failure. */}finally{syncTaskButtons();}});
  return control;
}
async function startConsolidate(key,userIds,create=false){
  if(tasks.has(key))throw new Error('该聊天已在整理中，请等待当前任务结束');
  ++taskVersion;const task={startedAt:Date.now(),submitted:false};tasks.set(key,task);syncTaskButtons();
  taskStatus(key,'正在提交整理任务…');
  try{
    const result=await request('POST','/api/memory-files/consolidate',{chatKey:key,userIds,force:true,...(create?{create:true}:{})});
    if(!result?.started)throw new Error(result?.reason||result?.error||'整理未启动');
    // A terminal SSE event may arrive before the accepted HTTP response.
    if(tasks.get(key)===task){task.submitted=true;++taskVersion;taskStatus(key,'整理任务已提交，完成后会自动刷新');}
  }catch(e){if(tasks.get(key)===task){tasks.delete(key);++taskVersion;taskStatus(key,`整理失败：${e.message}`);}throw e;}
  finally{syncTaskButtons();void load();}
}
async function load(){
  const version=++listVersion,taskRevision=taskVersion;
  try{
    const data=await request('GET','/api/memory-files',undefined,{scope:'allowlist'});if(version!==listVersion)return;const files=data.files||[];text($('#meta'),`${files.length} 个记忆文件 · 整理中 ${data.consolidating?.length||0}`);
    if(taskRevision===taskVersion){
      const active=new Set([...(data.consolidating||[]),...files.filter(file=>file.consolidating).map(file=>file.chatKey)]);
      for(const key of active)if(!tasks.has(key))tasks.set(key,{startedAt:Date.now(),submitted:true});
      for(const [key,task] of tasks)if(task.submitted&&!active.has(key)){
        tasks.delete(key);taskStatus(key,'整理任务已结束，已刷新最新印象');if(current===key)void show(key,{refresh:true});
      }
      syncTaskButtons();
    }
    const live=new Set(files.map(file=>file.chatKey)),next=[];
    for(const key of tasks.keys())if(!live.has(key))tasks.delete(key);
    for(const key of memberFolds.keys())if(!live.has(key.split('\0')[0]))memberFolds.delete(key);
    if(current&&!live.has(current)){current=rendered=null;++detailVersion;memberCards.clear();text(detail,'此聊天不在聊天白名单中');}
    for(const [key,entry] of fileRows)if(!live.has(key)){entry.item.remove();fileRows.delete(key);}
    for(const file of files){const key=file.chatKey;
      let entry=fileRows.get(key);if(entry&&!entry.item.isConnected){fileRows.delete(key);entry=null;}if(!entry){
        entry={file,item:null};const item=row(key,'',[destructiveButton('删除',async()=>{await request('DELETE',`/api/memory-files/${encodeURIComponent(key.replace(':','_'))}`);forgetChatFolds(key);if(current===key){current=rendered=null;++detailVersion;text(detail,'记忆已清空');}await load();},{clicks:4,target:()=>[entry.item,...(current===key&&rendered===key?[detail]:[])],key:()=>key,canActivate:()=>fileRows.has(key),impact:()=>`清空 ${key} 的全部聊天记忆（${entry.file.memberCount??0} 位成员、${entry.file.impressionCount??0} 条印象）。`})]);
        entry.item=item;entry.title=item.querySelector('strong');entry.summary=item.querySelector('.muted');entry.open=selectableRow(item,()=>void show(key));item.dataset.memoryChat=key;item.addEventListener('click',e=>{if(!e.target.closest('button'))void show(key);});fileRows.set(key,entry);
      }
      entry.file=file;text(entry.summary,`${file.memberCount??0} 位成员 · ${file.impressionCount??0} 条印象 · ${memoryUpdatedAt(file.updatedAt)}${file.consolidating?' · 整理中':''}`);entry.item.classList.toggle('selected',current===key);entry.open.setAttribute('aria-current',String(current===key));next.push(entry.item);
    }
    // Polling updates summaries without replacing controls mid-interaction.
    for(const node of [...list.children])if(!next.includes(node))node.remove();next.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);});if(!files.length)list.append(Object.assign(document.createElement('div'),{className:'empty',textContent:'暂无记忆文件'}));syncChatTitles();if(!disposed)void contentReady();return files;
  }catch(e){if(!disposed&&version===listVersion){error(list,e.message);void contentReady();}}
}
async function show(key,{refresh=false}={}){
  if(refresh&&current!==key)return;rememberMemberFolds();current=key;syncSelection();const version=++detailVersion;
  try{
    const url=key.replace(':','_'),[data,config]=await Promise.all([request('GET',`/api/memory-files/${encodeURIComponent(url)}`,undefined,{scope:'allowlist'}),request('GET','/api/config')]);if(current!==key||version!==detailVersion)return;const scroll=detail.scrollTop;
    if(rendered!==key||!detail.querySelector('.member-cards')){
      clear(detail);memberCards.clear();const head=document.createElement('div');head.className='row';const title=document.createElement('h3');title.className='memory-chat-title';title.textContent=`${chatTitle(key)} · 成员印象`;title.title=key;
      const status=document.createElement('div');status.className='muted task-status';const cards=document.createElement('div');cards.className='member-cards';
      head.append(title,button('新增成员',()=>editMember(key)),consolidateButton('整理全部',key,null,'primary'));if(key.startsWith('group:'))head.append(button('成员列表',()=>groupMembers(key)));detail.append(head,status,cards);rendered=key;
    }
    const cards=detail.querySelector('.member-cards'),members=data.members||data.memberImpression||[],live=new Set(members.map(member=>String(member.userId))),next=[];
    for(const foldKey of memberFolds.keys())if(foldKey.startsWith(key+'\0')&&!live.has(foldKey.slice(key.length+1)))memberFolds.delete(foldKey);
    for(const [uid,entry] of memberCards)if(!live.has(uid)){entry.card.remove();memberCards.delete(uid);memberFolds.delete(`${key}\0${uid}`);}
    for(const member of members){
      const uid=String(member.userId);let entry=memberCards.get(uid);
      if(!entry){
        const card=document.createElement('article'),fold=document.createElement('details'),summary=document.createElement('summary'),heading=document.createElement('div'),name=document.createElement('h3'),identity=document.createElement('small'),count=document.createElement('span'),body=document.createElement('div'),notes=document.createElement('ul'),actions=document.createElement('div');card.className='card';card.dataset.member=uid;fold.dataset.collapsible='';fold.open=memberFolds.get(`${key}\0${uid}`)??true;summary.setAttribute('aria-expanded',String(fold.open));count.className='member-impression-count';body.className='member-impression-body';actions.className='actions';entry={card,fold,name,identity,count,notes,member};
        actions.append(button('编辑印象',()=>editMember(key,entry.member)),button('编辑备注',()=>editNote(uid,entry.member.name)),consolidateButton('重新整理',key,[uid]),destructiveButton('删除成员',async()=>{await request('DELETE',`/api/memory-files/${encodeURIComponent(url)}/members/${encodeURIComponent(uid)}`);await show(key,{refresh:true});},{clicks:2,target:()=>[entry.card],key:()=>`${key}:${uid}`,canActivate:()=>current===key&&memberCards.get(uid)===entry,impact:()=>`删除 ${entry.name.textContent} 在此聊天中的全部成员印象。`}));heading.append(name,identity);summary.append(heading,count);body.append(notes);fold.append(summary,body);card.append(fold,actions);memberCards.set(uid,entry);
      }
      entry.member=member;text(entry.name,config.memberNotes?.[member.userId]||member.name||member.userId||'未知成员');text(entry.identity,`QQ ${member.userId}`);text(entry.count,`${member.impressions?.length||0} 条印象`);const notes=(member.impressions||[]).map(impressionText);while(entry.notes.children.length>notes.length)entry.notes.lastElementChild.remove();notes.forEach((note,index)=>{let li=entry.notes.children[index];if(!li){li=document.createElement('li');entry.notes.append(li);}text(li,note);});next.push(entry.card);
    }
    for(const node of [...cards.children])if(!next.includes(node))node.remove();next.forEach((node,index)=>{if(cards.children[index]!==node)cards.insertBefore(node,cards.children[index]||null);});if(!members.length)cards.append(Object.assign(document.createElement('div'),{className:'empty',textContent:'暂无成员印象'}));
    syncTaskButtons();if(tasks.has(key))taskStatus(key,`正在整理 · 已 ${Math.floor((Date.now()-tasks.get(key).startedAt)/1000)} 秒`);if(refresh)detail.scrollTop=scroll;
  }catch(e){if(current===key&&version===detailVersion){if(refresh)taskStatus(key,`刷新失败：${e.message}`);else{rendered=null;error(detail,e.message);}}}
}
$('#reload').addEventListener('click',()=>{void loadChatNames();void load();if(current)void show(current,{refresh:true});});
const create=button('新增聊天记忆',()=>formDialog('新增聊天记忆',[{key:'chatKey',label:'聊天（group:群号 或 private:QQ号）',required:true,pattern:'(group|private):[0-9]+'}],async value=>{await show(value.chatKey);}));document.querySelector('header').append(create);
const live=createLiveRefresh(async()=>{await load();if(current)await show(current,{refresh:true});});
onShellEvent((name,payload)=>{
  if(name==='hello'){void loadChatNames();live.request();return;}
  if(name==='status'&&payload?.configUpdated){++detailVersion;void loadChatNames();live.request();return;}
  if(name!=='memory-update')return;if(payload?.phase==='consolidate-start'){const task=tasks.get(payload.chatKey)||{startedAt:Date.now()};task.submitted=true;tasks.set(payload.chatKey,task);}else if(payload?.phase)tasks.delete(payload.chatKey);if(payload?.phase)++taskVersion;syncTaskButtons();live.request();if(!current||(payload?.chatKey&&payload.chatKey!==current))return;
  if(payload?.phase==='consolidate-start')taskStatus(current,'正在整理…');
  else if(payload?.phase==='consolidate-error')taskStatus(current,`整理失败：${payload.error||'本轮已放弃，原印象保留'}`);
  else{if(payload?.phase==='consolidate-done')taskStatus(current,payload.failures?.length?`整理完成 · ${payload.failures.length} 位成员失败：${payload.failures.map(item=>typeof item==='string'?item:JSON.stringify(item)).join('；')}`:'整理完成');live.request();}
});
ticker=createActiveTaskTicker({active:()=>tasks.size>0,tick:()=>{if(current&&tasks.has(current))taskStatus(current,`正在整理 · 已 ${Math.floor((Date.now()-tasks.get(current).startedAt)/1000)} 秒`);}});
onLeave(()=>{live.dispose();disposed=true;++namesVersion;++listVersion;++detailVersion;ticker.dispose();});
void loadChatNames();void initializeNavigation().catch(()=>{});
