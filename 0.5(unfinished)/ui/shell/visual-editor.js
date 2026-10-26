import {migrateUikit,resolveScheme,getCurrentTheme} from '../panels/theme.js';
import {VISUAL_KINDS,VISUAL_PROPERTIES,VISUAL_GROUPS,VISUAL_STATES,normalizeVisual,normalizeVisualValue,validVisualSelector,resolveVisualColor} from '../panels/visual-style.js';
import {createVisualPicker} from '../panels/visual-picker.js';
import {renderVisualRecipes} from './visual-recipes.js';
import {mountFontPicker} from '../panels/local-fonts.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const labels={left:'左',right:'右',center:'居中',justify:'两端',none:'无',solid:'实线',dashed:'虚线',dotted:'点线',block:'纵向',flex:'弹性排列',grid:'网格','inline-flex':'行内弹性','inline-block':'行内块',row:'横排',column:'竖排','row-reverse':'反向横排','column-reverse':'反向竖排',nowrap:'不换行',wrap:'换行','flex-start':'起点','flex-end':'终点','space-between':'两端分布','space-around':'周围留白','space-evenly':'均匀分布',stretch:'拉伸',baseline:'基线',visible:'显示',hidden:'隐藏',auto:'自动',scroll:'滚动'};
const hex=value=>{if(/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value||''))return value.slice(0,7);if(/^#[\da-f]{3,4}$/i.test(value||''))return'#'+[...value.slice(1,4)].map(c=>c+c).join('');const m=/^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value||'');return m?'#'+m.slice(1).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):'#808080';};
Object.assign(labels,{contain:'完整显示',cover:'铺满裁切',fill:'拉伸','scale-down':'缩小适配',normal:'自动换行','pre-wrap':'保留换行',uppercase:'大写',lowercase:'小写',capitalize:'首字母大写','border-box':'含内边距与边框','content-box':'仅内容'});
const alpha=value=>{if(value==='transparent')return 0;if(/^#[\da-f]{8}$/i.test(value||''))return Math.round(parseInt(value.slice(7),16)/255*100);const match=/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(value||'');return match?Math.round(Number(match[1])*100):100;};
export function createVisualEditor({doc=document,api,registry,notify=()=>{},navigate=()=>{},getPanel=()=>null}={}){
  let host=null,root=null,active=false,closing=false,picking=true,selection=null,scope='element',state='base',visual={rules:[]},slot='dark',revision=0,savedRevision=0,timer=null,inflight=null,error='',history=[],future=[],lastHistoryKey='',lastHistoryAt=0;
  const picker=createVisualPicker(doc,{select:payload=>receive(payload,'shell')});
  const ui={};
  let opening=null,openEpoch=0,disposed=false;
  let activationFrame=null,activationMode=null,activationTicket=null,activationTimer=null;
  let previewVisual=null,previewFrame=0,freshSelection=false;
  const el=(tag,className,text)=>{const n=doc.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
  const action=(label,fn,cls='')=>{const b=el('button',cls,label);b.type='button';b.addEventListener('click',()=>{Promise.resolve().then(fn).catch(showError);});return b;};
  const eventState=()=>({active,picking,state,page:selection?.page||null,ticket:activationTicket});
  function activateFrame(){
    const frame=registry.current?.frame;
    if(!active){clearTimeout(activationTimer);if(activationFrame)activationFrame.inert=false;activationFrame=null;activationMode=null;activationTicket=null;return;}
    if(!frame||activationFrame===frame&&activationMode===picking)return;
    clearTimeout(activationTimer);if(activationFrame)activationFrame.inert=false;activationFrame=frame;activationMode=picking;activationTicket=crypto.randomUUID();frame.inert=true;
    activationTimer=setTimeout(()=>{if(active&&activationTicket){notify('页面还未准备好，请重新打开点选编辑','error');void close().catch(showError);}},4000);
  }
  function broadcast(command){activateFrame();picker.set(active&&picking);picker.preview?.(selection?.page==='shell'?state:null);registry.emit('visual-editor',{...eventState(),...(command?{command}:{})});}
  function status(){if(!ui.status)return;ui.status.textContent=error?'保存失败 · 点击重试':revision!==savedRevision?'正在保存…':'已自动保存';ui.status.dataset.error=String(!!error);ui.status.disabled=!error;ui.count.textContent=`已有样式 · ${visual.rules.length}`;ui.undo.disabled=!history.length;ui.redo.disabled=!future.length;}
  function showError(e){status();notify(String(e?.message||e),'error');}
  function paint(){if(active)registry.applyVisualEverywhere(previewVisual||visual);}
  function stopPreview(){if(previewFrame)doc.defaultView.cancelAnimationFrame(previewFrame);previewFrame=0;if(previewVisual){previewVisual=null;paint();}}
  function makePatch(snapshot){
    const tokens={visual:snapshot};return{ui:{uikit:slot.startsWith('custom:')?{custom:{[slot.slice(7)]:{tokens}}}:{[slot]:tokens}}};
  }
  async function flush(){
    clearTimeout(timer);timer=null;if(inflight){await inflight;if(revision!==savedRevision)return flush();return;}
    if(revision===savedRevision)return;
    const captured=revision,snapshot=copy(visual);error='';status();
    inflight=api.post('/api/config',makePatch(snapshot)).then(()=>{savedRevision=captured;error='';if(revision===savedRevision)notify('外观已保存');}).catch(e=>{error=String(e.message||e);throw e;}).finally(()=>{inflight=null;status();});
    await inflight;if(revision!==savedRevision)return flush();
  }
  function changed(key){
    revision++;error='';paint();status();clearTimeout(timer);timer=setTimeout(()=>{void flush().catch(showError);},500);
  }
  function remember(key){
    const now=Date.now();if(key!==lastHistoryKey||now-lastHistoryAt>650){history.push(copy(visual));if(history.length>50)history.shift();}lastHistoryKey=key;lastHistoryAt=now;future=[];
  }
  function target(){if(!selection)return null;return{page:scope==='all'?'*':selection.page,selector:scope==='element'?selection.selector:selection.family||VISUAL_KINDS[selection.kind].selector,state,kind:selection.kind};}
  function find(){const t=target();return t?visual.rules.find(r=>r.page===t.page&&r.selector===t.selector&&r.state===t.state):null;}
  function withPatch(patch){
    const t=target();if(!t)return visual;const next=copy(visual);let rule=next.rules.find(r=>r.page===t.page&&r.selector===t.selector&&r.state===t.state);
    if(!rule){if(!Object.values(patch).some(value=>value!==null))return next;if(next.rules.length>=400)throw Error('已有 400 条样式，请先移除不再使用的样式');rule={...t,id:'v'+crypto.randomUUID(),styles:{}};next.rules.push(rule);}
    for(const [key,value]of Object.entries(patch)){if(value===null)delete rule.styles[key];else{const valid=normalizeVisualValue(key,value);if(valid===null)throw Error('样式数值无效');rule.styles[key]=valid;}}
    if(!Object.keys(rule.styles).length)next.rules=next.rules.filter(r=>r!==rule);return next;
  }
  function applyRecipe(patch,key,rebuild=true){stopPreview();const next=withPatch(patch);if(JSON.stringify(normalizeVisual(next))===JSON.stringify(normalizeVisual(visual)))return;const t=target();remember(`recipe-${key}:${t.page}:${t.selector}:${t.state}`);visual=next;changed(key);if(rebuild)renderSelection();else for(const button of root.querySelectorAll('.recipe[aria-checked=true]'))button.setAttribute('aria-checked','false');}
  function previewRecipe(patch){if(previewFrame)doc.defaultView.cancelAnimationFrame(previewFrame);previewFrame=doc.defaultView.requestAnimationFrame(()=>{previewFrame=0;try{previewVisual=withPatch(patch);paint();}catch(error){showError(error);}});}
  function change(key,value){
    stopPreview();
    const t=target();if(!t)return;const valid=normalizeVisualValue(key,value);if(value!==''&&value!==null&&valid===null)return;
    const existing=find();if(!existing&&valid===null)return;if(!existing&&visual.rules.length>=400)throw Error('已有 400 条样式，请先移除不再使用的样式');
    remember(`${t.page}:${t.selector}:${state}:${key}`);
    let rule=existing;if(!rule){rule={...t,id:'v'+crypto.randomUUID(),styles:{}};visual.rules.push(rule);}
    if(valid===null)delete rule.styles[key];else rule.styles[key]=valid;
    if(!Object.keys(rule.styles).length)visual.rules=visual.rules.filter(r=>r!==rule);
    changed(key);root?.querySelector(`[data-property="${key}"]`)?.classList.toggle('modified',valid!==null);
  }
  function receive(payload,page){
    if(!active)return{ok:false};if(payload?.exit)return close();if(payload?.pause){picking=false;broadcast();renderSelection();return{ok:true};}
    if(payload?.ack){if(payload.ack===activationTicket&&page===registry.current?.id){clearTimeout(activationTimer);if(activationFrame)activationFrame.inert=false;if(host){const opening=host.style.visibility==='hidden';host.style.visibility='';if(opening)ui.pick.focus();}}return{ok:true};}
    if(payload?.resize){
      if(!selection||selection.page!==page||selection.selector!==payload.selector)return{ok:false};
      const width=normalizeVisualValue('width',payload.resize.width),height=normalizeVisualValue('height',payload.resize.height);if(!width||!height)return{ok:false};
      const rebuild=scope!=='element'||state!=='base';scope='element';state='base';const t=target();remember('resize');let rule=find();if(!rule){if(visual.rules.length>=400)throw Error('样式数量已达上限');rule={...t,id:'v'+crypto.randomUUID(),styles:{}};visual.rules.push(rule);}Object.assign(rule.styles,{width,height,boxSizing:'border-box'});changed('resize');broadcast();if(rebuild)renderSelection();else for(const [key,value]of Object.entries({width,height})){const input=root.querySelector('#visual-property-'+key);if(input){input.value=String(parseFloat(value));input.closest('.property').classList.add('modified');}}return{ok:true};
    }
    if(!validVisualSelector(payload?.selector)||!Object.hasOwn(VISUAL_KINDS,payload?.kind))throw Error('无法选取此元素');
    const values={};for(const [key,value]of Object.entries(payload.values||{})){const valid=normalizeVisualValue(key,value);if(valid!==null)values[key]=valid;}
    stopPreview();selection={page,selector:payload.selector,kind:payload.kind,values,...(validVisualSelector(payload.family)?{family:payload.family}:{})};scope='element';state='base';freshSelection=true;broadcast();renderSelection();return{ok:true};
  }
  function renderSelection(){
    if(!ui.body)return;stopPreview();const body=ui.body,scroll=freshSelection?0:body.scrollTop,advancedWasOpen=!freshSelection&&body.querySelector('.visual-advanced')?.open,previousGroups=new Set(!freshSelection?[...body.querySelectorAll('details.group[open]')].map(n=>n.querySelector(':scope>summary').textContent):[]);freshSelection=false;body.replaceChildren();
    ui.pick.textContent=picking?'点选中':'浏览页面';ui.pick.setAttribute('aria-pressed',String(picking));ui.pick.classList.toggle('primary',picking);
    if(!selection){body.append(el('div','empty','点击页面中的按钮、文字或内容框'),el('p','hint','Shift 精确点选图标或文字；Alt 操作页面；Esc 暂停点选。'));return;}
    const title=el('div','target-title'),name=el('strong','',VISUAL_KINDS[selection.kind].label),parent=action('外层',()=>{if(selection.page==='shell')picker.parent();else broadcast('parent');},'small');parent.title='选择外层元素';title.append(name,el('span','chip',selection.page==='shell'?'工作台':registry.list().find(p=>p.id===selection.page)?.title||selection.page),parent);body.append(title);
    const scopeFold=el('details','scope-options'),scopeTitle=el('summary','',{element:'仅此元素',page:'本页同类',all:'所有页面同类'}[scope]),scopes=el('div','segments');scopes.setAttribute('role','radiogroup');scopes.setAttribute('aria-label','修改范围');for(const [value,label]of [['element','仅此元素'],['page','本页同类'],['all','所有同类']]){const b=action(label,()=>{scope=value;renderSelection();});b.setAttribute('role','radio');b.setAttribute('aria-checked',String(scope===value));scopes.append(b);}scopeFold.append(scopeTitle,scopes);body.append(scopeFold);
    body.append(renderVisualRecipes({doc,kind:selection.kind,theme:getCurrentTheme(),styles:find()?.styles||{},values:selection.values,apply:(patch,key,rebuild)=>{try{applyRecipe(patch,key,rebuild);}catch(error){showError(error);}},preview:previewRecipe,cancel:stopPreview}));
    const advanced=el('details','visual-advanced'),advancedTitle=el('summary','',state==='base'?'精细调整':`精细调整 · ${VISUAL_STATES[state]}`);advanced.append(advancedTitle);let built=false;
    const buildFine=()=>{if(built)return;built=true;const states=el('div','states');states.setAttribute('aria-label','预览交互状态');for(const [value,label]of Object.entries(VISUAL_STATES)){const b=action(label,()=>{state=value;broadcast();renderSelection();});b.setAttribute('aria-pressed',String(state===value));states.append(b);}advanced.append(states);const controls=el('div','properties');for(const [index,group]of VISUAL_GROUPS.entries()){const fold=el('details','group');fold.open=previousGroups.size?previousGroups.has(group.label):index===0||index===1;const heading=el('summary','',group.label),fields=el('div','fields');if(['内边距','外边距'].includes(group.label))fields.classList.add('box-fields');for(const key of group.keys)fields.append(property(key));fold.append(heading,fields);controls.append(fold);}advanced.append(controls);};
    advanced.addEventListener('toggle',()=>{if(advanced.open)buildFine();});if(advancedWasOpen){advanced.open=true;buildFine();}body.append(advanced);
    const tail=el('div','target-actions');tail.append(action('恢复当前范围',()=>{const existing=find();if(!existing)return;remember('reset');visual.rules=visual.rules.filter(r=>r!==existing);changed('reset');renderSelection();}));body.append(tail);
    const info=el('details','selector-info');info.append(el('summary','','定位信息'),el('code','',selection.selector),el('p','hint','动态列表的顺序可能变化；调整列表项时优先使用“本页同类”。'));body.append(info);
    body.scrollTop=scroll;
  }
  function renderRules(){
    ui.body.replaceChildren();const head=el('div','target-title');head.append(el('strong','','已有样式'),action('返回点选',()=>{picking=true;broadcast();renderSelection();},'small'));ui.body.append(head);
    if(!visual.rules.length){ui.body.append(el('p','hint','还没有单独设置的元素。'));return;}
    const list=el('div','rule-list');
    for(const rule of visual.rules){
      const row=el('article','rule-row'),name=`${VISUAL_KINDS[rule.kind].label} · ${VISUAL_STATES[rule.state]}`,page=rule.page==='*'?'所有页面':rule.page==='shell'?'工作台':registry.list().find(p=>p.id===rule.page)?.title||rule.page;
      const info=el('div');info.append(el('strong','',name),el('small','',`${page} · ${Object.keys(rule.styles).length} 项调整`));row.append(info);
      row.append(action('调整',async()=>{if(rule.page!=='*'&&rule.page!=='shell'&&rule.page!==getPanel()){await flush();await navigate(rule.page);}selection={page:rule.page==='*'?getPanel()||'settings':rule.page,selector:rule.selector,kind:rule.kind,family:rule.selector,values:{}};scope=rule.page==='*'?'all':Object.values(VISUAL_KINDS).some(k=>k.selector===rule.selector)?'page':'element';state=rule.state;renderSelection();}),action('移除',()=>{remember('delete-rule');visual.rules=visual.rules.filter(r=>r!==rule);changed('delete-rule');renderRules();}));list.append(row);
    }
    ui.body.append(list,action('恢复全部元素样式',()=>{remember('reset-all');visual={rules:[]};changed('reset-all');renderRules();}));
  }
  function property(key){
    const spec=VISUAL_PROPERTIES[key],row=el('div','property'),head=el('div','property-head'),label=el('label','',spec.label),reset=action('↺',()=>{change(key,null);renderSelection();},'reset');row.dataset.property=key;reset.setAttribute('aria-label',`恢复${spec.label}`);const id='visual-property-'+key;label.htmlFor=id;head.append(label,reset);row.append(head);
    const own=find()?.styles[key],inherited=selection.values[key]||'',value=own===undefined?'':resolveVisualColor(own,getCurrentTheme()),line=el('div','value');row.classList.toggle('modified',own!==undefined);
    let input;
    if(spec.type==='color'){
      const swatch=el('input','swatch'),opacity=el('input','color-alpha');swatch.type='color';swatch.value=hex(value||inherited);swatch.setAttribute('aria-label',`${spec.label}取色`);input=el('input','hex');input.type='text';input.value=value;input.placeholder=inherited||'跟随主题';opacity.type='number';opacity.min='0';opacity.max='100';opacity.step='1';opacity.value=String(alpha(value||inherited));opacity.setAttribute('aria-label',`${spec.label}不透明度`);
      const pick=()=>{const n=Number(opacity.value);if(opacity.value===''||n<0||n>100)return;const next=swatch.value+(n===100?'':Math.round(n/100*255).toString(16).padStart(2,'0'));input.value=next;input.removeAttribute('aria-invalid');change(key,next);};
      swatch.addEventListener('input',pick);opacity.addEventListener('input',pick);input.addEventListener('input',()=>{const ok=!input.value||normalizeVisualValue(key,input.value)!==null;input.setAttribute('aria-invalid',String(!ok));if(ok){change(key,input.value);swatch.value=hex(input.value||inherited);opacity.value=String(alpha(input.value||inherited));}});line.append(swatch,input,opacity,el('span','unit','%'));
    }else if(spec.type==='font'){
      input=el('input');input.value=value;input.placeholder=inherited||'选择本机字体';const picker=mountFontPicker({doc,input,stack:true,request:(_method,url)=>api.get(url),onChange:next=>{const valid=!next||normalizeVisualValue(key,next)!==null;input.setAttribute('aria-invalid',String(!valid));if(valid)change(key,next);}});line.append(picker.element);
    }else if(spec.type==='select'||spec.type==='columns'||spec.type==='shadow'){
      input=el('select');const automatic=el('option','','跟随主题');automatic.value='';input.append(automatic);
      const choices=spec.type==='font'?[['system-ui, sans-serif','系统无衬线'],['Georgia, serif','衬线'],['ui-monospace, monospace','等宽']]:spec.type==='columns'?Array.from({length:8},(_,i)=>[`repeat(${i+1}, minmax(0, 1fr))`,`${i+1} 列`]):spec.type==='shadow'?[['none','无'],['0px 4px 16px rgba(0,0,0,0.16)','轻'],['0px 8px 28px rgba(0,0,0,0.28)','中'],['0px 16px 48px rgba(0,0,0,0.4)','深']]:spec.options.map(v=>[v,labels[v]||v]);
      if(value&&!choices.some(([v])=>v===value))choices.unshift([value,value]);for(const [v,name]of choices){const option=el('option','',name);option.value=v;input.append(option);}input.value=value;input.addEventListener('change',()=>change(key,input.value));line.append(input);
    }else{
      input=el('input');input.type='number';input.min=String(spec.min);input.max=String(spec.max);input.step=String(spec.step);const dimension=/width|height/i.test(key);const raw=/^(-?[\d.]+)(.*)$/.exec(value),fallback=/^(-?[\d.]+)/.exec(inherited);input.value=raw?.[1]||'';input.placeholder=fallback?.[1]||'自动';
      let unit=spec.unit;const suffix=dimension?el('select','unit'):el('span','unit',unit);if(dimension){for(const v of ['px','%','vw','vh']){const option=el('option','',v);option.value=v;suffix.append(option);}suffix.value=raw?.[2]||spec.unit;unit=suffix.value;suffix.setAttribute('aria-label',`${spec.label}单位`);suffix.addEventListener('change',()=>{unit=suffix.value;apply();});}
      const apply=()=>{const next=input.value===''?'':input.value+unit,ok=!next||normalizeVisualValue(key,next)!==null;input.setAttribute('aria-invalid',String(!ok));if(ok)change(key,next);};input.addEventListener('input',apply);line.append(input,suffix);
      if(key==='opacity'){const range=el('input','opacity-range');range.type='range';range.min='0';range.max='1';range.step='.05';range.value=String(Number(value||inherited||1));range.setAttribute('aria-label','透明度滑条');range.addEventListener('input',()=>{input.value=range.value;apply();});line.prepend(range);}
    }
    input.id=id;input.setAttribute('aria-label',`${spec.label}值`);row.append(line);
    if(spec.type==='shadow'){
      row.classList.add('full');const advanced=el('details','shadow-fine'),fields=el('div','shadow-fields');advanced.append(el('summary','','细调阴影'));
      const match=/^(-?\d+)px (-?\d+)px (\d+)px(?: (-?\d+)px)? (.+)$/.exec(value),parts=[Number(match?.[1]||0),Number(match?.[2]||4),Number(match?.[3]||16),Number(match?.[4]||0)];const values=[];
      const ink=el('input');ink.type='color';ink.value=hex(match?.[5]||'#000000');ink.setAttribute('aria-label','阴影颜色');
      const amount=el('input');amount.type='number';amount.min='0';amount.max='100';amount.value=String(alpha(match?.[5]||'rgba(0,0,0,.25)'));amount.setAttribute('aria-label','阴影不透明度');
      const update=()=>{if(values.some(n=>n.value===''||!n.checkValidity())||amount.value===''||!amount.checkValidity())return;const next=values.map(n=>`${Number(n.value)}px`).join(' ')+' '+ink.value+Math.round(Number(amount.value)/100*255).toString(16).padStart(2,'0');change(key,next);};
      for(const [i,name]of ['横移','下移','柔化','扩张'].entries()){const wrap=el('label','',name),number=el('input');number.type='number';number.min=String(i===2?0:-160);number.max='160';number.value=String(parts[i]);number.setAttribute('aria-label',`阴影${name}`);number.addEventListener('input',update);values.push(number);wrap.append(number);fields.append(wrap);}ink.addEventListener('input',update);amount.addEventListener('input',update);const colors=el('div','shadow-colors');colors.append(ink,amount,el('span','unit','%'));fields.append(colors);advanced.append(fields);row.append(advanced);
    }
    return row;
  }
  function historyMove(from,to){if(!from.length)return;stopPreview();to.push(copy(visual));visual=from.pop();lastHistoryKey='';changed('history');renderSelection();}
  function build(){
    host=el('aside');host.id='visual-editor';host.dataset.visualOwned='true';host.style.visibility='hidden';root=host.attachShadow({mode:'open'});const css=el('link');css.rel='stylesheet';css.href=new URL('./visual-editor.css',import.meta.url).href;root.append(css);
    const panel=el('section','editor');panel.setAttribute('aria-label','外观点选编辑器');const header=el('header'),top=el('div','heading');top.append(el('h2','','外观编辑'),action('完成',close,'finish'));header.append(top,el('p','hint','点选 → 调整 → 自动保存'));
    const nav=el('div','editor-nav'),pages=el('select');pages.setAttribute('aria-label','切换预览页面');for(const p of registry.list().filter(p=>p.kind==='bundled')){const option=el('option','',p.title);option.value=p.id;pages.append(option);}pages.value=getPanel()||'settings';pages.addEventListener('change',async()=>{try{await flush();selection=null;picking=false;broadcast();await navigate(pages.value);renderSelection();}catch(e){showError(e);}});
    ui.pick=action('点选中',()=>{picking=!picking;broadcast();renderSelection();},'primary');nav.append(pages,ui.pick);header.append(nav);
    const tools=el('div','tools');ui.undo=action('↶',()=>historyMove(history,future));ui.undo.setAttribute('aria-label','撤销元素样式');ui.redo=action('↷',()=>historyMove(future,history));ui.redo.setAttribute('aria-label','重做元素样式');ui.count=action('',renderRules,'count');ui.count.setAttribute('aria-label','管理已有元素样式');tools.append(ui.undo,ui.redo,ui.count);header.append(tools);
    ui.body=el('div','editor-body');const footer=el('footer');ui.status=action('已自动保存',flush,'save-status');ui.status.setAttribute('role','status');footer.append(ui.status);
    const files=el('div','file-tools'),file=el('input');file.type='file';file.accept='.json,application/json';file.hidden=true;file.setAttribute('aria-label','导入元素样式文件');
    files.append(action('导出样式',()=>{const blob=new Blob([JSON.stringify({format:'qqa-visual-v1',visual},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='QQA-appearance.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}),action('导入样式',()=>file.click()),file);footer.append(files);
    file.addEventListener('change',async()=>{
      const epoch=openEpoch;
      try{
        const f=file.files?.[0];if(!f)return;if(f.size>256*1024)throw Error('样式文件不能超过 256 KB');
        const raw=await f.text();if(disposed||!active||epoch!==openEpoch)return;
        const data=JSON.parse(raw);if(data.format!=='qqa-visual-v1'||!Array.isArray(data.visual?.rules))throw Error('请选择 QQA 导出的元素样式');if(data.visual.rules.length>400)throw Error('样式文件超过 400 条，请先精简');
        const imported=normalizeVisual(data.visual);if(imported.rules.length!==data.visual.rules.length)throw Error('样式文件包含无法识别的规则，未应用');remember('import');visual=imported;changed('import');renderSelection();
      }catch(e){showError(e);}finally{file.value='';}
    });
    panel.append(header,ui.body,footer);root.append(panel);doc.body.append(host);doc.body.dataset.visualEditor='true';
    const layout=el('style');layout.dataset.visualOwned='true';layout.textContent='body[data-visual-editor="true"]>.app-shell{width:calc(100% - 352px)!important} @media(max-width:800px){body[data-visual-editor="true"]>.app-shell{width:100%!important;height:55dvh!important}}';host.append(layout);
  }
  async function open(){
    if(active){ui.pick.focus();return{ok:true};}if(opening)return opening;const epoch=++openEpoch;
    opening=(async()=>{const config=await api.get('/api/config');if(disposed||epoch!==openEpoch)return{ok:false};const store=migrateUikit(config.ui?.uikit);slot=store.mode;if(!['dark','light'].includes(slot)&&!(/^custom:[\w-]{1,64}$/.test(slot)&&Object.hasOwn(store.custom,slot.slice(7))))slot='dark';visual=normalizeVisual(resolveScheme(config.ui?.uikit).visual);revision=savedRevision=0;history=[];future=[];error='';selection=null;active=true;closing=false;picking=true;scope='element';state='base';build();renderSelection();status();broadcast();ui.pick.focus();return{ok:true};})();
    try{return await opening;}finally{opening=null;}
  }
  async function close(){++openEpoch;stopPreview();closing=true;try{await flush();}catch(error){closing=false;throw error;}active=false;closing=false;broadcast();picker.set(false);host?.remove();host=root=null;delete doc.body.dataset.visualEditor;return{ok:true};}
  const keyboard=event=>{if(!active)return;if(event.key==='Escape'){event.preventDefault();if(picking){picking=false;broadcast();renderSelection();}else void close().catch(showError);}};doc.addEventListener('keydown',keyboard);
  const unload=event=>{if(active&&revision!==savedRevision){event.preventDefault();event.returnValue='';}};doc.defaultView.addEventListener('beforeunload',unload);
  return{open,close,flush,get active(){return active;},getState:eventState,
    receive:(payload,page)=>receive(payload,page),
    handle(method,payload,page){if(method==='appearance.open')return open();if(method==='appearance.select')return receive(payload,page);if(method==='appearance.ready'&&active){activateFrame();const chooser=root.querySelector('[aria-label="切换预览页面"]');if(chooser)chooser.value=page;if(selection&&selection.page!=='shell'&&selection.page!==page){selection=null;renderSelection();}return;}return{ok:false};},
    mergeTheme(theme){return active&&!closing?{...theme,visual:previewVisual||visual}:theme;},
    configChanged(config){if(!active)return;if(migrateUikit(config.ui?.uikit).mode!==slot){void close().catch(showError);return;}if(revision===savedRevision&&!inflight){const incoming=normalizeVisual(resolveScheme(config.ui?.uikit).visual);if(JSON.stringify(incoming)!==JSON.stringify(normalizeVisual(visual))){visual=incoming;history=[];future=[];selection=null;renderSelection();status();}}},
    dispose(){disposed=true;++openEpoch;clearTimeout(timer);stopPreview();active=false;activateFrame();picker.dispose();doc.removeEventListener('keydown',keyboard);doc.defaultView.removeEventListener('beforeunload',unload);host?.remove();delete doc.body.dataset.visualEditor;}
  };
}
