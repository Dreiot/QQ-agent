import {registerTool} from './tool-registry.js';
import {receivedWechatImage} from './wechat-images.js';
export function registerWechatTools() {
  registerTool({
    id:'read_wechat_image',name:'读取微信图片',category:'vision',requiresVision:true,
    platforms:['wechat-desktop'],
    available:ctx=>ctx.platform==='wechat-desktop',
    description:'读取当前微信会话中已接收的图片或表情。传消息的本地id，不接受文件路径。',
    parameters:{type:'object',properties:{messageId:{type:'integer'}},required:['messageId']},
    async execute(ctx,args) {
      if(ctx.platform!=='wechat-desktop')return {content:'仅用于微信会话',isError:true};
      const entry=ctx.store.recent(ctx.chatKey,{limit:500}).find(m=>m.id===Number(args.messageId)&&!m.self);
      if(!entry)return {content:'当前会话内未找到此消息',isError:true};
      // Retry media decoding only; this never submits or downloads a chat message.
      return receivedWechatImage(entry);
    }
  });
}
