// Structured appearance overrides. No CSS text, URLs, scripts or content values.
export const VISUAL_KINDS = Object.freeze({
  button:{label:'按钮',selector:'button'}, input:{label:'输入框',selector:'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"])'},
  textarea:{label:'多行输入',selector:'textarea'},select:{label:'选择框',selector:'select'},
  choice:{label:'勾选与单选',selector:'input[type="checkbox"],input[type="radio"]'},
  switch:{label:'卡片开关',selector:'.is-switch,.personalization-toggle,.choice-toggle,[role="switch"]'},
  range:{label:'滑条',selector:'input[type="range"]'},card:{label:'卡片',selector:'.card,.settings-card,.session-card,.extension-card'},
  heading:{label:'标题',selector:'h1,h2,h3,h4,h5,h6'},text:{label:'文字',selector:'p,small,label,span,.muted'},
  navigation:{label:'导航项',selector:'#nav button,.settings-sidebar a'},dialog:{label:'弹窗',selector:'dialog'},
  table:{label:'表格',selector:'table'},row:{label:'表格行',selector:'tr'},list:{label:'列表',selector:'.list,.settings-list'},
  icon:{label:'图标',selector:'svg.qq-icon,svg.theme-icon'},image:{label:'图片',selector:'img'},container:{label:'内容框',selector:'section,article'}
});
const number=(label,min,max,unit='px',step=1)=>({label,type:'number',min,max,unit,step});
const options=(label,values)=>({label,type:'select',options:values});
export const VISUAL_PROPERTIES=Object.freeze({
  color:{label:'文字',type:'color'},backgroundColor:{label:'底色',type:'color'},borderColor:{label:'边框',type:'color'},
  width:number('宽度',0,3840),height:number('高度',0,2160),minWidth:number('最小宽度',0,3840),maxWidth:number('最大宽度',0,3840),minHeight:number('最小高度',0,2160),maxHeight:number('最大高度',0,2160),
  paddingTop:number('上',0,160),paddingRight:number('右',0,160),paddingBottom:number('下',0,160),paddingLeft:number('左',0,160),
  marginTop:number('上',-160,160),marginRight:number('右',-160,160),marginBottom:number('下',-160,160),marginLeft:number('左',-160,160),
  gap:number('间距',0,160),rowGap:number('行间距',0,160),columnGap:number('列间距',0,160),
  fontSize:number('字号',8,96),fontWeight:options('字重',['300','400','500','600','700','800','900']),lineHeight:number('行距',.8,4,'',.05),letterSpacing:number('字距',-3,16,'px',.1),
  fontFamily:{label:'字体',type:'font'},textAlign:options('对齐',['left','center','right','justify']),
  borderWidth:number('粗细',0,16,'px',.5),borderRadius:number('圆角',0,160),borderStyle:options('线型',['none','solid','dashed','dotted']),
  borderTopLeftRadius:number('左上角',0,160),borderTopRightRadius:number('右上角',0,160),borderBottomRightRadius:number('右下角',0,160),borderBottomLeftRadius:number('左下角',0,160),
  objectFit:options('图片填充',['contain','cover','fill','none','scale-down']),whiteSpace:options('折行',['normal','nowrap','pre-wrap']),textTransform:options('字母大小写',['none','uppercase','lowercase','capitalize']),
  strokeWidth:number('图标线宽',.5,12,'px',.5),fill:{label:'图形填充',type:'color'},stroke:{label:'图形描边',type:'color'},
  boxSizing:options('尺寸计算',['border-box','content-box']),
  boxShadow:{label:'阴影',type:'shadow'},opacity:number('透明度',0,1,'',.05),
  display:options('排列',['block','flex','grid','inline-flex','inline-block','none']),flexDirection:options('方向',['row','column','row-reverse','column-reverse']),flexWrap:options('换行',['nowrap','wrap']),
  justifyContent:options('主轴',['flex-start','center','flex-end','space-between','space-around','space-evenly']),alignItems:options('交叉轴',['stretch','flex-start','center','flex-end','baseline']),
  gridTemplateColumns:{label:'网格列数',type:'columns'},overflow:options('溢出',['visible','hidden','auto','scroll']),
  scale:number('缩放',.25,3,'',.05),rotate:number('旋转',-180,180,'deg'),transitionDuration:number('过渡',0,2000,'ms',25)
});
export const VISUAL_GROUPS=[
  {label:'颜色',keys:['color','backgroundColor','borderColor']},
  {label:'尺寸',keys:['width','height','minWidth','maxWidth','minHeight','maxHeight','boxSizing']},
  {label:'内边距',keys:['paddingTop','paddingRight','paddingBottom','paddingLeft']},
  {label:'外边距',keys:['marginTop','marginRight','marginBottom','marginLeft']},
  {label:'文字',keys:['fontSize','fontWeight','fontFamily','lineHeight','letterSpacing','textAlign','whiteSpace','textTransform']},
  {label:'轮廓',keys:['borderWidth','borderStyle','borderRadius','borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius','boxShadow']},
  {label:'排列',keys:['display','flexDirection','flexWrap','justifyContent','alignItems','gap','rowGap','columnGap','gridTemplateColumns','overflow']},
  {label:'图片与图标',keys:['objectFit','strokeWidth','fill','stroke']},
  {label:'效果',keys:['opacity','scale','rotate','transitionDuration']}
];
export const VISUAL_STATES=Object.freeze({base:'默认',hover:'悬停',active:'按下','focus-visible':'聚焦',disabled:'禁用'});
const color=/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|transparent|rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d{1,3}))?\s*\))$/i;
const themeColor=/^theme:(bg|surface|surface2|surface3|text|muted|line|accent|accentInk|good|warn|bad)(?::(100|[1-9]?\d))?$/;
const colorVars={bg:'--bg',surface:'--surface',surface2:'--surface-2',surface3:'--surface-3',text:'--text',muted:'--muted',line:'--line',accent:'--accent',accentInk:'--accent-ink',good:'--good',warn:'--warn',bad:'--bad'};
export function visualColorCss(value){const ref=themeColor.exec(value||'');if(!ref)return value;const base=`var(${colorVars[ref[1]]})`;return ref[2]===undefined?base:`color-mix(in srgb, ${base} ${ref[2]}%, var(--surface))`;}
export function resolveVisualColor(value,theme={}){
  const ref=themeColor.exec(value||'');if(!ref)return value;
  const base=theme[ref[1]]||'#808080';if(ref[2]===undefined)return base;
  const rgb=hex=>{let s=String(hex).replace('#','');if(s.length===3)s=[...s].map(c=>c+c).join('');if(!/^[\da-f]{6,8}$/i.test(s))s='808080';return[0,2,4].map(i=>parseInt(s.slice(i,i+2),16));};
  const a=rgb(base),b=rgb(theme.surface||theme.bg),amount=Number(ref[2])/100;return'#'+a.map((v,i)=>Math.round(v*amount+b[i]*(1-amount)).toString(16).padStart(2,'0')).join('');
}
export function normalizeVisualValue(key,value){
  const spec=VISUAL_PROPERTIES[key];if(!spec||value===null||value===undefined||value==='')return null;
  const text=String(value).trim();if(text.length>160||/[;{}<>\\]|url\s*\(|var\s*\(|expression/i.test(text))return null;
  if(spec.type==='color')return color.test(text)||themeColor.test(text)?text:null;
  if(spec.type==='select')return spec.options.includes(text)?text:null;
  if(spec.type==='font')return /^[\p{L}\p{N} .,&()"'_-]{1,160}$/u.test(text)?text:null;
  if(spec.type==='columns')return /^repeat\([1-8], minmax\(0, 1fr\)\)$/.test(text)?text:null;
  if(spec.type==='shadow')return text==='none'||/^(?:inset )?-?\d{1,3}px -?\d{1,3}px \d{1,3}px(?: -?\d{1,3}px)? (?:#[\da-f]{6,8}|rgba\(\d{1,3}, ?\d{1,3}, ?\d{1,3}, ?(?:0|1|0?\.\d{1,3})\))$/i.test(text)?text:null;
  if(['width','height','minWidth','maxWidth','minHeight','maxHeight'].includes(key)&&['auto','none','fit-content','max-content','min-content'].includes(text))return text;
  const match=/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|%|vw|vh|deg|ms)?$/.exec(text);if(!match)return null;
  const n=Number(match[1]),unit=match[2]??spec.unit;
  const dimension=/^(?:min|max)?(?:Width|Height)$/.test(key)||key==='width'||key==='height';
  if(unit!==spec.unit&&!(dimension&&['%','vw','vh'].includes(unit)))return null;
  const max=unit==='%'||unit==='vw'||unit==='vh'?100:spec.max;
  return n>=spec.min&&n<=max?`${n}${unit}`:null;
}
const simple=/^(?:(?:[a-z][a-z0-9-]*|\*)?(?:#[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|\[id="[A-Za-z_][\w:.-]{0,95}"\]|:nth-of-type\([1-9]\d{0,3}\))*)$/i;
export function validVisualSelector(selector){
  if(typeof selector!=='string'||!selector||selector.length>600)return false;
  if(/^(?:html|body)(?=[#.\[:]|$)/i.test(selector.split(/\s*>\s*/).at(-1)))return false;
  if(Object.values(VISUAL_KINDS).some(kind=>kind.selector===selector))return true;
  return selector.split(/\s*>\s*/).every(part=>part&&simple.test(part));
}
export function normalizeVisual(input){
  const rules=[];if(!Array.isArray(input?.rules))return{rules};
  for(const rule of input.rules.slice(0,400)){
    if(!rule||!validVisualSelector(rule.selector)||!Object.hasOwn(VISUAL_STATES,rule.state)||!/^\*$|^[a-z][\w-]{0,63}$/i.test(rule.page||''))continue;
    const styles={};for(const [key,value] of Object.entries(rule.styles||{})){const valid=normalizeVisualValue(key,value);if(valid!==null)styles[key]=valid;}
    if(!Object.keys(styles).length)continue;
    rules.push({id:typeof rule.id==='string'&&/^[\w-]{1,80}$/.test(rule.id)?rule.id:`v${rules.length}`,page:rule.page,selector:rule.selector,state:rule.state,kind:Object.hasOwn(VISUAL_KINDS,rule.kind)?rule.kind:'container',styles});
  }
  return{rules};
}
export function visualPage(doc){return /\/panels\/([\w-]+)\//.exec(doc?.location?.pathname||'')?.[1]||'shell';}
export function visualCss(input,page){
  const priority=rule=>(rule.page==='*'?0:1)+(Object.values(VISUAL_KINDS).some(k=>k.selector===rule.selector)?0:2);
  return normalizeVisual(input).rules.filter(rule=>rule.page==='*'||rule.page===page).sort((a,b)=>priority(a)-priority(b)).map(rule=>{
    const forced=`:not([data-visual-preview-state]:not([data-visual-preview-state="${rule.state}"]))`;
    const suffix=rule.state==='base'?'':(rule.state==='disabled'?':is(:disabled,[aria-disabled="true"],[data-visual-preview-state="disabled"])':`:is(:${rule.state},[data-visual-preview-state="${rule.state}"])`)+forced;
    const selectors=rule.selector.split(',').map(s=>`:is(#qqa-visual-specificity#qqa-visual-specificity,${s})${suffix}:not(html):not(body):not([data-visual-owned])`),selector=selectors.join(',');
    let declarations=Object.entries(rule.styles).map(([key,value])=>`${key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase())}:${VISUAL_PROPERTIES[key].type==='color'?visualColorCss(value):value}!important`).join(';');
    if(rule.styles.backgroundColor)declarations+=';background-image:none!important';
    if(rule.styles.borderWidth&&parseFloat(rule.styles.borderWidth)>0&&!rule.styles.borderStyle)declarations+=';border-style:solid!important';
    if(rule.styles.height&&!rule.styles.minHeight)declarations+=';min-height:0!important';
    if(rule.styles.width&&!rule.styles.minWidth)declarations+=';min-width:0!important';
    if(Object.keys(rule.styles).some(k=>/Radius$/.test(k)))declarations+=';clip-path:none!important';
    const iconKeys=Object.entries(rule.styles).filter(([key])=>['fill','stroke','strokeWidth'].includes(key));
    const icon=rule.kind==='icon'&&iconKeys.length?`${rule.selector.split(',').map(s=>`:is(#qqa-visual-specificity#qqa-visual-specificity,${s})${suffix} :is(path,circle,rect,line,polyline,polygon,ellipse)`).join(',')}{${iconKeys.map(([key,value])=>`${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}:${VISUAL_PROPERTIES[key].type==='color'?visualColorCss(value):value}!important`).join(';')}}`:'';
    const noMotion=rule.styles.transitionDuration?`@media(prefers-reduced-motion:reduce){${selector}{transition-duration:0ms!important}}${selectors.map(s=>'body[data-interface-motion="off"] '+s).join(',')}{transition-duration:0ms!important}`:'';
    return`${selector}{${declarations}}${icon}${noMotion}`;
  }).join('\n');
}
const paintCache=new WeakMap();
export function applyVisualStyles(doc,input){
  if(!doc?.head?.append||!doc.createElement)return;
  const css=visualCss(input,visualPage(doc));let state=paintCache.get(doc);
  if(!state){state={css:null,node:null};paintCache.set(doc,state);}
  if(state.css===css)return;state.css=css;
  if(!css){state.node?.remove();state.node=null;return;}
  if(!state.node){state.node=doc.createElement('style');state.node.dataset.visualOwned='true';doc.head.append(state.node);}
  state.node.textContent=css;
}
