import {request,onBeforeLeave,onLeave,contentReady,getViewState,onViewStateSnapshot} from '../panel-client.js';
import {createIcon} from '../icons.js';
import {createAutoSave,mountSaveFeedback,saveFeedback,flushAutoSaves} from '../settings/auto-save.js';
import {mountManagement} from './management.js';

const host=document.querySelector('#rules-editor'),status=document.querySelector('#status'),reload=document.querySelector('#reload');
reload.append(createIcon('refresh'));
const disposeFeedback=mountSaveFeedback();
let editor=null,rules=[],revision=0,acknowledged=0,disposed=false,loading=false;
const automatic=createAutoSave({root:host,delay:180,dirty:()=>revision!==acknowledged,save:async()=>{
  const saving=revision,payload=structuredClone(rules);
  await request('POST','/api/management',{rules:payload});
  acknowledged=saving;
}});
function write(_path,value){rules=structuredClone(value.rules);revision++;automatic.schedule();}
async function flush(){
  try{await automatic.flush();}
  catch(error){saveFeedback('error','未保存 · '+error.message,()=>flush().catch(()=>{}));throw error;}
}
async function flushAll(){
  try{await flushAutoSaves(document);await flush();}
  catch(error){saveFeedback('error','未保存 · '+error.message,()=>flushAll().catch(()=>{}));throw error;}
}
function describe(){status.textContent='按事件编排自动操作 · 各账号独立保存';}
async function load(){
  if(loading||disposed)return;loading=true;reload.disabled=true;host.inert=true;
  try{
    await flushAll();
    const data=await request('GET','/api/management'),saved=editor?.snapshot()??await getViewState('editor');
    if(disposed)return;
    editor?.dispose();host.replaceChildren();rules=structuredClone(data.rules??[]);revision=acknowledged=0;
    editor=mountManagement({host,request,flush,read:()=>({rules}),write,initialState:saved??{},initialData:data});describe();
  }catch(error){status.textContent=error.message;status.classList.add('field-error');}
  finally{loading=false;reload.disabled=false;host.inert=false;await contentReady();}
}
onViewStateSnapshot('editor',()=>editor?.snapshot()??{});
onBeforeLeave(flushAll);
onLeave(()=>{disposed=true;editor?.dispose();automatic.dispose();disposeFeedback();});
reload.addEventListener('click',()=>{status.classList.remove('field-error');void load();});
void load();
