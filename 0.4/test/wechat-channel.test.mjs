// Isolated fixtures: no real WeChat process, credentials, model or remote messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.QQ_AGENT_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-wx-channel-'));
const {updateConfig,DATA_DIR}=await import('../src/config.js');
const {DesktopWechatChannel}=await import('../src/desktop-wechat.js');
const {ChatStore}=await import('../src/store.js');
const {SendQueue}=await import('../src/sender.js');
const {desktopWechatKey,isDesktopWechatKey}=await import('../src/desktop-wechat-key.js');
const {wechatToolAllowed,guardWechatContext}=await import('../src/wechat-tool-policy.js');
const {registerWechatTools}=await import('../src/wechat-tools.js');
const {getTool,getToolAvailability}=await import('../src/tool-registry.js');
const {wechatMediaRoot}=await import('../src/wechat-db-receiver.js');
const {receivedWechatImage,stageWechatImage}=await import('../src/wechat-images.js');
const {createRoutes}=await import('../src/routes.js');
let channel;
const store=new ChatStore({maxPerChat:200});let calls=0,receipt=true,qqCalls=0;
const database={
  state:{ready:true,connected:true,accountStableId:'fixture-self',accountDirectory:'fixture-self',targets:[{id:'fixture-room@chatroom',name:'Fixture Group',kind:'group'},{id:'fixture-friend',name:'Fixture Friend',kind:'private',friendVerified:true}]},
  configure(){},stop(){},snapshotReceiptBaseline(){return {sequence:calls};},
  async waitForReceipt(){return receipt?{mid:'receipt-'+calls}:null;}
};
const nativeSender={state:{nativeImageSend:true,nativeMentionSend:true},async health(){},async sendText(){calls++;return {submitted:true};},async sendImage(){calls++;return {submitted:true};}};
const incoming=[];
const orchestrator={paused:false,aborted:false,onIncoming:(key,entry)=>incoming.push({key,entry}),drainBacklogAfterResume(){}};
const sender=new SendQueue({store,onebot:new Proxy({},{get:()=>()=>{qqCalls++;throw Error('unexpected QQ call');}})});
const group=()=>Object.keys(channel.state.rooms).find(k=>k.startsWith('group:'));
const privateKey=()=>Object.keys(channel.state.rooms).find(k=>k.startsWith('private:'));
const message=(mid,patch={})=>({mid,ts:Date.now(),receiver:'database',accountStableId:'fixture-self',chatStableId:'fixture-room@chatroom',chatType:'group',senderStableId:'fixture-member',senderName:'Member',text:'fixture text',...patch});
test('stable namespaces, trusted inbound dedupe and shared orchestrator',async()=>{
  updateConfig({desktopWechat:{enabled:true,groups:['Fixture Group'],privateChats:['Fixture Friend']}});
  channel=new DesktopWechatChannel({store,orchestrator,database,nativeSender});sender.desktopWechat=channel;
  await channel.sync();assert.equal(channel.sendAvailable,true);
  channel.ingest(message('m1'));channel.ingest(message('m1'));
  channel.ingest(message('m2',{accountStableId:'other-account'}));
  channel.ingest(message('m3',{chatStableId:'unknown@chatroom'}));
  assert.equal(incoming.length,1);assert.equal(incoming[0].entry.principal.verified,true);
  assert.equal(isDesktopWechatKey(group()),true);assert.equal(isDesktopWechatKey('group:wxdesktop_../bad'),false);
  channel.ingest(message('p1',{chatStableId:'fixture-friend',chatType:'private',senderStableId:'fixture-friend'}));
  assert.equal(incoming.length,2);assert.equal(channel.describeChat(privateKey()).chatType,'private');
  const reopened=new ChatStore();assert.ok(reopened.listChats().includes(group()));
  assert.equal(reopened.findByMid(group(),'m1').principal.id,'fixture-member');
});
test('confirmed native text and @ flow through SendQueue without QQ fallback',async()=>{
  const result=await sender.sendTextBatch(group(),['confirmed text'],{atUserId:'wxdesktop_'+(await import('node:crypto')).createHash('sha256').update('fixture-member').digest('hex').slice(0,32)});
  assert.equal(result.sent.length,1);assert.equal(calls,1);assert.equal(qqCalls,0);
  assert.ok(store.recent(group()).at(-1).text.startsWith('@Member'));
  await assert.rejects(sender.sendSticker(group(),{}),/未接入微信/);
});
test('unknown receipt halts batch and survives restart; no paraphrase retry',async()=>{
  receipt=false;const before=calls;
  await assert.rejects(sender.sendTextBatch(group(),['unknown first','must not submit']),e=>e.sendUncertain&&e.sent.length===0);
  assert.equal(calls,before+1);
  const old=channel;channel=new DesktopWechatChannel({store,orchestrator,database,nativeSender});sender.desktopWechat=channel;old.dispose();await channel.sync();
  await assert.rejects(sender.sendTextBatch(group(),['paraphrased retry']),e=>e.sendUncertain===true);
  assert.equal(calls,before+1);
  const pending=channel.status().pending;assert.equal(pending.length,1);
  await channel.resolveSend(pending[0].id);receipt=true;
});
test('WX tool policy and uncertainty guard do not invoke QQ or another chat',async()=>{
  registerWechatTools();assert.equal(wechatToolAllowed({id:'get_active_members'}),false);
  assert.equal(wechatToolAllowed({id:'custom',skillId:'extension',platforms:['wechat-desktop']}),true);
  assert.equal(getToolAvailability('read_wechat_image',{runtimeContext:{platform:'qq'}}).enabled,false);
  const session={sent:[]};let submits=0;
  const ctx={chatKey:group(),session,sender:{async sendTextBatch(){submits++;throw Object.assign(Error('unknown'),{sendUncertain:true});}},onebot:{}};
  guardWechatContext(ctx);
  await assert.rejects(ctx.sender.sendTextBatch(group(),['one']),/unknown/);
  await assert.rejects(ctx.sender.sendTextBatch(group(),['two']),/本轮已有/);
  await assert.rejects(ctx.sender.sendTextBatch(privateKey(),['three']),/本次会话/);
  assert.equal(submits,1);assert.equal(session.noAutoRetry,true);assert.throws(()=>ctx.onebot.call('send_group_msg'),/不可调用QQ/);
});
test('image bytes and current-chat image reading remain scoped',async()=>{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMmsAAAAASUVORK5CYII=','base64');
  const staged=await stageWechatImage({dataUrl:'base64://'+bytes.toString('base64')});
  assert.ok(staged.startsWith(path.join(DATA_DIR,'desktop-wechat','outbox')));
  fs.mkdirSync(wechatMediaRoot,{recursive:true});const received=path.join(wechatMediaRoot,'fixture.png');fs.writeFileSync(received,bytes);
  channel.ingest(message('image1',{text:'[图片]',media:[{kind:'image',localFile:received,mime:'image/png'}]}));
  const entry=store.findByMid(group(),'image1');assert.equal(receivedWechatImage(entry).content[1].type,'image_url');
  assert.throws(()=>receivedWechatImage({media:[{kind:'image',localFile:staged}]}),/没有可读取/);
  const tool=getTool('read_wechat_image');const foreign=await tool.execute({platform:'wechat-desktop',chatKey:privateKey(),store},{messageId:entry.id});assert.equal(foreign.isError,true);
  updateConfig({desktopWechat:{imageSendEnabled:true}});const result=await sender.sendImage(group(),{dataUrl:'base64://'+bytes.toString('base64')});assert.ok(result.sendConfirmed);
});
test('archive route accepts strict WX and legacy QQ IDs',async()=>{
  const routes=createRoutes({store,desktopWechat:channel,sender,orchestrator,readBody:async()=>({})});
  const filename=group().replace(':','_');const url=new URL('http://127.0.0.1/api/chats/'+filename+'/messages');
  const route=routes.find(r=>r.method==='GET'&&r.pattern instanceof RegExp&&r.pattern.test(url.pathname));assert.ok(route);
  let response;await route.handler({url,match:route.pattern.exec(url.pathname),res:{},json:(_res,status,body)=>{response={status,body};}});
  assert.equal(response.status,200);assert.ok(response.body.messages.length);
  assert.ok(route.pattern.test('/api/chats/group_123456/messages'));
  assert.equal(route.pattern.test('/api/chats/group_wxdesktop_bogus/messages'),false);
});
test('disabled channel touches no database process or native sender',async()=>{
  channel.dispose();let touched=0;updateConfig({desktopWechat:{enabled:false}});
  const disabled=new DesktopWechatChannel({store,orchestrator,database:{state:{},stop(){},configure(){touched++;}},nativeSender:{state:{},async health(){touched++;}}});
  await disabled.sync();assert.equal(touched,0);assert.equal(disabled.status().sendAvailable,false);disabled.dispose();
});
