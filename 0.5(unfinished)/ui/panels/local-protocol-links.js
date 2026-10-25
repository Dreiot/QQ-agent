export const LOCAL_PROTOCOL_RELEASES=Object.freeze({
  'napcat-releases':'https://github.com/NapNeko/NapCatQQ/releases',
  'snowluma-releases':'https://github.com/SnowLuma/SnowLuma/releases',
});
export function localProtocolLoginUrl(value){
  try{
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)return null;
    return url.href;
  }catch{return null;}
}
// The iframe chooses an existing instance, never an arbitrary external URL.
export function localProtocolPageUrl(target,snapshot,id){
  if(Object.hasOwn(LOCAL_PROTOCOL_RELEASES,target))return LOCAL_PROTOCOL_RELEASES[target];
  const running=snapshot?.running;
  if(target!=='local-protocol-login'||!running||running.id!==id||!['starting','running'].includes(running.status)||!['napcat','snowluma'].includes(running.provider))return null;
  return localProtocolLoginUrl(running.webUiUrl);
}
