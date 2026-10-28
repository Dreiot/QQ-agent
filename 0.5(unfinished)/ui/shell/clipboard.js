// Copy in the host document: settings frames have an opaque sandbox origin.
export async function writeClipboardText(value,doc=document){
  try{await doc.defaultView.navigator.clipboard.writeText(value);return;}catch{/* Older desktop/browser clipboard implementations use selection. */}
  const active=doc.activeElement,selection=doc.defaultView.getSelection(),ranges=[];
  for(let i=0;i<(selection?.rangeCount||0);i++)ranges.push(selection.getRangeAt(i).cloneRange());
  const field=doc.createElement('textarea');field.value=value;field.readOnly=true;field.setAttribute('aria-hidden','true');field.style.cssText='position:fixed;left:-10000px;top:0;opacity:0;';
  doc.body.append(field);
  try{field.select();if(!doc.execCommand('copy'))throw Error('复制失败，请重试');}
  finally{field.value='';field.remove();active?.focus?.({preventScroll:true});if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}}
}
