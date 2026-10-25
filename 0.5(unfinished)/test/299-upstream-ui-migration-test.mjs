// Verify the new protocol boundary and the unpushed local interface together.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {PERSONALIZATION_FIELDS} from '../ui/panels/theme.js';

const evidence=path.resolve('.qa-local/upstream-ui-migration');
fs.mkdirSync(evidence,{recursive:true});
const checks=[],removedRequests=[];
const check=label=>{checks.push(label);console.log(`✓ 299 ${label}`);};
const until=async(read,accept,label)=>{for(let i=0;i<140;i++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(label);};
const qa=await modelUiFixture({config:{onebot:{wsUrl:'ws://127.0.0.1:3001/events',httpUrl:'http://127.0.0.1:3000/actions',accessToken:'SYNTHETIC_OLD_WS',httpAccessToken:''}}});
const {page,frame}=qa;
page.on('request',request=>{if(/\/api\/(?:snowluma|qq-portable)(?:\/|$)/i.test(new URL(request.url()).pathname))removedRequests.push(new URL(request.url()).pathname);});
const settle=async()=>{
  await frame.locator('body').evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
  await page.locator('body').evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
};
try{
  assert.deepEqual(await page.locator('#nav button').evaluateAll(nodes=>nodes.map(node=>node.dataset.panel)),['sessions','chats','memory','usage','skills','plugins','logs','settings','community']);
  assert.deepEqual(await page.locator('[data-readiness]').evaluateAll(nodes=>nodes.map(node=>node.dataset.readiness)),['onebot','model']);
  for(const url of ['/api/snowluma/status','/api/qq-portable/status'])assert.equal((await qa.request('GET',url)).status,404,url+' is absent from the new backend');
  check('new navigation and removed process endpoints match the upstream boundary');

  await page.locator('#ready-onebot').click();
  await frame.locator('#section-onebot').waitFor({state:'visible'});
  for(const key of ['wsUrl','httpUrl'])assert.equal(await frame.locator(`#field-onebot-${key}`).isVisible(),true);
  for(const key of ['accessToken','httpAccessToken'])assert.equal(await frame.locator(`#secret-onebot-${key}`).isVisible(),true);
  assert.equal(await frame.locator('[data-path^="snowluma."]').count(),0);
  assert.equal(await frame.locator('#settings-sidebar a').count(),11);
  assert.equal(await frame.locator('#field-onebot-wsUrl').inputValue(),'ws://127.0.0.1:3001/events');
  check('readiness opens four directly reachable connection controls within the local eleven-section layout');

  await frame.locator('#field-onebot-wsUrl').fill('ws://127.0.0.1:3101/events');
  await frame.locator('#field-onebot-httpUrl').fill('http://127.0.0.1:3100/actions');
  await until(()=>qa.disk().onebot,value=>value.wsUrl==='ws://127.0.0.1:3101/events'&&value.httpUrl==='http://127.0.0.1:3100/actions','explicit endpoints did not save');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'visible'});
  await frame.locator('#secret-onebot-accessToken').fill('SYNTHETIC_NEW_WS');
  await until(()=>qa.disk().onebot.accessToken,value=>value==='SYNTHETIC_NEW_WS','protocol credential did not save');
  await until(()=>frame.locator('#secret-onebot-accessToken').inputValue(),value=>value==='','acknowledged secret input was not cleared');
  await frame.locator('#secret-onebot-httpAccessToken').fill('SYNTHETIC_NEW_HTTP');
  await until(()=>qa.disk().onebot.httpAccessToken,value=>value==='SYNTHETIC_NEW_HTTP','independent HTTP credential did not save');
  const publicConfig=(await qa.request('GET','/api/config')).data;
  assert.ok(!JSON.stringify(publicConfig).includes('SYNTHETIC_NEW_'));
  assert.equal(qa.disk().snowluma,undefined);
  check('endpoints and independent credentials auto-save to the new keys without leaking credentials');

  let reject=true;
  await page.route('**/api/config/lifecycle',route=>reject?(reject=false,route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic migration write failure'})})):route.continue());
  await frame.locator('#field-onebot-wsUrl').fill('ws://127.0.0.1:3201/events');
  await frame.locator('.settings-save-toast[data-state=error]').waitFor({state:'visible'});
  assert.equal(qa.disk().onebot.wsUrl,'ws://127.0.0.1:3101/events');
  assert.equal(await frame.locator('#field-onebot-wsUrl').inputValue(),'ws://127.0.0.1:3201/events');
  await frame.getByRole('button',{name:'重试保存',exact:true}).click();
  await until(()=>qa.disk().onebot.wsUrl,value=>value==='ws://127.0.0.1:3201/events','retained endpoint did not retry');
  await page.unroute('**/api/config/lifecycle');
  check('a failed connection edit retains input and retries the same value');

  for(const width of [1360,560,400]){
    await page.setViewportSize({width,height:900});await settle();
    assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`connection page overflow at ${width}`);
    for(const key of ['wsUrl','httpUrl'])assert.equal(await frame.locator(`#field-onebot-${key}`).isVisible(),true);
    await page.screenshot({path:path.join(evidence,`connection-${width}.png`)});
  }
  check('connection controls remain reachable without horizontal overflow at desktop and phone widths');

  await page.setViewportSize({width:1360,height:900});
  await settingsSection(frame,'appearance');
  assert.equal(await frame.locator('.personalization-field').count(),PERSONALIZATION_FIELDS.length);
  for(const key of ['rippleEnabled','rippleColor','rippleSpread','rippleSpeed'])assert.ok(PERSONALIZATION_FIELDS.some(field=>field.key===key));
  await page.locator('#nav button[data-panel=logs]').click();
  await frame.locator('#app-log').waitFor({state:'visible'});
  await frame.locator('#reload svg').waitFor({state:'attached'});
  assert.equal(await frame.locator('#reload svg').count(),1);
  const prior=(await qa.request('GET','/api/logs')).data.level;
  await frame.locator('#log-level').selectOption(prior==='warn'?'info':'warn');
  await until(async()=>(await qa.request('GET','/api/logs')).data.level,value=>value!==prior,'application log level was not applied');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'visible'});
  for(const width of [1360,560,400]){
    await page.setViewportSize({width,height:900});await settle();
    assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`log page overflow at ${width}`);
    await page.screenshot({path:path.join(evidence,`logs-${width}.png`)});
  }
  check('all personalization fields survive and the new log page uses shared icons, save feedback and responsive layout');

  assert.deepEqual(removedRequests,[]);
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  check('no removed integration requests, browser errors or external service traffic');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,browserErrors:qa.errors,removedRequests,externalTraffic:qa.outbound()},null,2));
}finally{await qa.close();}
