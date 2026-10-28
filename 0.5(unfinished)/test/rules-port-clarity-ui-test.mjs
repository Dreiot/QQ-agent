import assert from 'node:assert/strict';
import fs from 'node:fs';
import {modelUiFixture} from './model-ui-fixture.mjs';

const rule={id:'clarity',name:'字段说明',enabled:false,groups:['12345'],cooldownSeconds:30,nodes:[
  {id:'event',type:'message',config:{},next:'person'},
  {id:'person',type:'target_sender',config:{},bindings:{user_id:{nodeId:'event',port:'user_id'}},next:'mute'},
  {id:'mute',type:'mute',config:{seconds:60},next:'$end'},
]};
const f=await modelUiFixture({config:{management:{rules:[rule]}}}),{frame,page}=f;
const until=async(fn,label)=>{const end=Date.now()+10000;while(!await fn()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
const explain=async row=>{const section=row.locator('..');if(await section.getAttribute('open')===null)await section.locator(':scope>summary').click();const details=row.locator('.management-value-explanation');if(await details.getAttribute('open')===null)await details.locator(':scope>summary').click();};
try{
  const before=structuredClone(f.disk().management.rules);
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-node').first().waitFor();await frame.getByRole('button',{name:'总览',exact:true}).click();
  await frame.locator('[data-value-node=event][data-value-output=user_id]').click();assert.equal(await frame.locator('.management-inspector').count(),0,'a socket begins a wire without selecting its card');await frame.locator('.management-flow-viewport').press('Escape');
  await frame.locator('[data-node-id=event] .management-node-caption').click();const inspector=frame.locator('.management-inspector');
  const output=key=>inspector.locator(`[data-output-key="${key}"]`);
  for(const key of ['chat_type','chat_id','message','text'])await explain(output(key));
  assert.match(await output('chat_type').textContent(),/group（群聊）.*private（私聊）/);assert.match(await output('chat_id').textContent(),/群聊时是群号，私聊时是对方/);
  assert.match(await output('message').textContent(),/文字、图片、语音、@、回复/);assert.match(await output('text').textContent(),/只拼接文字段/);
  assert.match(await frame.locator('[data-value-node=event][data-value-output=text]').getAttribute('title'),/只拼接文字段/);
  await frame.getByRole('button',{name:'收起节点设置',exact:true}).click();await frame.locator('[data-node-id=person] .management-value-row').first().locator('span').first().click();
  assert.match(await inspector.locator('[data-input-key=user_id] .management-value-binding').textContent(),/收到消息 \/ 发送者 QQ/);
  assert.equal(await inspector.locator('select[aria-label^="数据来源"]').count(),0);assert.equal(await inspector.locator('.management-value-source').count(),0);
  assert.equal(await inspector.getByRole('button',{name:/查看来源|跳转/}).count(),0);assert.ok(await inspector.getByRole('button',{name:'断开连线 选择哪个 QQ',exact:true}).isVisible());
  await frame.getByRole('button',{name:'收起节点设置',exact:true}).click();await frame.locator('[data-node-id=mute] .management-node-caption').click();
  const autoUser=inspector.locator('[data-input-key=user_id]'),originalSource=await autoUser.locator('.management-source-text').textContent();assert.match(originalSource,/02 触发用户 \/ 选出的成员/);assert.equal(await autoUser.locator('input:not([type=checkbox]):visible,textarea:visible,select:visible').count(),0,'automatic parameters do not show an empty manual editor');await explain(autoUser);assert.match(await autoUser.textContent(),/仅处理此 QQ/);assert.match(await autoUser.textContent(),/只影响这一次操作，后续仍沿用原名单/);
  const resultSection=inspector.locator('.management-value-section').filter({has:frame.locator('summary',{hasText:/^结果 · 可传给下一步/})}),successInfo=output('success').locator('.management-value-explanation');assert.equal(await resultSection.getAttribute('open'),null,'results are collapsed while editing an operation');const search=inspector.getByRole('searchbox',{name:'查找节点字段',exact:true});await search.fill('success');assert.ok(await resultSection.getAttribute('open')!==null);assert.ok(await successInfo.getAttribute('open')!==null);assert.equal(await inspector.locator('.management-value-field:visible').count(),1);await search.fill('');assert.equal(await resultSection.getAttribute('open'),null,'clearing search restores the result group');assert.equal(await successInfo.getAttribute('open'),null,'clearing search restores the result explanation');
  await resultSection.locator(':scope>summary').click();await explain(output('count'));await explain(output('targets'));assert.match(await output('count').textContent(),/名单中有多少人，包含可能被权限保护而跳过的人/);assert.match(await output('targets').textContent(),/不是成功处理记录/);
  assert.ok(await frame.getByLabel('禁言时长（秒）',{exact:true}).isVisible(),'real parameter inputs remain available');assert.deepEqual(f.disk().management.rules,before,'opening explanations, folding groups and searching must not change the graph');
  await autoUser.getByRole('button',{name:'改用固定值',exact:true}).click();const fixed=autoUser.getByLabel('参数 仅处理此 QQ',{exact:true});assert.ok(await fixed.isVisible());await fixed.fill('10009');await fixed.press('Tab');await until(()=>f.disk().management.rules[0].nodes[2].values?.user_id==='10009','fixed QQ persisted');assert.equal(await autoUser.locator('.management-source-kind').textContent(),'固定值');assert.equal(await autoUser.getByLabel('参数 仅处理此 QQ',{exact:true}).inputValue(),'10009');
  await autoUser.getByRole('button',{name:'恢复自动来源',exact:true}).click();await until(()=>!Object.hasOwn(f.disk().management.rules[0].nodes[2].values??{},'user_id'),'automatic source restored and persisted');assert.equal(await autoUser.locator('.management-source-text').textContent(),originalSource);assert.equal(await autoUser.locator('input:not([type=checkbox]):visible,textarea:visible,select:visible').count(),0,'restoring automatic source hides the fixed editor');assert.equal(f.disk().management.rules[0].nodes[2].config.seconds,60,'editing the QQ source preserves the duration');assert.deepEqual(f.disk().management.rules[0].nodes[1].bindings,before[0].nodes[1].bindings,'editing an automatic field preserves other data wires');
  fs.mkdirSync('.qa-local/rules-clarity-20261027',{recursive:true});await page.screenshot({path:'.qa-local/rules-clarity-20261027/clarity-wide.png'});
  await page.setViewportSize({width:800,height:1000});assert.ok(await frame.locator('body').evaluate(body=>body.scrollWidth<=body.clientWidth+1));assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('PASS rules clarity: body selection, socket separation, precise descriptions, source provenance, compact automatic fields, fixed override/save/reset, search fold restoration and read-only graph preservation');
}finally{await f.close();}
