// Default presentation leaf. ui.assets can replace this view independently
// of session storage, transport, selection and the scroll policy.
import {jsonDetails,dateTime} from '../ui.js';
import {collapsibleExpanded} from '../collapsible.js';
import {formatDuration,sessionDuration,formatCacheRate,sessionCacheRate,cacheTone} from './metrics.js';
const labels={waiting:'等待中',running:'运行中',done:'已回复',noreply:'未回复',error:'失败',aborted:'已中止'};
const content=value=>typeof value==='string'?value:JSON.stringify(value??'',null,2);
const snapshots=new WeakMap();
const streamFrames=new WeakMap();
const nodeKey=node=>node.nodeType===1?(node.dataset.key?`key:${node.dataset.key}`:node.dataset.sent!==undefined?`sent:${node.dataset.sent}`:null):null;
const compatible=(a,b)=>a?.nodeType===b.nodeType&&(b.nodeType!==1||a.localName===b.localName);

// Patch only this default view's own text/attributes. Preserve live details,
// nested scroll containers, focus and an in-progress fold's runtime attributes.
function patch(current,next){
  if(current.nodeType!==1){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
  const transient=new Set(['style','inert','aria-expanded',...(current.localName==='details'?['open']:[])]);
  for(const attribute of [...current.attributes])if(!transient.has(attribute.name)&&!next.hasAttribute(attribute.name))current.removeAttribute(attribute.name);
  for(const attribute of next.attributes)if(!transient.has(attribute.name)&&current.getAttribute(attribute.name)!==attribute.value)current.setAttribute(attribute.name,attribute.value);
  const keyed=new Map([...current.childNodes].filter(nodeKey).map(node=>[nodeKey(node),node])),retained=new Set();let cursor=current.firstChild;
  for(const wanted of [...next.childNodes]){
    const key=nodeKey(wanted);let node=key?keyed.get(key):cursor&&!nodeKey(cursor)&&compatible(cursor,wanted)?cursor:null;
    if(!compatible(node,wanted)){node=wanted;current.insertBefore(node,cursor);}
    else{if(node!==cursor)current.insertBefore(node,cursor);patch(node,wanted);}
    retained.add(node);cursor=node.nextSibling;
  }
  for(const node of [...current.childNodes])if(!retained.has(node))node.remove();
}

export function renderSessionTrace(host,data,{waiting}={}){
  const fingerprint=JSON.stringify(data);if(snapshots.get(host)===fingerprint&&host.children.length)return;
  const states=new Map([...host.querySelectorAll('details[data-key]')].map(node=>[node.dataset.key,collapsibleExpanded(node)]));
  const body=host.cloneNode(false);
  const remember=(node,key,expanded=false)=>{node.dataset.key=key;node.open=states.has(key)?states.get(key):expanded;return node;};
  function fold(key,title,hint='',kind='',expanded=false){
    const node=document.createElement('details'),summary=document.createElement('summary'),name=document.createElement('strong'),sub=document.createElement('span');
    node.dataset.collapsible='';node.className=`flow-card ${kind}`.trim();name.textContent=title;sub.className='flow-hint';sub.textContent=hint;
    summary.append(name,sub);node.append(summary);remember(node,key,expanded);return node;
  }
  const pre=value=>{const node=document.createElement('pre');node.className='flow-content';node.textContent=content(value);return node;};
  function duration(section,key,{state,startedAt,elapsedMs,durationMs,title}={}){
    const node=document.createElement('span');node.className='flow-duration';node.dataset.key=`${key}-duration`;if(title)node.title=title;
    const start=Number(startedAt),base=Math.max(0,Number(elapsedMs)||0),active=state==='running'&&data.status==='running'&&startedAt!=null&&Number.isFinite(start);
    if(active){node.dataset.elapsedStart=String(start);node.dataset.elapsedBase=String(base);node.textContent=`用时 ${formatDuration(Math.max(base,Date.now()-start))}`;}
    else{const stopped=state==='running'&&data.endedAt!=null&&Number.isFinite(start)?Math.max(base,Number(data.endedAt)-start):elapsedMs;node.textContent=`用时 ${formatDuration(durationMs??stopped)}`;}
    section.querySelector('summary').insertBefore(node,section.querySelector('.flow-hint'));return node;
  }
  const entries=[...(data.messages||[])],step=data.activeStep;
  if(step&&step.messageIndex===entries.length&&['generation','tool'].includes(step.kind)){
    if(step.kind==='generation')entries.push({role:'assistant',content:step.content||'',reasoning_content:step.reasoning||'',generationState:step.state,generationStartedAt:step.startedAt,generationElapsedMs:step.elapsedMs,...(step.state!=='running'?{generationDurationMs:step.elapsedMs}:{})});
    else entries.push({role:'tool',toolCall:{name:step.name,args:step.args,state:step.state,startedAt:step.startedAt,elapsedMs:step.elapsedMs,...(step.state!=='running'?{durationMs:step.elapsedMs,ok:step.state==='completed'}:{})}});
  }
  const receipts=data.sent||[],claimed=new Set(),sentByCall=new Map();
  const sameReceipt=(a,b)=>a&&b&&String(a.text??'')===String(b.text??'')&&(a.msgId!=null&&b.msgId!=null?String(a.msgId)===String(b.msgId):(a.at??a.ts)===(b.at??b.ts));
  for(const [index,message]of entries.entries()){
    const call=message.toolCall;if(!call)continue;
    let sent=call.sent;
    if(!Array.isArray(sent))try{const result=typeof call.result==='string'?JSON.parse(call.result):call.result;sent=result?.sent??result?.result?.sent;}catch{/* Older text-only results have no receipt list. */}
    for(const receipt of Array.isArray(sent)?sent:[]){const match=receipts.findIndex((item,i)=>!claimed.has(i)&&sameReceipt(item,receipt));if(match<0)continue;claimed.add(match);if(!sentByCall.has(index))sentByCall.set(index,[]);sentByCall.get(index).push(match);}
  }
  // Older archives only recorded a flat sent array. A single legacy sender is
  // unambiguous; with several senders keep unmatched receipts separate.
  const senders=entries.map((message,index)=>({call:message.toolCall,index})).filter(({call})=>['send_message','send_to'].includes(call?.name));
  if(senders.length===1&&!Array.isArray(senders[0].call.sent))for(let index=0;index<receipts.length;index++)if(!claimed.has(index)){claimed.add(index);if(!sentByCall.has(senders[0].index))sentByCall.set(senders[0].index,[]);sentByCall.get(senders[0].index).push(index);}
  function sentCard(indices,key){
    const sent=fold(key,'已发送',`${indices.length} 条消息 · 已送达`,'flow-sent',true);
    for(const index of indices){const item=receipts[index],message=document.createElement('div');message.className='sent-message';message.dataset.sent=String(index);
      const at=document.createElement('small'),timestamp=item.at??item.ts;at.textContent=timestamp!=null&&Number.isFinite(Number(timestamp))?dateTime(Number(timestamp)):String(timestamp??'');message.append(at,pre(item.text??''));sent.append(message);}
    body.append(sent);
  }
  const meta=document.createElement('div');meta.className='session-meta';meta.dataset.key='meta';
  const badge=document.createElement('span');badge.className=`badge status-${data.status}`;badge.textContent=labels[data.status]||data.status;meta.append(badge);
  const at=document.createElement('span'),elapsed=document.createElement('span');elapsed.dataset.key='session-duration';elapsed.className='session-elapsed';elapsed.textContent=`用时 ${formatDuration(sessionDuration(data))}`;
  if(data.status==='running'&&data.endedAt==null&&data.startedAt!=null&&Number.isFinite(Number(data.startedAt))){elapsed.dataset.elapsedStart=String(data.startedAt);elapsed.dataset.elapsedBase=String(sessionDuration(data));}
  at.append(document.createTextNode(`开始 ${dateTime(data.startedAt)} · `),elapsed);meta.append(at);
  for(const value of [`模型 ${data.model||'未知'} · 渠道 ${data.providerId||data.provider||data.vendor||'未知'}`,`${data.usage?.calls||0} 次调用 · ${data.rounds||0} 轮工具 · 搜索 ${data.webSearchCount||0} 次`,`输入 ${data.usage?.promptTokens||0} / 输出 ${data.usage?.completionTokens||0} / 缓存 ${data.usage?.cachedTokens||0} / 总计 ${data.usage?.totalTokens||0} tokens`]){
    const node=document.createElement('span');node.textContent=value;meta.append(node);
  }
  const cache=document.createElement('span');cache.className='cache-rate';cache.dataset.key='cache-rate';cache.dataset.tone=cacheTone(sessionCacheRate(data.usage));cache.textContent=`缓存命中率 ${formatCacheRate(data.usage)}`;meta.append(cache);
  body.append(meta);
  if(data.status==='waiting'&&data.waitUntil&&waiting){const node=waiting(data);if(node.dataset)node.dataset.key='wait';body.append(node);}
  for(const [key,title,value] of [['system','系统提示词',data.systemPrompt],['user','本次输入',data.userPrompt],['excluded','排除的工具与原因',data.excludedTools]]){
    if(value==null||value===''||Array.isArray(value)&&!value.length)continue;
    const section=jsonDetails(title,value);section.className='session-prompt';remember(section,key);body.append(section);
  }
  entries.forEach((message,index)=>{
    const key=`message-${index}`,call=message.toolCall;
    if(call){
      const pending=call.state==='running'&&data.status==='running',aborted=call.state==='aborted'||call.state==='running'&&data.status==='aborted',failed=call.state==='error'||call.ok===false||call.isError===true;
      const section=fold(key,call.name||'工具调用',pending?'调用中':aborted?'已中止':failed?'失败':'成功',pending?'flow-tool flow-pending':aborted?'flow-tool flow-aborted':failed?'flow-tool flow-error':'flow-tool flow-success');
      duration(section,key,{state:call.state,startedAt:call.startedAt,elapsedMs:call.elapsedMs,durationMs:call.durationMs});
      const args=jsonDetails('参数',call.args??{});remember(args,`${key}-args`,true);
      const result=jsonDetails('结果',call.result??message.content??'');remember(result,`${key}-content`,true);
      section.append(args,result);body.append(section);if(sentByCall.has(index))sentCard(sentByCall.get(index),`${key}-sent`);return;
    }
    if(message.toolImages){const section=fold(key,message.toolImages.tool||'工具图像',`${message.toolImages.count||0} 张图片`,'flow-tool');section.append(pre('已作为图像输入注入模型'));body.append(section);return;}
    if(message.role!=='assistant')return;
    const value=content(message.content),reasoning=message.reasoning_content??message.reasoning;
    if(!value.trim()&&!reasoning&&message.tool_calls?.length&&message.generationDurationMs==null)return;
    const pending=message.generationState==='running'&&data.status==='running',aborted=message.generationState==='aborted'||message.generationState==='running'&&data.status==='aborted',failed=message.generationState==='error';
    const section=fold(key,'思考',pending?'进行中':aborted?'已中止':failed?'失败':'不发送',pending?'flow-think flow-pending':aborted?'flow-think flow-aborted':failed?'flow-think flow-error':'flow-think',pending||!!reasoning);
    duration(section,key,{state:message.generationState,startedAt:message.generationStartedAt,elapsedMs:message.generationElapsedMs,durationMs:message.generationDurationMs,title:'本轮模型请求用时，包含网络与重试'});
    const reasoningView=jsonDetails('思考过程',reasoning||'');reasoningView.className='flow-reasoning';remember(reasoningView,`${key}-reasoning`,true);reasoningView.hidden=!reasoning;section.append(reasoningView);
    const text=jsonDetails('正文',value||(pending?'等待模型输出…':'（无文本输出）'));remember(text,`${key}-content`,true);section.append(text);
    for(const [name,title,entry] of [['tool_calls','模型请求的工具',message.tool_calls],['raw','原始响应与用量',message.raw]]){
      if(entry==null)continue;const child=jsonDetails(title,entry);remember(child,`${key}-${name}`);section.append(child);
    }
    body.append(section);
  });
  const unmatched=receipts.map((_,index)=>index).filter(index=>!claimed.has(index));if(unmatched.length)sentCard(unmatched,'sent');
  if(data.error&&data.status!=='aborted'){const section=fold('error','错误','运行异常','flow-error error',true);section.append(pre(data.error));body.append(section);}
  const reason=data.status==='aborted'?(data.finishReason||data.error||'已中止'):data.finishReason;
  if(reason){const section=fold('finish','结束原因',data.status==='aborted'?'已中止':'结束本次','flow-finish',true);section.append(pre(reason));body.append(section);}
  patch(host,body);snapshots.set(host,fingerprint);streamFrames.set(host,{streamId:step?.streamId,revision:step?.revision});
}

// Keep the live card, folds, focus and scroll containers in place. Token frames
// update two text nodes; the final round still uses the normal trace renderer.
export function renderStreamingStep(host,data,options){
  const step=data.activeStep,key=`message-${step?.messageIndex}`;
  let card=host.querySelector(`[data-key="${key}"]`);
  if(!card?.classList.contains('flow-pending')){renderSessionTrace(host,data,options);return;}
  const previous=streamFrames.get(host),delta=options?.delta,append=delta&&!delta.reset&&previous?.streamId===step.streamId&&previous.revision===delta.fromRevision;
  for(const [name,value]of [['content',step.content||'等待模型输出…'],['reasoning',step.reasoning||'']]){
    const section=card.querySelector(`[data-key="${key}-${name}"]`),pre=section?.querySelector('pre');
    const addition=delta?.[name]||'';
    if(pre&&!(append&&!addition)){
      const follow=pre.scrollHeight-pre.scrollTop-pre.clientHeight<=24,top=pre.scrollTop;
      if(append&&addition&&(step[name]||'').length>addition.length&&pre.firstChild?.nodeType===3&&pre.childNodes.length===1)pre.firstChild.appendData(addition);
      else if(pre.textContent!==value)pre.textContent=value;
      if(follow)pre.scrollTop=pre.scrollHeight;else pre.scrollTop=top;
    }
    if(name==='reasoning'&&section&&section.hidden===!!value)section.hidden=!value;
  }
  streamFrames.set(host,{streamId:step.streamId,revision:step.revision});snapshots.delete(host);
}
