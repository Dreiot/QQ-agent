import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createBlocklistState} from './blocklist-state.js';
import {createAutoSave,flushAutoSaves} from './auto-save.js';
const node=(tag,text)=>{const result=document.createElement(tag);if(text!==undefined)result.textContent=text;return result;};
const UID=/^\d{1,15}$/;

// The current panel owns an unlimited draft map. It deliberately contributes no
// large snapshot to the host's existing 7400-byte settings draft budget.
export function createBlocklistMembers({request,beforeOpen=async()=>{},onSaved=()=>{}}){
  const state=createBlocklistState();let dialog=null,generation=0,disposed=false;
  async function open(){
    await beforeOpen();if(disposed)return;if(dialog){dialog.focus();return;}
    const epoch=++generation,root=node('dialog');dialog=root;root.dataset.blocklistMembers='';
    const heading=node('h3','按群选择屏蔽成员'),notice=node('p'),retention=node('p','关闭此弹窗会保留当前页面的多群草稿；切换面板或刷新页面不会缓存这些草稿，请先保存。'),group=node('select'),search=node('input'),manual=node('input'),list=node('div'),summary=node('p'),actions=node('div');
    group.setAttribute('aria-label','选择屏蔽群');search.type='search';search.placeholder='搜索昵称、群名片或 QQ 号';search.setAttribute('aria-label','搜索屏蔽成员');manual.placeholder='手填未返回的 QQ 号';manual.setAttribute('aria-label','手填屏蔽 QQ');notice.setAttribute('role','status');actions.className='actions';retention.className='muted';list.className='blocklist-members-list';
    const save=node('button','保存所有群和全局变更'),close=node('button','关闭（草稿保留在当前页面）'),retry=node('button','重新读取'),add=node('button','加入手填号码');save.className='primary';actions.append(save,retry,close);root.append(heading,retention,group,search,manual,add,notice,summary,list,actions);
    save.hidden=true;retention.hidden=true;close.textContent='完成';
    const autoSave=createAutoSave({root,save:commit,dirty:()=>state.view().pending>0});
    const lifecycle=installDisposableDialog(root,{beforeClose:()=>flushAutoSaves(root),onClosed(){autoSave.dispose();if(dialog===root)dialog=null;++generation;}});let currentGroup='',members=[],memberSequence=0,cfg={},names=new Map(),memberError='',globalMessage='';
    const current=()=>!disposed&&dialog===root&&generation===epoch;
    function status(message=''){
      if(!current())return;const view=state.view();notice.textContent=message||[memberError,globalMessage].filter(Boolean).join(' ');summary.textContent='本群 · 仅当前群　／　全局 · 所有会话';save.disabled=view.saving;retry.disabled=view.saving;
    }
    function draw(){
      if(!current())return;list.replaceChildren();const query=search.value.trim().toLowerCase(),view=state.view(),self=String(view.data?.selfId??'');
      const supported=!!view.data?.global?.membership?.source;
      for(const member of state.candidates(currentGroup,members)){
        if(member.uid===self)continue;if(query&&!`${member.nickname} ${member.card} ${member.uid}`.toLowerCase().includes(query))continue;
        const row=node('article');row.dataset.blockUid=member.uid;row.className='list-item';row.append(node('strong',`${member.card||member.nickname||member.uid} (${member.uid})`),node('p',`昵称：${member.nickname||'未返回'} · 群名片：${member.card||'未返回'}${member.offline?' · 离线/本次未返回':''}`));
        for(const[scope,label]of [['group','仅本群屏蔽'],['global','全局屏蔽']]){
          const field=node('label'),input=node('input');input.type='checkbox';input.checked=state.value(scope,currentGroup,member.uid);input.dataset.blockScope=scope;input.disabled=scope==='group'?!currentGroup:!supported||member.uid.length>15;field.append(input,document.createTextNode(label));input.addEventListener('change',()=>{state.choose(scope,currentGroup,member.uid,input.checked);status();autoSave.schedule();});row.append(field);
          if(scope==='global'&&member.uid.length>15)field.title='默认名单支持1~15位数字QQ号；原有异常条目请在高级配置中明确处理。';
          const changed=view.rows.find(item=>item.uid===member.uid&&item.scope===scope&&(scope==='global'||item.groupId===currentGroup));
          if(changed?.conflict){const conflict=node('p',`${label}冲突：服务器当前为${changed.conflict.blocked?'屏蔽':'允许'}；你的选择为${changed.value?'屏蔽':'允许'}。`);if(changed.conflict.revision)for(const[keep,text]of [[false,'采用服务器值'],[true,'保留我的选择并按新版本重试']]){const resolve=node('button',text);resolve.addEventListener('click',()=>{state.resolve(scope,currentGroup,member.uid,keep);draw();autoSave.schedule();});conflict.append(resolve);}else conflict.append(document.createTextNode(' 当前来源没有逐成员版本；输入保留，全局写入暂停。'));row.append(conflict);}
          if(changed?.remotePending)row.append(node('p','本机已确认；云端尚未确认，保存将只重试此全局项。'));
        }
        list.append(row);
      }
      status();
    }
    async function readMembers(){const selected=currentGroup,ticket=++memberSequence;members=[];memberError='';draw();if(!selected)return;try{const payload=await request('GET',`/api/groups/${encodeURIComponent(selected)}/members`);if(!current()||selected!==currentGroup||ticket!==memberSequence)return;if(!Array.isArray(payload.members))throw Error('成员列表格式无效');members=payload.members;}catch(error){if(!current()||selected!==currentGroup||ticket!==memberSequence)return;memberError=`成员读取失败：${error.message}。已保存与手填号码仍可编辑。`;}draw();}
    async function read(){
      status('正在读取屏蔽名单…');
      try{const payload=await request('GET','/api/blocklist-members');if(!current())return;state.read(payload);globalMessage=payload.global?.unavailable?`全局能力不可用：${payload.global.error}；本群屏蔽仍可保存。`:!payload.global?.membership?.source?'所选社区客户端未提供逐成员版本，全局只读；可使用社区原名单入口。':'';
        try{cfg=await request('GET','/api/config');}catch{cfg={};}if(!current())return;
        const ids=new Set([...(cfg.allow?.groups??[]).map(String),...payload.groups.map(item=>item.groupId),...state.view().rows.map(item=>item.groupId).filter(Boolean)]);for(const id of names.keys())ids.add(id);group.replaceChildren();for(const id of ids){if(UID.test(id)){const option=node('option',`${names.get(id)||`群 ${id}`}${cfg.allow?.groups?.map(String).includes(id)?'':' · 不在白名单'}`);option.value=id;group.append(option);}}if(ids.has(currentGroup))group.value=currentGroup;currentGroup=group.value||'';void readMembers();
        // Metadata only enhances labels; it never replaces selections/drafts.
        void request('GET','/api/onebot/groups').then(result=>{if(!current())return;for(const item of result.groups??[]){const id=String(item.id??item.group_id??'');if(!UID.test(id))continue;names.set(id,String(item.name??item.group_name??id));let option=[...group.options].find(option=>option.value===id);if(!option){option=node('option');option.value=id;group.append(option);}option.textContent=`${names.get(id)} (${id})${cfg.allow?.groups?.map(String).includes(id)?'':' · 不在白名单'}`;}if(!currentGroup&&group.value){currentGroup=group.value;void readMembers();}}).catch(()=>{});
      }catch(error){if(current())status(`名单读取失败：${error.message}；未清空任何草稿。`);}
    }
    async function commit(){
      const sent=state.begin();if(!sent)return;if(sent.noop){status('没有待保存变更');return;}status('正在保存；此时仍可调整勾选，新输入不会被保存回执覆盖。');let message='',interrupted=false;
      const scopes=new Map();for(const item of sent.rows){const key=item.scope==='group'?`group:${item.groupId}`:'global';if(!scopes.has(key))scopes.set(key,[]);scopes.get(key).push(item);}
      for(const items of scopes.values()){
        for(let offset=0;offset<items.length;offset+=64){const changes=items.slice(offset,offset+64),first=changes[0],body={scope:first.scope,...(first.scope==='group'?{groupId:first.groupId}:{source:first.source}),changes:changes.map(({uid,blocked,expected})=>({uid,blocked,expected}))};
          try{const receipt=await request('PUT','/api/blocklist-members',body);state.accept(sent,first.scope,first.groupId,changes,receipt);onSaved();if(receipt.ok!==true){message=receipt.warning||'部分保存尚未确认；已确认项不会重复提交。';interrupted=true;break;}}
          catch(error){message=`保存失败：${error.message}；草稿保留，可重试。`;if(error.status===409||/409|其它|来源|版本|修改/.test(error.message))try{const latest=await request('GET','/api/blocklist-members');state.read(latest);state.conflict(changes,latest,first.scope,first.groupId);}catch{}interrupted=true;break;}
        }if(interrupted)break;
      }
      state.finish(sent,message||'');if(current())draw();if(interrupted)throw Error(message);
    }
    save.addEventListener('click',()=>{void autoSave.flush().catch(error=>status(error.message));});
    group.addEventListener('change',()=>{currentGroup=group.value;void readMembers();});search.addEventListener('input',draw);retry.addEventListener('click',()=>{void read();});add.addEventListener('click',()=>{const uid=manual.value.trim();if(!UID.test(uid)){status('请输入数字 QQ 号');return;}if(uid===String(state.view().data?.selfId??'')){status('当前机器人自身不提供勾选');return;}state.value('group',currentGroup,uid);manual.value='';draw();});close.addEventListener('click',()=>lifecycle.close());document.body.append(root);root.showModal();void read();
  }
  return{open,dispose(){disposed=true;++generation;if(dialog){dialog.close();dialog=null;}}};
}
