import {createIcon,ICON_NAMES} from '../icons.js';
import {ICON_LABELS,ICON_IMAGE_LIMIT,safeIconImage,normalizeIconOverrides} from '../icon-customization.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';

const GROUPS=[
  {id:'navigation',label:'导航',names:['sessions','chats','rules','memory','usage','skills','plugins','logs','settings','community','panel']},
  {id:'actions',label:'操作',names:['search','refresh','plus','close','check','copy','save','trash','undo','link','upload','folder','qrcode','play','pause','menu','arrow']},
  {id:'status',label:'状态',names:['model','shield','globe','activity','info','warning','clock','loading','status-onebot-ready','status-onebot-pending','status-model-ready','status-model-pending']},
  {id:'other',label:'其他',names:[]},
];
const groupOf=name=>GROUPS.find(group=>group.names.includes(name))?.id||'other';
const namesOf=group=>group.id==='other'?ICON_NAMES.filter(name=>groupOf(name)===group.id):group.names.filter(name=>ICON_NAMES.includes(name));
let editorSequence=0;

export function createIconEditor({doc=document,read,change}){
  let life=null,selected='sessions',disposed=false,upload=0;
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
  const button=(label,fn)=>{const b=el('button','',label);b.type='button';b.addEventListener('click',fn);return b;};
  const tab=(label,fn)=>{const item=el('div','icon-editor-tab',label);item.setAttribute('role','tab');item.tabIndex=0;item.addEventListener('click',fn);item.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();item.click();}});return item;};
  const tabKeys=host=>host.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const all=[...host.children],index=all.indexOf(doc.activeElement),next=event.key==='Home'?0:event.key==='End'?all.length-1:(index+(event.key==='ArrowLeft'?-1:1)+all.length)%all.length;all[next].focus();all[next].click();});
  function open(){
    if(disposed||life)return;
    const instance=++editorSequence,values=()=>normalizeIconOverrides(read());
    let category=groupOf(selected),glyphCategory=groupOf(values()[selected]?.glyph||selected);
    const dialog=el('dialog','icon-editor-dialog'),head=el('div','settings-dialog-head'),title=el('h3','','更换图标'),close=button('',()=>life.close());
    close.setAttribute('aria-label','关闭图标设置');close.append(createIcon('close',{size:18}));head.append(title,close);
    const body=el('div','icon-editor-body'),list=el('section','icon-editor-list'),searchWrap=el('div','icon-editor-search'),search=el('input'),categories=el('div','icon-editor-categories'),collection=el('div','icon-editor-collection'),editor=el('section','icon-editor-detail');
    search.type='search';search.placeholder='搜索图标';search.setAttribute('aria-label','搜索图标');search.autocomplete='off';searchWrap.append(createIcon('search',{size:18}),search);
    const cards=new Map(),sections=new Map(),tabs=new Map();
    collection.setAttribute('role','group');collection.setAttribute('aria-label','选择要修改的图标');
    categories.setAttribute('role','tablist');categories.setAttribute('aria-label','图标分类');
    const empty=el('p','icon-editor-empty','没有匹配的图标');empty.setAttribute('role','status');empty.hidden=true;
    list.append(searchWrap,categories,collection,empty);body.append(list,editor);dialog.append(head,body);

    // These are single-choice items, not actions. Ordinary button dimensions
    // must not distort the thumbnail layout when a compact theme is applied.
    function choice({name,label,group,cls,select}){
      const card=el('label',cls),input=el('input');input.type='radio';input.name=group;input.value=name;input.setAttribute('aria-label',label);input.addEventListener('change',()=>{if(input.checked)select(name);});card.append(input);return{card,input};
    }
    function filter(){
      const query=search.value.trim().toLowerCase();let total=0;
      for(const group of GROUPS){let count=0;for(const name of namesOf(group)){const item=cards.get(name),match=query?(ICON_LABELS[name]+' '+name).toLowerCase().includes(query):group.id===category;item.card.hidden=!match;if(match)count++;}const section=sections.get(group.id);section.hidden=!count;section.querySelector('h4').hidden=!query;total+=count;}
      for(const [id,tab]of tabs){tab.setAttribute('aria-selected',String(!query&&id===category));tab.tabIndex=id===category?0:-1;}
      categories.dataset.searching=String(!!query);empty.hidden=total>0;collection.hidden=!total;
    }
    function refresh(){
      const current=values();for(const [name,{card,input}]of cards){input.checked=name===selected;card.dataset.modified=String(!!current[name]);card.title=(ICON_LABELS[name]||name)+(current[name]?' · 已自定义':'');}
      render();
    }
    function commit(value){
      const focused=doc.activeElement?.dataset.glyph,current=values(),scroll=editor.scrollTop;
      if(value)current[selected]=value;else delete current[selected];change(current);refresh();editor.scrollTop=scroll;
      if(focused)editor.querySelector('input[data-glyph="'+focused+'"]')?.focus({preventScroll:true});
    }
    function render(){
      ++upload;editor.replaceChildren();const name=ICON_LABELS[selected]||selected,caption=el('div','icon-editor-caption'),scope=el('small','icon-editor-scope',selected==='emblem'?'仅当前账号':'所有账号共享'),preview=el('div','icon-editor-preview');
      caption.append(el('h4','',name),scope);preview.append(createIcon(selected,{size:64}));preview.setAttribute('aria-label',name+'图标预览');editor.append(caption,preview);
      const actions=el('div','icon-editor-actions'),file=el('input'),pick=button('选择图片',()=>file.click()),reset=button('恢复默认',()=>commit(null)),error=el('p','field-error');
      pick.prepend(createIcon('upload',{size:16}));pick.className='icon-editor-upload';reset.className='icon-editor-reset';file.type='file';file.accept='.png,.jpg,.jpeg,.webp,.gif,.svg';file.hidden=true;file.setAttribute('aria-label','上传图标图片');error.setAttribute('role','alert');error.hidden=true;reset.disabled=!values()[selected];actions.append(pick,reset,file);
      editor.append(actions,error,el('small','icon-editor-file-note','PNG / JPG / WebP / GIF / SVG · 最大 140 KB'));
      file.addEventListener('change',async()=>{const image=file.files?.[0];if(!image)return;const ticket=++upload,key=selected;try{if(image.size>140*1024)throw Error('图标图片过大，请选择 140 KB 以内的文件。');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(image);});if(!life||ticket!==upload||key!==selected)return;if(data.length>ICON_IMAGE_LIMIT||!safeIconImage(data))throw Error('图片格式不可用；SVG 请使用不含脚本或外部引用的纯图形。');commit({image:data});}catch(reason){if(life&&ticket===upload){error.hidden=false;error.textContent=reason.message;}}});
      const glyphHeader=el('div','icon-editor-glyph-head'),glyphTabs=el('div','icon-editor-glyph-tabs'),choices=el('div','icon-editor-glyphs');glyphHeader.append(el('h4','','内置图形'));glyphTabs.setAttribute('role','tablist');glyphTabs.setAttribute('aria-label','内置图形分类');choices.setAttribute('role','group');choices.setAttribute('aria-label','选择内置图形');editor.append(glyphHeader,glyphTabs,choices);
      function renderGlyphs(){
        choices.replaceChildren();const active=values()[selected],currentGlyph=active?.glyph||(!active?.image?selected:'');
        for(const glyph of glyphCategory==='all'?ICON_NAMES:namesOf(GROUPS.find(group=>group.id===glyphCategory))){
          const label=ICON_LABELS[glyph]||glyph,{card,input}=choice({name:glyph,label:'使用'+label+'图形',group:'icon-glyph-'+instance,cls:'icon-editor-glyph',select:glyph=>commit(glyph===selected?null:{glyph})});
          input.dataset.glyph=glyph;input.checked=currentGlyph===glyph;card.title=label;card.append(createIcon(glyph,{size:26,original:true}));choices.append(card);
        }
      }
      for(const group of [...GROUPS,{id:'all',label:'全部'}]){
        const item=tab(group.label,()=>{glyphCategory=group.id;for(const entry of glyphTabs.children){entry.setAttribute('aria-selected',String(entry===item));entry.tabIndex=entry===item?0:-1;}renderGlyphs();});item.setAttribute('aria-selected',String(glyphCategory===group.id));item.tabIndex=glyphCategory===group.id?0:-1;glyphTabs.append(item);
      }
      tabKeys(glyphTabs);
      renderGlyphs();
      const saved=el('small','icon-editor-save-note','修改自动保存');saved.prepend(createIcon('check',{size:14}));editor.append(saved);
    }
    for(const group of GROUPS){
      const section=el('section','icon-editor-section'),heading=el('h4','',group.label),grid=el('div','icon-editor-grid');section.dataset.iconGroup=group.id;section.append(heading,grid);collection.append(section);sections.set(group.id,section);
      const item=tab(group.label,()=>{category=group.id;search.value='';filter();collection.scrollTop=0;});item.setAttribute('aria-controls','icon-section-'+instance+'-'+group.id);section.id='icon-section-'+instance+'-'+group.id;categories.append(item);tabs.set(group.id,item);
      for(const name of namesOf(group)){
        const label=ICON_LABELS[name]||name,{card,input}=choice({name,label:'修改'+label+(label.endsWith('图标')?'':'图标'),group:'icon-target-'+instance,cls:'icon-editor-target',select:name=>{selected=name;glyphCategory=groupOf(values()[name]?.glyph||name);refresh();editor.scrollTop=0;}});
        card.dataset.iconName=name;card.append(createIcon(name,{size:28}),el('span','icon-editor-target-name',label));grid.append(card);cards.set(name,{card,input});
      }
    }
    tabKeys(categories);
    search.addEventListener('input',()=>{filter();collection.scrollTop=0;});search.addEventListener('keydown',event=>{if(event.key==='Escape'&&search.value){event.preventDefault();event.stopPropagation();search.value='';filter();}});
    life=installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed:()=>{life=null;++upload;}});doc.body.append(dialog);filter();refresh();dialog.showModal();search.focus();
  }
  const element=el('div','appearance-icon-entry full'),copy=el('div');copy.append(el('strong','','图标'),el('small','muted','导航、设置、操作与状态图标，均可替换。'));element.append(copy,button('更换图标',open));
  return {element,open,dispose(){disposed=true;life?.close();}};
}
