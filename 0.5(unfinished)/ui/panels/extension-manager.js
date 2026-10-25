import { request } from './panel-client.js';
import { $, clear, row, button, destructiveButton, confirmAction, managePermissions } from './ui.js';
import { installDisposableDialog } from './dialog-lifecycle.js';
import {createExtensionUpdateControls} from './extension-updates.js';

const secretKey = (key, rule) => /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i.test(key) || rule.secret || rule.sensitive || rule.format === 'password';
const capabilityLoads = new WeakMap();
const providerClearButtons = new WeakMap();
const uninstallButtons = new WeakMap();
const cleanupButtons = new WeakMap();
const providerViews = new WeakMap();

// Loader diagnostics can include a short stack or credentials from an extension.
// Keep the reason useful in the management UI without rendering either verbatim.
function diagnosticText(value) {
  let message = String(value ?? '').split(/\r?\n|\s+\|\s+at\s+/)[0].trim();
  message = message.replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Basic|Bearer)\s+[^\s,;"']+/gi, 'Authorization: [已隐藏]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/(\b(?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|community[_-]?key|token|password|secret|cookie|authorization|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, '[已隐藏私钥]');
  return message.length > 280 ? `${message.slice(0, 280)}…` : message;
}

export function summarizeExtensions(items) {
  return {
    total: items.length,
    loaded: items.filter(item => item.loaded).length,
    errors: items.filter(item => item.reason || item.lastError || ['error', 'unmet'].includes(item.code)).length,
  };
}

function extensionDiagnostics(extension) {
  const diagnostics = [];
  if (extension.reason) {
    const label = extension.loaded ? '加载说明' : extension.code === 'unmet' ? '依赖未就绪' : '加载失败';
    diagnostics.push({ error: true, text: `${label}：${diagnosticText(extension.reason)}` });
  } else if (extension.code === 'error') {
    diagnostics.push({ error: true, text: '加载失败：未提供具体原因；请检查安装文件和宿主授权后重扫。' });
  } else if (extension.code === 'unmet') {
    diagnostics.push({ error: true, text: extension.requires?.length ? `依赖未就绪：检查所需能力 ${extension.requires.join('、')}。` : '依赖未就绪：请检查能力提供者是否已启用。' });
  } else if (!extension.loaded) {
    diagnostics.push({ error: false, text: extension.code === 'loading' ? '正在加载扩展。' : extension.enabled ? '扩展尚未加载；可重扫磁盘，并检查宿主授权。' : '扩展已停用；启用后才会加载工具和界面。' });
  } else if (!extension.available) {
    diagnostics.push({ error: true, text: '当前扩展不可用；请检查所需能力和宿主授权。' });
  }
  if (extension.lastError) {
    const at = new Date(extension.lastErrorAt);
    const time = extension.lastErrorAt && Number.isFinite(at.getTime()) ? ` · ${at.toLocaleString('zh-CN', { hour12: false })}` : '';
    diagnostics.push({ error: true, text: `最近运行错误${time}：${diagnosticText(extension.lastError)}` });
  }
  return diagnostics;
}

export async function renderCapabilityProviders(extensions = [],{isCurrent=()=>true}={}) {
  const container = $('#capability-providers');
  if (!container) return;
  const version = (capabilityLoads.get(container) || 0) + 1; capabilityLoads.set(container, version);
  const data = await request('GET', '/api/skills/capabilities');
  if (!container.isConnected || capabilityLoads.get(container) !== version||!isCurrent()) return;
  // Preserve what is on screen when this response commits: a user may change
  // the selection or collapse this group while the metadata request is pending.
  const wasOpen = container.querySelector('details')?.open === true;
  const drafts = new Map([...container.querySelectorAll('[data-capability]')].filter((item) => item.querySelector('select')).map((item) => [item.dataset.capability, { pinned: item.dataset.pinned, value: item.querySelector('select').value }]));
  const capabilities = [...(data.capabilities || [])].sort((a, b) => a.name.localeCompare(b.name));
  const clears = providerClearButtons.get(container) || new Map(); providerClearButtons.set(container, clears);
  const clearable = new Set(capabilities.filter(item => item.multi && (item.pinnedOwnerId ?? item.ownerId ?? item.selection ?? '')).map(item => item.name));
  for (const [name, entry] of clears) {
    entry.present = clearable.has(name);
    if (!entry.present && !entry.busy) clears.delete(name);
  }
  let view=providerViews.get(container);
  if(!view){const details=document.createElement('details'),summary=document.createElement('summary'),help=document.createElement('p'),list=document.createElement('div');details.className='capability-provider-picker';details.open=wasOpen;help.className='muted';help.textContent='同一功能有多个扩展时，可以指定由谁处理；自动选择会优先使用已启用的扩展。标为协作的功能会按顺序交给多个扩展处理。';list.className='capability-provider-list';details.append(summary,help,list);container.append(details);view={details,summary,list,rows:new Map()};providerViews.set(container,view);}
  const {details,summary,list}=view;details.hidden=!capabilities.length;putText(summary,`能力提供者 · ${capabilities.length} 项`);
  const names = new Map(extensions.map((item) => [item.id, item.name || item.id]));
  const next=[],live=new Set(capabilities.map(item=>item.name)),focused=document.activeElement,focusedRow=focused?.closest?.('[data-capability]')?.dataset.capability;
  for(const [name,entry]of view.rows)if(!live.has(name)){entry.item.remove();view.rows.delete(name);}
  for (const capability of capabilities) {
    const signature=JSON.stringify([capability,[...names].sort(([a],[b])=>a.localeCompare(b))]),previous=view.rows.get(capability.name);
    if(previous?.signature===signature){next.push(previous.item);const clear=clears.get(capability.name);if(clear)clear.extensions=extensions;continue;}
    const providers = capability.providers || [];
    const owner = (provider) => provider.ownerId ?? provider.skillId;
    const pinned = capability.pinnedOwnerId ?? capability.ownerId ?? capability.selection ?? '';
    const selected = providers.find((provider) => provider.selected) || providers.find((provider) => owner(provider) === capability.selectedOwnerId) || providers.find((provider) => provider.usable);
    const item = document.createElement('div'); item.className = 'capability-provider-row'; item.dataset.capability = capability.name; item.dataset.pinned = pinned;
    const info = document.createElement('div'); info.className = 'capability-provider-info';
    const name = document.createElement('code'); name.textContent = capability.name;
    const current = document.createElement('small'); current.className = 'muted';
    current.textContent = selected ? `${selected.managed && !selected.running ? '已选' : '当前'}：${names.get(owner(selected)) || owner(selected)}${selected.default ? ' · 默认' : ''}${pinned ? ' · 已指定' : ' · 自动'}` : '当前没有可用提供者';
    info.append(name, current);
    if (capability.multi) {
      current.textContent = '多提供者 · 按声明顺序协作';
      const chain = document.createElement('small'); chain.className = 'capability-provider-chain';
      const active = providers.filter((provider) => provider.selectable ?? provider.usable);
      chain.textContent = active.length ? `协作链：${active.map((provider) => `${names.get(owner(provider)) || owner(provider)}${provider.default ? '（默认）' : ''}`).join(' → ')}` : '当前没有可用协作提供者';
      item.append(info, chain);
      if (pinned) {
        const warning = document.createElement('small'); warning.className = 'muted'; warning.textContent = '旧指定不影响协作顺序'; item.append(warning);
        let entry = clears.get(capability.name);
        if (!entry) {
          entry = { name: capability.name, pinned, target: item, extensions, present: true, busy: false };
          entry.button = destructiveButton('清除旧指定', async () => {
            entry.busy = true;
            try {
              await request('PUT', '/api/skills/capabilities/provider', { name: entry.name, ownerId: '' });
              await renderCapabilityProviders(entry.extensions);
            } finally { entry.busy = false; if (!entry.present && clears.get(entry.name) === entry) clears.delete(entry.name); }
          }, { clicks: 2, target: () => entry.target, key: () => JSON.stringify([entry.name, entry.pinned]), canActivate: () => entry.present, impact: '清除旧的能力提供者指定；多提供者的协作顺序保持不变。' });
          clears.set(capability.name, entry);
        }
        Object.assign(entry, { pinned, target: item, extensions, present: true });
        item.append(entry.button);
      }
      view.rows.set(capability.name,{signature,item});next.push(item);continue;
    }
    if (selected?.managed) {
      const status = document.createElement('small'); status.className = selected.running ? 'muted capability-provider-status' : 'error capability-provider-status';
      status.textContent = selected.running ? '服务运行中' : `服务未就绪：${selected.error || capability.reason || '尚未启动'}`; info.append(status);
    }
    const select = document.createElement('select'); select.setAttribute('aria-label', `${capability.name} 提供者`);
    const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = '自动选择'; select.append(automatic);
    for (const provider of providers) {
      const id = owner(provider); if (!id) continue;
      const option = document.createElement('option'); option.value = id;
      const selectable = provider.selectable ?? provider.usable;
      option.textContent = `${names.get(id) || id}${provider.default ? ' · 默认' : ''}${selectable === false ? ' · 不可用' : provider.managed && !provider.running ? ' · 待启动' : ''}`;
      option.disabled = selectable === false; select.append(option);
    }
    if (pinned && !providers.some((provider) => owner(provider) === pinned)) {
      const missing = document.createElement('option'); missing.value = pinned; missing.textContent = `${pinned} · 不可用`; missing.disabled = true; select.append(missing);
    }
    select.value = pinned;
    const draft = drafts.get(capability.name);
    if (draft && draft.pinned === pinned && [...select.options].some((option) => option.value === draft.value && !option.disabled)) select.value = draft.value;
    const feedback = document.createElement('small'); feedback.className = 'error'; feedback.setAttribute('role', 'status');
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = '应用';
    apply.addEventListener('click', async () => {
      apply.disabled = true; select.disabled = true; feedback.textContent = '';
      try {
        await request('PUT', '/api/skills/capabilities/provider', { name: capability.name, ownerId: select.value });
        await renderCapabilityProviders(extensions);
      } catch (error) { feedback.textContent = error.message || '切换失败'; }
      finally { if (apply.isConnected) { select.disabled = false; apply.disabled = select.value === pinned; } }
    });
    apply.disabled = select.value === pinned; select.addEventListener('change', () => { apply.disabled = select.value === pinned; feedback.textContent = ''; });
    item.append(info, select, apply, feedback);view.rows.set(capability.name,{signature,item});next.push(item);
  }
  placeNodes(list,next);
  if(focusedRow&&!focused.isConnected)view.rows.get(focusedRow)?.item.querySelector('select')?.focus({preventScroll:true});
}

export function settingsDialog(extension, reload) {
  const dialog = document.createElement('dialog');
  dialog.className = 'extension-settings';
  const title = document.createElement('h3'); title.textContent = `${extension.name || extension.id} · 设置`;
  const form = document.createElement('form');
  const dirty = new Map();
  const feedback = document.createElement('p'); feedback.className = 'error';
  for (const [key, rule] of Object.entries(extension.configSchema || {})) {
    const label = document.createElement('label'); label.className = 'setting-field';
    const heading = document.createElement('span'); heading.textContent = rule.title || rule.label || key;
    const secret = secretKey(key, rule);
    let input;
    const value = extension.settings?.[key] ?? rule.default;
    if (!secret && Array.isArray(rule.enum)) {
      input = document.createElement('select');
      rule.enum.forEach((option, index) => { const node = document.createElement('option'); node.value = String(index); node.textContent = typeof option === 'string' ? option : JSON.stringify(option); node.selected = JSON.stringify(value) === JSON.stringify(option); input.append(node); });
    } else if (!secret && (rule.type === 'object' || rule.type === 'array')) {
      input = document.createElement('textarea'); input.value = value == null ? '' : JSON.stringify(value, null, 2);
    } else {
      input = document.createElement('input');
      input.type = secret ? 'password' : rule.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(rule.type) ? 'number' : 'text';
      if (input.type === 'checkbox') input.checked = value === true;
      else if (!secret) input.value = value == null ? '' : String(value);
      else { input.placeholder = value ? '已保存；留空保留原值' : '尚未设置'; input.autocomplete = 'new-password'; }
      if (input.type === 'number') { input.step = rule.type === 'integer' ? '1' : 'any'; if (rule.minimum != null) input.min = rule.minimum; if (rule.maximum != null) input.max = rule.maximum; }
    }
    input.name = key;
    input.addEventListener('input', () => dirty.set(key, { input, rule, secret }));
    input.addEventListener('change', () => dirty.set(key, { input, rule, secret }));
    label.append(heading, input);
    if(input.type==='checkbox')label.classList.add('extension-setting-toggle');
    if (secret) label.append(destructiveButton(`清除 ${rule.title || rule.label || key}`, () => {
      input.value = ''; input.placeholder = '保存后清除此密钥'; dirty.set(key, { input, rule, secret, cleared: true });
    }, { clicks: 3, target: () => label, key: () => JSON.stringify([extension.id, key, input.value]), impact: '将此密钥标记为清除；点击“保存修改”后生效。' }));
    if (rule.description) { const help = document.createElement('small'); help.textContent = rule.description; label.append(help); }
    form.append(label);
  }
  const save = document.createElement('button'); save.type = 'button'; save.className='primary';save.textContent = '保存修改';
  const actions=document.createElement('div');actions.className='actions';actions.append(save,button('取消',()=>dialog.close()));form.append(feedback,actions);
  const commit = async (event) => {
    event.preventDefault(); if (!form.reportValidity()) return; feedback.textContent = ''; save.disabled = true;
    try {
      const settings = {}, clearSecrets = [];
      for (const [key, { input, rule, secret, cleared }] of dirty) {
        if (secret && !input.value && !cleared) continue;
        if (secret && cleared && !input.value) clearSecrets.push(key);
        let value = input.value;
        if (!secret && Array.isArray(rule.enum)) value = rule.enum[Number(input.value)];
        else if (rule.type === 'boolean') value = secret ? input.value === 'true' : input.checked;
        else if (['number', 'integer'].includes(rule.type)) { if (!input.value.trim()) throw new Error(`${key} 不能为空`); value = Number(input.value); if (!Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) throw new Error(`${key} 必须为${rule.type === 'integer' ? '整数' : '数字'}`); }
        else if (['object', 'array'].includes(rule.type)) value = JSON.parse(input.value);
        settings[key] = value;
      }
      if (Object.keys(settings).length) await request('POST', `/api/skills/${encodeURIComponent(extension.id)}`, { settings, clearSecrets });
      dialog.close(); await reload();
    } catch (e) { feedback.textContent = e.message || '保存失败'; }
    finally { save.disabled = false; }
  };
  save.addEventListener('click', commit); form.addEventListener('submit', commit);
  dialog.append(title, form); installDisposableDialog(dialog); document.body.append(dialog); dialog.showModal();
}

export async function pickZip() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip'; input.hidden = true; document.body.append(input);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (file, error) => {
      if (done) return; done = true;
      input.removeEventListener('change', selected); input.removeEventListener('cancel', cancelled);
      window.removeEventListener('pagehide', cancelled); input.remove();
      if (error) reject(error); else resolve(file);
    };
    const selected = () => finish(input.files?.[0] ?? null);
    const cancelled = () => finish(null);
    // Owner focus can return while the native chooser is still open. Only its
    // selection/cancel event, or panel teardown, settles this request.
    input.addEventListener('change', selected, { once: true });
    input.addEventListener('cancel', cancelled, { once: true });
    window.addEventListener('pagehide', cancelled, { once: true });
    try { input.click(); } catch (error) { finish(null, error); }
  });
}

export async function installZip(kind) {
  const file = await pickZip(); if (!file) return null;
  if (file.size > 8 * 1024 * 1024) throw new Error('安装包超过 8MB 上限');
  if (!await confirmAction(`安装 ${file.name}？\n\n安装后默认停用，不执行代码。请先检查来源、设置与权限，再显式启用。Node 插件不是沙箱。`)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return request('POST', '/api/skills/install', { zipBase64: btoa(binary), kind });
}

// Keep the last installation outcome outside the independently refreshed list.
export function bindZipInstaller(kind, reload) {
  const install = $('#install'), feedback = $('#install-status');
  let busy = false;
  const show = (message = '', failed = false) => {
    feedback.textContent = message; feedback.className = failed ? 'error' : 'muted'; feedback.hidden = !message;
  };
  const run = async () => {
    if (busy) return;
    busy = true; install.disabled = true; show();
    try {
      const result = await installZip(kind);
      if (result === null) return;
      if (result?.ok !== true || !result.installed) throw new Error('未收到明确的安装结果，请重扫磁盘核对。');
      const success = `已安装「${result.skill?.name || result.installed}」，默认停用，未执行代码。请检查设置与权限后显式启用。`;
      show(success);
      try {
        const refreshed = await reload();
        if (refreshed === false) show(`${success} 列表刷新失败，请重扫磁盘核对。`);
      } catch (error) { show(`${success} 列表刷新失败：${diagnosticText(error.message || '请重扫磁盘核对。')}`); }
    } catch (error) {
      const reason = diagnosticText(error.message || '请检查安装包后重试。').replace(/^(?:安装失败\s*[：:]\s*)+/, '');
      show(`安装失败：${reason || '请检查安装包后重试。'}`, true);
    }
    finally { busy = false; install.disabled = false; }
  };
  install.addEventListener('click', run);
  return () => install.removeEventListener('click', run);
}

// Keep catalogue identity and first-seen order across loader unload/reload events.
const catalogues = new WeakMap();
const putText = (node,value) => {const next=String(value??'');if(node.textContent!==next)node.textContent=next;};
function placeNodes(parent,nodes){
  const wanted=new Set(nodes);for(const node of [...parent.children])if(!wanted.has(node))node.remove();
  nodes.forEach((node,index)=>{if(parent.children[index]!==node)parent.insertBefore(node,parent.children[index]||null);});
}
export function renderExtensions(items,kind,reload,updates=[]){
  const list=$('#list');let view=catalogues.get(list);
  if(!view){
    const defaults=document.createElement('details'),summary=document.createElement('summary'),grid=document.createElement('div'),empty=document.createElement('div');
    defaults.className='default-capabilities';summary.textContent='默认能力';grid.className='default-capability-grid';empty.className='empty';defaults.append(summary,grid);
    view={entries:new Map(),defaults,summary,grid,empty};catalogues.set(list,view);
  }
  const anchor=[...list.querySelectorAll('.list-item')].find(node=>node.getBoundingClientRect().bottom>0&&node.getClientRects().length),anchorTop=anchor?.getBoundingClientRect().top;
  const uninstalls=uninstallButtons.get(list)||new Map();uninstallButtons.set(list,uninstalls);
  const live=new Set(items.filter(item=>item.kind===kind).map(item=>item.id));
  const installedIds=new Set(items.filter(item=>item.kind===kind&&item.root!=='bundled').map(item=>item.id));
  for(const [id,entry]of view.entries)if(!live.has(id)){entry.card.remove();view.entries.delete(id);}
  for(const [id,entry]of uninstalls){entry.present=installedIds.has(id);if(!entry.present&&!entry.busy)uninstalls.delete(id);}
  for(const extension of items.filter(item=>item.kind===kind)){
    let entry=view.entries.get(extension.id);
    if(!entry){
      entry={extension,reload};
      const toggle=button('',async()=>{
        const current=entry.extension;
        if(!current.enabled&&current.root!=='bundled'&&!await confirmAction(`启用「${current.name||current.id}」？\n\n启用后，它会立即在你的电脑上运行，并可能读取文件、连接网络。这里的权限开关不能限制它的全部行为。请确认扩展来源可靠，再继续启用。`))return;
        await request('POST',`/api/skills/${encodeURIComponent(current.id)}`,{enabled:!current.enabled});await entry.reload();
      });
      const settings=button('设置',()=>settingsDialog(entry.extension,entry.reload));
      const hot=button('重新加载',async()=>{
        const result=await request('POST',`/api/skills/${encodeURIComponent(entry.extension.id)}/hot-reload`,{});await entry.reload();
        if(!result.ok)throw new Error(result.error||'重新加载失败，请查看扩展状态');
        if(result.needsReauthorize&&await confirmAction('扩展已更新，需要重新确认新版的权限。现在查看？'))await managePermissions(result.skill);
      });
      hot.classList.add('extension-hot-action');
      const permissions=button('宿主授权',()=>managePermissions(entry.extension));
      const card=row('','',[toggle,settings,hot,permissions]),description=document.createElement('p'),identity=document.createElement('small'),diagnostics=document.createElement('div'),dependencies=document.createElement('small'),location=document.createElement('details'),locationTitle=document.createElement('summary'),path=document.createElement('code');
      card.dataset.extensionId=extension.id;card.dataset.motionKey=`extension:${extension.root}:${extension.id}`;
      description.className='extension-description';identity.className='extension-id';diagnostics.className='extension-diagnostics';dependencies.className='extension-dependencies';location.dataset.extensionPath=extension.id;locationTitle.textContent='根目录';path.className='extension-root-path';location.append(locationTitle,path);card.append(description,identity,diagnostics,dependencies,location);
      Object.assign(entry,{card,title:card.querySelector('strong'),summary:card.querySelector('.muted'),actions:card.querySelector('.actions'),toggle,settings,hot,permissions,description,identity,diagnostics,dependencies,path});
      entry.updateControls=createExtensionUpdateControls(entry);entry.actions.append(entry.updateControls.check,entry.updateControls.update);card.append(entry.updateControls.note);view.entries.set(extension.id,entry);
    }
    Object.assign(entry,{extension,reload});
    entry.updateControls.render(updates.find(row=>row.id===extension.id));
    if(extension.root!=='bundled'){
      let uninstall=uninstalls.get(extension.id);
      if(!uninstall){
        uninstall={extension,reload,present:true,busy:false};
        uninstall.button=destructiveButton('卸载',async()=>{
          const current=uninstall.extension,endpoint=`/api/skills/${encodeURIComponent(current.id)}`;uninstall.busy=true;
          try{if(current.enabled)await request('POST',endpoint,{enabled:false});await request('POST',`${endpoint}/delete`,{});await uninstall.reload();}
          finally{uninstall.busy=false;if(!uninstall.present&&uninstalls.get(current.id)===uninstall)uninstalls.delete(current.id);}
        },{clicks:4,target:()=>uninstall.target,key:()=>JSON.stringify([uninstall.extension?.id,uninstall.extension?.fingerprint,uninstall.extension?.dir]),canActivate:()=>uninstall.present,impact:()=>`${uninstall.extension?.enabled?'将先停用，再卸载。':''}代码移入可恢复隔离区，设置与宿主授权清除；插件存储数据保留。`});uninstalls.set(extension.id,uninstall);
      }
      Object.assign(uninstall,{extension,reload,present:true,target:entry.card});entry.uninstall=uninstall;if(uninstall.button.parentElement!==entry.actions)entry.actions.append(uninstall.button);
    }else{entry.uninstall?.button.remove();entry.uninstall=null;}
    const source=extension.root==='bundled'?'默认提供':['skills','plugins'].includes(extension.root)?'用户安装':'来源未提供';
    putText(entry.title,extension.name||extension.id);putText(entry.summary,`加载：${extension.loaded?'已加载':'未加载'} · 开关：${extension.enabled?'启用':'停用'} · 可用：${extension.available?'是':'否'} · ${source} · ${extension.version||'未知版本'}`);
    putText(entry.toggle,extension.enabled?'停用':'启用');entry.settings.hidden=!Object.keys(extension.configSchema||{}).length;entry.hot.hidden=!extension.enabled||extension.code==='disabled';entry.permissions.hidden=extension.root==='bundled'||!extension.fingerprint;
    putText(entry.description,extension.description||'');entry.description.hidden=!extension.description;putText(entry.identity,extension.id);putText(entry.dependencies,extension.requires?.length?`所需能力：${extension.requires.join('、')}`:'');entry.dependencies.hidden=!extension.requires?.length;putText(entry.path,extension.dir||'暂未提供安装路径；可重扫磁盘更新。');
    for(const control of [entry.toggle,entry.settings,entry.hot,entry.permissions,entry.uninstall?.button])if(control)control.disabled=entry.updateState?.status==='updating';
    const diagnostics=extensionDiagnostics(extension);for(let i=entry.diagnostics.children.length-1;i>=diagnostics.length;i--)entry.diagnostics.children[i].remove();
    diagnostics.forEach((diagnostic,index)=>{let note=entry.diagnostics.children[index];if(!note){note=document.createElement('p');entry.diagnostics.append(note);}const className=diagnostic.error?'error':'muted';if(note.className!==className)note.className=className;putText(note,diagnostic.text);});
  }
  const query=$('#search').value.trim().toLowerCase(),shown=[...view.entries.values()].filter(({extension:item})=>`${item.id} ${item.name||''} ${item.description||''}`.toLowerCase().includes(query));
  const check=document.querySelector('#check-updates');if(check)check.disabled=!items.some(item=>item.root!=='bundled'&&item.update);
  const defaults=shown.filter(entry=>entry.extension.root==='bundled').map(entry=>entry.card),installed=shown.filter(entry=>entry.extension.root!=='bundled').map(entry=>entry.card);
  putText(view.summary,`默认能力 · ${defaults.length} 项`);placeNodes(view.grid,defaults);
  putText(view.empty,`没有匹配的${kind==='skill'?'技能':'插件'}；可以安装 ZIP，或重扫磁盘。`);placeNodes(list,[...(defaults.length?[view.defaults]:[]),...installed,...(!shown.length?[view.empty]:[])]);
  if(anchor?.isConnected&&anchor.getClientRects().length){const delta=anchor.getBoundingClientRect().top-anchorTop;if(Math.abs(delta)>1)window.scrollBy(0,delta);}
}

export function renderCleanup(ids,reload){
  const host = document.querySelector('header .actions');
  if (!host) return;
  let entry = cleanupButtons.get(host);
  if (entry?.busy) { entry.next = { ids: [...(ids || [])], reload };if(entry.button.parentElement!==host)host.append(entry.button);return; }
  if (!ids?.length) { entry?.button.remove();cleanupButtons.delete(host); return; }
  const signature = JSON.stringify([...ids].sort());
  if (!entry || entry.signature !== signature) {
    entry?.button.remove();
    entry = { signature, ids: [...ids], reload, busy: false, next: null };
    entry.button = destructiveButton(`清理残留设置（${ids.length}）`, async () => {
      entry.busy = true;
      try { await request('POST', '/api/skills/cleanup', { ids: entry.ids }); await entry.reload(); }
      finally { entry.busy = false; if (entry.next) { const next = entry.next; entry.next = null; renderCleanup(next.ids, next.reload); } }
    }, { clicks: 3, target: () => $('#list'), key: () => entry.signature, impact: () => `清除未安装扩展的残留设置：${entry.ids.join('、')}。` });
    entry.button.id = 'cleanup'; cleanupButtons.set(host, entry);
  }
  entry.reload = reload;if(entry.button.parentElement!==host)host.append(entry.button);
}
