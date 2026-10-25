import{request,publishFeedback,cancelFeedbackPublish,onLeave}from'/panels/panel-client.js';
import{button,bindDestructiveAction}from'../ui.js';
import{prepareDialog}from'../dialog-lifecycle.js';
import{FeedbackDraft}from'./feedback-draft-state.js';
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
// Official comments client: <=300KiB unchanged; larger images -> longest side 1600 / JPEG .85.
// https://kondius.cn/qq-agent/comments/ (GET, 2026-10-12).
// Reserve the bounded host-only CAPTCHA proof inside the local 2MiB request limit.
const FORM_BUDGET=2*1024*1024-64*1024;
function screenshot(file,signal){
  return new Promise((resolve,reject)=>{
    if(!IMAGE_TYPES.has(file.type))return reject(new Error('支持PNG、JPEG、WebP和GIF截图'));
    const image=new Image(),reader=new FileReader();let done=false;
    const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);reader.onload=reader.onerror=reader.onabort=null;image.onload=image.onerror=null;image.src='';error?reject(error):resolve(value);};
    const abort=()=>{reader.abort();finish(new Error('已取消读取截图'));};signal.addEventListener('abort',abort,{once:true});
    image.onerror=()=>finish(new Error(`无法读取截图：${file.name}`));
    image.onload=()=>{
      if(file.size<=300*1024){finish(null,String(reader.result));return;}
      try{const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);finish(null,canvas.toDataURL('image/jpeg',.85));}catch{finish(new Error(`无法处理截图：${file.name}`));}
    };
    reader.onload=()=>{image.src=String(reader.result);};reader.onerror=()=>finish(new Error(`无法读取截图：${file.name}`));reader.onabort=()=>finish(new Error('已取消读取截图'));reader.readAsDataURL(file);if(signal.aborted)abort();
  });
}
export function createFeedbackForm({status}){
  const draft=new FeedbackDraft(request);
  let dialog=null,cleanupCurrent=null,saveTimer=null,draftNotice=()=>{},hydrateCurrent=()=>{};
  function save(){
    clearTimeout(saveTimer);saveTimer=null;
    draftNotice('正在保存本机草稿…');
    return draft.flush().then(ticket=>{draftNotice('草稿已保存在本机');return ticket;},error=>{draftNotice(`草稿未保存：${error.message}；当前输入仍保留`);return null;});
  }
  function schedule(){clearTimeout(saveTimer);draftNotice('草稿尚未保存到本机');saveTimer=setTimeout(()=>void save(),300);}
  function close(){if(cleanupCurrent)return cleanupCurrent();clearTimeout(saveTimer);return draft.baseline||draft.loading||draft.dirty?save():Promise.resolve();}
  onLeave(async()=>{await close();draft.dispose();});
  return()=>{
    if(dialog)return;
    status.textContent='';dialog=document.createElement('dialog');dialog.className='feedback-dialog';const current=dialog,controller=new AbortController();
    const heading=document.createElement('h3'),notice=document.createElement('p'),form=document.createElement('form'),editor=document.createElement('section'),review=document.createElement('section'),feedback=document.createElement('p'),draftStatus=document.createElement('p'),comparison=document.createElement('section'),images=[];
    heading.textContent='意见收集';notice.className='muted';notice.textContent='反馈会公开显示在留言板。草稿保存在本机，取消或切换页面会保留。提交前请检查正文和截图中的私人信息。发布后，取消等待不能撤回投稿。';feedback.className='feedback-result';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');draftStatus.className='feedback-draft-status';draftStatus.setAttribute('role','status');draftStatus.setAttribute('aria-live','polite');review.className='feedback-review';review.hidden=true;
    function field(label,input){const node=document.createElement('label');node.className='setting-field';node.textContent=label;node.append(input);editor.append(node);return input;}
    const nickname=field('昵称（最多32字）',document.createElement('input'));nickname.name='nickname';nickname.maxLength=32;nickname.required=true;
    const content=field('反馈正文（最多5000字）',document.createElement('textarea'));content.name='text';content.maxLength=5000;content.required=true;content.rows=6;
    const files=field('截图（可选，最多9张）',document.createElement('input'));files.name='images';files.type='file';files.accept='image/png,image/jpeg,image/webp,image/gif';files.multiple=true;
    const hint=document.createElement('p'),attachments=document.createElement('div');hint.className='muted';hint.textContent='支持PNG、JPEG、WebP和GIF；较大图片会自动压缩。提交内容需小于2MB，可移除截图后重试。';attachments.className='feedback-attachments';editor.append(hint,attachments);
    let busy=false,processing=false,discarding=false,reviewed=null,reviewSignature=null,closed=false;
    draftNotice=message=>{if(!closed)draftStatus.textContent=message;};
    function changed(){draft.update({nickname:nickname.value,text:content.value,images:images.map(item=>item.dataUrl)});schedule();}
    nickname.addEventListener('input',changed);content.addEventListener('input',changed);
    function cleanup({saveDraft=true}={}){
      if(closed)return Promise.resolve();
      if(saveDraft)draft.update({nickname:nickname.value,text:content.value,images:images.map(item=>item.dataUrl)});
      closed=true;const cancelPublish=busy;busy=false;
      if(dialog===current){dialog=null;cleanupCurrent=null;}
      const cancel=cancelPublish?cancelFeedbackPublish().catch(()=>{}):Promise.resolve();
      discardControl.dispose();
      controller.abort();for(const item of images)item.view?.control.dispose();images.length=0;reviewed=null;review.replaceChildren();attachments.replaceChildren();
      current.close();current.remove();
      return Promise.all([cancel,saveDraft?save():Promise.resolve()]);
    }
    cleanupCurrent=cleanup;
    function controls(){preview.disabled=busy||processing||discarding;submit.disabled=busy;back.disabled=busy;manualSave.disabled=busy||processing||discarding;compare.disabled=busy||processing||discarding;discard.disabled=busy||processing||discarding||!draft.baseline;for(const input of editor.querySelectorAll('input,textarea,button'))input.disabled=busy||processing||discarding;}
    function renderAttachments(){
      const cards=images.map((item,index)=>{
        if(!item.view){
          const card=document.createElement('div'),image=document.createElement('img'),label=document.createElement('small'),remove=document.createElement('button'),name=document.createElement('span');
          card.className='feedback-attachment';image.src=item.dataUrl;label.textContent=item.name;remove.type='button';remove.append(name);card.append(image,label,remove);
          const control=bindDestructiveAction(remove,{
            clicks:2,target:()=>card,canActivate:()=>!busy&&!processing&&!closed&&!editor.hidden&&images.includes(item),
            impact:()=>`从本次反馈草稿移除截图「${item.name}」。`,
            action:()=>{const currentIndex=images.indexOf(item);if(currentIndex<0)return;images.splice(currentIndex,1);control.dispose();renderAttachments();changed();feedback.textContent='';},
          });
          item.view={card,image,name,control};
        }
        item.view.image.alt=`截图 ${index+1}`;item.view.name.textContent=`移除截图 ${index+1}`;return item.view.card;
      });
      attachments.replaceChildren(...cards);controls();
    }
    files.addEventListener('change',async()=>{
      const incoming=[...files.files];files.value='';if(processing||busy)return;
      if(images.length+incoming.length>9){feedback.textContent='截图最多9张，请减少后重新选择';return;}
      processing=true;controls();feedback.textContent='正在处理截图…';
      try{
        for(const file of incoming){const dataUrl=await screenshot(file,controller.signal);if(!current.isConnected)return;if(images.length>=9)throw new Error('截图最多9张，请减少后重新选择');
          const draft={nickname:nickname.value,text:content.value,images:[...images.map(item=>item.dataUrl),dataUrl]};
          if(new TextEncoder().encode(JSON.stringify(draft)).length>FORM_BUDGET)throw new Error('提交内容超过2MB，请减少截图后重试');
          images.push({name:file.name,dataUrl});renderAttachments();changed();
        }
        feedback.textContent='';
      }catch(error){if(current.isConnected)feedback.textContent=error.message||'截图处理失败';}
      finally{processing=false;if(current.isConnected)controls();}
    });
    const preview=button('预览反馈',()=>{
      if(processing||busy)return;
      const nick=nickname.value.trim(),text=content.value.trim();
      if(!nick||nick.length>32){feedback.textContent='昵称必填，最多32字';nickname.focus();return;}
      if(!text||text.length>5000){feedback.textContent='反馈正文必填，最多5000字';content.focus();return;}
      reviewed={nickname:nick,text,images:images.map(item=>item.dataUrl)};
      draft.update({nickname:nickname.value,text:content.value,images:images.map(item=>item.dataUrl)});reviewSignature=JSON.stringify(draft.value);
      if(new TextEncoder().encode(JSON.stringify(reviewed)).length>FORM_BUDGET){reviewed=null;feedback.textContent='提交内容超过2MB，请减少截图后重试';return;}
      review.replaceChildren();const title=document.createElement('h4'),name=document.createElement('p'),body=document.createElement('div'),screens=document.createElement('div');title.textContent='确认公开内容';name.textContent=`昵称：${nick}`;body.className='feedback-text';body.textContent=text;screens.className='feedback-attachments';
      images.forEach((item,index)=>{const image=document.createElement('img');image.src=item.dataUrl;image.alt=`公开截图 ${index+1}`;screens.append(image);});review.append(title,name,body,screens);editor.hidden=true;review.hidden=false;preview.hidden=true;submit.hidden=back.hidden=false;feedback.textContent='尚未投稿。确认公开发布后将进行人机验证。';submit.focus();
    });
    const back=button('返回编辑',()=>{if(busy)return;reviewed=null;reviewSignature=null;editor.hidden=false;review.hidden=true;preview.hidden=false;submit.hidden=back.hidden=true;feedback.textContent='';content.focus();});back.hidden=true;
    const submit=button('确认公开发布',async()=>{
      if(busy||!reviewed)return;
      busy=true;controls();feedback.textContent='请完成人机验证；验证通过后提交反馈…';
      try{
        const ticket=await save();if(closed)return;if(!ticket)throw new Error('草稿尚未保存到本机，请先处理保存问题后重试');
        if(ticket.signature!==reviewSignature)throw new Error('草稿已变更，请返回编辑并重新预览');
        const result=await publishFeedback(reviewed);if(result?.ok!==true)throw new Error('未能确认反馈提交结果，请稍后检查留言板');
        let cleared=false;try{cleared=(await draft.clearPublished(ticket)).cleared;}catch{/* The public receipt stays successful; a newer/conflicting local draft stays intact. */}
        if(cleared&&dialog!==current)hydrateCurrent();
        if(dialog===current){busy=false;await cleanup({saveDraft:false});}
        status.textContent=cleared?'意见已提交到公开留言板':'意见已提交到公开留言板；本机未清除的草稿仍保留';
      }
      catch(error){if(current.isConnected)feedback.textContent=error.message||'意见提交失败，请稍后重试';}
      finally{busy=false;if(current.isConnected)controls();}
    },'primary');submit.hidden=true;
    const manualSave=button('保存草稿',save);
    const compare=button('对比已保存草稿',async()=>{
      const saved=await draft.compare();if(closed)return;comparison.replaceChildren();
      const heading=document.createElement('h4'),stored=document.createElement('pre'),local=document.createElement('pre');heading.textContent='对比本机已保存内容';stored.textContent=`已保存昵称：${saved.draft.nickname}\n已保存正文：${saved.draft.text}\n截图：${saved.draft.images.length}张`;local.textContent=`当前昵称：${draft.value.nickname}\n当前正文：${draft.value.text}\n截图：${draft.value.images.length}张`;
      comparison.append(heading,stored,local,button('采用已保存草稿',()=>{draft.resolve(saved,true);hydrate();comparison.replaceChildren();draftNotice('已采用本机已保存草稿');}),button('保留当前输入并保存到已读版本',async()=>{draft.resolve(saved,false);comparison.replaceChildren();await save();}));
    });
    const discard=document.createElement('button');discard.type='button';discard.textContent='清除本机草稿';
    const discardControl=bindDestructiveAction(discard,{clicks:2,target:()=>editor,canActivate:()=>!closed&&!busy&&!processing&&!discarding&&!editor.hidden&&!!draft.baseline,impact:'清除本机保存的反馈昵称、正文和截图；不会删除已发布的反馈。',action:async()=>{
      clearTimeout(saveTimer);discarding=true;controls();
      try{const result=await draft.discard();if(!closed){hydrate();draftNotice(result.cleared?'本机草稿已清除':'输入已有更新，未清除新草稿');}}
      finally{discarding=false;if(!closed)controls();}
    }});
    function hydrate(){
      if(closed)return;nickname.value=draft.value.nickname;content.value=draft.value.text;
      for(const item of images)item.view?.control.dispose();images.splice(0,images.length,...draft.value.images.map((dataUrl,index)=>({dataUrl,name:`草稿截图 ${index+1}`})));renderAttachments();
    }
    const actions=document.createElement('div');actions.className='actions';actions.append(button('取消',()=>cleanup()),manualSave,compare,discard,back,preview,submit);form.append(editor,review,feedback,draftStatus,comparison,actions);form.addEventListener('submit',event=>event.preventDefault());
    current.addEventListener('cancel',event=>{event.preventDefault();void cleanup();});current.addEventListener('close',()=>{void cleanup();},{once:true});
    hydrateCurrent=hydrate;
    current.append(heading,notice,form);prepareDialog(current);document.body.append(current);current.showModal();nickname.focus();
    hydrate();draftNotice(draft.dirty?'草稿尚未保存到本机':'正在读取本机草稿…');
    void draft.load().then(()=>{if(!closed){hydrate();draftNotice(draft.conflict?'本机草稿有冲突，请先对比':draft.dirty?'草稿尚未保存到本机':'草稿已从本机恢复');}},error=>draftNotice(`无法读取本机草稿：${error.message}；当前输入仍保留`));
  };
}
