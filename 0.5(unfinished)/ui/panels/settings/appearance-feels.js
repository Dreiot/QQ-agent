import {APPEARANCE_FEELS} from '../visual-presets.js';
export function renderAppearanceFeels({doc=document,effective,change}){
  const host=doc.createElement('div');host.className='appearance-feels full';
  for(const group of APPEARANCE_FEELS){
    const row=doc.createElement('div'),label=doc.createElement('strong'),choices=doc.createElement('div');row.className='appearance-feel';row.dataset.appearanceFeel=group.id;label.textContent=group.label;choices.className='appearance-feel-choices';choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label',group.label);
    for(const item of group.items){const button=doc.createElement('button');button.type='button';button.dataset.feelValue=item.id;button.textContent=item.label;button.setAttribute('role','radio');button.setAttribute('aria-checked',String(Object.entries(item.tokens).every(([k,v])=>effective[k]===v)));button.addEventListener('click',()=>change(item.tokens,group.id,item.id));choices.append(button);}
    if(!group.items.some(item=>Object.entries(item.tokens).every(([key,value])=>effective[key]===value))){const custom=doc.createElement('small');custom.className='appearance-feel-custom';custom.textContent='已细调';label.append(custom);}
    row.append(label,choices);host.append(row);
  }return host;
}
