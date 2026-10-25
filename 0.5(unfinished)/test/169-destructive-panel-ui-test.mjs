import {settingsSection,settingsEditor,settingsProvider} from './settings-navigation.mjs';
// Real shell + opaque bundled iframes; every destructive API is intercepted.
// Only a synthetic temporary kernel on a system-assigned port is reachable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createKernel} from '../src/kernel/kernel.js';
import {CONSOLE_SESSION_KEY,CONSOLE_SESSION_TTL_MS} from '../ui/shell/console-auth.js';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-destructive169-')),appRoot=path.join(dataDir,'application');
fs.mkdirSync(appRoot);fs.cpSync(path.join(sourceRoot,'ui'),path.join(appRoot,'ui'),{recursive:true});
for(const name of ['bundled','plugins','skills'])fs.mkdirSync(path.join(appRoot,name));
const token='synthetic-console169',chatKey='group:169',routeKey='group_169';
const errors=[],dialogs=[],requests=[],intercepted=[],outboundRequests=[];
let browser,base,outbound=0;
const kernel=createKernel({appRoot,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_PORT:'0',QQ_AGENT_MIGRATE_FROM:path.join(dataDir,'absent-migration-source')},headless:true,
  transport:{id:'inert169',start(){},stop(){},status:()=>({connected:false}),actions:{listGroups:async()=>[],listFriends:async()=>[]}},
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]}),getBlocklist:()=>({ok:true,ids:[]}),listAccounts:()=>({ok:true,accounts:[]})},
  fetchImpl:async()=>{outbound++;throw new Error('QA169 outbound networking disabled');}});
kernel.log.setLevel('error');kernel.loader.startWatchers=()=>{};
kernel.config.update({server:{port:0,token},telemetry:{enabled:false},proactive:{enabled:false},ui:{refreshMs:15000,uikit:{mode:'dark',dark:{bg:'#191919',accent:'#ff8800'},light:null,custom:{}}},
  api:{baseUrl:'https://invalid.example/v1',apiKey:'synthetic-secret169',model:'synthetic-model169'},allow:{groups:['169']},allowAllWhenEmpty:true,providers:[{id:'qa-provider169',displayName:'QA Provider169',baseURL:'https://invalid.example/v1',models:['synthetic-model169']}]});
const finished=kernel.sessions.create(chatKey);kernel.sessions.finish(finished.id,'done');
const pending=kernel.sessions.create(chatKey);
for(let id=1;id<=3;id++)kernel.store.appendIncoming(chatKey,{mid:16900+id,senderId:'16901',senderName:'合成成员169',text:`QA169 消息 ${id}`,ts:Date.now()+id});
kernel.memory.append(chatKey,{userId:'16901',name:'合成成员169',content:'只用于临时交互测试的成员印象'});
const originalMessages=()=>fs.readFileSync(path.join(dataDir,'messages',`${routeKey}.json`),'utf8');
const originalMemory=()=>fs.readFileSync(path.join(dataDir,'memory',routeKey,'16901.json'),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=10000){const deadline=Date.now()+timeout;do{if(await predicate())return;await delay(15);}while(Date.now()<deadline);assert.fail(message);}
function chromiumExecutable(playwright){
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const roots=[path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'ms-playwright'),path.join(os.homedir(),'.cache','ms-playwright'),path.join(os.homedir(),'Library','Caches','ms-playwright')];
  for(const root of roots){let versions;try{versions=fs.readdirSync(root).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));}catch{continue;}
    for(const version of versions)for(const relative of ['chrome-win64/chrome.exe','chrome-win/chrome.exe','chrome-linux64/chrome','chrome-linux/chrome','chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium','chrome-mac/Chromium.app/Contents/MacOS/Chromium']){const candidate=path.join(root,version,relative);if(fs.existsSync(candidate))return candidate;}}
  const candidate=playwright.chromium.executablePath();assert.ok(fs.existsSync(candidate),'Use installed Chromium; never download a browser');return candidate;
}
const isDestructive=request=>request.method==='DELETE'||request.method==='POST'&&(/\/(clear|clear-finished|delete-messages|reset-data)$/.test(request.path)||request.path==='/api/providers/set-key');
const requestCount=(method,pathname)=>requests.filter(request=>request.method===method&&request.path===pathname).length;
const settingsSaveCount=()=>requestCount('POST','/api/config')+requestCount('POST','/api/config/lifecycle');
const progress=async button=>Number(await button.getAttribute('data-danger-progress'));
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<.025,`${label}: expected ${expected}, got ${actual}`);
async function saveShot(page,name){const directory=path.resolve(process.env.QA_SCREENSHOT_DIR||path.join(sourceRoot,'.qa-local/destructive-ui-20261016/integration'));fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,`${name}.png`),fullPage:true,animations:'disabled'});}

try{
  base=`http://127.0.0.1:${await kernel.start()}`;
  assert.notEqual(new URL(base).port,'15967');assert.deepEqual(kernel.loader.listEntries(),[]);
  const messagesBefore=originalMessages(),memoryBefore=originalMemory();
  const playwright=createRequire(import.meta.url)('playwright-core');
  browser=await playwright.chromium.launch({executablePath:chromiumExecutable(playwright),headless:process.env.QA_HEADLESS!=='0'});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(({origin,key,token,ttl})=>{if(window.top===window&&location.origin===origin)sessionStorage.setItem(key,JSON.stringify({version:1,origin,token,expiresAt:Date.now()+ttl}));},{origin:base,key:CONSOLE_SESSION_KEY,token,ttl:CONSOLE_SESSION_TTL_MS});
  await context.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();outboundRequests.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push(dialog.type());void dialog.dismiss();});
  page.on('request',request=>requests.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postData()}));
  // Destructive requests never reach even this disposable backend. A reset is
  // an accepted mock receipt, so no restart marker or real backup is created.
  await page.route('**/api/**',async route=>{
    const request=route.request(),entry={method:request.method(),path:new URL(request.url()).pathname,body:request.postData()};
    if(!isDestructive(entry))return route.continue();intercepted.push(entry);
    const json=entry.path==='/api/reset-data'?{ok:true,phase:'accepted',resetAccepted:true,resetCompleted:false,restartRequired:true,backupDir:'QA169-MOCK-BACKUP',message:'QA169 已接受模拟重置，等待重启完成'}:{ok:true,removed:1};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(json)});
  });
  await page.goto(base);await page.locator('#nav button[data-panel=sessions]').waitFor();
  const frame=()=>page.frameLocator('#panel-host iframe');
  const actualFrame=()=>page.frames().find(item=>item.url().includes('/panels/')&&item!==page.mainFrame());
  async function navigate(panel){await page.locator(`#nav button[data-panel=${panel}]`).click();await frame().locator(`body[data-panel=${panel}]`).waitFor();}
  async function noConfirmation(){assert.equal(await frame().locator('dialog.confirm-panel[open]').count(),0);assert.equal(await page.locator('dialog.confirm-panel[open]').count(),0);assert.deepEqual(dialogs,[]);}
  async function threshold(button,{clicks,method,pathname,afterClick,beforeFinal,label=pathname}){
    const before=requestCount(method,pathname);
    for(let index=1;index<clicks;index++){
      await button.click();await delay(20);near(await progress(button),index/clicks,`${label} click ${index}`);
      assert.equal(requestCount(method,pathname),before,`${label} must not send before click ${clicks}`);await noConfirmation();await afterClick?.(index);
    }
    await beforeFinal?.();await button.click();await until(()=>requestCount(method,pathname)===before+1,`${label} must send on click ${clicks}`);await noConfirmation();
    await delay(25);assert.equal(requestCount(method,pathname),before+1,`${label} must issue only one request`);
  }
  await frame().locator(`[data-session="${finished.id}"]`).waitFor();
  assert.equal(await page.locator('#panel-host iframe').getAttribute('sandbox'),'allow-scripts');
  assert.equal(await actualFrame().evaluate(()=>{try{localStorage.getItem('qa169');return 'accessible';}catch{return 'opaque';}}),'opaque');
  await frame().locator('#follow').uncheck();
  await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));

  console.log('· Sessions: a half-filled row survives SSE; 500ms grace and linear decay never send a request');
  await frame().locator(`[data-session="${finished.id}"] strong`).click();
  const sessionDelete=frame().locator('#detail').getByRole('button',{name:'删除',exact:true});await sessionDelete.waitFor();
  await sessionDelete.click();near(await progress(sessionDelete),.5,'single session half progress');
  assert.equal(await frame().locator('#detail > .danger-wash').count(),1);await noConfirmation();
  await saveShot(page,'session-half-progress');
  const sessionControl=await sessionDelete.elementHandle();
  await actualFrame().evaluate(id=>{window.qa169SessionEventObserved=false;const listener=event=>{const m=event.data;if(m?.method==='shell.event'&&m.params?.name==='session-update'&&(m.params.payload?.sessionId??m.params.payload?.id)===id){window.removeEventListener('message',listener);window.qa169SessionEventObserved=true;}};window.addEventListener('message',listener);},finished.id);
  const detailReads=requestCount('GET',`/api/sessions/${finished.id}`);kernel.bus.emit('session.update',{sessionId:finished.id,status:'done'});
  await until(()=>actualFrame().evaluate(()=>window.qa169SessionEventObserved),'session SSE must reach the real panel before advancing its paused clock');
  const sseElapsed=90;await page.clock.runFor(sseElapsed);
  await until(()=>requestCount('GET',`/api/sessions/${finished.id}`)>detailReads,'session SSE must refresh the live detail');await delay(30);
  assert.equal(await sessionControl.evaluate(node=>node.isConnected),true);near(await progress(sessionDelete),.5,'SSE preserves session progress');
  await page.clock.runFor(500-sseElapsed);near(await progress(sessionDelete),.5,'500ms grace');await page.clock.runFor(375);near(await progress(sessionDelete),.25,'linear decay');await page.clock.runFor(500);
  near(await progress(sessionDelete),0,'progress decays to zero');assert.equal(requestCount('DELETE',`/api/sessions/${finished.id}`),0);
  await threshold(sessionDelete,{clicks:2,method:'DELETE',pathname:`/api/sessions/${finished.id}`});
  await frame().locator(`[data-session="${pending.id}"] strong`).click();await frame().locator(`#detail[data-session-id="${pending.id}"] h3`).waitFor();
  await threshold(frame().locator('#clear'),{clicks:4,method:'POST',pathname:'/api/sessions/clear-finished'});
  assert.equal(await frame().locator('#detail').getAttribute('data-session-id'),pending.id,'clearing finished sessions preserves the selected pending session');
  assert.equal(await frame().locator('#detail .session-body').count(),1,'the preserved selection must still have its actual detail body');

  console.log('· Chats: archive clearing needs four clicks; selection changes reset its independent two-click action');
  await navigate('chats');const chatRow=frame().locator(`[data-chat=${routeKey}]`);await chatRow.locator('strong').click();await frame().locator('.messages [data-message="1"]').waitFor();
  const clearChat=chatRow.getByRole('button',{name:'清空',exact:true}),chatControl=await clearChat.elementHandle();
  await threshold(clearChat,{clicks:4,method:'POST',pathname:`/api/chats/${routeKey}/clear`,afterClick:async index=>{if(index!==1)return;const reads=requestCount('GET','/api/chats');kernel.bus.emit('chat.update',chatKey);await page.clock.runFor(90);await until(()=>requestCount('GET','/api/chats')>reads,'chat SSE must refresh the list');await delay(20);assert.equal(await chatControl.evaluate(node=>node.isConnected),true);near(await progress(clearChat),.25,'chat refresh preserves row progress');}});
  await frame().getByRole('button',{name:'选择消息',exact:true}).click();
  const firstCheck=frame().locator('.messages input[value="1"]'),secondCheck=frame().locator('.messages input[value="2"]'),removeSelected=frame().getByRole('button',{name:'删除选中消息',exact:true});
  await firstCheck.check();await removeSelected.click();near(await progress(removeSelected),.5,'selected message progress');
  assert.equal(await frame().locator('[data-message="1"] > .danger-wash').count(),1);await secondCheck.check();near(await progress(removeSelected),0,'new selection clears prior progress');
  assert.equal(requestCount('POST',`/api/chats/${routeKey}/delete-messages`),0);await secondCheck.uncheck();
  await threshold(removeSelected,{clicks:2,method:'POST',pathname:`/api/chats/${routeKey}/delete-messages`});
  assert.deepEqual(JSON.parse(requests.find(request=>request.path===`/api/chats/${routeKey}/delete-messages`&&request.method==='POST').body),{ids:[1]});
  const unauthorized=await actualFrame().evaluate(async()=>{const{rpc}=await import('/panels/panel-client.js');try{await rpc('ui.destructiveProgress',{progress:.75});return{allowed:true};}catch(error){return{allowed:false,code:error.code,message:error.message};}});
  assert.equal(unauthorized.allowed,false);assert.match(unauthorized.message,/此面板不能/);assert.equal(await page.locator('.destructive-window-wash').count(),0,'a correctly authenticated non-settings panel cannot tint its host');

  console.log('· Memory: entity controls survive refresh; member deletion needs two and whole-chat clearing four clicks');
  await navigate('memory');const memoryRow=frame().locator(`[data-memory-chat="${chatKey}"]`);await memoryRow.locator('strong').click();
  const member=frame().locator('[data-member="16901"]'),memberDelete=member.getByRole('button',{name:'删除成员',exact:true});await memberDelete.waitFor();const memberControl=await memberDelete.elementHandle();
  await threshold(memberDelete,{clicks:2,method:'DELETE',pathname:`/api/memory-files/${routeKey}/members/16901`,afterClick:async()=>{const reads=requestCount('GET',`/api/memory-files/${routeKey}`);await actualFrame().evaluate(async()=>{window.qa169MemoryEventObserved=false;const {onShellEvent}=await import('/panels/panel-client.js');const off=onShellEvent(name=>{if(name==='memory-update'){window.qa169MemoryEventObserved=true;off();}});});kernel.bus.emit('memory.update',{chatKey});await until(()=>actualFrame().evaluate(()=>window.qa169MemoryEventObserved),'memory SSE must arrive before advancing the paused clock');await page.clock.runFor(90);await until(()=>requestCount('GET',`/api/memory-files/${routeKey}`)>reads,'memory SSE must refresh member cards');await delay(25);assert.equal(await memberControl.evaluate(node=>node.isConnected),true);near(await progress(memberDelete),.5,'memory refresh preserves member progress');}});
  await threshold(memoryRow.getByRole('button',{name:'删除',exact:true}),{clicks:4,method:'DELETE',pathname:`/api/memory-files/${routeKey}`});

  console.log('· Settings: provider deletion needs four clicks and secret clearing three, with no confirmation dialog');
  await navigate('settings');await frame().locator('#settings-sidebar a[data-target=models]').waitFor();
  await settingsEditor(frame(),'model-manager');
  const provider=frame().locator('#provider-list article').filter({hasText:'QA Provider169'});
  await threshold(provider.locator('.provider-detail-head').getByRole('button',{name:'删除渠道',exact:true}),{clicks:4,method:'DELETE',pathname:'/api/providers'});
  await settingsProvider(frame(),'qa-provider169');
  // This fixture keeps the secret in direct mode; seed a synthetic channel key
  // through the real config store before checking its independent clear action.
  kernel.config.update({dshProviderKeys:{'qa-provider169':'synthetic-channel169'}});await frame().locator('dialog[data-settings-editor=model-manager]').press('Escape');await frame().locator('#reload').click();await page.clock.runFor(90);await settingsEditor(frame(),'model-manager');
  await provider.locator('[data-manager-key=set]').waitFor();
  await threshold(provider.getByRole('button',{name:'清除密钥',exact:true}),{clicks:3,method:'POST',pathname:'/api/providers/set-key'});
  await settingsSection(frame(),'uikit');
  const configBefore=settingsSaveCount(),themeReset=frame().getByRole('button',{name:'恢复当前预设出厂',exact:true});
  for(let index=1;index<=2;index++){await themeReset.click();near(await progress(themeReset),index/3,'theme reset progress');assert.equal(settingsSaveCount(),configBefore);await noConfirmation();}
  await themeReset.click();await page.clock.runFor(1000);await until(()=>settingsSaveCount()===configBefore+1,'theme reset must save after its third click');
  await until(()=>kernel.config.get().ui?.uikit?.dark===null,'theme reset only updates synthetic configuration');await noConfirmation();

  console.log('· Full reset: five clicks tint the entire real shell, leaving clears it, and only the sixth submits a mocked accepted receipt');
  async function openReset(){await settingsSection(frame(),'desktop');const fold=frame().locator('[data-settings-group=layout-data]');if(!await fold.evaluate(node=>node.open)){await fold.locator(':scope > summary').click();await page.clock.runFor(250);}}
  await openReset();const reset=frame().locator('#reset');
  for(let index=1;index<=5;index++){
    await reset.click();await until(async()=>Number(await page.locator('.destructive-window-wash').getAttribute('data-progress'))>=index/6-.02,'settings progress must reach the authenticated shell');
    near(Number(await page.locator('.destructive-window-wash').getAttribute('data-progress')),index/6,'whole-window progress');assert.equal(requestCount('POST','/api/reset-data'),0);await noConfirmation();
  }
  const coverage=await page.locator('.destructive-window-wash').evaluate(node=>{const rect=node.getBoundingClientRect();return{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,pointerEvents:getComputedStyle(node).pointerEvents};});
  assert.ok(coverage.left<=0&&coverage.top<=0&&coverage.right>=coverage.width&&coverage.bottom>=coverage.height);assert.equal(coverage.pointerEvents,'none');
  await saveShot(page,'settings-window-five-of-six');await navigate('sessions');assert.equal(await page.locator('.destructive-window-wash').count(),0,'leaving settings removes host tint');
  await navigate('settings');await frame().locator('#settings-sidebar a[data-target=desktop]').waitFor();await openReset();near(await progress(frame().locator('#reset')),0,'remount starts uncharged');
  await threshold(frame().locator('#reset'),{clicks:6,method:'POST',pathname:'/api/reset-data'});
  await frame().locator('#reset-result[data-state=accepted]').waitFor();assert.match(await frame().locator('#reset-result').innerText(),/QA169-MOCK-BACKUP/);
  assert.equal(await page.locator('.destructive-window-wash').count(),0,'completion clears the host tint');
  assert.equal(await frame().locator('#save').isDisabled(),true);
  assert.equal(originalMessages(),messagesBefore);assert.equal(originalMemory(),memoryBefore);
  assert.ok(kernel.sessions.get(finished.id));assert.ok(kernel.sessions.get(pending.id));assert.equal(kernel.memory.query(chatKey).length,1);
  assert.ok(intercepted.length>=9);assert.deepEqual(errors,[]);assert.deepEqual(dialogs,[]);assert.deepEqual(outboundRequests,[]);assert.equal(outbound,0);
  assert.ok(requests.every(request=>!request.path.endsWith('/launch')));
  console.log(JSON.stringify({test:'169-destructive-panel-ui',result:'passed',realKernel:true,opaqueIframes:true,destructiveRequestsMocked:intercepted.length,realResetCalls:0,productionConsoleAccessed:false}));
}finally{
  await browser?.close();await kernel.stop();assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('qqa-destructive169-'));fs.rmSync(dataDir,{recursive:true,force:true});
}
