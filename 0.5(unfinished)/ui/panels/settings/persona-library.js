import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createAutoSave,flushAutoSaves,saveFeedback} from './auto-save.js';
import {createConditionalMotion} from './conditional-motion.js';
import {bindDestructiveAction} from '../ui.js';

const STYLE_FIELDS=['roleText','customRules','participation','systemPromptOverride'];
const same=(persona,template)=>persona?.roleText===template?.text&&(persona?.customRules??'')===(template?.customRules??'');

// The default presentation uses the selected template/controller APIs and the
// original settings transaction. No second runtime persona policy lives here.
export function mountPersonaLibrary({host,read,commit,save,request,onDraftChange=()=>{},onIdle=()=>{},doc=host.ownerDocument}){
  const visibility=createConditionalMotion(doc);
  let disposed=false,templates=[],inventory={chats:[]},global=read('persona')??{},unified=read('personaUnified')!==false,readVersion=0,revision=0,manager=null,operation=0;
  const dialogs=new Set(),names=new Map(),drafts=new Map();
  let pendingUnified=null,switchingUnified=false;
  const node=(tag,cls,value)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(value!==undefined)el.textContent=value;return el;};
  const action=(label,run,cls='')=>{const el=node('button',cls,label);el.type='button';el.addEventListener('click',()=>Promise.resolve().then(run).catch(error=>{feedback.textContent=error.message;}));return el;};
  const toolbar=node('div','persona-library-toolbar'),toggle=action('统一人设',switchUnified,'persona-unified-toggle'),manage=action('人设管理',()=>openManager()),list=node('div','persona-binding-list'),feedback=node('p','persona-library-feedback');
  const filter=node('input','persona-binding-filter'),empty=node('p','muted persona-binding-empty','没有匹配的会话');filter.type='search';filter.placeholder='搜索群聊、好友或 QQ 号';filter.setAttribute('aria-label','筛选会话人设');empty.setAttribute('role','status');empty.hidden=true;
  toggle.setAttribute('role','switch');toggle.setAttribute('aria-controls','persona-binding-list');manage.setAttribute('aria-haspopup','dialog');manage.dataset.settingsOpen='persona-manager';list.id='persona-binding-list';feedback.setAttribute('role','status');toolbar.append(toggle,manage);host.append(toolbar,filter,list,empty,feedback);
  function filterRows(){
    const query=filter.value.trim().toLocaleLowerCase();let count=0;
    for(const entry of list.children){const matches=entry.dataset.personaBinding==='global'||`${entry.dataset.personaBinding} ${entry.textContent}`.toLocaleLowerCase().includes(query);entry.classList.toggle('persona-binding-filtered',!matches);if(matches&&entry.dataset.personaBinding!=='global')++count;}
    empty.hidden=unified||!query||count>0;
  }
  filter.addEventListener('input',filterRows);
  function labelFor(persona,id,name){
    const explicit=templates.find(item=>item.id===id&&same(persona,item));
    return explicit?.name||templates.find(item=>same(persona,item))?.name||name||'当前自定义人设';
  }
  function draw(){
    if(disposed)return;toggle.setAttribute('aria-checked',String(unified));
    const rows=[{chatKey:'global',title:'全局人设'},...(inventory.chats??[])],wanted=new Set(rows.map(row=>row.chatKey));
    for(const child of [...list.children])if(!wanted.has(child.dataset.personaBinding))child.remove();
    for(const row of rows){
      let entry=[...list.children].find(el=>el.dataset.personaBinding===row.chatKey);
      if(!entry){entry=node('div','persona-binding-row');entry.dataset.personaBinding=row.chatKey;const pick=action('',()=>openPicker(entry.dataset.personaBinding),'persona-binding-choice'),name=node('span','persona-binding-name');pick.setAttribute('aria-haspopup','dialog');entry.append(pick,name);list.append(entry);}
      const isGlobal=row.chatKey==='global',custom=!isGlobal&&row.overriddenFields.length>0,title=isGlobal?'全局人设':names.get(row.chatKey)||row.title;
      entry.children[0].textContent=`${custom?'● ':''}${title}`;entry.children[0].classList.toggle('has-custom',custom);
      entry.children[0].title=isGlobal?'选择全局人设':`${title} · ${row.chatKey}`;
      entry.children[1].textContent=isGlobal?labelFor(global,global.templateId,global.templateName):custom?labelFor(row.values,row.templateId,row.templateName):'跟随全局';entry.title=(isGlobal?global:row.values)?.roleText?.slice(0,240)||'';
      if(!isGlobal)visibility.set(entry,!unified);
    }
    visibility.set(filter,!unified&&(inventory.chats??[]).length>0);filterRows();
  }
  async function switchUnified(){
    // Reverse the visible transition immediately. Serialize writes so a late
    // acknowledgement cannot undo the user's latest rapid click.
    ++revision;++readVersion;pendingUnified=!(pendingUnified??unified);unified=pendingUnified;draw();
    if(switchingUnified)return;switchingUnified=true;
    try{
      while(!disposed&&pendingUnified!==null){const value=pendingUnified;await commit([{path:'personaUnified',value}]);if(pendingUnified===value)pendingUnified=null;sync();}
    }catch(error){pendingUnified=null;sync();throw error;}
    finally{switchingUnified=false;}
    if(!disposed)await refresh();
  }
  function sync(){if(disposed)return;global=read('persona')??{};unified=pendingUnified??(read('personaUnified')!==false);draw();}
  async function refresh(){
    const version=++readVersion,atRevision=revision;
    try{
      const [catalog,chats,cfg]=await Promise.all([request('GET','/api/persona-templates'),request('GET','/api/persona-by-chat'),request('GET','/api/config')]);
      if(disposed||version!==readVersion||atRevision!==revision)return;
      templates=catalog.templates??[];inventory=chats;global=cfg.persona??{};unified=pendingUnified??(cfg.personaUnified!==false);draw();manager?.drawNav();
    }catch(error){if(!disposed&&version===readVersion)feedback.textContent=`读取人设失败：${error.message}`;}
  }
  async function enrich(){
    const responses=await Promise.allSettled([request('GET','/api/chats'),request('GET','/api/onebot/groups'),request('GET','/api/onebot/friends')]);if(disposed)return;
    const [chats,groups,friends]=responses.map(result=>result.status==='fulfilled'?result.value??{}:{});
    for(const item of chats.chats??[])if(item.chatKey&&item.chatName)names.set(item.chatKey,String(item.chatName));
    for(const item of groups.groups??[])if(item.id&&item.name)names.set(`group:${item.id}`,String(item.name));
    for(const item of friends.friends??[])if(item.id&&(item.remark||item.nickname||item.name))names.set(`private:${item.id}`,String(item.remark||item.nickname||item.name));draw();
  }
  function shell(title,kind){
    const root=node('dialog',`persona-library-dialog ${kind}`),head=node('div','settings-dialog-head'),body=node('div','settings-dialog-body'),status=node('p','persona-library-status');let busy=false;
    root.dataset.settingsEditor=kind;status.setAttribute('role','status');head.append(node('h3','',title),action('关闭',()=>life.close()));root.append(head,body,status);
    const life=installDisposableDialog(root,{dismissOnBackdrop:true,beforeClose:()=>flushAutoSaves(root),onClosed:()=>{view.onClosed?.();dialogs.delete(view);if(manager===view){manager=null;drafts.clear();onDraftChange();}onIdle();}});
    const view={root,body,status,life,get busy(){return busy;},setBusy(value){busy=value;for(const el of root.querySelectorAll('button,input,textarea'))el.disabled=el.dataset.personaReadonly==='true'||el.tagName==='BUTTON'&&value;onDraftChange();}};
    dialogs.add(view);doc.body.append(root);root.showModal();return view;
  }
  async function openPicker(key){
    const token=++operation;await save();if(disposed||token!==operation)return;
    const view=shell(key==='global'?'选择全局人设':`选择${names.get(key)||inventory.chats.find(row=>row.chatKey===key)?.title||key}的人设`,'persona-selector');
    try{
      const [catalog,current]=await Promise.all([request('GET','/api/persona-templates'),key==='global'?request('GET','/api/config'):request('GET',`/api/persona-by-chat/${key.replace(':','_')}`)]);
      if(disposed||view.life.closed)return;templates=catalog.templates??templates;
      const grid=node('div','persona-option-grid');
      if(key!=='global'&&current.scope==='legacy-shared')view.body.append(node('p','muted','这份旧版人设由同号群聊与私聊共用，选择后会同时生效。'));
      for(const template of [...(key==='global'?[]:[{id:null,name:'跟随全局'}]),...templates]){
        const pick=action(template.name,async()=>{
          if(view.busy||view.life.closed)return;view.setBusy(true);view.status.textContent='正在保存…';
          try{
            if(key==='global'){
              await commit([{path:'persona.roleText',value:template.text},{path:'persona.customRules',value:template.customRules??''},{path:'persona.systemPromptOverride',value:''},{path:'persona.templateId',value:template.id},{path:'persona.templateName',value:template.name}]);
            }else{
              const patch={roleText:template.text??'',customRules:template.customRules??'',participation:'',systemPromptOverride:''};
              const body={storageKey:current.storageKey,sourceGuard:current.sourceGuard,patch,expected:Object.fromEntries(STYLE_FIELDS.map(field=>[field,current.revisions[field]])),...(current.scope==='legacy-shared'?{shared:true}:{}),...(current.selectionRevision?{selection:{id:template.id,revision:template.revision,expected:current.selectionRevision}}:{})};
              await request('PUT',`/api/persona-by-chat/${key.replace(':','_')}`,body);
            }
            ++revision;if(disposed||view.life.closed)return;await refresh();saveFeedback('saved');view.setBusy(false);view.life.close();
          }catch(error){if(!disposed&&!view.life.closed){view.status.textContent=`${error.message}；设置未完成，请重新打开后重试`;view.setBusy(false);}}
        },'persona-option');pick.dataset.personaOption=template.id??'follow-global';
        const selected=key==='global'?same(current.persona,template):template.id===null?!current.overriddenFields.length:current.templateId?current.templateId===template.id:same(current.values,template);
        pick.setAttribute('aria-pressed',String(selected));grid.append(pick);
      }
      view.body.append(grid);
    }catch(error){if(!view.life.closed)view.status.textContent=error.message;}
  }
  async function openManager(){
    if(manager&&!manager.life.closed){manager.root.focus();return;}
    const view=manager=shell('人设管理','persona-manager'),layout=node('div','persona-library-layout'),nav=node('nav','persona-library-nav'),editor=node('div','persona-library-editor');nav.setAttribute('aria-label','已添加的人设');layout.append(nav,editor);view.body.append(layout);let active=null;
    let autoSave=null;
    const navEntries=new Map(),navBindings=new Set(),add=action('添加人设',async()=>{await autoSave?.flush();active=null;drawEditor();},'persona-library-add');add.dataset.personaAdd='';
    view.onClosed=()=>{autoSave?.dispose();for(const binding of navBindings)binding.dispose();navBindings.clear();navEntries.clear();};
    const currentGlobal=()=>({id:'current-global',name:'当前全局人设',text:global.roleText??'',customRules:global.customRules??'',currentGlobal:true});
    const available=()=>[...(!templates.some(item=>same(global,item))?[currentGlobal()]:[]),...templates];
    function drawNav(){
      if(view.life.closed)return;const items=available(),wanted=new Set(items.map(item=>item.id)),nodes=[];
      for(const[id,entry]of navEntries)if(!wanted.has(id)){if(!entry.deleting){entry.binding?.dispose();navBindings.delete(entry.binding);}entry.row.remove();navEntries.delete(id);}
      for(const template of items){
        let entry=navEntries.get(template.id);
        if(!entry){
          const row=node('div','persona-library-nav-item'),pick=action('',async()=>{await autoSave?.flush();active=template.id;drawEditor();});pick.dataset.personaEntry=template.id;row.append(pick);
          entry={row,pick,template,deleting:false};navEntries.set(template.id,entry);
          if(!template.builtin&&!template.currentGlobal){
            const remove=node('button','persona-library-remove','删除');remove.dataset.personaDelete=template.id;row.append(remove);entry.remove=remove;
            entry.binding=bindDestructiveAction(remove,{action:()=>deleteTemplate(entry),target:()=>row,clicks:2,key:()=>`${entry.template.id}:${entry.template.revision}`,canActivate:()=>!disposed&&!view.busy&&!view.life.closed&&navEntries.get(template.id)===entry,impact:()=>`从人设库删除「${entry.template.name}」；已应用到全局和会话的内容保留。`,onError:error=>{if(!view.life.closed)view.status.textContent=`${error.message}；输入已保留`;}});
            navBindings.add(entry.binding);
          }
        }
        entry.template=template;entry.pick.textContent=template.name;entry.pick.setAttribute('aria-pressed',String(active===template.id));entry.pick.disabled=view.busy;
        if(entry.remove){entry.remove.title=`删除人设「${template.name}」`;entry.remove.setAttribute('aria-label',`删除人设 ${template.name}`);entry.binding.refresh();}
        nodes.push(entry.row);
      }
      add.setAttribute('aria-pressed',String(active===null));add.disabled=view.busy;nodes.push(add);
      nodes.forEach((el,index)=>{if(nav.children[index]!==el)nav.insertBefore(el,nav.children[index]??null);});
    }
    view.drawNav=drawNav;
    async function deleteTemplate(entry){
      const selected=entry.template;entry.deleting=true;view.setBusy(true);view.status.textContent='正在删除…';
      try{
        const result=await request('DELETE',`/api/persona-templates/${encodeURIComponent(selected.id)}`,{expected:selected.revision});
        ++revision;if(disposed||view.life.closed)return;templates=result.templates??templates;drafts.delete(selected.id);
        if(active===selected.id){active=available()[0]?.id??null;drawEditor();}else drawNav();
        await refresh();if(!view.life.closed)view.status.textContent='人设已删除；已应用到全局和会话的内容保留';
      }finally{entry.deleting=false;if(!view.life.closed)view.setBusy(false);}
    }
    function drawEditor(){
      if(disposed||view.life.closed)return;autoSave?.dispose();autoSave=null;drawNav();editor.replaceChildren();view.status.textContent='';
      const template=available().find(item=>item.id===active),key=template?.id??'new';
      if(!drafts.has(key))drafts.set(key,{name:template?.name??'',text:template?.text??'',customRules:template?.customRules??'',expected:template?.revision,version:0,dirty:false});
      const draft=drafts.get(key),inputs={};
      for(const [field,label,max] of [['name','人设名称',50],['text','角色与性格',20000],['customRules','回复规则',10000]]){
        const wrap=node('label','setting-field'),input=node(field==='name'?'input':'textarea');input.name=field;input.maxLength=max;input.value=draft[field];if(field!=='name')input.rows=field==='text'?12:4;
        input.dataset.personaReadonly=String(template?.builtin===true||template?.currentGlobal===true&&field==='name');input.disabled=input.dataset.personaReadonly==='true';
        input.addEventListener('input',()=>{draft[field]=input.value;draft.dirty=true;++draft.version;onDraftChange();autoSave?.schedule();});wrap.append(node('span','',label),input);editor.append(wrap);inputs[field]=input;
        if(field==='customRules')wrap.append(node('small','muted','设置机器人回复时需要遵循的系统指令，例如“回答尽量简短”。可留空。'));
      }
      if(template?.builtin)editor.append(node('p','muted','出厂人设只读。点击左侧“添加人设”可从空白创建自己的提示词。'));
      async function persistPersona(){
        if(view.busy||view.life.closed)return false;if(!draft.name.trim()||!template?.currentGlobal&&!draft.text.trim()){view.status.textContent='请填写人设名称和提示词';return false;}
        const version=draft.version,sent={name:draft.name,text:draft.text,customRules:draft.customRules,...(template?.revision?{expected:draft.expected}:{})};view.setBusy(true);view.status.textContent='正在保存…';
        try{
          let result;
          if(template?.currentGlobal){await commit([{path:'persona.roleText',value:sent.text},{path:'persona.customRules',value:sent.customRules},{path:'persona.templateId',value:''},{path:'persona.templateName',value:''}]);global=read('persona')??global;}
          else result=await request(template?'PUT':'POST',template?`/api/persona-templates/${encodeURIComponent(template.id)}`:'/api/persona-templates',sent);
          ++revision;if(disposed||view.life.closed)return;
          if(result)templates=result.templates??templates;
          const latest=templates.find(item=>item.id===template?.id);if(latest?.revision)draft.expected=latest.revision;
          if(draft.version===version){draft.dirty=false;if(!template){drafts.delete(key);active=result?.created??null;drawEditor();}}
          await refresh();if(!view.life.closed){view.status.textContent='';drawNav();}if(!template)saveFeedback('saved','已添加');
        }catch(error){if(!disposed&&!view.life.closed)view.status.textContent=error.message;return false;}
        finally{if(!view.life.closed)view.setBusy(false);}
      }
      const submit=action(template?'保存人设':'添加人设',persistPersona,'primary');submit.hidden=!!template;submit.disabled=template?.builtin===true;submit.dataset.personaReadonly=String(template?.builtin===true);editor.append(submit);
      if(template&&!template.builtin)autoSave=createAutoSave({root:editor,save:persistPersona,dirty:()=>draft.dirty});
    }
    try{await refresh();if(disposed||view.life.closed)return;active=available()[0]?.id??null;drawEditor();}catch(error){view.status.textContent=error.message;drawEditor();}
  }
  function closeEditors(){++operation;for(const view of [...dialogs].reverse())view.life.close();}
  function dispose(){disposed=true;++readVersion;++operation;visibility.dispose();for(const view of [...dialogs].reverse())view.life.dispose();dialogs.clear();drafts.clear();}
  sync();void refresh();void enrich();return{sync,refresh,closeEditors,dispose,get dirty(){return !!manager&&!manager.busy&&[...drafts.values()].some(draft=>draft.dirty);}};
}
