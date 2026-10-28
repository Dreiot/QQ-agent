import {button, destructiveButton, text} from '../ui.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {modelId, providerEndpointIdentity} from './model-catalog-data.js';
import {onLeave} from '../panel-client.js';

// This default editor is an independent ui.assets target. It has no token,
// storage or configuration-array access; the host handles field conflict rules.
export function openProviderEditor({provider, request, beforeWrite, changed, cleared}) {
  const dialog=document.createElement('dialog'), fields=document.createElement('div');fields.className='settings-fields';
  const heading=text(document.createElement('h3'),`编辑渠道 · ${provider.displayName || provider.name || provider.id}`);
  function input(label,id,type='text') {
    const wrap=text(document.createElement('label'),label);wrap.className=`setting-field${type==='textarea'?' full':''}`;
    const node=document.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')node.type=type;node.id=id;
    if(type==='password')node.autocomplete='new-password';wrap.append(node);fields.append(wrap);return node;
  }
  const original={displayName:provider.displayName || provider.name || provider.id,baseUrl:provider.baseURL || provider.baseUrl,models:(provider.models || []).map(modelId),credentialRevision:provider.credentialRevision};
  const name=input('显示名称','provider-edit-name'),base=input('Base URL','provider-edit-base'),key=input('新密钥（空白保留）','provider-edit-key','password'),models=input('模型 ID（每行一个）','provider-edit-models','textarea');
  name.value=original.displayName;base.value=original.baseUrl;models.value=original.models.join('\n');
  let closed=false,busy=false,unleave=()=>{};
  function check(){if(closed||!dialog.isConnected)throw new Error('渠道编辑已关闭');}
  const life=installDisposableDialog(dialog,{onClosed(){closed=true;key.value='';unleave();window.removeEventListener('pagehide',leave);}});
  const leave=()=>dialog.close();unleave=onLeave(leave);window.addEventListener('pagehide',leave,{once:true});
  const save=button('保存渠道',async()=>{
    if(busy||closed)return;
    const ids=[...new Set(models.value.split(/\n/).map(id=>id.trim()).filter(Boolean))],changes={};
    const target=providerEndpointIdentity(base.value);
    if(!target)throw new Error('Base URL 必须是有效的 http(s) 地址');
    if(name.value.trim()!==original.displayName)changes.displayName=name.value.trim();
    if(target!==providerEndpointIdentity(original.baseUrl))changes.baseUrl=base.value.trim();
    if(JSON.stringify(ids)!==JSON.stringify(original.models))changes.models=ids;
    if(key.value.trim())changes.apiKey=key.value.trim();
    busy=true;clearKey.disabled=true;
    try {
      await beforeWrite?.();check();
      await request('POST','/api/providers/update',{providerId:provider.id,expected:original,changes});
      key.value='';if(!closed)dialog.close();await changed?.();
    } finally {busy=false;clearKey.disabled=false;}
  },'primary');
  const clearKey=destructiveButton('清除渠道密钥',async()=>{
    if(busy)return;busy=true;save.disabled=true;
    try {await beforeWrite?.();check();const result=await request('POST','/api/providers/set-key',{providerId:provider.id,apiKey:'',expectedBaseUrl:original.baseUrl});original.credentialRevision=result.credentialRevision;key.value='';await cleared?.();}
    finally{busy=false;save.disabled=false;}
  },{target:()=>key.closest('.setting-field')||fields,clicks:3,key:()=>provider.id,canActivate:()=>!closed&&!busy,
    impact:`将清除渠道 ${original.displayName} 的密钥，依赖它的模型连接会失效。`});
  dialog.append(heading,fields,save,clearKey,button('关闭',()=>dialog.close()));document.body.append(dialog);dialog.showModal();
  return {dialog,life};
}
