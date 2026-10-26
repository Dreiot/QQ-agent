// Project-owned round-stroke symbols, with motion room inside a 24-unit canvas.
import { installIconMotion } from './icon-motion.js';
import { LIFE_EMBLEM_FRAMES } from './life-emblem.js';
const NS = 'http://www.w3.org/2000/svg';
const line = (role,d) => ({role,d});
const solid = (role,d) => ({role,d,solid:true});
const ready = () => solid('ready','M16.1 16.3l1.5 1.6 3-3.7 1.1.9-4 4.9-2.7-2.8z');
const pending = () => line('gap','M18.5 14.5v3l1.8 1.1M22 17.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z');
const GLYPHS = Object.freeze({
  rules:[line('rail','M6 5.5h5a2 2 0 0 1 2 2v9a2 2 0 0 0 2 2h3M13 12h5'),line('nodes','M7 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM22 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM22 18.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z')],
  sessions:[line('rail','M6 8v3m0 3v3M10 6h9M10 12h3M10 18h9'),line('nodes','M7.5 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM7.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM7.5 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z'),solid('cursor','M16 9.2l4.2 2.8-4.2 2.8z')],
  chats:[line('back','M8 5V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1'),line('shell','M5 7h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z'),solid('message','M7.1 12.5a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0zM10.9 12.5a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0zM14.7 12.5a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0z')],
  memory:[line('index','M6 3.5H4.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2H6M18 3.5h1.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H18'),line('portrait','M13 8.2a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM5.5 17.7a4.5 4.5 0 0 1 9 0'),line('impressions','M17 8h2M17 12h2M17 16h2')],
  usage:[line('rail','M3.5 4.5v15a1 1 0 0 0 1 1h16'),solid('meter-a','M7 11h2.5v7H7z'),solid('meter-b','M11.5 5h2.5v13h-2.5z'),solid('meter-c','M16 8.5h2.5V18H16z')],
  skills:[line('tool','M7.5 16.5l6-6 3 3-6 6a2.12 2.12 0 0 1-3-3zM12 12l3 3'),line('marks','M17.5 3v4M15.5 5h4M5.5 6v4M3.5 8h4M19 16v3M17.5 17.5h3')],
  plugins:[line('socket','M4 9V5a1 1 0 0 1 1-1h4v-.3a2 2 0 0 1 4 0V4h6a1 1 0 0 1 1 1v4'),line('module','M20 9h-.5a2.5 2.5 0 0 0 0 5h.5v5a1 1 0 0 1-1 1h-5v-.5a2.5 2.5 0 0 0-5 0v.5H5a1 1 0 0 1-1-1v-5h.5a2.5 2.5 0 0 0 0-5H4'),solid('contacts','M11 10h2v4h-2z')],
  logs:[line('sheet','M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z'),line('records','M8 8h8M8 12h8M8 16h5')],
  settings:[line('rail','M3.5 6h17M3.5 12h17M3.5 18h17'),solid('control-a','M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'),solid('control-b','M18 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'),solid('control-c','M12 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z')],
  community:[line('avatar','M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z'),line('shoulders','M5 21v-2a7 7 0 0 1 14 0v2'),line('identity','M8.5 18.5h7')],
  model:[line('shell','M7.5 5.5h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h4M2.5 15h4M17.5 9h4M17.5 15h4'),line('network','M9 9.5h6M9 9.5l3 6 3-6'),solid('nodes','M10 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM16 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM13 15.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z')],
  shield:[line('shell','M12 3l8 3v6c0 4.2-3 7.2-8 9-5-1.8-8-4.8-8-9V6z'),line('lock','M9.5 11.5v-2a2.5 2.5 0 0 1 5 0v2M8.5 11.5h7v5h-7z'),solid('keyhole','M12.7 14a.7.7 0 1 1-1.4 0 .7.7 0 0 1 1.4 0z')],
  globe:[line('shell','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),line('meridians','M3.5 9h17M3.5 15h17M12 3a18 18 0 0 0 0 18 18 18 0 0 0 0-18z')],
  smile:[line('shell','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),line('expression','M8 14.5a4.5 4.5 0 0 0 8 0M8 9h.1M16 9h.1')],
  panel:[line('shell','M5 3.5h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2zM3 8.5h18M8 8.5v12'),solid('anchor','M6.2 6a.7.7 0 1 1-1.4 0 .7.7 0 0 1 1.4 0z')],
  activity:[line('rail','M3 12h4l2.5-7 5 14 2.5-7h4'),solid('cursor','M21 12a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0z')],
  menu:[line('rails','M5 6.5h14M5 12h14M5 17.5h14')],
  arrow:[line('direction','M5.5 12h13M13 6.5l5.5 5.5-5.5 5.5')],
  'arrow-up':[line('direction','M12 19V5M6.5 10.5L12 5l5.5 5.5')],
  'arrow-down':[line('direction','M12 5v14M6.5 13.5L12 19l5.5-5.5')],
  chevron:[line('direction','M6.5 9l5.5 5.5L17.5 9')],
  check:[line('direction','M5 12.5l4.5 4.5L19 7.5')],
  close:[line('direction','M6 6l12 12M18 6L6 18')],
  search:[line('lens','M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z'),line('handle','M14.8 14.8l5.7 5.7')],
  refresh:[line('forward','M19.5 8.5A8 8 0 0 0 5 6.5M19.5 4.5v4h-4'),line('return','M4.5 15.5A8 8 0 0 0 19 17.5M4.5 19.5v-4h4')],
  undo:[line('direction','M8 6L3.5 10.5 8 15M4 10.5h9a6 6 0 0 1 6 6v2')],
  plus:[line('direction','M12 5.5v13M5.5 12h13')],
  qrcode:[line('corners','M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'),line('codes','M7 7h3v3H7zM14 7h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z')],
  trash:[line('shell','M4.5 6.5h15M9 6.5v-3h6v3M6.5 6.5l.7 13a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1l.7-13'),line('slots','M10 10.5v6M14 10.5v6')],
  pause:[solid('bars','M6 5.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5zM14 5.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5z')],
  play:[solid('direction','M7 5.4a.8.8 0 0 1 1.2-.7l11 6.6a.8.8 0 0 1 0 1.4l-11 6.6a.8.8 0 0 1-1.2-.7z')],
  upload:[line('direction','M12 15.5v-11M7.5 9L12 4.5 16.5 9'),line('dock','M4.5 15.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3.5')],
  folder:[line('shell','M4.5 5h5l2 2h8a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'),line('records','M7.5 11.5h9M7.5 15.5h6')],
  link:[line('chain','M9 7l2.5-2.5a5 5 0 0 1 7 7L16 14M8 10l-2.5 2.5a5 5 0 0 0 7 7L15 17'),line('join','M8.5 15.5l7-7')],
  copy:[line('back','M8 15H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V7'),line('sheet','M10 7h9a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 21h-9a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 10 7z')],
  save:[line('shell','M5 3.5h12l3.5 3.5v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM8 20v-7h8v7'),line('slot','M8 3.5v5h8v-5')],
  info:[line('shell','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),line('stem','M11 11h1v6M10 17h4'),solid('dot','M13 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0z')],
  warning:[line('shell','M10.7 4.7a1.5 1.5 0 0 1 2.6 0L21 18.1a1.5 1.5 0 0 1-1.3 2.2H4.3A1.5 1.5 0 0 1 3 18.1z'),solid('mark','M11.2 8h1.6v6h-1.6zM12.9 17a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0z')],
  clock:[line('shell','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),line('hands','M12 6.5V12l4 2.5')],
  loading:[line('orbit','M12 3.5a8.5 8.5 0 0 1 8.5 8.5M12 20.5A8.5 8.5 0 0 1 3.5 12'),solid('nodes','M13 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM13 20.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z')],
  sun:[line('rays','M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4'),line('core','M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z')],
  moon:[line('crescent','M20.5 14.7A9 9 0 0 1 9.3 3.5a9 9 0 1 0 11.2 11.2z')],
  contrast:[line('shell','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),solid('half','M12 3a9 9 0 0 1 0 18z')],
  emblem:[solid('cells',LIFE_EMBLEM_FRAMES[0])],
  archive:[line('tray','M4 9.5v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-10M3.5 5h17v4.5h-17z'),line('payload','M9 14h6')],
  'status-onebot-ready':[line('endpoints','M3.5 4h6v6h-6zM3.5 15h6v6h-6z'),line('bridge','M9.5 7H13v11H9.5M13 12h5V8'),ready()],
  'status-onebot-pending':[line('endpoints','M3.5 4h6v6h-6zM3.5 15h6v6h-6z'),line('bridge','M9.5 7H13v11H9.5M13 12h5V8'),pending()],
  'status-model-ready':[line('network','M5 6.5h9M5 12h9M5 17.5h7M7 6.5L12 12 7 17.5'),line('nodes','M6.5 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM6.5 17.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM17 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM16 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'),ready()],
  'status-model-pending':[line('network','M5 6.5h9M5 12h9M5 17.5h7M7 6.5L12 12 7 17.5'),line('nodes','M6.5 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM6.5 17.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM17 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM16 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'),pending()],
});
const ALIASES = Object.freeze({extension:'plugins',plugin:'plugins',chat:'chats',session:'sessions',profile:'community',chart:'usage',gear:'settings'});
/** Pure decoration: the surrounding control supplies its accessible name. */
export function createIcon(name,{size=20}={}) {
  installIconMotion(document);
  const px=Number.isFinite(Number(size))?Math.min(96,Math.max(12,Number(size))):20;
  const key=Object.hasOwn(GLYPHS,name)?name:Object.hasOwn(ALIASES,name)?ALIASES[name]:'panel';
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('class','qq-icon icon-'+key);svg.dataset.iconMotion=key;
  svg.style.setProperty('--icon-size-ratio',String(px/20));
  for(const [name,value] of Object.entries({viewBox:key==='emblem'?'0 0 68 68':'0 0 24 24',width:String(px),height:String(px),'aria-hidden':'true',focusable:'false',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'}))svg.setAttribute(name,value);
  for(const [index,glyph] of GLYPHS[key].entries()) {
    const part=document.createElementNS(NS,'path');part.setAttribute('d',glyph.d);part.dataset.iconPart=String(index);part.dataset.iconRole=glyph.role;
    if(glyph.solid){part.setAttribute('fill',key==='emblem'?'#3d9bff':'currentColor');part.setAttribute('stroke','none');}
    svg.append(part);
  }
  return svg;
}
export const ICON_NAMES=Object.freeze(Object.keys(GLYPHS));
