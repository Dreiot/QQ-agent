import {request,onShellEvent,onLeave,contentReady} from '/panels/panel-client.js';
import {$,clear} from '../ui.js';
import {createIcon} from '../icons.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createSpark,usageSeries} from './spark.js';

const names={chat:'会话',model:'模型',day:'日期',hour:'小时',session:'运行会话',provider:'渠道'};
const number=value=>Number.isFinite(Number(value))?Number(value):0;
const tokens=value=>number(value).toLocaleString('zh-CN');
const money=value=>{const n=number(value);return n===0?'¥0':`¥${n.toFixed(Math.abs(n)<.0001?6:Math.abs(n)<1?4:2)}`;};
const cacheRate=row=>Math.max(0,Math.min(1,number(row.cacheHitRate??(number(row.promptTokens)?number(row.cachedTokens)/number(row.promptTokens):0))));
const rate=row=>`${(cacheRate(row)*100).toFixed(1)}%`;
const ownButton=(label,handler,className='')=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.className=className;node.addEventListener('click',handler);return node;};
const element=(tag,content,className='')=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;};
let loadVersion=0,detailVersion=0,lastData=null,lastStatus=null,expanded=false,selected=null,detailDialog=null,toolDialog=null,disposed=false,inFlight=null,pendingRefresh=false,refreshTimer=null;
const rangeControl=$('#range'),metrics=$('#metrics'),cards=new Map(),tables=new WeakMap();
function summary(total){return `成本 ${money(total.cost)} · ${tokens(total.runs)} 次运行 / ${tokens(total.exactCalls)} 次模型调用 · 输入 ${tokens(total.promptTokens)} / 输出 ${tokens(total.completionTokens)} / 缓存 ${tokens(total.cachedTokens)} Tokens · 命中 ${rate(total)}`;}
function dimensionKey(value,dim){const field={chat:'chatKey',model:'model',day:'day',hour:'hour',session:'sessionId',provider:'provider'}[dim];return value[field]??value.key??(dim==='session'?value.id:dim==='provider'?value.vendor:dim==='chat'?value.chat:undefined)??'';}
function providerScope(value,dim){return dim==='model'&&value.modelKey!==undefined?(value.provider??''):undefined;}
function rowLabel(value,dim){const key=String(dimensionKey(value,dim));if(dim==='model'&&value.provider)return `${value.provider}：${value.model??key}`;return value.title||value.name||key;}
function updateText(node,value){const next=String(value);if(node.textContent!==next)node.textContent=next;}

function setupMetrics(){
  for(const [id,label,key,format] of [['cost','估算成本','cost',money],['calls','调用次数','exactCalls',tokens],['search','搜索次数','searchCount',tokens],['prompt','输入 Token','promptTokens',tokens],['cache','缓存命中率','cacheHitRate',value=>`${(number(value)*100).toFixed(1)}%`]]){
    const card=element('article',undefined,'metric'),head=element('div',label,'metric-label'),value=element('b','—','uc-value'),sub=element('small','正在读取…','uc-sub');card.dataset.metric=id;
    if(id==='calls'){const action=ownButton('明细 ›',openTools);action.setAttribute('aria-label','查看工具调用');head.append(action);}
    if(id==='search')head.append(element('span','不计入成本','metric-tag'));
    const spark=createSpark({key,label,valueNode:value,subNode:sub,format});card.append(head,value,sub,spark.host);metrics.append(card);cards.set(id,{card,value,sub,spark,key});
  }
}
function updateMetrics(data,status){
  const t=data.totals||{},today=status?.usage;
  const values={cost:[money(t.cost),data.rangeLabel||'当前区间'],calls:[tokens(t.exactCalls),`${tokens(t.runs)} 次运行${today?` · 今日 ${tokens(today.runs)} 次运行`:''}`],search:[tokens(data.searchCount),number(data.searchCount)?`搜索 ${tokens(number(data.toolCounts?.web_search)+number(data.toolCounts?.search_web))} · 抓网页 ${tokens(data.toolCounts?.web_fetch)}`:'本区间没有联网'],prompt:[tokens(t.promptTokens),`输出 ${tokens(t.completionTokens)}`],cache:[rate(t),`命中 ${tokens(t.cachedTokens)}`]};
  for(const [id,card] of cards){const [value,sub]=values[id];card.spark.update(usageSeries(data,card.key),value,sub);}
}

// Stable viewport/table/row nodes retain scrolling, focus and the model expand
// state on status refreshes. Only removed identities are actually detached.
function renderRows(host,values,dim,{loading=false,empty='暂无数据',drilldown=true,provider=undefined}={}){
  let view=tables.get(host);
  if(!view){
    const viewport=element('div',undefined,'usage-table'),table=document.createElement('table'),thead=document.createElement('thead'),head=document.createElement('tr'),body=document.createElement('tbody');
    viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label',`按${names[dim]||'项目'}统计`);
    const labels=[dim==='model'?'模型（渠道：模型 ID）':names[dim]||'项目','调用','输入','输出',...(dim==='day'?['缓存命中']:[]),'命中率','成本'];
    for(const label of labels)head.append(element('th',label));thead.append(head);table.append(thead,body);viewport.append(table);host.replaceChildren(viewport);view={viewport,body,entries:new Map(),columns:labels.length,empty:null};tables.set(host,view);
  }
  view.drilldown=drilldown;view.provider=provider;
  const focused=view.viewport.contains(document.activeElement)?document.activeElement:null,scrollLeft=view.viewport.scrollLeft,scrollTop=view.viewport.scrollTop;
  const wanted=new Set();
  for(const [index,value] of values.entries()){
    const key=String(dimensionKey(value,dim)),scope=providerScope(value,dim),identity=JSON.stringify([key,scope??null]);wanted.add(identity);
    let entry=view.entries.get(identity);
    if(!entry){
      const line=document.createElement('tr'),cells=Array.from({length:view.columns},()=>document.createElement('td'));
      entry={line,cells,value,button:null};entry.button=ownButton('',()=>{if(!view.drilldown)return;const scope=providerScope(entry.value,dim);showBreakdown(dim,String(dimensionKey(entry.value,dim)),null,scope===undefined?view.provider:scope);});
      cells[0].append(entry.button);line.append(...cells);line.addEventListener('click',event=>{if(!event.target.closest('button,a,input,select'))entry.button.click();});view.entries.set(identity,entry);
    }
    entry.value=value;entry.line.dataset.key=key;if(scope!==undefined)entry.line.dataset.provider=scope;
    const label=rowLabel(value,dim);updateText(entry.button,label);entry.button.disabled=!drilldown;entry.line.toggleAttribute('data-no-drill',!drilldown);entry.button.title=!drilldown?'旧账未记录可追溯的交叉明细':scope===''&&dim==='model'?'旧账未记录渠道；明细仅含这部分历史汇总':`${tokens(value.runs)} 次运行 · ${tokens(value.exactCalls)} 次模型调用`;
    const valuesForCells=[tokens(value.exactCalls),tokens(value.promptTokens),tokens(value.completionTokens),...(dim==='day'?[tokens(value.cachedTokens)]:[]),rate(value),money(value.cost)];
    for(const [i,content] of valuesForCells.entries())updateText(entry.cells[i+1],content);
    if(view.body.children[index]!==entry.line)view.body.insertBefore(entry.line,view.body.children[index]||null);
  }
  for(const [id,entry] of view.entries)if(!wanted.has(id)){entry.line.remove();view.entries.delete(id);}
  if(values.length){view.empty?.remove();view.empty=null;}
  else{if(!view.empty){view.empty=document.createElement('tr');const cell=element('td','','usage-empty');cell.colSpan=view.columns;view.empty.append(cell);view.body.append(view.empty);}updateText(view.empty.firstChild,loading?'加载中…':empty);}
  if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
  view.viewport.scrollLeft=scrollLeft;view.viewport.scrollTop=scrollTop;
}
function renderModels(){if(!lastData)return;const values=lastData.models||[];renderRows($('#models'),expanded?values:values.slice(0,20),'model');const expand=$('#models-expand');expand.hidden=values.length<=20;expand.textContent=expanded?'收起':`展开全部（还有 ${values.length-20} 项）`;expand.setAttribute('aria-expanded',String(expanded));}
function renderData(data,status){
  updateMetrics(data,status);$('#days-block').hidden=['today','24h'].includes(data.mode);renderRows($('#days'),data.days||[],'day');renderRows($('#chats'),data.chats||[],'chat');renderModels();renderRows($('#providers'),data.providers||[],'provider');renderRows($('#sessions'),data.sessions||[],'session');renderRows($('#hours'),(data.hours||[]).filter(row=>number(row.runs)||number(row.exactCalls)||number(row.totalTokens)),'hour');
  if(toolDialog?.open)renderTools();
}
function syncRange(){for(const button of document.querySelectorAll('#usage-ranges [data-range]'))button.setAttribute('aria-pressed',String(button.dataset.range===rangeControl.value));}
async function load(){
  if(disposed)return;const version=++loadVersion,range=rangeControl.value;if(!lastData){metrics.setAttribute('aria-busy','true');updateText($('#status'),'正在读取用量…');}$('#status').className='muted';
  const pending=Promise.all([request('GET','/api/usage/stats',undefined,{range}),request('GET','/api/status').catch(()=>null)]);inFlight=pending;
  try{const [data,status]=await pending;if(disposed||version!==loadVersion||range!==rangeControl.value)return;lastData=data;lastStatus=status||lastStatus;renderData(data,lastStatus);updateText($('#status'),data.rangeLabel||range);if(selected&&detailDialog?.open)void loadDetail(false);void contentReady();}
  catch(error){if(!disposed&&version===loadVersion){$('#status').className='error';updateText($('#status'),`用量加载失败：${error.message||'请重试'}${lastData?'；保留上次结果。':''}`);void contentReady();}}
  finally{if(version===loadVersion)metrics.setAttribute('aria-busy','false');if(inFlight===pending){inFlight=null;if(pendingRefresh&&!disposed){pendingRefresh=false;scheduleRefresh();}}}
}
function scheduleRefresh(){if(disposed)return;if(inFlight){pendingRefresh=true;return;}if(refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=null;void load();},160);}
function changeRange(value){if(![...rangeControl.options].some(option=>option.value===value))return;rangeControl.value=value;syncRange();detailDialog?.close();for(const card of cards.values())card.spark.restore();void load();}

function makeDialog(id,title,closeLabel,onClosed){
  const dialog=element('dialog',undefined,'usage-dialog'),head=element('div',undefined,'dialog-head'),heading=element('h3',title);dialog.id=id;heading.id=id+'-title';dialog.setAttribute('aria-labelledby',heading.id);head.append(heading,ownButton(closeLabel,()=>dialog.close(),'dialog-close'));dialog.append(head);
  installDisposableDialog(dialog,{onClosed,dismissOnBackdrop:true});document.body.append(dialog);return dialog;
}
function showBreakdown(dim,key,by=null,provider=undefined){
  const origin=document.activeElement;
  if(!detailDialog?.open){
    detailDialog=makeDialog('breakdown','用量明细','关闭明细',()=>{selected=null;++detailVersion;detailDialog=null;if(origin?.isConnected&&!document.querySelector('dialog[open]'))origin.focus({preventScroll:true});});
    const controls=element('div',undefined,'usage-detail-controls'),tabs=element('div',undefined,'detail-tabs'),select=document.createElement('select');select.id='breakdown-by';select.setAttribute('aria-label','明细统计维度');
    for(const [value,label] of Object.entries(names))select.append(new Option(`按${label}`,value));select.addEventListener('change',()=>{if(selected){selected={...selected,by:select.value};void loadDetail();}});
    controls.append(tabs,select);detailDialog.append(element('p','加载中…','summary'),controls,element('div',undefined,'peak-split'),element('p','','detail-feedback'),element('div',undefined,'detail-rows'));detailDialog.showModal();
  }
  selected={dim,key,by:by||({chat:'model',model:'chat',day:'model',hour:'chat',session:'model',provider:'model'}[dim]||'day'),...(provider===undefined?{}:{provider})};
  if(dim==='model'&&provider===''&&!by)selected.by='day';
  updateText(detailDialog.querySelector('h3'),`${names[dim]}明细 · ${key}${provider?` · ${provider}`:provider===''?' · 旧账未分渠道':''}`);void loadDetail();
}
async function loadDetail(showLoading=true){
  if(!selected||!detailDialog?.open)return;const dialog=detailDialog,choice={...selected},range=rangeControl.value,version=++detailVersion,rows=dialog.querySelector('.detail-rows'),feedback=dialog.querySelector('.detail-feedback');
  const scope=JSON.stringify([range,choice.dim,choice.key,choice.provider??null,choice.by]),scopeChanged=dialog.dataset.scope!==scope;
  if(scopeChanged){dialog.dataset.scope=scope;updateText(dialog.querySelector('.summary'),'正在读取该项明细…');dialog.querySelector('.peak-split').hidden=true;tables.delete(rows);clear(rows);rows.dataset.by=choice.by;renderRows(rows,[],choice.by,{loading:true,drilldown:choice.provider!=='',provider:choice.provider});}
  const select=dialog.querySelector('#breakdown-by');select.value=choice.by;
  const tabs=dialog.querySelector('.detail-tabs'),options={chat:[['model','各模型'],['day','各天']],model:[['chat','各会话'],['day','各天']],day:[['model','各模型'],['chat','各会话']]}[choice.dim]||[['model','各模型'],['day','各天']];
  const signature=JSON.stringify(options);if(tabs.dataset.signature!==signature){tabs.dataset.signature=signature;clear(tabs);for(const [by,label] of options){const tab=ownButton(label,()=>{selected={...selected,by};void loadDetail();});tab.dataset.by=by;tabs.append(tab);}}
  for(const tab of tabs.children)tab.setAttribute('aria-pressed',String(tab.dataset.by===choice.by));
  if(showLoading){rows.setAttribute('aria-busy','true');feedback.className='detail-feedback';updateText(feedback,'正在加载明细…');}
  try{
    const data=await request('GET','/api/usage/breakdown',undefined,{range,...choice});
    if(disposed||version!==detailVersion||detailDialog!==dialog||!dialog.open||range!==rangeControl.value)return;
    updateText(dialog.querySelector('.summary'),summary(data.totals||{}));renderPeak(dialog.querySelector('.peak-split'),data);
    // Different dimensions have different headers; replace this detail-only
    // table when switching dimensions, without replacing the modal controls.
    if(rows.dataset.by!==choice.by){rows.dataset.by=choice.by;tables.delete(rows);clear(rows);}
    renderRows(rows,data.rows||[],choice.by,{empty:data.detailUnavailable?'旧账仅保留汇总，没有此维度的历史明细。':'暂无数据',drilldown:choice.provider!=='',provider:choice.provider});updateText(feedback,data.detailUnavailable?'此部分历史用量未记录可追溯的交叉明细，汇总仍按原账保留。':'');
    if(!dialog.contains(document.activeElement))select.focus({preventScroll:true});
  }catch(error){if(version===detailVersion&&detailDialog===dialog&&dialog.open){feedback.className='detail-feedback error';updateText(feedback,`明细加载失败：${error.message||'请重试'}`);if(scopeChanged){updateText(dialog.querySelector('.summary'),'未能读取该项明细');renderRows(rows,[],choice.by,{empty:'明细读取失败，请切换维度重试。',drilldown:false});}}}
  finally{if(version===detailVersion&&dialog.isConnected)rows.setAttribute('aria-busy','false');}
}
function renderPeak(host,data){
  const total=data.totals||{};host.hidden=!data.showPeak&&!total.hasPeakModel&&!total.hasPeakTiers;if(host.hidden)return;
  const signature=JSON.stringify([total.peakTokens,total.offPeakTokens,total.peakCost,total.offPeakCost]);if(host.dataset.signature===signature)return;host.dataset.signature=signature;
  clear(host);host.append(element('strong','峰谷拆分'));const peakTokens=number(total.peakTokens),offTokens=number(total.offPeakTokens),all=peakTokens+offTokens;
  for(const [label,cost,count] of [['峰时',total.peakCost,peakTokens],['谷时',total.offPeakCost,offTokens]]){const row=element('div',undefined,'peak-row'),track=element('span',undefined,'peak-track'),bar=document.createElement('i'),percent=all?count/all:0;bar.style.width=`${percent*100}%`;track.append(bar);row.append(element('span',label),element('span',money(cost)),track,element('span',`${(percent*100).toFixed(0)}% Tokens`));host.append(row);}
}

const toolMeta={send_message:['发消息','发言'],send_to:['发消息到会话','发言'],send_sticker:['发表情','发言'],send_poke:['戳一戳','发言'],get_recent_messages:['翻聊天记录','查看'],get_message_detail:['看消息详情','查看'],get_message_images:['看图片','查看'],get_active_members:['看活跃群友','查看'],list_stickers:['列表情库','表情'],get_sticker_image:['看表情图','表情'],collect_sticker:['收藏表情','表情'],sticker_note:['备注表情','表情'],memory_append:['记一条','记忆'],memory_query:['查记忆','记忆'],memory_remove:['删记忆','记忆'],web_search:['联网搜索','联网'],search_web:['联网搜索','联网'],web_fetch:['抓网页','联网'],report_feedback:['汇报反馈','其他'],finish:['结束本次','其他']};
function openTools(){if(toolDialog?.open)return;const origin=document.activeElement;toolDialog=makeDialog('tool-breakdown','工具调用明细','关闭',()=>{toolDialog=null;if(origin?.isConnected&&!document.querySelector('dialog[open]'))origin.focus({preventScroll:true});});toolDialog.append(element('p','','tool-note'),element('div',undefined,'tool-content'),element('p','工具调用本身不额外计费，估算成本来自模型消耗的 Token。','tool-note'));toolDialog.querySelector('.tool-content').id='tools';renderTools();toolDialog.showModal();}
function renderTools(){
  if(!toolDialog)return;const entries=Object.entries(lastData?.toolCounts||{}).map(([id,count])=>({id,count:Math.max(0,number(count))})).filter(item=>item.count>0),total=entries.reduce((sum,item)=>sum+item.count,0),max=Math.max(...entries.map(item=>item.count),1),host=toolDialog.querySelector('#tools');updateText(toolDialog.querySelector('.tool-note'),`${lastData?.rangeLabel||'当前区间'} · 共 ${tokens(total)} 次工具调用`);const signature=JSON.stringify(entries);if(host.dataset.signature===signature)return;host.dataset.signature=signature;clear(host);
  if(!entries.length){host.append(element('p','这个时间区间内还没有任何工具调用记录。','empty'));return;}
  const groups=new Map();for(const item of entries){const [name,category]=toolMeta[item.id]||[item.id,'其他'];if(!groups.has(category))groups.set(category,[]);groups.get(category).push({...item,name});}
  const icons={发言:'chats',查看:'search',表情:'smile',记忆:'memory',联网:'globe',其他:'skills'};
  for(const category of ['发言','查看','表情','记忆','联网','其他']){
    const items=groups.get(category);if(!items)continue;const group=element('section',undefined,'tool-category'),head=element('div',undefined,'tool-category-head'),count=items.reduce((sum,item)=>sum+item.count,0);head.append(createIcon(icons[category],{size:18}),element('h4',category),element('small',`${tokens(count)} 次 · ${(count/total*100).toFixed(0)}%`));group.append(head);
    for(const item of items.sort((a,b)=>b.count-a.count)){const row=element('div',undefined,'tool-row'),name=document.createElement('div'),track=element('span',undefined,'tool-track'),bar=document.createElement('i');name.append(element('strong',item.name),element('code',item.id));bar.style.width=`${item.count/max*100}%`;track.append(bar);row.append(name,track,element('span',`${tokens(item.count)} 次`,'tool-count'));group.append(row);}host.append(group);
  }
}

setupMetrics();for(const [id,dim] of [['days','day'],['chats','chat'],['models','model'],['providers','provider'],['sessions','session'],['hours','hour']])renderRows($('#'+id),[],dim,{loading:true});
for(const button of document.querySelectorAll('#usage-ranges [data-range]'))button.addEventListener('click',()=>changeRange(button.dataset.range));
rangeControl.addEventListener('change',()=>changeRange(rangeControl.value));$('#reload').addEventListener('click',()=>void load());$('#models-expand').addEventListener('click',()=>{expanded=!expanded;renderModels();});
onShellEvent((name,payload)=>{if(['hello','session-start','session-update','session-end','price-update'].includes(name)||name==='status'&&payload?.configUpdated)scheduleRefresh();});
const visible=()=>{if(!document.hidden)scheduleRefresh();};document.addEventListener('visibilitychange',visible);
function dispose(){document.removeEventListener('visibilitychange',visible);disposed=true;++loadVersion;++detailVersion;clearTimeout(refreshTimer);detailDialog?.close();toolDialog?.close();}
onLeave(dispose);window.addEventListener('pagehide',dispose);syncRange();void load();
