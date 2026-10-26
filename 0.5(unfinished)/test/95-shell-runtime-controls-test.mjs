import {settingsSection} from './settings-navigation.mjs';
// Real console + kernel: pause controls, partial SSE snapshots and keyboard focus.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-shell95-')),token='shell95-token';
// Real default UI/routes and the formal source consumers stay under test.
// No loader extension is required by this fixture's business contract.
const appRoot = path.join(dataDir, 'application'); fs.mkdirSync(appRoot);
fs.cpSync(path.resolve(import.meta.dirname, '../ui'), path.join(appRoot, 'ui'), { recursive: true });
for (const directory of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(appRoot, directory));
let isolatedOutbound = 0, dnsCalls = 0; const browserOutbound = [], ownedOrigins = new Set();
const nativeFetch = globalThis.fetch, nativeLookup = dns.lookup;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (ownedOrigins.has(url.origin)) return nativeFetch(input, options);
  isolatedOutbound++; throw new Error('QA95 external fetch disabled');
};
dns.lookup = async () => { dnsCalls++; throw new Error('QA95 external DNS disabled'); };
const routeOwnedPage = (page, base) => page.route('**/*', route => {
  const url = route.request().url();
  if (new URL(url).origin === new URL(base).origin) return route.continue();
  browserOutbound.push(url); return route.abort();
});
function assertOffline() {
  assert.equal(isolatedOutbound, 0, 'no external Node fetch was attempted');
  assert.equal(dnsCalls, 0, 'no external DNS was attempted');
  assert.deepEqual(browserOutbound, [], 'browser requested only its exact owned console origin');
}

const refreshMs=Number(process.env.QA_SHELL95_REFRESH_MS || 1000);
assert.ok(Number.isFinite(refreshMs)&&refreshMs>=1000&&refreshMs<=15000);
let bindings;
const kernel=createKernel({appRoot,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_PORT:'0',QQ_AGENT_MIGRATE_FROM:path.join(dataDir,'absent')},
  fetchImpl: async()=>{isolatedOutbound++;throw new Error('QA95 external traffic disabled');},headless:true,
  transport:{id:'fixture',selfId:'99',bind(hooks){bindings=hooks;},start(){bindings.onStatus({connected:true,selfId:'99'});},stop(){},status:()=>({connected:true,selfId:'99'}),actions:{}},
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})}});
kernel.loader.startWatchers = () => {};
kernel.config.update({server:{port:0,token},telemetry:{enabled:false},allowAllWhenEmpty:true,ui:{refreshMs},api:{baseUrl:'http://127.0.0.1:1/v1',model:'local-fixture'}});
const port=await kernel.start(),base=`http://127.0.0.1:${port}`;
ownedOrigins.add(base); assert.notEqual(port, 15967); assert.deepEqual(kernel.loader.listEntries(), []);
let browser;
try{
  const playwright=createRequire(import.meta.url)('playwright-core');
  const cache=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'ms-playwright');
  const versions=fs.existsSync(cache)?fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9))):[];
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??versions.map(version=>path.join(cache,version,'chrome-win64/chrome.exe')).find(file=>fs.existsSync(file));
  browser=await playwright.chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:900},reducedMotion:'reduce'}),errors=[];
  await routeOwnedPage(page, base);
  // Advance the actual production poll timer, independently of wall-clock
  // scheduling or background-page timer delays. Network and API handlers stay real.
  await page.clock.install();
  page.on('pageerror',error=>errors.push(error.message));
  // Keep interception patterns stable for the whole page lifecycle. Removing a
  // one-shot pause route while its finally starts the next poll can strand that
  // already issued browser request before a later status route ever sees it.
  let failNextPause=false,holdNextStatus=false,releaseOldStatus,announceBlocked;
  const blocked=new Promise(resolve=>{announceBlocked=resolve;});
  await page.route('**/api/pause',route=>{
    if(!failNextPause)return route.continue();
    failNextPause=false;
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂停测试故障'})});
  });
  await page.route('**/api/status',async route=>{
    if(!holdNextStatus)return route.continue();
    holdNextStatus=false;
    const response=await route.fetch(),body=await response.json();
    assert.equal(body.orchestrator.paused,false,'the held real status snapshot predates the pause');
    announceBlocked();await new Promise(resolve=>{releaseOldStatus=resolve;});
    await route.fulfill({response,json:body});
  });
  await page.goto(`${base}/?token=${token}`);
  const pause=page.locator('#pause-btn');
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.disabled===false);
  assert.equal(await pause.textContent(),'全局暂停');
  assert.equal(await page.locator('#ready-onebot small').textContent(),'已连接');
  assert.equal(await page.locator('#ready-model small').textContent(),'已配置');
  await page.locator('#ready-model').click();
  await page.frameLocator('#panel-host iframe').locator('#section-models').waitFor({state:'visible'});
  assert.match(await page.locator('#panel-host iframe').getAttribute('src'),/\/panels\/settings\/index\.html.*#models$/);
  assert.match(await page.locator('#ready-model-detail').textContent(),/尚未验证.*连通/);

  console.log('· Pause updates the real orchestrator and keeps incoming messages unread');
  await pause.click();
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent==='恢复运行');
  assert.equal(kernel.orchestrator.status().paused,true);
  bindings.onEvent({kind:'group',id:'100',type:'message',event:{user_id:'123',message_id:501,message:[{type:'text',data:{text:'暂停期间的测试消息'}}]}});
  for(let i=0;i<100&&kernel.store.unread('group:100').length===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(kernel.store.unread('group:100').length,1);
  assert.equal(kernel.sessions.running().length,0);
  kernel.store.markAllRead('group:100');
  await pause.click();
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent==='全局暂停');
  assert.equal(kernel.orchestrator.status().paused,false);

  console.log('· External pause and partial application SSE snapshots stay synchronized');
  kernel.orchestrator.pause();kernel.bus.emit('status',{paused:true});
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent==='恢复运行');
  assert.equal(await page.locator('#ready-model small').textContent(),'已配置');
  assert.equal(await page.locator('#ready-onebot small').textContent(),'已连接');
  kernel.orchestrator.resume();kernel.bus.emit('status',{paused:false});
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent==='全局暂停');

  console.log('· Navigation refresh preserves node identity and keyboard focus');
  await page.evaluate(()=>{window.qaNavButton=document.querySelector('#nav button');window.qaNavButton.focus();});
  const panelRefresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/panels');
  kernel.bus.emit('permission.decision',{pluginId:'fixture',requestId:'fixture-request',decision:'allow'});
  await panelRefresh;
  await page.waitForFunction(()=>document.querySelector('#nav button')===window.qaNavButton&&document.activeElement===window.qaNavButton);
  assert.equal(await page.evaluate(()=>document.querySelector('#nav button')===window.qaNavButton),true);

  console.log('· Failed pause is recoverable and does not announce success');
  // The failed pause starts an immediate real status/config poll. Observe its
  // genuine commit before arming the next status transaction and advancing time.
  await page.evaluate(async()=>{
    const {state}=await import('/app.js'),original=state.set.bind(state);
    window.qaFailedPausePollCommitted=false;
    state.set=patch=>{
      original(patch);
      if(Object.hasOwn(patch,'config')&&[...document.querySelectorAll('.toast.error')].some(el=>el.textContent.includes('暂停测试故障'))){state.set=original;window.qaFailedPausePollCommitted=true;}
    };
  });
  failNextPause=true;
  await pause.click();
  await page.locator('.toast.error').filter({hasText:'暂停测试故障'}).waitFor();
  assert.equal(kernel.orchestrator.status().paused,false);
  assert.equal(await pause.textContent(),'全局暂停');
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.disabled===false);
  await page.waitForFunction(()=>window.qaFailedPausePollCommitted===true,{},{timeout:10000});

  console.log('· A delayed status poll cannot overwrite a newer pause result');
  holdNextStatus=true;
  // The preceding real transaction has committed and scheduled this exact
  // configured timer. Advance one interval, then wait for the actual HTTP snapshot.
  await page.clock.runFor(refreshMs);
  let blockedTimer;
  try{await Promise.race([blocked,new Promise((_,reject)=>{blockedTimer=setTimeout(()=>reject(new Error('Status poll was not observed within 10 seconds')),10000);})]);}
  finally{clearTimeout(blockedTimer);}
  await pause.click();
  await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent==='恢复运行');
  // Observe the held poll's genuine commit point, rather than sleeping 250ms.
  await page.evaluate(async()=>{
    const {state}=await import('/app.js');
    const original=state.set.bind(state);
    window.qaOldPollSettled=new Promise(resolve=>{
      state.set=patch=>{
        original(patch);
        if(Object.hasOwn(patch,'config')){state.set=original;resolve(state.get().status.orchestrator.paused);}
      };
    });
  });
  releaseOldStatus();
  assert.equal(await page.evaluate(()=>window.qaOldPollSettled),true,'the late real poll was processed after pause without reverting it');
  assert.equal(await pause.textContent(),'恢复运行');
  assert.equal(await pause.getAttribute('aria-pressed'),'true');

  console.log('· Configuration notifications refresh once; ordinary status polls retain upload errors');
  const activeApi=new Set();let apiChangedAt=Date.now(),settingsReads=0;
  const observeRequest=request=>{
    const route=new URL(request.url()).pathname;
    if(!route.startsWith('/api/')||route==='/api/events')return;
    activeApi.add(request);apiChangedAt=Date.now();
    if(route==='/api/persona-templates'&&request.method()==='GET')settingsReads++;
  };
  const observeFinished=request=>{if(activeApi.delete(request))apiChangedAt=Date.now();};
  page.on('request',observeRequest);page.on('requestfinished',observeFinished);page.on('requestfailed',observeFinished);
  async function settleApi(){
    const deadline=Date.now()+5000;
    while(activeApi.size||Date.now()-apiChangedAt<200){
      assert.ok(Date.now()<deadline,'the real bounded API transactions must settle');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  async function updateBotName(name){
    const response=await fetch(base+'/api/config',{method:'POST',headers:{'x-console-token':token,'content-type':'application/json'},body:JSON.stringify({persona:{botName:name}})});
    assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.config.persona.botName,name);
    await settings.locator('body').evaluate((_,expected)=>new Promise((resolve,reject)=>{
      const deadline=performance.now()+5000;
      function check(){
        if(document.querySelector('#field-persona-botName')?.value===expected)return resolve();
        if(performance.now()>deadline)return reject(new Error('a new actual config notification did not reach settings'));
        requestAnimationFrame(check);
      }
      check();
    }),name);
    await settleApi();
  }
  await page.locator('#nav button[data-panel=settings]').click();
  const settings=page.frameLocator('#panel-host iframe');
  await settings.locator('#status').filter({hasText:'配置已读取'}).waitFor();await settleApi();
  await settingsSection(settings,'uikit');
  await settings.locator('dialog[data-settings-editor] [data-settings-save]').focus();
  const initialSettingsReads=settingsReads;
  await updateBotName('QA-95-NOTIFICATION-FIRST');
  assert.equal(settingsReads,initialSettingsReads+1,'a real config POST must refresh settings once');
  await settings.getByRole('button',{name:'选择图片或视频',exact:true}).focus();
  const rejectedUpload=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/uikit/background'&&response.request().method()==='POST');
  await settings.locator('#section-uikit input[type=file]').setInputFiles({name:'qa95-invalid.png',mimeType:'image/png',buffer:Buffer.from('QA95 inert invalid image bytes')});
  assert.equal((await rejectedUpload).status(),400);
  await settings.locator('#status').filter({hasText:'上传失败'}).waitFor();await settleApi();
  const failure=await settings.locator('#status').textContent(),readsBeforePoll=settingsReads;
  assert.match(failure,/只支持 PNG \/ JPG \/ GIF \/ WebP 图片/);
  assert.equal(fs.existsSync(path.join(dataDir,'ui/backgrounds')),false,'rejected upload must not create background files');
  for(let poll=0;poll<2;poll++){
    const realStatus=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/status'&&response.request().method()==='GET');
    await page.clock.runFor(refreshMs);assert.equal((await realStatus).status(),200);await settleApi();
    assert.equal(settingsReads,readsBeforePoll,'ordinary status polling must not replay an earlier configuration notification');
    assert.equal(await settings.locator('#status').textContent(),failure,'ordinary status polling must preserve actionable upload feedback');
    assert.match(await settings.locator('#status').getAttribute('class'),/field-error/);
    assert.equal(kernel.orchestrator.status().paused,true);
    assert.equal(await pause.getAttribute('aria-pressed'),'true');
  }
  await updateBotName('QA-95-NOTIFICATION-SECOND');
  assert.equal(settingsReads,readsBeforePoll+1,'a second genuine configuration notification must not be lost');
  assert.match(await settings.locator('#status').textContent(),/配置已读取/);
  assert.equal(kernel.config.get().persona.botName,'QA-95-NOTIFICATION-SECOND');
  page.off('request',observeRequest);page.off('requestfinished',observeFinished);page.off('requestfailed',observeFinished);
  await page.locator('#nav button[data-panel=sessions]').click();

  console.log('· Readiness reflects configuration changes and fits a narrow window');
  kernel.config.update({api:{baseUrl:'',model:''}});
  await page.clock.runFor(refreshMs);
  await page.waitForFunction(()=>document.querySelector('#ready-model small')?.textContent==='未完成');
  await page.setViewportSize({width:520,height:900});
  assert.equal(await page.locator('.readiness-icon svg').count(),2);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.runtime-controls,.readiness-item,.readiness-details')].some(el=>{const b=el.getBoundingClientRect();return b.left<0||b.right>innerWidth+1;}));
  assert.equal(overflow,false);
  assert.deepEqual(errors,[]);
  console.log('✓ 95 shell runtime controls passed');
}finally{
  await browser?.close();await kernel.stop();
  globalThis.fetch = nativeFetch; dns.lookup = nativeLookup;
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('qqa-shell95-'));
  fs.rmSync(dataDir,{recursive:true,force:true});
  assertOffline(); assert.deepEqual(kernel.loader.listEntries(), []);
}
