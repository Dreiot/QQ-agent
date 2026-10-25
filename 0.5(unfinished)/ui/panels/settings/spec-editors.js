import { button, destructiveButton, text, confirmAction } from '../ui.js';
import { installDisposableDialog } from '../dialog-lifecycle.js';
import { openModelPicker } from './model-picker.js';
import { groupCandidates, normalizeQQList } from './list-choice.js';
import {bindAutoSave,flushAutoSaves} from './auto-save.js';
import {createIcon} from '../icons.js';
export { editModelPrices } from './model-prices.js';

function dialog(title) {
  const root = document.createElement('dialog'), body = document.createElement('article'), heading = document.createElement('h3');
  text(heading, title); root.className = 'settings-spec-dialog'; body.append(heading); root.append(body);
  installDisposableDialog(root,{beforeClose:()=>flushAutoSaves(root)}); document.body.append(root); root.showModal();
  return { root, body };
}
function input(parent, label, value = '', type = 'text') {
  const wrap = document.createElement('label'), title = document.createElement('span'), field = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
  wrap.className = 'setting-field'; text(title, label);
  if (!['textarea', 'select'].includes(type)) field.type = type;
  if (type === 'checkbox') field.checked = Boolean(value); else field.value = String(value ?? '');
  wrap.append(title, field); parent.append(wrap); return field;
}
function options(select, values, value) {
  for (const [id, name] of values) { const option = document.createElement('option'); option.value = id; text(option, name); select.append(option); }
  select.value = value ?? '';
}
function numeric(field, label, min, max) {
  const n = Number(field.value);
  if (!field.value.trim() || !Number.isFinite(n) || n < min || n > max) throw new Error(`${label}需要在 ${min}~${max} 之间`);
  return n;
}
function end(root, body, commit,automatic=false) { const actions = document.createElement('div'); actions.className = 'actions';const submit=button('保存', async () => { await commit(); root.close(); }, 'primary');submit.hidden=automatic;actions.append(submit, button(automatic?'完成':'取消', () => root.close())); body.append(actions);if(automatic)return bindAutoSave(root,commit); }

export async function editGroupResponse({ request, form, queue, save, render, isCurrent = () => true, onError = () => {} }) {
  const { root, body } = dialog('分群响应档位');
  const hint = document.createElement('p'); text(hint, '留空跟随全局；分群档位在“所有群统一档位”关闭后生效，峰谷值在峰谷切档开启后生效。'); body.append(hint);
  const sliders = form.value('store.groupSliderPos') ?? {}, peaks = form.value('store.groupPeakPos') ?? {};
  const names = document.createElement('p'), host = document.createElement('div'), feedback = document.createElement('p'); names.className = 'muted'; text(names, '正在补充 QQ 群名；现在就可以编辑白名单和已保存的群。'); feedback.className = 'field-error'; feedback.setAttribute('role', 'status'); body.append(names, host, feedback);
  const fields = new Map(), staged = new Set(); let revision = 0, saving = false;
  function addGroup(item) {
    const {id,name} = item, existing = fields.get(id);
    const title = `${name || id} (${id}) · ${item.allowed ? '白名单' : '当前不在白名单，档位设置不会授予准入'}${item.stored ? ' · 已保存设置' : ''}`;
    if (existing) { text(existing.legend, title); return; }
    const section = document.createElement('fieldset'), legend = document.createElement('legend'); text(legend, title); section.dataset.groupId = id; section.append(legend); host.append(section);
    const normal = input(section, '平时滑条 0~100（空白跟随）', sliders[id] ?? '', 'number');
    const peak = input(section, '高峰滑条 0~100（空白跟随）', peaks[id]?.peak ?? peaks[id]?.peakPos ?? '', 'number');
    const valley = input(section, '低谷滑条 0~100（空白跟随）', peaks[id]?.valley ?? peaks[id]?.valleyPos ?? '', 'number');
    for (const field of [normal, peak, valley]) { field.min = '0'; field.max = '100'; field.step = '0.1'; field.addEventListener('input', () => { revision++; text(feedback, ''); }); }
    fields.set(id, { id, legend, normal, peak, valley, initial: { normal: normal.value, peak: peak.value, valley: valley.value } });
  }
  const context = {allow:form.value('allow.groups'),sliders,peaks};
  for (const item of groupCandidates(context)) addGroup(item);
  const actions = document.createElement('div'); actions.className = 'actions';
  const submit = button('保存', async () => {
    if (saving) return;
    if (!isCurrent()) { text(feedback, '设置已重新读取，请关闭后重开；当前草稿尚未提交。'); return; }
    const next = structuredClone(form.value('store.groupSliderPos') ?? {}), dual = structuredClone(form.value('store.groupPeakPos') ?? {}), submitted = [];
    let normalChanged = false, peaksChanged = false;
    for (const row of fields.values()) for (const key of ['normal','peak','valley']) {
      const field = row[key], value = field.value.trim(); if (value === row.initial[key].trim() && !staged.has(`${row.id}:${key}`)) continue;
      const number = value ? numeric(field, '档位', 0, 100) : null; submitted.push({row,key,value:field.value});
      if (key === 'normal') { normalChanged = true; if (number === null) delete next[row.id]; else next[row.id] = number; }
      else {
        peaksChanged = true; const pair = {...dual[row.id]}; delete pair[`${key}Pos`];
        if (number === null) delete pair[key]; else pair[key] = number;
        if (Object.keys(pair).length) dual[row.id] = pair; else delete dual[row.id];
      }
    }
    if (!submitted.length) { root.close(); return; }
    const sentRevision = revision; saving = true;
    try {
      for (const {row,key} of submitted) staged.add(`${row.id}:${key}`);
      if (normalChanged) queue('store.groupSliderPos', next, false, true); if (peaksChanged) queue('store.groupPeakPos', dual, false, true);
      await save(); for (const {row,key,value} of submitted) { row.initial[key] = value; staged.delete(`${row.id}:${key}`); }
      if (revision === sentRevision) { root.close(); if (isCurrent()) render(); }
      else if (root.isConnected) text(feedback, '此前修改已保存；当前输入尚未保存。');
    } catch (error) { text(feedback, error.message || '保存失败，草稿已保留'); text(cancel, '关闭（未保存草稿保留）'); onError(error); }
    finally { saving = false; }
  }, 'primary');
  const cancel = button('取消', () => root.close()); actions.append(submit, cancel); body.append(actions);
  void (async () => {
    try {
      const result = normalizeQQList(await request('GET', '/api/onebot/groups'), 'groups');
      if (!root.isConnected || !isCurrent()) return;
      if (result.phase === 'ready') { for (const item of groupCandidates({...context,live:result.items})) addGroup(item); text(names, '群名已补充；当前输入保持不变。'); }
      else text(names, `${result.error} 仍可按群号编辑白名单及已保存的群。`);
    } catch (error) { if (root.isConnected) text(names, `群名读取失败：${error.message}。仍可按群号编辑。`); }
  })();
  return {root};
}

export function editFallbacks({ form, providers, queue, save, render }) {
  const { root, body } = dialog('备选模型顺序'), host = document.createElement('div'); body.append(host);
  let rows = structuredClone(form.value('api.fallbackModels') ?? []);
  const rowKeys=new WeakMap();let nextRowKey=0;
  const draw = () => {
    host.replaceChildren();
    rows.forEach((row, index) => {
      const box = document.createElement('fieldset'); host.append(box);
      if(!rowKeys.has(row))rowKeys.set(row,++nextRowKey);box.dataset.motionKey=`fallback:${rowKeys.get(row)}`;
      const provider = input(box, `${index + 1}. 渠道`, '', 'select'); options(provider, [['', '沿用主渠道'], ...providers.map((p) => [p.id, p.displayName || p.id])], row.provider);
      const model = input(box, '模型 ID', row.model); model.setAttribute('list', `fallback-models-${index}`);
      const list = document.createElement('datalist'); list.id = `fallback-models-${index}`; box.append(list);
      const refresh = () => { list.replaceChildren(); const selected = providers.find((p) => p.id === provider.value); for (const item of selected?.models ?? []) { const option = document.createElement('option'); option.value = typeof item === 'string' ? item : item.id; list.append(option); } };
      provider.addEventListener('change', () => { row.provider = provider.value; refresh(); }); model.addEventListener('input', () => row.model = model.value); refresh();
      box.append(button('从目录选择', () => openModelPicker({providers, title: '选择备选模型', current: row, onPick: choice => {
        row.provider = choice.provider; row.model = choice.model; provider.value = choice.provider; model.value = choice.model; refresh();autoSave.schedule();
      }})));
      const up = button('', () => { [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; draw();autoSave.schedule(); });up.append(createIcon('arrow-up',{size:18}));up.title='上移';up.setAttribute('aria-label','上移');up.disabled = index === 0;
      const down = button('', () => { [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]]; draw();autoSave.schedule(); });down.append(createIcon('arrow-down',{size:18}));down.title='下移';down.setAttribute('aria-label','下移');down.disabled = index === rows.length - 1;
      box.append(up, down, destructiveButton('移除', () => { rows.splice(index, 1); draw();autoSave.schedule(); }, {
        target: () => box, clicks: 2, key: () => JSON.stringify([row.provider, row.model]),
        impact: () => `将从当前草稿移除备选模型 ${row.model || `第 ${index + 1} 项`}，保存后生效。`,
      }));
    });
  };
  body.append(button('添加备选模型', () => { rows.push({ provider: '', model: '' }); draw(); })); draw();
  const autoSave=end(root, body, async () => { if (rows.some((row) => !row.model?.trim())) throw new Error('请选择备选模型'); queue('api.fallbackModels', rows.map((row) => ({ model: row.model.trim(), ...(row.provider ? { provider: row.provider } : {}) }))); await save(); },true);
}

export function importCatalog({ request, save, reload }) {
  const { root, body } = dialog('导入渠道 YAML');
  const source = input(body, 'providers 数组或按渠道 ID 的映射（密钥单独保存）', '', 'textarea'); source.rows = 12; source.placeholder = 'providers:\n  - id: example\n    baseURL: https://example.com/v1\n    models: [model-id]';
  const replace = input(body, '替换全部已有渠道（默认合并同 ID）', false, 'checkbox');
  end(root, body, async () => { if (replace.checked && !await confirmAction('替换全部渠道目录？未导入的渠道及其密钥将从配置移除。')) throw new Error('已取消替换'); await save(); await request('POST', '/api/providers/import', { source: source.value, replace: replace.checked }); source.value = ''; await reload(); });
}

export function editSearchProvider({ provider = {}, request, reload }) {
  const { root, body } = dialog(provider.id ? '编辑搜索源' : '添加搜索源');
  const name = input(body, '名称', provider.name), type = input(body, '类型', '', 'select'); options(type, [['openai', 'JSON 搜索接口'], ['bing', 'Bing HTML']], provider.type ?? 'openai');
  const url = input(body, '接口地址', provider.baseUrl), key = input(body, '新密钥（空白保留已有）', '', 'password'); key.autocomplete = 'new-password';
  const model = input(body, '模型（可空）', provider.model), count = input(body, '结果条数', provider.count ?? 6, 'number'), timeout = input(body, '超时（毫秒）', provider.timeoutMs ?? 20000, 'number');
  end(root, body, async () => { await request('POST', '/api/search-providers', { id: provider.id, name: name.value, type: type.value, baseUrl: url.value, ...(key.value.trim() ? { apiKey: key.value.trim() } : {}), model: model.value, count: numeric(count, '条数', 1, 20), timeoutMs: numeric(timeout, '超时', 5000, 300000) }); key.value = ''; await reload(); });
  if (provider.id) body.append(destructiveButton('清除搜索源密钥', async () => { await request('POST', '/api/search-providers', { ...provider, apiKey: '' }); await reload(); root.close(); }, {
    target: () => key.closest('.setting-field') || body, clicks: 3, key: () => provider.id,
    impact: `将清除搜索源 ${provider.name || provider.id} 的密钥，需要鉴权的搜索请求会失效。`,
  }));
}
