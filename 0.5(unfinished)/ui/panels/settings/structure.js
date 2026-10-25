import {installDisposableDialog} from '../dialog-lifecycle.js';
import {mountActivityView} from './activity-view.js';
import {mountQuietView} from './quiet-view.js';
import {allChatsAllowed} from '../chat-access.js';
import {modelChoiceLabel,modelId,modelLabel} from './model-catalog-data.js';
import {createSearchSources} from './search-sources.js';
import {mountPersonaLibrary} from './persona-library.js';
import {createConditionalMotion} from './conditional-motion.js';
import {mountSendSettings,mountCompactSettings,PROACTIVE_SETTING_HELP} from './send-settings.js';
import {flushAutoSaves} from './auto-save.js';
import {mountChoiceCards} from './choice-cards.js';
import {organizeSecurity} from './preference-layout.js';
import {createIcon} from '../icons.js';

// Presentation only: move the selected settings controls, never clone their
// values, save handlers, credential state or transaction controllers.
export const SETTINGS_SECTIONS = [
  ['onebot','QQ 连接'], ['models','模型'], ['access','响应范围'],
  ['persona','人设'], ['chat','聊天'], ['memory','记忆'], ['search','搜索'],
  ['tools','工具'], ['appearance','外观'], ['security','隐私与安全'], ['desktop','应用'],
];
export const canonicalSettingsSection = id => {
  const key=String(id??'').replace(/^#/, '').replace(/^section-/, '');
  return {api:'models',allow:'access',wake:'chat',send:'chat',active:'chat',prices:'models',uikit:'appearance'}[key] || key;
};

export function composeSettingsStructure({sections,host,read,write,request,save,reload,activityDraft,commitActivity,getProviders=()=>[],onActivityChange=()=>{},onIdle=()=>{},onEditorClosed=()=>{},doc=host.ownerDocument}) {
  let disposed=false;
  const editors=new Map(),refreshers=[],restorers=[],disposers=[];
  const visibility=createConditionalMotion(doc);disposers.push(visibility.dispose);
  const fieldsByPath=new Map();
  for(const el of host.querySelectorAll('.setting-field[data-path]'))if(!fieldsByPath.has(el.dataset.path))fieldsByPath.set(el.dataset.path,el);
  const watch=(keys,run)=>{run.keys=keys;refreshers.push(run);};
  const node=(tag,cls,value)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(value!==undefined)el.textContent=value;return el;};
  const action=(label,run)=>{const el=node('button','',label);el.type='button';el.addEventListener('click',run);return el;};
  const iconAction=(name,label,run)=>{const el=action('',run);el.setAttribute('aria-label',label);el.title=label;el.append(createIcon(name,{size:18}));return el;};
  const field=path=>fieldsByPath.get(path);
  const group=(id,label)=>[...sections.get(id).card.querySelectorAll('[data-settings-label]')].find(el=>el.dataset.settingsLabel===label);
  const content=id=>{const entry=sections.get(id);entry.card.hidden=false;entry.card.classList.remove('card','settings-section');entry.card.classList.add('settings-subsection');entry.card.querySelector(':scope > .module-head').hidden=true;return entry.card;};
  function fold(parent,id,title,children,open=false){
    const box=node('details','settings-fold'),summary=node('summary','settings-fold-title',title),body=node('div','settings-fold-body');
    box.dataset.collapsible='';box.dataset.settingsGroup=`layout-${id}`;box.open=open;
    body.append(...children.filter(Boolean));box.append(summary,body);parent.append(box);return body;
  }
  function root(id,title,description){
    const card=node('article','card settings-section'),head=node('div','module-head'),text=node('div','module-text'),fields=node('div','settings-fields');
    card.id=`section-${id}`;text.append(node('h3','',title),node('p','muted',description));head.append(text);card.append(head,fields);
    return {card,fields,title,description,meta:head};
  }
  // Nodes outside #fields (persistent reset bindings / prompt preview) go back
  // before the next render clears the old layout.
  function borrow(el){if(!el)return null;const anchor=doc.createComment('settings structure');el.before(anchor);restorers.push(()=>anchor.replaceWith(el));return el;}
  function modal(parent,id,title,children,{summary,description=''}={}){
    const box=node('div','settings-launcher'),open=action(title,()=>show()),detail=node('p','muted'),parking=node('div','settings-editor-parking');
    parking.hidden=true;parking.append(...children.filter(Boolean));open.dataset.settingsOpen=id;open.setAttribute('aria-haspopup','dialog');
    box.append(open,detail,parking);parent.append(box);
    let life=null,dialog=null;
    const refresh=()=>{detail.textContent=summary?.()||'';detail.hidden=!detail.textContent;};refreshers.push(refresh);
    function show(){
      if(disposed)return;if(life&&!life.closed){dialog.focus();return;}
      const focus=doc.activeElement;dialog=node('dialog','settings-layout-dialog');dialog.dataset.settingsEditor=id;
      dialog.setAttribute('aria-labelledby',`settings-editor-${id}`);
      const head=node('div','settings-dialog-head'),heading=node('h3','',title),close=iconAction('close','关闭',()=>life.close());heading.id=`settings-editor-${id}`;
      head.append(heading,close);const body=node('div','settings-dialog-body');body.append(...parking.childNodes);
      const note=node('p','muted settings-dialog-note',description);note.hidden=!description;dialog.append(head,note,body);
      const status=doc.querySelector('#status'),feedback=node('p','muted settings-dialog-status'),footer=node('div','settings-dialog-footer');feedback.setAttribute('role','status');
      const syncStatus=()=>{feedback.textContent=status?.textContent||'';feedback.classList.toggle('field-error',status?.classList.contains('field-error')===true);};
      const observer=new doc.defaultView.MutationObserver(syncStatus);if(status)observer.observe(status,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});syncStatus();
      footer.append(feedback);
      feedback.hidden=true;footer.hidden=true;
      dialog.append(footer);
      life=installDisposableDialog(dialog,{dismissOnBackdrop:true,beforeClose:async()=>{await flushAutoSaves(dialog);await save?.();},onClosed:()=>{
        observer.disconnect();
        for(const input of body.querySelectorAll('[data-manager-key]')){input.type='password';input.value='';}
        for(const toggle of body.querySelectorAll('[data-manager-key-toggle]'))toggle.textContent='显示';
        parking.append(...body.childNodes);life=null;dialog=null;refresh();onEditorClosed(id);
        if(focus?.isConnected&&!doc.querySelector('dialog:modal'))focus.focus({preventScroll:true});
        if(!disposed&&!doc.querySelector('dialog[data-settings-editor][open]'))onIdle();
      }});
      doc.body.append(dialog);dialog.showModal();
    }
    const close=()=>{
      if(!dialog)return;
      // A render can also retire a parent while a nested picker is open.
      const stack=[...doc.querySelectorAll('dialog:modal')],index=stack.indexOf(dialog);
      if(index>=0)for(const nested of stack.slice(index+1).reverse())nested.close();
      life?.close();
    };
    editors.set(id,{show,close,box,parking,get open(){return !!dialog?.open;}});return editors.get(id);
  }
  function conditional(el,visible){el.dataset.settingsConditional='';visibility.set(el,visible);}
  const nav=new Map(SETTINGS_SECTIONS.map(([id,title])=>{
    const entry=sections.get(id)||root(id,title,id==='chat'?'发送、响应、活跃与表情。常用项内联，低频项展开编辑。':'协议地址与连接凭据。');
    entry.title=title;entry.card.querySelector('h3').textContent=title;
    return [id,entry];
  }));
  for(const [id,description] of [
    ['onebot','连接与管理 QQ 账号。'],
    ['models','主模型、多模态与模型参数。'],
    ['memory','后台整理、专用模型与自动发现阈值。'],
    ['access','选择允许响应的群聊和好友，或在选择窗口允许全部。'],
    ['desktop','启动行为、数据与版本更新。'],
    ['appearance','主题、背景与界面布局。'],
  ]){const entry=nav.get(id);entry.description=description;entry.card.querySelector('.module-text p').textContent=description;}

  // 模型 API: configuration and catalog each have one entrance.
  const models=nav.get('models'),endpoint=group('models','接入点'),sampling=group('models','采样与预算'),thinking=group('models','思考模式'),media=group('models','多模态输入');
  const fallback=field('api.fallbackModels'),modelActions=models.card.querySelector(':scope > .actions');
  const buttons=[...modelActions.children],take=label=>buttons.find(el=>el.textContent===label);
  const config=node('div','model-config-layout full'),main=node('div','model-config-main'),identity=node('p','muted model-config-identity'),inputs=node('div','model-media-inputs'),state=node('div','model-config-state');
  const mainPick=take('从目录选择主模型'),test=take('测试主模型');mainPick.setAttribute('aria-label','从目录选择主模型');mainPick.classList.add('model-config-picker');test.setAttribute('aria-label','测试主模型');test.textContent='测试连通性';main.append(mainPick,test);
  // Keep the existing form controls as hidden state; the compact view writes
  // through the same FormState rather than maintaining another configuration.
  state.hidden=true;state.append(...['api.baseUrl','api.provider','api.model','api.vision','api.video','api.visionModel','api.videoModel','api.visionProvider','api.videoProvider','skills.video-frames.enabled'].map(field),endpoint.querySelector('.main-credential'),fallback,field('api.modelPrices'));
  for(const[kind,label]of [['vision','图片输入'],['video','视频输入']]){
    const row=node('div','model-media-row'),toggle=action(label,()=>write(`api.${kind}`,read(`api.${kind}`)!==true)),pick=[...media.querySelectorAll('button')].find(el=>el.textContent===`选择${kind==='vision'?'图片':'视频'}模型`),slide=node('div','model-media-slide');
    row.dataset.modelMedia=kind;toggle.className='model-media-toggle';toggle.setAttribute('role','switch');pick.className='model-media-pick';pick.setAttribute('aria-label',`选择${kind==='vision'?'图片':'视频'}模型`);slide.dataset.motion='off';slide.append(pick);row.append(toggle,slide);inputs.append(row);
    watch([`api.${kind}`,`api.${kind}Model`,`api.${kind}Provider`,'api.provider','api.model'],()=>{
      const enabled=read(`api.${kind}`)===true,model=read(`api.${kind}Model`)||read('api.model'),provider=read(`api.${kind}Provider`)||read('api.provider');toggle.setAttribute('aria-checked',String(enabled));conditional(slide,enabled);pick.disabled=!enabled;pick.textContent=modelChoiceLabel(getProviders(),{provider,model});pick.title=pick.textContent;
    });
  }
  const videoMode=field('api.videoMode');
  config.append(node('h4','','当前模型'),main,identity,models.card.querySelector('#api-test-result'),inputs,videoMode,state);
  watch(['api.video'],()=>conditional(videoMode,read('api.video')===true));
  const updateConfig=()=>{const provider=read('api.provider'),model=read('api.model');const label=[...doc.querySelectorAll('.model-catalog-item')].find(item=>item.dataset.providerId===provider&&item.dataset.modelId===model)?.querySelector('.model-catalog-name')?.textContent;mainPick.textContent=label||model||'选择模型';identity.textContent=getProviders().find(item=>item.id===provider)?.displayName||provider||'';identity.title=read('api.baseUrl')||'';};
  watch(['api.provider','api.model','api.baseUrl'],updateConfig);
  models.fields.append(config);
  endpoint.remove();media.remove();
  const providerLayout=models.card.querySelector('#provider-manager-layout');
  const add=modal(providerLayout.querySelector('#provider-manager-actions'),'provider-add','添加渠道',[models.card.querySelector(':scope > .settings-editor')],{description:'填写渠道名称、Base URL 和 API Key，点击“添加渠道”。'});
  add.box.classList.add('provider-add-launcher');
  const modelManager=modal(models.fields,'model-manager','渠道与模型库',[providerLayout],{});
  const fallbackSummary=node('small','muted');watch(['api.fallbackModels'],()=>{fallbackSummary.textContent=(read('api.fallbackModels')||[]).map(item=>item.model).join(' → ')||'未设置';});
  fold(models.fields,'fallback','故障时使用的备选模型',[fallbackSummary,take('管理备选模型')]);
  const modelParameters=fold(models.fields,'model-parameters','模型参数',[sampling,thinking]);disposers.push(mountSendSettings(modelParameters,{id:'model-setting-tooltip'}).dispose);
  modelActions.remove();
  fold(models.fields,'prices','成本核算',[content('prices')]);

  // Keep the original fields once; the selected source editor commits through
  // the same settings transaction and custom-source controller.
  const search=nav.get('search'),sources=group('search','各源接口与密钥（高级）'),sourceFields=[...sources.querySelector(':scope > .settings-fields').children];
  const searchState=node('div','search-enabled-state'),searchProvider=field('webSearch.provider'),searchLimit=field('webSearch.maxResults');
  const searchToggle=action('联网搜索',()=>write('webSearch.enabled',read('webSearch.enabled')!==true));
  searchToggle.className='search-enabled-toggle';searchToggle.setAttribute('role','switch');searchToggle.setAttribute('aria-controls','search-service-options');searchLimit.id='search-max-results-option';
  searchState.hidden=true;searchState.append(field('webSearch.enabled'),searchProvider,field('webSearch.searchUrl'),...sourceFields,search.card.querySelector('#search-provider-list'),search.card.querySelector(':scope > .settings-editor'));
  const searchSources=createSearchSources({read,commit:commitActivity,save,request,doc,onDraftChange:onActivityChange}),searchRow=node('div','search-service-row full'),searchOptions=node('div','search-service-options full');
  searchOptions.id='search-service-options';searchOptions.dataset.motion='off';searchOptions.append(searchSources.choice,searchLimit);
  searchRow.append(searchToggle,searchSources.manage);search.fields.replaceChildren(searchRow,searchOptions,searchState);sources.remove();disposers.push(searchSources.dispose);
  watch(['webSearch'],searchSources.refresh);
  watch(['webSearch.enabled'],()=>{const enabled=read('webSearch.enabled')===true;searchToggle.setAttribute('aria-checked',String(enabled));conditional(searchOptions,enabled);});

  // Memory retains its short common path; advanced thresholds stay collapsed.
  const memory=nav.get('memory'),memoryModel=node('div','memory-model-choice'),consolidate=group('memory','记忆整理');
  const memoryFields=consolidate.querySelector(':scope > .settings-fields'),memoryState=node('div','memory-consolidate-state'),memoryRow=node('div','memory-consolidate-row full'),cooldown=node('div','memory-consolidate-cooldown');
  const memoryToggle=action('自动整理记忆',()=>write('memory.consolidateEnabled',read('memory.consolidateEnabled')!==true));
  memoryToggle.className='memory-consolidate-toggle';memoryToggle.setAttribute('role','switch');memoryToggle.setAttribute('aria-controls','memory-consolidate-cooldown');
  cooldown.id='memory-consolidate-cooldown';cooldown.dataset.motion='off';cooldown.append(field('memory.consolidateMinIntervalMs'));
  memoryState.hidden=true;memoryState.append(field('memory.consolidateEnabled'));memoryRow.append(memoryToggle,cooldown);memoryFields.prepend(memoryRow);memoryFields.append(memoryState);
  watch(['memory.consolidateEnabled'],()=>{const enabled=read('memory.consolidateEnabled')===true;memoryToggle.setAttribute('aria-checked',String(enabled));conditional(cooldown,enabled);});
  const memoryModelRow=node('div','memory-consolidate-row full'),useChatModel=action('共用聊天模型',()=>write('memory.useChatModel',read('memory.useChatModel')===false));
  useChatModel.className='memory-consolidate-toggle';useChatModel.setAttribute('role','switch');useChatModel.setAttribute('aria-controls','memory-model-choice');
  memoryState.append(field('memory.useChatModel'),field('memory.provider'),field('memory.model'));
  const memoryPick=[...consolidate.querySelectorAll('button')].find(el=>el.textContent==='选择整理专用模型');
  memoryPick.setAttribute('aria-label','选择整理专用模型');memoryModel.id='memory-model-choice';memoryModel.dataset.motion='off';memoryModel.append(memoryPick);memoryModelRow.append(useChatModel,memoryModel);memoryRow.after(memoryModelRow);
  watch(['memory.useChatModel'],()=>{const shared=read('memory.useChatModel')!==false;useChatModel.setAttribute('aria-checked',String(shared));conditional(memoryModel,!shared);});
  watch(['memory.provider','memory.model'],()=>{
    const id=modelId(read('memory.model')),provider=getProviders().find(item=>item.id===read('memory.provider')),entry=provider?.models?.find(item=>modelId(item)===id)??id;
    memoryPick.textContent=id?modelLabel(provider,entry):'选择整理专用模型';memoryPick.title=id?`${provider?.displayName||read('memory.provider')||'直接接入'} · ${id}`:'';
    memoryPick.setAttribute('aria-description',id?`当前模型：${memoryPick.textContent}，${memoryPick.title}`:'尚未选择专用模型');
  });

  // Keep legacy fields as one hidden form for existing consumers. The default
  // library owns the visible manager and uses the same selected controllers.
  const personaRoot=nav.get('persona'),personaLibraryHost=node('div','persona-library full');
  const personaLibrary=mountPersonaLibrary({host:personaLibraryHost,read,commit:commitActivity,save,request,onDraftChange:onActivityChange,onIdle,doc});
  if(personaLibrary){
    const parked=node('div','persona-library-state');parked.hidden=true;parked.append(...personaRoot.fields.childNodes,personaRoot.card.querySelector('#persona-template-manager'),personaRoot.card.querySelector('#persona-by-chat-manager'));
    personaRoot.fields.replaceChildren(personaLibraryHost,parked);watch(['persona','personaUnified'],personaLibrary.sync);disposers.push(personaLibrary.dispose);
  }else{
  // A replacement presentation may opt into the earlier inline editor.
  const persona=nav.get('persona'),unified=field('personaUnified'),global=node('div','settings-fields settings-persona-global');
  global.append(...[...persona.fields.children].filter(el=>el!==unified));
  fold(global,'persona-templates','人设模板',[persona.card.querySelector('#persona-template-manager')]);
  const personaToggle=action('所有会话使用统一人设',()=>write('personaUnified',read('personaUnified')===false)),personaState=node('div','persona-unified-state');
  personaToggle.className='persona-unified-toggle';personaToggle.setAttribute('role','switch');personaToggle.setAttribute('aria-controls','persona-unified-inline persona-by-chat-manager');
  personaState.hidden=true;personaState.append(unified);persona.fields.replaceChildren(personaToggle,personaState);
  const globalEditor=modal(persona.fields,'global-persona','全局人设设置',[global],{summary:()=>read('persona.botName')||'全局默认人设'});
  const inline=node('div','settings-persona-inline full');inline.id='persona-unified-inline';persona.fields.append(inline);
  const perChat=persona.card.querySelector('#persona-by-chat-manager');
  watch(['personaUnified'],()=>{
    const shared=read('personaUnified')!==false;
    personaToggle.setAttribute('aria-checked',String(shared));
    if(shared&&global.parentNode!==inline){globalEditor.close();inline.append(global);}
    if(!shared&&global.parentNode===inline)globalEditor.parking.append(global);
    conditional(globalEditor.box,!shared);conditional(inline,shared);conditional(perChat,!shared);
  });
  }

  // The user-managed protocol service only exposes explicit endpoints and tokens.
  const access=nav.get('access'),link=group('access','协议端连接'),deny=group('access','拒绝与屏蔽'),onebot=nav.get('onebot');onebot.fields.append(link);
  link.querySelector(':scope > .field-group-head').hidden=true;
  const localConnection=link.querySelector('[data-local-protocols]')?.parentElement,linkFields=link.querySelector(':scope > .settings-fields');
  if(localConnection&&linkFields)fold(linkFields,'manual-onebot','手动配置地址与令牌',[...linkFields.children].filter(child=>child!==localConnection));
  const connectionSummary=node('div','settings-inline-summary full'),connectionText=node('div'),connectionName=node('strong','','读取连接状态…'),connectionDetail=node('small'),connectionRefresh=iconAction('refresh','刷新连接状态',()=>refreshConnection());
  connectionRefresh.setAttribute('aria-label','刷新连接状态');connectionRefresh.title='刷新连接状态';connectionText.append(connectionName,connectionDetail);connectionSummary.append(connectionText,connectionRefresh);onebot.fields.prepend(connectionSummary);
  connectionSummary.dataset.phase='loading';
  let connectionRead=0;
  function showConnection(payload){
    if(disposed)return;
    const state=payload?.onebot||{},connected=state.connected===true,ready=connected&&state.transportReady!==false;
    connectionName.textContent=ready?(state.selfNickname||'QQ')+(state.selfId?` · ${state.selfId}`:''):connected?'正在验证账号…':'QQ 未连接';
    connectionSummary.dataset.connected=String(ready);
    connectionSummary.dataset.phase=ready?'ready':connected?'verifying':'idle';
    connectionDetail.textContent=ready?'当前查看的账号 · 已连接':connected?'等待账号验证':'点下方账号卡片连接，或添加 QQ';connectionDetail.title=state.diagnosis||state.connection?.wsUrl||'';
  }
  async function refreshConnection(){const ticket=++connectionRead;try{const payload=await request('GET','/api/status');if(ticket===connectionRead)showConnection(payload);}catch(error){if(!disposed&&ticket===connectionRead){connectionSummary.dataset.phase='error';connectionDetail.textContent=error.message;}}}
  void refreshConnection();
  const allowAll=field('allowAllWhenEmpty'),accessState=node('div','settings-access-state');accessState.hidden=true;accessState.append(allowAll,field('deny.groups'),field('deny.private'));access.fields.append(accessState);
  deny.querySelector(':scope > .field-group-head').remove();
  accessState.append(deny.querySelector('[data-blocklist-raw]'));
  watch(['allow','allow.groups','allow.private','allow.allGroups','allow.allPrivate','allowAllWhenEmpty'],()=>{
    const cfg={allow:read('allow'),allowAllWhenEmpty:read('allowAllWhenEmpty')};
    conditional(field('allow.groups'),!allChatsAllowed(cfg,'group'));conditional(field('allow.private'),!allChatsAllowed(cfg,'private'));
  });
  const accessButtons=[...access.card.querySelectorAll('button')];
  const groupsChoice=accessButtons.find(button=>button.textContent==='从QQ 群列表选择'),friendsChoice=accessButtons.find(button=>button.textContent==='从好友列表选择');
  for(const button of [groupsChoice,friendsChoice])if(button)button.classList.add('settings-scope-choice');
  fold(access.fields,'manual-access','手填号码',[field('allow.groups'),field('allow.private')]);
  watch(['allow','allowAllWhenEmpty'],()=>{const cfg={allow:read('allow'),allowAllWhenEmpty:read('allowAllWhenEmpty')};for(const[kind,button,path,label]of [['group',groupsChoice,'allow.groups','群聊'],['private',friendsChoice,'allow.private','好友']])if(button){button.textContent=allChatsAllowed(cfg,kind)?`✓ 全部${label}`:`${label} · ${(read(path)||[]).length}`;button.title='选择允许回复的'+label;}});

  // Chat: one expanded activity card, then compact low-frequency cards.
  const chat=nav.get('chat'),tier=group('wake','响应档位'),perGroup=group('wake','分群与峰谷（高级）'),timing=group('wake','时序与并发（高级）'),mute=group('wake','群指令安静模式');
  const params=node('div','settings-fields tier-params-fields'),history=field('store.historyCount');
  history.classList.add('tier-history-count');history.querySelector('.field-title').textContent='历史消息读取';history.append(node('span','tier-history-unit','条'));
  const chatActiveRow=node('div','chat-active-row'),chatActiveState=node('div','chat-active-state'),chatActiveOptions=node('div','chat-active-options');
  const chatActiveToggle=action('连续回复当前话题',()=>write('chatActive.enabled',read('chatActive.enabled')!==true));
  chatActiveToggle.className='chat-active-toggle';chatActiveToggle.setAttribute('role','switch');chatActiveToggle.setAttribute('aria-controls','chat-active-options');
  chatActiveOptions.id='chat-active-options';chatActiveOptions.dataset.motion='off';chatActiveOptions.append(field('chatActive.ttlMinutes'));
  chatActiveState.hidden=true;chatActiveState.append(field('chatActive.enabled'));chatActiveRow.append(chatActiveToggle,chatActiveOptions);
  params.append(field('store.keywords'),history,chatActiveRow,chatActiveState);
  watch(['chatActive.enabled'],()=>{const enabled=read('chatActive.enabled')===true;chatActiveToggle.setAttribute('aria-checked',String(enabled));conditional(chatActiveOptions,enabled);});
  const paramsEditor=modal(tier.querySelector(':scope > .settings-fields'),'tier-params','档位参数',[params]);
  const peak=field('store.peakSchedule.enabled'),peakAction=[...perGroup.querySelectorAll('button')].find(el=>el.textContent==='编辑峰谷时段与预设');
  const groupAction=[...sections.get('wake').card.querySelectorAll(':scope > button')];
  const activity=mountActivityView({read,draft:activityDraft,commit:commitActivity,onChange:onActivityChange,request,doc});watch(['store.contextSliderPos','store.unifiedTier','store.groupSliderPos','store.groupPeakPos','store.peakSchedule.enabled','store.peakSchedule.peak.sliderPos','store.peakSchedule.valley.sliderPos','allow','allow.groups','allow.allGroups','allowAllWhenEmpty'],activity.refresh);disposers.push(activity.dispose);
  const activityCard=node('section','activity-card settings-activity full'),activityHead=node('div','activity-heading'),activityBody=node('div','settings-fold-body'),activityInner=node('div','activity-inner'),activityControls=node('div','activity-head-controls');
  activityCard.dataset.settingsGroup='layout-activity';activityCard.append(activityHead,activityControls,activityBody);chat.fields.append(activityCard);activityBody.append(activityInner);activityInner.append(activity.host);
  const title=node('div','activity-title'),heading=node('h4','','回复频率'),badge=node('span','activity-badge');title.append(heading);
  const activityGlyph=node('div','activity-icon');activityGlyph.append(createIcon('activity',{size:20}));activityHead.replaceChildren(activityGlyph,title,badge);
  const peakControl=node('div','activity-peak-control'),activityUnified=field('store.unifiedTier');
  for(const wrap of [peak,activityUnified]){
    wrap.classList.remove('is-switch');wrap.classList.add('activity-switch');
    const track=node('span','activity-switch-track');track.append(node('span','activity-switch-thumb'));wrap.append(track);
  }
  peak.querySelector('.field-title').textContent='按时段';const editPeak=iconAction('clock','编辑回复时段',()=>peakAction.click());peakControl.append(peak,editPeak);
  activityControls.addEventListener('click',event=>event.stopPropagation());
  peak.querySelector('input').setAttribute('aria-label','启用峰谷自动切档');activityUnified.querySelector('.field-title').textContent='统一频率';activityUnified.querySelector('input').setAttribute('aria-label','所有群统一档位');activityUnified.append(activityUnified.querySelector('.field-title'));
  activityControls.append(node('span','activity-head-divider'),peakControl,paramsEditor.box,activityUnified);paramsEditor.box.querySelector('button').replaceChildren(createIcon('settings',{size:18}));paramsEditor.box.querySelector('button').setAttribute('aria-label','回复条件');paramsEditor.box.querySelector('button').title='关键词与连续回复';
  activity.bindHeader({badge,inputs:[['store.unifiedTier',activityUnified.querySelector('input')],['store.peakSchedule.enabled',peak.querySelector('input')]]});
  // Retain the original selected controls exactly once, with their bindings,
  // outside the visible legacy card. Raw JSON is not part of the 0.4 view.
  const activityState=node('div','activity-state');activityState.hidden=true;activityState.append(tier,...groupAction,perGroup,peakAction);activityBody.append(activityState);
  const send=content('send');send.querySelector(':scope > .settings-fields').prepend(timing);
  disposers.push(mountSendSettings(send).dispose);
  fold(chat.fields,'send','信息发送配置',[send]);
  const muteFields=mute.querySelector(':scope > .settings-fields'),muteState=node('div','command-mute-state'),muteOptions=node('div','settings-fields full command-mute-options');
  const muteToggle=action('用指令暂停回复',()=>write('commandMute.enabled',read('commandMute.enabled')!==true));
  muteToggle.className='command-mute-toggle full';muteToggle.setAttribute('role','switch');muteToggle.setAttribute('aria-controls','command-mute-options');muteOptions.id='command-mute-options';
  muteState.hidden=true;muteState.append(field('commandMute.enabled'),field('commandMute.active'));
  const quietView=mountQuietView({read,write,request,doc});disposers.push(quietView.dispose);
  muteOptions.append(...['commandMute.command','commandMute.durationMin'].map(field),quietView.element);
  muteFields.append(muteToggle,muteOptions,muteState);
  watch(['commandMute.enabled'],()=>{const enabled=read('commandMute.enabled')===true;muteToggle.setAttribute('aria-checked',String(enabled));conditional(muteOptions,enabled);});
  watch(['commandMute','allow','allowAllWhenEmpty'],()=>{field('commandMute.active').querySelector('textarea').value=JSON.stringify(read('commandMute.active')||{},null,2);quietView.refresh();});
  fold(chat.fields,'mute','指令暂停回复',[mute]);
  const proactive=content('active'),proactiveFields=proactive.querySelector(':scope > .settings-fields'),proactiveState=node('div','proactive-state'),proactiveOptions=node('div','settings-fields full proactive-options');
  const proactiveToggle=action('主动发起聊天',()=>write('proactive.enabled',read('proactive.enabled')!==true));
  proactiveToggle.className='proactive-toggle full';proactiveToggle.setAttribute('role','switch');proactiveToggle.setAttribute('aria-controls','proactive-options');proactiveOptions.id='proactive-options';proactiveOptions.dataset.motion='off';
  proactiveState.hidden=true;proactiveState.append(field('proactive.enabled'));proactiveOptions.append(...['proactive.probability','proactive.idleThresholdMs','proactive.checkIntervalMinMs','proactive.checkIntervalMaxMs'].map(field));
  const proactiveCompact=mountCompactSettings(proactiveOptions,{help:PROACTIVE_SETTING_HELP,id:'proactive-setting-tooltip'});disposers.push(proactiveCompact.dispose);
  proactiveFields.replaceChildren(proactiveToggle,proactiveOptions,proactiveState);
  watch(['proactive.enabled'],()=>{const enabled=read('proactive.enabled')===true;proactiveToggle.setAttribute('aria-checked',String(enabled));if(!enabled)proactiveCompact.hide();conditional(proactiveOptions,enabled);});
  fold(chat.fields,'proactive','主动发起聊天',[proactive]);
  const sticker=group('memory','表情');sticker.classList.add('sticker-settings');
  const stickerFields=sticker.querySelector(':scope > .settings-fields');
  for(const [path,quantity,id] of [['sticker.enabled','sticker.promptMaxStickers','sticker-context-options'],['sticker.collectEnabled','sticker.maxCollectPerHour','sticker-collect-options']]){
    const toggle=field(path),options=field(quantity),row=node('div','sticker-setting-row');
    toggle.classList.add('sticker-card-toggle');options.classList.add('sticker-setting-options');options.id=id;options.dataset.motion='off';toggle.querySelector('input').setAttribute('aria-controls',id);
    row.append(toggle,options);stickerFields.append(row);
    watch([path],()=>conditional(options,read(path)===true));
  }
  stickerFields.append(field('sticker.encourage'));
  fold(chat.fields,'sticker','表情包',[sticker]);
  deny.querySelector(':scope > .settings-fields > button').classList.add('settings-direct-action');
  chat.fields.append(...deny.querySelector(':scope > .settings-fields').children);deny.remove();

  // Desktop extras keep their original controllers, behind a single launcher.
  const desktop=nav.get('desktop');
  const appearance=nav.get('appearance');appearance.fields.append(field('ui.uikit.mode'),content('uikit'));
  const interfaceFields=node('div','settings-fields');interfaceFields.append(field('ui.showVision'));
  const general=node('div','settings-fields');general.append(field('server.autoStart'),field('server.closeToTray'));
  const generalCard=fold(desktop.fields,'desktop-general','桌面行为',[general],true);desktop.fields.prepend(generalCard.parentElement);
  fold(desktop.fields,'desktop-interface','界面',[interfaceFields]);
  const dataActions=node('div','actions');dataActions.append(...['#open-data','#reset'].map(selector=>borrow(doc.querySelector(selector))).filter(Boolean));
  const tokenManager=[...desktop.card.querySelectorAll(':scope > button')].find(el=>el.textContent==='管理控制台访问令牌');
  const connection=node('div','settings-fields');connection.append(field('server.port'));if(tokenManager)connection.append(tokenManager);
  fold(desktop.fields,'console-connection','控制台连接',[connection]);
  const dataFields=node('div','settings-fields');
  fold(desktop.fields,'data','数据管理',[dataFields,dataActions]);
  fold(desktop.fields,'desktop-update','版本更新',[desktop.card.querySelector('.settings-update')]);

  // Tool switches remain discoverable; large lists and prompt output are opt-in.
  const tools=nav.get('tools'),categories=[...tools.fields.children].filter(el=>el.dataset.path?.startsWith('tools.categories.'));
  tools.fields.append(field('extensions.hotReload'));
  fold(tools.fields,'tool-categories','工具类别',categories);
  const toolList=tools.card.querySelector('#tool-list'),toolSearch=node('input','settings-tool-search'),toolEmpty=node('p','settings-empty');toolEmpty.setAttribute('role','status');toolSearch.type='search';toolSearch.placeholder='搜索工具';toolSearch.setAttribute('aria-label','搜索工具');
  const filterTools=()=>{for(const item of toolList.children)item.hidden=!`${item.textContent} ${item.title}`.toLowerCase().includes(toolSearch.value.trim().toLowerCase());toolEmpty.hidden=[...toolList.children].some(item=>!item.hidden);toolEmpty.textContent=toolList.children.length?'没有匹配的工具':'暂无已注册工具';};
  toolSearch.addEventListener('input',filterTools);const toolObserver=new doc.defaultView.MutationObserver(filterTools);toolObserver.observe(toolList,{childList:true});disposers.push(()=>toolObserver.disconnect());filterTools();
  fold(tools.fields,'tool-list','工具列表',[toolSearch,toolList,toolEmpty],true);
  const diagnostic=[...tools.card.querySelectorAll(':scope>button')].find(button=>button.textContent==='诊断');fold(tools.fields,'tool-maintenance','工具维护',[field('extensions.hotReload'),diagnostic]);
  modal(nav.get('persona').fields,'prompt-preview','预览实际提示词',[borrow(doc.querySelector('.settings-preview'))],{});

  for(const [id,entry] of nav){
    const description=entry.card.querySelector('.module-text p');if(description){entry.card.querySelector('h3').title=description.textContent;description.hidden=true;}
    const meta=entry.meta;let no=meta.querySelector('.module-no');if(!no){no=node('span','module-no');meta.append(no);}
    no.textContent=String(SETTINGS_SECTIONS.findIndex(row=>row[0]===id)+1).padStart(2,'0');
  }
  organizeSecurity(nav.get('security'),field,doc);
  disposers.push(mountChoiceCards(field('ui.uikit.mode').querySelector('select'),{labels:{dark:'深色',light:'浅色'}}).dispose);
  host.replaceChildren(...[...nav.values()].map(entry=>entry.card));
  function refresh(changed){if(!disposed)for(const run of refreshers)if(!changed||!run.keys||run.keys.some(key=>key===changed||changed.startsWith(key+'.')))run();}refresh();
  return {
    sections:nav,canonical:canonicalSettingsSection,refresh,updateRuntime:showConnection,
    get searchDirty(){return searchSources.dirty;},
    get personaDirty(){return personaLibrary?.dirty===true;},refreshPersonas:()=>personaLibrary?.refresh(),
    activityDraft:activity.draft,saveActivity:activity.flush,get activityDirty(){return activity.dirty;},get activityVersion(){return activity.version;},activitySnapshot:activity.snapshot,discardActivity:activity.discard,
    closeEditors(){personaLibrary?.closeEditors();for(const editor of [...editors.values()].reverse())editor.close();},
    snapshot:()=>[...doc.querySelectorAll('dialog[data-settings-editor][open]')].map(dialog=>dialog.dataset.settingsEditor),
    restore(ids=[]){for(const id of ids)editors.get(id)?.show();},
    dispose(){if(disposed)return;disposed=true;for(const dispose of disposers)dispose();for(const editor of [...editors.values()].reverse())editor.close();for(const restore of restorers)restore();},
  };
}
