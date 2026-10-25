import {button,destructiveButton,text} from '../ui.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {bindAutoSave,flushAutoSaves} from './auto-save.js';
import {TransactionDraft,withinDraftBudget,packFields,restoreFields} from './transaction-draft.js';
import {priceCatalogue} from './model-price-data.js';
const FIELDS=[['in','输入 / 百万 Token'],['out','输出 / 百万 Token'],['cached','缓存 / 百万 Token']];
const node=(tag,value)=>{const result=document.createElement(tag);if(value!==undefined)text(result,value);return result;};
const strings=view=>({...view,values:Object.fromEntries(FIELDS.map(([key])=>[key,view.values[key]==null?'':String(view.values[key])]))});
const number=value=>{if(!String(value).trim())return null;const result=Number(value);if(!Number.isFinite(result)||result<0)throw Error('单价需为非负数字，留空删除该自定义字段');return result;};
const format=price=>price?`输入 ${price.in ?? 0} / 输出 ${price.out ?? 0} / 缓存 ${price.cached==null?'随输入':price.cached}${price.peak?' · 含高峰单价':''}`:'未提供';
export function createModelPriceEditor({request,providers=()=>[],beforeOpen=async()=>{},onSaved=()=>{}}){
  let dialog=null,drawCurrent=()=>{},notice=()=>{},ticket=0,saving=false,filter='',newId='',empty=null,disposed=false,uncachedPrevious=false;
  const rows=new Map(),catalogue=new Map(),quotes=new Map();
  const dirty=row=>row.remove||row.draft.pending.size;
  function packed(){return{version:1,filter:filter.slice(0,200),newId:newId.slice(0,200),rows:[...rows].filter(([,row])=>dirty(row)).map(([id,row])=>({id,...packFields(row.draft,FIELDS.map(([key])=>key)),remove:row.remove,rowRevision:row.rowRevision}))};}
  const cacheable=value=>value.rows.length<=8&&withinDraftBudget(value,5200);
  // A valid small tombstone replaces the previous host snapshot. Returning an
  // oversized value or throwing would retain a stale, apparently saved subset.
  function snapshot(){const value=packed();return cacheable(value)?value:{version:1,overflow:true};}
  function restore(value){try{if(value?.version!==1)return;if(value.overflow===true){uncachedPrevious=true;return;}if(!Array.isArray(value.rows)||!cacheable(value))return;filter=value.filter||'';newId=value.newId||'';for(const item of value.rows){const draft=restoreFields(item,FIELDS.map(([key])=>key));if(typeof item.id==='string'&&item.id.length<=200){rows.set(item.id,{draft,remove:item.remove===true,rowRevision:item.rowRevision});catalogue.set(item.id,{id:item.id,names:[],vendors:['恢复的草稿']});}}}catch{/* A malformed host snapshot never alters persisted prices. */}}
  function getRow(id){if(!rows.has(id))rows.set(id,{draft:new TransactionDraft(strings({...empty,id})),remove:false,rowRevision:empty.rowRevision});return rows.get(id);}
  function applyInput(id,key,value){const row=getRow(id);row.remove=false;row.draft.set(key,value);notice('尚未保存；留空删除自定义字段，整行自定义价不会逐字段继承目录。');}
  async function open(){
    if(disposed||dialog)return;await beforeOpen();if(disposed||dialog)return;
    quotes.clear();const read=++ticket,root=node('dialog'),body=node('article'),heading=node('h3','批量设置模型价格'),feedback=node('p'),host=node('div'),comparison=node('div');
    root.className='settings-spec-dialog settings-model-prices';feedback.setAttribute('role','status');root.append(body);body.append(heading,node('p','目录参考与当前有效计价独立显示。自定义价格按模型 ID 共用；0 是免费价，空白删除自定义字段。'));
    const search=node('input');search.type='search';search.placeholder='搜索模型 ID、名称或提供商';search.value=filter;body.append(search,feedback,host,comparison);
    const idLabel=node('label','目录外模型 ID'),idInput=node('input');idInput.value=newId;idInput.maxLength=200;idLabel.append(idInput);body.append(idLabel);
    dialog=root;notice=message=>{if(dialog===root)text(feedback,message+(!cacheable(packed())?' 当前草稿超出跨页缓存容量，输入仍保留在当前页面；请先保存再离开。':uncachedPrevious?' 上次草稿超出跨页缓存容量，未跨页保留；旧缓存已失效，请核对服务器已保存的内容。':''));};
    const autoSave=bindAutoSave(root,commit,{dirty:()=>[...rows.values()].some(dirty),accept:event=>event.target.matches('[data-price]')});
    installDisposableDialog(root,{beforeClose:()=>flushAutoSaves(root),onClosed:()=>{autoSave.dispose();if(dialog===root){dialog=null;drawCurrent=()=>{};notice=()=>{};++ticket;}}});document.body.append(root);root.showModal();
    let loaded=false;
    function draw(){
      if(dialog!==root)return;host.replaceChildren();
      for(const item of catalogue.values()){
        const{id,names,vendors}=item;if(!`${id} ${names.join(' ')} ${vendors.join(' ')}`.toLowerCase().includes(filter.toLowerCase()))continue;
        const row=getRow(id),box=node('fieldset'),legend=node('legend',`${names.join(' / ')||id}${names.length?` (${id})`:''} · ${vendors.join(' / ')}`);box.dataset.motionKey=`model-price:${id}`;box.dataset.modelRow=id;box.append(legend);host.append(box);
        const quote=quotes.get(id),reference=node('p'),effective=node('p');reference.dataset.priceReference=id;effective.dataset.priceEffective=id;
        text(reference,quote?`目录参考（${quote.reference?.origin??'未提供'}）：${format(quote.reference)}`:'目录参考：读取中…');text(effective,quote?`当前有效计价（${quote.current?.source??'未提供'}）：${format(quote.current)}`:'当前有效计价：读取中…');box.append(reference,effective);
        for(const[key,label]of FIELDS){const wrap=node('label',label),input=node('input');input.type='number';input.min='0';input.step='any';input.dataset.model=id;input.dataset.price=key;input.value=row.draft.value(key);input.disabled=!loaded;input.placeholder=quote?.reference?.[key]==null?'':String(quote.reference[key]);input.addEventListener('input',()=>applyInput(id,key,input.value));wrap.append(input);box.append(wrap);}
        box.append(destructiveButton('清除自定义价',()=>{row.remove=true;for(const[key]of FIELDS)row.draft.set(key,'');for(const input of box.querySelectorAll('[data-price]'))input.value='';autoSave.schedule();},{target:()=>box,clicks:2,key:()=>id,impact:`清除 ${id} 的自定义价格。`}));
      }
    }
    drawCurrent=draw;search.addEventListener('input',()=>{filter=search.value.slice(0,200);draw();});idInput.addEventListener('input',()=>{newId=idInput.value;});
    body.append(button('添加模型价格',async()=>{const id=idInput.value.trim();if(!id||id.length>200||['__proto__','constructor','prototype','__replace__'].includes(id))throw Error('请输入合法模型 ID');catalogue.set(id,{id,names:[],vendors:['自定义']});filter='';search.value='';draw();try{await loadQuotes([id]);}catch(error){notice(`参考报价读取失败：${error.message}；输入保留。`);}}));
    async function loadQuotes(requested){
      const result=await request('GET','/api/model-prices',undefined,{models:JSON.stringify(requested)});if(ticket!==read||dialog!==root)return;
      for(const id of requested)quotes.set(id,{model:id,reference:null,current:null});for(const quote of result.quotes??[])quotes.set(quote.model,quote);
      // Metadata responses enhance existing nodes, never redraw a live input.
      for(const box of host.querySelectorAll('[data-model-row]')){const quote=quotes.get(box.dataset.modelRow);if(!quote)continue;text(box.querySelector('[data-price-reference]'),`目录参考（${quote.reference?.origin??'未提供'}）：${format(quote.reference)}`);text(box.querySelector('[data-price-effective]'),`当前有效计价（${quote.current?.source??'未提供'}）：${format(quote.current)}`);for(const input of box.querySelectorAll('[data-price]'))input.placeholder=quote.reference?.[input.dataset.price]==null?'':String(quote.reference[input.dataset.price]);}
    }
    const saveButton=button('保存',commit,'primary'),compareButton=button('处理冲突',compare),actions=node('div');saveButton.hidden=true;actions.className='actions';actions.append(saveButton,compareButton,button('完成',()=>root.close()));body.append(actions);
    async function commit(){
      if(saving||!loaded)return;const sent=new Map(),changes=[];let confirmed=0;
      try{for(const[id,row]of rows){if(!dirty(row))continue;const snap=row.draft.snapshot(number);sent.set(id,{snap,remove:row.remove});changes.push(row.remove?{id,remove:true,expectedRow:row.rowRevision}:{id,patch:snap.patch,expected:snap.expected});}if(!changes.length)return;
        saving=true;saveButton.disabled=true;notice('正在保存价格…');
        for(let offset=0;offset<changes.length;offset+=64){
          const batch=changes.slice(offset,offset+64),receipt=await request('PUT','/api/model-price-overrides',{changes:batch});
          for(const view of receipt.entries){const row=rows.get(view.id),own=sent.get(view.id);if(!row||!own)continue;row.draft.accept(own.snap,strings(view));row.rowRevision=view.rowRevision;if(own.remove&&!row.draft.pending.size)row.remove=false;}
          confirmed+=batch.length;uncachedPrevious=false;onSaved(receipt);notice(`已保存 ${confirmed}/${changes.length} 个模型，正在继续…`);
        }
        quotes.clear();if(dialog===root){comparison.replaceChildren();await loadQuotes([...sent.keys()]);notice('');}
      }catch(error){notice(error.message);return false;}finally{saving=false;saveButton.disabled=false;}
    }
    async function compare(){
      try{const latest=await request('GET','/api/model-price-overrides');if(dialog!==root)return;comparison.replaceChildren();const map=new Map(latest.entries.map(view=>[view.id,view]));
        for(const[id,row]of rows){if(!dirty(row))continue;const view=strings(map.get(id)??{...latest.empty,id});
          if(row.remove&&row.rowRevision!==view.rowRevision){const box=node('fieldset');box.dataset.priceConflict=id;box.append(node('legend',`${id} 整行已更新`),node('p','清除会同时删除服务器上的其他自定义价格元数据。'),button('保留草稿并确认清除最新整行',()=>{row.rowRevision=view.rowRevision;box.remove();notice('已确认新的整行版本，仍需再次保存。');}),button('采用服务器价格',()=>{row.draft=new TransactionDraft(view);row.remove=false;row.rowRevision=view.rowRevision;box.remove();draw();}));comparison.append(box);continue;}
          for(const[field]of row.draft.pending)if(row.draft.base.revisions[field]!==view.revisions[field]){const box=node('fieldset');box.dataset.priceConflict=`${id}:${field}`;box.append(node('legend',`${id} · ${field}`),node('p',`打开时：${row.draft.base.values[field]||'空白'}；服务器：${view.values[field]||'空白'}；草稿：${row.draft.value(field)||'空白'}`),button('保留我的值并采用新版本',()=>{row.draft.resolve(field,view,true);box.remove();notice('已确认新版本，仍需再次保存。');}),button('采用服务器值',()=>{row.draft.resolve(field,view,false);box.remove();draw();}));comparison.append(box);}
        }if(!comparison.childElementCount)notice('提交字段版本一致；未自动修改保存基线，可重试。');
      }catch(error){notice(`对比失败：${error.message}；草稿保留。`);}
    }
    try{
      const[feed,stored]=await Promise.all([request('GET','/api/model-prices'),request('GET','/api/model-price-overrides')]);if(disposed||ticket!==read||dialog!==root)return;
      empty=stored.empty;for(const view of stored.entries){const row=rows.get(view.id);if(!row||!dirty(row))rows.set(view.id,{draft:new TransactionDraft(strings(view)),remove:false,rowRevision:view.rowRevision});}
      for(const item of priceCatalogue(typeof providers==='function'?providers():providers,feed.prices,stored.entries))catalogue.set(item.id,item);
      loaded=true;draw();notice([...rows.values()].some(dirty)?'已恢复未保存草稿；服务器读取不会覆盖输入。':'目录已读取；尚无未保存改动。');
      const ids=[...catalogue.keys()];for(let index=0;index<ids.length;index+=128){await loadQuotes(ids.slice(index,index+128));if(ticket!==read||dialog!==root)return;}
    }catch(error){notice(`读取失败：${error.message}；已有草稿保留。`);}
    return root;
  }
  return{open,snapshot,restore,dispose(){disposed=true;++ticket;dialog?.close();},get dirty(){return[...rows.values()].some(dirty);}};
}
export async function editModelPrices(options){const editor=options.editor??createModelPriceEditor({...options,providers:()=>options.providers,beforeOpen:options.save});return editor.open();}
