// A channel declaration opts a tool in; it does not provide a QQ protocol bridge.
const common = new Set([
  'send_message','send_image','finish','get_recent_messages',
  'memory_append','memory_query','web_search','web_fetch','search_images','read_wechat_image'
]);
export function wechatToolAllowed(tool) {
  return (!tool.skillId && common.has(tool.id))
    || (Array.isArray(tool.platforms) && tool.platforms.includes('wechat-desktop'));
}

export function guardWechatContext(ctx) {
  const sender = ctx.sender;
  const wrap = method => async (chatKey, ...args) => {
    if(chatKey !== ctx.chatKey) throw Error('微信工具只能发送到本次会话');
    if(ctx.session.deliveryUncertain) throw Error('本轮已有发送结果未知，停止后续发送，不改写或重发');
    try { return await sender[method](chatKey,...args); }
    catch(error) {
      if(error.sendUncertain) {
        ctx.session.deliveryUncertain=true;
        ctx.session.noAutoRetry=true;
      }
      for(const part of error.sent || []) {
        if(!part.deduped) ctx.session.sent.push({type:'text',text:part.text,at:part.at});
      }
      throw error;
    }
  };
  ctx.sender = {
    sendTextBatch:wrap('sendTextBatch'),sendImage:wrap('sendImage'),
    sendSticker:async()=>{throw Error('微信尚未接入QQ收藏表情');},
    sendMedia:async()=>{throw Error('微信尚未接入通用QQ媒体段');},
    poke:async()=>{throw Error('微信尚未接入QQ拍一拍');}
  };
  ctx.onebot = new Proxy({}, {get(){return ()=>{throw Error('微信会话不可调用QQ协议');};}});
}
