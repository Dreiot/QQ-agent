import {request,notify} from './panel-client.js';
import {button,managePermissions} from './ui.js';
import {installDisposableDialog} from './dialog-lifecycle.js';

export async function readExtensionUpdates(){try{return await request('GET','/api/extensions/updates');}catch(error){return{updates:[],error:error.message};}}
export function bindExtensionUpdateCheck(reload){
  const actions=document.querySelector('#installed-actions');if(!actions||actions.querySelector('#check-updates'))return;
  const check=button('检查更新',async()=>{await request('POST','/api/extensions/updates/check',{});await reload();});check.id='check-updates';check.title='检查所有已配置来源的技能和插件';actions.querySelector('#reload')?.after(check);
}
export function createExtensionUpdateControls(entry){
  const check=button('检查更新',async()=>{await request('POST','/api/extensions/updates/check',{id:entry.extension.id});await entry.reload();});
  const update=button('更新',()=>showUpdateDialog(entry),'primary'),note=document.createElement('p');note.className='extension-update-status muted';note.setAttribute('role','status');
  return {check,update,note,render(info){entry.updateState=info;const hasSource=entry.extension.root!=='bundled'&&!!entry.extension.update;
    check.hidden=!hasSource;check.disabled=info?.status==='checking'||info?.status==='updating';update.hidden=info?.status!=='available';update.disabled=info?.status==='updating';
    const labels={unchecked:'',checking:'正在检查更新…',current:'已是最新版',available:`新版 ${info?.latestVersion||''}`,updating:'正在下载并加载新版…',error:`更新未完成：${info?.error||'请重试检查'}`};
    note.textContent=entry.extension.updateError||labels[info?.status]||'';note.hidden=!note.textContent;note.classList.toggle('is-good',info?.status==='available');
  }};
}
function showUpdateDialog(entry){
  const offer=entry.updateState;if(offer?.status!=='available')return;
  const dialog=document.createElement('dialog');dialog.className='extension-update-dialog';dialog.dataset.extensionUpdate=entry.extension.id;
  const heading=document.createElement('h3'),versions=document.createElement('p'),source=document.createElement('p'),notes=document.createElement('pre'),impact=document.createElement('p'),feedback=document.createElement('p'),actions=document.createElement('div');
  heading.textContent=`更新 ${entry.extension.name||entry.extension.id}`;versions.className='extension-update-versions';versions.textContent=`${offer.currentVersion} → ${offer.latestVersion}`;
  source.className='muted';source.textContent=`GitHub · ${offer.source.repo} · ${offer.source.asset}`;
  notes.className='pre';notes.textContent=offer.notes||'作者未提供更新说明。';
  impact.className='muted';impact.textContent='下载并替换后重新加载。保留设置和存储数据；失败时恢复原版。新版宿主权限需重新确认。';feedback.className='error';feedback.setAttribute('role','alert');actions.className='actions';let busy=false;
  const cancel=button('取消',()=>life.close());const install=button('下载并更新',async()=>{busy=true;cancel.disabled=true;feedback.textContent='';
    try{const result=await request('POST',`/api/extensions/${encodeURIComponent(entry.extension.id)}/update`,{confirmed:true,checkId:offer.checkId});busy=false;life.close();await entry.reload();void notify(`已更新至 ${result.version}${result.enabled?'':'，保持停用'}`).catch(()=>{});if(result.needsReauthorize&&result.skill)await managePermissions(result.skill);}
    catch(error){feedback.textContent=error.message;await entry.reload();}
    finally{busy=false;cancel.disabled=false;}
  },'primary');actions.append(cancel,install);dialog.append(heading,versions,source,notes,impact,feedback,actions);
  const life=installDisposableDialog(dialog,{canClose:()=>!busy,dismissOnBackdrop:true});document.body.append(dialog);dialog.showModal();
}
