import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';
const wait=async condition=>{for(let i=0;i<500;i++){if(await condition())return;await new Promise(r=>setTimeout(r,20));}throw new Error('controlled session state did not settle');};
const f=await modelUiFixture({nativeVisibility:process.env.QA_HEADED==='1'});let other,appended;
try {
  await f.page.emulateMedia({reducedMotion:'no-preference'});
  await f.page.clock.install();
  await f.page.addInitScript(()=>{
    window.__qaFrames=new Set();const raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window);window.requestAnimationFrame=fn=>{const owned=new Error().stack.includes('/panels/sessions/session-activity.js');const id=raf(time=>{if(owned)window.__qaFrames.delete(id);fn(time);});if(owned)window.__qaFrames.add(id);return id;};window.cancelAnimationFrame=id=>{window.__qaFrames.delete(id);caf(id);};window.__qaIntervals=new Map();const start=window.setInterval.bind(window),stop=window.clearInterval.bind(window);
    window.setInterval=(fn,ms,...args)=>{const id=start(fn,ms,...args);window.__qaIntervals.set(id,ms);return id;};window.clearInterval=id=>{window.__qaIntervals.delete(id);stop(id);};
    window.addEventListener('message',event=>{if(event.data?.method==='shell.event'&&event.data.params?.name?.startsWith('session-'))event.stopImmediatePropagation();},{capture:true});
  });
  await f.page.goto(f.base);await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('#sessions-panel[data-ready=true]').waitFor();
  const timers=()=>f.frame.locator('body').evaluate(()=>[...window.__qaIntervals.values(),...[...window.__qaFrames].map(()=>'raf')]);
  assert.deepEqual(await timers(),[],'idle session panel owns no periodic timer');
  const waiting=f.kernel.sessions.create('group:19801',{trigger:'QA waiting for countdown',waitUntil:Date.now()+60000});
  await f.frame.locator('#reload').click();const row=f.frame.locator(`[data-session="${waiting.id}"]`);await row.locator('[data-wait]').waitFor();
  // No selected detail yet: filtering all list clocks stops the visual timer.
  await f.frame.locator('#search').fill('no matching session');await wait(async()=>JSON.stringify(await timers())==='[]');await f.frame.locator('#search').fill('');await row.waitFor();
  await row.click();await f.frame.locator('.session-body [data-wait]').waitFor();
  const detailClock=f.frame.locator('.session-body [data-wait]'),beforeDetail=await detailClock.innerText();await f.page.clock.runFor(1100);assert.notEqual(await detailClock.innerText(),beforeDetail,'selected detail also ticks');assert.equal(await detailClock.innerText(),await row.locator('[data-wait]').innerText(),'list and detail use the same clock');
  assert.match(await row.locator('[data-wait]').innerText(),/等待 \d+\.\d 秒/);assert.deepEqual(await timers(),['raf']);
  await f.frame.locator('#search').fill('no matching session');await wait(async()=>JSON.stringify(await timers())==='["raf"]');const filteredDetail=await detailClock.innerText();await f.page.clock.runFor(1000);assert.notEqual(await detailClock.innerText(),filteredDetail,'visible detail keeps ticking with its row filtered out');await f.frame.locator('#search').fill('');await row.waitFor();await wait(async()=>JSON.stringify(await timers())==='["raf"]');
  await f.frame.locator('#search').fill('no matching session');await f.frame.locator('#json-mode').check();await wait(async()=>JSON.stringify(await timers())==='[]');await f.frame.locator('#json-mode').uncheck();await wait(async()=>JSON.stringify(await timers())==='["raf"]');await f.frame.locator('#search').fill('');await row.waitFor();
  f.kernel.sessions.finish(waiting.id,'done');
  f.kernel.httpServer.broadcast('hello',{});await f.page.clock.runFor(250);await wait(async()=>!(await row.locator('[data-wait]').count()));
  assert.match(await row.innerText(),/已回复/);await f.frame.locator('.session-body').filter({hasText:'已回复'}).waitFor();await wait(async()=>!(await timers()).length);
  const missed=f.kernel.sessions.create('group:19805',{trigger:'QA missed start',waitUntil:Date.now()+60000});
  f.kernel.httpServer.broadcast('hello',{});await f.page.clock.runFor(250);await f.frame.locator(`[data-session="${missed.id}"] [data-wait]`).waitFor();
  f.kernel.sessions.finish(missed.id,'done');f.kernel.httpServer.broadcast('hello',{});await f.page.clock.runFor(250);await f.frame.locator(`[data-session="${missed.id}"]`).filter({hasText:'已回复'}).waitFor();await wait(async()=>!(await timers()).length);
  const running=f.kernel.sessions.create('group:19806',{trigger:'QA running activity'});f.kernel.sessions.update(running,{activity:'调用 <img src=x> 天气工具',rounds:3,webSearchCount:2});
  await f.frame.locator('#reload').click();const runningRow=f.frame.locator(`[data-session="${running.id}"]`);await runningRow.locator('.session-activity').waitFor();assert.match(await runningRow.innerText(),/调用 <img src=x> 天气工具/);assert.match(await runningRow.innerText(),/3 轮.*搜索 2 次/);assert.equal(await runningRow.locator('img').count(),0);
  f.kernel.sessions.finish(running.id,'done');await f.frame.locator('#reload').click();await wait(async()=>!(await timers()).length);
  // Snapshot refresh must not reopen a native details slot that is closing.
  const completed=f.kernel.sessions.create('group:19802',{trigger:'QA trace fold'});f.kernel.sessions.update(completed,{messages:[{role:'assistant',content:{value:'trace'}}]});f.kernel.sessions.finish(completed.id,'done');
  await f.frame.locator('#reload').click();const doneRow=f.frame.locator(`[data-session="${completed.id}"]`);await doneRow.click();
  const outer=f.frame.locator('.session-body > details[data-key="message-0"]');await outer.locator(':scope > summary').click();const nested=outer.locator('details[data-collapsible]').first();if(!await nested.evaluate(n=>n.open))await nested.locator('summary').click();await nested.evaluate(async n=>{await Promise.allSettled(n.getAnimations().map(a=>a.finished));});
  await nested.evaluate(n=>{n.querySelector('summary').click();const a=n.getAnimations()[0];if(!a)throw new Error('trace details must have actual animation');a.pause();a.currentTime=90;});
  await f.frame.locator('#reload').click();await f.frame.locator('.session-body > details[data-key="message-0"]').waitFor();
  // Explicit reload revalidates the selected detail as well as the list.
  // Incremental rendering retains this intentionally paused closing animation.
  // Assert its logical target, then release the harness pause and check closure.
  await wait(async()=>await nested.evaluate(async n=>{const {collapsibleExpanded}=await import('/panels/collapsible.js');return !collapsibleExpanded(n);}));
  await nested.evaluate(n=>{for(const animation of n.getAnimations())if(animation.playState==='paused')animation.play();});
  await wait(async()=>await nested.evaluate(n=>!n.open));
  if(process.env.QA_HEADED==='1') {
    const active=f.kernel.sessions.create('group:19803',{trigger:'QA hidden pending',waitUntil:Date.now()+60000});await f.frame.locator('#reload').click();await f.frame.locator(`[data-session="${active.id}"] [data-wait]`).waitFor();
    other=await f.page.context().newPage();await other.goto('about:blank');await other.bringToFront();await f.page.waitForFunction(()=>document.hidden,undefined,{polling:100});await wait(async()=>!(await timers()).length);
    f.kernel.sessions.finish(active.id,'done');await f.page.bringToFront();await f.page.waitForFunction(()=>!document.hidden,undefined,{polling:100});await f.frame.locator(`[data-session="${active.id}"]`).filter({hasText:'已回复'}).waitFor();await wait(async()=>!(await timers()).length);
  }
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);await f.close();
  appended=await modelUiFixture({uiAssetPath:'panels/sessions/session-activity.js',uiAsset:`export const formatWaitDeadline=()=> '追加等待显示';export function installSessionActivity(){return{sync(){},dispose(){}}}`});const custom=appended.kernel.sessions.create('group:19804',{trigger:'appended',waitUntil:Date.now()+60000});await appended.page.locator('#nav button[data-panel=sessions]').click();await appended.frame.locator(`[data-session="${custom.id}"] [data-wait]`).filter({hasText:'追加等待显示'}).waitFor();assert.deepEqual(appended.errors,[]);
  console.log('✓ session activity: zero idle timers, precise visible clock/filter, reconnect list/detail reconciliation without periodic reads, logical trace fold target, real appended default; real background '+(process.env.QA_HEADED==='1'?'verified':'covered in headed run'));
}catch(error){console.error('ACTIVITY DEBUG',await f.frame.locator('body').evaluate(()=>({hidden:document.hidden,text:document.body.innerText})));throw error;}finally{await other?.close();await appended?.close();await f.close();}
