import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {chatCompletion} from '../src/kernel/llm.js';
let modelStream=false,finishModel=()=>{};
const completion=async args=>{
 if(!modelStream)return {message:{role:'assistant',content:''},finishReason:'stop'};
 const encode=new TextEncoder(),packet=delta=>`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`;
 const body=new ReadableStream({start(controller){controller.enqueue(encode.encode(packet({reasoning_content:'从模型经调度器实时送达的第一段'})));finishModel=()=>{try{controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n'));controller.close();}catch{}};}});
 return chatCompletion({...args,fetchFn:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})});
};
const f=await modelUiFixture({components:{'llm.complete':completion},marketClientFactory:()=>({listAccounts:()=>({accounts:[]})})}),{page,frame,kernel}=f;
const evidence=path.resolve('.qa-local/visual-realtime-20261024');fs.mkdirSync(evidence,{recursive:true});
const reads=[];page.on('request',req=>{if(req.method()==='GET'&&req.url().startsWith(f.base+'/api/'))reads.push(new URL(req.url()).pathname);});
const wait=async(fn,label)=>{for(let i=0;i<160;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error(label);};
const records=[];
try{
  await page.locator('#nav [data-panel=sessions]').click();await frame.locator('[data-ready=true]').waitFor();
  const session=kernel.sessions.create('group:10001',{trigger:'实时思考验证'});
  const messages=[{role:'system',content:'合成测试'},{role:'user',content:'测试输入'}];
  let step={kind:'generation',messageIndex:2,streamId:'ui-stream-1',revision:0,state:'running',startedAt:Date.now(),elapsedMs:0,content:'',reasoning:''};
  kernel.sessions.update(session,{status:'running',messages,activeStep:step});
  await frame.locator('.flow-pending').waitFor();await new Promise(r=>setTimeout(r,350));
  const baseline=reads.length;
  const send=async(content,reasoning='',reset=false)=>{const fromRevision=step.revision;step={...step,revision:fromRevision+1,content:reset?content:step.content+content,reasoning:reset?reasoning:step.reasoning+reasoning};kernel.sessions.stream(session,{...step},{content,reasoning,reset,fromRevision,revision:step.revision});await new Promise(r=>setTimeout(r,65));};
  await send('第一段','正在逐项检查',true);await frame.locator('[data-key="message-2-content"] pre').filter({hasText:'第一段'}).waitFor();
  assert.equal(session.status,'running','text is visible before completion');
  await page.screenshot({path:path.join(evidence,'streaming-thought.png')});
  await frame.locator('[data-key="message-2"]').evaluate(n=>{window.__streamCard=n;window.__streamPre=n.querySelector('pre');window.__streamText=n.querySelector('pre').firstChild;});
  for(let i=0;i<20;i++)await send(' · '+i,'。');
  await wait(()=>frame.locator('[data-key="message-2-content"] pre').evaluate(n=>n.textContent.endsWith('19')),'stream did not grow');
  assert.equal(reads.length,baseline,'token deltas cause zero snapshot/status reads');
  assert.equal(await frame.locator('[data-key="message-2"]').evaluate(n=>n===window.__streamCard&&n.querySelector('pre')===window.__streamPre&&n.querySelector('pre').firstChild===window.__streamText),true);
  assert.equal(await frame.locator('.raw-json').textContent(),'','hidden raw JSON is not serialized');
  await frame.locator('[data-key="message-2"] > summary').click();await send('后续');
  await wait(()=>frame.locator('[data-key="message-2"]').evaluate(n=>!n.open),'manual collapse survives text growth and finishes its animation');
  step={...step,streamId:'ui-retry',revision:0,content:'',reasoning:''};await send('重试后的内容','重新检查',true);
  await wait(()=>frame.locator('[data-key="message-2-content"] pre').evaluate(n=>n.textContent==='重试后的内容'),'retry must reset projection');
  kernel.sessions.update(session,{messages:[...messages,{role:'assistant',content:'最终已完成',reasoning_content:'完整摘要',generationDurationMs:1200}],activeStep:null});kernel.sessions.finish(session.id,'done');
  await wait(()=>frame.locator('[data-key="message-2-content"] pre').evaluate(n=>n.textContent==='最终已完成'),'final snapshot did not reconcile');
  records.push({check:'stream',fragments:23,tokenSnapshotReads:0,retainedCard:true,firstTextBeforeCompletion:true});
  console.log('✓ 303 genuine SSE deltas paint before completion, retain nodes/folds, retry resets and lazy JSON');
  modelStream=true;kernel.config.update({allow:{private:['30301']},api:{maxRounds:1},memory:{consolidateEnabled:false}});
  kernel.store.appendIncoming('private:30301',{mid:'stream-303',senderId:'30301',senderName:'合成联系人',text:'模型流式检查'});
  await frame.locator('#follow').check();const run=kernel.orchestrator.wake('private:30301',{verified:true});
  await frame.locator('.flow-pending [data-key$="-reasoning"] pre').filter({hasText:'从模型经调度器实时送达的第一段'}).waitFor();
  const liveSession=kernel.sessions.current('private:30301');assert.equal(liveSession.status,'running');assert.ok(liveSession.activeStep.reasoning.includes('第一段'));
  finishModel();await run;assert.notEqual(liveSession.status,'running');
  assert.equal(liveSession.messages.find(message=>message.role==='assistant')?.reasoning_content,'从模型经调度器实时送达的第一段','finishing preserves the reasoning that was already streamed');modelStream=false;
  console.log('✓ 303 model SSE → runner → orchestrator → persisted session → browser, before final gate');
  await page.clock.install();
  for(const id of ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']){
    await page.locator(`#nav [data-panel=${id}]`).click();await frame.locator(`body[data-panel=${id}]`).waitFor();
    for(let i=0;i<5;i++){await page.clock.runFor(250);await new Promise(r=>setTimeout(r,50));}
    const before=reads.length;await page.clock.runFor(45000);await new Promise(r=>setTimeout(r,80));await page.clock.runFor(300);
    const quiet=reads.slice(before);assert.deepEqual(quiet,[],`${id}: no fixed-interval reads while idle`);
    await page.screenshot({path:path.join(evidence,`${id}-desktop.png`)});
    const overflow=await frame.locator('body').evaluate(n=>n.scrollWidth>n.ownerDocument.documentElement.clientWidth+2);assert.equal(overflow,false,`${id} desktop horizontal overflow`);
    records.push({panel:id,virtualIdleSeconds:45,requests:quiet.length});console.log(`✓ 303 ${id}: 45 seconds idle, zero periodic reads`);
  }
  await page.setViewportSize({width:640,height:900});await page.clock.runFor(500);
  for(const id of ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']){
    await page.locator(`#nav [data-panel=${id}]`).click();await frame.locator(`body[data-panel=${id}]`).waitFor();await page.clock.runFor(600);await new Promise(r=>setTimeout(r,80));await page.clock.runFor(300);
    const geometry=await frame.locator('body').evaluate(n=>({width:n.ownerDocument.documentElement.clientWidth,overflow:n.scrollWidth-n.ownerDocument.documentElement.clientWidth}));assert.ok(geometry.overflow<=2,`${id} narrow overflow ${geometry.overflow}`);
    await page.screenshot({path:path.join(evidence,`${id}-narrow.png`)});
  }
  assert.deepEqual(f.errors,[]);fs.writeFileSync(path.join(evidence,'live-pages.json'),JSON.stringify(records,null,2));
  console.log('✓ 303 all nine panels: desktop/narrow geometry, no browser errors');
}finally{finishModel();await f.close();}
