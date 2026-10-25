// Real default panels, authenticated RPC, terminal synthetic sessions and local
// archive mutations only. No live console, QQ, model or external account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const evidence=process.env.QA251_EVIDENCE;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const wait=async condition=>{for(let i=0;i<400;i++){if(await condition())return;await new Promise(r=>setTimeout(r,20));}throw Error('251 UI state did not settle');};
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve};};
const f=await modelUiFixture({config:{ui:{refreshMs:60000},proactive:{enabled:false},allow:{groups:['25101']}}});
try{
  // The real session-name controller still owns name enrichment.
  f.kernel.capability.register('transport.provider','kernel',{id:'synthetic251',selfId:'25199',start(){},stop(){},status:()=>({connected:true}),actions:{listGroups:async()=>[{group_id:25101,group_name:'示例·精修讨论组'},{group_id:25102,group_name:'示例·另一个群'}]}});
  const session=f.kernel.sessions.create('group:25101',{trigger:'安排验收 · 示例·精修讨论组'});
  f.kernel.sessions.update(session,{model:'synthetic251',providerId:'a',systemPrompt:'系统输入 <script>bad()</script>',userPrompt:'本次输入 <img src=x onerror=bad()>',usage:{calls:2,promptTokens:120,completionTokens:30,totalTokens:150,cachedTokens:40},rounds:2,messages:[
    {role:'system',content:'不重复显示的系统消息'},
    {role:'user',content:'不重复显示的用户消息'},
    {role:'assistant',content:'',tool_calls:[{id:'call251',function:{name:'echo251',arguments:'{}'}}]},
    {role:'tool',toolCall:{name:'echo251',args:{value:'<svg onload=bad()>'},result:'固定合成结果',ok:true}},
    {role:'assistant',content:'合成思考内容',raw:{usage:{total_tokens:150}}},
    {role:'tool',toolCall:{name:'fail251',args:{},result:'合成错误',ok:false}},
  ],sent:[{text:'第一条示例回复',ts:Date.now()-5000},{text:'第二条示例回复',ts:Date.now()-4000}]});
  f.kernel.sessions.finish(session.id,'done',{finishReason:'合成流程已结束'});
  const other=f.kernel.sessions.create('group:25102',{trigger:'另一群触发'});f.kernel.sessions.finish(other.id,'noreply');
  const key='group:25101',routeKey='group_25101';
  for(let i=1;i<=20;i++)f.kernel.store.appendIncoming(key,{mid:251000+i,ts:Date.now()-60000+i*1000,senderId:'25110',senderName:'示例成员',text:`示例消息 ${i}${i===4?'\n第二行':''}`,atMe:false});
  await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('#sessions-panel[data-ready=true]').waitFor();
  const item=f.frame.locator(`[data-session="${session.id}"]`);await item.click();await f.frame.locator('.flow-sent').waitFor();
  assert.equal(await item.evaluate(n=>getComputedStyle(n,'::before').content),'none','session list has no ordinal decoration');
  await f.frame.locator('#chat-filter').selectOption(key);await f.frame.locator('#list-context').filter({hasText:'示例·精修讨论组'}).waitFor();
  assert.equal(await item.locator('strong').innerText(),'安排验收');assert.doesNotMatch(await item.locator('.muted').innerText(),/精修讨论组|group:25101/);
  assert.equal(await f.frame.locator('#list [data-session]').count(),1);
  const body=f.frame.locator('.session-body');
  assert.equal(await body.locator('[data-key="message-0"],[data-key="message-1"],[data-key="message-2"]').count(),0,'input prompts and pure tool requests are not duplicate flow cards');
  assert.equal(await body.locator('.flow-tool').count(),2);assert.match(await body.locator('.flow-tool.flow-error > summary').innerText(),/fail251/);assert.match(await body.locator('.flow-tool.flow-error > summary').innerText(),/失败/);assert.equal(await body.locator('.flow-tool .flow-duration').count(),2);
  assert.equal(await body.locator('.flow-sent').evaluate(n=>n.open),true);assert.match(await body.locator('.flow-sent').innerText(),/第一条示例回复[\s\S]*第二条示例回复/);
  assert.equal(await body.locator('.flow-finish').evaluate(n=>n.open),true);assert.equal(await body.locator('script,img,svg').count(),0);
  await body.locator('[data-key="message-3"] > summary').click();await body.locator('[data-key="message-3-content"]').waitFor();
  await f.frame.locator('#reload').click();await wait(()=>body.locator('[data-key="message-3"]').evaluate(n=>n.open));
  await f.frame.locator('#json-mode').check();assert.match(await f.frame.locator('.raw-json').innerText(),/不重复显示的系统消息/);await f.frame.locator('#json-mode').uncheck();
  if(evidence){await f.frame.locator('#detail').evaluate(async n=>{await Promise.allSettled(n.getAnimations({subtree:true}).map(a=>a.finished));});await f.page.screenshot({path:path.join(evidence,'sessions-grouped.png'),fullPage:true});}
  await f.frame.locator('#chat-filter').selectOption('');assert.equal(await f.frame.locator('#list-context').isHidden(),true);assert.match(await item.locator('.session-row-title').innerText(),/精修讨论组/);assert.doesNotMatch(await item.locator('.muted').innerText(),/group:25101/);
  if(evidence)await f.page.screenshot({path:path.join(evidence,'sessions.png'),fullPage:true});
  console.log('✓ 251 session flow, safe text, grouped name, ordinals, JSON and open state');

  await f.page.locator('#nav button[data-panel=chats]').click();await f.frame.locator(`[data-chat="${routeKey}"] strong`).click();
  const host=f.frame.locator('.messages'),rows=host.locator(':scope > .message');await wait(async()=>await rows.count()===20);
  const geometry=await rows.first().evaluate(n=>{const b=n.getBoundingClientRect(),t=n.querySelector('.message-time').getBoundingClientRect(),s=n.querySelector('.message-sender').getBoundingClientRect(),m=n.querySelector('.body').getBoundingClientRect();return{height:b.height,time:t.left,sender:s.left,body:m.left};});
  assert.ok(geometry.height<60,JSON.stringify(geometry));assert.ok(geometry.time<geometry.sender&&geometry.sender<geometry.body,'time, sender and message are columns');
  assert.equal(await f.frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await f.frame.getByRole('button',{name:'选择消息',exact:true}).click();
  if(evidence){await host.evaluate(async n=>{await Promise.allSettled(n.getAnimations({subtree:true}).map(a=>a.finished));});await f.page.screenshot({path:path.join(evidence,'archive.png'),fullPage:true});}
  const remove=f.frame.getByRole('button',{name:'删除选中消息',exact:true}),control=await remove.elementHandle();
  const choose=async id=>{await host.locator(`[data-message="${id}"] input`).check();await wait(async()=>await remove.isEnabled());};
  const commit=()=>remove.evaluate(n=>{n.click();n.click();});
  await choose(1);await commit();await wait(async()=>await rows.count()===19);await wait(async()=>await remove.getAttribute('data-danger-progress')==='0');
  assert.equal(await remove.isDisabled(),true);assert.equal(await control.evaluate(n=>n.isConnected),true);
  await choose(2);await commit();await wait(async()=>await rows.count()===18);await wait(async()=>await remove.getAttribute('data-danger-progress')==='0');
  assert.equal(f.kernel.store.recent(key,100).some(m=>m.id===1||m.id===2),false,'second deletion works in the same mounted panel');
  console.log('✓ 251 repeated deletion without changing tabs');

  const held=gate(),entered=gate();
  const pattern=`**/api/chats/${routeKey}/delete-messages`;
  const delay=async route=>{const response=await route.fetch();entered.resolve();await held.promise;await route.fulfill({response});};
  await f.page.route(pattern,delay);
  try{
    await choose(3);await commit();await entered.promise;
    await wait(async()=>await rows.count()===17);await host.locator('[data-message="4"] input').check();
    assert.equal(await remove.isDisabled(),true,'selection changes cannot unlock a pending request');
    held.resolve();await wait(async()=>await remove.isEnabled());
    assert.equal(await control.evaluate(n=>n.isConnected),true);
  }finally{held.resolve();await f.page.unroute(pattern,delay);}
  const fail=async route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'QA251 合成失败'})});
  await f.page.route(pattern,fail);
  try{await commit();await f.frame.locator('.danger-error').filter({hasText:'QA251'}).waitFor();assert.equal(await remove.isEnabled(),true);assert.equal(await host.locator('[data-message="4"] input').isChecked(),true);}
  finally{await f.page.unroute(pattern,fail);}
  await commit();await wait(async()=>await rows.count()===16);await wait(async()=>await remove.getAttribute('data-danger-progress')==='0');
  assert.equal(f.kernel.store.recent(key,100).some(m=>m.id===4),false);
  console.log('✓ 251 pending SSE keeps lock; failed request preserves selection and retries');
  await wait(async()=>await f.frame.locator('.danger-removal-ghost').count()===0);
  await f.page.setViewportSize({width:540,height:850});
  await wait(()=>f.frame.locator('.message').first().evaluate(n=>n.getBoundingClientRect().width>0));
  assert.equal(await f.frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'compact archive fits a narrow panel');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
}catch(error){
  if(evidence){await f.page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});fs.writeFileSync(path.join(evidence,'failure-state.json'),JSON.stringify(await f.frame.locator('#detail').evaluate(n=>({html:n.innerHTML,selection:[...n.querySelectorAll('.message input')].map(c=>({id:c.value,checked:c.checked,hidden:c.hidden,inert:c.closest('[inert]')?.className})),animations:n.getAnimations({subtree:true}).map(a=>({state:a.playState,target:a.effect?.target?.className}))})),null,2));}
  throw error;
}finally{await f.close();}

const replacement=await modelUiFixture({config:{allow:{groups:['25103']}},uiAssetPath:'panels/sessions/trace-view.js',uiAsset:"export function renderSessionTrace(body,data){body.textContent='追加文件提供的会话详情';body.dataset.appendedTrace='true';body.dataset.appendedReasoning=data.activeStep?.reasoning||'';}"});
try{
  const s=replacement.kernel.sessions.create('group:25103',{trigger:'追加视图验证'});replacement.kernel.sessions.finish(s.id,'done');
  await replacement.page.locator('#nav button[data-panel=sessions]').click();await replacement.frame.locator(`[data-session="${s.id}"]`).click();
  await replacement.frame.locator('.session-body[data-appended-trace=true]').waitFor();
  assert.equal(await replacement.frame.locator('.session-body').innerText(),'追加文件提供的会话详情');assert.deepEqual(replacement.errors,[]);assert.equal(replacement.outbound(),0);
  const running=replacement.kernel.sessions.create('group:25103',{trigger:'旧版追加视图接收流式内容'});await replacement.frame.locator(`[data-session="${running.id}"]`).click();
  replacement.kernel.sessions.stream(running,{kind:'generation',state:'running',messageIndex:0,startedAt:Date.now(),elapsedMs:0,streamId:'replacement-stream',streamAttempt:0,revision:1,content:'',reasoning:'兼容视图的第一段'}, {reset:true,reasoning:'兼容视图的第一段',content:'',fromRevision:0,revision:1});
  await wait(async()=>await replacement.frame.locator('.session-body').getAttribute('data-appended-reasoning')==='兼容视图的第一段');assert.deepEqual(replacement.errors,[]);assert.equal(replacement.outbound(),0);
  console.log('✓ 251 legacy append-only trace replacement receives archives and live stream snapshots without requiring an incremental renderer');
}finally{await replacement.close();}
if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,at:new Date().toISOString(),headed:process.env.QA_HEADED==='1',realApplication:true,opaqueFrames:true,externalRequests:0,liveConsoleAccessed:false,scenarios:['legacy flow and compact columns','group title and no ordinals','safe text and raw JSON','fold state across refresh','same mounted button reused','immediate next selection during exit','pending SSE lock','failed deletion retry','narrow layout','append-only trace override']},null,2)+'\n');
