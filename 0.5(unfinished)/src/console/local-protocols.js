import {openDataDir} from './route-adapters.js';

export function registerLocalProtocolRoutes(http,{localProtocols,protocolLogin,openProtocolDirectory=openDataDir}={}){
  const available=()=>{if(!localProtocols)throw Object.assign(new Error('当前组合未提供本地协议端管理'),{status:501,expose:true});return localProtocols;};
  http.route('GET','/api/local-protocols',()=>available().snapshot());
  http.route('POST','/api/local-protocols/rescan',()=>available().scan());
  http.route('POST','/api/local-protocols/open-folder',({body,query}={})=>{
    if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)||query&&Object.keys(query).length)throw Object.assign(new Error('打开协议端文件夹不接受自定义路径'),{status:400,expose:true});
    return openProtocolDirectory(available().snapshot().root);
  });
  http.route('POST','/api/local-protocols/start',({body})=>{
    if(body?.deferConnection!==undefined&&typeof body.deferConnection!=='boolean')throw Object.assign(new Error('延后连接设置必须为开关'),{status:400,expose:true});
    return available().launch(body?.id,body?.account,{deferConnection:body?.deferConnection===true});
  });
  http.route('POST','/api/local-protocols/stop',()=>available().stop());
  http.route('POST','/api/local-protocols/settings',({body})=>available().saveSettings(body));
  // Raw initial login output is deliberately not persisted, logged or sent in
  // SSE. Only an authenticated, explicitly opened settings view can read it.
  http.route('GET','/api/local-protocols/output',()=>available().output());
  const login=()=>{if(!protocolLogin)throw Object.assign(new Error('当前组合未提供协议端账号接入'),{status:501,expose:true});return protocolLogin;};
  http.route('GET','/api/local-protocols/login',async({query,res})=>{
    const service=login();let result;
    res?.once('close',()=>{if(!res.writableEnded)service.closeView({sessionId:result?.sessionId||query?.sessionId});});
    result=await service.get(query);
    // A first-open response may arrive after its iframe was removed. It must
    // not leave an unowned native event stream running in the host.
    if(res?.destroyed&&!res.writableEnded)service.closeView({sessionId:result.sessionId});
    return result;
  });
  for(const action of ['connect','refresh','inject','close','visibility']){
    http.route('POST','/api/local-protocols/login/'+action,({body})=>{
      if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.sessionId!=='string'||!body.sessionId||body.sessionId.length>64)throw Object.assign(new Error('账号接入窗口参数无效'),{status:400,expose:true});
      return login()[action==='close'?'closeView':action](body);
    });
  }
}
