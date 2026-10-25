let sequence=0;

// Keep the bound select as the value owner. The cards only present its options
// and forward genuine changes through the select's existing event handler.
export function mountChoiceCards(select,{labels={}}={}){
  const doc=select.ownerDocument,group=doc.createElement('div'),title=select.closest('.setting-field')?.querySelector('.field-title');
  group.className='settings-choice-cards';group.setAttribute('role','radiogroup');
  if(title){title.id||=`settings-choice-${++sequence}`;group.setAttribute('aria-labelledby',title.id);}
  else group.setAttribute('aria-label',select.getAttribute('aria-label')||'选择');
  const wasHidden=select.hidden;select.hidden=true;select.after(group);
  function render(){
    const focused=group.contains(doc.activeElement)?doc.activeElement?.dataset.value:null;
    group.replaceChildren();
    for(const option of select.options){
      const button=doc.createElement('button'),selected=select.value===option.value;
      button.type='button';button.dataset.value=option.value;button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));
      button.textContent=labels[option.value]||option.label;button.disabled=select.disabled||option.disabled;button.tabIndex=selected?0:-1;
      button.addEventListener('click',()=>{
        if(select.value===option.value)return;
        select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();
      });
      group.append(button);
    }
    if(focused!==null)[...group.children].find(button=>button.dataset.value===focused)?.focus({preventScroll:true});
  }
  function sync(){for(const button of group.children){const selected=button.dataset.value===select.value,option=[...select.options].find(option=>option.value===button.dataset.value);button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1;button.disabled=select.disabled||option?.disabled===true;}}
  group.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    const options=[...group.children].filter(button=>!button.disabled);if(!options.length)return;event.preventDefault();
    const index=options.indexOf(doc.activeElement),next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)+options.length)%options.length;
    options[next].focus();options[next].click();
  });
  select.addEventListener('change',sync);
  const observer=new MutationObserver(render);observer.observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected','label','value']});render();
  return {refresh:render,dispose(){observer.disconnect();select.removeEventListener('change',sync);select.hidden=wasHidden;group.remove();}};
}
