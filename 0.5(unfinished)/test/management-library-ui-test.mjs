import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const evidence=path.resolve('.qa-local/management-library');fs.mkdirSync(evidence,{recursive:true});
const f=await modelUiFixture({config:{ui:{uikit:{mode:'dark',dark:{controlHeight:56,buttonPaddingY:18,dialogWidth:560}}}}}),{page,frame}=f;
const until=async(fn,message)=>{const end=Date.now()+10000;while(!await fn()){if(Date.now()>end)throw Error(message);await new Promise(r=>setTimeout(r,25));}};
try{
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();await frame.getByRole('button',{name:'创建空白规则',exact:true}).click();await until(()=>f.disk().management.rules.length===1,'create draft');await frame.getByRole('button',{name:'添加独立节点',exact:true}).click();
  const library=frame.locator('#management-node-library'),search=library.getByRole('searchbox',{name:'搜索节点',exact:true}),detail=library.getByRole('region',{name:'节点详情',exact:true});
  await library.waitFor({state:'visible'});const bounds=await library.boundingBox();assert.ok(bounds.width>850,'node library must not inherit a small general dialog width');
  assert.match(await detail.textContent(),/输入/);assert.match(await detail.textContent(),/输出/);assert.match(await detail.textContent(),/例如/);
  for(const card of await library.locator('.management-node-option').all()){const fit=await card.evaluate(n=>{const r=n.getBoundingClientRect(),small=n.querySelector('small').getBoundingClientRect();return r.height>=80&&small.bottom<=r.bottom+1;});assert.ok(fit,'card description must remain inside its card with custom 56px buttons');}
  await search.fill('并行分发');await library.getByRole('button',{name:'并行分发',exact:true}).click();assert.equal(f.disk().management.rules[0].nodes.length,1,'selecting a node only previews it');assert.match(await detail.textContent(),/独立选择用户/);assert.match(await detail.textContent(),/8 条连接/);await page.screenshot({path:path.join(evidence,'library-wide.png')});
  await page.setViewportSize({width:800,height:1000});await page.screenshot({path:path.join(evidence,'library-narrow.png')});assert.ok(await library.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=n.ownerDocument.documentElement.clientWidth+1;}),'library must fit narrow iframe');assert.ok(await frame.locator('body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await library.getByRole('button',{name:'添加到画布',exact:true}).click();await until(()=>f.disk().management.rules[0].nodes.length===2,'confirm node addition');assert.equal(f.disk().management.rules[0].nodes[1].type,'fork');assert.ok(await frame.getByText('执行输入',{exact:true}).count());assert.ok(await frame.getByText('执行输出',{exact:true}).count());
  await frame.getByRole('button',{name:'更换节点',exact:true}).click();await search.fill('增加计次');await library.getByRole('button',{name:'增加计次',exact:true}).click();assert.match(await detail.textContent(),/可设置/);assert.match(await detail.textContent(),/默认/);await library.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(f.disk().management.rules[0].nodes[1].type,'fork','closing preview must preserve the original node');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);console.log('PASS node library: readable cards under custom button sizing, classification/search, full I/O/example/parameter details, explicit confirmation, cancel and narrow layout');
}finally{await f.close();}
