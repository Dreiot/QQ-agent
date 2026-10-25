// Actual temporary app/plugin/HTTP/opaque frame. No live console or external IO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createApplication} from '../src/kernel/composition.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-provider223-')),appRoot=path.join(root,'app'),dataDir=path.join(root,'data');
const evidence=process.env.QA_EVIDENCE_DIR?path.resolve(process.env.QA_EVIDENCE_DIR):null;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
fs.mkdirSync(appRoot);fs.cpSync(new URL('../ui',import.meta.url),path.join(appRoot,'ui'),{recursive:true});
for(const name of ['bundled','plugins','skills'])fs.mkdirSync(path.join(appRoot,name));
const plugin=path.join(appRoot,'plugins','synthetic-provider223');fs.mkdirSync(plugin);
fs.writeFileSync(path.join(plugin,'plugin.json'),JSON.stringify({id:'synthetic-provider223',kind:'plugin',name:'合成提供者',version:'1.0.0',apiVersion:1,entry:'index.js',permissions:[]}));
fs.writeFileSync(path.join(plugin,'index.js'),"export default{setup(ctx){ctx.registerCapability('fixture.choice',{choose:()=>223});}};");
const token='synthetic-provider223',errors=[],outbound=[],blocked=[],checks=[],releases=new Set();
let kernel,browser,page,base;
const read=()=>JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
const until=async(test)=>{for(let i=0;i<500;i++){if(await test())return;await new Promise(done=>setTimeout(done,10));}throw Error('223 condition did not settle');};
async function start(initialize=false){
  kernel=await createApplication({appRoot,headless:true,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_MIGRATE_FROM:path.join(root,'absent')},
    transport:{id:'inert223',start(){},stop(){},status:()=>({connected:false}),actions:{}},
    priceUpdates:{refresh:async()=>({ok:true}),updateCheck:async()=>({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false})},
    communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})},fetchImpl:async(url)=>{outbound.push(String(url));throw Error('223 forbids external requests');}});
  kernel.log.setLevel('error');kernel.loader.startWatchers=()=>{};
  if(initialize)kernel.config.update({server:{port:0,token},api:{baseUrl:'https://synthetic.invalid/v1',model:'synthetic223'},allowAllWhenEmpty:true,telemetry:{enabled:false},proactive:{enabled:false},skills:{'synthetic-provider223':{enabled:true}},extensions:{providers:{'fixture.choice':'kernel'}}});
  kernel.capability.register('fixture.choice','kernel',{choose:()=>0},{default:true});
  base=`http://127.0.0.1:${await kernel.start()}`;assert.notEqual(new URL(base).port,'15967');
  assert.deepEqual(kernel.loader.listEntries().map(entry=>entry.id),['synthetic-provider223']);
}
const f=()=>page.frameLocator('#panel-host iframe'),row=()=>f().locator('[data-capability="fixture.choice"]'),select=()=>row().getByLabel('fixture.choice 提供者'),apply=()=>row().getByRole('button',{name:'应用',exact:true,includeHidden:true}),details=()=>f().locator('#capability-providers details');
async function open(){await page.goto(base);await page.locator('#nav button[data-panel=plugins]').click();await row().waitFor({state:'attached'});await details().locator('summary').click();await select().waitFor();}
async function holdRefresh(){
  let entered,release;const started=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});releases.add(release);
  const handler=async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});};
  await page.route(base+'/api/skills/capabilities',handler);
  kernel.bus.emit('status',{configUpdated:true});await started;
  return{async finish(){release();releases.delete(release);await page.unroute(base+'/api/skills/capabilities',handler);}};
}
async function retained(handle){await page.waitForTimeout(200);assert.equal(await handle.evaluate(node=>node.isConnected),true,'unchanged metadata retains the original selector');}
try{
  await start(true);const playwright=createRequire(import.meta.url)('playwright-core'),cache=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'ms-playwright');
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9))).map(name=>path.join(cache,name,'chrome-win64/chrome.exe')).find(file=>fs.existsSync(file));assert.ok(executablePath);
  browser=await playwright.chromium.launch({executablePath,headless:process.env.QA_HEADED!=='1'});page=await browser.newPage({viewport:{width:1360,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();blocked.push(route.request().url());return route.abort();});
  await open();assert.equal(await select().inputValue(),'kernel');assert.equal(await apply().isDisabled(),true);
  let old=await select().elementHandle(),pending=await holdRefresh();await select().selectOption('');assert.equal(await apply().isEnabled(),true);await details().locator('summary').click();assert.equal(await details().evaluate(node=>node.open),false);
  await pending.finish();await retained(old);assert.equal(await select().inputValue(),'');assert.equal(await apply().isEnabled(),true);assert.equal(await details().evaluate(node=>node.open),false);assert.equal(read().extensions.providers['fixture.choice'],'kernel');checks.push('a real delayed metadata response preserves the original selector, latest unsaved owner and collapse state');
  await details().locator('summary').click();await apply().click();await until(()=>read().extensions.providers['fixture.choice']===undefined);await row().locator('.capability-provider-info').filter({hasText:'合成提供者 · 自动'}).waitFor();assert.equal(await select().inputValue(),'');assert.equal(await apply().isDisabled(),true);checks.push('the retained automatic selection commits through actual authenticated PUT and disk');

  old=await select().elementHandle();pending=await holdRefresh();await select().selectOption('kernel');await pending.finish();await retained(old);assert.equal(await select().inputValue(),'kernel');assert.equal(await apply().isEnabled(),true);
  const reject=route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'synthetic223 selection conflict'})});await page.route(base+'/api/skills/capabilities/provider',reject);await apply().click();await row().getByRole('status').filter({hasText:'synthetic223 selection conflict'}).waitFor();assert.equal(await select().inputValue(),'kernel');assert.equal(await select().isEnabled(),true);assert.equal(read().extensions.providers['fixture.choice'],undefined);await page.unroute(base+'/api/skills/capabilities/provider',reject);await apply().click();await until(()=>read().extensions.providers['fixture.choice']==='kernel');checks.push('a delayed reverse selection and failed save retain the draft for a successful retry');

  await until(async()=>await apply().isDisabled());old=await select().elementHandle();pending=await holdRefresh();await select().selectOption('');kernel.config.update({extensions:{providers:{'fixture.choice':'synthetic-provider223'}}});await pending.finish();await retained(old);
  await f().locator('#reload').click();await row().locator('.capability-provider-info').filter({hasText:'合成提供者 · 已指定'}).waitFor();assert.equal(await select().inputValue(),'synthetic-provider223');assert.equal(await apply().isDisabled(),true);checks.push('an externally changed pin invalidates the old-source draft instead of silently applying it');

  await page.goto('about:blank');await kernel.stop();kernel=null;const layer=path.join(appRoot,'overrides','20-provider-ui');fs.mkdirSync(layer,{recursive:true});
  const source=fs.readFileSync(new URL('../ui/panels/extension-manager.js',import.meta.url),'utf8');fs.writeFileSync(path.join(layer,'manager.js'),source.replace('能力提供者 · ${capabilities.length} 项','能力提供者 · 追加223 · ${capabilities.length} 项'));
  const manifest={version:1,id:'provider-ui223',ui:{assets:{'panels/extension-manager.js':'./manager.js'}}};fs.writeFileSync(path.join(layer,'composition.json'),JSON.stringify(manifest));await start();await open();await details().locator('summary').filter({hasText:'追加223'}).waitFor();checks.push('one appended UI asset is actually consumed while other default plugin controls remain');
  await page.goto('about:blank');await kernel.stop();kernel=null;fs.writeFileSync(path.join(layer,'composition.json'),JSON.stringify({...manifest,enabled:false}));await start();await open();assert.match(await details().locator('summary').textContent(),/^能力提供者 · \d+ 项$/);assert.equal(await select().inputValue(),'synthetic-provider223');checks.push('disabling the appended asset restores the default renderer and persisted selection');
  assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);assert.deepEqual(blocked,[]);for(const check of checks)console.log('✓ 223 '+check);
  if(evidence){await page.screenshot({path:path.join(evidence,'provider.png')});fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',headed:process.env.QA_HEADED==='1',checks,errors,outbound,blocked},null,2)+'\n');}
}finally{
  for(const release of releases)release();await browser?.close();await kernel?.stop();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('qqa-provider223-'));fs.rmSync(root,{recursive:true,force:true});
}
