import { installDisposableDialog } from '../dialog-lifecycle.js';
import { bindDestructiveAction } from '../destructive-action.js';
import {createConditionalMotion} from './conditional-motion.js';
import {createAutoSave,flushAutoSaves} from './auto-save.js';

const ids = value => new Set((Array.isArray(value) ? value : []).map(String));
const same = (a, b) => a.size === b.size && [...a].every(item => b.has(item));

export function normalizeQQList(payload, kind) {
  if (!payload || !Array.isArray(payload[kind])) return { phase: 'invalid', items: [], error: '返回的名单格式不正确；白名单未更新。' };
  const items = new Map();
  for (const item of payload[kind]) {
    const raw = item && typeof item === 'object' ? item.id ?? (kind === 'groups' ? item.group_id : item.user_id) : null;
    const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (!/^\d{1,15}$/.test(id)) return { phase: 'invalid', items: [], error: '名单含无效号码；白名单未更新。' };
    const rawName = item.name ?? item.group_name ?? item.remark ?? item.nickname;
    const name = typeof rawName === 'string' || typeof rawName === 'number' ? String(rawName) : id;
    if (!items.has(id)) items.set(id, { id, name });
  }
  return { phase: items.size ? 'ready' : 'empty', items: [...items.values()], error: items.size ? '' : '本次没有读到列表；白名单未更新。可重试或取消。' };
}

export function createListChoiceDraft(selected = [], initialAll = false) {
  let confirmed = ids(selected), draft = ids(selected), live = [], phase = 'loading', error = '';
  let closed = false, generation = 0, revision = 0, sequence = 0, active = null, staged = false;
  let allowAll=initialAll===true,allTouched=false,allRevision=0,policyStaged=false;
  const canSubmit=()=>!closed&&!active&&(phase==='ready'||allowAll||allTouched||policyStaged);
  const candidates = () => {
    const map = new Map(live.map(item => [item.id, { ...item, savedOnly: false }]));
    for (const id of new Set([...confirmed, ...draft])) if (!map.has(id)) map.set(id, { id, name: id, savedOnly: true });
    return [...map.values()];
  };
  return {
    view: () => ({ phase, error, closed, staged, allowAll, policyChanged:allTouched||policyStaged,selected: [...draft], candidates: candidates(), saving: !!active, canSubmit:canSubmit(), pending: staged || allTouched || !same(draft, confirmed) }),
    beginRead() { if (closed) return null; phase = 'loading'; error = ''; return ++generation; },
    acceptRead(ticket, payload, kind) { if (closed || ticket !== generation) return false; const next = normalizeQQList(payload, kind); phase = next.phase; live = next.items; error = next.error; return true; },
    rejectRead(ticket, reason) { if (closed || ticket !== generation) return false; phase = 'failed'; error = String(reason?.message ?? reason); return true; },
    choose(id, checked) { if (closed || allowAll || phase !== 'ready' || !candidates().some(item => item.id === id)) return false; if (draft.has(id) === checked) return false; checked ? draft.add(id) : draft.delete(id); revision++; error = ''; return true; },
    add(id){id=String(id);if(closed||allowAll||!/^[1-9]\d{0,14}$/.test(id)||draft.has(id))return false;draft.add(id);phase='ready';revision++;error='';return true;},
    chooseAll(value){if(closed||allowAll===(value===true))return false;allowAll=value===true;allTouched=true;allRevision=++revision;error='';return true;},
    beginCommit() { if (!canSubmit()) return null; if (!staged && !allTouched && same(draft, confirmed)) return { noop: true }; active = { attempt: ++sequence, revision, selected: [...draft],allowAll,policyChanged:allTouched||policyStaged,allRevision }; staged = true;policyStaged=active.policyChanged;error = ''; return structuredClone(active); },
    acceptCommit(receipt) { if (closed || !active || receipt.attempt !== active.attempt) return { ignored: true }; const sent = active; confirmed = new Set(sent.selected);if(allRevision===sent.allRevision)allTouched=false;active = null; staged = policyStaged = false;error = ''; return { close: revision === sent.revision, pending: allTouched||!same(draft, confirmed) }; },
    rejectCommit(receipt, reason) { if (closed || !active || receipt.attempt !== active.attempt) return false; active = null; error = String(reason?.message ?? reason); return true; },
    close() { closed = true; generation++; active = null; },
  };
}

export function groupCandidates({ allow = [], sliders = {}, peaks = {}, live = [] } = {}) {
  const allowed = ids(allow), stored = new Set([...Object.keys(sliders ?? {}), ...Object.keys(peaks ?? {})]);
  const names = new Map(live.map(item => [String(item.id), item.name]));
  return [...new Set([...allowed, ...names.keys(), ...stored])].map(id => ({ id, name: names.get(id) || `群 ${id}`, allowed: allowed.has(id), stored: stored.has(id), live: names.has(id) }));
}

export function openListChoice({ kind, load, getSelected, getAllowAll=()=>false,getEmptyPolicy = () => false, commit, isCurrent = () => true, onError = () => {}, onSaved = () => {} }) {
  const doc = document, state = createListChoiceDraft(getSelected(),getAllowAll());
  const visibility=createConditionalMotion(doc);
  const root = doc.createElement('dialog'); root.className = 'settings-list-choice'; root.dataset.choiceKind = kind;
  const heading = doc.createElement('h3'); heading.textContent = kind === 'groups' ? '选择允许响应的群' : '选择允许响应的好友';
  const allowAll=doc.createElement('button');allowAll.type='button';allowAll.className='allow-all-toggle';allowAll.setAttribute('role','switch');allowAll.textContent=kind==='groups'?'允许所有群聊':'允许所有私聊';
  const search = doc.createElement('input'); search.type = 'search'; search.placeholder = '搜索名称或号码'; search.setAttribute('aria-label', '搜索名单');
  const notice = doc.createElement('p'); notice.setAttribute('role', 'status');notice.dataset.choiceNotice='';
  const count = doc.createElement('p'), impact = doc.createElement('p'), host = doc.createElement('div'), actions = doc.createElement('div'); actions.className = 'actions';
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = '重新读取列表';
  const apply = doc.createElement('button'); apply.type = 'button'; apply.className = 'primary';
  const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  // Collapse one clipped flow region. Independent outgoing overlays let the
  // moving footer cross list rows that are still fading out.
  const viewport=doc.createElement('div'),options=doc.createElement('div');
  viewport.className='list-choice-viewport';options.className='list-choice-options';options.id=`list-choice-${kind}-options`;
  allowAll.setAttribute('aria-controls',options.id);
  options.append(search,count,host,retry);viewport.append(options);
  impact.className='list-choice-impact';
  apply.hidden=true;actions.append(apply,cancel); root.append(heading,allowAll,notice,impact,viewport,actions);
  let closed = false, clearAction,shownAllowAll=state.view().allowAll;
  const lifecycle = installDisposableDialog(root, {beforeClose:()=>flushAutoSaves(root),onClosed() { closed = true;autoSave.dispose(); visibility.dispose();clearAction?.dispose(); state.close(); window.removeEventListener('pagehide', dispose); } });
  const autoSave=createAutoSave({root,save:saveSelection,dirty:()=>state.view().pending,onError});
  function dispose() { lifecycle.dispose(); }
  function status(message = '') {
    const view = state.view(), current = isCurrent();
    // A cleared list error must not move the centred dialog on this click.
    // Keep errors outside the optional list so failed all-mode saves stay visible.
    if(view.allowAll!==shownAllowAll&&notice.getBoundingClientRect().height){notice.style.minHeight=`${notice.getBoundingClientRect().height}px`;notice.dataset.preserveSpace='';}
    shownAllowAll=view.allowAll;
    // Capture the old flow size before clearing an error/rewriting labels.
    visibility.set(options,!view.allowAll);
    notice.textContent = current ? view.error || message || (view.phase === 'loading' ? '正在读取列表…' : view.saving ? '正在保存；关闭窗口不会撤回已提交的保存。' : '') : '设置已重新读取，请关闭后重开；当前选择尚未提交。';
    notice.className = view.error || !current ? 'field-error' : 'muted';
    count.textContent = `已选 ${view.selected.length} 项`;
    allowAll.setAttribute('aria-checked',String(view.allowAll));allowAll.disabled=!current;
    impact.textContent = view.allowAll?`保存后将允许所有${kind==='groups'?'群聊':'私聊'}；已选号码保留，关闭后恢复。`:view.policyChanged?`保存后${view.selected.length?'仅响应已选择的':'不响应任何'}${kind==='groups'?'群聊':'私聊'}。`:view.selected.length ? '本次列表未返回的已保存号码会保留，除非你明确取消勾选。' : getEmptyPolicy() === true ? '清空后将允许所有会话。' : '清空后将不响应任何会话。';
    apply.textContent = view.allowAll||view.policyChanged?'保存设置':view.selected.length ? '保存选择' : '清空并保存'; apply.disabled = !view.canSubmit || !current;
    apply.classList.toggle('danger',!view.allowAll&&!view.policyChanged&&!view.selected.length);
    retry.disabled = view.saving || view.phase === 'loading' || !current;
    cancel.textContent = '完成';
  }
  function draw() {
    if (closed) return;
    host.replaceChildren(); const view = state.view(), chosen = new Set(view.selected), query = search.value.trim().toLowerCase();
    renderQQChoiceRows({doc,host,view,query,disabled:!isCurrent(),onChange:(id,checked)=>{state.choose(id,checked);status();autoSave.schedule();}});
    status();
  }
  async function read() {
    const ticket = state.beginRead(); if (ticket === null) return; draw();
    try { const payload = await load(); if (!isCurrent() || closed) { status(); return; } state.acceptRead(ticket, payload, kind); }
    catch (error) { state.rejectRead(ticket, error); }
    if (!closed) draw();
  }
  async function saveSelection(){
    if (!isCurrent()) throw Error('设置已刷新，请重新打开选择器');
    const sent = state.beginCommit(); if (!sent) return false;
    if (sent.noop) return;
    status();
    try {
      await commit(sent.selected,{allowAll:sent.allowAll,changed:sent.policyChanged});
      const accepted = state.acceptCommit(sent);
      if (closed) return;
      onSaved();status();
    } catch (error) { state.rejectCommit(sent, error); onError(error); if (!closed) status();throw error; }
  }
  apply.addEventListener('click',()=>{const view=state.view();if(view.allowAll||view.policyChanged||view.selected.length)void saveSelection();});
  clearAction=bindDestructiveAction(apply,{action:saveSelection,clicks:3,target:()=>host,canActivate:()=>{const view=state.view();return !closed&&isCurrent()&&view.canSubmit&&!view.allowAll&&!view.policyChanged&&!view.selected.length;},impact:()=>getEmptyPolicy()===true?'清空白名单并保存；此后允许响应所有会话。':'清空白名单并保存；此后不响应任何会话。'});
  allowAll.addEventListener('click',()=>{state.chooseAll(!state.view().allowAll);draw();autoSave.schedule();});
  search.addEventListener('input', draw); retry.addEventListener('click', () => { void read(); }); cancel.addEventListener('click', () => lifecycle.close());
  window.addEventListener('pagehide', dispose, { once: true }); doc.body.append(root); root.showModal(); void read();
  return { root, dispose: () => lifecycle.close() };
}

export function renderQQChoiceRows({doc,host,view,query='',disabled=false,onChange}){
  host.replaceChildren();const chosen=new Set(view.selected),search=query.trim().toLowerCase();
  for(const item of view.candidates){if(search&&!`${item.id} ${item.name}`.toLowerCase().includes(search))continue;
    const label=doc.createElement('label');label.className='tool-toggle';label.dataset.choiceId=item.id;
    const checkbox=doc.createElement('input');checkbox.type='checkbox';checkbox.checked=chosen.has(item.id);checkbox.disabled=disabled||view.allowAll||view.phase!=='ready';
    const name=doc.createElement('span');name.textContent=`${item.name} (${item.id})${item.savedOnly?' · 已保存，本次 QQ 列表未返回':''}`;
    const indicator=doc.createElement('span');indicator.className='settings-toggle-indicator qq-choice-indicator';indicator.setAttribute('aria-hidden','true');
    checkbox.addEventListener('change',()=>onChange(item.id,checkbox.checked));label.append(checkbox,name,indicator);host.append(label);
  }
}
