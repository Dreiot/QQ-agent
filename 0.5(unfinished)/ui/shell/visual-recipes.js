import {elementPresetFamily,elementSizePresets,ELEMENT_SHAPES,presetPatch} from '../panels/visual-presets.js';
import {resolveVisualColor,normalizeVisualValue} from '../panels/visual-style.js';

export function renderVisualRecipes({doc,kind,theme,styles={},values={},apply,preview,cancel}){
  const node=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const host=node('div','quick-editor'),family=elementPresetFamily(kind);
  const matches=(item,keys)=>keys.every(key=>(styles[key]??null)===(normalizeVisualValue(key,item.styles[key])??null));
  function wire(button,patch,key,name){
    const show=()=>{caption.textContent='预览 · '+(name||button.textContent||button.title);caption.dataset.preview='true';preview(patch);},restore=()=>{caption.textContent=currentName;delete caption.dataset.preview;cancel();};
    button.addEventListener('pointerenter',show);button.addEventListener('pointerleave',restore);button.addEventListener('focus',show);button.addEventListener('blur',restore);button.addEventListener('click',()=>apply(patch,key));
  }
  const currentName=family.items.find(item=>matches(item,family.keys))?.label||(family.keys.some(key=>styles[key]!==undefined)?'自定义':'跟随主题'),caption=node('span','recipe-status',currentName);
  const heading=node('div','quick-heading');heading.append(node('strong','','挑个样式'),caption);const reset=node('button','quick-reset','↺');reset.type='button';reset.setAttribute('aria-label','恢复跟随主题样式');reset.title='跟随主题';reset.addEventListener('click',()=>apply(Object.fromEntries(family.keys.map(key=>[key,null])),'finish-reset'));heading.append(reset);host.append(heading);
  const grid=node('div','recipe-grid');grid.setAttribute('role','radiogroup');grid.setAttribute('aria-label','元素样式');
  grid.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;const cards=[...grid.querySelectorAll('.recipe')].filter(n=>n.getClientRects().length),current=cards.indexOf(event.target.closest('.recipe'));if(current<0)return;event.preventDefault();const delta=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:event.key==='ArrowUp'?-2:2;cards[(current+delta+cards.length)%cards.length]?.focus();});
  for(const item of family.items){
    const button=node('button','recipe');button.type='button';button.dataset.preset=item.id;button.setAttribute('role','radio');button.setAttribute('aria-label',`${item.label}样式`);button.setAttribute('aria-checked',String(matches(item,family.keys)));
    const canvas=node('span','recipe-canvas'),sample=node('span',`recipe-sample ${family.text?'sample-text':family.icon?'sample-icon':family.image?'sample-image':family.surface?'sample-card':'sample-button'}`);
    sample.textContent=family.text?'Aa 你好':family.icon?'✧':family.image?'◩':family.surface?'卡片':'按钮';
    for(const [key,value]of Object.entries(item.styles))sample.style[key]=resolveVisualColor(value,theme);
    if(family.icon)sample.style.fontWeight=String(Math.min(900,Number.parseFloat(item.styles.strokeWidth||'2')*250));
    if(family.surface){sample.replaceChildren(node('span','sample-line'),node('span','sample-line short'));}
    canvas.style.background=theme.bg||'#202120';canvas.append(sample);button.append(canvas,node('span','recipe-label',item.label));
    const tick=node('span','recipe-tick','✓');tick.setAttribute('aria-hidden','true');button.append(tick);wire(button,presetPatch(item,family.keys),'finish-'+item.id,item.label);grid.append(button);
  }
  if(family.items.length>4){grid.dataset.expanded='false';const more=node('button','recipe-more','更多样式');more.type='button';more.setAttribute('aria-expanded','false');more.addEventListener('click',()=>{const open=grid.dataset.expanded!=='true';grid.dataset.expanded=String(open);more.setAttribute('aria-expanded',String(open));more.textContent=open?'收起样式':'更多样式';});host.append(grid,more);}else host.append(grid);
  function choices(title,items,key){
    const section=node('section','quick-facet'),label=node('strong','',title),row=node('div','facet-choices');row.setAttribute('role','radiogroup');row.setAttribute('aria-label',title);
    const keys=[...new Set(items.flatMap(item=>Object.keys(item.styles)))];
    for(const item of items){const b=node('button','',item.label);b.type='button';b.setAttribute('role','radio');b.setAttribute('aria-checked',String(matches(item,keys)));b.dataset.facet=item.id;wire(b,presetPatch(item,keys),key+'-'+item.id);row.append(b);}section.append(label,row);host.append(section);
  }
  choices(family.surface?'留白':'大小',elementSizePresets(kind),'size');
  if(!family.text&&!family.icon)choices('圆润',ELEMENT_SHAPES,'shape');
  const colorKey=family.text||family.icon?'color':'backgroundColor',colorRow=node('div','quick-color'),label=node('label','','颜色'),input=node('input');input.type='color';input.setAttribute('aria-label','常用颜色');input.id='visual-quick-color';label.htmlFor=input.id;
  const current=resolveVisualColor(styles[colorKey]||values[colorKey]||(family.surface?'theme:surface':'theme:accent'),theme);let shown=current;
  const rgb=/^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(shown||'');if(rgb)shown='#'+rgb.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join('');if(/^#[\da-f]{8}$/i.test(shown||''))shown=shown.slice(0,7);input.value=/^#[\da-f]{6}$/i.test(shown||'')?shown:'#808080';
  input.addEventListener('input',()=>apply({[colorKey]:input.value},'quick-color',false));colorRow.append(label,input);
  for(const token of ['accent','surface2','text','good']){const chip=node('button','color-chip');chip.type='button';chip.title={accent:'强调色',surface2:'表面色',text:'文字色',good:'绿色'}[token];chip.setAttribute('aria-label',`使用${chip.title}`);chip.style.background=resolveVisualColor('theme:'+token,theme);wire(chip,{[colorKey]:'theme:'+token},'color-'+token);colorRow.append(chip);}host.append(colorRow);
  return host;
}
