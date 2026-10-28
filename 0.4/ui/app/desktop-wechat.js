'use strict';
function renderDesktopWechatSection(c) {
  const w=c.desktopWechat||{};
  return `<div class="set-card"><h3>微信 · 原生通道</h3>
    <p class="hint">Windows 可选接入，与 QQ 共用人设、记忆、模型和聊天调度。首次连接需按文档在本机配置读取器与精确版本发送组件。</p>
    <div class="field">${switchHtml('wx-enabled',w.enabled,'启用微信')}</div>
    <div class="field"><label>群白名单（每行一个准确群名）</label><textarea id="wx-groups" rows="4">${esc((w.groups||[]).join('\n'))}</textarea></div>
    <div class="field"><label>私聊白名单（每行一个准确联系人名）</label><textarea id="wx-private" rows="3">${esc((w.privateChats||[]).join('\n'))}</textarea></div>
    <div class="field">${switchHtml('wx-all-private',w.allowAllPrivateWhenEmpty,'私聊名单为空时接待已核验好友')}</div>
    <div class="field">${switchHtml('wx-images',w.imageSendEnabled,'允许图片发送（PNG/JPEG，需原生组件已验收）')}</div>
    <p class="hint">名单按本机通讯录解析，发送按稳定 ID 定向；重名无法唯一匹配时不会任选对象。QQ 专属插件需声明微信兼容。原生引用暂未支持。</p>
    <div class="field"><button type="button" class="btn primary" id="wx-save">保存微信设置</button> <button type="button" class="btn" id="wx-refresh">刷新状态</button></div>
    <pre id="wx-status" class="hint">正在读取状态…</pre><div id="wx-pending"></div>
    </div>`;
}
function bindDesktopWechatSettings() {
  const refresh=async()=>{
    try {
      const w=await api('/api/desktop-wechat');
      const el=$('#wx-status');if(!el)return;
      el.textContent=`接入：${w.enabled?'启用':'停用'}；读取：${w.readAvailable?'就绪':'未就绪'}；发送：${w.sendAvailable?'就绪':'未就绪'}；图片：${w.sendImageAvailable?'就绪':'未就绪'}\n${w.lastError||''}\n未匹配名单：${(w.database?.unresolvedTargets||[]).map(x=>typeof x==='string'?x:JSON.stringify(x)).join('、')||'无'}`;
      const pending=$('#wx-pending');if(!pending)return;
      pending.innerHTML=(w.pending||[]).map(p=>`<p>待核对 ${esc(p.type)} · ${esc(new Date(p.at).toLocaleString())} <button type="button" class="btn" data-wx-resolve="${esc(p.id)}">核对后解除（不重发）</button></p>`).join('');
      pending.querySelectorAll('[data-wx-resolve]').forEach(button=>button.onclick=async()=>{
        if(!confirm('已人工核对原消息？此操作只解除该记录，不会重发。'))return;
        try{await api('/api/desktop-wechat/resolve-send',{method:'POST',body:JSON.stringify({id:button.dataset.wxResolve})});await refresh();}catch(e){el.textContent=e.message;}
      });
    } catch(e){const el=$('#wx-status');if(el)el.textContent=e.message;}
  };
  $('#wx-refresh')?.addEventListener('click',refresh);
  $('#wx-save')?.addEventListener('click',async()=>{
    const lines=id=>$(id).value.split('\n').map(s=>s.trim()).filter(Boolean);
    const patch={enabled:$('#wx-enabled').checked,groups:lines('#wx-groups'),privateChats:lines('#wx-private'),allowAllPrivateWhenEmpty:$('#wx-all-private').checked,imageSendEnabled:$('#wx-images').checked};
    try{await api('/api/desktop-wechat',{method:'POST',body:JSON.stringify(patch)});state.config.desktopWechat={...state.config.desktopWechat,...patch};await refresh();}catch(e){$('#wx-status').textContent=e.message;}
  });
  void refresh();
}
