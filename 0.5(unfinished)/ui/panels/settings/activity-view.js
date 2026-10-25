import {button,text} from '../ui.js';
import {groupCandidates,normalizeQQList} from './list-choice.js';
import {allChatsAllowed} from '../chat-access.js';
import {ActivityDraft} from './activity-draft.js';
import {createConditionalMotion} from './conditional-motion.js';
import {createAutoSave} from './auto-save.js';
let lastGroup='';
const number=(value,fallback)=>Number.isFinite(Number(value))&&value!=null?Math.max(0,Math.min(100,Math.round(Number(value)*100)/100)):fallback;
// Presentation follows the selected 0.5 wake policy's actual probability and
// 90% boundary; it does not replace the kernel response policy.
const tier=p=>p<=10?1:p<=20?2:p<90?3:4;
const summary=p=>tier(p)===3?`3 档 · ${Math.round((p-20)/70*100)}%`:`${tier(p)} 档 · ${['','仅艾特','+关键词','+随机','全响应'][tier(p)]}`;
const describe=p=>['','只有被 @ 时才响应，其余消息标记已读、<b>不调模型</b>（最省 token）','在 1 档基础上，<b>命中关键词</b>也响应',`被 @ / 命中关键词必响应；此外每批普通消息有 <b>${Math.round((p-20)/70*100)}%</b> 概率响应`,'任何消息都响应 —— <b>最费 token</b>'][tier(p)];

// This replaceable view owns only the card's unpublished Cancel/Save draft.
export function mountActivityView({read:baseRead,draft:retainedDraft,commit,onChange=()=>{},request,doc=document}){
  const visibility=createConditionalMotion(doc);
  const draft=retainedDraft||new ActivityDraft(baseRead);draft.read=baseRead;const read=path=>draft.value(path);
  const node=(tag,cls,value)=>{const el=doc.createElement(tag);el.className=cls;if(value!==undefined)el.textContent=value;return el;};
  const host=node('div','activity-editor'),wrap=node('div','activity-tier-wrap'),bar=node('div','activity-tier-bar'),readout=node('div','activity-readout'),big=node('span','activity-big'),note=node('span','activity-note'),target=node('div','activity-target');
  const groups=node('div','activity-group-area'),groupField=node('div','activity-group-field'),choices=node('div','activity-group-buttons'),clearRow=node('div','activity-clear-row');
  const groupViewport=node('div','activity-group-viewport');groupViewport.append(groups);
  readout.append(big,note);wrap.append(bar,readout,target);groupField.append(node('label','','未单独配置的群聊和私聊使用全局设置'),choices);groups.append(groupField,clearRow);host.append(wrap,groupViewport);
  for(const[left,width,label]of [[0,10,'@'],[10,10,'关键词'],[20,70,'按概率回复'],[90,10,'全部']]){const band=node('div','activity-tier-band',label);band.style.left=`${left}%`;band.style.width=`${width}%`;bar.append(band);}
  for(const left of [10,20,90]){const sep=node('div','activity-tier-sep');sep.style.left=`${left}%`;bar.append(sep);}
  const slider=(kind,label)=>{const el=node('div',`activity-position activity-position-${kind}`);el.setAttribute('role','slider');el.setAttribute('aria-label',label);el.setAttribute('aria-valuemin','0');el.setAttribute('aria-valuemax','100');el.tabIndex=0;bar.append(el);return el;};
  const normal=slider('normal','当前响应档位'),peak=slider('peak','高峰响应档位'),valley=slider('valley','低谷响应档位');
  const picks=new Map(),names=new Map(),toggles=new Map();let selected=lastGroup,disposed=false,dragging=null,headBadge=null;
  const globalPick=button('全局设置',()=>{selected=lastGroup='';refresh();});globalPick.dataset.activityGlobal='';
  let current={dual:false,disabled:false,normal:100,peak:10,valley:100};
  const footer=node('div','activity-footer'),status=node('span','activity-hint','改动先落在草稿里：「保存」整体提交，「取消」放弃未保存的改动。');status.setAttribute('role','status');
  const cancel=button('取消',()=>discard()),save=button('保存',async()=>{try{await flush();}catch{}},'primary');cancel.hidden=save.hidden=true;cancel.dataset.activityCancel='';save.dataset.activitySave='';status.hidden=true;footer.append(cancel,save,status);host.append(footer);
  const autoSave=createAutoSave({root:host,save:flush,dirty:()=>draft.dirty});
  const clear=button('清除所选群的单独设置',()=>{if(!selected||read('store.unifiedTier')!==false)return;for(const path of ['store.groupSliderPos','store.groupPeakPos']){const next={...(read(path)||{})};delete next[selected];draft.set(path,next);}changed();},'danger');clearRow.append(clear);
  function changed(){status.textContent='';status.classList.remove('field-error');refresh();onChange();autoSave.schedule();}
  function paint(){
    const{dual,disabled}=current,lo=dual?current.valley:current.normal,hi=current.peak;
    for(const[kind,el]of [['normal',normal],['peak',peak],['valley',valley]]){el.hidden=kind==='normal'?dual:!dual;el.style.left=`${current[kind]}%`;el.setAttribute('aria-valuenow',String(current[kind]));el.setAttribute('aria-disabled',String(disabled));el.tabIndex=disabled?-1:0;}
    bar.classList.toggle('is-dual',dual);bar.classList.toggle('is-disabled',disabled);
    text(big,dual&&tier(hi)!==tier(lo)?`峰 ${tier(hi)} 档 · 谷 ${tier(lo)} 档`:`${tier(lo)} 档`);
    // Only fixed local strings and bounded numbers enter this markup.
    note.innerHTML=dual?`高峰：${describe(hi)}<br>低谷：${describe(lo)}`:describe(lo);
    if(headBadge)text(headBadge,dual&&tier(hi)!==tier(lo)?`峰 ${summary(hi)} / 谷 ${summary(lo)}`:summary(lo));
  }
  function refresh(){
    if(disposed)return;
    const unified=read('store.unifiedTier')!==false,dual=read('store.peakSchedule.enabled')===true,map=read('store.groupSliderPos')||{},pairs=read('store.groupPeakPos')||{};
    const allowAll=allChatsAllowed({allow:baseRead('allow'),allowAllWhenEmpty:baseRead('allowAllWhenEmpty')},'group');
    const candidates=groupCandidates({allow:baseRead('allow.groups'),sliders:map,peaks:pairs,live:allowAll?[...names].map(([id,name])=>({id,name})):[]}).filter(item=>item.allowed||allowAll);
    if(selected&&!candidates.some(item=>item.id===selected))selected='';
    const group=unified?'':selected,pair=pairs[group]||{},globalPos=number(read('store.contextSliderPos'),100);
    if(!dragging){current={dual,disabled:false,normal:number(group?map[group]:globalPos,globalPos),peak:number(pair.peak??pair.peakPos,number(read('store.peakSchedule.peak.sliderPos'),10)),valley:number(pair.valley??pair.valleyPos,number(read('store.peakSchedule.valley.sliderPos'),100))};if(current.peak>current.valley)[current.peak,current.valley]=[current.valley,current.peak];}
    paint();text(target,group?`当前编辑：${names.get(group)||`群 ${group}`}`:(dual?'当前编辑：全局峰谷双点':'当前编辑：全局档位'));visibility.set(groups,!unified);
    for(const[path,input]of toggles)input.checked=path==='store.unifiedTier'?read(path)!==false:read(path)===true;
    lastGroup=selected;globalPick.setAttribute('aria-pressed',String(!selected));const wanted=[globalPick];
    for(const item of candidates){let pick=picks.get(item.id);if(!pick){pick=button('',()=>{selected=lastGroup=item.id;refresh();});pick.dataset.activityGroup=item.id;picks.set(item.id,pick);}
      pick.replaceChildren(doc.createTextNode(names.get(item.id)||item.name||`群 ${item.id}`));pick.title=item.id;pick.setAttribute('aria-pressed',String(selected===item.id));
      if(Object.hasOwn(map,item.id)||Object.hasOwn(pairs,item.id)){const dot=node('span','activity-own-dot');dot.title='该群有单独设置';pick.append(dot);}wanted.push(pick);}
    for(const child of [...choices.children])if(!wanted.includes(child))child.remove();wanted.forEach((child,index)=>{if(choices.children[index]!==child)choices.insertBefore(child,choices.children[index]||null);});
    clear.hidden=!group;clear.disabled=!group;cancel.disabled=save.disabled=!!draft.submitting;
  }
  function change(kind,value){
    if(current.disabled)return;const id=read('store.unifiedTier')!==false?'':selected;
    if(!id)draft.set(kind==='normal'?'store.contextSliderPos':`store.peakSchedule.${kind}.sliderPos`,value);
    else if(kind==='normal')draft.set('store.groupSliderPos',{...(read('store.groupSliderPos')||{}),[id]:value});
    else{const pairs=read('store.groupPeakPos')||{},pair={...pairs[id]};delete pair[`${kind}Pos`];pair[kind]=value;draft.set('store.groupPeakPos',{...pairs,[id]:pair});}changed();
  }
  function move(kind,value){value=number(value,0);if(kind==='peak')value=Math.min(value,current.valley);if(kind==='valley')value=Math.max(value,current.peak);current[kind]=value;paint();}
  const position=event=>{const rect=bar.getBoundingClientRect();return number((event.clientX-rect.left)/(rect.width||1)*100,0);};
  bar.addEventListener('pointerdown',event=>{if(current.disabled||dragging||event.button!==0)return;event.preventDefault();const value=position(event);dragging=current.dual?(Math.abs(value-current.valley)<=Math.abs(value-current.peak)?'valley':'peak'):'normal';bar.classList.add('is-dragging');bar.setPointerCapture(event.pointerId);move(dragging,value);});
  bar.addEventListener('pointermove',event=>{if(dragging)move(dragging,position(event));});
  const endDrag=()=>{if(!dragging)return;const kind=dragging;dragging=null;bar.classList.remove('is-dragging');const value=current[kind],snap={1:5,2:15,4:95}[tier(value)]??value;move(kind,snap);change(kind,current[kind]);};
  bar.addEventListener('pointerup',endDrag);bar.addEventListener('pointercancel',endDrag);bar.addEventListener('lostpointercapture',endDrag);
  for(const[kind,el]of [['normal',normal],['peak',peak],['valley',valley]])el.addEventListener('keydown',event=>{if(current.disabled)return;const value=current[kind],next={ArrowLeft:value-1,ArrowDown:value-1,ArrowRight:value+1,ArrowUp:value+1,PageDown:value-10,PageUp:value+10,Home:0,End:100}[event.key];if(next===undefined)return;event.preventDefault();move(kind,next);change(kind,current[kind]);});
  async function flush(){
    if(draft.submitting)return draft.submitting;if(!draft.dirty)return;const sent=draft.beginCommit();
    draft.submitting=(async()=>{try{await commit(draft.changes(sent));draft.accept(sent);status.textContent=draft.dirty?'此前改动已保存；当前草稿尚未保存。':'已保存';status.classList.remove('field-error');}catch(error){draft.reject();status.textContent=error.message;status.classList.add('field-error');throw error;}finally{draft.submitting=null;if(!disposed)refresh();onChange();}})();refresh();return draft.submitting;
  }
  function discard(sent){if(draft.submitting)return;draft.discard(sent);changed();}
  refresh();bar.classList.add('is-ready');
  void(async()=>{const result=await Promise.allSettled([request('GET','/api/chats'),request('GET','/api/onebot/groups')]);if(disposed)return;for(const item of result[0].status==='fulfilled'?result[0].value.chats||[]:[]){const key=item.chatKey||item.key?.replace('_',':');if(key?.startsWith('group:')&&item.chatName)names.set(key.slice(6),item.chatName);}if(result[1].status==='fulfilled')for(const item of normalizeQQList(result[1].value,'groups').items||[])names.set(String(item.id),item.name);refresh();})().catch(()=>{});
  return{host,draft,refresh,flush,discard,snapshot:()=>draft.snapshot(),get dirty(){return draft.dirty;},get version(){return draft.version;},
    bindHeader({badge,inputs}){headBadge=badge;for(const[path,input]of inputs){toggles.set(path,input);input.addEventListener('change',event=>{event.stopImmediatePropagation();draft.set(path,input.checked);changed();},true);}refresh();},
    dispose(){disposed=true;autoSave.dispose();visibility.dispose();picks.clear();names.clear();toggles.clear();},
  };
}
