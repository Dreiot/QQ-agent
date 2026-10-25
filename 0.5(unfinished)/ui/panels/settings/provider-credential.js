import {button, destructiveButton, text} from '../ui.js';
import {createAutoSave} from './auto-save.js';

export function providerCredential({parent, provider, request, save, isCurrent, changed}) {
  const wrap=document.createElement('div');wrap.className='setting-field';wrap.dataset.providerCredential=provider.id;
  const title=text(document.createElement('span'),`当前渠道 API Key · ${provider.displayName || provider.id}`);
  const state=document.createElement('small'),line=document.createElement('div'),reveal=document.createElement('div'),input=document.createElement('input');
  state.className='secret-state';line.className='secret-controls';reveal.className='secret-revealed';
  input.type='password';input.autocomplete='new-password';input.id='active-provider-key';input.placeholder='输入新密钥；空白保持';
  let closed=false,timer;
  const check=()=>{if(closed||!wrap.isConnected||!isCurrent(provider.id))throw new Error('渠道已切换，请在当前渠道重新操作');};
  const clear=()=>{clearTimeout(timer);reveal.textContent='';};
  const sync=hasKey=>text(state,hasKey?'已配置；不会自动读取明文':'本渠道未配置密钥；不会借用直连密钥');sync(provider.hasKey);
  async function write(value){
    check();await save();check();
    const result=await request('POST','/api/providers/set-key',{providerId:provider.id,apiKey:value,expectedBaseUrl:provider.baseURL||provider.baseUrl});
    if(closed||!wrap.isConnected)return;
    if(input.value.trim()===value)input.value='';clear();sync(result.hasKey);changed?.(provider.id,result.hasKey);
  }
  const autoSave=createAutoSave({root:wrap,dirty:()=>!!input.value.trim(),save:async()=>{if(input.value.trim())await write(input.value.trim());}});input.addEventListener('input',()=>autoSave.schedule());
  line.append(input,
    destructiveButton('清除',()=>{input.value='';return write('');},{target:()=>wrap,clicks:3,key:()=>provider.id,canActivate:()=>!closed&&isCurrent(provider.id),impact:`将清除渠道 ${provider.displayName||provider.id} 的密钥。`}),
    button('显示已有',async()=>{
      check();const data=await request('GET','/api/providers/key',undefined,{providerId:provider.id});
      if(closed||!wrap.isConnected||!isCurrent(provider.id))return;
      clear();text(reveal,data.apiKey||'未配置');timer=setTimeout(clear,20000);
    }));
  wrap.append(title,state,line,reveal);parent.append(wrap);
  return()=>{closed=true;autoSave.dispose();input.value='';clear();};
}
