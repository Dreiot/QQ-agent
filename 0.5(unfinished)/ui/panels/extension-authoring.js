import {request,onLeave} from './panel-client.js';
import {button,text} from './ui.js';
import {installDisposableDialog} from './dialog-lifecycle.js';
import {buildAuthoringPrompt} from './extension-authoring-prompt.js';

let active=null;
export function openAuthoringGuide({readContext=()=>request('GET','/api/extensions/authoring-context')}={}) {
  if(active?.dialog.isConnected){active.dialog.querySelector('.authoring-prompt')?.focus();return active.dialog;}
  const dialog=document.createElement('dialog');dialog.className='authoring-guide';dialog.setAttribute('aria-label','创作扩展');
  const title=text(document.createElement('h3'),'创作扩展'),description=text(document.createElement('p'),'复制提示词，交给能读写本机文件的AI工具。AI会先问清你想要的功能，再自行判断做成技能还是插件，完成制作、自检和本地安装。新功能默认禁用，由你在列表中点击启用。');
  const fields=document.createElement('div');fields.className='settings-fields';
  function field(label,node){const wrap=text(document.createElement('label'),label);wrap.className='setting-field full';wrap.append(node);fields.append(wrap);return node;}
  const prompt=field('给AI的提示词',document.createElement('textarea'));prompt.readOnly=true;prompt.rows=12;prompt.className='authoring-prompt';prompt.setAttribute('aria-label','给AI的提示词');prompt.spellcheck=false;
  const state=text(document.createElement('p'),'正在读取项目位置…');state.setAttribute('role','status');state.className='muted';
  let context=null,closed=false,readVersion=0,unleave=()=>{};
  function render(){if(!closed){prompt.value=buildAuthoringPrompt({context});prompt.setSelectionRange(0,0);prompt.scrollTop=0;}}
  async function read(){const version=++readVersion;try {const next=await readContext();if(closed||version!==readVersion)return;if(typeof next?.appRoot!=='string'||!next.appRoot.trim()||next.appRoot.length>4096)throw new Error('项目位置响应无效');context=next;render();state.textContent='已读取项目位置；复制后AI会先与你确认需求。';}catch {if(!closed&&version===readVersion){context=null;render();state.textContent='暂未取得项目位置；确认需求后AI会询问安装目录，可重试。';}}}
  const copy=button('复制提示词',async()=>{
    const value=prompt.value;let copied=false;
    try {await navigator.clipboard.writeText(value);copied=true;}catch {
      if(closed)return;prompt.focus();prompt.select();try{copied=document.execCommand('copy')===true;}catch{}
    }
    if(closed)return;
    state.textContent=copied?'提示词已复制':'已选中提示词，请按Ctrl+C复制';
    if(value!==prompt.value&&copied)state.textContent='先前版本提示词已复制；如需最新内容请再次复制';
  },'primary');
  const close=()=>dialog.close();
  installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed(){closed=true;++readVersion;prompt.value='';unleave();window.removeEventListener('pagehide',close);if(active?.dialog===dialog)active=null;}});
  unleave=onLeave(close);window.addEventListener('pagehide',close,{once:true});
  const actions=document.createElement('div');actions.className='actions';actions.append(copy,button('重试读取位置',read),button('关闭',close));
  dialog.append(title,description,fields,state,actions);document.body.append(dialog);active={dialog};render();dialog.showModal();void read();return dialog;
}

export function bindAuthoringGuide({parent,kind='auto'}) {
  const control=button('创作扩展',()=>openAuthoringGuide({kind}));if(parent){const install=parent.querySelector('#install');if(install)parent.insertBefore(control,install);else parent.append(control);}return control;
}
