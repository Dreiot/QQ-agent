import {PERSONALIZATION_FIELDS,PERSONALIZATION_GROUPS} from '../theme.js';
import {createIcon} from '../icons.js';
import {mountChoiceCards} from './choice-cards.js';
import {mountFontPicker} from '../local-fonts.js';
import {request} from '../panel-client.js';

// Every editor writes through the current scheme's existing queue. There is no
// parallel preferences store, and preview-only controls never call this module.
export function renderAppearanceControls({doc=document,effective,path,change}){
  const groups=new Map(PERSONALIZATION_GROUPS.map(group=>[group.id,{...group,fields:[]}])),disposers=[];
  for(const spec of PERSONALIZATION_FIELDS){
    const box=doc.createElement('div');box.className='setting-field personalization-field';box.dataset.personalizationKey=spec.key;
    const head=doc.createElement('div'),title=doc.createElement('label'),reset=doc.createElement('button');head.className='personalization-field-head';title.className='field-title';title.textContent=spec.label;
    const id=`field-uikit-${spec.key}`;title.htmlFor=id;
    reset.type='button';reset.className='personalization-reset';reset.setAttribute('aria-label',`恢复${spec.label}默认值`);reset.title=`恢复${spec.label}默认值`;reset.append(createIcon('undo',{size:14}));head.append(title,reset);box.append(head);
    let value=effective[spec.key]??spec.default,sync=()=>{},apply;
    const emit=(next,preserveNumber=false)=>{value=next;change(spec.key,next);sync(preserveNumber);};
    const bind=input=>{input.id=id;input.dataset.configPath=path(spec.key);input.setAttribute('aria-label',spec.label);return input;};
    if(spec.type==='boolean'){
      const input=bind(doc.createElement('input')),card=doc.createElement('label'),name=doc.createElement('span');input.type='checkbox';name.className='field-title';name.textContent=spec.label;card.className='personalization-toggle';card.append(name,input);box.classList.add('personalization-boolean');box.replaceChildren(card,reset);
      input.addEventListener('change',()=>emit(input.checked));sync=()=>{input.checked=value===true;};
    }else if(spec.type==='select'){
      const input=bind(doc.createElement('select'));for(const item of spec.options){const option=doc.createElement('option');option.value=String(item.value);option.textContent=item.label;input.append(option);}
      input.value=String(value);input.addEventListener('change',()=>{const option=spec.options.find(item=>String(item.value)===input.value);emit(option?.value??input.value);});box.append(input);
      const cards=mountChoiceCards(input);disposers.push(cards.dispose);sync=()=>{input.value=String(value);cards.refresh();};
    }else if(spec.type==='font'){
      const input=bind(doc.createElement('input'));input.value=value;
      const picker=mountFontPicker({doc,input,request,onChange:next=>emit(next)});box.append(picker.element);disposers.push(picker.dispose);sync=()=>{input.value=value;};
    }else if(spec.type==='color'){
      const row=doc.createElement('div'),input=bind(doc.createElement('input')),auto=doc.createElement('button');row.className='personalization-color';input.type='color';auto.type='button';auto.textContent=spec.autoLabel||'自动';auto.setAttribute('role','switch');auto.setAttribute('aria-label',`${spec.label}自动`);
      const inherited=spec.key==='rail'?effective.bg:effective.accent;
      auto.addEventListener('click',()=>emit(value===''?inherited:''));input.addEventListener('input',()=>emit(input.value));row.append(input,auto);box.append(row);
      sync=()=>{const automatic=value==='';input.disabled=automatic;input.value=automatic?inherited:value;auto.setAttribute('aria-checked',String(automatic));};
    }else{
      const row=doc.createElement('div'),slider=bind(doc.createElement('input')),number=doc.createElement('input'),unit=doc.createElement('span');row.className='personalization-range';slider.type='range';number.type='number';number.id=id+'-number';number.setAttribute('aria-label',`${spec.label}精确值`);unit.className='personalization-unit';unit.textContent=spec.unit;
      const scale=spec.displayScale||1,min=spec.autoValue===undefined?spec.min:Math.max(0,spec.min);
      slider.min=String(min);slider.max=String(spec.max);slider.step=String(spec.step);number.min=String(min*scale);number.max=String(spec.max*scale);number.step=String(Number((spec.step*scale).toFixed(6)));
      const automatic=spec.autoValue===undefined?null:doc.createElement('button');
      const inheritedRadius=['radiusButton','radiusInput'].includes(spec.key)?effective.radius===0?0:Math.max(2,Math.round(effective.radius*.7)):effective.radius;
      if(automatic){automatic.type='button';automatic.className='personalization-auto';automatic.textContent=spec.autoLabel;automatic.setAttribute('role','switch');automatic.setAttribute('aria-label',`${spec.label}自动`);automatic.addEventListener('click',()=>emit(value===spec.autoValue?inheritedRadius:spec.autoValue));box.append(automatic);}
      slider.addEventListener('input',()=>emit(Number(slider.value)));
      number.addEventListener('input',()=>{const next=Number(number.value)/scale,valid=number.value.trim()!==''&&Number.isFinite(next)&&next>=min&&next<=spec.max;number.setAttribute('aria-invalid',String(!valid));if(valid)emit(next,true);});
      number.addEventListener('blur',()=>sync());
      row.append(slider,number,unit);box.append(row);
      sync=(preserveNumber=false)=>{const isAuto=automatic&&value===spec.autoValue,shown=isAuto?inheritedRadius:value;slider.value=String(shown);if(!preserveNumber)number.value=String(Number((Number(shown)*scale).toFixed(6)));number.removeAttribute('aria-invalid');slider.disabled=number.disabled=!!isAuto;automatic?.setAttribute('aria-checked',String(!!isAuto));};
    }
    if(spec.hint){const hint=doc.createElement('small');hint.className='field-hint';hint.id=id+'-hint';hint.textContent=spec.hint;box.append(hint);for(const input of box.querySelectorAll('input,select'))input.setAttribute('aria-describedby',hint.id);}
    reset.addEventListener('click',()=>emit(spec.default));sync();groups.get(spec.group).fields.push(box);
  }
  return {groups:[...groups.values()],dispose:()=>disposers.splice(0).forEach(dispose=>dispose())};
}
