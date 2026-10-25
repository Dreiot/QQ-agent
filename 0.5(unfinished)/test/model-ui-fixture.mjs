import {settingsSection} from './settings-navigation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createApplication} from '../src/kernel/composition.js';
import {createConfig, buildDefaultConfig} from '../src/kernel/config.js';
import {launchVisibilityBrowser} from './real-visibility-browser.mjs';

export async function modelUiFixture({models = [], config = {}, components = {}, transport = null, uiAsset = null, uiAssetPath = 'panels/settings/model-picker.js', uiAssetEnabled = true, marketClientFactory = null, nativeVisibility = false, updateCheck = async()=>({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false})} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-model-parity-')), appRoot = path.join(dir, 'app');
  fs.mkdirSync(appRoot); fs.cpSync(path.resolve(import.meta.dirname, '../ui'), path.join(appRoot, 'ui'), {recursive:true});
  for (const folder of ['bundled','plugins','skills']) fs.mkdirSync(path.join(appRoot, folder));
  if(marketClientFactory){
    // Exercise the actual default market service rather than invent a provider
    // in an otherwise empty bundled fixture. Only source trees are copied.
    fs.writeFileSync(path.join(appRoot,'package.json'),'{"type":"module"}');
    fs.cpSync(path.resolve(import.meta.dirname,'../src'),path.join(appRoot,'src'),{recursive:true});
    fs.cpSync(path.resolve(import.meta.dirname,'../bundled/market'),path.join(appRoot,'bundled/market'),{recursive:true});
  }
  if (uiAsset) {
    const layer=path.join(appRoot,'overrides','10-picker');fs.mkdirSync(layer,{recursive:true});
    fs.writeFileSync(path.join(layer,'picker.js'),uiAsset);
    fs.writeFileSync(path.join(layer,'composition.json'),JSON.stringify({version:1,id:'qa-picker',enabled:uiAssetEnabled,ui:{assets:{[uiAssetPath]:'./picker.js'}}}));
  }
  let browser,browserOwner, kernel, gate = null, modelStatus = 200, chatStatus = 200, outbound = 0;
  const modelRequests = [], errors = [], writes = [];
  const server = http.createServer(async (req,res) => {
    const record={url:req.url, authorization:req.headers.authorization};modelRequests.push(record);
    if(req.url.endsWith('/chat/completions')) {
      let raw='';for await(const chunk of req)raw+=chunk;record.body=JSON.parse(raw);
      res.writeHead(chatStatus,{'content-type':'application/json'});res.end(JSON.stringify(chatStatus===200?{model:record.body.model,choices:[{message:{role:'assistant',content:'fixture response'}}]}:{error:{message:'synthetic model connection failure'}}));return;
    }
    await gate?.promise;
    if (res.destroyed) return;
    res.writeHead(modelStatus, {'content-type':'application/json'}); res.end(JSON.stringify(modelStatus===200 ? {data:models} : {error:'synthetic model discovery failure'}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const modelBase = `http://127.0.0.1:${server.address().port}`, token = 'synthetic-model-parity';
  let closed=false;
  async function close() {
    if(closed)return;closed=true;
    gate?.resolve(); gate = null; await browser?.close(); await browserOwner?.close(); await kernel?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('qqa-model-parity-')); fs.rmSync(dir,{recursive:true,force:true});
  }
  try {
    kernel = await createApplication({appRoot,headless:true,components,env:{QQ_AGENT_DATA_DIR:dir,QQ_AGENT_MIGRATE_FROM:path.join(dir,'absent')},
      transport:transport??{id:'inert-model-fixture',start(){},stop(){},status:()=>({connected:false}),actions:{}},
      fetchImpl:async()=>{++outbound;throw new Error('External traffic disabled');},
      priceUpdates:{refresh:async()=>({ok:true}),updateCheck},communityMarket:marketClientFactory?{
        ...marketClientFactory({appRoot,dataDir:dir}),syncGlobalBlocklist:async()=>({ok:true,ids:[]}),getBlocklist:()=>({ok:true,ids:[]}),
      }:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})}});
    kernel.log.setLevel('error'); kernel.loader.startWatchers=()=>{};
    kernel.config.update({server:{port:0,token},telemetry:{enabled:false},allow:{groups:['10001'],private:[]},
      api:{provider:'a',baseUrl:modelBase+'/a/v1',model:'shared',apiKey:'synthetic-direct-key'},
      providers:[
        {id:'a',displayName:'Channel A',baseUrl:modelBase+'/a/v1',models:[{id:'shared',name:'A Shared',vision:true,contextLimit:128000},'alpha/existing'],modelNames:{shared:'A显示名'}},
        {id:'b',displayName:'Channel B',baseUrl:modelBase+'/b/v1',models:[{id:'shared',name:'B Shared'},'b-only'],modelNames:{shared:'B显示名'}},
      ],dshProviderKeys:{a:'synthetic-key-a',b:'synthetic-key-b'}});
    kernel.config.update(config);
    const port = await kernel.start(), base = `http://127.0.0.1:${port}`;
    const playwright=createRequire(import.meta.url)('playwright-core'), cache=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'ms-playwright');
    const versions=fs.readdirSync(cache).filter(v=>/^chromium-\d+$/.test(v)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));
    const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||versions.map(v=>path.join(cache,v,'chrome-win64/chrome.exe')).find(f=>fs.existsSync(f));
    assert.ok(executablePath);let context;
    if(nativeVisibility){({browser,owner:browserOwner,context}=await launchVisibilityBrowser(playwright.chromium,executablePath));}
    else{browser=await playwright.chromium.launch({executablePath,headless:process.env.QA_HEADED!=='1'});context=await browser.newContext({viewport:{width:1360,height:900}});}
    const page=await context.newPage();await page.setViewportSize({width:1360,height:900});page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',req=>{if(req.url().startsWith(base+'/api/')&&['POST','DELETE'].includes(req.method()))writes.push({path:new URL(req.url()).pathname,method:req.method(),body:req.postDataJSON()});});
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    const frame=page.frameLocator('#panel-host iframe');
    async function openSettings() {
      await page.goto(base); await page.locator('#nav button[data-panel=settings]').click();
      await frame.locator('#settings-sidebar a[data-target=models]').waitFor({state:'visible'}); await settingsSection(frame,'models');
    }
    await openSettings();
    return {dir,appRoot,kernel,page,frame,base,modelBase,modelRequests,errors,writes,openSettings,close,
      card:id=>frame.locator(`#provider-list > article[data-motion-key="provider:${id}"]`),
      request:async(method,url,body)=>{const r=await fetch(base+url,{method,headers:{'x-console-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};},
      disk:()=>{const store=createConfig({dataDir:dir,defaults:buildDefaultConfig(),log:{info(){},warn(){}}});store.load();return store.get();},
      pauseModels:()=>{assert.equal(gate,null);let resolve;const promise=new Promise(r=>{resolve=r;});const held={promise,resolve};gate=held;return()=>{resolve();if(gate===held)gate=null;};},
      modelStatus:value=>{modelStatus=value;},chatStatus:value=>{chatStatus=value;},outbound:()=>outbound};
  } catch (error) {await close();throw error;}
}
