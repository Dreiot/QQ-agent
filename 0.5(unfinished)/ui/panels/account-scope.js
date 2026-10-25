const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const PRIMARY_ACCOUNT_ID='primary';
export function normalizeAccountId(value){return value==='primary'?'primary':typeof value==='string'&&UUID.test(value)?value.toLowerCase():null;}
export function resolveAccountScope(locationLike=globalThis.location){
  const pathname=String(locationLike?.pathname||'/'),search=String(locationLike?.search||'');
  let id='primary';
  if(pathname.startsWith('/accounts/'))id=normalizeAccountId(pathname.split('/')[2]);
  else if(pathname==='/'||pathname==='/index.html'){
    const params=new URLSearchParams(search);if(params.has('account'))id=params.getAll('account').length===1?normalizeAccountId(params.get('account')):null;
  }
  if(!id)throw Error('账号地址无效，请返回主账号。');
  return Object.freeze({id,base:id==='primary'?'':'/accounts/'+id});
}
// A document never changes account in place. Requests, leases and asset URLs
// retain this identity until the entire shell document is replaced.
export const currentAccountScope=resolveAccountScope();
export const accountStorageKey=(key,scope=currentAccountScope)=>scope.id==='primary'?key:key+'.account.'+scope.id;
export function accountResourceUrl(value,scope=currentAccountScope){
  let raw=String(value??'').trim();if(!raw)return '';
  if(/^https?:\/\//i.test(raw)){
    try{const url=new URL(raw);if(url.origin===globalThis.location?.origin&&/^\/(?:accounts\/|ui\/backgrounds\/|api\/uikit\/background\/)/.test(url.pathname))return accountResourceUrl(url.pathname+url.search+url.hash,scope);}catch{return '';}
    return raw;
  }
  if(raw.startsWith('/accounts/')){
    const match=raw.match(/^\/accounts\/([a-f0-9-]+)(\/.*)$/i);if(!match||normalizeAccountId(match[1])!==scope.id)return '';
    raw=match[2];
  }
  if(raw.startsWith('/api/uikit/background/'))raw=raw.replace('/api/uikit/background/','/ui/backgrounds/');
  if(raw.startsWith('/ui/backgrounds/')||raw.startsWith('/api/'))return scope.base+raw;
  return raw;
}
