// Actual runner -> orchestrator -> SessionRegistry -> authenticated SSE/GET ->
// opaque default UI. Only inert selected model/tool components are injected.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await pause(20);}throw Error('256 live operation did not settle');};
const gate=()=>{let resolve,reject;return{promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
const evidence=process.env.QA256_EVIDENCE;if(evidence)fs.mkdirSync(evidence,{recursive:true});
let plan=null,requests=[],enteredTools=0;
const f=await modelUiFixture({nativeVisibility:process.env.QA_HEADED==='1',config:{ui:{refreshMs:60000},allow:{groups:['25601','25602','25603','25604','25605'],private:[]},sessionRetryAttempts:0,drainDelayMs:600000,memory:{consolidateEnabled:false,discoverMaxMembers:0},proactive:{enabled:false}},components:{
  'llm.complete':async options=>{
    requests.push(structuredClone(options.messages));const index=plan.calls++;plan.notifyRequest=options.onRequest;await (index===0?plan.generation.promise:plan.second.promise);
    return{message:{role:'assistant',content:index===0?'首轮模型结果':'第二轮模型结果',...(index===0?{tool_calls:[{id:'clock256',type:'function',function:{name:'clock256',arguments:'{}'}}]}:{})}};
  },
  'core.tools.bundle':()=>({tools:[{type:'function',function:{name:'clock256',description:'Fixed local echo only',parameters:{type:'object',properties:{}}}}],excludedTools:[],invoke:async()=>{enteredTools++;await plan.tool.promise;return plan.toolResult??{ok:true,result:'固定本地结果'};}}),
}});
let running=null,other=null;
const events=[];
try{
  await f.page.addInitScript(()=>{window.__frameTimes256=[];window.__frames256=new Set();const raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window);window.requestAnimationFrame=fn=>{const owned=new Error().stack.includes('/panels/sessions/session-activity.js');const id=raf(time=>{if(owned){window.__frames256.delete(id);window.__frameTimes256.push(time);if(window.__frameTimes256.length>500)window.__frameTimes256.shift();}fn(time);});if(owned)window.__frames256.add(id);return id;};window.cancelAnimationFrame=id=>{window.__frames256.delete(id);caf(id);};window.__timers256=new Map();const start=window.setInterval.bind(window),stop=window.clearInterval.bind(window);window.setInterval=(fn,ms,...args)=>{const id=start(fn,ms,...args);window.__timers256.set(id,ms);return id;};window.clearInterval=id=>{window.__timers256.delete(id);stop(id);};});
  await f.page.goto(f.base);await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('#sessions-panel[data-ready=true]').waitFor();await f.frame.locator('#follow').uncheck();
  let reads=0;f.page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/sessions'))reads++;});
  const timers=()=>f.frame.locator('body').evaluate(()=>[...window.__timers256.values(),...[...window.__frames256].map(()=>'raf')]);
  assert.deepEqual(await timers(),[]);
  async function start(chatKey,previous=false){
    plan={calls:0,generation:gate(),tool:gate(),second:gate()};
    f.kernel.store.appendIncoming(chatKey,{mid:Date.now(),senderId:'25610',text:'QA256 fixed local test',atMe:true});
    const session=f.kernel.sessions.create(chatKey,{trigger:'本地计时验证',waitUntil:Date.now()+60000});
    if(previous)f.kernel.sessions.update(session,{messages:[{role:'assistant',content:'上一轮阅读内容',generationDurationMs:123}],rounds:1});
    running=f.kernel.orchestrator.wake(chatKey,{waitingSessionId:session.id,verified:true});
    await wait(()=>Promise.resolve(session.activeStep?.kind==='generation'));
    await f.frame.locator(`[data-session="${session.id}"] strong`).click();await f.frame.locator('.flow-think.flow-pending').waitFor();
    return session;
  }
  async function grows(clock){const before=await clock.innerText();await pause(360);assert.notEqual(await clock.innerText(),before,'in-flight elapsed must grow locally');}
  async function stableCard(card){await card.evaluate(n=>{window.__card256=n;window.__duration256=n.querySelector('.flow-duration');window.__detail256=document.querySelector('#detail');window.__root256=n.parentElement;window.__scroll256=window.__detail256.scrollTop;});}
  const sameCard=card=>card.evaluate(n=>n===window.__card256&&n.querySelector('.flow-duration')===window.__duration256&&n.parentElement===window.__root256&&document.querySelector('#detail')===window.__detail256);
  const first=await start('group:25601',true),generation=f.frame.locator('.flow-think.flow-pending');
  assert.equal(first.activeStep.messageIndex,3,'retry/previous-run offset reaches the actual future message index');
  assert.equal(await generation.evaluate(n=>n.open),true,'a live thought opens immediately so incoming reasoning is visible');
  await generation.locator(':scope > summary').click();await generation.evaluate(async n=>{await Promise.allSettled(n.getAnimations().map(a=>a.finished));});
  await generation.locator(':scope > summary').click();await generation.evaluate(async n=>{await Promise.allSettled(n.getAnimations().map(a=>a.finished));});
  await stableCard(generation);await pause(160);const readBefore=reads;await grows(generation.locator('.flow-duration'));assert.equal(reads,readBefore,'frame-aligned painting must not perform server reads');assert.equal(await sameCard(generation),true);
  await grows(f.frame.locator('.session-elapsed'));
  const generationStart=first.activeStep.startedAt;plan.notifyRequest?.();plan.notifyRequest?.();await pause(150);assert.equal(first.activeStep.startedAt,generationStart);assert.equal(await sameCard(generation),true,'request retry notices must keep the same in-flight slot');
  const frameTiming=await f.frame.locator('body').evaluate(()=>{const times=window.__frameTimes256.slice(-80),gaps=times.slice(1).map((time,index)=>time-times[index]).filter(gap=>gap>0).sort((a,b)=>a-b);return{frames:times.length,medianMs:gaps[Math.floor(gaps.length*.5)]??null,p95Ms:gaps[Math.floor(gaps.length*.95)]??null,over100ms:gaps.filter(gap=>gap>=100).length};});
  assert.ok(frameTiming.frames>8,'a visible running clock follows visual frames instead of a 100ms tick');
  console.log('FRAME_TIMING_256 '+JSON.stringify(frameTiming));
  if(evidence)fs.writeFileSync(path.join(evidence,'frame-timing.json'),JSON.stringify(frameTiming,null,2));
  assert.equal(await f.frame.locator('#detail').evaluate(n=>n.getAnimations().some(a=>a.playState==='running')),false);
  assert.equal(await generation.evaluate(n=>n.open),true);
  if(evidence)await f.page.screenshot({path:path.join(evidence,'thinking-running.png'),fullPage:true});
  plan.generation.resolve();await wait(()=>Promise.resolve(enteredTools===1));await f.frame.locator('.flow-tool.flow-pending').waitFor();
  const generationDone=f.frame.locator('[data-key="message-3"]');assert.equal(await sameCard(generationDone),true);assert.equal(await generationDone.evaluate(n=>n.open),true);
  const fixedGeneration=await generationDone.locator('.flow-duration').innerText();await pause(250);assert.equal(await generationDone.locator('.flow-duration').innerText(),fixedGeneration);
  events.push('real generation start grows without polling; completion keeps card/clock/open state and freezes');
  const tool=f.frame.locator('.flow-tool.flow-pending');await tool.locator(':scope > summary').click();await tool.evaluate(async n=>{await Promise.allSettled(n.getAnimations().map(a=>a.finished));});await stableCard(tool);await grows(tool.locator('.flow-duration'));
  assert.equal(await sameCard(tool),true);assert.equal(await tool.locator('.flow-hint').innerText(),'调用中');
  if(process.env.QA_HEADED==='1'){
    other=await f.page.context().newPage();await other.goto('about:blank');await other.bringToFront();await f.page.waitForFunction(()=>document.hidden,undefined,{polling:50});await wait(async()=>!(await timers()).includes('raf'));
    const hidden=await tool.locator('.flow-duration').innerText();await pause(250);assert.equal(await tool.locator('.flow-duration').innerText(),hidden);
    await f.page.bringToFront();await f.page.waitForFunction(()=>!document.hidden,undefined,{polling:50});await wait(async()=>(await timers()).includes('raf'));await grows(tool.locator('.flow-duration'));await other.close();other=null;
  }
  if(evidence)await f.page.screenshot({path:path.join(evidence,'tool-running.png'),fullPage:true});
  plan.tool.resolve();await f.frame.locator('.flow-tool.flow-success').waitFor();const toolDone=f.frame.locator('.flow-tool.flow-success');assert.equal(await sameCard(toolDone),true);assert.equal(await toolDone.evaluate(n=>n.open),true);
  const fixedTool=await toolDone.locator('.flow-duration').innerText();await f.frame.locator('.flow-think.flow-pending').waitFor();await grows(f.frame.locator('.flow-think.flow-pending .flow-duration'));assert.equal(await toolDone.locator('.flow-duration').innerText(),fixedTool);
  const secondStart=first.activeStep.startedAt,beforeLeave=await f.frame.locator('.flow-think.flow-pending .flow-duration').innerText();
  await f.page.locator('#nav button[data-panel=settings]').click();await f.frame.locator('#status').waitFor();await pause(250);await f.page.locator('#nav button[data-panel=sessions]').click();await f.frame.locator('.flow-think.flow-pending').waitFor();
  assert.equal(first.activeStep.startedAt,secondStart);assert.notEqual(await f.frame.locator('.flow-think.flow-pending .flow-duration').innerText(),beforeLeave);await grows(f.frame.locator('.flow-think.flow-pending .flow-duration'));assert.equal((await timers()).filter(ms=>ms==='raf').length,1,'remount owns exactly one local animation-frame clock');
  plan.second.resolve();await running;running=null;await wait(async()=>!(await timers()).includes('raf'));assert.equal(first.status,'noreply');assert.equal(first.activeStep,null);
  events.push('real tool start/completion and next generation reuse slots; hidden clocks stop and resume with elapsed continuity');
  const toolFailure=await start('group:25604');plan.toolResult={ok:false,error:'固定本地工具失败'};plan.generation.resolve();await f.frame.locator('.flow-tool.flow-pending').waitFor();const failedTool=f.frame.locator('.flow-tool.flow-pending');await stableCard(failedTool);await grows(failedTool.locator('.flow-duration'));plan.tool.resolve();await f.frame.locator('.flow-tool.flow-error').waitFor();assert.equal(await sameCard(f.frame.locator('.flow-tool.flow-error')),true);const failedToolTime=await f.frame.locator('.flow-tool.flow-error .flow-duration').innerText();await pause(250);assert.equal(await f.frame.locator('.flow-tool.flow-error .flow-duration').innerText(),failedToolTime);plan.second.resolve();await running;running=null;assert.equal(toolFailure.activeStep,null);
  events.push('failed tool completion freezes in place while the next model step is free to start');
  const failure=await start('group:25602');const failing=f.frame.locator('.flow-think.flow-pending');await stableCard(failing);await grows(failing.locator('.flow-duration'));plan.generation.reject(Error('固定本地模型失败'));await running;running=null;
  await f.frame.locator('.flow-think.flow-error').waitFor();assert.equal(failure.status,'error');assert.equal(await sameCard(f.frame.locator('.flow-think.flow-error')),true);const fixedFailure=await f.frame.locator('.flow-think.flow-error .flow-duration').innerText();await pause(250);assert.equal(await f.frame.locator('.flow-think.flow-error .flow-duration').innerText(),fixedFailure);await wait(async()=>!(await timers()).includes('raf'));
  events.push('failed generation freezes its original pending card');
  const canceledGeneration=await start('group:25605');const cancelGeneration=f.frame.locator('.flow-think.flow-pending');await stableCard(cancelGeneration);await grows(cancelGeneration.locator('.flow-duration'));f.kernel.orchestrator.abortSession(canceledGeneration.id);await f.frame.locator('.flow-think.flow-aborted').waitFor();const canceledGenerationTime=await f.frame.locator('.flow-think.flow-aborted .flow-duration').innerText();await pause(250);assert.equal(await f.frame.locator('.flow-think.flow-aborted .flow-duration').innerText(),canceledGenerationTime);plan.generation.resolve();await running;running=null;await wait(()=>Promise.resolve(canceledGeneration.activeStep===null));assert.equal(await sameCard(f.frame.locator('.flow-think.flow-aborted')),true);assert.equal(await f.frame.locator('.flow-think.flow-aborted .flow-duration').innerText(),canceledGenerationTime);
  events.push('canceling a model request freezes immediately and its late response cannot change the duration');
  const aborted=await start('group:25603');plan.generation.resolve();await f.frame.locator('.flow-tool.flow-pending').waitFor();const cancel=f.frame.locator('.flow-tool.flow-pending');await stableCard(cancel);await grows(cancel.locator('.flow-duration'));
  assert.equal(f.kernel.orchestrator.abortSession(aborted.id).ok,true);await f.frame.locator('.flow-tool.flow-aborted').waitFor();await wait(async()=>!(await timers()).includes('raf'));const fixedAbort=await f.frame.locator('.flow-tool.flow-aborted .flow-duration').innerText();await pause(250);assert.equal(await f.frame.locator('.flow-tool.flow-aborted .flow-duration').innerText(),fixedAbort);
  plan.tool.resolve();await running;running=null;await wait(()=>Promise.resolve(aborted.activeStep===null));assert.equal(await sameCard(f.frame.locator('.flow-tool.flow-aborted')),true);assert.equal(await f.frame.locator('.flow-tool.flow-aborted .flow-duration').innerText(),fixedAbort,'late success cannot restart or rewrite the aborted clock');
  events.push('abort freezes immediately even when the synthetic tool ignores abort; late result retains the same fixed clock');
  for(const request of requests)for(const message of request){assert.equal('activeStep'in message,false);assert.equal('generationState'in message,false);assert.equal('toolCall'in message,false);}
  // Terminal panels release their local paint interval, including after leave.
  f.kernel.orchestrator.pause();await wait(async()=>!(await timers()).includes('raf'));
  await f.page.locator('#nav button[data-panel=settings]').click();await f.frame.locator('#status').waitFor();
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,headed:process.env.QA_HEADED==='1',events,realRunnerOrchestrator:true,localClockNoExtraReads:true,modelPayloadClean:true,externalRequests:0,liveConsoleAccessed:false},null,2)+'\n');
  console.log('✓ 256 actual live generation/tool clocks, stable completion/failure/abort, hidden recovery, retry offset and clean model requests');
}catch(error){if(evidence)await f.page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}
finally{plan?.generation.resolve();plan?.tool.resolve();plan?.second.resolve();await running?.catch(()=>{});await other?.close();await f.close();}
