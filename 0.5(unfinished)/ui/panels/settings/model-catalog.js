import {button, destructiveButton, formDialog, row, text} from '../ui.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {modelId, modelLabel} from './model-catalog-data.js';
import {openModelImport} from './model-import.js';

export function addProviderModel({provider,request,beforeWrite,changed}){
  const dialog=formDialog('手动添加模型',[
    {key:'id',label:'模型 ID',required:true},
    {key:'name',label:'显示名称（可选）'},
  ],async fields=>{
    const id=fields.id.trim();if(!id)throw new Error('模型 ID 不能为空');
    await beforeWrite();if(!dialog.isConnected||!dialog.open)throw new Error('添加模型已取消');
    await request('POST','/api/providers/models',{providerId:provider.id,expectedBaseUrl:provider.baseURL||provider.baseUrl,onlyMissing:true,models:[{id,name:fields.name.trim()||id}]});
    await changed();
  },{submitLabel:'添加模型'});return dialog;
}

// Ordinary settings UI: no token/storage access or new host privileges. The
// whole module can be replaced through the existing UI file composition layer.
export function openModelCatalog({provider, request, beforeWrite, changed}) {
  const dialog = document.createElement('dialog'); dialog.className = 'model-manager';
  const heading = text(document.createElement('h3'), `模型管理 · ${provider.displayName || provider.id}`);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = '筛选模型 ID 或显示名称'; search.setAttribute('aria-label', '筛选模型');
  const list = document.createElement('div'); list.className = 'model-manager-list';
  const state = text(document.createElement('p'), '目录变更不修改已配置的主模型或专用模型。'); state.className = 'muted';
  let current = provider, busy = false, version = 0;
  const life = installDisposableDialog(dialog, {onClosed: () => { ++version; }});
  async function mutate(run) {
    if (busy || life.closed) throw new Error(life.closed ? '模型管理已关闭' : '请等待当前目录操作完成');
    busy = true;
    try {
      await beforeWrite();
      if (life.closed) throw new Error('模型管理已关闭，目录操作已取消');
      await run(); await changed();
      if (life.closed) return;
      const ticket = ++version, data = await request('GET', '/api/providers');
      if (life.closed || ticket !== version) return;
      current = data.providers.find(item => item.id === provider.id);
      if (!current) { dialog.close(); return; }
      render();
    } finally { busy = false; }
  }
  function edit(value) {
    const id = value ? modelId(value) : '';
    formDialog(id ? '模型显示名称' : '手动添加模型', [
      {key: 'id', label: '模型 ID', value: id, required: true, readOnly: !!id},
      {key: 'name', label: '显示名称（可选）', value: value ? modelLabel(current, value) : ''},
    ], async fields => {
      const next = fields.id.trim(); if (!next) throw new Error('模型 ID 不能为空');
      if (busy) throw new Error('请等待当前目录操作完成');
      await mutate(() => request('POST', '/api/providers/models', {providerId: current.id,
        expectedBaseUrl: current.baseURL || current.baseUrl,
        models: [{id: next, name: fields.name.trim() || next}], modelNames: {[next]: fields.name.trim() || next}}));
    });
  }
  function render() {
    const query = search.value.trim().toLocaleLowerCase(); list.replaceChildren();
    for (const value of current.models || []) {
      const id = modelId(value), label = modelLabel(current, value);
      if (!`${id} ${label}`.toLocaleLowerCase().includes(query)) continue;
      const item = row(label, id); item.dataset.modelId = id; item.dataset.motionKey = `${current.id}:${id}`;
      const actions = document.createElement('div'); actions.className = 'actions';
      actions.append(button('修改显示名称', () => edit(value)), destructiveButton('移出目录', () => mutate(() => request('DELETE', '/api/providers/models', {providerId: current.id, modelId: id, expectedBaseUrl: current.baseURL || current.baseUrl})), {
        target: () => item, clicks: 2, key: () => `${current.id}:${id}`,
        impact: `将从本渠道目录移除 ${label}；已配置的模型调用保持。`,
      })); item.append(actions); list.append(item);
    }
    if (!list.childElementCount) list.append(text(document.createElement('p'), query ? '没有匹配的模型' : '目录为空，可以手动添加模型。'));
  }
  search.addEventListener('input', render);
  const actions = document.createElement('div'); actions.className = 'actions';
  actions.append(button('手动添加模型', () => edit()), button('拉取模型列表', () => {
    const snapshot = current;
    openModelImport({provider: snapshot,
      load: async () => (await request('POST', '/api/providers/fetch-models', {providerId: snapshot.id, expectedBaseUrl: snapshot.baseURL || snapshot.baseUrl})).models,
      onApply: models => mutate(() => request('POST', '/api/providers/models', {providerId: snapshot.id, expectedBaseUrl: snapshot.baseURL || snapshot.baseUrl, onlyMissing: true, models})),
    });
  }), button('刷新目录', async () => {
    if (busy || life.closed) return;
    const ticket = ++version, data = await request('GET', '/api/providers');
    if (life.closed || ticket !== version) return;
    current = data.providers.find(p => p.id === provider.id);
    if (!current) { dialog.close(); return; } render();
  }), button('关闭', () => dialog.close()));
  dialog.append(heading, search, state, actions, list); document.body.append(dialog); render(); dialog.showModal(); return dialog;
}
