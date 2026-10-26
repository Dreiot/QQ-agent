import { request, onShellEvent, onLeave, onBeforeLeave, getViewState, onViewStateSnapshot, consoleUpdate, applyHostTheme, openVisualEditor, openConsoleTokenManager, openLocalProtocolPage, settingsSaveAvailable, settingsSaveState, saveSettings, contentReady } from '/panels/panel-client.js';
import {createLiveRefresh} from '../live-refresh.js';
import {currentAccountScope} from '../account-scope.js';
import { $, button, destructiveButton, bindDestructiveAction, clear, confirmAction, row, text } from '../ui.js';
import { PRESETS, DEFAULT_THEME, LIGHT_BASE, DARK_BASE, normalizeTheme, migrateUikit, resolveScheme, saveCustom, deleteCustom, renameCustom, PERSONALIZATION_FIELDS } from '../theme.js';
import {createIcon} from '../icons.js';
import {renderAppearanceControls} from './appearance-controls.js';
import { FormState, getPath } from './form-state.js';
import { createBackgroundEditor } from './bg-editor.js';
import {uploadBackgroundFile} from './background-upload.js';
import {isVideoBackground} from '../background-media.js';
import { editGroupResponse, editFallbacks, editModelPrices, editSearchProvider } from './spec-editors.js';
import { renderComponentPreview } from './component-preview.js';
import { createThemePreviewQueue } from '../theme-preview.js';
import {createProviderManager} from './provider-manager.js';
import { modelLabel, providerEndpointIdentity } from './model-catalog-data.js';
import { collapsibleExpanded } from '../collapsible.js';
import { openModelPicker } from './model-picker.js';

import { providerCredential } from './provider-credential.js';
import { mountUpdateStatus } from './update-status.js';

import { createPersonaTemplates } from './persona-templates.js';
import { createPersonaByChatUI } from './persona-by-chat.js';
import { mountKeywordEditor } from './keyword-editor.js';
import { openListChoice } from './list-choice.js';
import { allChatsAllowed } from '../chat-access.js';
import { createModelPriceEditor } from './model-prices.js';
import { createPriceTable } from './price-table.js';
import { mountCostView } from './cost-view.js';
import { createPeakPresetEditor } from './peak-presets.js';
import { createBlocklistMembers } from './blocklist-members.js';
import { createBlocklistRawEditor } from './blocklist-raw.js';
import {createSettingsSaveLifecycle} from './save-lifecycle.js';
import {composeSettingsStructure,SETTINGS_SECTIONS,canonicalSettingsSection} from './structure.js';
import {searchSourcePresets} from './search-sources.js';
import {createAutoSave,flushAutoSaves,hasAutoSaves,mountSaveFeedback,saveFeedback} from './auto-save.js';
import {mountSwitchCards} from './switch-cards.js';
import {organizeAppearance} from './appearance-layout.js';
import {renderAppearanceFeels} from './appearance-feels.js';
import {mountChoiceCards} from './choice-cards.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createLocalProtocols} from './local-protocols.js';

const disposeSaveFeedback=mountSaveFeedback();
const disposeSwitchCards=mountSwitchCards();
const localProtocols=createLocalProtocols({request,subscribe:onShellEvent,openPage:openLocalProtocolPage,beforeStart:saveAll,beforeDisconnect:async()=>{await flushAutoSaves();await saveAll();},onConnected:()=>{void load();}});
onLeave(()=>localProtocols.dispose());
window.addEventListener('pagehide',()=>localProtocols.dispose(),{once:true});
$('#reload').replaceChildren(createIcon('refresh',{size:18}));
let appearanceChoices=[];onLeave(()=>appearanceChoices.splice(0).forEach(dispose=>dispose()));
onLeave(()=>{disposeSwitchCards();disposeSaveFeedback();});

const themePreview = createThemePreviewQueue(applyHostTheme);
onLeave(() => { backgroundUploadLeaving = true; ++backgroundUploadVersion; void themePreview.flush().catch(() => {}); });
window.addEventListener('pagehide', () => themePreview.dispose());

const form = new FormState();
const status = $('#status');
const fieldsHost = $('#fields');
const invalid = new Map();
const saveLifecycle=createSettingsSaveLifecycle({form,invalid,sendState:settingsSaveState,saveRequest:saveSettings,request,extraGuard:()=>resetAccepted?'':hasAutoSaves()?'正在保存设置':providerManager?.dirty?'渠道修改尚未保存；请先保存或修正输入':settingsStructure?.searchDirty?'搜索源修改尚未保存；请保存或关闭编辑窗口':settingsStructure?.personaDirty?'人设修改尚未保存；请保存或关闭人设管理窗口':settingsStructure?.activityDirty?'活跃设置有未保存草稿；请保存或取消':(blocklistRaw.dirty||blocklistRaw.invalid)?'高级原始编辑尚未手动保存；请保存或放弃后再离开':'',paused:()=>!resetAccepted&&(resetting||resetPreparing)?'正在备份并提交重置；请等待结果后再离开':'',onError:error=>report(error.message,true)});
const saveLifecycleReady=settingsSaveAvailable().then(value=>saveLifecycle.enable(value));
const syncAutomaticState=()=>saveLifecycle.sync();
document.addEventListener('settings-autosave-state',syncAutomaticState);
onLeave(()=>document.removeEventListener('settings-autosave-state',syncAutomaticState));
let saveTimer = null;
let previousAppearance=null;
let refreshPalette=()=>{};
let disposeUpdates=()=>{};
onLeave(()=>disposeUpdates());
let disposePriceTable=()=>{};
onLeave(()=>disposePriceTable());
let costView=null;
onLeave(()=>costView?.dispose());
let disposeMainCredential = () => {};
onLeave(() => disposeMainCredential());
window.addEventListener('pagehide', () => disposeMainCredential());
let reloadConfirmation = false;
let resetting = false;
let resetPreparing = false;
let resetAccepted = false;
let acceptedResetReceipt = null;
let knownResetStatus = null, resetStatusVersion = 0, lastResetError = '';
const resetDisabled = new Map();
let saving = null;
let saveCommitRevision = 0;
let loading = false;
let disposed = false;
let renderedView = null;
let backgroundEditor = null;
let backgroundViewport={width:window.innerWidth,height:window.innerHeight};
let backgroundUploadVersion = 0;
let backgroundUploadMode = null;
let backgroundUploadImage = null;
let backgroundUploadFeedback = null;
let backgroundUploadLeaving = false;
let refreshBackgroundKit = null;
let providers = [];
let managerProvider=null;
let providerManager=null;
let providerReadVersion=0;
onLeave(()=>providerManager?.dispose());
window.addEventListener('pagehide',()=>providerManager?.dispose(),{once:true});
const modelPriceEditor=createModelPriceEditor({request,providers:()=>providers,beforeOpen:async()=>{await settingsEditorState;await save();}});
const peakPresetEditor=createPeakPresetEditor({request,beforeOpen:async()=>{await settingsEditorState;await save();}});
const blocklistMembers=createBlocklistMembers({request,beforeOpen:save,onSaved:async()=>{
  try{const current=await request('GET','/api/config');if(disposed)return;
    for(const name of ['blocklist','globalBlocklist','communityExemptions'])if(!form.pending.has(name)){
      form.mergeBase({...form.base,[name]:current[name]});const input=controls.get(name);
      if(input&&document.activeElement!==input)input.value=name==='blocklist'?JSON.stringify(current[name]??{},null,2):(current[name]??[]).join('\n');
    }
  }catch{/* The confirmed membership receipt remains valid. */}
}});
const blocklistRaw=createBlocklistRawEditor({request,onChange:()=>saveLifecycle.sync()});
onLeave(()=>blocklistRaw.dispose());
window.addEventListener('pagehide',()=>blocklistRaw.dispose(),{once:true});
onLeave(()=>blocklistMembers.dispose());
window.addEventListener('pagehide',()=>blocklistMembers.dispose(),{once:true});
const settingsEditorState=Promise.all([getViewState('priceDraft').then(value=>modelPriceEditor.restore(value)),getViewState('peakDraft').then(value=>peakPresetEditor.restore(value))]);
onViewStateSnapshot('priceDraft',()=>modelPriceEditor.snapshot());
onViewStateSnapshot('peakDraft',()=>peakPresetEditor.snapshot());
onLeave(()=>{modelPriceEditor.dispose();peakPresetEditor.dispose();});
window.addEventListener('pagehide',()=>{modelPriceEditor.dispose();peakPresetEditor.dispose();},{once:true});
const personaTemplates=createPersonaTemplates({
  request,
  readPersona:()=>({text:form.value('persona.roleText')??'',customRules:form.value('persona.customRules')??''}),
  onApply:async(template,{isCurrent})=>{
    if(!isCurrent())return;
    queue('persona.roleText',template.text);queue('persona.customRules',template.customRules??'');
    for(const [field,value] of [['persona.roleText',template.text],['persona.customRules',template.customRules??'']]){const input=controls.get(field);if(input)input.value=value;}
    await save();
  },
});
onLeave(()=>personaTemplates.dispose());
window.addEventListener('pagehide',()=>personaTemplates.dispose(),{once:true});
let personaMapReadVersion=0;
async function syncPersonaByChat(){
  const version=++personaMapReadVersion,saveRevision=saveCommitRevision;
  try{
    const current=await request('GET','/api/config');if(disposed||version!==personaMapReadVersion)return;
    if(saveRevision!==saveCommitRevision){void syncPersonaByChat();return;}
    if(!form.pending.has('personaByChat')){
      const next={...form.base,personaByChat:current.personaByChat??{}};if(![...form.pending.keys()].some(key=>key==='persona'||key.startsWith('persona.')))next.persona=current.persona;if(!form.pending.has('customPersonas'))next.customPersonas=current.customPersonas;form.mergeBase(next);const input=controls.get('personaByChat');
      if(input&&document.activeElement!==input)input.value=JSON.stringify(current.personaByChat??{},null,2);
    }
  }catch{/* A committed field save remains successful even if this optional read fails. */}
}
const personaByChat=createPersonaByChatUI({request,beforeOpen:save,onSaved:()=>{void syncPersonaByChat();}});
onLeave(()=>personaByChat.dispose());
window.addEventListener('pagehide',()=>personaByChat.dispose(),{once:true});
let tools = [];
let availability = [];
let toolAvailabilityReadVersion = 0;
let toolAvailabilityPending = false;
let searchProviders = [];
let visionResults = {}, visionReadVersion = 0, visionError = '';
let lastSavedAt = '';
const sections = new Map();
let settingsStructure=null;
let pendingConnectQQ=null;
function openAccountConnection(connectQQ){
  if(!settingsStructure||loading){pendingConnectQQ=connectQQ;return;}
  void localProtocols.openLogin(connectQQ===true?undefined:connectQQ).catch(error=>report(error.message,true));
}
let settingsReadDeferred=false;
// The appearance editor already reconciles remote changes with upload/picker
// generations. Keep that live path, including remote removal of a background.
const protectedSettingsDialog=()=>document.querySelector('dialog[open]:not([data-settings-editor="appearance"])');
const navigationSections=()=>settingsStructure?.sections||sections;
onLeave(()=>{settingsReadDeferred=false;settingsStructure?.dispose();});
window.addEventListener('pagehide',()=>settingsStructure?.dispose(),{once:true});
const controls = new Map();
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor', '__replace__']);
const secretKey = /apikey|api_key|accesstoken|access_token|cookie|password|secret|privatekey|private_key|^token$/i;

function report(message, failed = false) {
  text(status, message);
  status.className = failed ? 'field-error' : 'muted';
}
function hasFocusedSettingInput() {
  const active = document.activeElement;
  return (fieldsHost.contains(active)||active?.closest('dialog')) && (['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName) || active?.isContentEditable === true);
}
function empty(message) { const el = document.createElement('p'); el.className = 'muted'; text(el, message); return el; }
function output(target, result) { text(target, typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }
function safeJson(value, field) {
  if (!value.trim()) throw new Error(`请输入 JSON；清空请填写 ${field.endsWith('fallbackModels') ? '[]' : '{}'}`);
  const parsed = JSON.parse(value);
  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (unsafeKeys.has(key)) throw new Error('不允许 prototype/constructor/__replace__ 配置键');
      if (secretKey.test(key)) throw new Error('请使用专门的密钥输入框，JSON 编辑器不能写入密钥');
      scan(item);
    }
  };
  scan(parsed);
  if (field.endsWith('fallbackModels')) {
    if (!Array.isArray(parsed)) throw new Error('备选模型必须是数组');
  } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置映射必须是 JSON 对象');
  return parsed;
}
function queue(field, value, immediate = false, replace = false) {
  if (resetting || resetPreparing || resetAccepted) return;
  if(field.startsWith('ui.uikit')&&!previousAppearance)previousAppearance=structuredClone(migrateUikit(form.value('ui.uikit')));
  if(field.startsWith('ui.uikit')){const undo=document.querySelector('[aria-label="撤销本次外观调整"]');if(undo)undo.disabled=false;}
  form.set(field, value, { replace });
  if(field.startsWith('ui.uikit'))refreshPalette();
  settingsStructure?.refresh(field);
  costView?.refresh();
  saveLifecycle.sync();
  report('有未保存改动');
  saveFeedback('saving');
  clearTimeout(saveTimer);
  if (immediate && !reloadConfirmation) void save().catch((error) => report(error.message, true));
  else scheduleSave();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!reloadConfirmation && !resetting && !resetPreparing && !resetAccepted && form.dirty && !disposed) saveTimer = setTimeout(() => { void save().catch((error) => report(error.message, true)); }, 700);
}
function queueToolOverride(id, value) {
  form.setKey('tools.overrides', id, value);
  queue('tools.overrides', form.value('tools.overrides'));
}
async function save() {
  await saveLifecycleReady;
  clearTimeout(saveTimer);
  if (resetting || resetPreparing || resetAccepted) return;
  if (invalid.size) throw new Error(`请先修正：${[...invalid.values()].join('；')}`);
  if (saving) { await saving; if (form.dirty) return save(); return; }
  if (!form.dirty) return;
  saving = (async () => {
    let committed = false;
    try {
      while (form.dirty && !disposed && !resetting && !resetPreparing && !resetAccepted) {
        const snapshot = form.snapshot();
        const result = await saveLifecycle.save(snapshot);
        if(result.stale)throw new Error('更晚的设置保存已接管此版本，请重试读取');
        form.accept(snapshot, result.config);
        if(snapshot.fields.has('personaUnified'))void personaByChat.refresh();
        settingsStructure?.refresh('commandMute.active');
        costView?.refresh();
        saveLifecycle.sync();
        ++saveCommitRevision;
        committed = true;
        lastSavedAt = new Date().toLocaleTimeString('zh-CN');
        report(form.dirty ? '保存中…' : '');
        // Never rebuild the active form: input typed during the request belongs to a newer version.
        updateSecretStates();
      }
    } finally { if (committed) void refreshToolAvailability(); }
  })();
  try { await saving;if(!form.dirty&&!hasAutoSaves())saveFeedback('saved'); }
  catch(error){saveFeedback('error',`未保存 · ${error.message}`,()=>saveAll().catch(error=>report(error.message,true)));throw error;}
  finally { saving = null;if(settingsReadDeferred)liveSettings.request(); }
}
async function guarded(task, target = status) {
  try { return await task(); } catch (error) { text(target, error.message || '操作失败'); target.classList.add('field-error'); return null; }
}
// 原字段构造保持独立；所选结构模块将它们组合成九个可导航分区。
const SECTION_GROUPS = Object.fromEntries(SETTINGS_SECTIONS.map(([id])=>[id,'settings']));
const GROUP_LABELS = [['settings','设置分区']];
// 分区编号：仪表盘上的通道号，按声明顺序稳定分配（与分区 id 无关）。
const SECTION_ORDER = SETTINGS_SECTIONS.map(([id])=>id);
let activeSection = canonicalSettingsSection(location.hash.slice(1));
let sectionFilter = '';

function section(id, title, description) {
  const card = document.createElement('article');
  card.className = 'card settings-section';
  card.id = `section-${id}`;
  // 分区抬头：通道号 + 标题说明 + 右侧元信息（替代原来的裸 h3 + 裸 <p>）
  const head = document.createElement('div'); head.className = 'module-head';
  const text_ = document.createElement('div'); text_.className = 'module-text';
  const heading = document.createElement('h3'); text(heading, title);
  const meta = document.createElement('div'); meta.className = 'module-meta';
  const no = document.createElement('span'); no.className = 'module-no';
  no.textContent = String(SECTION_ORDER.indexOf(id) + 1).padStart(2, '0');
  meta.append(no);
  text_.append(heading, empty(description));
  head.append(text_, meta);
  const fields = document.createElement('div'); fields.className = 'settings-fields'; card.append(head, fields);
  sections.set(id, { card, fields, title, description, meta });
  fieldsHost.append(card);
  return { card, fields };
}

/** 字段小节：把一批相关字段切一段，避免十几项平铺在一起。
 *  opts.fold：低频/高级项收进可折叠组（默认收起），主路径字段不被淹。 */
function group(parent, label, opts = {}) {
  const box = document.createElement(opts.fold ? 'details' : 'div'); box.className = 'field-group' + (opts.fold ? ' fold-group' : '');
  box.dataset.settingsLabel=label;
  if (opts.fold) box.dataset.collapsible = '';
  if (opts.fold && opts.key) box.dataset.settingsGroup = opts.key;
  if (opts.fold && opts.open) box.open = true;
  const head = document.createElement(opts.fold ? 'summary' : 'div'); head.className = 'field-group-head'; text(head, label);
  const fields = document.createElement('div'); fields.className = 'settings-fields';
  box.append(head, fields); parent.append(box);
  return fields;
}

/** The native checkbox exposes checked state; cards provide the visual mark. */
function switchPill(input) {
  const pill = document.createElement('span'); pill.className = 'switch-state';
  pill.setAttribute('aria-hidden','true');
  return pill;
}

/** 更新分区抬头右侧的字段计数（元信息，不是装饰）。 */
function refreshSectionMeta() {
  for (const [id, entry] of sections) {
    const holder = entry.meta?.querySelector('.section-field-count');
    if (holder) holder.textContent = String(entry.fields.querySelectorAll('.setting-field').length).padStart(2, '0');
  }
}

/** 构建左侧通道条（分组 + 编号 + 状态灯 + 说明摘要）。 */
function buildSectionNav() {
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  clear(sidebar);
  const ordered = GROUP_LABELS
    .map(([gid, label]) => [gid, label, [...navigationSections().entries()].filter(([id]) => SECTION_GROUPS[id] === gid)])
    .filter(([, , items]) => items.length);
  const all = ordered.flatMap(([, , items]) => items.map(([id]) => id));
  if (!activeSection || !all.includes(activeSection)) activeSection = all[0] ?? '';
  // 筛选后当前项被藏起来时，自动落到第一个可见分区，避免出现"右侧空白"
  if (sectionFilter && !all.includes(activeSection)) activeSection = all[0] ?? '';

  for (const [, label, items] of ordered) {
    const visible = items.filter(([id]) => matchesFilter(id, items));
    if (!visible.length) continue;
    const groupEl = document.createElement('div'); groupEl.className = 'settings-group';
    const title = document.createElement('div'); title.className = 'settings-group-title'; text(title, label);
    groupEl.append(title);
    for (const [id, entry] of items) {
      const link = document.createElement('a');
      link.href = `#${entry.card.id}`; link.dataset.target = id;
      // 左侧：状态灯 + 通道竖条；右侧：编号 + 标题 + 说明摘要
      const mark = document.createElement('span'); mark.className = 'channel-mark';
      const led = document.createElement('span'); led.className = 'led is-idle';
      const bar = document.createElement('span'); bar.className = 'channel-bar';
      mark.append(led, bar);
      const body = document.createElement('span'); body.className = 'channel-text';
      const name = document.createElement('span'); name.className = 'channel-title';name.append(createIcon(({onebot:'link',models:'model',access:'chats',persona:'community',chat:'chats',management:'shield',memory:'memory',search:'search',tools:'skills',appearance:'contrast',security:'shield',desktop:'panel'})[id]||'panel',{size:18}),document.createTextNode(entry.title));
      const desc = document.createElement('span'); desc.className = 'channel-desc';
      text(desc, entry.description || '');
      body.append(name, desc);
      const no = document.createElement('span'); no.className = 'channel-no';
      no.textContent = String(SECTION_ORDER.indexOf(id) + 1).padStart(2, '0');
      link.append(mark, body, no);
      if (!matchesFilter(id, items)) link.classList.add('is-hidden');
      if (id === activeSection) {link.classList.add('is-active');link.setAttribute('aria-current','page');}
      link.addEventListener('click', (event) => { event.preventDefault(); selectSection(id); });
      groupEl.append(link);
    }
    sidebar.append(groupEl);
  }
  const emptyBox = $('#settings-sidebar-empty');
  if (emptyBox) emptyBox.hidden = sidebar.children.length > 0;
  renderSettingSearch();
  applySectionVisibility();
}

function settingSearchEntries(){
  const entries=[];
  for(const [id,section] of navigationSections()){
    entries.push({id,section:section.title,name:section.title,target:section.card,search:section.title.toLowerCase()});
    const seen=new Set();
    for(const target of section.card.querySelectorAll('.setting-field[data-path],.setting-field:has([data-config-path]),[data-settings-open],.settings-fold-title,.settings-compact-group>summary')){
      if(target.closest('[data-settings-search-exclude]'))continue;
      const label=target.querySelector('.field-title')?.textContent||target.closest('.send-setting-row')?.querySelector('.field-title')?.textContent||target.textContent;
      const name=String(label||'').trim();if(!name||seen.has(name))continue;seen.add(name);
      entries.push({id,section:section.title,name,target,search:`${name} ${target.dataset.path||''}`.toLowerCase()});
    }
  }
  return entries;
}
function renderSettingSearch(){
  const host=$('#settings-search-results');if(!host)return;host.replaceChildren();host.hidden=!sectionFilter;
  $('#settings-sidebar').hidden=!!sectionFilter;if(!sectionFilter)return;
  const matches=settingSearchEntries().filter(item=>item.search.includes(sectionFilter));
  $('#settings-sidebar-empty').hidden=matches.length>0;
  $('#settings-sidebar-empty').textContent='没有找到设置';
  for(const item of matches){
    const result=document.createElement('button');result.type='button';result.className='settings-search-result';
    const title=document.createElement('span'),category=document.createElement('small');title.textContent=item.name;category.textContent=item.section;result.append(title,category);
    result.addEventListener('click',()=>{
      sectionFilter='';$('#settings-filter').value='';activeSection=item.id;buildSectionNav();
      const parking=item.target.closest('.settings-editor-parking');parking?.parentElement.querySelector('[data-settings-open]')?.click();
      for(let parent=item.target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
      const target=item.target.getClientRects().length?item.target:navigationSections().get(item.id).card;
      target.scrollIntoView({block:'center'});target.classList.add('settings-focus-target');setTimeout(()=>target.classList.remove('settings-focus-target'),2000);
      const selected=target.querySelector('[role=radio][aria-checked=true]:not(:disabled)');
      (selected||[...target.querySelectorAll('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)')].find(control=>control.getClientRects().length))?.focus({preventScroll:true});
    });host.append(result);
  }
}

/** 分区是否命中筛选（标题或说明含关键词，大小写不敏感）。 */
function matchesFilter(id, items) {
  if (!sectionFilter) return true;
  const entry = navigationSections().get(id);
  const haystack = `${entry?.title ?? ''} ${entry?.description ?? ''} ${id} ${entry?.card.textContent||''}`.toLowerCase();
  return haystack.includes(sectionFilter);
}

/** 依据筛选结果决定分区 DOM 的显隐（而非重建 DOM，防抖窗口内的输入不会被吹掉）。 */
function applySectionVisibility() {
  for (const [id, entry] of navigationSections()) {
    const hidden = id !== activeSection;
    entry.card.hidden = hidden;
    // 分区抬头的状态灯跟着可见性走：可见=正常待机，不可见=熄灭
    const led = entry.card.querySelector('.led');
    if (led) led.className = `led ${hidden ? 'is-idle' : 'is-ok'}`;
  }
  for (const link of document.querySelectorAll('#settings-sidebar a[data-target]')) {
    const active=link.dataset.target === activeSection;link.classList.toggle('is-active',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
}

function selectSection(id) {
  id=canonicalSettingsSection(id);
  if (!navigationSections().has(id)) return;
  settingsStructure?.closeEditors();
  activeSection = id;
  applySectionVisibility();
  // 切换分区不重建 DOM，防抖窗口内的输入不会被吹掉，因此不需要 flush。
  const content = document.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
}const fieldIds = { 'api.baseUrl': 'base-url', 'api.model': 'model', 'api.apiKey': 'api-key' };
function field(parent, path, label, type = 'text', opts = {}) {
  const wrap = document.createElement('label'); wrap.className = `setting-field${type === 'textarea' || type === 'json' ? ' full' : ''}`;
  wrap.dataset.path = path;
  const title = document.createElement('span'); title.className = 'field-title'; text(title, label); wrap.append(title);
  let input;
  const value = form.value(path) ?? opts.default;
  if (type === 'select') {
    input = document.createElement('select');
    const options = [...(opts.options || [])];
    // 当前值不在候选里也留一个占位项：否则渲染瞬间就把它静默丢掉，用户没动等于清值
    if (value !== undefined && value !== null && value !== '' && !options.some(([v]) => String(v) === String(value))) options.push([value, `${value}（当前值）`]);
    for (const [optValue, titleText] of options) { const option = document.createElement('option'); option.value = String(optValue); text(option, titleText); input.append(option); }
  }
  else if (type === 'textarea' || type === 'json') { input = document.createElement('textarea'); input.rows = opts.rows || 3; }
  else { input = document.createElement('input'); input.type = type === 'list' ? 'text' : type; }
  input.id = fieldIds[path] || `field-${path.replaceAll('.', '-')}`;
  input.dataset.configPath = path;
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  if (opts.step !== undefined) input.step = String(opts.step);
  if (type === 'checkbox') input.checked = value === true;
  else if (type === 'json') input.value = JSON.stringify(value ?? {}, null, 2);
  else if (type === 'list') input.value = Array.isArray(value) ? value.join('，') : '';
  else if (type === 'number' && opts.valueScale && value != null) input.value = String(value / opts.valueScale);
  else input.value = String(value ?? '');
  const hint = document.createElement('small'); hint.className = 'field-hint'; text(hint, opts.hint || '');hint.hidden=true;if(opts.hint){title.title=opts.hint;input.setAttribute('aria-description',opts.hint);}
  const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
  input.addEventListener(type === 'select' || type === 'checkbox' ? 'change' : 'input', () => {
    try {
      let next;
      if (type === 'checkbox') next = input.checked;
      else if (type === 'number' || type === 'range') {
        next = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(next)) throw new Error(`${label}必须是有效数字`);
        if (opts.min !== undefined && next < opts.min || opts.max !== undefined && next > opts.max) throw new Error(`${label}超出允许范围`);
        if (opts.valueScale) { next = opts.valueScale>=1?Math.round(next * opts.valueScale):Number((next * opts.valueScale).toFixed(8)); if (!Number.isFinite(next)) throw new Error(`${label}必须是有效数字`); }
      } else if (type === 'json') next = safeJson(input.value, path);
      else if (type === 'list') {
        next = [...new Set(input.value.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean))];
        if (opts.numeric && next.some((item) => !/^\d{1,15}$/.test(item))) throw new Error('名单只能包含数字 QQ 号/群号');
      } else next = input.value;
      invalid.delete(path); error.hidden = true; input.removeAttribute('aria-invalid');
      // JSON object editors describe the entire map, including removed keys.
      // Ordinary scalar/child updates retain the server's recursive patch contract.
      queue(path, next, false, type === 'json' && !Array.isArray(next)); opts.onChange?.(next);
    } catch (cause) { invalid.set(path, cause.message); saveLifecycle.sync(); text(error, cause.message); error.hidden = false; input.setAttribute('aria-invalid', 'true'); clearTimeout(saveTimer); report('输入需要修正后才能保存', true); }
  });
  controls.set(path, input);
  if (type === 'checkbox') {
    // 勾选框 → 状态卡：整块内容框可点，亮色=开启 / 暗色=关闭（视觉见 common.css .is-switch）
    wrap.classList.add('is-switch');
    wrap.append(input, switchPill(input), hint, error);
  } else wrap.append(input, hint, error);
  parent.append(wrap); return input;
}
function secretField(parent, path, label, readEndpoint = null, query = undefined) {
  const wrap = document.createElement('div'); wrap.className = 'setting-field'; wrap.dataset.path = path;
  const title = document.createElement('span'); title.className = 'field-title'; text(title, label);
  const state = document.createElement('small'); state.className = 'secret-state'; state.dataset.secretPath = path;
  const line = document.createElement('div'); line.className = 'secret-controls';
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.id = fieldIds[path] || `secret-${path.replaceAll('.', '-')}`; input.placeholder = '输入新密钥；空白保留已有值';
  const reveal = document.createElement('div'); reveal.className = 'secret-revealed';
  const credentialSave=createAutoSave({root:wrap,dirty:()=>!!input.value.trim(),save:async()=>{
    const value=input.value.trim();if(!value)return;
    form.set(path,value);await save();if(input.value.trim()===value)input.value='';text(reveal,'');
  }});
  input.addEventListener('input',()=>credentialSave.schedule());
  onLeave(()=>credentialSave.dispose());
  line.append(input, destructiveButton('清除', async () => { input.value='';form.set(path, ''); await save(); text(reveal, ''); }, {
    target: () => wrap, clicks: 3, key: () => path,
    impact: `将清除 ${label}，依赖它的连接会失效。`,
  }));
  if (readEndpoint) line.append(button('显示已有', async () => {
    const data = await request('GET', readEndpoint, undefined, query); text(reveal, data.apiKey ?? data.token ?? '未配置');
    setTimeout(() => text(reveal, ''), 20000);
  }));
  wrap.append(title, state, line, reveal); parent.append(wrap);
}
function updateSecretStates() {
  // A structural editor temporarily hosts the same fields outside #fields.
  for (const el of document.querySelectorAll('[data-secret-path]')) {
    const path = el.dataset.secretPath; const parts = path.split('.'); const key = parts.pop();
    const node = parts.length ? getPath(form.base, parts.join('.')) : form.base;
    const set = Boolean(node?.[`has${key[0].toUpperCase()}${key.slice(1)}`] || key === 'apiKey' && node?.hasKey);
    text(el, set ? '已配置；不会自动读取明文' : '尚未配置');
  }
}
function tierFor(position) {
  const p = Math.min(100, Math.max(0, Number(position) || 0));
  if (p <= 10) return { tier: 1, percent: 0 }; if (p <= 20) return { tier: 2, percent: 0 };
  if (p < 90) return { tier: 3, percent: Math.round((p - 20) / 70 * 100) }; return { tier: 4, percent: 100 };
}
function renderResponse(parent) {
  // 四档响应概率是整个设置里最需要"读懂"的一项，所以做成仪表：
  // 刻度尺（标出四档分界）→ 滑条 → 读数窗 + 档位说明。
  // 刻度分界按 tierFor 的口径标：0-10 / 10-20 / 20-90 / 90-100。
  const scale = document.createElement('div'); scale.className = 'ticks'; scale.style.setProperty('--tick-step', '10%');
  const scaleMarks = document.createElement('div'); scaleMarks.className = 'ticks-marks';
  for (const [left, label] of [[0, '1 档'], [10, '2 档'], [20, '3 档'], [90, '4 档']]) {
    const mark = document.createElement('span'); mark.className = 'ticks-mark';
    mark.style.left = `${left}%`; text(mark, label);
    scaleMarks.append(mark);
  }
  const scaleWrap = document.createElement('div'); scaleWrap.className = 'ticks-wrap';
  scaleWrap.append(scaleMarks, scale);

  const readout = document.createElement('div'); readout.className = 'readout';
  const readoutValue = document.createElement('span'); readoutValue.id = 'tier-readout';
  const readoutUnit = document.createElement('span'); readoutUnit.className = 'unit'; text(readoutUnit, '档位');
  readout.append(readoutValue, readoutUnit);

  const summary = document.createElement('p'); summary.className = 'tier-value'; summary.id = 'tier-summary';
  const percentInput = document.createElement('input'); percentInput.id = 'random-percent'; percentInput.type = 'number'; percentInput.min = '0'; percentInput.max = '100'; percentInput.value = String(tierFor(form.value('store.contextSliderPos') ?? 100).percent);
  const update = () => {
    const { tier, percent } = tierFor(form.value('store.contextSliderPos') ?? 100);
    text(summary, ['', '1 档 · 仅 @ 机器人', '2 档 · @ 或关键词', `3 档 · @/关键词之外，每条消息骰一次（${percent}%）`, '4 档 · 有消息就响应'][tier]);
    text(readoutValue, `${tier} / 4`);
    if (document.activeElement !== percentInput) percentInput.value = String(percent);
  };
  const slider = field(parent, 'store.contextSliderPos', '响应档位滑条', 'range', { min: 0, max: 100, step: 0.1, default: 100, onChange: update });
  slider.id = 'context-slider';
  parent.append(scaleWrap, readout, summary);
  const wrap = document.createElement('label'); wrap.className = 'setting-field'; text(wrap, '3 档随机概率（0~100%）');
  percentInput.addEventListener('change', () => {
    const percent = Number(percentInput.value); if (!Number.isFinite(percent) || percent < 0 || percent > 100) { report('概率需要在0~100之间', true); return; }
    const pos = 20.0001 + percent * 69.9998 / 100; queue('store.contextSliderPos', pos); slider.value = String(pos); update();
  });
  const hint = empty('只修改唯一滑条值，由后端派生档位/概率。@ 与关键词命中不骰；未命中立即标已读。');
  wrap.append(percentInput, hint); parent.append(wrap); update();
}
async function listChoices(kind) {
  const path = `allow.${kind === 'groups' ? 'groups' : 'private'}`, modePath=`allow.${kind==='groups'?'allGroups':'allPrivate'}`, control = controls.get(path);
  const isCurrent = () => !disposed && !resetting && !resetPreparing && !resetAccepted && control?.isConnected && controls.get(path) === control;
  return openListChoice({ kind, load: () => request('GET', kind === 'groups' ? '/api/onebot/groups' : '/api/onebot/friends'),
    getSelected: () => form.value(path), getAllowAll:()=>allChatsAllowed({allow:form.value('allow'),allowAllWhenEmpty:form.value('allowAllWhenEmpty')},kind==='groups'?'group':'private'),getEmptyPolicy: () => form.value(modePath)===undefined?form.value('allowAllWhenEmpty'):form.value(modePath)===true, isCurrent,
    commit: async (selected,policy) => {
      if (!isCurrent()) throw new Error('当前设置已改变，请关闭后重开选择器');
      invalid.delete(path); control.removeAttribute('aria-invalid'); const error = control.closest('.setting-field')?.querySelector('.field-error'); if (error) error.hidden = true;
      queue(path, selected);if(policy?.changed)queue(modePath,policy.allowAll);control.value = selected.join('，'); await save();
    }, onError: error => { if (!disposed) report(error.message, true); }, onSaved: () => { if (isCurrent()) settingsStructure?.refresh(); },
  });
}
function editor(parent, title) { const box = document.createElement('div'); box.className = 'settings-editor'; const h = document.createElement('h4'); text(h, title); const fields = document.createElement('div'); fields.className = 'settings-fields'; box.append(h, fields); parent.append(box); return { box, fields }; }
function localInput(parent, label, id, type = 'text') {
  const wrap = document.createElement('label'); wrap.className = `setting-field${type === 'textarea' ? ' full' : ''}`; text(wrap, label);
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type; input.id = id; if (type === 'password') input.autocomplete = 'new-password'; wrap.append(input); parent.append(wrap); return input;
}
async function refreshProviders() {
  const ticket=++providerReadVersion,version=form.version,revision=saveCommitRevision;
  const [data,config]=await Promise.all([request('GET','/api/providers'),request('GET','/api/config')]);if(disposed||resetAccepted||ticket!==providerReadVersion)return;
  providers=data.providers||[];if(form.version===version&&saveCommitRevision===revision)form.mergeBase(config);else settingsReadDeferred=true;
  ++saveCommitRevision;renderProviderList();
  for(const path of ['api.provider','api.visionProvider','api.videoProvider','memory.provider']){const control=controls.get(path);if(!control)continue;if(control.localName!=='select'){if(document.activeElement!==control)control.value=form.value(path)||'';continue;}const ids=new Set(providers.map(p=>p.id));for(const option of [...control.options])if(option.value&&!ids.has(option.value))option.remove();for(const provider of providers){let option=[...control.options].find(item=>item.value===provider.id);if(!option){option=document.createElement('option');option.value=provider.id;control.append(option);}text(option,provider.displayName||provider.id);}if(document.activeElement!==control)control.value=form.value(path)||'';}
  for(const path of ['api.baseUrl','api.model']){const control=controls.get(path);if(control&&document.activeElement!==control)control.value=form.value(path)||'';}
  settingsStructure?.refresh();
  costView?.refresh();
  for(const field of document.querySelectorAll('[data-provider-credential]')){const provider=providers.find(p=>p.id===field.dataset.providerCredential);if(provider){const state=field.querySelector('.secret-state');if(state)text(state,provider.hasKey?'已配置；不会自动读取明文':'本渠道未配置密钥；不会借用直连密钥');}}
  saveLifecycle.sync();await refreshVisionResults();
}
function visionInfo(providerId, model) {
  const result = visionResults[`${providerId}|||${model}`];
  const verdict = ['vision', 'no-vision'].includes(result?.verdict) ? result.verdict : 'unknown';
  const [mark, label] = { vision: ['✓', '支持图片'], 'no-vision': ['✗', '不支持图片'], unknown: ['？', '尚未扫描或无法判断'] }[verdict];
  return { verdict, mark, label, title: `视觉扫描：${label}${result?.note ? ` · ${result.note}` : ''}` };
}
function updateModelVision() {
  costView?.refresh();
  const show = form.value('ui.showVision') !== false;
  for (const badge of document.querySelectorAll('.model-vision-badge')) {
    const info = visionInfo(badge.dataset.providerId, badge.dataset.modelId);
    badge.hidden = !show; badge.dataset.verdict = info.verdict; text(badge, `${info.mark} 视觉`);
    badge.title = info.title; badge.setAttribute('aria-label', info.title);
  }
  for (const option of document.querySelectorAll('option.model-vision-option')) {
    const info = visionInfo(option.dataset.providerId, option.value);
    const label = option.dataset.modelLabel || option.value;
    text(option, show ? `${label} · ${info.mark} 视觉` : label);
  }
  const status = $('#model-vision-state');
  if (status) { status.hidden = !show; text(status, visionError ? `视觉结果读取失败：${visionError}` : '视觉扫描结果：✓ 支持图片 · ✗ 不支持图片 · ？ 尚未扫描或无法判断'); }
}
async function refreshVisionResults() {
  const version = ++visionReadVersion;
  try {
    const data = await request('GET', '/api/vision/results');
    if (disposed || version !== visionReadVersion) return;
    visionResults = data.results || {}; visionError = '';
  } catch (error) {
    if (disposed || version !== visionReadVersion) return;
    visionError = error.message;
  }
  updateModelVision();
}
function queueProvider(id, chosenModel) {
  queue('api.provider', id);
  const provider = providers.find((item) => item.id === id);
  if (!provider) return;
  const models = (provider.models || []).map((model) => typeof model === 'string' ? model : model.id).filter(Boolean);
  const model = chosenModel ?? (models.includes(form.value('api.model')) ? form.value('api.model') : models[0] || '');
  const baseUrl = provider.baseURL || provider.baseUrl || '';
  queue('api.baseUrl', baseUrl); queue('api.model', model);
  if (controls.has('api.baseUrl')) controls.get('api.baseUrl').value = baseUrl;
  if (controls.has('api.model')) controls.get('api.model').value = model;
}
function chooseConfiguredModel(kind) {
  const modelPath = kind === 'main' ? 'api.model' : kind === 'memory' ? 'memory.model' : `api.${kind}Model`;
  const providerPath = kind === 'main' ? 'api.provider' : kind === 'memory' ? 'memory.provider' : `api.${kind}Provider`;
  const title = {main: '选择主模型', memory: '选择记忆整理专用模型', vision: '选择图片模型', video: '选择视频模型'}[kind];
  const media = kind === 'vision' || kind === 'video';
  const snapshot = providers;
  return openModelPicker({providers: snapshot, title, current: {provider: form.value(providerPath), model: form.value(modelPath)},...(media?{followMain:{provider:form.value('api.provider'),model:form.value('api.model')}}:{}),
    onPick: async (choice, context) => {
      const follow = media && choice?.followMain === true;
      if (!follow && (typeof choice?.provider !== 'string' || !choice.provider.trim() || typeof choice?.model !== 'string' || !choice.model.trim())) throw new Error('请选择有效的渠道和模型 ID');
      choice = follow ? {provider:'',model:''} : {provider: choice.provider.trim(), model: choice.model.trim()};
      const isCurrent = () => typeof context?.isCurrent === 'function' ? context.isCurrent() : true;
      if (disposed || resetting || resetPreparing || resetAccepted || !isCurrent()) throw new Error('当前设置不可编辑');
      const latest = (await request('GET', '/api/providers')).providers || [];
      if (disposed || resetting || resetPreparing || resetAccepted || !isCurrent()) throw new Error('模型选择已取消');
      const previous = snapshot.find(p => p.id === choice.provider), next = latest.find(p => p.id === choice.provider);
      const address = providerEndpointIdentity(next?.baseURL || next?.baseUrl);
      if (!follow && (!previous || !next || !address || providerEndpointIdentity(previous.baseURL || previous.baseUrl) !== address)) throw new Error('渠道已改变，请关闭选择器并重新读取设置');
      if (!follow && next.baseUrl && next.baseURL && providerEndpointIdentity(next.baseUrl) !== providerEndpointIdentity(next.baseURL)) throw new Error('渠道地址别名存在冲突，请重新编辑渠道');
      providers = latest;
      if (invalid.size) throw new Error(`请先修正：${[...invalid.values()].join('；')}`);
      const previousEdits = form.snapshot();
      const affected = kind === 'main' ? ['api.provider', 'api.baseUrl', 'api.model'] : [providerPath, modelPath, ...(kind === 'memory' ? ['memory.useChatModel'] : [])];
      if (kind === 'main') {
        queueProvider(choice.provider, choice.model);
        if (controls.has('api.provider')) controls.get('api.provider').value = choice.provider;
      } else {
        queue(providerPath, choice.provider); queue(modelPath, choice.model);
        if (controls.has(providerPath)) controls.get(providerPath).value = choice.provider;
        if (controls.has(modelPath)) controls.get(modelPath).value = choice.model;
        if (kind === 'memory') {
          const follow = controls.get('memory.useChatModel');
          if (follow) { follow.checked = false; follow.dispatchEvent(new Event('change')); }
          else queue('memory.useChatModel', false);
        }
      }
      const staged = form.snapshot();
      try { await save(); }
      catch (error) {
        form.restorePending(previousEdits, staged, affected);
        for (const path of affected) {
          const input = controls.get(path); if (!input || invalid.has(path)) continue;
          if (input.type === 'checkbox') { input.checked = form.value(path) === true; const pill = input.closest('.setting-field')?.querySelector('.switch-state'); if (pill) text(pill, input.checked ? '开启' : '关闭'); }
          else input.value = form.value(path) ?? '';
        }
        settingsStructure?.refresh();
        costView?.refresh();
        throw error;
      }
      if (!disposed) render();
    },
  });
}
function renderProviderList() {
  const host=$('#provider-list');if(!host)return;
  if(providerManager?.host!==host){providerManager?.dispose();providerManager=createProviderManager({host,request,beforeWrite:save,changed:refreshProviders,activeProvider:()=>form.value('api.provider'),selected:managerProvider,onSelect:id=>managerProvider=id,onDraftChange:()=>saveLifecycle.sync(),paused:()=>disposed||resetting||resetPreparing||resetAccepted});}
  providerManager.render(providers);updateModelVision();
}
async function saveAll(){await providerManager?.flush();while(settingsStructure?.activityDirty)await settingsStructure.saveActivity();await save();}
async function commitActivity(changes){
  if(resetting||resetPreparing||resetAccepted)throw Error('正在重置，无法保存设置');
  const previous=form.snapshot();
  for(const{path,value,replace}of changes)form.set(path,value,{replace});
  const staged=form.snapshot();saveLifecycle.sync();
  try{await save();}
  catch(error){form.restorePending(previous,staged,changes.map(item=>item.path));saveLifecycle.sync();throw error;}
}
function updateToolAvailability(error = '') {
  const byId = new Map(availability.map(item => [item.id, item]));
  for (const reason of fieldsHost.querySelectorAll('[data-tool-availability-id]')) {
    const state = byId.get(reason.dataset.toolAvailabilityId);
    const message = error || (state?.enabled ? '' : state?.reason || '暂不可用');
    reason.dataset.available=String(state?.enabled===true);reason.closest('label').dataset.available=String(state?.enabled===true);
    if (reason.textContent !== message) text(reason, message);
  }
}
async function refreshToolAvailability() {
  if (disposed || resetAccepted) return;
  toolAvailabilityPending = true;
  if (resetting || resetPreparing) return;
  const version = ++toolAvailabilityReadVersion, revision = saveCommitRevision;
  const isCurrent = () => version === toolAvailabilityReadVersion && revision === saveCommitRevision && !disposed && !resetting && !resetPreparing && !resetAccepted;
  try {
    const state = await request('GET', '/api/tools/availability');
    if (!isCurrent()) return;
    availability = state.tools || [];
    toolAvailabilityPending = false;
    // Runtime hints can change while a checkbox or an unrelated draft owns focus.
    // Update text only; never recreate the tool list or any editable controls.
    updateToolAvailability();
  } catch {
    if (isCurrent()) { toolAvailabilityPending = false; updateToolAvailability('状态刷新失败，请重新读取'); }
  }
}
function renderTools() {
  const host = $('#tool-list'); if (!host) return; clear(host);
  for (const tool of tools) {
    const state = availability.find((item) => item.id === tool.id); const label = document.createElement('label'); label.className = 'tool-toggle'; const input = document.createElement('input'); input.type = 'checkbox';
    input.checked = form.value('tools.overrides')?.[tool.id] ?? tool.defaultEnabled !== false;
    input.addEventListener('change', () => queueToolOverride(tool.id, input.checked));
    const title = document.createElement('span'); text(title, tool.name);label.title=tool.id; const reason = document.createElement('small'); reason.dataset.toolAvailabilityId = tool.id;reason.className='tool-runtime-state';reason.dataset.available=String(state?.enabled===true);label.dataset.available=String(state?.enabled===true);text(reason, state?.enabled ? '' : state?.reason || '暂不可用');
    label.classList.add('is-switch');
    label.append(input, title, reason, switchPill(input)); host.append(label);
  }
}
async function refreshSearchProviders() { searchProviders = (await request('GET', '/api/search-providers')).providers || []; renderSearchProviders(); }
function renderSearchProviders() {
  const host = $('#search-provider-list'); if (!host) return; clear(host);
  for (const provider of searchProviders) {
    const outputHost = document.createElement('pre'); outputHost.className = 'settings-output';
    const item = row(provider.name, `${provider.type} · ${provider.baseUrl} · ${provider.hasApiKey ? '密钥已配置' : '未配置密钥'}`, [
      button('使用', async () => { queue('webSearch.provider', `custom:${provider.id}`); await save(); render(); }),
      button('测试', async () => output(outputHost, (await request('POST', '/api/search-providers/test', { providerId: provider.id })).result)),
      button('编辑', () => editSearchProvider({ provider, request, reload: refreshSearchProviders })),
      destructiveButton('删除', async () => { await request('DELETE', '/api/search-providers', { id: provider.id }); await load(true); }, {
        target: () => item, clicks: 3, key: () => provider.id,
        impact: `将删除搜索源 ${provider.name} 及其密钥，后续搜索将无法继续使用此源。`,
      }),
    ]); item.dataset.motionKey = `search:${provider.id}`; item.append(outputHost); host.append(item);
  }
}
function render() {
  const savedAppearanceFolds=new Map([...document.querySelectorAll('details[data-appearance-group]')].map(group=>[group.dataset.appearanceGroup,group.open]));
  const activityDraft=settingsStructure?.activityDraft;
  costView?.dispose();costView=null;
  disposePriceTable();disposePriceTable=()=>{};
  providerManager?.dispose();providerManager=null;
  renderedView = null;
  const openEditors=settingsStructure?.snapshot()||[];
  const foldStates = new Map([...document.querySelectorAll('details[data-settings-group]')]
    .map(group => [group.dataset.settingsGroup, collapsibleExpanded(group)]));
  settingsStructure?.dispose();settingsStructure=null;
  disposeMainCredential(); disposeMainCredential = () => {};
  clear(fieldsHost); sections.clear(); controls.clear(); invalid.clear();
  const api = section('models', '模型与渠道', '首次配置先填写 Base URL、模型 ID 和密钥。测试连接/视觉扫描会调用对应服务。');
  {
    const endpoint = group(api.fields, '接入点');
    field(endpoint, 'api.baseUrl', 'Base URL', 'text', { hint: 'OpenAI 兼容接口，如 https://example.com/v1' });
    field(endpoint, 'api.model', '主模型 ID');
    const credential = document.createElement('div'); credential.className = 'main-credential'; endpoint.append(credential);
    function refreshCredential() {
      disposeMainCredential();disposeMainCredential=()=>{};
      for(const node of credential.querySelectorAll('input'))node.value='';
      for(const node of credential.querySelectorAll('.secret-revealed'))node.textContent='';
      clear(credential);
      const id=form.value('api.provider'), provider=providers.find(p=>p.id===id);
      if(provider)disposeMainCredential=providerCredential({parent:credential,provider,request,save,isCurrent:pid=>form.value('api.provider')===pid&&!disposed,
        changed:(pid,hasKey)=>{const current=providers.find(p=>p.id===pid);if(current)current.hasKey=hasKey;renderProviderList();}});
      else if(id)credential.append(empty('当前渠道不存在，请重新选择渠道或切回直连模式。'));
      else secretField(credential,'api.apiKey','直连 API Key','/api/api-key');
      updateSecretStates();
    }
    field(endpoint, 'api.provider', '当前渠道', 'select', { options: [['','直接使用主模型配置'], ...providers.map((p) => [p.id, p.displayName || p.id])], onChange: (id) => {queueProvider(id);refreshCredential();} });
    refreshCredential();
    const sampling = group(api.fields, '采样与预算');
    field(sampling, 'api.temperature', '温度', 'number', { min: 0, max: 2, step: 0.1 });
    field(sampling, 'api.maxRounds', '最大工具轮数', 'number', { min: 1, max: 100 });
    field(sampling, 'api.timeoutMs', '等待模型回复（秒）', 'number', { min: 5, valueScale:1000 });
    field(sampling, 'api.fallbackModels', '备选模型（JSON 数组）', 'json', { default: [], hint: '[{"provider":"渠道ID","model":"模型ID"}]，按顺序降级。' });
    const thinking = group(api.fields, '思考模式');
    field(thinking, 'api.thinkingMode', '思考模式', 'select', { options: [['auto','自动'],['on','开启'],['off','关闭']] });
    field(thinking, 'api.thinkingEffort', '思考强度', 'select', { options: [['','默认'],['off','关闭'],['low','低'],['medium','中'],['high','高'],['xhigh','极高'],['max','极限']], hint: '只对支持推理强度的模型生效' });
    field(thinking, 'api.thinkingBudget', '思考预算', 'number', { min: 0 });
    const media = group(api.fields, '多模态输入');
    field(media, 'api.vision', '允许图片输入', 'checkbox');
    field(media, 'api.visionModel', '图片专用模型');
    field(media, 'api.visionProvider', '图片模型渠道', 'select', {options: [['', '沿用主模型端点'], ...providers.map(p => [p.id, p.displayName || p.id])]});
    media.append(button('选择图片模型', () => chooseConfiguredModel('vision')));
    field(media, 'api.video', '允许视频输入', 'checkbox');
    field(media, 'api.videoModel', '视频专用模型');
    field(media, 'api.videoProvider', '视频模型渠道', 'select', {options: [['', '沿用主模型端点'], ...providers.map(p => [p.id, p.displayName || p.id])]});
    media.append(button('选择视频模型', () => chooseConfiguredModel('video')));
    field(media, 'api.videoMode', '视频处理模式', 'select', { options: [['auto','自动'],['native','原生视频'],['frames','抽帧'],['off','关闭']] });
    field(media, 'skills.video-frames.enabled', '启用视频读取服务', 'checkbox', { default: true, hint: '使用已安装的 ffmpeg 或扩展提供者；没有抽帧能力时仍可返回元信息。' });
  }
  const testOut = document.createElement('pre'); testOut.id = 'api-test-result'; testOut.className = 'settings-output';
  const modelChoices = document.createElement('select'); modelChoices.id = 'fetched-models'; modelChoices.hidden = true;
  modelChoices.addEventListener('change', () => { queue('api.model', modelChoices.value); controls.get('api.model').value = modelChoices.value; });
  const actions = document.createElement('div'); actions.className = 'actions'; actions.append(
    button('从目录选择主模型', () => chooseConfiguredModel('main')),
    button('管理备选模型', () => editFallbacks({ form, providers, queue, save, render })),
    button('测试主模型', async () => { await save(); const result = await request('POST', '/api/test/api', {}); output(testOut, result); }),
    button('获取模型列表', async () => { await save(); const data = await request('GET', '/api/models'); clear(modelChoices); for (const m of data.models || []) { const o = document.createElement('option'); o.value = m.id; o.className = 'model-vision-option'; o.dataset.providerId = form.value('api.provider') || 'default'; text(o, m.id); modelChoices.append(o); } updateModelVision(); modelChoices.hidden = !modelChoices.options.length; output(testOut, { models: modelChoices.options.length }); }),
    button('扫描视觉能力', async () => { await save(); output(testOut, await request('POST', '/api/vision/scan', {})); }),
    button('查看视觉结果', async () => { await refreshVisionResults(); output(testOut, visionResults); }),
  ); api.card.append(actions, modelChoices, testOut);
  const providerList = document.createElement('div'); providerList.id = 'provider-list'; providerList.className = 'settings-list'; api.card.append(providerList); renderProviderList();
  const providerEditor = editor(api.card, '添加渠道');
  const pName = localInput(providerEditor.fields, '渠道名称', 'provider-name'); const pBase = localInput(providerEditor.fields, 'Base URL', 'provider-base'); const pKey = localInput(providerEditor.fields, 'API Key', 'provider-key', 'password');
  providerEditor.box.append(button('添加渠道', async () => { await saveAll(); const result=await request('POST', '/api/providers', { displayName: pName.value, baseUrl: pBase.value, apiKey: pKey.value.trim() }); pKey.value = '';pName.closest('dialog[data-settings-editor="provider-add"]')?.close();await refreshProviders();await providerManager?.select(result.provider?.id||result.created); }, 'primary'));

  const persona = section('persona', '人设与角色', '全局角色、分会话人设和自定义规则。机器人名称是账号身份，不随会话单独变化。');
  field(persona.fields, 'persona.botName', '机器人名称'); field(persona.fields, 'persona.selfNickname', '账号昵称（留空自动读取）');
  field(persona.fields, 'persona.roleText', '角色卡', 'textarea', { rows: 8 });
  field(persona.fields, 'persona.participation', '参与程度', 'select', { options: [['low','克制'],['medium','自然'],['high','积极']] });
  field(persona.fields, 'persona.customRules', '管理员附加规则', 'textarea'); field(persona.fields, 'personaUnified', '所有会话使用统一人设', 'checkbox');
  {
    const personaAdvanced = group(persona.fields, '高级覆盖（JSON / 系统提示词）', { fold: true, key: 'persona-overrides' });
    field(personaAdvanced, 'personaByChat', '分会话人设（JSON 对象）', 'json', { hint: '{"群号":{"roleText":"…"}}，统一人设关闭后生效。' });
    field(personaAdvanced, 'persona.systemPromptOverride', '完整系统提示词覆盖', 'textarea', { hint: '改变默认行为规则，建议留空；{botName}/{roleText}/{participation} 支持占位。' });
  }
  const templateHost=document.createElement('div');templateHost.id='persona-template-manager';persona.card.append(templateHost);personaTemplates.mount(templateHost);
  const perChatHost=document.createElement('div');perChatHost.id='persona-by-chat-manager';persona.card.append(perChatHost);personaByChat.mount(perChatHost);

  const wake = section('wake', '响应与分时', '判定本地完成；3 档普通群消息全程最多骰一次，没命中即标已读，不反复抽签。');
  {
    const tier = group(wake.fields, '响应档位');
    renderResponse(tier);
    controls.set('store.keywords', mountKeywordEditor({parent:tier,value:form.value('store.keywords'),onInput:value=>queue('store.keywords',value)}).input);
    field(tier, 'store.unifiedTier', '所有群统一档位', 'checkbox');
    field(tier, 'store.historyCount', '历史消息读取条数', 'number', { min: 0 });
    const perGroup = group(wake.fields, '分群与峰谷（高级）', { fold: true, key: 'wake-per-group' });
    wake.card.append(button('管理分群档位', () => { const owner=controls.get('store.groupSliderPos'); return editGroupResponse({request,form,queue,save,render,isCurrent:()=>!disposed&&!resetting&&!resetPreparing&&!resetAccepted&&owner?.isConnected&&controls.get('store.groupSliderPos')===owner,onError:error=>{if(!disposed)report(error.message,true);}}); }));
    field(perGroup, 'store.groupSliderPos', '分群滑条（JSON）', 'json');
    field(perGroup, 'store.groupPeakPos', '分群峰谷双点（JSON）', 'json');
    field(perGroup, 'store.peakSchedule.enabled', '启用峰谷自动切档', 'checkbox');
    perGroup.append(button('编辑峰谷时段与预设',()=>peakPresetEditor.open()));
    const timing = group(wake.fields, '时序与并发（高级）', { fold: true, key: 'wake-timing' });
    field(timing, 'wakeDelayMs', '消息聚批等待（毫秒）', 'number', { min: 200 });
    field(timing, 'drainDelayMs', '积压处理间隔（毫秒）', 'number', { min: 200 });
    field(timing, 'maxConcurrentRuns', '并发会话上限', 'number', { min: 1 });
    field(timing, 'sessionRetryAttempts', '未发言失败会话重试次数', 'number', { min: 0, max: 5 });
    const mute = group(wake.fields, '群指令安静模式');
    field(mute, 'commandMute.enabled', '启用群指令安静模式', 'checkbox');
    field(mute, 'commandMute.command', '安静指令');
    field(mute, 'commandMute.durationMin', '安静时长（分钟，0永久）', 'number', { min: 0 });
    field(mute, 'commandMute.active', '当前安静群（JSON，清空可解除）', 'json');
  }

  const access = section('access', '白名单与协议连接', '默认空白名单不响应任何群/好友。协议端地址可配；明文令牌只由你显式写入/显示。');
  {
    const allow = group(access.fields, '准入白名单');
    field(allow, 'allow.groups', '允许的群号', 'list', { numeric: true }); field(allow, 'allow.private', '允许的好友 QQ 号', 'list', { numeric: true });
    field(allow, 'allowAllWhenEmpty', '空白名单时允许所有会话（慎开）', 'checkbox');
    const allowActions=document.createElement('div');allowActions.className='actions';
    allowActions.append(button('从QQ 群列表选择', () => listChoices('groups')), button('从好友列表选择', () => listChoices('friends')));
    allow.prepend(allowActions);
    const deny = group(access.fields, '拒绝与屏蔽');
    field(deny, 'deny.groups', '拒绝的群号', 'list', { numeric: true }); field(deny, 'deny.private', '拒绝的好友 QQ 号', 'list', { numeric: true });
    blocklistRaw.mount(deny);
    deny.append(button('按群选择屏蔽成员',()=>blocklistMembers.open()));
    const link = group(access.fields, '协议端连接');
    const localHost=document.createElement('div');localHost.className='full';link.append(localHost);localProtocols.mount(localHost);
    const manualHead=document.createElement('div');manualHead.className='full local-protocol-manual-head';const manualTitle=document.createElement('h4');manualTitle.className='local-protocol-manual-title';manualTitle.textContent='已有服务';manualHead.append(manualTitle,button('连接已运行的协议端',async()=>{await saveAll();localProtocols.openExisting();}));link.append(manualHead);
    field(link, 'onebot.wsUrl', 'OneBot WebSocket 地址', 'text', { hint: '协议端提供的正向 WebSocket 事件地址。' });
    field(link, 'onebot.httpUrl', 'OneBot HTTP 地址', 'text', { hint: '同一账号的 HTTP API 地址，用于发送消息和查询。' });
    secretField(link, 'onebot.accessToken', 'WebSocket 令牌', '/api/onebot-token', { which: 'ws' });
    secretField(link, 'onebot.httpAccessToken', 'HTTP 令牌', '/api/onebot-token', { which: 'http' });
    const tokenHint = document.createElement('p'); tokenHint.className = 'field-hint'; tokenHint.textContent = '已有协议端也可手动连接。填写地址与令牌后自动保存。'; link.append(tokenHint);
  }

  const send = section('send', '发送与消息存档', '同会话串行、成功后去重记账。限频用于防刷屏，不应设得过大。');
  {
    const gap = group(send.fields, '真人间隔');
    for (const [key, label, min] of [['minGapMs','最低真人间隔（毫秒）',0],['maxGapMs','最高真人间隔（毫秒）',0],['byLengthMs','按字数附加间隔',0]]) field(gap, `send.${key}`, label, 'number', { min });
    const rate = group(send.fields, '限频与去重');
    for (const [key, label, min] of [['maxPerMinute','每分钟发送上限',1],['maxPerHour','每小时发送上限',1],['hardSplitAt','单条文字切分长度（0不限）',0],['dedupeWindowMs','相同消息去重窗口（毫秒）',0]]) field(rate, `send.${key}`, label, 'number', { min });
    // 注意变量名不要和配置路径 store.* 混淆：group() 返回的就是字段容器本身。
    const archive = group(send.fields, '存档与缓存锚点（高级）', { fold: true, key: 'send-archive' });
    field(archive, 'store.maxMessagesPerChat', '每会话存档条数（0不限）', 'number', { min: 0 });
    field(archive, 'store.keepSessionFiles', '保留会话记录数（0不限）', 'number', { min: 0 });
    field(archive, 'store.promptAnchor.enabled', '启用提示词缓存锚点', 'checkbox');
    field(archive, 'store.promptAnchor.maxExtraRead', '锚点最多追加历史条数', 'number', { min: 0 });
  }

  const active = section('active', '主动话题与活跃期', '默认关闭主动发言。启用后只有白名单内闲置会话会成为候选。');
  field(active.fields, 'proactive.enabled', '主动发起聊天', 'checkbox');
  field(active.fields, 'proactive.probability', '主动发言概率（%）', 'number', { min: 0, max: 100, step: 1, valueScale:0.01 });
  field(active.fields, 'proactive.idleThresholdMs', '冷场阈值（秒）', 'number', { min: 300, step: 'any', valueScale: 1000 });
  field(active.fields, 'proactive.checkIntervalMinMs', '最短检查间隔（秒）', 'number', { min: 60, step: 'any', valueScale: 1000 });
  field(active.fields, 'proactive.checkIntervalMaxMs', '最长检查间隔（秒）', 'number', { min: 60, step: 'any', valueScale: 1000 });
  field(active.fields, 'chatActive.enabled', '启用活跃话题持续响应', 'checkbox'); field(active.fields, 'chatActive.ttlMinutes', '活跃期有效时长（分钟）', 'number', { min: 1 });

  const memory = section('memory', '记忆与表情', '群友印象和表情库保存在本地。');
  {
    const consolidate = group(memory.fields, '记忆整理');
    field(consolidate, 'memory.consolidateEnabled', '自动整理记忆', 'checkbox');
    field(consolidate, 'memory.consolidateMinIntervalMs', '最短整理间隔（分钟）', 'number', { min: 30, step: 'any', valueScale: 60000 });
    field(consolidate, 'memory.useChatModel', '共用聊天模型', 'checkbox');
    field(consolidate, 'memory.provider', '整理专用渠道 ID');
    field(consolidate, 'memory.model', '整理专用模型 ID');
    consolidate.append(button('选择整理专用模型', () => chooseConfiguredModel('memory')));
    const tuning = group(memory.fields, '整理阈值（高级）', { fold: true, key: 'memory-tuning' });
    field(tuning, 'memory.maxImpressionsPerMember', '每人保留印象（条）', 'number', { min: 2 });
    field(tuning, 'memory.consolidateMinImpressions', '全群印象阈值（条）', 'number', { min: 0, hint:'群内印象总数超过此值，或某成员印象超过保留上限时触发整理。' });
    field(tuning, 'memory.discoverMinMessages', '发现成员需发言（条）', 'number', { min: 1 });
    field(tuning, 'memory.discoverMaxMembers', '单次自动发现人数（0 关闭）', 'number', { min: 0 });
    const sticker = group(memory.fields, '表情');
    field(sticker, 'sticker.enabled', '让模型参考表情库', 'checkbox');
    field(sticker, 'sticker.promptMaxStickers', '提供给模型的表情数', 'number', { min: 1, max: 30 });
    field(sticker, 'sticker.collectEnabled', '自动收藏表情', 'checkbox');
    field(sticker, 'sticker.maxCollectPerHour', '每小时自动收藏上限', 'number', { min: 0 });
    field(sticker, 'sticker.encourage', '表情使用积极程度', 'select', { options: [[0,'不鼓励'],[1,'偶尔'],[2,'较积极'],[3,'表情包爱好者']] });
  }

  const toolSection = section('tools', '工具与能力', '开关控制模型能看到的工具；不可用原因来自实际运行时，启用不会绕过权限或缺失能力。');
  field(toolSection.fields, 'tools.enabled', '模型使用工具', 'checkbox'); field(toolSection.fields, 'tools.crossChatSend', '跨会话发言', 'checkbox');
  for (const [id, title] of [['messaging','消息'],['sticker','表情'],['query','查询'],['memory','记忆'],['web','联网'],['knowledge','知识库'],['media','媒体'],['system','系统']]) field(toolSection.fields, `tools.categories.${id}`, `${title}类工具`, 'checkbox');
  const toolHost = document.createElement('div'); toolHost.id = 'tool-list'; toolHost.className = 'settings-list'; toolSection.card.append(toolHost); renderTools();
  const capabilityOut = document.createElement('pre'); capabilityOut.className = 'settings-output'; toolSection.card.append(button('诊断', async () => {const dialog=document.createElement('dialog'),heading=document.createElement('h3'),details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');dialog.className='settings-diagnostic-dialog';heading.textContent='能力诊断';summary.textContent='技术详情';output(pre,await request('GET','/api/skills/capabilities'));details.append(summary,pre);dialog.append(heading,details,button('完成',()=>dialog.close()));installDisposableDialog(dialog);document.body.append(dialog);dialog.showModal();}), capabilityOut);

  const search = section('search', '联网搜索', '开启后选择搜索源，并设置搜索结果上限。');
  field(search.fields, 'webSearch.enabled', '启用联网搜索', 'checkbox'); field(search.fields, 'webSearch.provider', '当前搜索源', 'select', { options: [...searchSourcePresets(path=>form.value(path)), ...searchProviders.map((p) => [`custom:${p.id}`, p.name])] }); field(search.fields, 'webSearch.searchUrl', 'Bing 搜索地址'); field(search.fields, 'webSearch.maxResults', '结果上限（条）', 'number', { min: 1, max: 20 });
  const defaults = { deepseek: 'https://api.deepseek.com/responses', zhipu: 'https://open.bigmodel.cn/api/paas/v4/web_search', bocha: 'https://api.bochaai.com/v1/web-search', baidu: 'https://qianfan.baidubce.com/v2/ai_search/web_search', metaso: 'https://metaso.cn/api/open/v1/search' };
  {
    const sourceAdvanced = group(search.fields, '各源接口与密钥（高级）', { fold: true, key: 'search-sources' });
    for (const [id, url] of Object.entries(defaults)) { field(sourceAdvanced, `webSearch.${id}.baseUrl`, `${id} 接口地址`, 'text', { hint: url }); secretField(sourceAdvanced, `webSearch.${id}.apiKey`, `${id} 密钥`, '/api/search-key', { field: id }); field(sourceAdvanced, `webSearch.${id}.timeoutMs`, `${id} 超时（毫秒，0默认）`, 'number', { min: 0 }); if (id !== 'deepseek') field(sourceAdvanced, `webSearch.${id}.count`, `${id} 请求条数（0默认）`, 'number', { min: 0, max: 20 }); }
    field(sourceAdvanced, 'webSearch.deepseek.model', 'DeepSeek 搜索模型'); field(sourceAdvanced, 'webSearch.zhipu.engine', '智谱搜索引擎');
  }
  const spHost = document.createElement('div'); spHost.id = 'search-provider-list'; spHost.className = 'settings-list'; search.card.append(spHost); renderSearchProviders();
  const sEditor = editor(search.card, '添加自定义搜索源'); const sName = localInput(sEditor.fields, '名称', 'search-source-name'); const sUrl = localInput(sEditor.fields, '接口地址', 'search-source-url'); const sKey = localInput(sEditor.fields, 'API Key（可空）', 'search-source-key', 'password');
  sEditor.box.append(button('添加搜索源', async () => { await request('POST', '/api/search-providers', { name: sName.value, baseUrl: sUrl.value, apiKey: sKey.value, type: 'openai' }); sKey.value = ''; await refreshSearchProviders(); }, 'primary'), button('完整搜索源设置', () => editSearchProvider({ request, reload: refreshSearchProviders })));

  const price = section('prices', '价格与成本', '单价为元 / 百万 Token。按模型自定义价格优先；远程和内置参考价未匹配时，使用下方手填价格。内置参考价来自2026年9月的版本快照，可拉取最新价格表。');
  field(price.fields, 'api.useOfficialPrice', '使用远程价格表及内置参考价', 'checkbox'); for (const [id,label] of [['priceInputPerM','输入单价 / 百万 Token'],['priceOutputPerM','输出单价 / 百万 Token'],['priceCachedPerM','缓存输入单价 / 百万 Token']]) field(price.fields, `api.${id}`, label, 'number', { min: 0, step: 0.001 });
  field(price.fields, 'api.modelPrices', '按模型定价（JSON）', 'json', { hint: '{"模型ID":{"in":1,"out":2,"cached":0.1}}' });
  costView=mountCostView({parent:price.fields,read:path=>form.value(path),write:value=>{const input=controls.get('api.useOfficialPrice');input.checked=value;input.dispatchEvent(new Event('change',{bubbles:true}));},ready:()=>![...form.pending.keys()].some(path=>path==='api'||path.startsWith('api.')),request});
  const priceTable=createPriceTable({request});disposePriceTable=()=>priceTable.dispose();
  const priceActions=document.createElement('div');priceActions.className='actions';
  priceActions.append(button('查看当前价格表', async () => {await priceTable.load();costView?.refresh({force:true});}), button('拉取最新价格表', async () => {await priceTable.load({refresh:true});costView?.refresh({force:true});}));
  price.card.append(priceActions,priceTable.element);

  const security = section('security', '安全与隐私', '默认禁止内网图片与任意浏览。插件在 Node 进程内执行，不是沙箱，只安装可信代码。');
  {
    // 会放开权限/放开出站的项收进红框：这些开关的代价不在当前页，而在群聊现场
    const risky = document.createElement('div'); risky.className = 'zone-danger';
    const riskyHead = document.createElement('div'); riskyHead.className = 'field-group-head'; text(riskyHead, '放开限制（谨慎）');
    risky.append(riskyHead);
    const riskyFields = document.createElement('div'); riskyFields.className = 'settings-fields';
    risky.append(riskyFields);
    security.card.append(risky);
    field(riskyFields, 'security.allowPrivateImageHosts', '允许内网图片来源', 'checkbox');
    field(riskyFields, 'security.browseLock.hosts', '允许访问的域名', 'list');
    field(security.fields, 'security.browseLock.enabled', '仅访问指定域名', 'checkbox');
    field(security.fields, 'security.browseLock.siteSearchUrl', '站内搜索地址');
    field(security.fields, 'security.imageSend.requirePreview', '发送前预览', 'checkbox', { default: true });
    field(security.fields, 'security.imageSend.maxPerRun', '每轮发送（张）', 'number', { default: 3, min: 1 });
    field(security.fields, 'security.imageSend.maxPreviewsPerRun', '每轮预览（张）', 'number', { default: 5, min: 1 });
    field(security.fields, 'security.imageSend.maxBytesMB', '单张大小（MB）', 'number', { default: 5, min: 1 });
    field(security.fields, 'telemetry.enabled', '匿名使用统计', 'checkbox', { default: true, hint:'不含聊天内容。' });
  }

  /** 「界面预设」下拉的选项：两个出厂基准 + 每个自定义方案。
      注意 custom 是「id → 方案」的映射（不是数组），对象没有 .map。 */
  function schemeOptions() {
    const custom = form.value('ui.uikit.custom') ?? {};
    return [
      ['dark', '暗色预设'],
      ['light', '亮色预设'],
      ...Object.entries(custom).map(([id, c]) => [`custom:${id}`, `自定义：${c?.name ?? id}`]),
    ];
  }
  /** 自定义方案增删后同步下拉（render 是一次性的，下拉不会自动更新）。 */
  function refreshModeSelect() {
    const select = document.querySelector('#field-ui-uikit-mode');
    if (!select) return;
    select.replaceChildren();
    for (const [value, label] of schemeOptions()) {
      const option = document.createElement('option'); option.value = value; text(option, label); select.append(option);
    }
    select.value = form.value('ui.uikit.mode') ?? 'dark';
  }

  const desktop = section('desktop', '桌面与界面', '监听端口修改需重启；控制台访问令牌保留在宿主，不传入 iframe 面板。');
  desktop.card.append(button('管理控制台访问令牌',async()=>{await save();await openConsoleTokenManager();}));
  field(desktop.fields, 'server.port', '控制台端口（重启生效）', 'number', { min: 1024, max: 65535 }); field(desktop.fields, 'server.autoStart', '开机自启', 'checkbox'); field(desktop.fields, 'server.closeToTray', '关窗留在托盘', 'checkbox'); field(desktop.fields, 'ui.uikit.mode', '界面预设', 'select', { options: schemeOptions(), hint: '亮色/暗色是出厂基准；在其上改动任何一项后，可用下方组件库里的「另存为」变成一个独立的自定义方案。' }); field(desktop.fields, 'ui.showVision', '显示视觉能力标记', 'checkbox', { default: true, onChange: updateModelVision }); field(desktop.fields, 'extensions.hotReload', '自动重新加载本地改动', 'checkbox', {hint:'监视本地文件，保存代码后重新加载；在线检查新版是独立流程。'});
  if(currentAccountScope.id!=='primary'){
    for(const path of ['server.port','server.autoStart','server.closeToTray']){const input=controls.get(path);if(input){input.disabled=true;input.setAttribute('aria-description','由主账号统一管理');}}
    const sharedNote=document.createElement('p');sharedNote.className='field-hint full';sharedNote.textContent='控制台端口、开机启动和窗口行为由主账号统一管理。';desktop.fields.prepend(sharedNote);
  }
  disposeUpdates();disposeUpdates=mountUpdateStatus({host:desktop.card,action:consoleUpdate,subscribe:onShellEvent});

  // ---- 组件库：控制台外观自定义 ----
  // 方案模型：亮色/暗色是出厂基准（改了就是"已修改态"，可另存为独立自定义方案）；
  // 自定义方案与两个基准互不干扰，可任意多个、可切换/重命名/删除。
  // 值进 form → 随 config.json 持久化；预览请求宿主落地（面板是 opaque origin，够不着宿主 DOM）。
  const kit = section('uikit', '组件库', '暖黑黄绿与骨白橄榄绿配色，图标与控件同步预览；背景、圆角和密度可实时调整，方案随配置保存。');

  const COLOR_FIELDS = [
    ['bg', '页面底色'], ['surface', '卡片底色'], ['surface2', '卡片底色 2'], ['surface3', '卡片底色 3'],
    ['text', '主文字'], ['muted', '次要文字'], ['faint', '弱化文字'],
    ['accent', '强调色'], ['accent2', '强调色 2（渐变右端）'], ['accentInk', '强调色文字'],
    ['good', '成功色'], ['warn', '警告色'], ['bad', '危险色'],
    ['line', '描边'], ['lineSoft', '弱描边'],
  ];
  const LAYOUT_FIELDS = ['radius', 'density', 'sidebar', 'btnAlign', 'styleMode'];
  // 参与"从基准重建表单"的键。必须包含背景图编辑器的四个参数，
  // 否则它们会被这里的白名单过滤掉，编辑器永远读到空值（选框量不到尺寸）。
  const ALL_KEYS = [...COLOR_FIELDS.map(([k]) => k), 'gradient', 'bgImage', 'bgOpacity', 'bgBlur', 'bgFit',
    'bgRotate', 'bgZoom', 'bgOffsetX', 'bgOffsetY', ...LAYOUT_FIELDS,...PERSONALIZATION_FIELDS.map(field=>field.key)];

  /** 当前选中的方案槽：'light' | 'dark' | 'custom:<id>' */
  const currentMode = () => {
    const store = migrateUikit(form.value('ui.uikit'));
    return ['light', 'dark'].includes(store.mode) || store.mode.startsWith('custom:') && store.custom[store.mode.slice(7)]
      ? store.mode : 'dark';
  };
  /** 当前编辑目标在 form 里的路径前缀（自定义方案按 id 索引，不用数组下标） */
  const slotPrefix = () => {
    const mode = currentMode();
    if (mode === 'light') return 'ui.uikit.light';
    if (mode === 'dark') return 'ui.uikit.dark';
    return `ui.uikit.custom.${mode.slice(7)}.tokens`;
  };
  const P = (k) => `${slotPrefix()}.${k}`;
  /** 当前编辑中的完整方案（用于预览与另存） */
  const currentScheme = () => resolveScheme(form.value('ui.uikit'));
  const replaceSchemeStore = (store) => queue('ui.uikit', store, false, true);
  const pushTheme = () => {
    themePreview(currentScheme()).catch(() => { /* 宿主不可用不阻断编辑 */ });
  };

  /** 切换方案 / 结构变化后重建整个组件库分区（路径前缀会变，必须重建控件） */
  function renderKit() {
    appearanceChoices.splice(0).forEach(dispose=>dispose());
    backgroundEditor?.dispose();
    backgroundEditor = null;
    const currentAppearanceFolds=[...kit.fields.querySelectorAll('details[data-appearance-group]')];
    const openAppearanceGroups=currentAppearanceFolds.length?new Set(currentAppearanceFolds.filter(group=>group.open).map(group=>group.dataset.appearanceGroup)):new Set([...savedAppearanceFolds].filter(([,isOpen])=>isOpen).map(([key])=>key));
    kit.fields.replaceChildren();
    const mode = currentMode();
    // A redraw after rename/palette/config refresh keeps the same logical upload.
    // Mode transitions still invalidate it, including A→B→A before its reply.
    const editorSlot = slotPrefix();
    const image = form.value(`${editorSlot}.bgImage`) ?? '';
    if (backgroundUploadMode !== mode || backgroundUploadImage !== image) {
      ++backgroundUploadVersion; backgroundUploadMode = mode; backgroundUploadImage = image;backgroundUploadFeedback=null;
    }
    const effective = currentScheme();
    const custom = migrateUikit(form.value('ui.uikit')).custom;
    const isBase = mode === 'light' || mode === 'dark';
    const slotLabel = isBase ? (mode === 'light' ? '亮色预设' : '暗色预设')
      : `自定义：${custom[mode.slice(7)]?.name ?? '（已删除）'}`;

    // ① 当前方案 + 另存为
    const head = document.createElement('div'); head.className = 'setting-field full';
    const headTitle = document.createElement('span'); headTitle.className = 'field-title';
    text(headTitle, `正在编辑：${slotLabel}`);
    const headRow = document.createElement('div'); headRow.className = 'actions';
    const nameInput = localInput(headRow, '方案名称', 'uikit-scheme-name'); nameInput.value = `我的方案 ${Object.keys(custom).length + 1}`;
    const createTheme=button('另存主题', () => {
      const name = String(nameInput.value || '').trim() || `我的方案 ${Object.keys(custom).length + 1}`;
      const { store, id } = saveCustom(form.value('ui.uikit'), name, currentScheme());
      replaceSchemeStore(store);
      refreshModeSelect();
      pushTheme(); renderKit();
      report(`已另存为「${name}」，并切换到该方案`);
    }, 'primary');createTheme.prepend(createIcon('plus',{size:16}));headRow.append(createTheme);
    const undo=button('',()=>{if(!previousAppearance)return;const previous=previousAppearance;queue('ui.uikit',previous,false,true);previousAppearance=null;refreshModeSelect();pushTheme();renderKit();});undo.append(createIcon('undo',{size:18}));undo.title='撤销本次外观调整';undo.setAttribute('aria-label','撤销本次外观调整');undo.disabled=!previousAppearance;headRow.append(undo);
    head.append(headTitle, headRow);
    const headHint = document.createElement('small'); headHint.className = 'field-hint';
    text(headHint, isBase
      ? '这是出厂基准。改动任意一项后点「另存为」，就会变成一个独立于亮/暗基准的自定义方案。'
      : '这个自定义方案独立于亮色/暗色基准，可放心修改。');
    headHint.hidden=true;head.append(headHint);headTitle.hidden=true;
    kit.fields.append(head);
    renderComponentPreview(kit.fields);

    // ② 自定义方案列表（切换 / 重命名 / 删除）
    const ids = Object.keys(custom);
    if (ids.length) {
      const listWrap = document.createElement('div'); listWrap.className = 'setting-field full';
      const listTitle = document.createElement('span'); listTitle.className = 'field-title';
      text(listTitle, `自定义方案（${ids.length}）`);
      listWrap.append(listTitle);
      const list = document.createElement('div'); list.className = 'settings-list'; list.dataset.motionList = 'uikit-schemes';
      for (const id of ids) {
        const item = document.createElement('div'); item.className = 'settings-list-row'; item.dataset.motionKey = `scheme:${id}`;
        const swatch = document.createElement('span'); swatch.className = 'scheme-swatch';
        const c = custom[id]?.tokens ?? {};
        swatch.style.background = `linear-gradient(135deg, ${c.bg ?? '#222'} 0 50%, ${c.accent ?? '#666'} 50% 100%)`;
        const itemRow = row(custom[id]?.name ?? id, '');
        itemRow.append(button('应用', () => { queue('ui.uikit.mode', `custom:${id}`); refreshModeSelect(); pushTheme(); renderKit(); }, currentMode() === `custom:${id}` ? 'primary' : ''));
        const renameBox = localInput(itemRow, '新名称', `uikit-rename-${id}`); renameBox.value = custom[id]?.name ?? '';
        itemRow.append(button('重命名', () => {
          const next = String(renameBox.value || '').trim();
          if (!next) { report('请输入方案名称', true); return; }
          replaceSchemeStore(renameCustom(form.value('ui.uikit'), id, next));
          refreshModeSelect(); renderKit(); report('已重命名');
        }));
        itemRow.append(destructiveButton('删除', async () => {
          replaceSchemeStore(deleteCustom(form.value('ui.uikit'), id));
          refreshModeSelect(); pushTheme(); renderKit(); report('已删除');
        }, {
          target: () => item, clicks: 2, key: () => id,
          impact: `将删除自定义方案「${custom[id]?.name ?? id}」；若正在使用它，界面会切回暗色基准。`,
        }));
        item.append(swatch, itemRow);
        list.append(item);
      }
      listWrap.append(list);
      kit.fields.append(listWrap);
    }

    // ③ 成型风格预设（配色起点）
    const presetRow = document.createElement('div'); presetRow.className = 'actions';
    for (const [name, preset] of Object.entries(PRESETS)) {
      const palette=button('', () => {
        for (const [k, v] of Object.entries(preset.tokens)) queue(P(k), v);
        pushTheme(); renderKit();
      });palette.className='palette-choice';palette.dataset.palette=name;palette.title=preset.label;palette.setAttribute('aria-label',preset.label);
      for(const key of ['bg','surface','accent','text']){const swatch=document.createElement('span');swatch.style.background=preset.tokens[key]||effective[key];swatch.setAttribute('aria-hidden','true');palette.append(swatch);}const selectedMark=document.createElement('span');selectedMark.className='palette-check';selectedMark.append(createIcon('check',{size:14}));palette.append(selectedMark);presetRow.append(palette);
    }
    refreshPalette=()=>{const current=currentScheme();for(const palette of presetRow.querySelectorAll('.palette-choice')){const preset=PRESETS[palette.dataset.palette];palette.setAttribute('aria-pressed',String(Object.entries(preset.tokens).every(([key,value])=>current[key]===value)));}};refreshPalette();
    const presetWrap = document.createElement('div'); presetWrap.className = 'setting-field full';
    const presetTitle = document.createElement('span'); presetTitle.className = 'field-title'; text(presetTitle, '配色');
    const presetHint = document.createElement('small'); presetHint.className = 'field-hint';
    presetHint.hidden=true;
    presetWrap.append(presetTitle, presetRow, presetHint);
    kit.fields.append(presetWrap);

    // ④ 颜色
    for (const [key, label] of COLOR_FIELDS) {
      const wrap = document.createElement('label'); wrap.className = 'setting-field';
      const title = document.createElement('span'); title.className = 'field-title'; text(title, label);
      const input = document.createElement('input'); input.type = 'color';
      input.id = `field-uikit-${key}`; input.dataset.configPath = P(key);
      input.value = effective[key];
      input.addEventListener('input', () => { queue(P(key), input.value); pushTheme(); });
      input.addEventListener('change', () => { void themePreview.flush().catch(() => {}); });
      wrap.append(title, input); kit.fields.append(wrap);
    }

    // ⑤ 背景图：上传后立即预览并自动保存。
    // Preview/crop use the host viewport, including while its window resizes.
    const bgWrap = document.createElement('div'); bgWrap.className = 'setting-field full';
    const bgTitle = document.createElement('span'); bgTitle.className = 'field-title'; text(bgTitle, '背景');
    const bgNote = document.createElement('p'); bgNote.className = 'field-hint';
    bgNote.textContent = '图片、动图或 MP4 / WebM 视频，保留原文件质量，最大 256MB。视频静音循环播放。';
    // 文件选择器：由编辑器"选择图片"按钮触发
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm';
    fileInput.style.display = 'none';
    let pickerVersion = null;
    const uploadScopeLive = () => currentMode() === mode && !disposed && !backgroundUploadLeaving
      && !resetting && !resetPreparing && !resetAccepted;
    const showUploadStatus=(message,failed=false)=>{
      if(!uploadScopeLive())return;
      backgroundUploadFeedback={message,failed};backgroundEditor?.setUploadStatus(message,failed);
    };
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file || !uploadScopeLive() || (!currentEditor() && pickerVersion !== backgroundUploadVersion)) return;
      const uploadVersion = ++backgroundUploadVersion;
      const uploadCurrent = () => uploadVersion === backgroundUploadVersion && uploadScopeLive();
      try {
        showUploadStatus('正在读取背景文件…');
        const up=await uploadBackgroundFile(file,{request,isCurrent:uploadCurrent,onProgress:message=>{if(uploadCurrent())showUploadStatus(message);}});
        if (!uploadCurrent()) return;
        // 新图进来后重置裁切参数：默认整页铺满、无旋转，避免沿用上一张的构图
        // A newly selected image must be visible even if the old one was hidden.
        // Read the current value after upload so an intervening opacity edit wins.
        if (Number(currentScheme().bgOpacity) === 0) queue(`${editorSlot}.bgOpacity`, 0.2);
        queue(`${editorSlot}.bgImage`, up.url);
        queue(`${editorSlot}.bgRotate`, 0);
        queue(`${editorSlot}.bgZoom`, 1);
        queue(`${editorSlot}.bgOffsetX`, 0);
        queue(`${editorSlot}.bgOffsetY`, 0);
        if(isVideoBackground(up.url)&&currentScheme().bgFit==='repeat')queue(`${editorSlot}.bgFit`,'cover');
        // This request owns the new reference; its redraw must not cancel a
        // picker already opened for the same slot while this upload was pending.
        backgroundUploadImage = up.url;
        pushTheme();
        const feedback=`${isVideoBackground(up.url)?'视频':'图片'}已按原文件导入 · ${file.size>=1024*1024?(file.size/1024/1024).toFixed(1)+'MB':Math.round(file.size/1024)+'KB'}`;
        showUploadStatus(feedback);report(feedback);
        refreshBackgroundKit?.();
      } catch (error) {
        if (uploadCurrent()) {showUploadStatus(error.message,true);report(`上传失败：${error.message}`, true);saveFeedback('error',error.message);}
      } finally { if (uploadCurrent()) fileInput.value = ''; }
    });

    function currentEditor() {
      return !disposed && !backgroundUploadLeaving && !resetting && !resetPreparing && !resetAccepted
        && backgroundEditor === editor && currentMode() === mode;
    }
    const editor = createBackgroundEditor({
      getViewport:()=>backgroundViewport,
      getImage: () => form.value(P('bgImage')) ?? '',
      getValues: () => ({
        bgRotate: form.value(P('bgRotate')) ?? 0,
        bgZoom: form.value(P('bgZoom')) ?? 1,
        bgOffsetX: form.value(P('bgOffsetX')) ?? 0,
        bgOffsetY: form.value(P('bgOffsetY')) ?? 0,
        bgFit: form.value(P('bgFit')) ?? 'cover',
      }),
      onChange: (patch) => {
        if (!currentEditor()) return;
        // 必须走 queue() 而不是 form.set()：queue 才会标脏 + 触发防抖保存。
        // 直接 form.set 的后果是配置永远不落盘（实测重启后背景图参数全丢）。
        // 逐项 queue 会各自起一个防抖窗口，clearTimeout 相互覆盖，正好合并成一次提交。
        for (const [key, value] of Object.entries(patch)) queue(`${editorSlot}.${key}`, value);
        pushTheme();
        editor.refresh();
      },
      onUpload: () => { if (currentEditor()) { pickerVersion = backgroundUploadVersion; fileInput.click(); } },
      onClear: () => {
        if (!currentEditor()) return;
        ++backgroundUploadVersion;
        backgroundUploadFeedback=null;
        queue(`${editorSlot}.bgImage`, '');
        pushTheme();
        renderKit();
      },
    });
    backgroundEditor = editor;
    if(backgroundUploadFeedback)editor.setUploadStatus(backgroundUploadFeedback.message,backgroundUploadFeedback.failed);
    bgWrap.append(bgTitle, bgNote, editor.element, fileInput);
    kit.fields.append(bgWrap);

    const slider = (key, label, min, max, step, fmt) => {
      const wrap = document.createElement('label'); wrap.className = 'setting-field';
      const title = document.createElement('span'); title.className = 'field-title'; text(title, label);
      const input = document.createElement('input'); input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.id = `field-uikit-${key}`; input.dataset.configPath = P(key);
      const v = effective[key];
      input.value = String(v);
      const hint = document.createElement('small'); hint.className = 'field-hint'; hint.textContent = fmt(Number(v));
      input.addEventListener('input', () => {
        const n = Number(input.value);
        queue(P(key), n); hint.textContent = fmt(n); pushTheme();
      });
      wrap.append(title, input, hint); kit.fields.append(wrap);
    };
    slider('bgOpacity', '背景不透明度', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`);
    slider('bgBlur', '背景模糊', 0, 20, 1, (v) => `${v}px`);

    // ⑥ 形状 / 布局
    slider('radius', '圆角基准', 0, 16, 1, (v) => `${v}px`);
    const pick = (key, label, options, hint = '') => {
      const wrap = document.createElement('label'); wrap.className = 'setting-field';
      const title = document.createElement('span'); title.className = 'field-title'; text(title, label);
      const select = document.createElement('select');
      select.id = `field-uikit-${key}`; select.dataset.configPath = P(key);
      for (const [value, labelText] of options) {
        const option = document.createElement('option'); option.value = String(value); text(option, labelText); select.append(option);
      }
      select.value = String(effective[key]);
      select.addEventListener('change', () => {
        const raw = select.value;
        queue(P(key), key === 'density' ? Number(raw) : raw);
        pushTheme();
        if (key === 'bgFit') backgroundEditor?.refresh();
      });
      wrap.append(title, select);
      if (hint) { const hintEl = document.createElement('small'); hintEl.className = 'field-hint'; text(hintEl, hint); wrap.append(hintEl); }
      kit.fields.append(wrap);
      if(['bgFit','density','sidebar','btnAlign'].includes(key))appearanceChoices.push(mountChoiceCards(select).dispose);
    };
    pick('bgFit', '背景铺法', [['cover', '铺满'], ['contain', '完整显示'], ...(!isVideoBackground(effective.bgImage)?[['repeat','平铺']]:[])]);
    pick('density', '间距密度', [[0.85, '紧凑'], [1, '标准'], [1.25, '宽松']]);
    pick('sidebar', '侧边栏', [['left', '左侧'], ['right', '右侧'], ['hidden', '隐藏']]);
    pick('btnAlign', '按钮排布', [['left', '靠左'], ['center', '居中'], ['right', '靠右']]);
    pick('styleMode', '外观风格', [['endfield', '暖黑黄绿 · 默认'], ['classic', '经典靛蓝'], ['signal', '简洁线条'], ['flux', '深紫荧光']], '默认使用暖黑底色与荧光黄绿强调，浅色基准使用骨白与橄榄绿；外观模式调整控件形状和质感，具体颜色可单独设置。');

    const gradWrap = document.createElement('label'); gradWrap.className = 'setting-field is-switch';
    const gradTitle = document.createElement('span'); gradTitle.className = 'field-title'; text(gradTitle, '强调色用渐变');
    const gradInput = document.createElement('input'); gradInput.type = 'checkbox';
    gradInput.id = 'field-uikit-gradient'; gradInput.dataset.configPath = P('gradient');
    gradInput.checked = effective.gradient === true;
    gradInput.addEventListener('change', () => { queue(P('gradient'), gradInput.checked); pushTheme(); });
    gradWrap.append(gradTitle, gradInput, switchPill(gradInput)); kit.fields.append(gradWrap);

    // ⑦ 恢复当前基准出厂。
    // 必须 append 到 kit.fields（每次 renderKit 会被 replaceChildren 清空），
    // 不能 append 到 kit.card —— 卡片本身不会被清空，每渲染一次就多挂一个按钮
    // （实测点几次切换就叠出 5 个"恢复当前预设出厂"）。
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(destructiveButton(isBase ? '恢复当前预设出厂' : '把当前方案重置为暗色基准', async () => {
      ++backgroundUploadVersion;
      const store = migrateUikit(form.value('ui.uikit'));
      const base = resolveScheme({ mode: mode === 'light' ? 'light' : 'dark' });
      if (isBase) store[mode] = null;
      else store.custom[mode.slice(7)] = { ...store.custom[mode.slice(7)], tokens: base };
      replaceSchemeStore(store);
      pushTheme(); renderKit();
      report('已恢复出厂外观，正在保存');
    }, {
      target: () => kit.fields, clicks: 3, key: currentMode,
      impact: `将丢弃${slotLabel}的自定义外观和背景设置，恢复为${mode === 'light' ? '亮色' : '暗色'}出厂基准。`,
    }));
    kit.fields.append(actions);
    const personalization=renderAppearanceControls({effective,path:P,change:(key,value)=>{queue(P(key),value);pushTheme();}});appearanceChoices.push(personalization.dispose);
    const feels=renderAppearanceFeels({effective,change:(tokens,group,id)=>{for(const [key,value]of Object.entries(tokens))queue(P(key),value);pushTheme();renderKit();kit.fields.querySelector(`[data-appearance-feel="${group}"] [data-feel-value="${id}"]`)?.focus();}});
    presetRow.append(undo);organizeAppearance(kit.fields,{background:bgWrap,presets:presetWrap,themeHeader:head,quick:feels,personalization:personalization.groups,open:openAppearanceGroups});
    const visualEntry=document.createElement('div');visualEntry.className='appearance-visual-entry full';
    const visualCopy=document.createElement('div'),visualTitle=document.createElement('strong'),visualHint=document.createElement('small');
    visualTitle.textContent='点哪里，改哪里';visualHint.textContent='单独调整任意元素，或统一修改同类控件。变化立即可见，自动保存。';visualCopy.append(visualTitle,visualHint);
    visualEntry.append(visualCopy,button('点选编辑',async()=>{await saveAll();await themePreview.flush();await openVisualEditor();},'primary'));kit.fields.prepend(visualEntry);
  }

  // 「界面预设」切换 → 重建（编辑目标换了，控件路径随之改变）
  const modeSelect = document.querySelector('#field-ui-uikit-mode');
  modeSelect?.addEventListener('change', () => { pushTheme(); renderKit(); });

  refreshBackgroundKit = () => { if (!disposed && !backgroundUploadLeaving && kit.card.isConnected) renderKit(); };
  renderKit();

  settingsStructure=composeSettingsStructure({sections,host:fieldsHost,read:path=>form.value(path),write:(path,value,replace=false)=>{const control=controls.get(path);if(control){if(control.type==='checkbox')control.checked=value;else control.value=typeof value==='object'?JSON.stringify(value,null,2):String(value);}queue(path,value,false,replace);},request,activityDraft,commitActivity,getProviders:()=>providers,onActivityChange:()=>{settingsStructure?.refresh();saveLifecycle.sync();},save:async()=>{try{return await saveAll();}catch(error){report(error.message,true);throw error;}},reload:()=>load(true),onEditorClosed:id=>{if(id==='model-manager'){providerManager?.clearSecrets();void providerManager?.flush().catch(error=>report(error.message,true));}},onIdle:()=>{
    if(settingsReadDeferred){settingsReadDeferred=false;void load();}
  }});
  for (const group of fieldsHost.querySelectorAll('details[data-settings-group]')) {
    if (foldStates.has(group.dataset.settingsGroup)) group.open = foldStates.get(group.dataset.settingsGroup);
  }
  buildSectionNav();
  settingsStructure.restore(openEditors);
  updateSecretStates();
}

// 筛选输入：只影响通道条的显隐，不碰任何字段 DOM，因此不会打断正在输入/防抖保存。
$('#settings-filter')?.addEventListener('input', (event) => {
  sectionFilter = String(event.target.value || '').trim().toLowerCase();
  buildSectionNav();
});
async function load(force = false) {
  if(providerManager?.dirty){if(!force)return;try{await providerManager.flush();}catch(error){report(error.message,true);return;}}
  if (loading || reloadConfirmation || resetting || resetAccepted || disposed) return;
  if(!force&&protectedSettingsDialog()){settingsReadDeferred=true;return;}
  if(force)settingsReadDeferred=false;
  if (!force && (form.dirty || hasAutoSaves() || settingsStructure?.activityDirty || invalid.size || saving || hasFocusedSettingInput())) return;
  if (force && (form.dirty||settingsStructure?.activityDirty||invalid.size)) {
    const snapshot = form.snapshot();
    const activitySnapshot=settingsStructure?.activitySnapshot();
    // Pause before opening the dialog: waiting for the user's decision must
    // not allow the original debounce timer to commit the proposed discard.
    reloadConfirmation = true;
    clearTimeout(saveTimer);
    let accepted;
    try { accepted = await confirmAction('重新读取将放弃未保存的普通设置，继续吗？'); }
    finally { reloadConfirmation = false; }
    if (!accepted) { scheduleSave(); return; }
    clearTimeout(saveTimer);
    form.discardPending(snapshot);
    settingsStructure?.discardActivity(activitySnapshot);
    saveLifecycle.sync();
    // Input entered during the confirmation still belongs to its newer draft.
    if(settingsStructure?.activityDirty){scheduleSave();return;}
    render();
    scheduleSave();
  }
  loading = true;
  const readFormVersion = form.version, readSaveRevision = saveCommitRevision,readActivityVersion=settingsStructure?.activityVersion;
  const readIsCurrent = () => form.version === readFormVersion && saveCommitRevision === readSaveRevision&&settingsStructure?.activityVersion===readActivityVersion;
  let refreshAfterSave = false;
  try {
    const resetVersion = resetStatusVersion;
    const runtime = await request('GET', '/api/status');
    settingsStructure?.updateRuntime(runtime);
    if (disposed || resetting || (resetAccepted && fieldsHost.childElementCount)) return;
    let reset = resetVersion === resetStatusVersion ? runtime.reset : knownResetStatus || runtime.reset;
    if (['preparing', 'accepted', 'failed'].includes(reset?.phase)) {
      // During reset the backend deliberately blocks reads that can populate
      // caches or reach external services. Reopen using the two allowed local views.
      const [config, p] = await Promise.all([request('GET', '/api/config'), request('GET', '/api/providers')]);
      if (disposed || resetting || (resetAccepted && fieldsHost.childElementCount)) return;
      if (resetVersion !== resetStatusVersion) reset = knownResetStatus || reset;
      if (readIsCurrent()) {
        config.ui ??= {}; config.ui.uikit = migrateUikit(config.ui.uikit);
        if (!fieldsHost.childElementCount) {
          form.discard(config); providers = p.providers || []; personaTemplates.accept({templates:[]}); tools = []; availability = []; searchProviders = [];
          render();
        } else form.mergeBase(config);
      } else refreshAfterSave = force && saveCommitRevision !== readSaveRevision;
      applyResetStatus(acceptedResetReceipt || reset);
      void contentReady();
      return;
    }
    const visionVersion = ++visionReadVersion,templateTicket=personaTemplates.ticket();
    const [config, p, t, tl, av, sp, vision] = await Promise.all([request('GET', '/api/config'), request('GET', '/api/providers'), request('GET', '/api/persona-templates'), request('GET', '/api/tools'), request('GET', '/api/tools/availability'), request('GET', '/api/search-providers'), request('GET', '/api/vision/results').catch(error => ({ error: error.message }))]);
    if (disposed || resetting || resetAccepted) return;
    if(!force&&protectedSettingsDialog()){settingsReadDeferred=true;return;}
    if (visionVersion === visionReadVersion) { visionResults = vision.results || {}; visionError = vision.error || ''; updateModelVision(); }
    // A newer edit or accepted save owns the base even after dirty becomes false.
    if (!readIsCurrent()) { refreshAfterSave = force && saveCommitRevision !== readSaveRevision; return; }
    personaTemplates.accept(t,templateTicket);
    if (!resetPreparing) {
      ++toolAvailabilityReadVersion;
      availability = av.tools || []; toolAvailabilityPending = false; updateToolAvailability();
    }
    // An SSE/network reply may arrive after the first keystroke; don't erase it.
    if (form.dirty || hasAutoSaves() || settingsStructure?.activityDirty || saving || hasFocusedSettingInput()) { form.mergeBase(config);settingsStructure?.refresh(); updateSecretStates(); updateModelVision(); return; }
    config.ui ??= {};
    config.ui.uikit = migrateUikit(config.ui.uikit);
    const base=structuredClone(form.base);base.ui??={};base.ui.uikit=migrateUikit(base.ui.uikit);
    const catalogueKey=JSON.stringify([p.providers||[],t.templates||[],tl.tools||[],av.tools||[],sp.providers||[],vision.results||{},vision.error||'']);
    const viewKey = JSON.stringify([config, p.providers || [], t.templates || [], tl.tools || [], av.tools || [], sp.providers || [], vision.results || {}, vision.error || '']);
    if (!force && !invalid.size && (renderedView?.key === viewKey && renderedView.version === form.version || renderedView?.catalogueKey===catalogueKey&&JSON.stringify(config)===JSON.stringify(base))) {
      form.mergeBase(config);renderedView={key:viewKey,catalogueKey,version:form.version};updateSecretStates();report('');return;
    }
    form.discard(config); providers = p.providers || []; tools = tl.tools || []; availability = av.tools || []; searchProviders = sp.providers || [];
    render(); renderedView = { key: viewKey,catalogueKey,version: form.version }; report('');void contentReady();
  } catch (error) { if (!resetting && !resetAccepted) {report(error.message, true);if(!disposed)void contentReady();} } finally {
    loading = false;
    if(pendingConnectQQ!==null&&settingsStructure&&!resetting&&!resetAccepted&&!disposed){const target=pendingConnectQQ;pendingConnectQQ=null;openAccountConnection(target);}
    if (refreshAfterSave) void load(); // One fresh read; existing guards retain later input and reset state.
  }
}
$('#save').hidden=true;
$('#save').addEventListener('click', () => guarded(saveAll));
$('#reload').addEventListener('click', () => guarded(async()=>{await flushAutoSaves();await saveAll();await load(true);}));
$('#open-data').addEventListener('click', () => guarded(() => request('POST', '/api/open-data-dir', {})));
$('#preview').addEventListener('click', () => guarded(async () => { const patch = form.snapshot().patch; const result = await request('POST', '/api/prompt-preview', patch); text($('#prompt'), result.systemPrompt); }));
function lockResetForm(locked) {
  if (locked) {
    settingsStructure?.closeEditors();
    for (const control of document.querySelectorAll('#fields input, #fields select, #fields textarea, #fields button, #save, #reload, #preview, #reset')) {
      if (!resetDisabled.has(control)) resetDisabled.set(control, control.disabled);
      control.disabled = true;
    }
    fieldsHost.inert = true;
  } else {
    for (const [control, disabled] of resetDisabled) control.disabled = disabled;
    resetDisabled.clear(); fieldsHost.inert = false;
  }
}
function resetResult(state, message, backupDir = '') {
  let card = $('#reset-result');
  if (!card) {
    card = document.createElement('section'); card.id = 'reset-result'; card.className = 'card'; card.setAttribute('role', 'status');
    document.querySelector('main > header').after(card);
  }
  card.dataset.state = state; clear(card);
  const heading = document.createElement('h3'); text(heading, state === 'accepted' ? '已接受重置，等待重启完成' : state === 'preparing' ? '服务器正在提交重置，请等待结果' : '重置未成功，当前表单已保留');
  card.append(heading, empty(message));
  if (backupDir) {
    const location = document.createElement('p'), path = document.createElement('code');
    location.append(document.createTextNode('原数据备份：')); text(path, backupDir); path.style.overflowWrap = 'anywhere'; location.append(path); card.append(location);
  }
  if (state === 'accepted') {
    card.append(empty('请彻底退出并重新启动 QQ Agent，再重新打开控制台。刷新网页不能完成重置或重启应用。'),
      empty('桌面应用：彻底退出 QQ Agent（仅关窗口可能仍在托盘运行），然后重新启动。'),
      empty('外部浏览器：先退出并重新启动提供控制台的 QQ Agent 进程，再重新打开控制台。'));
  }
}
function isAcceptedReset(result) {
  return result?.resetAccepted === true && result.resetCompleted === false && result.restartRequired === true && typeof result.backupDir === 'string' && Boolean(result.backupDir);
}
function applyAcceptedReset(result) {
  acceptedResetReceipt = result;
  resetPreparing = false;
  resetAccepted = true; clearTimeout(saveTimer); saveTimer = null;
  form.discard(form.base); invalid.clear(); lockResetForm(true);
  saveLifecycle.sync();
  resetResult('accepted', result.message || '备份和重置申请已提交，请重启应用完成清理。', result.backupDir);
  report('已接受重置，等待重启完成 · 请重启 QQ Agent');
}
function applyResetStatus(result) {
  if (isAcceptedReset(result)) { applyAcceptedReset(result); return; }
  if (resetAccepted) return;
  if (result?.phase === 'preparing') {
    resetPreparing = true; clearTimeout(saveTimer); saveTimer = null; lockResetForm(true);
    saveLifecycle.sync();
    resetResult('preparing', '服务器正在备份并提交重置，请等待结果；当前表单已暂停保存。');
    report('正在备份并提交重置，请等待服务器确认…');
  } else if (result?.phase === 'failed') {
    resetPreparing = false;
    saveLifecycle.sync();
    if (!resetting) lockResetForm(false);
    resetResult('error', lastResetError || '上次重置未提交，当前实例业务已暂停，请重启恢复；已保存设置可读取，普通设置草稿仍可保存。');
    report(lastResetError || '上次重置未提交 · 请重启 QQ Agent 恢复业务', true); scheduleSave();
  }
}
async function resetData() {
  if (resetting || resetPreparing || resetAccepted || disposed) return;
  resetting = true; clearTimeout(saveTimer); saveTimer = null;
  saveLifecycle.sync();
  try {
    // A config write already on the wire must settle before its snapshot is backed up.
    if (saving) await saving;
    lastResetError = '';
    lockResetForm(true); report('正在备份并提交重置，请等待服务器确认…');
    const result = await request('POST', '/api/reset-data', {});
    if (result?.ok !== true || !isAcceptedReset(result)) {
      throw new Error(result?.message || '服务器未确认重置已提交；当前表单保留，请检查运行状态。');
    }
    applyAcceptedReset(result);
  } catch (error) {
    resetPreparing = false; lastResetError = error.message || '操作失败';
    resetResult('error', lastResetError); report(lastResetError, true);
    throw error; // The shared visual layer must distinguish failure from completion.
  } finally {
    resetting = false;
    saveLifecycle.sync();
    if (!resetAccepted) { lockResetForm(false); scheduleSave(); if (toolAvailabilityPending) void refreshToolAvailability(); }
  }
}
const resetAction = bindDestructiveAction($('#reset'), {
  action: resetData, target: () => document.querySelector('main'), clicks: 6, windowTint: true,
  onError:()=>{}, // resetData already preserves the form and reports its error.
  impact: '将清空全部聊天、记忆、密钥与设置。服务器会先建立原数据备份并提交重置申请，完整清理在下次启动 QQ Agent 时执行；接受后当前表单会锁定，需彻底退出并重启应用。',
  canActivate: () => !resetting && !resetPreparing && !resetAccepted && !disposed,
});
onBeforeLeave(async () => { if(resetAccepted)return;try{await flushAutoSaves();await blocklistRaw.flushGuard();await saveAll();await blocklistRaw.flushGuard();}catch(error){report(error.message,true);throw error;} });
const liveSettings=createLiveRefresh(async()=>{
  if(protectedSettingsDialog()||form.dirty||hasAutoSaves()||saving||hasFocusedSettingInput()){settingsReadDeferred=true;return;}
  settingsReadDeferred=false;await load();
});
const settingsBlur=()=>{if(settingsReadDeferred)liveSettings.request();};
document.addEventListener('focusout',settingsBlur);
document.addEventListener('close',settingsBlur,true);
onLeave(()=>{liveSettings.dispose();document.removeEventListener('focusout',settingsBlur);document.removeEventListener('close',settingsBlur,true);});
onShellEvent((name, payload) => {
  if(name==='viewport-size'&&Number.isFinite(payload?.width)&&Number.isFinite(payload?.height)&&payload.width>0&&payload.height>0){backgroundViewport={width:payload.width,height:payload.height};backgroundEditor?.resize();}
  if(name==='hello')liveSettings.request();
  if(['plugin-loaded','plugin-unloaded','plugin-error'].includes(name)){void refreshToolAvailability();liveSettings.request();}
  if (name === 'onebot-status') settingsStructure?.updateRuntime({onebot:payload});
  else if (name === 'status' && payload?.onebot) settingsStructure?.updateRuntime(payload);
  if (name === 'settings-section' && ['models','access','onebot'].includes(payload?.section)) {
    activeSection = payload.section;sectionFilter = '';
    $('#settings-filter').value = '';
    if (navigationSections().has(activeSection)) { buildSectionNav();selectSection(activeSection); }
    if(payload.section==='onebot'&&(payload.connectQQ===true||typeof payload.connectQQ==='string'&&/^\d{5,20}$/.test(payload.connectQQ)))openAccountConnection(payload.connectQQ);
  }
  if (name === 'status' && payload?.reset) { knownResetStatus = payload.reset; ++resetStatusVersion; applyResetStatus(payload.reset); }
  if(name==='status'&&payload?.personaTemplatesUpdated){void personaTemplates.refresh();void settingsStructure?.refreshPersonas();void syncPersonaByChat();}
  if(name==='status'&&payload?.personaByChatUpdated){void personaByChat.refresh();void settingsStructure?.refreshPersonas();void syncPersonaByChat();}
  if (name === 'status' && payload?.configUpdated && !payload.personaTemplatesUpdated && !payload.personaByChatUpdated) {
    liveSettings.request();
  }
  if (name === 'vision-scan') { const target = $('#api-test-result'); if (target) output(target, payload); if (['done', 'error'].includes(payload?.phase)) void refreshVisionResults(); }
});
window.addEventListener('pagehide', () => { disposed = true; ++backgroundUploadVersion; refreshBackgroundKit = null; backgroundEditor?.dispose(); resetAction.dispose(); clearTimeout(saveTimer); });
void load();
