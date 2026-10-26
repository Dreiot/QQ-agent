import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {readPanelTarget} from '../ui/shell/account-navigation.js';

const child='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',prefix='/accounts/'+child;
const targets=['settings','chats','rules','memory','usage'];
const definitions=targets.map(id=>({id}));
assert.equal(readPanelTarget('?panel=settings&panel=chats',definitions),null,'ambiguous panel requests must fall back');
assert.equal(readPanelTarget('?panel=..%2Fsettings',definitions),null,'paths cannot become panel IDs');
assert.equal(readPanelTarget('?panel=removed',definitions),null,'absent panels must fall back');

const qa=await modelUiFixture(),{page,frame}=qa;
const evidence=path.resolve('.qa-local/account-navigation-browser-20261025');
fs.mkdirSync(evidence,{recursive:true});
const observations=[],requests=[],checks=[];
let missingChildMemory=false,rejectSave=false,rejectedSaves=0;
const accounts=[
  {id:'primary',accountId:'100001',nickname:'合成主账号',status:'running',wanted:true,connected:true,paused:true},
  {id:child,accountId:'100002',nickname:'合成第二账号',status:'running',wanted:true,connected:true,paused:true},
];
try{
  const manifest=(await qa.request('GET','/api/panels')).data;
  assert.ok(targets.every(id=>manifest.panels.some(panel=>panel.id===id)));
  // One temporary inert kernel serves both synthetic scopes. Prefixes are
  // rewritten only inside this browser fixture, never on the live QQA server.
  await page.route('**'+prefix+'/**',route=>{
    const url=new URL(route.request().url());requests.push(url.pathname);
    assert.ok(url.pathname.startsWith(prefix+'/'));url.pathname=url.pathname.slice(prefix.length);
    return route.continue({url:url.href});
  });
  await page.route('**/api/accounts',route=>route.fulfill({json:{accounts}}));
  await page.route('**/api/accounts/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'event: accounts\ndata: {}\n\n'}));
  await page.route('**/api/panels',route=>{
    const url=new URL(route.request().url()),scoped=url.pathname.startsWith(prefix+'/');
    requests.push(url.pathname);
    return route.fulfill({json:{...manifest,panels:manifest.panels.filter(panel=>!(scoped&&missingChildMemory&&panel.id==='memory'))}});
  });
  await page.route(/\/api\/chats(?:[/?]|$)/,route=>{
    const url=new URL(route.request().url()),pathname=url.pathname.replace(prefix,'');requests.push(url.pathname);
    assert.equal(route.request().method(),'GET','navigation must never mutate or send chat messages');
    if(pathname==='/api/chats')return route.fulfill({json:{chats:[{key:'group_10001',chatName:'合成聊天',lastText:'只读导航样本',total:0,unread:0}]}});
    if(pathname==='/api/chats/group_10001/messages')return route.fulfill({json:{messages:[],hasMore:false}});
    throw Error('Unexpected fixture chat route: '+pathname);
  });
  await page.route('**/api/config/lifecycle',route=>{
    if(rejectSave&&route.request().method()==='POST'){
      ++rejectedSaves;return route.fulfill({status:503,json:{error:'合成保存失败，保留当前账号'}});
    }
    return route.continue();
  });
  const group=()=>page.getByRole('radiogroup',{name:'切换 QQ 账号'});
  async function mounted(account,panel){
    await page.waitForFunction(({account,panel})=>{
      const url=new URL(location.href),selected=document.querySelector('#nav button.active');
      return (url.searchParams.get('account')||'primary')===account&&url.searchParams.get('panel')===panel&&selected?.dataset.panel===panel&&!document.documentElement.inert&&!document.querySelector('.app-shell')?.inert;
    },{account,panel});
    await frame.locator('body[data-panel="'+panel+'"]').waitFor({state:'visible'});
    if(panel==='settings')await frame.locator('#settings-sidebar a[data-target=models]').waitFor({state:'visible'});
    const src=await page.locator('#panel-host iframe').getAttribute('src');
    assert.ok(src.startsWith((account==='primary'?'':prefix)+'/panels/'+panel+'/'),src);
    assert.equal(await group().locator('[role=radio][aria-checked=true]').getAttribute('data-account-id'),account);
    const url=new URL(page.url());assert.deepEqual([...url.searchParams.keys()].sort(),['account','panel']);
    observations.push({account,panel,src,url:url.pathname+url.search});
  }
  async function switchTo(account,panel,{keyboard=false,manager=false}={}){
    if(manager){await page.getByRole('button',{name:'账号管理',exact:true}).click();await page.locator('dialog[data-account-manager]').getByRole('button',{name:'查看 '+(account==='primary'?'合成主账号':'合成第二账号'),exact:true}).click();}
    else if(keyboard){await group().locator('[role=radio][aria-checked=true]').focus();await page.keyboard.press(account==='primary'?'Home':'End');}
    else await group().locator('[data-account-id="'+account+'"]').click();
    await mounted(account,panel);
  }
  await page.goto(qa.base+'/?account=primary&panel=settings');await mounted('primary','settings');
  for(const panel of targets){
    await page.locator('#nav button[data-panel="'+panel+'"]').click();await mounted('primary',panel);
    await switchTo(child,panel);await page.reload();await mounted(child,panel);
    await switchTo('primary',panel);await page.reload();await mounted('primary',panel);
    checks.push(panel+' survives account round trip and full document reload');
  }
  await switchTo(child,'usage',{keyboard:true});await switchTo('primary','usage',{keyboard:true});
  await switchTo(child,'usage',{manager:true});await switchTo('primary','usage',{manager:true});
  checks.push('keyboard selection and manager View retain the same panel');

  await page.locator('#nav button[data-panel=chats]').click();await mounted('primary','chats');
  await frame.locator('[data-chat=group_10001]').click();await frame.locator('#detail h3').filter({hasText:'合成聊天'}).waitFor();
  assert.equal(await frame.locator('#list .selected').count(),1);
  await switchTo(child,'chats');await frame.locator('[data-chat=group_10001]').waitFor();
  assert.equal(await frame.locator('#list .selected').count(),0,'a matching chat ID in another account is not selected');
  await frame.getByText('选择会话查看消息',{exact:true}).waitFor();
  await switchTo('primary','chats');await frame.locator('[data-chat=group_10001]').waitFor();
  assert.equal(await frame.locator('#list .selected').count(),0,'account navigation carries no prior conversation selection');
  checks.push('only the page is carried; chat selection is never copied between account documents');

  await page.locator('#nav button[data-panel=memory]').click();await mounted('primary','memory');
  missingChildMemory=true;await switchTo(child,'sessions');
  assert.equal(await page.locator('#nav button[data-panel=memory]').count(),0);
  await page.reload();await mounted(child,'sessions');
  missingChildMemory=false;
  for(const query of ['panel=..%2Fsettings','panel=settings&panel=chats','panel=removed']){
    await page.goto(qa.base+'/?account='+child+'&'+query);await mounted(child,'sessions');
  }
  checks.push('missing, invalid and ambiguous panel requests use the normal startup page');

  await page.goto(qa.base+'/?account=primary&panel=settings');await mounted('primary','settings');
  await frame.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('温度');
  await frame.locator('.settings-search-result').getByText('温度',{exact:true}).click();
  rejectSave=true;await frame.locator('#field-api-temperature').fill('1.7');
  await frame.locator('.settings-save-toast[data-state=error]').waitFor({state:'visible'});
  const before=page.url(),diskTemperature=qa.disk().api.temperature;
  await group().locator('[data-account-id="'+child+'"]').click();
  await page.locator('#toast-region').getByText(/未切换/).waitFor({state:'visible'});
  assert.equal(page.url(),before,'failed settings flush must not replace the account document');
  await mounted('primary','settings');
  assert.equal(await frame.locator('#field-api-temperature').inputValue(),'1.7','failed switching preserves the editor draft');
  assert.notEqual(diskTemperature,1.7);assert.equal(qa.disk().api.temperature,diskTemperature);assert.ok(rejectedSaves>=2);
  rejectSave=false;await frame.getByRole('button',{name:'重试保存',exact:true}).click();
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
  assert.equal(qa.disk().api.temperature,1.7);await switchTo(child,'settings');
  checks.push('failed automatic save blocks switching, preserves the editor and allows a successful retry');

  assert.ok(requests.includes(prefix+'/api/config'),'the child reads its own scoped configuration URL');
  assert.ok(requests.includes(prefix+'/api/panels'),'the child obtains its own panel catalog');
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  assert.equal(qa.writes.filter(write=>/\/chats\//.test(write.path)).length,0);
  await page.screenshot({path:path.join(evidence,'child-settings.png'),fullPage:true});
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,observations,requests,rejectedSaves,errors:qa.errors,outbound:qa.outbound()},null,2));
  console.log('✓ account navigation browser: five panels including rules, both account directions, reload, scoped frames, keyboard and management entry, missing-panel fallback, isolated chat selection and failed-save protection');
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}finally{await qa.close();}
