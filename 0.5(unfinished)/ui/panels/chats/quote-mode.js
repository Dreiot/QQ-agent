import{request,publishQuote,cancelQuotePublish,onLeave}from'/panels/panel-client.js';
import{button,destructiveButton,dateTime}from'../ui.js';
import{prepareDialog}from'../dialog-lifecycle.js';

// Publish reviewed fields and inline picture bytes. Archive ids, group keys,
// original media coordinates and reply objects stay local.
export function createQuoteMode({trigger=null,preview,status,getMessages,onModeChange,selectionActive=()=>false,onPreviewChange=()=>{}}){
  let active=false,selected=new Set(),dialog=null,busy=false,cleanupCurrent=null;
  const sync=()=>{
    const title=active?'退出金句模式':'金句模式',pressed=String(active),hidden=!active&&!selectionActive(),disabled=!selected.size||busy;
    if(trigger){if(trigger.textContent!==title)trigger.textContent=title;if(trigger.getAttribute('aria-pressed')!==pressed)trigger.setAttribute('aria-pressed',pressed);}
    if(preview.hidden!==hidden)preview.hidden=hidden;if(preview.disabled!==disabled)preview.disabled=disabled;
    if(active){const message=`金句模式 · 已选 ${selected.size} 条，请预览后确认公开内容`;if(status.textContent!==message)status.textContent=message;}
  };
  function closePreview(){cleanupCurrent?.();}
  function exit(){closePreview();active=false;selected.clear();status.textContent='';sync();onModeChange(false);}
  function enter(){active=true;selected.clear();sync();onModeChange(true);}
  trigger?.addEventListener('click',()=>{if(active)exit();else enter();});
  preview.addEventListener('click',()=>{
    if(dialog||!selected.size)return;
    const source=getMessages().filter(message=>selected.has(String(message.id)));
    dialog=document.createElement('dialog');dialog.className='quote-dialog';
    const currentDialog=dialog,title=document.createElement('h3'),notice=document.createElement('p'),form=document.createElement('form'),feedback=document.createElement('p');
    title.textContent='预览金句';notice.className='muted';notice.textContent='公开下面的昵称、发言人、时间、正文及保留的图片，不附带群名、群号、QQ号、原消息编号或原图地址。请检查正文和图片中的私人信息，可以移除图片。发布后，取消等待不能撤回投稿。';feedback.className='quote-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    const nickLabel=document.createElement('label'),nickname=document.createElement('input');nickLabel.className='setting-field';nickLabel.textContent='收录人昵称';nickname.name='nickname';nickname.maxLength=32;nickname.required=true;nickname.setAttribute('aria-label','收录人昵称');nickLabel.append(nickname);form.append(nickLabel);
    const fields=[],mediaEntries=[];let hasForward=false,closed=false,submit=null;
    const restriction=document.createElement('p');restriction.className='quote-restriction';restriction.setAttribute('role','status');
    const keptMedia=()=>mediaEntries.filter(item=>!item.excluded);
    function mediaReason(){
      const kept=keptMedia();
      if(hasForward)return '合并转发暂不能作为金句发布，请重新选择消息。';
      if(kept.length>9)return '最多保留9张图片，请移除多余素材。';
      if(kept.some(item=>item.error))return '有图片或素材无法上传，请移除失败素材后重试。';
      if(kept.some(item=>item.pending))return '正在读取图片，读取完成后可以发布。';
      if(kept.reduce((sum,item)=>sum+item.bytes,0)>1024*1024)return '图片总量超过1MB，请减少图片后重试。';
      return '';
    }
    function refreshMedia(){
      if(closed)return;
      if(keptMedia().length<=9)for(const entry of keptMedia())if(!entry.started&&!entry.error)void loadPicture(entry);
      const reason=mediaReason();restriction.textContent=reason||`已保留 ${keptMedia().length} 张图片 · 最多9张，图片总量最多1MB`;
      restriction.hidden=!mediaEntries.length&&!hasForward;
      if(submit)submit.disabled=busy||Boolean(reason);
    }
    async function loadPicture(entry){
      entry.started=true;
      try{
        const data=await request('POST','/api/media-data',{items:[entry.source]});
        if(closed||entry.excluded||!currentDialog.isConnected)return;
        const item=data.results?.[0],url=typeof item==='string'?item:item?.dataUrl;
        const match=/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url||'');
        if(!match)throw new Error('图片不可用或已过期');
        if(url.length>Math.ceil(1024*1024/3)*4+64)throw new Error('这张图片超过1MB，请移除后重试');
        const bytes=atob(match[2]).length;
        if(!bytes||bytes>1024*1024)throw new Error('这张图片超过1MB，请移除后重试');
        const image=document.createElement('img');image.alt='即将公开的金句图片';
        await new Promise((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('图片无法解码，请移除后重试'));image.src=url;entry.preview.replaceChildren(image);});
        if(closed||entry.excluded||!currentDialog.isConnected){image.removeAttribute('src');return;}
        entry.dataUrl=url;entry.bytes=bytes;
      }catch(error){if(!closed&&!entry.excluded){entry.error=error.message||'图片读取失败';entry.preview.textContent=entry.error;}}
      finally{entry.pending=false;refreshMedia();}
    }
    function cleanup(){
      if(closed)return;
      closed=true;const ownsDialog=dialog===currentDialog,cancelPublish=ownsDialog&&busy;
      if(ownsDialog){dialog=null;cleanupCurrent=null;busy=false;}
      if(cancelPublish)void cancelQuotePublish().catch(()=>{});
      currentDialog.close();currentDialog.remove();
      for(const image of currentDialog.querySelectorAll('img'))image.removeAttribute('src');
      for(const entry of mediaEntries){entry.dataUrl=null;entry.source=null;}
      fields.length=0;mediaEntries.length=0;currentDialog.replaceChildren();
      if(ownsDialog&&(active||selectionActive()))sync();
      if(ownsDialog)onPreviewChange();
    }
    cleanupCurrent=cleanup;
    source.forEach((message,index)=>{
      const article=document.createElement('article'),heading=document.createElement('h4'),senderLabel=document.createElement('label'),sender=document.createElement('input'),textLabel=document.createElement('label'),body=document.createElement('textarea'),time=document.createElement('small');article.className='quote-message';heading.textContent=`${index+1} · ${message.self?'机器人':'发言人'}`;
      senderLabel.className=textLabel.className='setting-field';senderLabel.textContent='公开发言人';textLabel.textContent='公开正文';sender.name=`sender-${index}`;sender.maxLength=64;sender.required=true;sender.value=message.self?'机器人':message.senderName&&!/^\d+$/.test(message.senderName)?message.senderName:'未知成员';body.name=`text-${index}`;body.maxLength=2000;body.required=true;
      body.value=`${message.reply?.text?`引用${message.reply.sender?` ${message.reply.sender}`:''}：${message.reply.text}\n\n`:''}${message.text||''}`;time.textContent=dateTime(message.ts);senderLabel.append(sender);textLabel.append(body);article.append(heading,time,senderLabel,textLabel);form.append(article);
      const field={sender,body,ts:Number(message.ts),self:message.self===true,media:[]};fields.push(field);
      for(const media of message.media||[]){
        const mediaBox=document.createElement('div'),imagePreview=document.createElement('div'),kind=media.kind||media.type||'image';mediaBox.className='quote-media';
        const entry={source:media,preview:imagePreview,kind,dataUrl:null,bytes:0,pending:['image','mface'].includes(kind),started:false,error:['image','mface'].includes(kind)?null:'暂不支持此素材，请移除',excluded:false};
        const remove=destructiveButton('移除此素材',()=>{entry.excluded=true;entry.dataUrl=null;entry.bytes=0;for(const image of mediaBox.querySelectorAll('img'))image.removeAttribute('src');mediaBox.replaceChildren(document.createTextNode('此素材已移除，不会公开'));refreshMedia();},{clicks:2,target:()=>mediaBox,canActivate:()=>!busy&&!closed&&!entry.excluded,impact:'从本次金句草稿移除此素材；聊天存档中的原内容保留。'});remove.className+=' quote-remove-media';
        imagePreview.textContent=entry.error||'图片等待加载…';mediaBox.append(imagePreview,remove);mediaEntries.push(entry);field.media.push(entry);body.required=false;
        article.append(mediaBox);
      }
      if(message.forward||message.text?.includes('[合并转发'))hasForward=true;
    });
    form.append(restriction);
    submit=button('确认公开发布',async()=>{
      if(busy||mediaReason())return;
      const nick=nickname.value.trim();
      if(!nick||nick.length>32){feedback.textContent='收录人昵称必填，最多32字';nickname.focus();return;}
      if(!fields.some(field=>field.self)){feedback.textContent='至少选择一条机器人发言';return;}
      const messages=fields.map(field=>({ts:field.ts,senderName:field.sender.value.trim(),text:field.body.value.trim(),self:field.self,media:field.media.filter(entry=>!entry.excluded).map(entry=>({kind:'image',url:'',file:'',dataUrl:entry.dataUrl}))}));
      if(messages.length>50||messages.some(message=>!message.senderName||message.senderName.length>64||(!message.text&&!message.media.length)||message.text.length>2000)){feedback.textContent='请选择至多50条消息，并检查发言人和正文（最多2000字）；无正文的消息需保留图片';return;}
      if(new TextEncoder().encode(JSON.stringify({nickname:nick,messages,captchaVerifyParam:'x'.repeat(16384)})).length>2*1024*1024){feedback.textContent='提交内容超过2MB，请减少图片或正文后重试';return;}
      busy=true;sync();refreshMedia();for(const input of currentDialog.querySelectorAll('input,textarea,.quote-remove-media'))input.disabled=true;feedback.textContent='请完成人机验证；验证通过后提交投稿…';
      try{
        const result=await publishQuote({nickname:nick,messages});
        if(result?.ok!==true)throw new Error('未能确认投稿结果，请稍后检查金句墙');
        if(dialog===currentDialog){const includedImages=messages.some(message=>message.media.length);busy=false;exit();status.textContent=includedImages?'含图金句已提交':'文字金句已提交';}
      }catch(error){if(currentDialog.isConnected)feedback.textContent=error.message||'金句上传失败，请稍后重试';}
      finally{if(dialog===currentDialog){busy=false;for(const input of currentDialog.querySelectorAll('input,textarea,.quote-remove-media'))input.disabled=false;if(currentDialog.isConnected){sync();refreshMedia();}}}
    },'primary');
    const actions=document.createElement('div');actions.className='actions';actions.append(button('取消',cleanup),submit);form.append(feedback,actions);form.addEventListener('submit',event=>event.preventDefault());
    currentDialog.addEventListener('cancel',event=>{event.preventDefault();cleanup();});
    currentDialog.addEventListener('close',cleanup,{once:true});
    currentDialog.append(title,notice,form);prepareDialog(currentDialog);document.body.append(currentDialog);currentDialog.showModal();onPreviewChange();refreshMedia();nickname.focus();
  });
  onLeave(()=>{exit();});sync();
  return{
    get active(){return active;},get selected(){return selected;},get previewing(){return dialog!==null;},exit,enter,
    setSelected(ids){selected=new Set(ids.map(String));sync();},
    updateMessages(messages){if(active||selectionActive()){const available=new Set(messages.map(message=>String(message.id)));selected=new Set([...selected].filter(id=>available.has(id)));sync();}},
  };
}
