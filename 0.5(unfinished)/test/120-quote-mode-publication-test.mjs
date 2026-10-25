// Contract source: GET https://kondius.cn/qq-agent/holyshits/ on 2026-10-12.
// All CAPTCHA and publication traffic below is synthetic/local. No real submission.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{createRequire}from'node:module';
import{createKernel}from'../src/kernel/kernel.js';
import { isolateConsoleFixture } from './console-fixture-isolation.mjs';
import{QUOTE_ENDPOINT}from'../bundled/community/quote-client.js';
import{RpcBridge}from'../ui/shell/rpc-bridge.js';

const originalWindow=globalThis.window,sent=[],guardCalls=[];
globalThis.window={addEventListener(){},removeEventListener(){}};
const frame={contentWindow:{postMessage:m=>sent.push(m)},addEventListener(){}};
let guardPending;
const guard=new RpcBridge({frame,manifest:{id:'chats',kind:'bundled',api:[{method:'POST',path:'/api/community/quotes'}]},onPublishQuote:async(_,{signal})=>{guardCalls.push(1);await new Promise((resolve,reject)=>{guardPending=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return{ok:true};}});
const event=(method='community.publishQuote')=>({source:frame.contentWindow,origin:'null',data:{jsonrpc:'2.0',id:'120',method,params:{},meta:{panel:guard.manifest.id,nonce:guard.nonce}}});
try{
  for(const [id,kind]of[['chats','user'],['community','bundled'],['settings','bundled']]){guard.manifest.id=id;guard.manifest.kind=kind;await guard.handle(event());assert.equal(sent.at(-1).error.code,-32003);}
  guard.manifest.id='chats';guard.manifest.kind='bundled';
  for(const patch of[e=>e.source={},e=>e.origin='https://evil.invalid',e=>e.data.meta.nonce='forged']){const e=event();patch(e);await guard.handle(e);}
  assert.equal(guardCalls.length,0);
  const pending=guard.handle(event());await new Promise(resolve=>setTimeout(resolve,0));
  await guard.handle(event());assert.equal(sent.at(-1).error.data.httpStatus,409);assert.equal(guardCalls.length,1);
  await guard.handle(event('community.cancelQuotePublish'));await pending;assert.equal(guard.quoteController,null);
}finally{guard.close();if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;}

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-quote120-')),token='quote120-console',remoteCalls=[];
// Keep the actual default provider closure, with no workspace/installed roots.
const isolation = isolateConsoleFixture(dataDir, '120');
if(process.env.QA120_PANEL_SOURCE)fs.copyFileSync(path.resolve(process.env.QA120_PANEL_SOURCE),path.join(isolation.appRoot,'ui/panels/chats/panel.js'));
fs.writeFileSync(path.join(isolation.appRoot, 'package.json'), JSON.stringify({type:'module'}));
fs.cpSync(new URL('../src', import.meta.url), path.join(isolation.appRoot, 'src'), {recursive:true});
for (const name of ["community","market","media-service"]) fs.cpSync(new URL(`../bundled/${name}`, import.meta.url), path.join(isolation.appRoot, 'bundled', name), {recursive:true});
function assertFixtureOwners(active = false) {
  assert.deepEqual(kernel.loader.listEntries().map(entry => entry.id).sort(), ["community","market","media-service"], 'only the actual declared default fixture owners are loaded');
  if (active) {
    for (const id of ["community","market","media-service"]) assert.equal(kernel.loader.isActive(id), true, id);
    assert.deepEqual(kernel.capability.providers('market.client').map(item => item.ownerId), ['market']);
    assert.deepEqual(kernel.capability.providers('community.client').map(item => item.ownerId), ['community']);
    assert.deepEqual(kernel.capability.providers('media.reader').map(item => item.ownerId), ['media-service']);
  }
}
function cleanupFixture() {
  try { isolation.restore(); } finally {
    const relative = path.relative(os.tmpdir(), dataDir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dataDir, {recursive:true, force:true});
  }
}

let remoteStatus=200,holdRemote=null,remoteError='投稿过于频繁，请稍后再试';
const kernel=createKernel({appRoot:isolation.appRoot,env:isolation.env,headless:true,
  transport:{id:'fixture',start(){},stop(){},status:()=>({connected:true}),actions:{}},priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]}),getBlocklist:()=>({ok:true,ids:[]}),listAccounts:()=>({ok:true,accounts:[]})},
  fetchImpl:async(url,init)=>{
    assert.equal(String(url),QUOTE_ENDPOINT,'the real community plugin can only dispatch the fixed quote endpoint');
    remoteCalls.push({url:String(url),init:{...init,signal:undefined},body:JSON.parse(init.body)});
    if(holdRemote)await holdRemote;
    return new Response(JSON.stringify(remoteStatus===200?{ok:true,irrelevant:'never forward upstream metadata'}:{ok:false,error:remoteError}),{status:remoteStatus,headers:{'content-type':'application/json',...(remoteStatus===302?{location:'https://evil.invalid/'}:{})}});
  },
});
kernel.config.update({server:{port:0,token},telemetry:{enabled:false},proactive:{enabled:false},allow:{groups:['123456'],private:[]},api:{apiKey:'private-key120'},security:{mediaRoots:[path.join(dataDir,'media')]}});
kernel.store.appendIncoming('group:123456',{mid:510000,senderId:'678900',senderName:'QA 小李',text:'引用原文',ts:1759999999000});
kernel.store.markAllRead('group:123456');
const first=kernel.store.appendIncoming('group:123456',{mid:510001,senderId:'678901',senderName:'QA 小林',text:'旁观者原话',reply:{mid:510000,sender:'QA 小李',text:'引用原文'},ts:1760000000000});
const bot=kernel.store.appendSelf('group:123456',{mid:510002,text:'机器人原话',ts:1760000001000});
fs.mkdirSync(path.join(dataDir,'media'),{recursive:true});const image=path.join(dataDir,'media','quote.png');fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64'));
const picture=kernel.store.appendSelf('group:123456',{mid:510003,text:'带图发言',media:[{kind:'image',file:image,url:'https://archive.invalid/raw-secret-url'}]});
const corruptImage=path.join(dataDir,'media','corrupt.png');fs.writeFileSync(corruptImage,Buffer.from([137,80,78,71,13,10,26,10,0]));
const brokenPicture=kernel.store.appendSelf('group:123456',{mid:510004,text:'图片读取失败后保留的正文',media:[{kind:'image',file:corruptImage}]});
kernel.loader.startWatchers=()=>{};
let browser,port;
async function api(method,pathname,body){const response=await fetch(`http://127.0.0.1:${port}${pathname}`,{method,headers:{'x-console-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};}
try{
  port=await kernel.start();const base=isolation.allowOrigin(`http://127.0.0.1:${port}`);assertFixtureOwners(true);
  console.log('· Production quote provider validates public-only text fields, proof and media before any outbound call');
  const valid={nickname:'记录者',messages:[{ts:1760000001000,senderName:'机器人',text:'原话',self:true,media:[]}],captchaVerifyParam:'synthetic-proof120'};
  for(const body of[{...valid,captchaVerifyParam:''},{...valid,groupId:'123456'},{...valid,messages:[{...valid.messages[0],senderId:'678901'}]},{...valid,messages:[{...valid.messages[0],media:[{url:'https://evil.invalid/'}]}]}])assert.equal((await api('POST','/api/community/quotes',body)).status,400);
  assert.equal(remoteCalls.length,0);
  remoteStatus=429;remoteError='投稿过于频繁 synthetic-proof120';
  const quota=await api('POST','/api/community/quotes',valid);assert.equal(quota.status,429);assert.doesNotMatch(JSON.stringify(quota.body),/synthetic-proof120/);
  remoteStatus=302;assert.equal((await api('POST','/api/community/quotes',valid)).status,502);assert.equal(remoteCalls.length,2);assert.ok(remoteCalls.every(call=>call.init.redirect==='manual'));
  remoteCalls.length=0;remoteStatus=200;remoteError='投稿过于频繁，请稍后再试';
  const playwright=createRequire(import.meta.url)('playwright-core'),cache=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'ms-playwright');
  const versions=fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??versions.map(version=>path.join(cache,version,'chrome-win64/chrome.exe')).find(file=>fs.existsSync(file));
  browser=await playwright.chromium.launch({executablePath,headless:true});
  const context=await browser.newContext({viewport:{width:960,height:640}}),external=[],localPosts=[],errors=[];
  await context.addInitScript(()=>{window.qa120Messages=[];window.addEventListener('message',event=>window.qa120Messages.push(event.data));});
  const blockedBrowser=[];
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===base)return route.continue();if(request.method()!=='GET'||request.url()!=='https://kondius.cn/qq-agent/captcha-sdk/AliyunCaptcha.js'){blockedBrowser.push(request.url());return route.abort();}
    external.push(route.request().url());
    assert.equal(route.request().url(),'https://kondius.cn/qq-agent/captcha-sdk/AliyunCaptcha.js');
    await route.fulfill({contentType:'text/javascript',body:`window.initAliyunCaptcha=function(o){window.qa120InitCount=(window.qa120InitCount||0)+1;if(window.qa120CaptchaError){o.onError({msg:'local failure'});return;}window.qa120Pass=function(){o.success('synthetic-proof120');};o.getInstance({show:function(){window.qa120Showing=true;},hide:function(){window.qa120Showing=false;},destroyCaptcha:function(){window.qa120Destroyed=(window.qa120Destroyed||0)+1;}});};`});
  });
  context.on('request',request=>{if(request.method()==='POST')localPosts.push(request.url());});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);await page.locator('#nav button[data-panel=chats]').click();
  const panel=page.frameLocator('#panel-host iframe');await panel.locator('#list strong').first().click();await panel.locator(`.message[data-message="${bot.id}"]`).waitFor();
  const check=id=>panel.locator(`.message[data-message="${id}"] input[type=checkbox]`);
  async function preview(ids=[first.id,bot.id]){if(await panel.locator('.selection-toggle').getAttribute('aria-pressed')!=='true')await panel.locator('.selection-toggle').click();for(const checked of await panel.locator('.message input:checked').all())if(!ids.map(String).includes(await checked.inputValue()))await checked.uncheck();for(const id of ids)await check(id).check();await panel.locator('#quote-preview').click();await panel.locator('dialog.quote-dialog').waitFor();}
  async function cancelRequests(){return page.evaluate(()=>window.qa120Messages.filter(message=>message?.method==='community.cancelQuotePublish').length);}
  console.log('· Unified selection previews reviewed messages and forbids deletion while the preview is open');
  await panel.getByRole('button',{name:'选择消息',exact:true}).click();await check(picture.id).check();
  await preview();assert.equal(await check(picture.id).isChecked(),false);
  assert.equal(await panel.getByRole('button',{name:'删除选中消息',exact:true}).isDisabled(),true);
  await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await panel.locator('.quote-feedback').filter({hasText:'昵称必填'}).waitFor();
  assert.equal(remoteCalls.length,0);assert.equal(external.length,0);
  assert.equal(await panel.locator('dialog textarea').first().inputValue(),'引用 QA 小李：引用原文\n\n旁观者原话');
  console.log('· Same-stack cancellation detaches before reopening and a stale close event cannot remove the fresh local preview');
  const immediateReopen=await panel.locator('body').evaluate(()=>{
    const previous=document.querySelector('dialog.quote-dialog');
    [...previous.querySelectorAll('button')].find(button=>button.textContent==='取消').click();
    const oldDisconnected=!previous.isConnected,remainingAfterCancel=document.querySelectorAll('dialog.quote-dialog').length;
    document.querySelector('#quote-preview').click();
    const fresh=document.querySelector('dialog.quote-dialog');previous.dispatchEvent(new Event('close'));
    return{oldDisconnected,remainingAfterCancel,reopenedCount:document.querySelectorAll('dialog.quote-dialog').length,fresh:!!fresh&&fresh!==previous,open:fresh?.open===true,nickname:fresh?.querySelector('[name=nickname]').value,mode:document.querySelector('.selection-toggle').getAttribute('aria-pressed'),staleCloseKeptFresh:!!fresh&&fresh.isConnected};
  });
  assert.deepEqual(immediateReopen,{oldDisconnected:true,remainingAfterCancel:0,reopenedCount:1,fresh:true,open:true,nickname:'',mode:'true',staleCloseKeptFresh:true});
  assert.equal(remoteCalls.length,0);assert.equal(external.length,0);assert.equal(localPosts.filter(url=>url.endsWith('/api/community/quotes')).length,0);assert.equal(await cancelRequests(),0);
  await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(remoteCalls.length,0);
  await panel.locator('.selection-toggle').click();
  // Exiting selection clears its checked messages. Deletion still requires a
  // new nonempty selection after the user returns.
  assert.equal(await panel.locator('.delete-selection').isHidden(),true);assert.equal(await panel.locator('.delete-selection').isDisabled(),true);assert.equal(await check(bot.id).isVisible(),false);
  await panel.getByRole('button',{name:'选择消息',exact:true}).click();await check(bot.id).check();assert.equal(await panel.getByRole('button',{name:'删除选中消息',exact:true}).isEnabled(),true);
  await panel.getByRole('button',{name:'取消选择',exact:true}).click();assert.equal(await panel.locator('.delete-selection').isHidden(),true);assert.equal(await panel.locator('.delete-selection').isDisabled(),true);
  await preview([first.id]);await panel.locator('dialog input[name=nickname]').fill('记录者');await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await panel.locator('.quote-feedback').filter({hasText:'至少选择一条机器人'}).waitFor();assert.equal(external.length,0);await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();await panel.locator('.selection-toggle').click();

  console.log('· Reviewed cache images become publishable; raw source references stay local and preview does not submit');
  await preview([picture.id]);await panel.locator('dialog img').waitFor();assert.match(await panel.locator('dialog img').getAttribute('src'),/^data:image\//);
  await panel.locator('.quote-restriction').filter({hasText:'已保留 1 张图片'}).waitFor();assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isEnabled(),true);
  await panel.locator('.quote-restriction').scrollIntoViewIfNeeded();fs.mkdirSync('.shots',{recursive:true});await page.screenshot({path:'.shots/quote-120-media-preview.png'});
  assert.equal(remoteCalls.length,0);assert.equal(external.length,0);await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();await panel.locator('.selection-toggle').click();

  console.log('· CAPTCHA cancellation destroys the instance; even a late success callback cannot publish');
  await preview();await panel.locator('dialog input[name=nickname]').fill('记录者');await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);
  assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isDisabled(),true);
  const cancelsBeforeBusy=await cancelRequests();await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await panel.locator('dialog').count(),0);await page.waitForFunction(()=>window.qa120Showing===false);assert.equal(await cancelRequests(),cancelsBeforeBusy+1);await page.evaluate(()=>window.qa120Pass());
  assert.equal(remoteCalls.length,0);assert.equal(localPosts.filter(url=>url.endsWith('/api/community/quotes')).length,0);assert.equal(await page.locator('[id^=public-captcha-]').count(),0);

  console.log('· The real route/service/SDK path sends one reviewed, anonymous text payload; proof stays in the host');
  await panel.locator('#quote-preview').waitFor({state:'visible'});await preview();
  await panel.locator('dialog input[name=nickname]').fill('记录者');await panel.locator('dialog input[name=sender-0]').fill('旁观者');await panel.locator('dialog textarea[name=text-0]').fill('确认后的引用与原话');
  let release;holdRemote=new Promise(resolve=>{release=resolve;});
  await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);await page.evaluate(()=>window.qa120Pass());
  for(let i=0;i<200&&remoteCalls.length!==1;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(remoteCalls.length,1);assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isDisabled(),true);
  const payload=remoteCalls[0].body;assert.deepEqual(payload,{nickname:'记录者',messages:[{ts:1760000000000,senderName:'旁观者',text:'确认后的引用与原话',self:false,media:[]},{ts:1760000001000,senderName:'机器人',text:'机器人原话',self:true,media:[]}],captchaVerifyParam:'synthetic-proof120'});
  assert.equal(remoteCalls[0].init.redirect,'manual');assert.deepEqual(Object.keys(remoteCalls[0].init.headers).sort(),['accept','content-type']);
  assert.doesNotMatch(JSON.stringify(remoteCalls),/123456|678901|51000[123]|raw-secret-url|quote120-console|private-key120|senderId|groupId|chatKey|"id"/);
  assert.doesNotMatch(await panel.locator('body').evaluate(()=>JSON.stringify(window.qa120Messages)),/synthetic-proof120|quote120-console|private-key120/);
  const cancelsBeforeSuccess=await cancelRequests();release();holdRemote=null;await panel.locator('#quote-status').filter({hasText:'文字金句已提交'}).waitFor();assert.equal(await panel.locator('dialog').count(),0);assert.equal(await panel.locator('.selection-toggle').getAttribute('aria-pressed'),'false');assert.equal(await cancelRequests(),cancelsBeforeSuccess);

  console.log('· Real successful publication detaches within its completion task, exits selection and can immediately reopen without a stale close or extra cancel');
  await preview([bot.id]);await panel.locator('dialog input[name=nickname]').fill('同栈测试');
  let releaseSuccess;holdRemote=new Promise(resolve=>{releaseSuccess=resolve;});
  await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);await page.evaluate(()=>window.qa120Pass());
  for(let i=0;i<200&&remoteCalls.length!==2;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(remoteCalls.length,2);
  assert.deepEqual(remoteCalls[1].body,{nickname:'同栈测试',messages:[{ts:1760000001000,senderName:'机器人',text:'机器人原话',self:true,media:[]}],captchaVerifyParam:'synthetic-proof120'});
  await panel.locator('body').evaluate((body,botId)=>{
    const previous=document.querySelector('dialog.quote-dialog'),status=document.querySelector('#quote-status');
    window.qa120SuccessCleanup=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error(`Success cleanup probe timed out: ${status.textContent}; dialogs=${document.querySelectorAll('dialog.quote-dialog').length}`));},8000);
      const observer=new MutationObserver(()=>{
        if(status.textContent!=='文字金句已提交')return;
        observer.disconnect();clearTimeout(timer);
        try{
        const oldDisconnected=!previous.isConnected,remainingAfterSuccess=document.querySelectorAll('dialog.quote-dialog').length,exited=document.querySelector('.selection-toggle').getAttribute('aria-pressed')==='false';
        document.querySelector('.selection-toggle').click();
        const check=document.querySelector(`.message[data-message="${botId}"] input[type=checkbox]`);check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
        document.querySelector('#quote-preview').click();
        const fresh=document.querySelector('dialog.quote-dialog');previous.dispatchEvent(new Event('close'));
        resolve({oldDisconnected,remainingAfterSuccess,exited,reopenedCount:document.querySelectorAll('dialog.quote-dialog').length,fresh:!!fresh&&fresh!==previous&&fresh.isConnected,open:fresh?.open===true,nickname:fresh?.querySelector('[name=nickname]').value,staleCloseKeptFresh:!!fresh&&fresh.isConnected});
        }catch(error){reject(error);}
      });observer.observe(status,{childList:true,subtree:true});
    });
  },bot.id);
  releaseSuccess();holdRemote=null;
  assert.deepEqual(await panel.locator('body').evaluate(()=>window.qa120SuccessCleanup),{oldDisconnected:true,remainingAfterSuccess:0,exited:true,reopenedCount:1,fresh:true,open:true,nickname:'',staleCloseKeptFresh:true});
  assert.equal(await cancelRequests(),cancelsBeforeSuccess);assert.equal(localPosts.filter(url=>url.endsWith('/api/community/quotes')).length,2);
  await panel.locator('dialog').press('Escape');assert.equal(await panel.locator('dialog').count(),0);assert.equal(await cancelRequests(),cancelsBeforeSuccess);

  console.log('· Real upstream 429 and disabled provider errors remain visible with drafts preserved; failed CAPTCHA never submits');
  remoteStatus=429;await preview([bot.id]);await panel.locator('dialog input[name=nickname]').fill('保留草稿');await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);await page.evaluate(()=>window.qa120Pass());await panel.locator('.quote-feedback').filter({hasText:'过于频繁'}).waitFor();assert.equal(await panel.locator('dialog input[name=nickname]').inputValue(),'保留草稿');assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isEnabled(),true);assert.equal(remoteCalls.length,3);
  await page.evaluate(()=>{window.qa120CaptchaError=true;});await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await panel.locator('.quote-feedback').filter({hasText:'初始化失败'}).waitFor();assert.equal(remoteCalls.length,3);
  await kernel.loader.setEnabled('community',false);assert.equal((await api('GET','/api/community/quotes/status')).status,503);const initCount=await page.evaluate(()=>window.qa120InitCount);await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await panel.locator('.quote-feedback').filter({hasText:'未提供该能力'}).waitFor();assert.equal(remoteCalls.length,3);assert.equal(await page.evaluate(()=>window.qa120InitCount),initCount);assert.equal(await panel.locator('dialog input[name=nickname]').inputValue(),'保留草稿');
  await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();await panel.locator('.selection-toggle').click();

  console.log('· The real image preview/RPC/service path submits exact reviewed pixels, never QQ coordinates or proof to the iframe');
  await kernel.loader.setEnabled('community',true);remoteStatus=200;
  await page.evaluate(()=>{window.qa120CaptchaError=false;});await preview([picture.id]);
  await panel.locator('.quote-restriction').filter({hasText:'已保留 1 张图片'}).waitFor();
  const reviewedImage=await panel.locator('dialog img').getAttribute('src');
  await panel.locator('dialog input[name=nickname]').fill('含图合成收录者');
  await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);assert.equal(remoteCalls.length,3);
  await page.evaluate(()=>window.qa120Pass());await panel.locator('#quote-status').filter({hasText:'含图金句已提交'}).waitFor();
  assert.equal(remoteCalls.length,4);assert.deepEqual(remoteCalls[3].body,{nickname:'含图合成收录者',messages:[{ts:picture.ts,senderName:'机器人',text:'带图发言',self:true,media:[{kind:'image',url:'',file:'',dataUrl:reviewedImage}]}],captchaVerifyParam:'synthetic-proof120'});
  assert.doesNotMatch(JSON.stringify(remoteCalls[3].body),/raw-secret-url|archive\.invalid|123456|510003|senderId|groupId|chatKey|quote\.png/);
  assert.doesNotMatch(await panel.locator('body').evaluate(()=>JSON.stringify(window.qa120Messages)),/synthetic-proof120|quote120-console|private-key120/);
  assert.equal(await panel.locator('dialog').count(),0);
  console.log('· A corrupt picture blocks publication until the user explicitly removes it; cancellation preserves zero outbound change');
  await preview([brokenPicture.id]);await panel.locator('.quote-media').filter({hasText:'无法解码'}).waitFor();
  assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isDisabled(),true);assert.equal(remoteCalls.length,4);
  const removeMedia=await panel.locator('dialog').getByRole('button',{name:'移除此素材',exact:true}).elementHandle();
  assert.equal(await removeMedia.getAttribute('data-danger-clicks'),'2');await removeMedia.click();
  assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isDisabled(),true);
  assert.equal(await panel.locator('dialog.confirm-panel').count(),0);assert.equal(remoteCalls.length,4);await removeMedia.click();
  assert.equal(await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).isEnabled(),true);assert.equal(await panel.locator('dialog img').count(),0);
  assert.equal(await panel.locator('dialog textarea').inputValue(),'图片读取失败后保留的正文');
  await panel.locator('dialog input[name=nickname]').fill('不提交的草稿');await panel.locator('dialog').getByRole('button',{name:'确认公开发布'}).click();await page.waitForFunction(()=>window.qa120Showing===true);
  await panel.locator('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>window.qa120Showing===false);await page.evaluate(()=>window.qa120Pass());assert.equal(remoteCalls.length,4);
  await panel.locator('.selection-toggle').click();
  assert.equal(await panel.locator('body').evaluate(body=>Math.max(body.scrollWidth,body.ownerDocument.documentElement.scrollWidth)-body.ownerDocument.documentElement.clientWidth),0);assert.deepEqual(errors,[]);assert.deepEqual(blockedBrowser,[]);isolation.assertOffline();assertFixtureOwners();
  console.log('✓ 120 Local text/image quote publication, pixel/coordinate boundary, explicit failed-image removal, CAPTCHA isolation/lifecycle, duplicate guard, quota failure and provider shutdown passed');
}finally{try{await browser?.close();await kernel.stop();}finally{cleanupFixture();}}
