import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {modelUiFixture} from './model-ui-fixture.mjs';

// A real temporary application serves inert data. Account prefixes are only
// rewritten inside this browser: neither live QQ accounts nor their files run.
const child='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',prefix='/accounts/'+child;
const evidence=path.resolve('.qa-local/account-transition-browser-20261025');
fs.mkdirSync(evidence,{recursive:true});
const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark'}}}}),{page,frame}=qa;
const requests=[],observations=[],checks=[];
const browserOutbound=[];page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(qa.base+'/'))browserOutbound.push(request.url());});
const browserMessages=[];page.on('console',message=>{if(['warning','error'].includes(message.type()))browserMessages.push({type:message.type(),text:message.text()});});
let configGate=null,chatGate=null,saveGate=null,rejectSave=false,rejectedSaves=0;
const accounts=[
  {id:'primary',accountId:'100001',nickname:'合成主账号',status:'running',wanted:true,connected:true,paused:true},
  {id:child,accountId:'100002',nickname:'合成第二账号',status:'running',wanted:true,connected:true,paused:true},
];
function gate(){let release,enter;const promise=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});return{promise,release,entered,enter};}
const scopedAccount=url=>url.pathname.startsWith(prefix+'/')?child:'primary';

// Playwright screenshots contain real compositor pixels, including the native
// View Transition overlay. Decode PNG locally so assertions do not inspect an
// unrelated DOM colour while the displayed snapshot belongs to the old page.
function pixels(png){
  assert.equal(png.readUInt32BE(0),0x89504e47);let at=8,width,height,type,depth;const chunks=[];
  while(at<png.length){const size=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+size);if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8];type=data[9];assert.equal(data[12],0,'noninterlaced screenshots');}if(kind==='IDAT')chunks.push(data);at+=size+12;if(kind==='IEND')break;}
  assert.equal(depth,8);assert.ok([2,6].includes(type),'RGB or RGBA screenshot');const channels=type===6?4:3,stride=width*channels,raw=inflateSync(Buffer.concat(chunks)),rgba=Buffer.alloc(width*height*channels);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const row=y*stride,source=y*(stride+1),filter=raw[source];for(let x=0;x<stride;x++){const a=x>=channels?rgba[row+x-channels]:0,b=y?rgba[row+x-stride]:0,c=y&&x>=channels?rgba[row+x-stride-channels]:0;const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);assert.ok(filter<=4);rgba[row+x]=(raw[source+x+1]+predictor)&255;}}
  return{width,height,at:(x,y)=>[...rgba.subarray((y*width+x)*channels,(y*width+x)*channels+3)]};
}
function luminance(rgb){return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function sampleSurface(png){const decoded=pixels(png);return[[1250,810],[1280,700],[1000,820],[550,820]].map(([x,y])=>({x,y,rgb:decoded.at(x,y),light:luminance(decoded.at(x,y))}));}
async function screenshot(name){const png=await page.screenshot({path:path.join(evidence,name+'.png'),animations:'allow',timeout:5000});return sampleSurface(png);}
const group=()=>page.getByRole('radiogroup',{name:'切换 QQ 账号'});
async function mounted(account,panel){
  await page.waitForFunction(({account,panel})=>{const url=new URL(location.href);return(url.searchParams.get('account')||'primary')===account&&url.searchParams.get('panel')===panel&&document.querySelector('#nav button.active')?.dataset.panel===panel&&window.__qqaTransitionProbe?.contentReady;},{account,panel});
  await frame.locator('body[data-panel="'+panel+'"]').waitFor({state:'visible'});
  await page.waitForFunction(()=>{const p=window.__qqaTransitionProbe;return!p.transition||p.finished;});
  const src=await page.locator('#panel-host iframe').getAttribute('src');assert.ok(src.startsWith((account==='primary'?'':prefix)+'/panels/'+panel+'/'),src);
  assert.equal(await group().locator('[role=radio][aria-checked=true]').getAttribute('data-account-id'),account);
  observations.push({phase:'mounted',account,panel,src,probe:await page.evaluate(()=>({...window.__qqaTransitionProbe,transition:!!window.__qqaTransitionProbe.transition}))});
}
async function switchWithoutWait(account,{twice=false}={}){
  // Dispatch two immediately adjacent real button clicks. This avoids the
  // automation navigation waiter concealing the pending-content interval.
  await group().locator('[data-account-id="'+account+'"]').evaluate((button,twice)=>{button.click();if(twice)button.click();},twice);
}
async function heldSnapshot(name,{target,oldMode,newMode}){
  observations.push({phase:name+'-entered',page:await page.evaluate(()=>({url:location.href,probe:{...window.__qqaTransitionProbe,transition:!!window.__qqaTransitionProbe.transition},handoff:{...document.documentElement.dataset},navigationFrom:window.navigation?.activation?.from?.url,swaps:JSON.parse(sessionStorage.getItem('qqa.transition.test.swaps')||'[]')}))});
  await page.waitForFunction(({target})=>new URL(location.href).searchParams.get('account')===target&&window.__qqaTransitionProbe?.ready,{target});
  const probe=await page.evaluate(()=>{const p=window.__qqaTransitionProbe;return{...p,transition:!!p.transition,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),oldOpacity:getComputedStyle(document.documentElement,'::view-transition-old(root)').opacity,newOpacity:getComputedStyle(document.documentElement,'::view-transition-new(root)').opacity};});
  assert.equal(probe.contentReady,false,'the target has not finished its first real content');
  assert.equal(probe.transition,true,'real native cross-document transition was supplied');assert.equal(probe.ready,true);assert.equal(probe.finished,false,'the old snapshot remains active while data is pending');
  assert.equal(probe.bg,newMode==='light'?'#e4e6de':'#191a19','the live target DOM already uses its own, opposite account theme');
  const first=await screenshot(name+'-early');await page.waitForTimeout(180);const later=await screenshot(name+'-late');
  for(const sample of [...first,...later])assert.ok(oldMode==='dark'?sample.light<90:sample.light>150,'compositor must keep '+oldMode+' snapshot, got '+JSON.stringify(sample));
  const still=await page.evaluate(()=>({ready:window.__qqaTransitionProbe.ready,finished:window.__qqaTransitionProbe.finished,contentReady:window.__qqaTransitionProbe.contentReady}));assert.deepEqual(still,{ready:true,finished:false,contentReady:false});observations.push({phase:name,target,oldMode,newMode,probe,first,later,still});
}

try{
  const transitionAsset=await fetch(qa.base+'/account-transition.js');assert.equal(transitionAsset.status,200);assert.match(await transitionAsset.text(),/pageswap/);
  await page.addInitScript(()=>{
    if(window.top!==window)return;
    const probe=window.__qqaTransitionProbe={documentId:crypto.randomUUID(),timeOrigin:performance.timeOrigin,transition:null,ready:false,finished:false,contentReady:false,reveals:0,events:[]};
    addEventListener('pagereveal',event=>{probe.reveals++;probe.events.push('pagereveal');if(!event.viewTransition)return;probe.transition=event.viewTransition;event.viewTransition.ready.then(()=>{probe.ready=true;probe.events.push('transition-ready');},()=>{probe.events.push('transition-ready-rejected');});event.viewTransition.finished.then(()=>{probe.finished=true;probe.events.push('transition-finished');},()=>{probe.finished=true;probe.events.push('transition-finished-rejected');});});
    addEventListener('qqa-account-content-ready',()=>{probe.contentReady=true;probe.events.push('content-ready');});
    addEventListener('pageswap',event=>{const key='qqa.transition.test.swaps',rows=JSON.parse(sessionStorage.getItem(key)||'[]');rows.push({from:location.search,to:event.activation?.entry?.url,type:event.activation?.navigationType,transition:!!event.viewTransition,frameConnected:!!document.querySelector('#panel-host iframe')?.isConnected,inert:document.querySelector('.app-shell')?.inert??false});sessionStorage.setItem(key,JSON.stringify(rows));event.viewTransition?.ready.catch(error=>sessionStorage.setItem('qqa.transition.test.skip',error.name+': '+error.message));});
  });
  const manifest=(await qa.request('GET','/api/panels')).data;
  await page.route('**'+prefix+'/**',route=>{const url=new URL(route.request().url());requests.push({method:route.request().method(),path:url.pathname});url.pathname=url.pathname.slice(prefix.length);return route.continue({url:url.href});});
  await page.route('**/api/accounts',route=>route.fulfill({json:{accounts}}));
  await page.route('**/api/accounts/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'event: accounts\ndata: {}\n\n'}));
  await page.route('**/api/panels',route=>{requests.push({method:'GET',path:new URL(route.request().url()).pathname});return route.fulfill({json:manifest});});
  await page.route('**/api/config',async route=>{
    const url=new URL(route.request().url()),account=scopedAccount(url);requests.push({method:route.request().method(),path:url.pathname});
    assert.equal(route.request().method(),'GET');const held=configGate;if(held?.account===account){held.enter();await held.promise;}
    const config=qa.disk();config.ui.uikit={mode:account===child?'light':'dark'};return route.fulfill({json:config});
  });
  await page.route(/\/api\/chats(?:[/?]|$)/,async route=>{
    const url=new URL(route.request().url()),account=scopedAccount(url),pathname=url.pathname.replace(prefix,'');requests.push({method:route.request().method(),path:url.pathname});assert.equal(route.request().method(),'GET','no chat mutations are permitted');
    if(pathname==='/api/chats'){const held=chatGate;if(held?.account===account){held.enter();await held.promise;}return route.fulfill({json:{chats:[{key:'group_10001',chatName:account===child?'第二账号独立聊天':'主账号独立聊天',lastText:'合成只读内容',total:0,unread:0}]}});}
    if(pathname==='/api/chats/group_10001/messages')return route.fulfill({json:{messages:[],hasMore:false}});throw Error('Unexpected chat request '+pathname);
  });
  await page.route('**/api/config/lifecycle',async route=>{if(rejectSave){rejectedSaves++;return route.fulfill({status:503,json:{error:'合成保存失败，保留当前账号'}});}const held=saveGate;if(held){held.enter();await held.promise;}return route.continue();});

  await page.goto(qa.base+'/?account=primary&panel=settings');await mounted('primary','settings');
  assert.equal(await page.evaluate(()=>typeof PageRevealEvent==='function'&&typeof PageSwapEvent==='function'&&CSS.supports('view-transition-name','root')),true,'this compositor test requires native MPA View Transitions');
  await page.evaluate(async child=>{const {LIGHT_BASE}=await import('/panels/theme.js');localStorage.setItem('qq-agent.theme.v1.account.'+child,JSON.stringify({...LIGHT_BASE,preset:'light'}));sessionStorage.removeItem('qqa.transition.test.swaps');},child);
  const originalDoc=await page.evaluate(()=>window.__qqaTransitionProbe.documentId);
  let originalFrame=await page.locator('#panel-host iframe').elementHandle();
  await frame.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('温度');await frame.locator('.settings-search-result').getByText('温度',{exact:true}).click();
  rejectSave=true;await frame.locator('#field-api-temperature').fill('1.7');await frame.locator('.settings-save-toast[data-state=error]').waitFor({state:'visible'});
  await switchWithoutWait(child);await page.locator('#toast-region').getByText(/未切换/).waitFor({state:'visible'});
  assert.equal(await originalFrame.evaluate(el=>el.isConnected),true);assert.equal(await page.evaluate(()=>window.__qqaTransitionProbe.documentId),originalDoc);assert.equal(await frame.locator('#field-api-temperature').inputValue(),'1.7');assert.equal(await page.locator('#panel-host').evaluate(el=>el.inert),false);assert.ok(rejectedSaves>=2);checks.push('save failure keeps the original connected iframe, draft, account and usable editor');
  rejectSave=false;await frame.getByRole('button',{name:'重试保存',exact:true}).click();await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
  await page.evaluate(()=>navigation.addEventListener('navigate',event=>event.preventDefault(),{once:true}));await switchWithoutWait(child);await page.locator('#toast-region').getByText(/未切换/).last().waitFor({state:'visible'});
  await page.waitForFunction(oldFrame=>!oldFrame.isConnected,originalFrame);
  await page.waitForFunction(()=>!document.querySelector('.app-shell').inert&&document.querySelector('#panel-host iframe'));
  assert.equal(new URL(page.url()).searchParams.get('account'),'primary');assert.equal(await page.evaluate(()=>window.__qqaTransitionProbe.documentId),originalDoc);
  await frame.locator('#settings-sidebar').waitFor({state:'visible'});assert.equal(await originalFrame.evaluate(el=>el.isConnected),false,'cancelled commit reacquires the flushed account editor');originalFrame=await page.locator('#panel-host iframe').elementHandle();
  await frame.locator('#field-api-temperature').waitFor({state:'attached'});await frame.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('');await frame.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('温度');await frame.locator('.settings-search-result').getByText('温度',{exact:true}).click();assert.equal(await frame.locator('#field-api-temperature').isEditable(),true);checks.push('cancelled native navigation restores the saved same-account editor, scope and input without an inert lock');
  saveGate=gate();await frame.locator('#field-api-temperature').fill('1.3');await saveGate.entered;
  configGate={...gate(),account:child};await switchWithoutWait(child,{twice:true});
  assert.equal(await originalFrame.evaluate(el=>el.isConnected),true,'save waits must not remove the visible old iframe');assert.equal(await page.evaluate(()=>window.__qqaTransitionProbe.documentId),originalDoc);assert.equal(await page.locator('#panel-host iframe').count(),1);await screenshot('save-pending-original-frame');
  const saved=saveGate;saveGate=null;saved.release();await configGate.entered;
  await heldSnapshot('config-delayed-dark-to-light',{target:child,oldMode:'dark',newMode:'light'});
  const configHeld=configGate;configGate=null;configHeld.release();await mounted(child,'settings');
  assert.equal(qa.disk().api.temperature,1.3);assert.equal(await frame.locator('#field-api-temperature').inputValue(),'1.3');
  const swaps=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qqa.transition.test.swaps')||'[]'));assert.equal(swaps.length,1,'rapid repeated clicks produce a single account navigation');assert.equal(swaps[0].transition,true);assert.equal(swaps[0].frameConnected,true,'old iframe survives until the browser captures the outgoing page');assert.equal(swaps[0].inert,true,'the saved outgoing iframe cannot receive more input');checks.push('pending saves retain the old iframe; one gated save produces one native account transition');
  const lightFinal=await screenshot('light-target-ready');assert.ok(lightFinal.every(sample=>sample.light>150));

  await page.locator('#nav button[data-panel=chats]').click();await frame.locator('[data-chat=group_10001]').waitFor();await frame.locator('[data-chat=group_10001]').click();await frame.locator('#detail h3').filter({hasText:'第二账号独立聊天'}).waitFor();assert.equal(await frame.locator('#list .selected').count(),1);
  chatGate={...gate(),account:'primary'};await switchWithoutWait('primary');await chatGate.entered;
  await heldSnapshot('content-delayed-light-to-dark',{target:'primary',oldMode:'light',newMode:'dark'});
  const chatHeld=chatGate;chatGate=null;chatHeld.release();await mounted('primary','chats');
  await frame.getByText('主账号独立聊天',{exact:true}).waitFor();assert.equal(await frame.locator('#list .selected').count(),0);await frame.getByText('选择会话查看消息',{exact:true}).waitFor();
  const darkFinal=await screenshot('dark-target-ready');assert.ok(darkFinal.every(sample=>sample.light<90));
  await switchWithoutWait(child);await mounted(child,'chats');await frame.getByText('第二账号独立聊天',{exact:true}).waitFor();assert.equal(await frame.locator('#list .selected').count(),0);checks.push('first content GET holds the prior light snapshot until dark target data is ready; only panel name crosses accounts, never chat selection');

  assert.ok(requests.some(r=>r.path===prefix+'/api/config'));assert.ok(requests.some(r=>r.path===prefix+'/api/chats'));assert.ok(requests.some(r=>r.path===prefix+'/api/panels'));assert.equal(qa.writes.filter(r=>/\/chats\//.test(r.path)).length,0);assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);assert.deepEqual(browserOutbound,[]);checks.push('scoped config, catalog, iframe and content API; zero external requests, QQ messages or browser errors');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,observations,requests,swaps,rejectedSaves,errors:qa.errors,browserOutbound,outbound:qa.outbound()},null,2));
  console.log('✓ account transitions: native compositor snapshots across delayed config/content, dark/light account themes, save retention/failure, single navigation, preserved panel and isolated selection');
}catch(error){fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error?.stack||error),observations,requests,errors:qa.errors,browserMessages,page:await page.evaluate(()=>({url:location.href,probe:window.__qqaTransitionProbe&&{...window.__qqaTransitionProbe,transition:!!window.__qqaTransitionProbe.transition},handoff:{...document.documentElement.dataset},navigationFrom:window.navigation?.activation?.from?.url,skipped:sessionStorage.getItem('qqa.transition.test.skip')})).catch(()=>null)},null,2));configGate?.release();chatGate?.release();saveGate?.release();await page.screenshot({path:path.join(evidence,'failure.png'),timeout:5000}).catch(()=>{});throw error;}finally{configGate?.release();chatGate?.release();saveGate?.release();await qa.close();}
