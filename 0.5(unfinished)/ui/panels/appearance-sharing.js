import {DEFAULT_THEME,PERSONALIZATION_FIELDS,migrateUikit,resolveScheme} from './theme.js';
import {normalizeIconOverrides} from './icon-customization.js';
import {normalizeVisual} from './visual-style.js';
const local = new Set(['preset','gradient','visual','icons',...Object.keys(DEFAULT_THEME).filter(key=>key.startsWith('bg')),...['surface','surface2','surface3','text','muted','faint','accent','accent2','good','warn','bad','line','lineSoft','accentInk'],...PERSONALIZATION_FIELDS.filter(field=>field.type==='color'||field.group==='brand').map(field=>field.key)]);
export const SHARED_APPEARANCE_KEYS=Object.freeze(Object.keys(DEFAULT_THEME).filter(key=>!local.has(key)));
const localPaint=new Set(['color','backgroundColor','borderColor','fill','stroke','boxShadow']);
const brandRule=rule=>/brand-emblem|icon-emblem/.test(rule.selector);
const identity=rule=>JSON.stringify([rule.page,rule.selector,rule.state]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function sharedAppearanceFrom(uikit){
  const theme=resolveScheme(uikit),tokens=Object.fromEntries(SHARED_APPEARANCE_KEYS.map(key=>[key,theme[key]])),icons={...normalizeIconOverrides(theme.icons)},visual={};delete icons.emblem;
  for(const rule of normalizeVisual(theme.visual).rules){if(brandRule(rule))continue;const styles=Object.fromEntries(Object.entries(rule.styles).filter(([key])=>!localPaint.has(key)));if(Object.keys(styles).length)visual[identity(rule)]={...rule,styles};}
  return {tokens,icons,visual};
}
export function appearanceDelta(before,after){
  const out={};for(const group of ['tokens','icons','visual'])for(const key of new Set([...Object.keys(before?.[group]||{}),...Object.keys(after?.[group]||{})]))if(!same(before?.[group]?.[key],after?.[group]?.[key]))(out[group]??={})[key]=after?.[group]?.[key]??null;
  return out;
}
export function mergeSharedAppearance(state,delta){
  const next=structuredClone(state||{tokens:{},icons:{},visual:{}});
  for(const group of ['tokens','icons','visual']){next[group]??={};for(const [key,value]of Object.entries(delta?.[group]||{})){if(['__proto__','constructor','prototype'].includes(key))continue;if(value===null)delete next[group][key];else next[group][key]=value;}}
  // Resolve through the same bounded preferences used by the renderer; no other config leaves an account.
  return sharedAppearanceFrom({dark:{...next.tokens,icons:next.icons,visual:{rules:Object.values(next.visual)}}});
}
export function applySharedAppearance(uikit,shared){
  const store=structuredClone(migrateUikit(uikit));
  function mix(input){
    const source=input||{},icons={...shared.icons,...(source.icons?.emblem?{emblem:source.icons.emblem}:{})};
    const rules=new Map();for(const rule of normalizeVisual(source.visual).rules){const styles=brandRule(rule)?rule.styles:Object.fromEntries(Object.entries(rule.styles).filter(([key])=>localPaint.has(key)));if(Object.keys(styles).length)rules.set(identity(rule),{...rule,styles});}
    for(const rule of Object.values(shared.visual||{})){const key=identity(rule),own=rules.get(key);rules.set(key,{...rule,id:own?.id||rule.id,styles:{...rule.styles,...own?.styles}});}
    return {...source,...shared.tokens,icons,visual:{rules:[...rules.values()]}};
  }
  store.dark=mix(store.dark);store.light=mix(store.light);for(const entry of Object.values(store.custom))if(entry&&typeof entry==='object')entry.tokens=mix(entry.tokens);
  return store;
}
