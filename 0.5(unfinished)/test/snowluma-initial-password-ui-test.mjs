import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {createLocalProtocols} from '../src/protocols/manager.js';
import {filesFor,writeFiles,fakeChild} from './local-protocol-fixtures.mjs';

const password='e1f2031425364758',auth={mustChangePassword:true,passwordHash:'synthetic-only-hash',passwordSalt:'synthetic-only-salt',generatedAt:'synthetic-first-run'};
let manager,physical;
const qa=await modelUiFixture({components:{'runtime.localProtocols':args=>(manager=createLocalProtocols({...args,platform:'win32',arch:'x64',
  spawnImpl:(_executable,_args,options)=>{
    physical=options.cwd;fs.writeFileSync(path.join(physical,'config/webui.json'),JSON.stringify(auth));
    const child=fakeChild();queueMicrotask(()=>child.stdout.write('12:00 INFO [WebUI] initial credentials: user=admin password='+password+'\n'));return child;
  },terminateImpl:async child=>{child.kill('SIGTERM');}}))}});
const {page,frame}=qa,evidence=path.resolve('.qa-local/snowluma-initial-password-20261028');fs.mkdirSync(evidence,{recursive:true});
try{
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:qa.base});
  // Exercise the real browser clipboard in this disposable context, including
  // the host selection fallback used by older desktop browser versions.
  await page.evaluate(()=>{const clipboard=navigator.clipboard,write=clipboard.writeText.bind(clipboard);window.__qaCopyCount=0;window.__qaClipboardRead=clipboard.readText.bind(clipboard);window.__qaClipboardWrite=write;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{await write(value);window.__qaCopyCount++;}}});});
  await writeFiles(manager.root,filesFor('snowluma','SnowLuma/'));await manager.scan();await settingsSection(frame,'onebot');
  await frame.getByRole('button',{name:'添加 QQ',exact:true}).click();
  await frame.locator('dialog[data-protocol-choice=""]').getByRole('button',{name:/Snowluma/}).click();
  const dialog=frame.locator('dialog[data-protocol-login]'),copy=dialog.getByRole('button',{name:'复制初始密码',exact:true});
  await copy.waitFor({state:'visible'});
  assert.ok(await dialog.getByRole('button',{name:'打开 SnowLuma',exact:true}).isVisible());assert.ok(await dialog.getByRole('button',{name:'已完成，继续',exact:true}).isVisible());assert.equal(await dialog.getByLabel('协议端管理密码',{exact:true}).isVisible(),false,'first-run setup does not ask for the later management password');
  assert.equal(await page.evaluate(()=>window.__qaCopyCount),0,'no automatic clipboard write');
  assert.equal((await frame.locator('body').textContent()).includes(password),false);
  await copy.click();await dialog.getByText('已复制',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.__qaCopyCount),1);assert.equal(await page.evaluate(()=>window.__qaClipboardRead()),password);
  assert.ok(await page.getByText('初始密码已复制',{exact:true}).isVisible(),'a host toast confirms the copy');
  const capture=async name=>{await dialog.evaluate(async el=>{await Promise.allSettled(el.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});await page.screenshot({path:path.join(evidence,name),fullPage:true});};
  await capture('desktop.png');
  await page.setViewportSize({width:390,height:760});
  assert.ok(await copy.isVisible());assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await capture('narrow.png');
  const state=await qa.request('GET','/api/local-protocols/login?sessionId='+encodeURIComponent(qa.writes.find(item=>item.path.endsWith('/initial-password')).body.sessionId));
  assert.equal(state.data.hasInitialPassword,true);assert.equal(JSON.stringify(state.data).includes(password),false);
  const unauthenticated=await fetch(qa.base+'/api/local-protocols/login/initial-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:state.data.sessionId})});
  assert.equal(unauthenticated.status,401);
  await page.evaluate(async()=>{await window.__qaClipboardWrite('before-selection-fallback');navigator.clipboard.writeText=async()=>{throw Error('Fixture: clipboard API unavailable');};});
  await copy.click();await dialog.getByText('已复制',{exact:true}).waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.__qaClipboardRead()),password,'host selection fallback also copies the actual password');
  fs.writeFileSync(path.join(physical,'config/webui.json'),JSON.stringify({...auth,mustChangePassword:false}));
  await page.evaluate(()=>window.__qaClipboardWrite('after-password-rotation'));
  await copy.click();await dialog.locator('.protocol-login-initial').waitFor({state:'hidden'});
  await dialog.getByLabel('协议端管理密码',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.__qaClipboardRead()),'after-password-rotation','an expired initial password is not copied again');
  const rotated=await qa.request('POST','/api/local-protocols/login/initial-password',{sessionId:state.data.sessionId});assert.equal(rotated.status,409);
  await dialog.getByRole('button',{name:'关闭账号接入'}).click();
  const closed=await qa.request('POST','/api/local-protocols/login/initial-password',{sessionId:state.data.sessionId});assert.equal(closed.status,409);
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,checks:['production output extraction','real HTTP/login session and host RPC','host clipboard write and toast','no plaintext in frame state','narrow layout','unauthenticated request rejected','password rotation and dialog closure invalidate copy'],errors:qa.errors},null,2));
  console.log('PASS SnowLuma initial-password UI: production manager/API/RPC, actual browser clipboard and selection fallback, toast, narrow layout, no plaintext in frame state, expired/closed/unauthenticated copy rejected');
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}finally{try{await page.evaluate(()=>window.__qaClipboardWrite?.(''));}catch{}await qa.close();}
