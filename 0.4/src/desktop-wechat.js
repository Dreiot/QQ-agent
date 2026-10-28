// Optional native Windows channel. Reuses the host store/persona/memory/orchestrator.
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {DATA_DIR,getConfig} from './config.js';import {desktopWechatKey,isDesktopWechatKey} from './desktop-wechat-key.js';
import {WechatDatabaseReceiver,trustedWechatMedia} from './wechat-db-receiver.js';import {WechatNativeSender} from './wechat-native-sender.js';
import {resolveWechatMention} from './wechat-message-options.js';
const hash=s=>createHash('sha256').update(String(s)).digest('hex').slice(0,32);
const names=v=>[...new Set((Array.isArray(v)?v:[]).map(String).map(x=>x.trim()).filter(Boolean))];
export function desktopWechatSettings(config=getConfig()){const s=config.desktopWechat||{};return{enabled:s.enabled===true,groups:names(s.groups),privateChats:names(s.privateChats),allowAllPrivateWhenEmpty:s.allowAllPrivateWhenEmpty===true,imageSendEnabled:s.imageSendEnabled===true,allowStickerCdn:s.allowStickerCdn===true,allowStickerCdnAlias:s.allowStickerCdnAlias===true};}
export class DesktopWechatChannel {
  constructor({store,orchestrator,emit=()=>{},log=()=>{},database,nativeSender}={}){
    Object.assign(this,{store,orchestrator,emit,log});this.file=path.join(DATA_DIR,'desktop-wechat/state.json');this.state={rooms:{},pending:{}};
    try{this.state={...this.state,...JSON.parse(fs.readFileSync(this.file,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw Error('微信通道状态不可读，未覆盖原记录');}
    this.native=nativeSender||new WechatNativeSender();this.database=database||new WechatDatabaseReceiver({onMessage:m=>this.ingest(m),onStatus:()=>this.emit('desktop-wechat-status',this.status())});
    this.connected=false;this.sendAvailable=false;this.lastError='';this.tails=new Map();this.syncing=false;this.stopped=false;
    // A process restart never silently retries a previously prepared submission.
    for(const attempt of Object.values(this.state.pending))if(attempt.state==='prepared')attempt.state='uncertain';
  }
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2));fs.renameSync(tmp,this.file);}
  bindRooms(){const db=this.database.state;if(!db.connected||!db.accountStableId)return;this.accountId=hash(db.accountStableId);let changed=false;
    for(const t of db.targets||[]){const key=desktopWechatKey(this.accountId,hash(t.id),t.kind),old=this.state.rooms[key];
      if(!old||old.name!==t.name){this.state.rooms[key]={accountId:this.accountId,stableId:t.id,name:t.name,kind:t.kind,membersByStableId:old?.membersByStableId||{}};changed=true;}}
    if(changed)this.save();
  }
  start(){this.stopped=false;if(this.timer)return;void this.sync();this.timer=setInterval(()=>void this.sync(),2000);this.timer.unref?.();}
  async sync(){if(this.syncing||this.stopped)return;this.syncing=true;
    try{const s=desktopWechatSettings();if(!s.enabled){this.database.stop();this.connected=false;this.sendAvailable=false;return;}
      this.database.configure({...s,allowAllPrivateWhenEmpty:s.allowAllPrivateWhenEmpty&&!s.privateChats.length});this.bindRooms();this.connected=this.database.state.ready===true;
      if(!this.connected){this.sendAvailable=false;return;}const wasReady=this.sendAvailable;
      await this.native.health(this.database.state);if(this.stopped||!desktopWechatSettings().enabled)return;this.sendAvailable=true;this.lastError='';
      if(!wasReady&&!this.orchestrator.paused&&!this.orchestrator.aborted)this.orchestrator.drainBacklogAfterResume?.();
    }catch(error){this.sendAvailable=false;this.lastError=String(error.message).slice(0,200);}finally{this.syncing=false;this.emit('desktop-wechat-status',this.status());}
  }
  isAllowed(key){const room=this.state.rooms[key],s=desktopWechatSettings(),db=this.database.state;return !!(isDesktopWechatKey(key)&&room&&s.enabled&&!this.stopped&&db.ready&&hash(db.accountStableId)===room.accountId&&(db.targets||[]).some(t=>t.id===room.stableId&&t.kind===room.kind));}
  ingest(message){const db=this.database.state,s=desktopWechatSettings();if(!s.enabled||this.stopped||!db.ready||message.receiver!=='database'||message.accountStableId!==db.accountStableId||!message.senderStableId||!String(message.text||'').trim())return;
    const target=(db.targets||[]).find(t=>t.id===message.chatStableId&&t.kind===message.chatType);if(!target)return;
    if(target.friendVerified&&message.senderStableId!==message.chatStableId)return;this.bindRooms();const key=desktopWechatKey(this.accountId,hash(target.id),target.kind),room=this.state.rooms[key];
    if(!message.mid||this.store.findByMid(key,message.mid))return;
    room.membersByStableId[message.senderStableId]=hash(message.senderStableId);this.save();
    const entry=this.store.appendIncoming(key,{mid:message.mid,ts:message.ts,senderId:'wxdesktop_'+hash(message.senderStableId),senderName:message.senderName,text:message.text,
      atMe:typeof message.atMe==='boolean'?message.atMe:null,media:trustedWechatMedia(message.media),principal:{platform:'wechat',id:message.senderStableId,accountId:db.accountStableId,source:'database',verified:true}});
    if(!entry)return;this.emit('chat-update',key);if(this.sendAvailable)this.orchestrator.onIncoming(key,entry);
  }
  describeChat(key){const r=this.state.rooms[key];return r?{chatName:'微信 · '+r.name,chatType:r.kind,platform:'wechat-desktop'}:null;}
  serial(key,run){const old=this.tails.get(key)||Promise.resolve(),next=old.catch(()=>{}).then(run);this.tails.set(key,next);return next.finally(()=>{if(this.tails.get(key)===next)this.tails.delete(key);});}
  async submit(key,body,{type='text',atUserId=null,replyToMessageId=null}={}){return this.serial(key,async()=>{
    if(!this.isAllowed(key)||!this.sendAvailable||this.orchestrator.paused||this.orchestrator.aborted)throw Object.assign(Error('微信此会话尚未就绪或已暂停'),{sendUncertain:false});
    if(replyToMessageId!=null)throw Object.assign(Error('当前微信原生引用未接入，不用拼接文字冒充引用'),{sendUncertain:false});
    const room=this.state.rooms[key],text=type==='text'?resolveWechatMention({key,room,accountId:this.accountId,store:this.store,roster:this.database.state.ownerCandidates||[],atUserId,text:body}):null;
    // Hold this room until the uncertain submission is reconciled, including paraphrases.
    const fingerprint=hash([key,type,text?.text||body].join('\0'));if(Object.values(this.state.pending).some(p=>p.key===key))throw Object.assign(Error('原提交待核对，未重发'),{sendUncertain:true});
    const started=Date.now(),baseline=this.database.snapshotReceiptBaseline(room.stableId);this.state.pending[fingerprint]={id:randomUUID(),key,type,body:text?.text||body,at:started,state:'prepared'};this.save();
    try{const r=type==='text'?await this.native.sendText({targetStableId:room.stableId,text:text.text,database:this.database.state,atUserIds:text.atUserIds}):await this.native.sendImage({targetStableId:room.stableId,file:body,database:this.database.state});
      if(r.submitted!==true)throw Object.assign(Error('后端未提交此消息'),{sendUncertain:false});
      const receipt=await this.database.waitForReceipt(room.stableId,type==='text'?text.text:'',started,type==='image'?30000:10000,type,baseline,{atUserIds:text?.atUserIds||[]});
      if(!receipt)throw Object.assign(Error('已提交但尚未取得新的服务器回执，不重发'),{sendUncertain:true});delete this.state.pending[fingerprint];this.save();return{message_id:receipt.mid,sendConfirmed:true,sentText:text?.text};
    }catch(error){if(error.sendUncertain===false)delete this.state.pending[fingerprint];else{this.state.pending[fingerprint].state='uncertain';error.sendUncertain=true;}this.save();throw error;}
  });}
  sendText(key,text,options){return this.submit(key,String(text),options);}
  sendImage(key,file){if(!desktopWechatSettings().imageSendEnabled)return Promise.reject(Object.assign(Error('微信图片发送未开启'),{sendUncertain:false}));return this.submit(key,file,{type:'image'});}
  async resolveSend(id){const entry=Object.entries(this.state.pending).find(([,v])=>v.id===id);if(!entry)throw Error('记录不存在');delete this.state.pending[entry[0]];this.save();return{resolved:true,resent:false};}
  status(){const db=this.database.state,s=desktopWechatSettings();return{...s,transport:'native-hook',connected:this.connected,readAvailable:db.ready===true,sendAvailable:this.sendAvailable,sendImageAvailable:this.sendAvailable&&s.imageSendEnabled&&this.native.state.nativeImageSend===true,
    lastError:this.lastError||db.lastError||'',database:{ready:db.ready===true,targetCount:db.targetCount||0,unresolvedTargets:db.unresolvedTargets||[]},capabilities:{text:true,images:s.imageSendEnabled,mentions:this.native.state.nativeMentionSend===true,quotes:false},pending:Object.values(this.state.pending).map(({id,key,type,at,state})=>({id,key,type,at,state}))};}
  dispose(){this.stopped=true;clearInterval(this.timer);this.timer=null;this.database.stop();this.connected=false;this.sendAvailable=false;}
}
