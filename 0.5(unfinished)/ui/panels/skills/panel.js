import {createLiveRefresh} from '../live-refresh.js';
import {readExtensionUpdates,bindExtensionUpdateCheck} from '../extension-updates.js';
import{request,onShellEvent,onLeave,contentReady}from'/panels/panel-client.js';import{$,clear,text,error}from'../ui.js';
import{renderExtensions,bindZipInstaller,renderCleanup,renderCapabilityProviders,summarizeExtensions}from'../extension-manager.js';
import{bindMarketBrowser}from'../market-browser.js';
import{bindAuthoringGuide}from'../extension-authoring.js';
bindAuthoringGuide({parent:document.querySelector('#installed-actions'),kind:'skill'});
const list=$('#list');let items=[],updates=[],loadVersion=0,disposed=false,eventTimer=null,conflictSignature=null;
const notice=document.createElement('p');notice.className='error catalogue-feedback';notice.hidden=true;list.before(notice);
function renderConflicts(conflicts){const signature=JSON.stringify(conflicts);if(signature===conflictSignature)return;conflictSignature=signature;const host=$('#conflicts');clear(host);if(!conflicts.length)return;const note=document.createElement('div'),title=document.createElement('h3'),ul=document.createElement('ul');note.className='conflict-note';title.textContent=`工具名称重复（${conflicts.length}）· 使用最后加载的版本`;for(const item of conflicts){const li=document.createElement('li');li.textContent=`${item.id} · 当前：${item.winner??'内置功能'} · 被替代：${(item.losers||[]).map(l=>l.ownerId).join('、')}`;ul.append(li);}note.append(title,ul);host.append(note);}
function render(){renderExtensions(items,'skill',load,updates);}
async function load(rescan=false){
  if(disposed)return false;const version=++loadVersion;
  try{
    if(rescan)await request('POST','/api/skills/reload');
    const [data,conflicts,online]=await Promise.all([request('GET','/api/skills'),request('GET','/api/tools/conflicts').catch(()=>({conflicts:[]})),readExtensionUpdates()]);if(disposed||version!==loadVersion)return true;
    items=data.skills||[];updates=online.updates||[];notice.hidden=true;renderCleanup(data.uninstalled,load);const summary=summarizeExtensions(items.filter(x=>x.kind==='skill'));text($('#meta'),`${summary.total} 项 · 已加载 ${summary.loaded} · 错误 ${summary.errors}`);renderConflicts(conflicts.conflicts||[]);render();
    await renderCapabilityProviders(items,{isCurrent:()=>!disposed&&version===loadVersion}).catch(e=>{if(!disposed&&version===loadVersion){text(notice,e.message);notice.hidden=false;}});if(!disposed&&version===loadVersion)void contentReady();return true;
  }catch(e){if(!disposed&&version===loadVersion){text(notice,`读取失败：${e.message}；已保留当前内容，可以重试。`);notice.hidden=false;void contentReady();}return false;}
}
$('#reload').addEventListener('click',()=>void load(true));bindZipInstaller('skill',load);$('#search').addEventListener('input',render);
bindExtensionUpdateCheck(load);
const live=createLiveRefresh(()=>load());
onShellEvent((name,payload)=>{if(['hello','plugin-loaded','plugin-unloaded','plugin-error'].includes(name)||name==='status'&&(payload?.configUpdated||payload?.extensionUpdates))live.request();});
onLeave(()=>{live.dispose();disposed=true;++loadVersion;clearTimeout(eventTimer);});void load();
if(document.querySelector('#market-view'))bindMarketBrowser({kind:'skill',onInstalled:load});
