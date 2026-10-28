export function downloadRule(rule,doc=document){
  let name=String(rule.name??'').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().slice(0,100).replace(/[. ]+$/,'')||'规则';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='QQA-'+name;
  const win=doc.defaultView,url=win.URL.createObjectURL(new win.Blob([JSON.stringify({format:'qqa-management-v1',rule},null,2)],{type:'application/json'})),link=doc.createElement('a');
  link.href=url;link.download=name+'.json';link.hidden=true;doc.body.append(link);
  try{link.click();}finally{link.remove();win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);}
}
