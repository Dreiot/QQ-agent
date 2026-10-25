// Real archive/store/SSE, isolated opaque iframe and local synthetic data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async check=>{for(let i=0;i<500;i++){if(await check())return;await pause(20);}throw Error('254 archive did not settle');};
const evidence=process.env.QA254_EVIDENCE,baseline=process.env.QA254_BASELINE;
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const f=await modelUiFixture({config:{ui:{refreshMs:1000},proactive:{enabled:false},allow:{groups:['25401'],private:['25402','25403']}},...(baseline?{uiAssetPath:'panels/chats/panel.js',uiAsset:fs.readFileSync(baseline,'utf8')}: {})});
const key='group:25401',uiKey='group_25401',otherKey='private:25402',otherUi='private_25402',events=[];
let reads=0,verification;
try{
  f.page.on('request',request=>{if(new URL(request.url()).pathname===`/api/chats/${uiKey}/messages`)reads++;});
  for(let i=1;i<=620;i++)f.kernel.store.appendIncoming(key,{mid:254000+i,ts:Date.now()-700000+i*1000,senderId:'25410',senderName:'合成成员',text:`阅读消息 ${i}`,atMe:false,...(i===452?{media:[{kind:'image',file:'local-synthetic-image'}]}:i===453?{media:[{kind:'forward',id:'synthetic254'}]}:{})});
  for(let i=1;i<=75;i++)f.kernel.store.appendIncoming(otherKey,{mid:354000+i,senderId:'25420',senderName:'另一位合成成员',text:`另一个聊天 ${i}`,atMe:false});
  await f.page.locator('#nav button[data-panel=chats]').click();
  const chat=f.frame.locator(`[data-chat="${uiKey}"] strong`),other=f.frame.locator(`[data-chat="${otherUi}"] strong`),host=f.frame.locator('.messages'),lines=host.locator(':scope > .message');
  await chat.click();await wait(async()=>await lines.count()===500);
  await host.locator('[data-message="450"]').evaluate(n=>{window.__row254=n;window.__body254=n.querySelector('.body');window.__check254=n.querySelector('input');window.__meta254=n.querySelector('.meta');});
  f.kernel.store.updateByMid(key,254450,{text:'原消息实时修改 450'});f.kernel.bus.emit('chat.update',key);
  await host.locator('[data-message="450"] .body').filter({hasText:'原消息实时修改 450'}).waitFor();
  const reused=await host.locator('[data-message="450"]').evaluate(n=>n===window.__row254&&n.querySelector('.body')===window.__body254&&n.querySelector('input')===window.__check254&&n.querySelector('.meta')===window.__meta254);
  if(baseline){assert.equal(reused,false,'old content update replaces the entire message row');console.log('✓ 254 old panel reproduces message/checkbox/body replacement');}
  else{
    assert.equal(reused,true,'editing a message patches the existing message, body, checkbox and metadata');
    events.push('changed existing message retains all reading surfaces');
    const select=f.frame.locator('.selection-toggle'),remove=f.frame.locator('.delete-selection'),preview=f.frame.locator('#quote-preview');
    assert.equal(await preview.isHidden(),true);assert.equal(await remove.isHidden(),true);assert.doesNotMatch(await chat.locator('..').locator('.muted').innerText(),/未读/);
    assert.equal(await f.frame.getByRole('button',{name:'全选',exact:true}).count(),0);
    assert.equal(await f.frame.locator('#quote-toggle,#reload,main > .head button').count(),0,'redundant header buttons are removed');
    if(evidence)await f.page.screenshot({path:path.join(evidence,'archive-normal.png'),fullPage:true});
    await select.click();assert.equal(await select.innerText(),'取消选择');assert.equal(await preview.isVisible(),true);assert.equal(await preview.isDisabled(),true);assert.equal(await remove.isVisible(),true);
    const entrance=await preview.evaluate(node=>{
      const animation=node.getAnimations().find(item=>item.animationName==='archive-action-in');if(!animation)return null;
      animation.pause();const frames=[0,70,240].map(time=>{animation.currentTime=time;const css=getComputedStyle(node);return{x:css.transform==='none'?0:new DOMMatrixReadOnly(css.transform).m41,opacity:Number(css.opacity)};});animation.finish();return frames;
    });
    assert.ok(entrance&&entrance[0].x<=-17&&entrance[1].x>entrance[0].x&&entrance[2].x===0&&entrance[0].opacity===0&&entrance[2].opacity===1,'upload action pops in from the left');
    await host.locator('[data-message="450"] input').check();assert.equal(await preview.isEnabled(),true);await preview.click();await f.frame.locator('dialog.quote-dialog').waitFor();
    assert.equal(await remove.isDisabled(),true,'deletion stays unavailable while reviewing a quote');
    await f.frame.locator('dialog.quote-dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await host.locator('[data-message="450"] input').isChecked(),true);
    await select.click();assert.equal(await select.innerText(),'选择消息');assert.equal(await host.locator('input:checked').count(),0);assert.equal(await preview.isHidden(),true);assert.equal(await remove.isHidden(),true);
    await select.click();await host.locator('[data-message="450"] input').check();
    const controls=await f.frame.locator('.archive-toolbar').evaluate(n=>{const group=n.querySelector('.archive-actions'),actions=group.getBoundingClientRect(),send=n.querySelector('.archive-test-send').getBoundingClientRect(),input=n.querySelector('input').getBoundingClientRect(),count=n.querySelector('.selection-count'),remove=group.querySelector('.delete-selection');return{left:actions.right<=send.left,right:Math.abs(send.right-n.getBoundingClientRect().right)<2,filled:Math.abs(input.left-actions.right-6)<2,countAfterDelete:count.previousElementSibling===remove,sameLine:Math.abs(count.getBoundingClientRect().top+count.getBoundingClientRect().height/2-(remove.getBoundingClientRect().top+remove.getBoundingClientRect().height/2))<2};});assert.deepEqual(controls,{left:true,right:true,filled:true,countAfterDelete:true,sameLine:true});
    await pause(180);
    const glow=await host.locator('[data-message="450"]').evaluate(n=>({gradient:getComputedStyle(n,'::before').backgroundImage,opacity:getComputedStyle(n,'::before').opacity,border:getComputedStyle(n).borderLeftColor}));
    assert.match(glow.gradient,/linear-gradient\(90deg/);assert.equal(glow.opacity,'1');assert.equal(await host.locator('[data-message="451"]').evaluate(n=>getComputedStyle(n,'::before').opacity),'0');
    if(evidence)await f.page.screenshot({path:path.join(evidence,'archive-selection.png'),fullPage:true});
    events.push('header shortcuts removed; selection actions enter from the left, count follows delete, warning glow marks checked rows and input fills the remaining width');
    await f.frame.getByRole('button',{name:'加载更早消息',exact:true}).click();await wait(async()=>await lines.count()===620);
    assert.equal(await host.locator('summary[aria-label="消息详情"]').count(),0,'raw message details are removed');
    await f.page.route('**/api/media-data',route=>route.fulfill({json:{results:[{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII='}]}}));
    await host.locator('[data-message="452"]').getByRole('button',{name:'查看图片'}).click();await host.locator('[data-message="452"] img').waitFor();
    let forwardedText='第一版合并转发';
    await f.page.route(`**/api/chats/${uiKey}/messages/453/forward`,route=>route.fulfill({json:{count:1,messages:[{senderName:'合成转发成员',text:forwardedText}]}}));
    const forwardButton=host.locator('[data-message="453"]').getByRole('button',{name:'展开合并转发'});
    await forwardButton.click();await host.locator('.forward-content').filter({hasText:forwardedText}).waitFor();
    forwardedText='第二版合并转发';await forwardButton.click();await host.locator('.forward-content').filter({hasText:forwardedText}).waitFor();
    await f.frame.locator('#test-send-text').fill('这个聊天独立的未发送草稿');
    await host.evaluate(n=>{const row=n.querySelector('[data-message="430"]');n.scrollTop+=row.getBoundingClientRect().top-n.getBoundingClientRect().top-20;});
    await host.evaluate(n=>{
      window.__host254=n;window.__tools254=document.querySelector('#detail .toolbar');window.__draft254=document.querySelector('#test-send-text');
      window.__image254=n.querySelector('[data-message="452"] img');
      window.__forward254=n.querySelector('[data-message="453"] .forward-content');
      window.__stamp254=n.querySelector('[data-message="450"] .message-time').firstChild;
      window.__list254=new Map([...document.querySelectorAll('#list [data-chat]')].map(row=>[row.dataset.chat,row]));
      window.__scroll254=n.scrollTop;window.__contentWrites254=0;
      window.__observer254=new MutationObserver(records=>{window.__contentWrites254+=records.filter(r=>r.type==='childList'||r.type==='characterData').length;});window.__observer254.observe(n,{childList:true,characterData:true,subtree:true});
    });
    const stable=()=>host.evaluate(n=>({host:n===window.__host254,tools:document.querySelector('#detail .toolbar')===window.__tools254,draft:document.querySelector('#test-send-text')===window.__draft254,
      row:n.querySelector('[data-message="450"]')===window.__row254,body:n.querySelector('[data-message="450"] .body')===window.__body254,
      check:n.querySelector('[data-message="450"] input')===window.__check254,checked:n.querySelector('[data-message="450"] input').checked,
      stamp:n.querySelector('[data-message="450"] .message-time').firstChild===window.__stamp254,
      open:window.__forward254.open,image:n.querySelector('[data-message="452"] img')===window.__image254,
      forward:n.querySelector('[data-message="453"] .forward-content')===window.__forward254,
      rows:[...window.__list254].every(([id,row])=>document.querySelector(`[data-chat="${id}"]`)===row),scroll:n.scrollTop,initialScroll:window.__scroll254,
      wholeAnimation:document.querySelector('#detail').getAnimations().some(a=>a.playState==='running'),actionAnimation:[...document.querySelectorAll('.archive-actions button')].some(n=>n.getAnimations().some(a=>a.animationName==='archive-action-in'&&a.playState==='running')),writes:window.__contentWrites254}));
    const before=reads;f.kernel.httpServer.broadcast('hello',{});await wait(()=>Promise.resolve(reads>=before+1));f.kernel.httpServer.broadcast('hello',{});await wait(()=>Promise.resolve(reads>=before+2));await pause(80);
    const quiet=await stable();for(const name of ['host','tools','draft','row','body','check','checked','stamp','open','image','forward','rows'])assert.equal(quiet[name],true,name);
    assert.equal(quiet.wholeAnimation,false);assert.equal(quiet.actionAnimation,false,'quiet reconciliation does not replay the action entrance');assert.equal(quiet.writes,0,'unchanged reconciliation must not rewrite even the time/sender text nodes');assert.ok(Math.abs(quiet.scroll-quiet.initialScroll)<=1);
    events.push('repeated reconnect reconciliation writes no message content and preserves loaded image/fold/draft/selection/scroll');
    const started=Date.now();f.kernel.store.appendIncoming(key,{mid:254621,senderId:'25410',text:'SSE 即时新增 621',atMe:false});f.kernel.bus.emit('chat.update',key);
    await host.locator('[data-message="621"]').waitFor();const elapsed=Date.now()-started;assert.ok(elapsed<950,`SSE should not await the 1000ms fallback (${elapsed}ms)`);
    const live=await stable();for(const name of ['host','tools','draft','row','body','check','checked','stamp','open','image','forward','rows'])assert.equal(live[name],true,name);assert.equal(live.wholeAnimation,false);assert.ok(Math.abs(live.scroll-live.initialScroll)<=1);
    f.kernel.store.markRecalled(key,254450);f.kernel.store.updateByMid(key,254450,{text:'撤回状态原位更新',senderName:'合成成员新名称'});f.kernel.bus.emit('chat.update',key);
    await host.locator('[data-message="450"] .message-state').filter({hasText:'已撤回'}).waitFor();assert.equal((await stable()).row,true);assert.equal((await stable()).forward,true);assert.equal((await stable()).image,true);assert.equal((await stable()).checked,true);
    events.push('real SSE append and recall/text/sender updates patch existing rows without replaying whole-pane animation');
    await f.frame.locator('#test-send-text').focus();
    f.kernel.bus.emit('chat.update',key);await pause(180);assert.equal(await f.frame.locator('#test-send-text').evaluate(n=>document.activeElement===n),true);
    const savedScroll=await host.evaluate(n=>n.scrollTop);
    await other.click();await host.locator('.body').filter({hasText:'另一个聊天 75'}).waitFor();
    assert.equal(await host.evaluate(n=>n===window.__host254&&document.querySelector('#detail .toolbar')===window.__tools254),true,'chat switches retain the pane and toolbar');
    assert.equal(await host.locator('input:checked').count(),0,'local message IDs cannot leak selection to a different chat');assert.equal(await f.frame.locator('#test-send-text').inputValue(),'');
    await f.frame.getByRole('button',{name:'选择消息',exact:true}).click();await host.locator('[data-message="30"] input').check();await f.frame.locator('#test-send-text').fill('另一个聊天的独立草稿');
    await host.evaluate(n=>{n.scrollTop=200;window.__otherScroll254=n.scrollTop;});
    await chat.click();await wait(async()=>await lines.count()===621);await wait(async()=>!(await f.frame.locator('#detail').evaluate(n=>n.inert)));
    assert.equal(await host.locator('[data-message="450"] input').isChecked(),true);assert.equal(await host.locator('[data-message="453"] .forward-content').evaluate(n=>n.open),true);
    assert.equal(await f.frame.locator('#test-send-text').inputValue(),'这个聊天独立的未发送草稿');assert.ok(Math.abs(await host.evaluate(n=>n.scrollTop)-savedScroll)<=1,'returning restores the previously loaded older window and scroll');
    assert.equal(await f.frame.locator('#detail').evaluate(n=>n.getAnimations().some(a=>a.playState==='running')),false);
    // Start just after one recovery cycle so its two paging requests are not
    // mistaken for a redundant request caused by the next click.
    const recoveryReads=reads;f.kernel.httpServer.broadcast('hello',{});await wait(()=>Promise.resolve(reads>=recoveryReads+2));await pause(80);
    const reselectReads=reads;await chat.click();await pause(100);assert.equal(reads,reselectReads,'reselect has no redundant detail request');
    await other.click();await host.locator('.body').filter({hasText:'另一个聊天 75'}).waitFor();assert.equal(await host.locator('[data-message="30"] input').isChecked(),true);assert.equal(await f.frame.locator('#test-send-text').inputValue(),'另一个聊天的独立草稿');assert.ok(Math.abs(await host.evaluate(n=>n.scrollTop-window.__otherScroll254))<=1);
    events.push('switching preserves each chat\'s older window, independent selection, folds, draft and scroll, with a stable toolbar');
    // Unified selection survives switching and the preview excludes deletion.
    await select.click();await select.click();await host.locator('[data-message="25"] input').check();
    await chat.click();await host.locator('[data-message="621"]').waitFor();await other.click();await host.locator('.body').filter({hasText:'另一个聊天 75'}).waitFor();
    assert.equal(await select.getAttribute('aria-pressed'),'true');assert.equal(await host.locator('[data-message="25"] input').isChecked(),true);await preview.click();await f.frame.locator('dialog.quote-dialog').waitFor();assert.equal(await remove.isDisabled(),true);
    await f.frame.locator('dialog.quote-dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await host.locator('[data-message="25"] input').isChecked(),true);await select.click();
    // A slow B request followed by A must neither replace A nor lose its state.
    await chat.click();await host.locator('[data-message="621"]').waitFor();
    let release,entered;const blocked=new Promise(resolve=>release=resolve),startedRead=new Promise(resolve=>entered=resolve);let held=false;
    const pattern=`**/api/chats/${otherUi}/messages?*`,delay=async route=>{if(held)return route.continue();held=true;const response=await route.fetch();entered();await blocked;await route.fulfill({response});};
    await f.page.route(pattern,delay);
    try{await other.click();await startedRead;assert.equal(await f.frame.locator('#detail').evaluate(n=>n.inert),true);await chat.click();await wait(async()=>!(await f.frame.locator('#detail').evaluate(n=>n.inert)));release();await pause(150);assert.equal(await host.locator('[data-message="450"] input').isChecked(),true);assert.equal(await f.frame.locator('#test-send-text').inputValue(),'这个聊天独立的未发送草稿');assert.equal(await host.locator('.body').filter({hasText:'另一个聊天 75'}).count(),0);}
    finally{release();await f.page.unroute(pattern,delay);}
    events.push('upload selection survives switching; preview excludes deletion and late reads cannot overwrite a newer selection');
    // Empty states are also stable under quiet recovery, both in the list and
    // inside a chat whose synthetic archive has no remaining messages.
    const emptyKey='private:25403',emptyUi='private_25403';f.kernel.store.appendIncoming(emptyKey,{mid:454001,text:'empty fixture'});f.kernel.store.removeByLocalIds(emptyKey,[1]);f.kernel.bus.emit('chat.update','*');
    await f.frame.locator(`[data-chat="${emptyUi}"] strong`).click();await host.locator('.empty').waitFor();
    await host.evaluate(n=>{window.__empty254=n.querySelector('.empty');});await pause(1300);assert.equal(await host.locator('.empty').evaluate(n=>n===window.__empty254),true);
    await f.frame.locator('#search').fill('no-synthetic-chat-matches');await f.frame.locator('#list .empty').waitFor();await f.frame.locator('#list .empty').evaluate(n=>{window.__listEmpty254=n;});await pause(1300);assert.equal(await f.frame.locator('#list .empty').evaluate(n=>n===window.__listEmpty254),true);await f.frame.locator('#search').fill('');
    await chat.click();await host.locator('[data-message="621"]').waitFor();events.push('empty history/list placeholders also retain their DOM under recovery');
    assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);assert.equal(f.writes.some(w=>/delete|clear|test-send|quotes/.test(w.path)),false);
    verification={passed:true,headed:process.env.QA_HEADED==='1',events,selectionPolish:{entrance,controls,glow},sseLatencyMs:elapsed,quietContentWrites:quiet.writes,externalRequests:f.outbound(),liveConsoleAccessed:false};
    if(evidence)await f.page.screenshot({path:path.join(evidence,'archive-incremental.png'),fullPage:true});
    const headings=[];for(const id of ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']){
      await f.page.locator(`#nav button[data-panel="${id}"]`).click();await f.frame.locator(`body[data-panel="${id}"] main > .head`).waitFor();
      const style=await f.frame.locator('main > .head').evaluate(n=>{const css=getComputedStyle(n),main=getComputedStyle(n.parentElement);return{minHeight:css.minHeight,paddingBottom:css.paddingBottom,marginBottom:css.marginBottom,paddingTop:main.paddingTop};});assert.deepEqual(style,{minHeight:'44px',paddingBottom:'10px',marginBottom:'14px',paddingTop:'10.4px'},id);headings.push(id);
    }
    verification.compactHeaders=headings;events.push('all nine default panels consume the same compact heading spacing');
    console.log('✓ 254 in-place message/meta/media updates, quiet recovery, real SSE, stable pane, per-chat reading/selection/quote/draft and rapid-switch guards');
  }
}catch(error){if(evidence)await f.page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}
finally{await f.close();}

if(!baseline){
  const replacement=await modelUiFixture({config:{allow:{groups:['25404']}},uiAssetPath:'panels/chats/message-view.js',uiAsset:"export function createMessageView(){const node=document.createElement('div');node.className='message';node.dataset.appendedMessage='true';return{node,update(message){node.dataset.message=String(message.id);node.textContent='追加消息视图：'+message.text;}};}"});
  try{replacement.kernel.store.appendIncoming('group:25404',{mid:554001,text:'独立替换验证'});await replacement.page.locator('#nav button[data-panel=chats]').click();await replacement.frame.locator('[data-chat=group_25404] strong').click();await replacement.frame.locator('.message[data-appended-message=true]').filter({hasText:'追加消息视图：独立替换验证'}).waitFor();assert.deepEqual(replacement.errors,[]);assert.equal(replacement.outbound(),0);console.log('✓ 254 append-only message-view replacement is consumed by the real default panel');}
  finally{await replacement.close();}
  if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({...verification,at:new Date().toISOString(),appendOnlyMessageViewVerified:true},null,2)+'\n');
}
