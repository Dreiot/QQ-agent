import {createIcon} from '../icons.js';
// Native checked/disabled state remains the source of truth, including keyboard
// activation. Color, the check mark and pressed surface convey state visually.
export function mountSwitchCards(doc=document){
  const indicator=element=>{if(element.querySelector(':scope>.settings-toggle-indicator'))return;const mark=doc.createElement('span');mark.className='settings-toggle-indicator';mark.setAttribute('aria-hidden','true');mark.append(createIcon('check',{size:14}),createIcon('warning',{size:14}));element.append(mark);};
  function enhance(){
    for(const input of doc.querySelectorAll('input[type=checkbox]')){
      const label=input.closest('label');if(!label)continue;
      label.classList.add('settings-toggle-card');
      const title=input.getAttribute('aria-label')||label.querySelector('.field-title')?.textContent;
      if(title&&!input.hasAttribute('aria-label'))input.setAttribute('aria-label',title);
      label.dataset.checked=String(input.checked);label.dataset.disabled=String(input.disabled);
      indicator(label);
      for(const pill of label.querySelectorAll('.switch-pill,.activity-switch-track'))pill.hidden=true;
    }
    for(const button of doc.querySelectorAll('button[role=switch]')){if(!button.hasAttribute('aria-label'))button.setAttribute('aria-label',button.textContent.trim());button.classList.add('settings-toggle-card','settings-toggle-button');indicator(button);}
    for(const summary of doc.querySelectorAll('details>summary'))if(!summary.querySelector(':scope>.settings-fold-chevron')){const mark=doc.createElement('span');mark.className='settings-fold-chevron';mark.setAttribute('aria-hidden','true');mark.append(createIcon('chevron',{size:14}));summary.append(mark);}
  }
  const observer=new MutationObserver(enhance);observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-checked','checked','disabled']});
  const update=()=>queueMicrotask(enhance);doc.addEventListener('change',update);enhance();
  return()=>{observer.disconnect();doc.removeEventListener('change',update);};
}
