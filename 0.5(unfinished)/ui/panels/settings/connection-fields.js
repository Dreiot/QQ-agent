// Runtime addresses can refresh independently of the rest of the settings page.
// Never send an automatic mirror back to the server or overwrite a user's edit.
export function syncEffectiveConnection({form,controls,payload,edited=new Set(),activeElement=null}){
  const state=payload?.onebot??payload,connection=state?.connection;if(!connection)return false;
  const next=structuredClone(form.base);next.onebot??={};let changed=false;
  for(const key of ['wsUrl','httpUrl']){
    const path='onebot.'+key,value=connection[key],control=controls.get(path);
    const pending=[...form.pending.keys()].some(field=>field===path||path.startsWith(field+'.'));
    if(typeof value!=='string'||!value||edited.has(path)||pending||control===activeElement)continue;
    next.onebot[key]=value;if(control&&control.value!==value){control.value=value;changed=true;}
  }
  form.mergeBase(next);return changed;
}
