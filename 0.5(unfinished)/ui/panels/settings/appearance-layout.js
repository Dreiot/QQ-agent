import {createIcon} from '../icons.js';
export function organizeAppearance(host,{background,presets,themeHeader,quick,personalization=[],open=new Set()}={}){
  function fold(title,key,children){
    const items=children.filter(Boolean);if(!items.length)return;
    const box=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
    box.className='settings-compact-group';box.dataset.appearanceGroup=key;box.open=open.has(key);
    summary.textContent=title;body.className='settings-fields';body.append(...items);box.append(summary,body);host.append(box);
  }
  const field=id=>host.querySelector(`#field-uikit-${id}`)?.closest('.setting-field');
  fold('配色细调','colors',[...host.querySelectorAll(':scope > .setting-field:has(input[type=color])')]);
  fold('背景','background',[background,...['bgOpacity','bgBlur','bgFit'].map(field)]);
  fold('布局','layout',['radius','density','sidebar','btnAlign','styleMode','gradient'].map(field));
  for(const group of personalization)fold(group.label,'personal-'+group.id,group.fields);
  const preview=host.querySelector('.component-preview');if(preview)fold('试用控件','preview',[preview]);
  fold('我的主题','themes',[themeHeader,host.querySelector('[data-motion-list=uikit-schemes]')?.closest('.setting-field')]);
  const fineGroups=[...host.querySelectorAll(':scope>details[data-appearance-group]')].filter(group=>!['background','themes','preview'].includes(group.dataset.appearanceGroup));
  const advanced=document.createElement('details'),advancedTitle=document.createElement('summary'),advancedBody=document.createElement('div');advanced.className='appearance-advanced full';advanced.dataset.appearanceGroup='advanced';advancedTitle.textContent='精细调整';advanced.open=open.has('advanced');advancedBody.className='appearance-advanced-body';advancedBody.append(...fineGroups);advanced.append(advancedTitle,advancedBody);host.append(advanced);
  if(quick)host.prepend(quick);if(presets)host.prepend(presets);
  const reset=host.querySelector(':scope > .actions');if(reset)host.append(reset);
  const searchWrap=document.createElement('div'),search=document.createElement('input'),empty=document.createElement('p');searchWrap.className='appearance-search full';search.type='search';search.placeholder='找外观设置';search.setAttribute('aria-label','找外观设置');searchWrap.append(createIcon('search',{size:18}),search);empty.className='settings-empty full';empty.textContent='没有找到外观设置';empty.setAttribute('role','status');empty.hidden=true;
  advancedBody.prepend(searchWrap,empty);
  let beforeSearch=null;
  search.addEventListener('input',()=>{
    const query=search.value.trim().toLowerCase(),groups=[...advancedBody.querySelectorAll(':scope>details')];
    if(query)advanced.open=true;
    if(query&&!beforeSearch)beforeSearch=new Set(groups.filter(group=>group.open));
    let found=0;for(const group of groups){const fields=[...group.querySelectorAll('.setting-field')],groupMatch=group.querySelector(':scope>summary').textContent.toLowerCase().includes(query);let matches=0;for(const field of fields){const match=!query||groupMatch||`${field.querySelector('.field-title')?.textContent||''} ${field.dataset.personalizationKey||''}`.toLowerCase().includes(query);field.hidden=!match;if(match)matches++;}group.hidden=!!query&&!matches;if(query&&matches){group.open=true;found+=matches;}else if(!query&&beforeSearch)group.open=beforeSearch.has(group);}
    empty.hidden=!query||found>0;
    if(!query)beforeSearch=null;
  });
}
