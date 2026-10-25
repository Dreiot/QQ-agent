// Real default panel, real SSE and authenticated GETs on a fresh inert app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const wait=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('253 incremental view did not settle');};
const evidence=process.env.QA253_EVIDENCE;if(evidence)fs.mkdirSync(evidence,{recursive:true});
const baseline=process.env.QA253_BASELINE;
const f=await modelUiFixture({config:{ui:{refreshMs:1000},proactive:{enabled:false}},...(baseline?{uiAssetPath:'panels/sessions/panel.js',uiAsset:fs.readFileSync(baseline,'utf8')}: {})});
const selectedTitle=id=>baseline?f.frame.locator('#detail h3').filter({hasText:id}):f.frame.locator(`#detail[data-session-id="${id}"] h3`);
const makeMessages=count=>Array.from({length:count},(_,i)=>({role:'assistant',content:`合成思考 ${i}\n`+'稳定的阅读内容。'.repeat(20)}));
const events=[];let reads=0,detailReads=0;
try{
  f.page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/sessions')reads++;if(/^\/api\/sessions\/[^/]+$/.test(url.pathname))detailReads++;});
  const a=f.kernel.sessions.create('group:25301',{trigger:'持续更新的会话'}),b=f.kernel.sessions.create('group:25302',{trigger:'已结束的会话'}),c=f.kernel.sessions.create('private:25303',{trigger:'未回复的会话'});
  f.kernel.sessions.update(a,{messages:makeMessages(32),systemPrompt:'合成系统提示',userPrompt:'合成本次输入',activity:'初始阶段',rounds:1});
  f.kernel.sessions.update(b,{messages:makeMessages(2)});f.kernel.sessions.finish(b.id,'done');f.kernel.sessions.finish(c.id,'noreply');
  await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('#sessions-panel[data-ready=true]').waitFor();await f.frame.locator('#follow').uncheck();
  await f.frame.locator(`[data-session="${a.id}"] strong`).click();await selectedTitle(a.id).waitFor();
  await f.frame.locator('body').evaluate(async()=>{await Promise.allSettled(document.getAnimations().map(animation=>animation.finished));});
  await f.frame.locator('#list').evaluate(node=>{window.__rows253=new Map([...node.children].map(n=>[n.dataset.session,n]));window.__option253=document.querySelector('#chat-filter option[value="group:25301"]');});
  const stableRows=()=>f.frame.locator('#list').evaluate(node=>[...window.__rows253].every(([id,row])=>row.isConnected&&node.querySelector(`[data-session="${id}"]`)===row)&&window.__option253===document.querySelector('#chat-filter option[value="group:25301"]'));
  await f.frame.locator(`[data-session="${b.id}"] strong`).click();await selectedTitle(b.id).waitFor();
  if(baseline){assert.equal(await stableRows(),false,'old selection recreates every list card');console.log('✓ 253 old panel counterexample reproduces whole-list replacement');}
  else{
    assert.equal(await stableRows(),true,'selecting another session must retain every list row and filter option');
    assert.equal(await f.frame.locator('#detail').evaluate(n=>n.getAnimations().some(a=>a.playState==='running')),false,'selection must not fade the full detail pane');
    const before=detailReads;await f.frame.locator(`[data-session="${b.id}"] strong`).click();await new Promise(r=>setTimeout(r,100));assert.equal(detailReads,before,'reselecting the same session performs no redundant fetch');
    await f.frame.locator(`[data-session="${a.id}"] strong`).click();await selectedTitle(a.id).waitFor();
    const card=f.frame.locator('[data-key="message-10"]');await card.locator(':scope > summary').click();
    await card.evaluate(n=>{const detail=n.closest('#detail');detail.scrollTop+=n.getBoundingClientRect().top-detail.getBoundingClientRect().top-30;});
    await card.evaluate(n=>{window.__card253=n;window.__text253=n.querySelector('pre');window.__meta253=document.querySelector('.session-meta');window.__body253=n.parentElement;window.__top253=n.closest('#detail').scrollTop;});
    const snapshot=()=>card.evaluate(n=>({card:n===window.__card253,text:n.querySelector('pre')===window.__text253,meta:document.querySelector('.session-meta')===window.__meta253,body:n.parentElement===window.__body253,open:n.open,top:n.closest('#detail').scrollTop,detailAnimation:document.querySelector('#detail').getAnimations().some(a=>a.playState==='running')}));
    const readBefore=reads;f.kernel.httpServer.broadcast('hello',{});await wait(()=>Promise.resolve(reads>=readBefore+1));f.kernel.httpServer.broadcast('hello',{});await wait(()=>Promise.resolve(reads>=readBefore+2));const quiet=await snapshot();
    assert.ok(quiet.card&&quiet.text&&quiet.meta&&quiet.body&&quiet.open);assert.equal(quiet.detailAnimation,false);assert.ok(Math.abs(quiet.top-await card.evaluate(()=>window.__top253))<2);assert.equal(await stableRows(),true);
    events.push('selection and repeated quiet reconciliation retain nodes, folds and scroll');
    // Record the last model-message node and grow that exact message in place.
    await f.frame.locator('[data-key="message-31"]').evaluate(n=>{window.__last253=n;window.__lastText253=n.querySelector('pre');});
    const updated=makeMessages(32);updated[31].content+='\nSSE 实时追加内容';
    const started=Date.now();f.kernel.sessions.update(a,{messages:updated,activity:'实时工具调用',rounds:2});
    await f.frame.locator(`[data-session="${a.id}"] .session-activity`).filter({hasText:'实时工具调用'}).waitFor();
    await wait(()=>f.frame.locator('[data-key="message-31"] pre').evaluate(n=>n.textContent.includes('SSE 实时追加内容')));
    const elapsed=Date.now()-started;assert.ok(elapsed<950,'SSE must update before the 1000ms fallback cycle');
    assert.equal(await f.frame.locator('[data-key="message-31"]').evaluate(n=>n===window.__last253&&n.querySelector('pre')===window.__lastText253),true,'stream growth patches the same text surface');
    const live=await snapshot();assert.ok(live.card&&live.text&&live.meta&&live.body&&live.open);assert.equal(live.detailAnimation,false);assert.equal(await stableRows(),true);
    // A real new tool/error/sent/end event changes only its corresponding parts.
    updated.push({role:'tool',toolCall:{name:'local_echo253',args:{value:'示例'},result:'完成',ok:true}});
    f.kernel.sessions.update(a,{messages:updated,sent:[{text:'实时发送记录',ts:Date.now()}]});f.kernel.sessions.finish(a.id,'done',{finishReason:'实时完成'});
    await f.frame.locator('.flow-sent').filter({hasText:'实时发送记录'}).waitFor();await f.frame.locator('.flow-finish').filter({hasText:'实时完成'}).waitFor();
    assert.equal(await f.frame.locator(`[data-session="${a.id}"]`).getAttribute('data-status'),'done');assert.ok((await snapshot()).card);assert.equal(await stableRows(),true);
    events.push('real SSE patches message text, tool, sent, terminal state and finish without replacing siblings');
    // Exercise the real button callback, including its post-request detail selection.
    const abortable=f.kernel.sessions.create('group:25304',{trigger:'可实际中止的会话'}),abortRow=f.frame.locator(`[data-session="${abortable.id}"]`);
    await abortRow.getByRole('button',{name:'中止',exact:true}).click();
    await selectedTitle(abortable.id).waitFor();await abortRow.locator('.session-state-label').filter({hasText:'已中止'}).waitFor();
    assert.equal(f.kernel.sessions.peek(abortable.id).status,'aborted');
    assert.equal(f.writes.filter(write=>write.method==='POST'&&write.path===`/api/sessions/${abortable.id}/abort`).length,1);
    assert.equal(await abortRow.locator('.error').count(),0,'successful abort must not report a callback ReferenceError');
    assert.equal(await stableRows(),true,'aborting a new session retains the existing list rows');
    events.push('real abort button finishes and selects its session without callback errors');
    if(evidence)await f.page.screenshot({path:path.join(evidence,'incremental-view.png'),fullPage:true});
    assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
    if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,headed:process.env.QA_HEADED==='1',at:new Date().toISOString(),events,sseLatencyMs:elapsed,quietReconciliationVerified:true,liveConsoleAccessed:false,externalRequests:f.outbound()},null,2)+'\n');
    console.log('✓ 253 stable selection, silent reconciliation, real-time SSE text/tool/sent/end patches and preserved reading state');
  }
}finally{await f.close();}
