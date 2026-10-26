// Shared by the appearance form and the per-element editor. No font files leave the computer.
let catalog=null,pending=null,sequence=0;
export const safeFontName=value=>typeof value==='string'&&value.length<=160&&!/[\x00-\x1f\x7f;{}<>\\]/.test(value)?value.trim():'';
export const fontStack=(name,fallback='sans-serif')=>safeFontName(name)?`${JSON.stringify(name.trim())}, ${fallback}`:null;
export function loadLocalFonts(request,refresh=false){
  if(catalog&&!refresh)return Promise.resolve(catalog);
  if(pending)return pending;
  pending=request('GET',refresh?'/api/ui/fonts/refresh':'/api/ui/fonts').then(result=>{catalog=result;return result;}).finally(()=>{pending=null;});return pending;
}
export function mountFontPicker({doc=document,input,request,onChange,stack=false}){
  const box=doc.createElement('div'),list=doc.createElement('datalist'),note=doc.createElement('small'),refresh=doc.createElement('button');
  box.className='local-font-picker';list.id=`local-fonts-${++sequence}`;input.type='text';input.setAttribute('list',list.id);input.autocomplete='off';input.placeholder||='跟随默认字体';
  refresh.type='button';refresh.textContent='↻';refresh.title='重新读取本机字体';refresh.setAttribute('aria-label','重新读取本机字体');note.className='muted';note.textContent='读取本机字体…';box.append(input,refresh,list,note);
  let disposed=false;
  async function load(force=false){try{const data=await loadLocalFonts(request,force);if(disposed)return;list.replaceChildren(...data.families.map(name=>{const option=doc.createElement('option');option.value=stack?fontStack(name):name;return option;}));note.textContent=data.available?`${data.families.length} 种本机字体 · 输入名称搜索`:data.error;}catch{if(!disposed)note.textContent='可手动输入本机字体名称';}}
  const change=()=>{const valid=!input.value||!!safeFontName(input.value);input.setAttribute('aria-invalid',String(!valid));if(valid){input.style.fontFamily=stack?input.value:fontStack(input.value)||'';onChange?.(input.value.trim());}};
  input.addEventListener('input',change);input.addEventListener('change',change);refresh.addEventListener('click',()=>void load(true));void load();
  return {element:box,dispose(){disposed=true;input.removeEventListener('input',change);input.removeEventListener('change',change);}};
}
