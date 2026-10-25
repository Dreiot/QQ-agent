import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';
const wait=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('session refresh policy did not settle');};
const gate=()=>{let release;return{promise:new Promise(r=>{release=r;}),release:()=>release()};};
const f=await modelUiFixture({config:{ui:{refreshMs:60000}}});let heldList=null,heldConfig=null,appended;
try{
  await f.page.addInitScript(()=>{window.__intervals=new Map();const add=setInterval.bind(window),del=clearInterval.bind(window);window.setInterval=(fn,ms,...args)=>{const id=add(fn,ms,...args);window.__intervals.set(id,ms);return id;};window.clearInterval=id=>{window.__intervals.delete(id);del(id);};});
  await f.page.goto(f.base);await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('#sessions-panel[data-ready=true]').waitFor();await f.frame.locator('#follow').uncheck();
  const policy=()=>f.frame.locator('body').evaluate(async()=>{const m=await import('/panels/refresh-policy.js');return m.getRefreshInterval();});const timers=()=>f.frame.locator('body').evaluate(()=>[...window.__intervals.values()]);await wait(async()=>await policy()===60000);
  const s=f.kernel.sessions.create('group:20201',{trigger:'QA coalesced run'});await f.frame.locator('#reload').click();const row=f.frame.locator(`[data-session="${s.id}"]`);await row.waitFor();await row.click();await f.frame.locator('.session-body').waitFor();await new Promise(r=>setTimeout(r,200));assert.deepEqual(await timers(),[],'a waiting session without a deadline owns no periodic clock or network work');
  let reads=0,detailReads=0,inflight=0,maxInflight=0,first=true;const captured=gate();heldList=gate();
  f.page.on('request',req=>{if(req.method()==='GET'&&new URL(req.url()).pathname===`/api/sessions/${s.id}`)detailReads++;});
  await f.page.route(f.base+'/api/sessions?**',async route=>{reads++;inflight++;maxInflight=Math.max(maxInflight,inflight);try{const response=await route.fetch();if(first){first=false;captured.release();await heldList.promise;}await route.fulfill({response});}finally{inflight--;}});
  for(let i=0;i<100;i++)f.kernel.sessions.update(s,{activity:'QA phase '+i});await captured.promise;
  f.kernel.sessions.finish(s.id,'done');await new Promise(r=>setTimeout(r,200));assert.equal(reads,1,'events arriving during a pending read do not start overlapping list requests');heldList.release();
  await row.filter({hasText:'已回复'}).waitFor();await f.frame.locator('.session-body').filter({hasText:'已回复'}).waitFor();assert.equal(reads,2,'100 updates and an in-flight terminal event require one read and one trailing reconciliation');assert.equal(detailReads,1,'only the accepted terminal batch refreshes selected detail');assert.equal(maxInflight,1);await wait(async()=>!(await timers()).length);
  const burst={listReads:reads,detailReads,maxInflight};
  await f.page.unroute(f.base+'/api/sessions?**');
  const pending=f.kernel.sessions.create('group:20202',{trigger:'QA dynamic interval'});await f.frame.locator(`[data-session="${pending.id}"]`).waitFor();await wait(async()=>JSON.stringify(await timers())==='[]');
  let configFirst=true,configOnlyStatusReads=0;const configCaptured=gate();heldConfig=gate();
  f.page.on('request',req=>{if(req.method()==='GET'&&new URL(req.url()).pathname==='/api/status')configOnlyStatusReads++;});
  await f.page.route(f.base+'/api/config',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();if(configFirst){configFirst=false;configCaptured.release();await heldConfig.promise;}await route.fulfill({response});});
  f.kernel.bus.emit('status',{configUpdated:true});await configCaptured.promise;
  const changed=await f.request('POST','/api/config',{ui:{refreshMs:1000}});assert.equal(changed.status,200);heldConfig.release();await wait(async()=>await policy()===1000);await wait(async()=>JSON.stringify(await timers())==='[]');
  assert.equal(configOnlyStatusReads,0,'configuration notifications must not query runtime status or trigger a process-status poll');
  await f.frame.locator('body').evaluate(()=>window.addEventListener('message',e=>{if(e.data?.method==='shell.event'&&e.data.params?.name?.startsWith('session-'))e.stopImmediatePropagation();},{capture:true}));
  f.kernel.sessions.finish(pending.id,'done');f.kernel.httpServer.broadcast('hello',{});await f.frame.locator(`[data-session="${pending.id}"]`).filter({hasText:'已回复'}).waitFor({timeout:5000});await wait(async()=>!(await timers()).length);
  assert.equal((await f.request('POST','/api/config',{ui:{refreshMs:60000}})).status,200);await wait(async()=>await policy()===60000);
  let plainConfigReads=0;f.page.on('request',req=>{if(req.method()==='GET'&&new URL(req.url()).pathname==='/api/config')plainConfigReads++;});for(let i=0;i<20;i++)f.kernel.bus.emit('status',{qa202Plain:true});await new Promise(r=>setTimeout(r,150));assert.equal(plainConfigReads,0,'ordinary status notifications cannot trigger host config-read loops');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);console.log(JSON.stringify({test:202,events:101,...burst,intervalChangedWithoutReload:true,staleConfigRejected:true}));
  const stamp=1600000000000,older=f.kernel.sessions.create('group:20205',{trigger:'older tied active'});f.kernel.sessions.update(older,{startedAt:stamp});await f.frame.locator(`[data-session="${older.id}"]`).waitFor();await f.frame.locator('#follow').check();await f.frame.locator(`#detail[data-session-id="${older.id}"] h3`).waitFor();
  const newest=f.kernel.sessions.create('group:20206',{trigger:'new tied active'});f.kernel.sessions.update(newest,{startedAt:stamp});await f.frame.locator(`#detail[data-session-id="${newest.id}"] h3`).waitFor();assert.equal(await f.frame.locator('#follow').isChecked(),true);assert.deepEqual(f.errors,[]);
  await f.close();
  appended=await modelUiFixture({config:{ui:{refreshMs:60000}},uiAssetPath:'panels/sessions/session-events.js',uiAsset:`export function createSessionEvents(){return{push(){globalThis.__qaAppendedEvents=(globalThis.__qaAppendedEvents||0)+1},dispose(){}}}`});
  const custom=appended.kernel.sessions.create('group:20203',{trigger:'appended events'});await appended.page.goto(appended.base);await appended.page.locator('#nav button[data-panel=sessions]').click();const customRow=appended.frame.locator(`[data-session="${custom.id}"]`);await customRow.waitFor();await appended.frame.locator('#follow').uncheck();
  appended.kernel.sessions.update(custom,{activity:'appended policy test'});await wait(async()=>await appended.frame.locator('body').evaluate(()=>window.__qaAppendedEvents>0));await new Promise(r=>setTimeout(r,150));assert.doesNotMatch(await customRow.innerText(),/appended policy test/);await appended.frame.locator('#reload').click();await customRow.filter({hasText:'appended policy test'}).waitFor();assert.deepEqual(appended.errors,[]);assert.equal(appended.outbound(),0);
  console.log('✓ real appended session event policy selected while manual refresh remains functional');
}finally{heldList?.release();heldConfig?.release();await appended?.close();await f.close();}
const shared=await modelUiFixture({config:{ui:{refreshMs:60000}},uiAssetPath:'panels/refresh-policy.js',uiAsset:`export const DEFAULT_REFRESH_MS=2500;export const normalizeRefreshInterval=()=>2500;export const getRefreshInterval=()=>2500;export const setRefreshInterval=()=>2500;export const onRefreshInterval=()=>()=>{};`});
try{
  await shared.page.clock.install();await shared.page.addInitScript(()=>{window.__policyIntervals=new Map();const add=setInterval.bind(window),del=clearInterval.bind(window);window.setInterval=(fn,ms,...args)=>{const id=add(fn,ms,...args);window.__policyIntervals.set(id,ms);return id;};window.clearInterval=id=>{window.__policyIntervals.delete(id);del(id);};});
  const run=shared.kernel.sessions.create('group:20204',{trigger:'shared appended interval'});let configReads=0;shared.page.on('request',req=>{if(req.method()==='GET'&&new URL(req.url()).pathname==='/api/config')configReads++;});await shared.page.goto(shared.base);await shared.page.locator('#nav button[data-panel=sessions]').click();await shared.frame.locator(`[data-session="${run.id}"]`).waitFor();
  assert.equal(await shared.frame.locator('body').evaluate(()=>[...window.__policyIntervals.values()].includes(2500)),false);const before=configReads;await shared.page.clock.runFor(2600);assert.equal(configReads,before);assert.deepEqual(shared.errors,[]);assert.equal(shared.outbound(),0);
  console.log('✓ legacy refresh preference cannot reactivate periodic host or session reads');
}finally{await shared.close();}
