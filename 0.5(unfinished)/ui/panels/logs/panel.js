import {request,onShellEvent,onLeave,onBeforeLeave,contentReady} from '/panels/panel-client.js';
import {$,dateTime} from '../ui.js';
import {createIcon} from '../icons.js';
import {createAutoSave,mountSaveFeedback} from '../settings/auto-save.js';
import {createLogStream} from './log-stream.js';

const status=$('#status'),level=$('#log-level'),reload=$('#reload');
const snapshotLevelRevision=Symbol('log-level-revision');
let disposed=false,refreshCount=0,levelRevision=0,acknowledgedLevel=level.value;
const disposeFeedback=mountSaveFeedback();
reload.replaceChildren(createIcon('refresh'));
const automatic=createAutoSave({root:level,delay:150,savedMessage:'已应用 · 本次运行',dirty:()=>level.value!==acknowledgedLevel,save:async()=>{
  const requested=level.value;
  const result=await request('POST','/api/logs/level',{level:requested});
  ++levelRevision;
  acknowledgedLevel=result.level||requested;
  // Keep a newer selection visible while an earlier request is in flight.
  if(!disposed&&level.value===requested)level.value=acknowledgedLevel;
}});
const formatLog=log=>typeof log==='string'?log:`[${dateTime(log.at??log.ts)}] ${log.level||log.stream||''} ${log.text??log.message??log.msg??''}`;
const view=createLogStream($('#app-log'),{format:formatLog,onSnapshot:data=>{
  if(data.level&&data[snapshotLevelRevision]===levelRevision&&!automatic.dirty)level.value=acknowledgedLevel=data.level;
  status.textContent='最近 200 条 · 实时更新';
}});
async function refresh(){
  if(disposed)return;
  const revision=levelRevision;
  ++refreshCount;reload.dataset.iconActive='true';reload.setAttribute('aria-busy','true');
  // A snapshot may describe the level before a later change was acknowledged.
  try{await view.refresh(async()=>({...await request('GET','/api/logs',undefined,{limit:200}),[snapshotLevelRevision]:revision}));}
  finally{if(--refreshCount===0&&!disposed){reload.dataset.iconActive='false';reload.setAttribute('aria-busy','false');requestAnimationFrame(()=>{if(!disposed)void contentReady();});}}
}
reload.addEventListener('click',()=>{void refresh();});
level.addEventListener('change',()=>{if(!disposed){++levelRevision;automatic.schedule();}});
const offEvents=onShellEvent((name,payload)=>{
  if(disposed)return;
  if(name==='log')view.append(payload);
  else if(name==='hello')void refresh();
});
const offBeforeLeave=onBeforeLeave(()=>automatic.flush());
function dispose(){if(disposed)return;disposed=true;offBeforeLeave();offEvents();automatic.dispose();disposeFeedback();view.dispose();}
onLeave(dispose);window.addEventListener('pagehide',dispose);void refresh();
