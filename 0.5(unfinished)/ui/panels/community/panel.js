// 社区面板：发布账号、扩展发布与意见收集。
// 全部动作走面板 RPC（后端按 manifest 白名单放行），UI 只负责收集参数与呈现结果。
import {createLiveRefresh} from '../live-refresh.js';
import { onShellEvent, request, openCommunityPage, publishMarket, cancelMarketPublish, authenticateMarket, cancelMarketAuthentication, openCaptchaDiagnostics, onLeave, contentReady } from '/panels/panel-client.js';
import { $, clear, text, error, capability, confirmAction, button, bindDestructiveAction } from '../ui.js';
import { createFeedbackForm } from './feedback-form.js';
import {bindAuthoringGuide} from '../extension-authoring.js';
bindAuthoringGuide({parent:document.querySelector('main > header .actions')});

const meta = $('#meta');
let accounts = [];
let accountVersion=0,disposed=false,accountSignature='';
const linkStatus = $('#community-link-status');
for (const [id, target, label] of [
  ['#open-persona-plaza', 'persona-plaza-btn', '人设广场'],
  ['#open-feedback-page', 'feedback-btn', '意见页面'],
  ['#open-market', 'plugin-market-btn', '市场网页版'],
  ['#open-site', 'open-site-btn', '官网'],
]) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await openCommunityPage(target);text(linkStatus, `已请求在浏览器打开${label}`); }
    catch (e) { error(linkStatus, e.message || '无法打开网页，请稍后重试'); }
    finally { $(id).disabled = false; }
  });
}
$('#open-feedback').addEventListener('click',createFeedbackForm({status:$('#feedback-status')}));
$('#captcha-diagnostics').addEventListener('click',async()=>{try{await openCaptchaDiagnostics();}catch(e){error(linkStatus,e.message||'无法打开验证码诊断');}});

/* ---------- 账号 ---------- */
let selected = '';
let selectedAccountTarget = null;
let loggingOut = false;
const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出所选账号';
const logoutControl = bindDestructiveAction(logout, {
  clicks: 2, target: () => selectedAccountTarget, key: () => selected,
  canActivate: () => !loggingOut && !!selected && accounts.some(item => item.username === selected),
  impact: () => `移除账号 ${selected} 在本机保存的登录凭据，并尝试吊销登录令牌；社区账号仍然保留。`,
  action: async () => {
    const username = selected;
    loggingOut = true; renderAccounts();
    try { await request('POST', '/api/market/logout', { username }); await loadAccounts(); }
    finally { loggingOut = false; renderAccounts(); }
  },
});
function renderAccounts() {
  const host = $('#account-state');
  selectedAccountTarget = null;
  clear(host);
  logout.disabled = loggingOut || !selected || !accounts.some(item => item.username === selected);
  if (accounts.length === 0) {
    text(host, '未登录社区账号（发布扩展需要账号）');
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'actions';
  accounts.forEach((item) => {
    const account = document.createElement('div'); account.className = 'actions';
    const choose = button(`使用 ${item.username}`, async () => {
      if (loggingOut) return;
      if (selected !== item.username) logoutControl.reset();
      selected = item.username;
      renderAccounts();
    }, item.username === selected ? 'primary' : '');
    choose.disabled = loggingOut; account.append(choose);
    if (item.username === selected) selectedAccountTarget = account;
    wrap.append(account);
  });
  wrap.append(logout);
  host.append(wrap);
}

async function loadAccounts() {
  const version=++accountVersion;
  const data = await capability(() => request('GET', '/api/market/accounts'), meta);
  if(disposed||version!==accountVersion)return null;
  if(!data){void contentReady();return null;}
  accounts = data.accounts ?? [];
  if (!selected || !accounts.some((a) => a.username === selected)) {
    logoutControl.reset(); selected = accounts[0]?.username ?? '';
  }
  const signature=JSON.stringify([accounts,selected,loggingOut]);if(signature!==accountSignature){accountSignature=signature;renderAccounts();}
  text(meta,`已登录 ${accounts.length} 个账号`);
  void contentReady();
  return accounts;
}

let authenticating=false;
$('#login-cancel').addEventListener('click',async()=>{try{await cancelMarketAuthentication();}catch(e){error($('#login-note'),e.message||'无法取消登录等待');}});
onLeave(()=>authenticating?cancelMarketAuthentication():undefined);
async function authenticate(mode){
  if(authenticating)return;
  const payload = {
    loginId: $('#login-id').value.trim(),
    password: $('#login-password').value,
    displayName: $('#login-name').value.trim() || undefined,
    mode,
  };
  if(!payload.loginId||!payload.password){error($('#login-note'),'请填写社区账号和密码');return;}
  if(mode==='register'&&!payload.displayName){error($('#login-note'),'注册时请填写显示名称');return;}
  authenticating=true;$('#login').disabled=true;$('#register').disabled=true;
  try {
    if(mode==='register'&&!await confirmAction(`注册社区账号 ${payload.loginId}？\n\n账号用于发布与安装扩展，请勿复用重要密码。`))return;
    $('#login-cancel').hidden=false;text($('#login-note'),'等待人机验证与认证结果…');
    await authenticateMarket(payload);
    if($('#login-password').value===payload.password)$('#login-password').value = '';
    await loadAccounts();
    text($('#login-note'),mode==='register'?'注册成功':'登录成功');
  } catch (e) { error($('#login-note'), e.message || '社区认证失败'); }
  finally{authenticating=false;$('#login').disabled=false;$('#register').disabled=false;$('#login-cancel').hidden=true;}
}
$('#login').addEventListener('click',()=>authenticate('login'));
$('#register').addEventListener('click',()=>authenticate('register'));

let publishing=false;
$('#publish-cancel').addEventListener('click',async()=>{try{await cancelMarketPublish();}catch(e){error($('#publish-note'),e.message||'无法取消等待');}});
onLeave(()=>publishing?cancelMarketPublish():undefined);
$('#publish').addEventListener('click', async () => {
  if(publishing)return;
  const body = {
    kind: $('#publish-kind').value,
    id: $('#publish-id').value.trim(),
    displayName: $('#publish-name').value.trim() || undefined,
    description: $('#publish-desc').value.trim() || undefined,
    accountUsername: selected || undefined,
  };
  if(!body.id||!body.accountUsername){error($('#publish-note'),'请填写扩展 id，并选择一个已登录的账号');return;}
  publishing=true;$('#publish').disabled=true;
  try {
    if (!await confirmAction(`公开发布 ${body.kind}「${body.id}」到社区？\n\n发布的是当前目录里的代码，请确认你已检查过内容。确认后需要完成人机验证。`)) return;
    $('#publish-cancel').hidden=false;text($('#publish-note'),'等待人机验证与发布结果…');
    const result = await publishMarket(body);
    const note = result.renamedTo ? `（社区已改名为 ${result.renamedTo}）` : '';
    text($('#publish-note'), `发布成功${note}。${result.note ?? ''}`);
  } catch (e) { error($('#publish-note'), e.message || '发布失败'); }
  finally{publishing=false;$('#publish').disabled=false;$('#publish-cancel').hidden=true;}
});

const live=createLiveRefresh(()=>loadAccounts());
onShellEvent((name,payload)=>{if(name==='hello'||name==='status'&&payload?.communityAccountsUpdated)live.request();});
onLeave(() => {disposed=true;++accountVersion;live.dispose();logoutControl.dispose();});
$('#refresh').addEventListener('click', loadAccounts);

/* ---------- 启动 ---------- */
(async () => {
  const list = await loadAccounts();
  text(meta, list === null ? '环境未提供社区能力' : `社区就绪 · 已登录 ${accounts.length} 个账号`);
})().catch((e) => {if(!disposed){error(meta, e.message || '加载失败');void contentReady();}});
