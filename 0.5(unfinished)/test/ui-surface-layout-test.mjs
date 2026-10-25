// Real bundled surfaces with disposable data; no QQ, model or community writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const f=await modelUiFixture({config:{allow:{groups:['10001','10002']},personaUnified:false}});
const {page,frame}=f;
async function panel(id){await page.locator(`#nav button[data-panel=${id}]`).click();await frame.locator(`body[data-panel=${id}]`).waitFor();}
async function close(dialog){await dialog.press('Escape');await dialog.waitFor({state:'detached'});}
async function contained(dialog){
  const m=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,width:innerWidth,overflow:el.scrollWidth-el.clientWidth};});
  assert.ok(m.x>=0&&m.right<=m.width+1,JSON.stringify(m));assert.ok(m.overflow<=1,JSON.stringify(m));
}
try{
  for(const key of ['group:10001','group:10002']){
    f.kernel.memory.append(key,{userId:'20001',name:'合成成员',content:'用于键盘导航检查。'});
    f.kernel.store.appendIncoming(key,{mid:Number(key.slice(6)),senderId:'20001',senderName:'合成成员',text:'界面检查',ts:Date.now()});
    const s=f.kernel.sessions.create(key,{trigger:key});f.kernel.sessions.finish(s.id,'done');
  }
  for(const id of ['sessions','chats','memory']){
    await panel(id);const open=frame.locator('#list .list-entry-open');await open.nth(1).waitFor();
    await open.nth(1).focus();await open.nth(1).press('Enter');await frame.locator('#list .selected .list-entry-open[aria-current=true]').waitFor();
    await open.first().focus();await open.first().press('Space');await frame.locator('#list .list-item').first().locator('.list-entry-open[aria-current=true]').waitFor();
    assert.equal(await frame.locator('#list [aria-current=true]').count(),1,'one current detail per list');
  }
  console.log('✓ Three reading lists have visible title buttons and working Enter/Space selection');
  await panel('settings');
  await settingsSection(frame,'access');await frame.getByRole('button',{name:/群聊 ·/}).click();const choices=frame.locator('dialog.settings-list-choice');
  for(const width of [1360,760,390]){await page.setViewportSize({width,height:720});const head=choices.locator('.dialog-standard-head'),title=await head.locator('h3').boundingBox(),dismiss=await head.locator('button').boundingBox();assert.ok(dismiss.x>=title.x+title.width+8,'close cannot overlay the flex-dialog title');await contained(choices);}
  await choices.getByRole('button',{name:'关闭弹窗',exact:true}).click();await choices.waitFor({state:'detached'});await page.setViewportSize({width:1360,height:900});
  await settingsSection(frame,'persona');const filter=frame.getByRole('searchbox',{name:'筛选会话人设'});await filter.waitFor();const writes=f.writes.length;await filter.fill('10002');
  assert.equal(await frame.locator('.persona-binding-row:visible').count(),2,'global persona stays pinned alongside the match');assert.equal(await frame.locator('[data-persona-binding="group:10001"]').isVisible(),false);await filter.fill('missing-persona');await frame.getByRole('status').filter({hasText:'没有匹配的会话'}).waitFor();await filter.fill('');assert.equal(f.writes.length,writes,'filtering never writes settings');
  for(const [section,name]of [['persona','人设管理'],['search','管理搜索源'],['models','渠道与模型库']]){
    await settingsSection(frame,section);await frame.getByRole('button',{name,exact:true}).click();const d=frame.locator('dialog[open]').last(),control=d.locator('.dialog-close-button');
    await control.waitFor();assert.equal(await control.locator('svg').count(),1);assert.ok((await control.getAttribute('aria-label')).startsWith('关闭'));
    await page.setViewportSize({width:390,height:720});await d.evaluate(async el=>{await Promise.allSettled(el.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));});await contained(d);
    const target=await control.boundingBox();assert.ok(target.width>=36&&target.height>=36,'close stays a usable square');
    await control.click();await d.waitFor({state:'detached'});await page.setViewportSize({width:1360,height:900});
  }
  console.log('✓ Persona, search and model managers retain an accessible icon close control in narrow windows');
  await settingsSection(frame,'models');await frame.getByRole('button',{name:'从目录选择主模型',exact:true}).click();const picker=frame.locator('dialog.model-picker');
  const size=await picker.locator('.model-selector-list > button').first().evaluate(el=>({item:el.getBoundingClientRect().width,list:el.parentElement.clientWidth}));assert.ok(size.item>=size.list-2,'model choices fill their track');await close(picker);
  // Reproduce a desktop preference before shrinking; it must not squeeze a phone
  // into the expanded desktop rail. Resizing does not write user preferences.
  const brand=page.locator('#brand-emblem');if(await page.locator('body').getAttribute('data-rail-collapsed')==='true')await brand.click();await brand.click();await brand.click();
  const before=await page.evaluate(()=>JSON.stringify(localStorage));await page.setViewportSize({width:390,height:720});await page.locator('body[data-rail-collapsed=true]').waitFor();assert.equal(await page.locator('body').getAttribute('data-rail-collapsed'),'true');
  const rail=await page.locator('.rail').boundingBox();assert.ok(rail.width<=80);assert.equal(await page.evaluate(()=>JSON.stringify(localStorage)),before);
  await page.setViewportSize({width:1360,height:900});await page.locator('body[data-rail-collapsed=false]').waitFor();assert.equal(await page.locator('body').getAttribute('data-rail-collapsed'),'false');
  console.log('✓ Model choices fill the available width; narrow navigation preserves the desktop preference');
  const dir=path.join(f.appRoot,'plugins','qa-layout');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify({id:'qa-layout',name:'界面检查',kind:'plugin',version:'1.0.0',apiVersion:1,entry:'index.js',enabledByDefault:false,configSchema:{enabled:{type:'boolean',title:'示例功能'}}}));fs.writeFileSync(path.join(dir,'index.js'),'export default {setup(){}};');await f.request('POST','/api/skills/reload',{});
  await panel('plugins');await frame.getByRole('button',{name:'设置',exact:true}).click();const editor=frame.locator('dialog.extension-settings'),toggle=editor.locator('.extension-setting-toggle');await toggle.click();assert.equal(await toggle.locator('input').isChecked(),true);await toggle.locator('input').press('Space');assert.equal(await toggle.locator('input').isChecked(),false);
  assert.equal(await editor.locator('form > .actions .primary').count(),1);await close(editor);
  await panel('community');await frame.getByRole('button',{name:'创作扩展',exact:true}).waitFor();assert.equal(await frame.locator('.head .actions button').count(),3);assert.equal(await frame.locator('.community-links button').count(),5);assert.equal(await frame.locator('#pane-publish #publish').count(),1);
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('✓ Extension cards work with pointer and keyboard; community actions have clear groups; no page errors or external traffic');
}finally{await f.close();}
