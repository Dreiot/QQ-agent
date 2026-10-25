import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const f=await modelUiFixture({config:{ui:{uikit:{mode:'dark',dark:{borderWidth:0}}}}}),out=path.resolve('.qa-local/ui-followup-20261025/stream');fs.mkdirSync(out,{recursive:true});
const wait=async(read,test,label)=>{for(let i=0;i<160;i++){if(test(await read()))return;await new Promise(r=>setTimeout(r,25));}throw Error(label);};
try{
 const s=f.kernel.sessions.create('group:10001',{trigger:'很长的会话标题'.repeat(40)}),start=Date.now(),base={kind:'generation',state:'running',messageIndex:0,startedAt:start,elapsedMs:0,streamId:'fixture-stream',streamAttempt:0};
 await f.page.locator('#nav button[data-panel=sessions]').click();const row=f.frame.locator(`[data-session="${s.id}"]`);await row.locator('.list-entry-open').click();
 const title=row.locator('.list-entry-open strong');const measure=await title.evaluate(n=>({height:n.getBoundingClientRect().height,line:parseFloat(getComputedStyle(n).lineHeight),scroll:n.scrollWidth,width:n.clientWidth,wrap:getComputedStyle(n).whiteSpace}));assert.equal(measure.wrap,'nowrap');assert.ok(measure.height<=measure.line+1);assert.ok(measure.scroll>measure.width,'long title is ellipsized');
 let reason='第一段：检查收到的信息。';f.kernel.sessions.stream(s,{...base,revision:1,content:'',reasoning:reason},{reset:true,reasoning:reason,content:'',fromRevision:0,revision:1});
 const thought=f.frame.locator('.flow-reasoning'),pre=thought.locator('pre');await wait(()=>pre.textContent(),text=>text===reason,'first reasoning chunk must be visible before completion');assert.equal(await thought.isVisible(),true);assert.equal(await thought.evaluate(n=>n.open),true);assert.equal(f.kernel.sessions.get(s.id).status,'running');
 const handle=await pre.elementHandle();await f.page.screenshot({path:path.join(out,'first-chunk.png')});
 const more='\n第二段：结合上下文继续判断。';reason+=more;f.kernel.sessions.stream(s,{...base,revision:2,content:'',reasoning:reason},{reset:false,reasoning:more,content:'',fromRevision:1,revision:2});await wait(()=>pre.textContent(),text=>text===reason,'second chunk appends before completion');assert.equal(await handle.evaluate(n=>n.isConnected),true,'streaming retains the same text container');assert.equal(f.kernel.sessions.get(s.id).status,'running');
 const long='\n'.repeat(2)+Array.from({length:80},(_,i)=>`思考示例 ${i}`).join('\n');reason+=long;f.kernel.sessions.stream(s,{...base,revision:3,content:'',reasoning:reason},{reset:false,reasoning:long,content:'',fromRevision:2,revision:3});await wait(()=>pre.textContent(),x=>x===reason,'long thought');await pre.evaluate(n=>{n.scrollTop=0;});
 const tail='\n仍在逐段追加。';reason+=tail;f.kernel.sessions.stream(s,{...base,revision:4,content:'',reasoning:reason},{reset:false,reasoning:tail,content:'',fromRevision:3,revision:4});await wait(()=>pre.textContent(),x=>x===reason,'tail thought');assert.equal(await pre.evaluate(n=>n.scrollTop),0,'reading earlier thoughts does not jump to the bottom');
 const paint=await pre.evaluate(n=>({width:getComputedStyle(n).borderTopWidth,style:getComputedStyle(n).borderTopStyle}));assert.notEqual(paint.style,'none');assert.ok(parseFloat(paint.width)>0,JSON.stringify(paint));
 f.kernel.sessions.update(s,{messages:[{role:'assistant',content:'最终正文',reasoning_content:reason}],activeStep:null});f.kernel.sessions.finish(s.id,'done');await wait(()=>f.frame.locator('.flow-think > summary').innerText(),x=>!x.includes('进行中'),'terminal status');assert.equal(await pre.textContent(),reason);assert.equal(await thought.isVisible(),true);await f.page.screenshot({path:path.join(out,'completed.png')});
 assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);console.log('✓ One-line session titles; real SSE reasoning chunks visible before completion; retained nodes, manual scroll, final archive and content borders');
}finally{await f.close();}
