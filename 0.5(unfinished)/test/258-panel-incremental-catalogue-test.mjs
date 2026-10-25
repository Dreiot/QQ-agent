// Real loader, authenticated HTTP/SSE and isolated built-in iframes. No live console.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evidence=process.env.QA258_EVIDENCE;if(evidence)fs.mkdirSync(evidence,{recursive:true});
const f=await modelUiFixture({config:{ui:{refreshMs:1000},proactive:{enabled:false}}}),checks=[],audits=[];
const until=async check=>{for(let i=0;i<300;i++){if(await check())return;await pause(25);}throw Error('258 did not settle');};
try{
  const entries=[];
  for(const kind of ['skill','plugin'])for(let i=0;i<10;i++){
    const root=i<2?'bundled':kind==='skill'?'skills':'plugins',id=`fixture258-${kind}-${i}`,dir=path.join(f.appRoot,root,id);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,kind==='skill'?'skill.json':'plugin.json'),JSON.stringify({id,kind,name:`合成${kind==='skill'?'技能':'插件'} ${i}`,version:'1.0.0',entry:'index.js',apiVersion:1,permissions:[],description:'只用于界面验证的本地空扩展。'}));
    fs.writeFileSync(path.join(dir,'index.js'),'export default {setup(){}};');entries.push({root,id,dir});
  }
  f.kernel.config.update({skills:Object.fromEntries(entries.map(item=>[item.id,{enabled:true}]))});
  for(const item of entries)await f.kernel.loader.loadDir(item.root,item.dir);
  for(const panel of ['skills','plugins']){
    const kind=panel==='skills'?'skill':'plugin',id=`fixture258-${kind}-2`;
    await f.page.locator(`#nav button[data-panel=${panel}]`).click();await f.frame.locator('#list > .list-item').first().waitFor();
    const defaults=f.frame.locator('.default-capabilities'),card=f.frame.locator(`[data-extension-id="${id}"]`);
    assert.equal(await defaults.evaluate(n=>n.open),false);assert.match(await defaults.locator(':scope > summary').innerText(),/默认能力 · 2 项/);
    assert.equal(await defaults.locator('.list-item').count(),2);assert.equal(await f.frame.locator('#list > .list-item').count(),8);
    const header=await f.frame.locator('.head').evaluate(n=>{const author=[...n.querySelectorAll('button')].find(b=>b.textContent==='创作扩展'),install=n.querySelector('#install');return{adjacent:author.nextElementSibling===install,sameLine:Math.abs(author.getBoundingClientRect().top-install.getBoundingClientRect().top)<2,height:n.getBoundingClientRect().height};});assert.equal(header.adjacent,true);assert.equal(header.sameLine,true);assert.ok(header.height<60);
    await defaults.locator(':scope > summary').click();await defaults.locator('.list-item').first().waitFor();
    const location=card.locator('details[data-extension-path]');await location.locator('summary').click();
    await card.evaluate(n=>{window.__catalogueCard258=n;window.__catalogueButton258=[...n.querySelectorAll('button')].find(b=>b.textContent==='停用');window.__catalogueOrder258=[...document.querySelectorAll('#list .list-item')].map(row=>row.dataset.extensionId);});
    await card.getByRole('button',{name:'停用',exact:true}).click();await card.getByRole('button',{name:'启用',exact:true}).waitFor();
    assert.equal(await card.evaluate(n=>n===window.__catalogueCard258&&[...n.querySelectorAll('button')].find(b=>b.textContent==='启用')===window.__catalogueButton258),true);
    assert.deepEqual(await f.frame.locator('#list .list-item').evaluateAll(nodes=>nodes.map(n=>n.dataset.extensionId)),await card.evaluate(()=>window.__catalogueOrder258));
    assert.equal(await location.evaluate(n=>n.open),true);assert.equal(await defaults.evaluate(n=>n.open),true);
    await card.getByRole('button',{name:'启用',exact:true}).click();const confirmation=f.frame.locator('dialog.confirm-panel');await confirmation.waitFor();assert.match(await confirmation.innerText(),/在你的电脑上运行/);assert.doesNotMatch(await confirmation.innerText(),/Node|沙箱/);await confirmation.getByRole('button',{name:'确认',exact:true}).click();await card.getByRole('button',{name:'停用',exact:true}).waitFor();
    await card.getByRole('button',{name:'宿主授权',exact:true}).click();const authorization=f.frame.locator('dialog').filter({hasText:'当前代码版本标识'});await authorization.waitFor();assert.match(await authorization.innerText(),/不能限制它的全部行为/);assert.doesNotMatch(await authorization.innerText(),/Node|沙箱/);await authorization.getByRole('button',{name:'关闭',exact:true}).click();
    await card.getByRole('button',{name:'重新加载',exact:true}).click();await until(async()=>await card.getByRole('button',{name:'重新加载',exact:true}).isEnabled());assert.equal(await card.evaluate(n=>n===window.__catalogueCard258),true);
    const order=await f.frame.locator('#list .list-item').evaluateAll(nodes=>nodes.map(n=>n.dataset.extensionId));assert.deepEqual(order,await card.evaluate(()=>window.__catalogueOrder258));
    await f.frame.locator('#search').fill('no-match-258');await f.frame.locator('#list > .empty').waitFor();await f.frame.locator('#search').fill('');await card.waitFor();assert.equal(await location.evaluate(n=>n.open),true);assert.equal(await defaults.evaluate(n=>n.open),true);
    await defaults.locator(':scope > summary').click();await card.scrollIntoViewIfNeeded();await pause(350);
    const top=await card.evaluate(n=>n.getBoundingClientRect().top);f.kernel.bus.emit('status',{configUpdated:true});await pause(1300);assert.ok(Math.abs(await card.evaluate(n=>n.getBoundingClientRect().top)-top)<2);
    const fail=route=>route.fulfill({status:503,json:{error:'合成读取失败'}});await f.page.route('**/api/skills',fail);f.kernel.bus.emit('status',{configUpdated:true});await f.frame.locator('.catalogue-feedback').filter({hasText:'已保留当前内容'}).waitFor();assert.equal(await card.evaluate(n=>n===window.__catalogueCard258),true);assert.equal(await location.evaluate(n=>n.open),true);await f.page.unroute('**/api/skills',fail);f.kernel.bus.emit('status',{configUpdated:true});await f.frame.locator('.catalogue-feedback').waitFor({state:'hidden'});
    if(evidence)await f.page.screenshot({path:path.join(evidence,`${panel}.png`),fullPage:true});
    checks.push(`${panel}: real enable/disable/hot-reload retains card/buttons/order/path/scroll; default group and compact authoring controls; plain-language permissions`);
  }
  // Every default panel stays mounted and retains its reading blocks under both
  // repeated authenticated status notifications and the normal recovery cycle.
  for(const id of ['sessions','chats','memory','usage','skills','plugins','logs','settings','community']){
    await f.page.locator(`#nav button[data-panel=${id}]`).click();await f.frame.locator(`body[data-panel=${id}]`).waitFor();await pause(650);
    await f.frame.locator('body').evaluate(n=>{window.__panelRoot258=n;window.__blocks258=[...n.querySelectorAll('.card,.list-item,.metric,.usage-table,.settings-section,.capability-provider-row,main > .head')];window.__replayed258=[];window.__observe258=new MutationObserver(()=>{for(const a of document.getAnimations()){if(a.playState==='running'&&a.effect.getKeyframes().some(frame=>frame.opacity==='0'||frame.opacity===0)&&!window.__replayed258.includes(a))window.__replayed258.push(a);}});window.__observe258.observe(n,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});});
    for(let i=0;i<3;i++){f.kernel.bus.emit('status',{fixture258:i});await pause(200);}await pause(1000);
    const audit=await f.frame.locator('body').evaluate(n=>{window.__observe258.disconnect();return{panel:n.dataset.panel,root:n===window.__panelRoot258,retained:window.__blocks258.every(node=>node.isConnected),replayed:window.__replayed258.length,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
    assert.equal(audit.root,true,id);assert.equal(audit.retained,true,id);assert.equal(audit.replayed,0,id);assert.ok(audit.overflow<=1,id);audits.push(audit);
    if(id==='usage'){const compact=await f.frame.locator('.usage-head').evaluate(n=>{const title=n.querySelector('h2').getBoundingClientRect(),range=n.querySelector('#status').getBoundingClientRect();return{sameLine:Math.abs(title.top+title.height/2-(range.top+range.height/2))<5,height:n.getBoundingClientRect().height};});assert.equal(compact.sameLine,true);assert.ok(compact.height<60);if(evidence)await f.page.screenshot({path:path.join(evidence,'usage.png'),fullPage:true});}
  }
  checks.push('all nine default pages retain reading blocks without background entrances or horizontal overflow');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('✓ 258 '+checks.join('\n✓ 258 '));
  if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,headed:process.env.QA_HEADED==='1',checks,audits,externalRequests:f.outbound(),liveConsoleAccessed:false},null,2)+'\n');
}catch(error){if(evidence)await f.page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}
finally{await f.close();}
