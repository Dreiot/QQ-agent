// Small, independent style recipes. Picking a finish does not change size or spacing.
const preset=(id,label,styles)=>Object.freeze({id,label,styles:Object.freeze(styles)});
const finishKeys=['backgroundColor','color','borderColor','borderWidth','borderStyle','boxShadow'];
const finishes=[
  preset('solid','实心',{backgroundColor:'theme:accent',color:'theme:accentInk',borderColor:'theme:accent',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('outline','细边',{backgroundColor:'transparent',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('soft','柔和',{backgroundColor:'theme:accent:12',color:'theme:text',borderColor:'theme:accent:30',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('quiet','轻盈',{backgroundColor:'transparent',color:'theme:muted',borderWidth:'0px',borderStyle:'none',boxShadow:'none'}),
  preset('raised','浮起',{backgroundColor:'theme:surface2',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'0px 5px 18px rgba(0,0,0,0.2)'}),
  preset('bold','粗边',{backgroundColor:'theme:surface',color:'theme:text',borderColor:'theme:accent',borderWidth:'2px',borderStyle:'solid',boxShadow:'none'}),
  preset('dashed','虚线',{backgroundColor:'transparent',color:'theme:text',borderColor:'theme:muted',borderWidth:'1px',borderStyle:'dashed',boxShadow:'none'}),
  preset('contrast','高对比',{backgroundColor:'theme:text',color:'theme:bg',borderColor:'theme:text',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'})
];
const surfaces=[
  preset('clean','清爽',{backgroundColor:'theme:surface',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('soft','柔和',{backgroundColor:'theme:accent:8',color:'theme:text',borderColor:'theme:accent:20',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('flat','平整',{backgroundColor:'theme:surface2',color:'theme:text',borderWidth:'0px',borderStyle:'none',boxShadow:'none'}),
  preset('raised','浮起',{backgroundColor:'theme:surface2',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'0px 8px 28px rgba(0,0,0,0.22)'}),
  preset('outline','通透',{backgroundColor:'transparent',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'none'}),
  preset('accent','醒目',{backgroundColor:'theme:accent:16',color:'theme:text',borderColor:'theme:accent',borderWidth:'2px',borderStyle:'solid',boxShadow:'none'}),
  preset('dashed','虚线',{backgroundColor:'transparent',color:'theme:text',borderColor:'theme:muted',borderWidth:'1px',borderStyle:'dashed',boxShadow:'none'}),
  preset('paper','纸片',{backgroundColor:'theme:surface3',color:'theme:text',borderColor:'theme:line',borderWidth:'1px',borderStyle:'solid',boxShadow:'0px 3px 0px rgba(0,0,0,0.2)'})
];
const typeStyles=[
  preset('body','日常',{fontFamily:'system-ui, sans-serif',fontWeight:'400',color:'theme:text'}),
  preset('soft','轻声',{fontFamily:'system-ui, sans-serif',fontWeight:'300',color:'theme:muted'}),
  preset('strong','醒目',{fontFamily:'system-ui, sans-serif',fontWeight:'700',color:'theme:accent'}),
  preset('serif','书页',{fontFamily:'Georgia, SimSun, serif',fontWeight:'400',color:'theme:text'}),
  preset('mono','等宽',{fontFamily:'ui-monospace, monospace',fontWeight:'400',color:'theme:text'}),
  preset('title','厚重',{fontFamily:'system-ui, sans-serif',fontWeight:'800',color:'theme:text'})
];
const pictures=[
  preset('clean','原图',{borderWidth:'0px',borderStyle:'none',boxShadow:'none',opacity:'1'}),
  preset('frame','细框',{borderWidth:'1px',borderStyle:'solid',borderColor:'theme:line',boxShadow:'none',opacity:'1'}),
  preset('photo','相纸',{borderWidth:'6px',borderStyle:'solid',borderColor:'theme:surface2',boxShadow:'0px 4px 16px rgba(0,0,0,0.2)',opacity:'1'}),
  preset('float','浮起',{borderWidth:'0px',borderStyle:'none',boxShadow:'0px 10px 32px rgba(0,0,0,0.28)',opacity:'1'}),
  preset('accent','彩框',{borderWidth:'2px',borderStyle:'solid',borderColor:'theme:accent',boxShadow:'none',opacity:'1'}),
  preset('mist','柔光',{borderWidth:'0px',borderStyle:'none',boxShadow:'none',opacity:'0.75'})
];
const icons=[
  preset('line','纤细',{color:'theme:text',stroke:'theme:text',strokeWidth:'1px',fill:'transparent'}),
  preset('normal','标准',{color:'theme:text',stroke:'theme:text',strokeWidth:'2px',fill:'transparent'}),
  preset('bold','醒目',{color:'theme:accent',stroke:'theme:accent',strokeWidth:'3px',fill:'transparent'}),
  preset('soft','柔和',{color:'theme:muted',stroke:'theme:muted',strokeWidth:'1.5px',fill:'transparent'}),
  preset('filled','轻填充',{color:'theme:accent',stroke:'theme:accent',strokeWidth:'1.5px',fill:'theme:accent:16'})
];
export function elementPresetFamily(kind){
  if(['text','heading'].includes(kind))return{text:true,items:typeStyles,keys:['fontFamily','fontWeight','color']};
  if(kind==='icon')return{icon:true,items:icons,keys:['color','stroke','strokeWidth','fill']};
  if(kind==='image')return{image:true,items:pictures,keys:['borderWidth','borderStyle','borderColor','boxShadow','opacity']};
  return{surface:['card','container','dialog','table','row','list','textarea'].includes(kind),items:['card','container','dialog','table','row','list','textarea'].includes(kind)?surfaces:finishes,keys:finishKeys};
}
export function elementSizePresets(kind){
  if(['text','heading'].includes(kind)){const base=kind==='heading'?22:14;return[base-2,base,base+3].map((n,i)=>preset(['small','normal','large'][i],['小','适中','大'][i],{fontSize:`${n}px`,lineHeight:'1.6'}));}
  if(kind==='icon')return[16,22,30].map((n,i)=>preset(['small','normal','large'][i],['小','适中','大'][i],{width:`${n}px`,height:`${n}px`}));
  if(kind==='image')return[96,160,240].map((n,i)=>preset(['small','normal','large'][i],['小','适中','大'][i],{width:`${n}px`,height:'auto',objectFit:'cover'}));
  if(['card','container','dialog','table','row','list'].includes(kind))return[10,16,24].map((n,i)=>preset(['compact','normal','spacious'][i],['紧凑','适中','舒展'][i],{paddingTop:`${n}px`,paddingBottom:`${n}px`,paddingLeft:`${n}px`,paddingRight:`${n}px`,gap:`${Math.round(n*.65)}px`}));
  return[[30,12,5,10],[38,13,8,14],[46,15,11,18]].map(([height,font,y,x],i)=>preset(['compact','normal','spacious'][i],['紧凑','适中','舒展'][i],{height:'auto',minHeight:`${height}px`,fontSize:`${font}px`,paddingTop:`${y}px`,paddingBottom:`${y}px`,paddingLeft:`${x}px`,paddingRight:`${x}px`,boxSizing:'border-box'}));
}
export const ELEMENT_SHAPES=[preset('square','方正',{borderRadius:'0px'}),preset('round','圆角',{borderRadius:'10px'}),preset('soft','柔圆',{borderRadius:'28px'})];
export function presetPatch(preset,keys){return Object.fromEntries(keys.map(k=>[k,preset.styles[k]??null]));}

export const APPEARANCE_FEELS=Object.freeze([
  {id:'size',label:'文字大小',items:[
    {id:'small',label:'小',tokens:{fontSize:12,controlFontSize:12,inputFontSize:12,navigationFontSize:12,tableFontSize:11,codeFontSize:11,headingScale:.95}},
    {id:'normal',label:'适中',tokens:{fontSize:13,controlFontSize:12,inputFontSize:13,navigationFontSize:13,tableFontSize:12,codeFontSize:11,headingScale:1}},
    {id:'large',label:'大',tokens:{fontSize:15,controlFontSize:14,inputFontSize:15,navigationFontSize:15,tableFontSize:14,codeFontSize:13,headingScale:1.1}}]},
  {id:'space',label:'页面疏密',items:[
    {id:'compact',label:'紧凑',tokens:{density:.85,controlHeight:30,buttonPaddingX:10,buttonPaddingY:5,inputPaddingX:10,inputPaddingY:5,cardPadding:12,listGap:8,pagePadding:12,navigationHeight:40,tablePaddingX:8,tablePaddingY:8}},
    {id:'normal',label:'适中',tokens:{density:1,controlHeight:36,buttonPaddingX:12,buttonPaddingY:7,inputPaddingX:12,inputPaddingY:7,cardPadding:16,listGap:12,pagePadding:16,navigationHeight:46,tablePaddingX:12,tablePaddingY:12}},
    {id:'spacious',label:'舒展',tokens:{density:1.15,controlHeight:44,buttonPaddingX:16,buttonPaddingY:10,inputPaddingX:16,inputPaddingY:10,cardPadding:22,listGap:16,pagePadding:24,navigationHeight:54,tablePaddingX:16,tablePaddingY:16}}]},
  {id:'shape',label:'圆润程度',items:[
    {id:'square',label:'方正',tokens:{radius:0,radiusButton:0,radiusInput:0,radiusCard:0,radiusDialog:0,buttonShape:'square'}},
    {id:'normal',label:'圆角',tokens:{radius:8,radiusButton:-1,radiusInput:-1,radiusCard:-1,radiusDialog:-1,buttonShape:'round'}},
    {id:'soft',label:'柔圆',tokens:{radius:16,radiusButton:24,radiusInput:16,radiusCard:20,radiusDialog:24,buttonShape:'round'}}]}
]);
