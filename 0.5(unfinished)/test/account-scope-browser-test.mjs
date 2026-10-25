import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',prefix='/accounts/'+id,qa=await modelUiFixture(),{page,frame}=qa,observed=[];
const evidence=path.resolve('.qa-local/account-scope-browser-20261025');fs.mkdirSync(evidence,{recursive:true});
try{
  // The fixture has one inert kernel. Only the UI routing contract is exercised
  // here: serve its files/data behind a synthetic account prefix without any
  // worker process, real QQ session or external network access.
  await page.route('**/api/accounts',route=>route.fulfill({json:{accounts:[{id:'primary',nickname:'主账号',status:'running',connected:true,paused:false},{id,accountId:'123456',nickname:'独立 QQ',provider:'snowluma',status:'running',connected:true,paused:true}]}}));
  await page.route('**/api/accounts/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'event: accounts\ndata: {}\n\n'}));
  await page.route('**'+prefix+'/**',route=>{const url=new URL(route.request().url());assert.ok(url.pathname.startsWith(prefix+'/'));observed.push(url.pathname);url.pathname=url.pathname.slice(prefix.length);return route.continue({url:url.href});});
  await page.goto(qa.base+'/?account='+id);await page.locator('#nav button[data-panel=settings]').click();await frame.locator('#settings-sidebar').waitFor({state:'visible'});
  const iframe=await page.locator('#panel-host iframe').getAttribute('src');assert.ok(iframe.startsWith(prefix+'/panels/settings/'),iframe);assert.ok(observed.includes(prefix+'/api/panels'));assert.ok(observed.includes(prefix+'/api/config'));assert.ok(observed.includes(prefix+'/api/events'));
  for(const name of ['server-port','server-autoStart','server-closeToTray'])assert.equal(await frame.locator('#field-'+name).isDisabled(),true,name+' belongs to the primary desktop');
  assert.equal(await frame.getByText('控制台端口、开机启动和窗口行为由主账号统一管理。',{exact:true}).count(),1);
  const backgrounds=await frame.locator('body').evaluate(async(_,prefix)=>{const {safeBgUrl}=await import('/panels/theme.js');return{own:safeBgUrl('/ui/backgrounds/shared.png'),same:safeBgUrl(prefix+'/ui/backgrounds/shared.png'),other:safeBgUrl('/accounts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/ui/backgrounds/shared.png')};},prefix);assert.deepEqual(backgrounds,{own:prefix+'/ui/backgrounds/shared.png',same:prefix+'/ui/backgrounds/shared.png',other:''});
  const accounts=page.getByRole('radiogroup',{name:'切换 QQ 账号'});await accounts.waitFor({state:'visible'});assert.equal(await accounts.locator('[role=radio][aria-checked=true]').getAttribute('data-account-id'),id);await page.waitForFunction(()=>document.querySelector('#pause-btn')?.textContent.includes('当前账号'));assert.match(await page.locator('#pause-btn').textContent(),/当前账号/);
  await settingsSection(frame,'desktop');await page.screenshot({path:path.join(evidence,'worker-settings.png'),fullPage:true});assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({scope:id,iframe,observed,backgrounds,checks:['fixed scoped API and SSE','scoped iframe URL','shared desktop fields disabled','account-specific local backgrounds','cross-account background rejected','current-account pause label','global account selector'],errors:qa.errors},null,2));
  console.log('✓ account scope browser: account API/SSE/iframe routes, isolated background URLs, primary-only desktop fields and current-account controls');
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}finally{await qa.close();}
