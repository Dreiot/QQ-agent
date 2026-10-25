import {button,destructiveButton,formDialog,text} from '../ui.js';
import {modelId,modelLabel,providerEndpointIdentity} from './model-catalog-data.js';
import {addProviderModel} from './model-catalog.js';
import {openModelImport} from './model-import.js';
import {createAutoSave,saveFeedback} from './auto-save.js';

// Default UI leaf. Mutations use the existing per-field channel transaction;
// discovery never imports models before an explicit selection is submitted.
export function createProviderManager({host,request,beforeWrite,changed,activeProvider,selected,onSelect=()=>{},onDraftChange=()=>{},paused=()=>false}){
  const doc=host.ownerDocument,layout=doc.createElement('div'),aside=doc.createElement('aside'),nav=doc.createElement('nav'),add=doc.createElement('div');
  layout.id='provider-manager-layout';layout.className='provider-manager-layout';nav.id='provider-manager-nav';nav.setAttribute('aria-label','模型管理渠道');add.id='provider-manager-actions';aside.append(nav,add);host.before(layout);layout.append(aside,host);
  const entries=new Map();let current=selected,disposed=false;
  const live=()=>!disposed&&host.isConnected&&!paused();
  const notify=()=>onDraftChange();
  add.addEventListener('click',async event=>{const launch=event.target.closest('[data-settings-open="provider-add"]');if(!launch||![...entries.values()].some(entry=>entry.dirty))return;event.preventDefault();event.stopImmediatePropagation();try{for(const entry of entries.values())await entry.flush();if(live())launch.click();}catch(error){entries.get(current)?.fail(error);}},{capture:true});
  const syncSelection=()=>{for(const[id,entry]of entries){entry.item.hidden=id!==current;entry.pick.setAttribute('aria-pressed',String(id===current));}onSelect(current);};
  async function select(id){if(!live()||id===current)return;try{await entries.get(current)?.flush();if(!live())return;for(const entry of entries.values())entry.pause();current=id;syncSelection();}catch(error){entries.get(current)?.fail(error);}}
  function make(provider){
    const item=doc.createElement('article'),head=doc.createElement('div'),name=doc.createElement('input'),title=doc.createElement('h4'),baseWrap=doc.createElement('label'),base=doc.createElement('input'),credential=doc.createElement('label'),key=doc.createElement('input'),keyLine=doc.createElement('div'),feedback=doc.createElement('p'),recovery=doc.createElement('div'),modelHead=doc.createElement('div'),modelsTitle=doc.createElement('h4'),catalogue=doc.createElement('div'),discoveryStatus=doc.createElement('p');
    item.className='list-item provider-detail';item.dataset.providerId=provider.id;item.dataset.motionKey=`provider:${provider.id}`;head.className='provider-detail-head';name.className='provider-name-input';name.setAttribute('aria-label','渠道名称');name.maxLength=100;name.dataset.providerField='displayName';title.textContent=provider.displayName||provider.id;title.className='provider-detail-title';head.append(title,name);
    baseWrap.className='setting-field provider-base-view';baseWrap.append(doc.createTextNode('Base URL'),base);base.type='url';base.setAttribute('aria-label','Base URL');base.dataset.providerField='baseUrl';
    credential.className='provider-key-view';const keyTitle=doc.createElement('span');keyTitle.textContent='API Key';key.type='password';key.autocomplete='new-password';key.setAttribute('aria-label','API Key');key.dataset.managerKey='';key.dataset.providerField='apiKey';keyLine.className='provider-key-controls';credential.append(keyTitle,keyLine);
    feedback.className='muted provider-save-status';feedback.setAttribute('role','status');recovery.className='actions provider-recovery';recovery.hidden=true;modelHead.className='provider-model-head';modelsTitle.textContent='模型';catalogue.className='model-catalog';discoveryStatus.className='muted provider-discovery-status';discoveryStatus.setAttribute('role','status');
    const filter=doc.createElement('input');filter.type='search';filter.className='provider-model-filter';filter.placeholder='筛选模型 ID 或显示名称';filter.setAttribute('aria-label','筛选模型');
    const pick=button('',()=>select(provider.id));pick.dataset.providerId=provider.id;pick.dataset.skipProviderPull='';
    let saved=provider,baseline=provider,keyDraft='',keyVersion=0,editVersion=0,sourceVersion=0,readVersion=0,fetchVersion=0,fetching=null,commit=null,timer=null,keyTimer=null,discovery=null,attempted='',closed=false,shown=false;
    const rows=new Map(),isLive=()=>live()&&!closed&&item.isConnected,owner=()=>item.closest('dialog[data-settings-editor="model-manager"][open]');
    const expected=()=>({baseUrl:baseline.baseURL||baseline.baseUrl,displayName:baseline.displayName||baseline.name||baseline.id,credentialRevision:baseline.credentialRevision});
    const dirty=()=>name.value.trim()!==(baseline.displayName||baseline.name||baseline.id)||providerEndpointIdentity(base.value)!==providerEndpointIdentity(baseline.baseURL||baseline.baseUrl)||!!keyDraft;
    const autoSave=createAutoSave({root:item,save:flush,dirty,onError:fail});
    function fail(error){if(!isLive())return;text(feedback,error.message||error);feedback.className='field-error provider-save-status';recovery.hidden=false;saveFeedback('error',`未保存 · ${error.message||error}`,()=>flush().catch(fail));notify();}
    function sync(){text(title,saved.displayName||saved.id);text(pick,`${saved.displayName||saved.id}${activeProvider()===saved.id?' · 当前':''}`);text(modelsTitle,`模型（${(saved.models||[]).length} 个）`);key.dataset.managerKey=saved.hasKey?'set':'empty';key.placeholder=saved.hasKey?'已保存密钥；输入新密钥可替换':'输入 API Key';pull.hidden=!providerEndpointIdentity(base.value)||!(keyDraft||saved.hasKey);}
    function closeDiscovery(){++fetchVersion;fetching=null;pull.disabled=false;discovery?.close();discovery=null;text(discoveryStatus,'');}
    function purge(){++readVersion;clearTimeout(keyTimer);shown=false;key.type='password';key.value=keyDraft;text(show,'显示');}
    function pause(){++sourceVersion;clearTimeout(timer);timer=null;purge();closeDiscovery();for(const row of rows.values())text(row.result,'');}
    function drawModels(){
      const wanted=[];
      for(const value of saved.models||[]){const id=modelId(value);let row=rows.get(id);
        if(!row){
          const el=doc.createElement('div'),identity=doc.createElement('div'),line=doc.createElement('div'),label=button('',()=>rename(id)),badge=doc.createElement('span'),result=doc.createElement('p');
          const test=button('测试连接',async()=>{
            await flush();if(!isLive()||current!==saved.id||!owner())return;
            const dialog=owner(),signature=stamp(),version=sourceVersion;test.disabled=true;text(result,'正在测试…');
            const valid=()=>isLive()&&owner()===dialog&&dialog.open&&current===saved.id&&sourceVersion===version&&stamp()===signature&&rows.get(id)?.el===el&&el.isConnected;
            try{const response=await request('POST','/api/providers/test-chat',{providerId:saved.id,model:id,expectedBaseUrl:saved.baseURL||saved.baseUrl});if(valid()){const info=response.result||{};text(result,`${info.ok?'连接成功':'连接失败'}${Number.isFinite(info.latencyMs)?` · ${info.latencyMs} ms`:''}${info.ok||!info.note?'':` · ${info.note}`}`);}}
            catch(error){if(valid())text(result,`连接失败 · ${error.message||error}`);}
            finally{test.disabled=false;if(!valid())text(result,'');}
          });test.className='model-test';test.dataset.skipProviderPull='';
          const remove=destructiveButton('删除模型',async()=>{await flush();if(!isLive())return;await request('DELETE','/api/providers/models',{providerId:saved.id,modelId:id,expectedBaseUrl:saved.baseURL||saved.baseUrl});await changed();},{target:()=>el,clicks:2,key:()=>`${saved.id}:${id}`,canActivate:isLive,impact:'将此模型移出渠道目录，已配置的模型调用保持。'});
          el.className='model-catalog-item';el.dataset.providerId=saved.id;el.dataset.modelId=id;identity.className='model-catalog-identity';line.className='model-catalog-label';label.className='model-catalog-name';label.setAttribute('aria-label',`编辑模型 ${id}`);badge.className='model-vision-badge';badge.setAttribute('role','img');badge.dataset.providerId=saved.id;badge.dataset.modelId=id;result.className='muted model-test-result';result.setAttribute('role','status');line.append(label,badge);identity.append(line,result);el.append(identity,test,remove);row={el,label,result};rows.set(id,row);
        }
        text(row.label,modelLabel(saved,value));row.label.title=id;row.el.hidden=!`${id} ${modelLabel(saved,value)}`.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase());wanted.push(row.el);
      }
      for(const[id,row]of rows)if(!wanted.includes(row.el)){row.el.remove();rows.delete(id);}
      wanted.forEach((el,index)=>{if(catalogue.children[index]!==el)catalogue.insertBefore(el,catalogue.children[index]||null);});
    }
    function accept(next){if(!isLive())return;const pending=dirty()||commit,source=`${providerEndpointIdentity(next.baseURL||next.baseUrl)}|${next.credentialRevision||''}`;if(source!==stamp()){++sourceVersion;attempted='';closeDiscovery();for(const row of rows.values())text(row.result,'');}saved=next;if(!pending){baseline=next;name.value=next.displayName||next.name||next.id;base.value=next.baseURL||next.baseUrl||'';}sync();drawModels();}
    async function flush(){
      clearTimeout(timer);timer=null;
      if(commit){await commit;if(dirty())return flush();return;}
      if(!isLive()||!dirty())return;
      const target=providerEndpointIdentity(base.value),displayName=name.value.trim();if(!target)throw Error('Base URL 必须是有效的 http(s) 地址');if(!displayName)throw Error('请填写渠道名称');
      const changes={},old=expected(),sentName=name.value,sentBase=base.value,sentKeyVersion=keyVersion;
      if(displayName!==old.displayName)changes.displayName=displayName;if(target!==providerEndpointIdentity(old.baseUrl))changes.baseUrl=base.value.trim();if(keyDraft)changes.apiKey=keyDraft;
      if(!Object.keys(changes).length)return;
      const version=editVersion;feedback.className='muted provider-save-status';text(feedback,'正在保存…');recovery.hidden=true;
      commit=(async()=>{await beforeWrite();if(!isLive())throw Error('渠道管理已关闭，操作已取消');const receipt=await request('POST','/api/providers/update',{providerId:saved.id,expected:old,changes});if(!isLive())return;
        baseline=saved=receipt.provider;if(name.value===sentName)name.value=saved.displayName||saved.id;if(base.value===sentBase)base.value=saved.baseURL||saved.baseUrl;if(keyVersion===sentKeyVersion){keyDraft='';purge();}sync();drawModels();text(feedback,editVersion===version?'已保存':'已保存提交时的改动，后续输入仍保留');await changed();
      })();notify();
      try{await commit;if(!dirty())saveFeedback('saved');}catch(error){fail(error);throw error;}finally{commit=null;notify();}
      if(dirty())await flush();
    }
    const stamp=()=>`${providerEndpointIdentity(saved.baseURL||saved.baseUrl)}|${saved.credentialRevision||''}`;
    async function discover(automatic=false){
      await flush();if(!isLive()||current!==saved.id||!owner())return;
      if(!providerEndpointIdentity(saved.baseURL||saved.baseUrl))return;
      const signature=stamp(),dialog=owner(),version=sourceVersion;if(fetching===signature||automatic&&attempted===signature)return;closeDiscovery();attempted=signature;fetching=signature;
      const snapshot=saved,ticket=fetchVersion;
      const valid=()=>isLive()&&owner()===dialog&&dialog.open&&current===snapshot.id&&sourceVersion===version&&stamp()===signature&&ticket===fetchVersion;
      const load=async()=>{const response=await request('POST','/api/providers/fetch-models',{providerId:snapshot.id,expectedBaseUrl:snapshot.baseURL||snapshot.baseUrl});if(!valid())throw Error('渠道已变化，请重新拉取模型');return response.models;};
      pull.disabled=true;text(discoveryStatus,'正在拉取模型…');
      try{
        const models=await load();if(!valid())return;let initial=true,view;
        view=openModelImport({provider:saved,load:()=>{if(initial){initial=false;return models;}return load();},onApply:async values=>{await flush();if(!valid()||discovery!==view||!view.isConnected)throw Error('渠道已变化，请重新拉取模型');await request('POST','/api/providers/models',{providerId:snapshot.id,expectedBaseUrl:snapshot.baseURL||snapshot.baseUrl,onlyMissing:true,models:values});await changed();}});discovery=view;text(discoveryStatus,'');
      }catch(error){if(valid())text(discoveryStatus,`拉取失败：${error.message||error}`);}
      finally{if(ticket===fetchVersion){fetching=null;pull.disabled=false;}}
    }
    function edited(kind){++editVersion;if(kind==='apiKey'){++keyVersion;keyDraft=key.value.trim();shown=false;key.type='password';text(show,'显示');}if(kind!=='displayName'){++sourceVersion;attempted='';++readVersion;closeDiscovery();for(const row of rows.values())text(row.result,'');}sync();notify();}
    for(const[kind,input]of [['displayName',name],['baseUrl',base],['apiKey',key]]){
      input.addEventListener('input',()=>{edited(kind);autoSave.schedule();});input.addEventListener('blur',event=>{
        clearTimeout(timer);const skip=event.relatedTarget?.closest('[data-skip-provider-pull]');timer=setTimeout(()=>{timer=null;if([name,base,key].includes(doc.activeElement))return;void(async()=>{await flush();if(kind!=='displayName'&&!skip&&base.value.trim())await discover(true);})().catch(fail);},100);
      });
    }
    const show=button('显示',async()=>{if(shown){purge();return;}if(keyDraft){key.type='text';shown=true;text(show,'隐藏');return;}const ticket=++readVersion,dialog=owner(),version=editVersion;const result=await request('GET','/api/providers/key',undefined,{providerId:saved.id});if(!isLive()||ticket!==readVersion||!dialog?.open||owner()!==dialog||current!==saved.id||version!==editVersion)return;key.type='text';key.value=result.apiKey||'';shown=true;text(show,'隐藏');clearTimeout(keyTimer);keyTimer=setTimeout(purge,20000);});show.dataset.managerKeyToggle='';
    const clearKey=destructiveButton('清除密钥',async()=>{await flush();if(!isLive())return;await request('POST','/api/providers/set-key',{providerId:saved.id,apiKey:'',expectedBaseUrl:saved.baseURL||saved.baseUrl});keyDraft='';purge();attempted='';closeDiscovery();await changed();},{target:()=>credential,clicks:3,key:()=>saved.id,canActivate:()=>isLive()&&!!saved.hasKey,impact:'清除本渠道保存的 API Key。'});keyLine.append(key,show,clearKey);
    const remove=destructiveButton('删除渠道',async()=>{await flush();if(!isLive())return;pause();await request('DELETE','/api/providers',{providerId:saved.id});await changed();},{target:()=>item,clicks:4,key:()=>saved.id,canActivate:isLive,impact:'删除此渠道及密钥、模型目录；使用它的主模型取消选择。'});head.append(remove);
    const pull=button('拉取模型',()=>discover()),addModel=button('添加模型',async()=>{await flush();if(isLive())addProviderModel({provider:saved,request,beforeWrite:flush,changed});});modelHead.append(modelsTitle,addModel,pull);
    recovery.append(button('重试保存',()=>flush()),button('重新读取此渠道',async()=>{const data=await request('GET','/api/providers'),latest=data.providers.find(p=>p.id===saved.id);if(!isLive()||!latest)return;keyDraft='';pause();baseline=saved=latest;name.value=latest.displayName||latest.id;base.value=latest.baseURL||latest.baseUrl;recovery.hidden=true;text(feedback,'已重新读取');sync();drawModels();notify();}));
    for(const action of [pull,clearKey,remove,addModel])action.dataset.skipProviderPull='';
    function rename(id){const value=saved.models.find(m=>modelId(m)===id),label=modelLabel(saved,value),signature=stamp();let modelIdCurrent=id,modelNameCurrent=label;const dialog=formDialog('编辑模型',[{key:'name',label:'显示名称',value:label,required:true,maxLength:200},{key:'id',label:'模型 ID',value:id,required:true,maxLength:500}],async fields=>{await flush();if(!isLive()||!owner()||current!==saved.id||stamp()!==signature||!dialog.isConnected||!dialog.open)throw Error('渠道已变化，请重新打开模型编辑');await request('POST','/api/providers/models/update',{providerId:saved.id,expectedBaseUrl:saved.baseURL||saved.baseUrl,modelId:modelIdCurrent,expectedName:modelNameCurrent,id:fields.id,name:fields.name});modelIdCurrent=fields.id;modelNameCurrent=fields.name;await changed();},{autoSave:(root,save)=>createAutoSave({root,save})});const hint=doc.createElement('p');hint.className='muted';hint.textContent='模型 ID 需与服务商一致';dialog.querySelector('h3').after(hint);}
    filter.addEventListener('input',drawModels);item.append(head,baseWrap,credential,feedback,recovery,modelHead,discoveryStatus,filter,catalogue);name.value=provider.displayName||provider.name||provider.id;base.value=provider.baseURL||provider.baseUrl||'';sync();drawModels();
    return{item,pick,accept,flush,pause,purge,fail,get dirty(){return dirty()||!!commit;},dispose(){closed=true;autoSave.dispose();pause();keyDraft='';key.value='';rows.clear();}};
  }
  function render(values){
    if(disposed)return;const wanted=new Set(values.map(p=>p.id));for(const[id,entry]of entries)if(!wanted.has(id)){entry.dispose();entry.item.remove();entry.pick.remove();entries.delete(id);}
    for(const provider of values){let entry=entries.get(provider.id);if(!entry){entry=make(provider);entries.set(provider.id,entry);nav.append(entry.pick);host.append(entry.item);}else entry.accept(provider);}
    if(!entries.has(current))current=entries.has(activeProvider())?activeProvider():values[0]?.id;syncSelection();
  }
  return{host,layout,render,select,async flush(){for(const entry of entries.values())await entry.flush();},get dirty(){return[...entries.values()].some(entry=>entry.dirty);},clearSecrets(){for(const entry of entries.values())entry.pause();},dispose(){disposed=true;for(const entry of entries.values())entry.dispose();entries.clear();}};
}
