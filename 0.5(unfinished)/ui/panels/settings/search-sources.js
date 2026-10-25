import {destructiveButton} from '../ui.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createAutoSave,flushAutoSaves,saveFeedback} from './auto-save.js';
import {createIcon} from '../icons.js';

const LEGACY_SOURCES=[
  ['deepseek','DeepSeek',['https://api.deepseek.com/responses']],
  ['zhipu','智谱',['https://open.bigmodel.cn/api/paas/v4/web_search']],
  ['bocha','博查',['https://api.bochaai.com/v1/web-search']],
  ['baidu','百度',['https://qianfan.baidubce.com/v2/ai_search/web_search']],
  ['metaso','秘塔',['https://metaso.cn/api/v1/search','https://metaso.cn/api/open/v1/search']],
];

// Bing is the only preset. Retain explicitly configured legacy sources so a
// UI simplification never strands an existing endpoint, credential or route.
export function searchSourcePresets(read){
  return [['bing','Bing'],...LEGACY_SOURCES.filter(([id,,urls])=>{
    const prefix=`webSearch.${id}`,url=String(read(`${prefix}.baseUrl`)||'').trim();
    return read('webSearch.provider')===id||read(`${prefix}.hasApiKey`)===true||Boolean(read(`${prefix}.apiKey`))||Boolean(read(`${prefix}.name`))||(url&&!urls.includes(url));
  }).map(([id,name])=>[id,name])];
}

// Default presentation only. Configuration commits and HTTP remain supplied by
// the selected settings panel; source protocol and transport stay in web.search.
export function createSearchSources({read,commit,save,request,onDraftChange=()=>{},doc=document}){
  let disposed=false,custom=null,picker=null,manager=null,busy=false,customVersion=0;
  const drafts=new Map();
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const action=(label,run)=>{const el=node('button','',label);el.type='button';el.addEventListener('click',run);return el;};
  const choice=action('选择搜索源',()=>openPicker()),manage=action('管理搜索源',()=>openManager());
  const choiceLabel=node('span','','选择搜索源');choice.replaceChildren(choiceLabel,createIcon('chevron',{size:16}));
  choice.className='search-source-choice';choice.setAttribute('aria-haspopup','dialog');choice.dataset.settingsOpen='search-picker';
  manage.className='search-source-manage full';manage.setAttribute('aria-haspopup','dialog');manage.dataset.settingsOpen='search-manager';
  function sources(){
    const builtin=searchSourcePresets(read).map(([id,name])=>({id,name:read(`webSearch.${id}.name`)||name,baseUrl:read(id==='bing'?'webSearch.searchUrl':`webSearch.${id}.baseUrl`)||'',prefix:`webSearch.${id}`,hasApiKey:read(`webSearch.${id}.hasApiKey`)===true,keySupported:id!=='bing'}));
    if(read('webSearch.custom.baseUrl')||read('webSearch.provider')==='custom')builtin.push({id:'custom',name:read('webSearch.custom.name')||'自定义搜索',baseUrl:read('webSearch.custom.baseUrl')||'',prefix:'webSearch.custom',hasApiKey:read('webSearch.custom.hasApiKey')===true,keySupported:true});
    return [...builtin,...(custom??read('webSearch.providers')??[]).map(item=>({...item,id:`custom:${item.id}`,customId:item.id,keySupported:item.type!=='bing'}))];
  }
  function refresh(){if(disposed)return;choiceLabel.textContent=sources().find(item=>item.id===read('webSearch.provider'))?.name||'选择搜索源';}
  async function refreshCustom(){const version=++customVersion,result=await request('GET','/api/search-providers');if(!disposed&&version===customVersion)custom=result.providers||[];}
  function shell(title,kind){
    const root=node('dialog',`search-source-dialog ${kind}`);root.dataset.settingsEditor=kind;
    const head=node('div','settings-dialog-head'),heading=node('h3','',title),close=action('关闭',()=>root.close()),body=node('div','settings-dialog-body'),feedback=node('p','search-source-feedback');feedback.setAttribute('role','status');
    head.append(heading,close);root.append(head,body,feedback);
    const life=installDisposableDialog(root,{dismissOnBackdrop:true,beforeClose:()=>flushAutoSaves(root),onClosed:()=>{view.autoSave?.dispose();for(const input of root.querySelectorAll('input[type=password]'))input.value='';if(kind==='search-manager'){for(const draft of drafts.values())draft.apiKey='';drafts.clear();manager=null;onDraftChange();}else picker=null;}});
    const view={root,body,feedback,life};doc.body.append(root);root.showModal();return view;
  }
  function fail(view,error){if(!disposed&&!view.life.closed){view.feedback.textContent=error.message||'操作失败';view.feedback.classList.add('error');}}
  function setBusy(view,value){busy=value;for(const button of view.root.querySelectorAll('button'))button.disabled=value;onDraftChange();}
  async function openPicker(){
    if(disposed)return;if(picker){picker.root.focus();return;}
    const view=picker=shell('选择搜索源','search-picker'),grid=node('div','search-source-grid');view.body.append(grid);
    const draw=()=>{if(disposed||view.life.closed)return;grid.replaceChildren();for(const source of sources()){
      const pick=action(source.name,async()=>{if(busy)return;setBusy(view,true);view.feedback.textContent='';try{
        if(source.customId){await refreshCustom();if(!sources().some(item=>item.id===source.id))throw Error('搜索源已移除，请重新选择');}
        if(disposed||view.life.closed)return;await commit([{path:'webSearch.provider',value:source.id}]);saveFeedback('saved');refresh();setBusy(view,false);view.root.close();
      }catch(error){fail(view,error);}finally{if(!view.life.closed)setBusy(view,false);}});
      pick.dataset.searchSource=source.id;pick.className='search-source-card';pick.setAttribute('aria-pressed',String(source.id===read('webSearch.provider')));grid.append(pick);
    }};draw();try{await refreshCustom();draw();}catch(error){fail(view,error);}
  }
  function draftFor(source){
    const id=source?.id||'add';if(!drafts.has(id))drafts.set(id,{name:source?.name||'',baseUrl:source?.baseUrl||'',apiKey:'',dirty:false});return drafts.get(id);
  }
  async function persist(source,draft,clearKey=false){
    const name=draft.name.trim(),baseUrl=draft.baseUrl.trim(),apiKey=draft.apiKey.trim();
    if(!name)throw Error('请输入名称');
    let url;try{url=new URL(baseUrl);}catch{throw Error('请输入有效的接口地址');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('接口地址必须为不含账号密码的 HTTP(S) 地址');
    if(apiKey==='******')throw Error('请输入新的 API Key，或留空保留');
    if(source?.prefix){
      const changes=[{path:`${source.prefix}.name`,value:name},{path:source.id==='bing'?'webSearch.searchUrl':`${source.prefix}.baseUrl`,value:baseUrl}];
      if(source.keySupported&&(clearKey||apiKey))changes.push({path:`${source.prefix}.apiKey`,value:clearKey?'':apiKey});
      await commit(changes);return source.id;
    }
    await save();
    if(disposed||manager?.life.closed)throw Error('搜索源编辑已关闭');
    ++customVersion;
    const result=await request('POST','/api/search-providers',{...(source?{id:source.customId}:{type:'openai'}),name,baseUrl,...(clearKey||apiKey?{apiKey:clearKey?'':apiKey}:{})});
    await refreshCustom();return `custom:${result.provider.id}`;
  }
  async function openManager(){
    if(disposed)return;if(manager){manager.root.focus();return;}
    const view=manager=shell('管理搜索源','search-manager'),layout=node('div','search-source-layout'),nav=node('nav','search-source-nav'),editor=node('div','search-source-editor');let autoSave=null;
    nav.setAttribute('aria-label','可用搜索源');layout.append(nav,editor);view.body.append(layout);let active=sources().find(item=>item.id===read('webSearch.provider'))?.id||sources()[0]?.id;
    function drawNav(){
      nav.replaceChildren();for(const source of sources()){
        const pick=action(source.name,async()=>{try{await autoSave?.flush();active=source.id;draw();}catch(error){fail(view,error);}});pick.dataset.searchSource=source.id;pick.setAttribute('aria-pressed',String(active===source.id));nav.append(pick);
      }
      const add=action('添加搜索源',async()=>{try{await autoSave?.flush();active=null;draw();}catch(error){fail(view,error);}});add.className='search-source-add';add.setAttribute('aria-pressed',String(active===null));nav.append(add);
    }
    function draw(){
      if(disposed||view.life.closed)return;autoSave?.dispose();autoSave=null;drawNav();editor.replaceChildren();view.feedback.textContent='';view.feedback.classList.remove('error');
      const source=sources().find(item=>item.id===active),draft=draftFor(source);
      for(const[key,label,type]of [['name','名称','text'],['baseUrl','接口地址','url'],['apiKey','API Key（可空）','password']]){
        const wrap=node('label','setting-field'),input=node('input');input.type=type;input.name=key;input.value=draft[key];input.autocomplete=type==='password'?'new-password':'off';
        if(key==='apiKey'){input.disabled=source?.keySupported===false;input.placeholder=input.disabled?'此搜索源无需 API Key':source?.hasApiKey?'已配置；留空保留现有密钥':'可留空';}
        input.addEventListener('input',()=>{draft[key]=input.value;draft.dirty=true;onDraftChange();autoSave?.schedule();});wrap.append(node('span','',label),input);editor.append(wrap);
      }
      async function persistCurrent(){
        if(busy)return false;const snapshot={...draft};setBusy(view,true);view.feedback.textContent='';view.feedback.classList.remove('error');try{const id=await persist(source,snapshot);if(disposed||view.life.closed)return;const unchanged=['name','baseUrl','apiKey'].every(key=>draft[key]===snapshot[key]);if(unchanged){draft.apiKey='';draft.dirty=false;const key=editor.querySelector('[name=apiKey]');if(key)key.value='';}active=id;refresh();if(!source)saveFeedback('saved','已添加');if(!source){drafts.delete('add');draw();}else drawNav();}catch(error){fail(view,error);return false;}finally{if(!view.life.closed){setBusy(view,false);const key=editor.querySelector('[name=apiKey]');if(key&&source?.keySupported===false)key.disabled=true;}}
      }
      const actions=node('div','actions'),commitButton=action(source?'保存搜索源':'添加搜索源',persistCurrent);commitButton.hidden=!!source;commitButton.className='primary';actions.append(commitButton);
      if(source){autoSave=createAutoSave({root:editor,save:persistCurrent,dirty:()=>draft.dirty,onError:error=>fail(view,error)});view.autoSave=autoSave;}
      if(source?.hasApiKey&&source.keySupported){const clear=destructiveButton('清除密钥',async()=>{
        if(draft.dirty)throw Error('请先保存名称和接口地址，再清除密钥');setBusy(view,true);try{await persist(source,{...draft,apiKey:''},true);if(disposed||view.life.closed)return;drafts.delete(source.id);draw();view.feedback.textContent='密钥已清除';}finally{if(!view.life.closed)setBusy(view,false);}
      },{clicks:3,target:()=>editor,key:()=>source.id,impact:`将清除 ${source.name} 的 API Key。`});actions.append(clear);}
      if(source?.customId)actions.append(destructiveButton('删除搜索源',async()=>{
        setBusy(view,true);try{await save();if(disposed||view.life.closed)return;await request('DELETE','/api/search-providers',{id:source.customId});await refreshCustom();if(read('webSearch.provider')===source.id)await commit([{path:'webSearch.provider',value:'bing'}]);if(disposed||view.life.closed)return;drafts.delete(source.id);active=sources()[0]?.id;refresh();draw();}finally{if(!view.life.closed)setBusy(view,false);}
      },{clicks:3,target:()=>editor,key:()=>source.id,impact:`将删除搜索源 ${source.name} 及其密钥。`}));
      editor.append(actions);onDraftChange();
    }
    draw();try{await refreshCustom();if(!disposed&&!view.life.closed){drawNav();}}catch(error){fail(view,error);}
  }
  const leave=()=>dispose();doc.defaultView.addEventListener('pagehide',leave,{once:true});
  function dispose(){if(disposed)return;disposed=true;++customVersion;for(const view of[picker,manager])if(view){for(const key of view.root.querySelectorAll('input[type=password]'))key.value='';view.life.dispose();}drafts.clear();doc.defaultView.removeEventListener('pagehide',leave);}
  refresh();return{choice,manage,refresh,dispose,get dirty(){return !busy&&[...drafts.values()].some(draft=>draft.dirty);}};
}
