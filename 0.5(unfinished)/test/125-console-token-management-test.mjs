import {settingsSection,openSettingsFold} from './settings-navigation.mjs';
// Temporary real kernel + headless Chrome and real Electron IPC handler via a mock shell.
// No current headed QA, OS autostart, external service, or user credential is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {EventEmitter} from 'node:events';
import {createKernel} from '../src/kernel/kernel.js';
import {startElectron,stopElectron} from '../electron/main.js';
import {ApiClient} from '../ui/shell/api-client.js';
import {SseClient} from '../ui/shell/sse-client.js';
import {createConsoleAuth,CONSOLE_SESSION_KEY} from '../ui/shell/console-auth.js';
import {consoleTokenValue} from '../ui/shell/token-management.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-token125-'));
const appRoot=path.join(dataDir,'application');fs.mkdirSync(appRoot);
fs.cpSync(path.resolve(import.meta.dirname,'../ui'),path.join(appRoot,'ui'),{recursive:true});
for(const directory of ['bundled','plugins','skills'])fs.mkdirSync(path.join(appRoot,directory));
const oldToken='old-private-125',newToken='new-private-125',recoveredToken='recovered-private-125';
let outbound=0;const outboundRequests=[];
const kernel=createKernel({appRoot,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_PORT:'0',QQ_AGENT_MIGRATE_FROM:path.join(dataDir,'absent')},headless:true,
  transport:{id:'fixture',start(){},stop(){},status:()=>({connected:true}),actions:{}},
  fetchImpl:async()=>{outbound++;throw Error('QA125 external traffic disabled');},
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})}});
kernel.log.setLevel('error');kernel.loader.startWatchers=()=>{};
let browser,base,page,panel;
const errors=[],requests=[],writes=[];
async function response(token,route='/api/config',method='GET',body){return fetch(base+route,{method,headers:{'x-console-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const disk=()=>JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
const openTokenSettings=async()=>{await panel.locator('#settings-sidebar a[data-target=desktop]').waitFor({state:'visible'});await settingsSection(panel,'desktop');await openSettingsFold(panel,'layout-console-connection');};
const waitTokenValue=expected=>page.waitForFunction(expected=>document.querySelector('#console-token-current')?.value===expected,expected);
try{
  kernel.config.update({server:{port:0,token:oldToken},telemetry:{enabled:false},proactive:{enabled:false},persona:{botName:'125 unchanged'}});
  base=`http://127.0.0.1:${await kernel.start()}`;
  assert.notEqual(new URL(base).port,'15967');assert.deepEqual(kernel.loader.listEntries(),[]);
  console.log('· Failed write/rename and reset preserve config, credentials, notifications and the existing SSE');
  const streamAbort=new AbortController(),stream=await fetch(base+'/api/events',{headers:{'x-console-token':oldToken},signal:streamAbort.signal});
  const reader=stream.body.getReader();await reader.read();let ended=false;
  const after=(async()=>{for(;;){const chunk=await reader.read();if(chunk.done){ended=true;return;}}})();
  const before=disk(),beforeRef=kernel.config.get();let changes=0;const unsubscribe=kernel.config.onChange(()=>changes++);
  for(const operation of ['writeFileSync','renameSync']){
    const original=fs[operation];
    fs[operation]=function(...args){if(String(args[operation==='renameSync'?1:0]).startsWith(path.join(dataDir,'config.json')))throw Object.assign(new Error('125 synthetic write failure'),{code:'EACCES'});return original.apply(this,args);};
    try{
      const failed=await response(oldToken,'/api/config','POST',{server:{token:'not-committed-125'},store:{contextSliderPos:20}});assert.equal(failed.status,500);
      assert.equal(kernel.config.get(),beforeRef);assert.deepEqual(disk(),before);assert.equal(changes,0);assert.equal(ended,false);
      assert.equal((await response(oldToken)).status,200);assert.equal((await response('not-committed-125')).status,401);
      assert.throws(()=>kernel.config.reset(),/synthetic write failure/);assert.equal(kernel.config.get(),beforeRef);assert.deepEqual(disk(),before);
    }finally{fs[operation]=original;}
  }
  unsubscribe();

  const playwright=createRequire(import.meta.url)('playwright-core');
  const cache=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'ms-playwright');
  const versions=fs.readdirSync(cache).filter(v=>/^chromium-\d+$/.test(v)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));
  browser=await playwright.chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??versions.map(v=>path.join(cache,v,'chrome-win64/chrome.exe')).find(f=>fs.existsSync(f))});
  const context=await browser.newContext();page=await context.newPage({viewport:{width:1360,height:900}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();outboundRequests.push(route.request().url());return route.abort();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{requests.push({url:request.url(),token:request.headers()['x-console-token']});if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/config')writes.push(request.postDataJSON());});
  await context.addInitScript(({origin,key,token})=>{
    if(top===window){if(!sessionStorage.getItem(key))sessionStorage.setItem(key,JSON.stringify({version:1,origin,token,expiresAt:Date.now()+30*60*1000}));window.qa125Copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.qa125Copied.push(value)},configurable:true});}
    else{window.qa125Messages=[];window.addEventListener('message',event=>window.qa125Messages.push(JSON.stringify(event.data)));}
  },{origin:base,key:CONSOLE_SESSION_KEY,token:oldToken});
  await page.goto(base);await page.locator('#nav button[data-panel=settings]').click();panel=page.frameLocator('#panel-host iframe');
  await openTokenSettings();
  console.log('· The settings iframe opens a host-only manager; display/copy/cancel never return a credential');
  await panel.getByRole('button',{name:'管理控制台访问令牌',exact:true}).click();
  const dialog=page.locator('#console-token-dialog'),current=dialog.locator('#console-token-current'),next=dialog.locator('#console-token-new');
  await dialog.waitFor();assert.equal(await panel.locator('#console-token-dialog').count(),0);assert.equal(await current.getAttribute('type'),'password');assert.equal(await current.inputValue(),oldToken);
  await dialog.getByRole('button',{name:'显示',exact:true}).click();assert.equal(await current.getAttribute('type'),'text');
  await dialog.getByRole('button',{name:'复制',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.qa125Copied),[oldToken]);
  assert.throws(()=>consoleTokenValue('bad\nheader'),/HTTP请求头/);
  // The current UI automatically saves nonblank edits. Blank means unchanged;
  // invalid nonblank input reports through the visible saved/error toast.
  for(const bad of ['', '   ', '令牌', 'x'.repeat(8193)])assert.throws(()=>consoleTokenValue(bad));
  for(const blank of ['', '   ']){const count=writes.length;await next.fill(blank);await page.waitForTimeout(750);assert.equal(writes.length,count);assert.equal(disk().server.token,oldToken);}
  for(const bad of ['令牌', 'x'.repeat(8193)]){
    const count=writes.length;await next.fill(bad);await page.locator('.settings-save-toast[data-state=error]').filter({hasText:/非空|HTTP请求头/}).waitFor();assert.equal(writes.length,count);assert.equal(disk().server.token,oldToken);
  }
  await next.fill('');await page.locator('.settings-save-toast[data-state=saved]').waitFor();
  const cancelled=await dialog.evaluate(node=>{
    const current=node.querySelector('#console-token-current'),next=node.querySelector('#console-token-new');
    node.querySelector('.dialog-actions button').click();
    return{connected:node.isConnected,currentCleared:current.value==='',nextCleared:next.value==='',count:document.querySelectorAll('#console-token-dialog').length};
  });
  assert.deepEqual(cancelled,{connected:false,currentCleared:true,nextCleared:true,count:0},'Cancel removes the dialog and clears both credentials in the same task');
  await dialog.waitFor({state:'detached'});assert.equal(disk().server.token,oldToken);
  await panel.getByRole('button',{name:'管理控制台访问令牌',exact:true}).click();
  console.log('· Malformed open requests and iframe config writes cannot expose, replace or disable the host credential');
  for(const body of [{server:{token:''}},{server:{__replace__:{}}},{server:[]},{server:false},{server:'invalid'},{__replace__:{}}]){
    const denied=await panel.locator('body').evaluate(async(_element,body)=>{const {request}=await import('/panels/panel-client.js');try{await request('POST','/api/config',body);return null;}catch(error){return error.code;}},body);
    assert.equal(denied,-32003);assert.equal(disk().server.token,oldToken);
  }
  const malformed=await panel.locator('body').evaluate(async()=>{const {rpc}=await import('/panels/panel-client.js');try{await rpc('console.manageToken',{token:'attacker-input'});return null;}catch(error){return error.code;}});
  assert.equal(malformed,-32600);
  console.log('· A real GUI rename failure leaves the old tab credential, SSE and interface usable');
  const rename=fs.renameSync;
  fs.renameSync=function(...args){if(String(args[1])===path.join(dataDir,'config.json'))throw new Error('125 synthetic GUI rename failure');return rename.apply(this,args);};
  try{
    await next.fill('gui-not-committed-125');await page.locator('.settings-save-toast[data-state=error]').filter({hasText:'保留当前凭据'}).waitFor();
    assert.equal(disk().server.token,oldToken);assert.equal(await current.inputValue(),oldToken);
    assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).token,CONSOLE_SESSION_KEY),oldToken);
    assert.equal((await response(oldToken,'/api/panels')).status,200);assert.equal(ended,false);
  }finally{fs.renameSync=rename;}
  console.log('· Successful token change revokes REST and existing SSE, then reconnects and reloads with the new tab credential');
  await next.fill(newToken);await waitTokenValue(newToken);await page.locator('.settings-save-toast[data-state=saved]').waitFor();
  assert.equal(disk().server.token,newToken);assert.equal((await response(oldToken)).status,401);assert.equal((await response(newToken)).status,200);
  await after;assert.equal(ended,true);streamAbort.abort();
  assert.equal((await response(oldToken,'/api/events')).status,401);
  await page.locator('#sse').filter({hasText:'实时同步'}).waitFor();
  assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).token,CONSOLE_SESSION_KEY),newToken);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await page.locator('#nav button[data-panel=settings]').waitFor();await page.locator('#sse').filter({hasText:'实时同步'}).waitFor();
  assert.equal(new URL(page.url()).search,'');assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(localStorage)),/private-125/);

  console.log('· A committed POST whose response is lost is recovered by candidate authentication');
  await page.locator('#nav button[data-panel=settings]').click();panel=page.frameLocator('#panel-host iframe');await openTokenSettings();
  await panel.getByRole('button',{name:'管理控制台访问令牌',exact:true}).click();
  let lost=false;await page.route('**/api/config',async route=>{if(route.request().method()==='POST'&&!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await next.fill(recoveredToken);await waitTokenValue(recoveredToken);await page.locator('.settings-save-toast[data-state=saved]').waitFor();await page.unroute('**/api/config');
  assert.equal(disk().server.token,recoveredToken);assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).token,CONSOLE_SESSION_KEY),recoveredToken);
  await page.locator('#sse').filter({hasText:'实时同步'}).waitFor();
  const frameMessages=await panel.locator('body').evaluate(()=>window.qa125Messages);
  assert.doesNotMatch(JSON.stringify(frameMessages),/old-private-125|new-private-125|recovered-private-125/);
  assert.ok(requests.filter(request=>new URL(request.url).pathname==='/api/events').some(request=>request.token===recoveredToken));
  assert.ok(requests.every(request=>!new URL(request.url).searchParams.has('token')));
  assert.equal(Object.hasOwn((await (await response(recoveredToken)).json()).server,'token'),false);
  assert.equal(disk().persona.botName,'125 unchanged');assert.deepEqual(errors,[]);
  await browser.close();browser=null;

  console.log('· Old 401 and old SSE finally cannot invalidate/clobber a new credential generation');
  const realFetch=globalThis.fetch,oldLocation=globalThis.location;
  try{
    const storage=new Map();
    // An actual top-level fake window supplies the existing tab credential.
    const win={location:{pathname:'/',origin:base,href:base+'/'},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};win.top=win;storage.set(CONSOLE_SESSION_KEY,JSON.stringify({version:1,origin:base,token:oldToken,expiresAt:Date.now()+10000}));
    const valid=await createConsoleAuth(win);let release;
    globalThis.location={href:base+'/'};globalThis.fetch=()=>new Promise(resolve=>release=resolve);
    const api=new ApiClient({token:oldToken}),pending=api.get('/api/config').catch(error=>error);api.setToken(newToken);valid.adopt(newToken);release({ok:false,status:401,json:async()=>({error:'未授权'})});
    const stale=await pending;valid.invalidate(stale);assert.equal(stale.credentialCurrent,false);assert.equal(JSON.parse(storage.get(CONSOLE_SESSION_KEY)).token,newToken);
    const pendingAgain=api.get('/api/config').catch(error=>error);api.setToken(oldToken);api.setToken(newToken);release({ok:false,status:401,json:async()=>({error:'未授权'})});
    valid.invalidate(await pendingAgain);assert.equal(JSON.parse(storage.get(CONSOLE_SESSION_KEY)).token,newToken,'a token value reused after two rotations still fences an older request');
    const gates=[],states=[];
    globalThis.fetch=()=>new Promise(resolve=>gates.push(resolve));
    const sse=new SseClient({token:oldToken,retryDelay:5,onState:state=>states.push(state)});sse.connect();sse.setToken(newToken);const currentController=sse.controller;
    gates[1]({ok:true,body:{getReader:()=>({read:()=>new Promise(()=>{})})}});await Promise.resolve();
    gates[0]({ok:false,status:401,body:{cancel:async()=>{}}});await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(sse.controller,currentController);assert.equal(gates.length,2);assert.deepEqual(states,['connecting','connecting','connected']);sse.close();
  }finally{globalThis.fetch=realFetch;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;}

  console.log('· Real Electron token IPC rereads committed config across F5; it remains main-frame-only');
  const handlers=new Map(),createdWindows=[];
  class Window extends EventEmitter{
    constructor(){super();this.destroyed=false;this.contents=new EventEmitter();this.contents.mainFrame={url:''};this.contents.setWindowOpenHandler=()=>{};this.contents.isDestroyed=()=>this.destroyed;createdWindows.push(this);}
    get webContents(){if(this.destroyed)throw new TypeError('Object has been destroyed');return this.contents;}
    isDestroyed(){return this.destroyed;}async loadURL(url){this.contents.mainFrame={url};}
    show(){}hide(){}destroy(){this.destroyed=true;this.contents.emit('destroyed');this.emit('closed');}
  }
  const app=new EventEmitter();Object.assign(app,{isPackaged:false,getPath:()=>dataDir,setPath(){},requestSingleInstanceLock:()=>true,whenReady:async()=>{},quit(){},setLoginItemSettings(){}});
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name),on(){},removeListener(){}},session:{defaultSession:{setProxy:async()=>{},setPermissionRequestHandler(){}}},shell:{openExternal(){}}};
  const envData=process.env.QQ_AGENT_DATA_DIR;process.env.QQ_AGENT_DATA_DIR=dataDir;
  try{
    const desktop=await startElectron(electron,{createKernel:()=>({...kernel,start:async()=>Number(new URL(base).port),stop:async()=>{}})}),contents=desktop.window.webContents,read=handlers.get('qq-agent:get-console-token');
    assert.equal(read({sender:contents,senderFrame:contents.mainFrame}),recoveredToken);kernel.config.update({server:{token:'desktop-latest-125'}});
    await desktop.window.loadURL(base+'/');assert.equal(read({sender:contents,senderFrame:contents.mainFrame}),'desktop-latest-125');
    assert.equal(read({sender:contents,senderFrame:{url:base+'/'}}),'');
    const desktopWin={location:{pathname:'/',origin:base,href:base+'/'},qqAgentShell:{getConsoleToken:async()=>read({sender:contents,senderFrame:contents.mainFrame})},sessionStorage:{getItem(){return null;},setItem(){throw new Error('desktop must not cache');},removeItem(){}}};desktopWin.top=desktopWin;
    const desktopAuth=await createConsoleAuth(desktopWin);desktopAuth.adopt('desktop-latest-125');assert.equal(desktopAuth.token,'desktop-latest-125');
    desktop.window.destroy();app.emit('activate');
    // activate owns a newly created main window; inspect the real guarded handler.
    const newWindow=createdWindows.at(-1),newContents=newWindow.webContents;
    await newWindow.loadURL(base+'/');kernel.config.update({server:{token:'desktop-recreated-125'}});
    await newWindow.loadURL(base+'/');assert.equal(read({sender:newContents,senderFrame:newContents.mainFrame}),'desktop-recreated-125');
    assert.equal(read({sender:contents,senderFrame:contents.mainFrame}),'');
  }finally{await stopElectron(electron);if(envData===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=envData;}
  assert.equal(outbound,0);assert.deepEqual(outboundRequests,[]);
  console.log('✓ 125 host-only management, durable rotation/failure, SSE revocation, reload caches/generations and real guarded IPC passed');
}finally{await browser?.close();await kernel.stop();assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});}
