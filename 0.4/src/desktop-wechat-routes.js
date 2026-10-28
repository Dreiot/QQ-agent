import {getConfig,updateConfig} from './config.js';import {desktopWechatSettings} from './desktop-wechat.js';
export function desktopWechatRoutes({channel,readBody}){return[
 {method:'GET',pattern:'/api/desktop-wechat',handler:({res,json})=>json(res,200,channel.status())},
 {method:'POST',pattern:'/api/desktop-wechat',handler:async({req,res,json})=>{const body=await readBody(req),allowed=['enabled','groups','privateChats','allowAllPrivateWhenEmpty','imageSendEnabled','allowStickerCdn','allowStickerCdnAlias'];
  for(const k of Object.keys(body))if(!allowed.includes(k))return json(res,400,{error:'不支持的微信设置字段'});
  for(const k of allowed)if(body[k]!==undefined&&(k==='groups'||k==='privateChats'?(!Array.isArray(body[k])||body[k].some(x=>typeof x!=='string')):typeof body[k]!=='boolean'))return json(res,400,{error:'微信设置格式无效'});
  updateConfig({desktopWechat:{...desktopWechatSettings(getConfig()),...body}});await channel.sync();return json(res,200,channel.status());}},
 {method:'POST',pattern:'/api/desktop-wechat/resolve-send',handler:async({req,res,json})=>{const body=await readBody(req);try{return json(res,200,await channel.resolveSend(String(body.id||'')));}catch(e){return json(res,409,{error:e.message});}}}
];}
