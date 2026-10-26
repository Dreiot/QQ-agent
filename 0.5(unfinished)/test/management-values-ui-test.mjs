import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const evidence=path.resolve('.qa-local/management-values');fs.mkdirSync(evidence,{recursive:true});
const rule={id:'typed-ui',name:'字段连线验证',enabled:false,groups:[],cooldownSeconds:0,nodes:[
  {id:'event',type:'message',config:{},next:'send'},
  {id:'send',type:'send_text',config:{text:'备用消息'},next:'mute'},
  {id:'mute',type:'mute',config:{seconds:60},next:'$end'},
  {id:'seconds',type:'value_number',config:{value:45}},
  {id:'welcome',type:'text_join',config:{a:'欢迎 ',b:'朋友'}},
]};
const f=await modelUiFixture({config:{management:{version:1,rules:[rule]},ui:{uikit:{mode:'dark',dark:{controlHeight:56,buttonPaddingY:18}}}}}),{page,frame}=f;
const until=async(fn,label)=>{const end=Date.now()+10000;while(!await fn()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
const state=()=>f.disk().management.rules[0],center=async n=>{const b=await n.boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2};};
const drag=async(a,b)=>{const from=await center(a),to=await center(b);await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:14});await page.mouse.up();};
const output=(node,key)=>frame.locator(`[data-value-node="${node}"][data-value-output="${key}"]`),input=(node,key)=>frame.locator(`[data-value-node="${node}"][data-value-input="${key}"]`);
try{
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();await frame.getByRole('button',{name:'专注编辑',exact:true}).click();await frame.getByRole('button',{name:'总览',exact:true}).click();
  await drag(output('event','sender.nickname'),input('welcome','b'));await until(()=>state().nodes[4].bindings?.b?.port==='sender.nickname','real data drag saved');
  await output('seconds','value').click();await input('mute','duration').click();await until(()=>state().nodes[2].bindings?.duration?.nodeId==='seconds','click data binding saved');
  await output('event','user_id').click();await input('mute','user_id').click();await until(()=>state().nodes[2].bindings?.user_id?.port==='user_id','typed QQ binding saved');
  await output('welcome','text').click();await input('send','text').click();await until(()=>state().nodes[1].bindings?.text?.nodeId==='welcome','computed text binding saved');
  assert.equal(await frame.locator('path.management-data-edge').count(),4);
  // Data and execution cables cannot be mixed. Invalid drags preserve the old input.
  await output('event','text').click();await input('mute','duration').click();assert.equal(state().nodes[2].bindings.duration.nodeId,'seconds');assert.match(await frame.locator('.management-canvas-live').textContent(),/类型不兼容/);await frame.locator('.management-flow-viewport').press('Escape');
  await frame.getByLabel('编辑节点 1 收到消息',{exact:true}).click();const inspector=frame.locator('.management-inspector');
  assert.ok(await inspector.getByText('sender.nickname · 可能缺失',{exact:true}).isVisible());assert.ok(await inspector.getByText('time · 可能缺失',{exact:true}).isVisible());
  await inspector.getByRole('searchbox',{name:'查找节点字段',exact:true}).fill('昵称');assert.equal(await inspector.locator('.management-value-field:visible').count(),1);await inspector.getByRole('searchbox',{name:'查找节点字段',exact:true}).fill('');
  await inspector.getByLabel('在画布显示输出 群名片',{exact:true}).check();await until(()=>state().layout?.visiblePorts?.event?.outputs?.includes('sender.card'),'show extra output saved');assert.equal(await output('event','sender.card').count(),1);
  await inspector.getByLabel('在画布显示输出 发送者昵称',{exact:true}).isEnabled().then(value=>assert.equal(value,false,'connected fields stay visible'));
  await frame.getByRole('button',{name:'收起节点设置',exact:true}).click();await frame.getByLabel('编辑节点 3 执行禁言',{exact:true}).click();assert.equal(await frame.getByLabel('禁言时长（秒）',{exact:true}).isEnabled(),false,'bound parameter cannot silently override the wire');
  const size=await input('mute','duration').evaluate(n=>({width:n.offsetWidth,height:n.offsetHeight}));assert.deepEqual(size,{width:22,height:22});
  // Source selector is an alternative to dragging and permits fan-out of a value.
  await frame.getByLabel('编辑节点 2 发送群消息',{exact:true}).click();await frame.getByLabel('数据来源 消息内容',{exact:true}).selectOption({label:'1. 收到消息 · 发送者昵称'});await until(()=>state().nodes[1].bindings.text.port==='sender.nickname','source picker saved');assert.equal(state().nodes[4].bindings.b.port,'sender.nickname');
  await frame.getByLabel('数据来源 消息内容',{exact:true}).selectOption({label:'5. 拼接文字 · 拼接结果'});await until(()=>state().nodes[1].bindings.text.port==='text','restore computed source');
  await frame.getByRole('button',{name:'试运行',exact:true}).click();const dialog=frame.locator('dialog.management-dialog');await dialog.getByText('时间、身份与连续消息样本',{exact:true}).click();await dialog.getByLabel('用户昵称',{exact:true}).fill('小鱼');await dialog.getByRole('button',{name:'运行模拟',exact:true}).click();await until(async()=>await dialog.locator('.management-simulation-result').textContent().then(t=>t.includes('预计执行 2 次')),'computed simulation completes');await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.match(await frame.locator('.management-inspector output').first().textContent(),/true/);
  await frame.getByLabel('编辑节点 5 拼接文字',{exact:true}).click();assert.equal(await frame.locator('.management-inspector [data-output-key=text] output').textContent(),'欢迎 小鱼');assert.equal(await frame.locator('[data-input-node=welcome]').count(),0,'pure computation has no execution socket');
  await page.screenshot({path:path.join(evidence,'typed-inspector.png')});
  await frame.getByRole('button',{name:'收起节点设置',exact:true}).click();const binding=structuredClone(state().nodes[2].bindings.duration);await frame.locator('path.management-data-edge').filter({hasNotText:'not-a-value'}).count().then(n=>assert.equal(n,4));const edge=frame.locator('path[data-data-edge="data:seconds:value:mute:duration"]');await edge.press('Delete');await until(()=>!state().nodes[2].bindings.duration,'delete one data wire');assert.equal(state().nodes[2].bindings.user_id.port,'user_id');await frame.getByRole('button',{name:'撤销规则编辑',exact:true}).click();await until(()=>state().nodes[2].bindings?.duration?.nodeId===binding.nodeId,'undo data wire');
  const visible=await edge.evaluate(n=>{for(let ratio=.05;ratio<.95;ratio+=.05){const p=n.getPointAtLength(n.getTotalLength()*ratio).matrixTransform(n.getScreenCTM());if(n.ownerDocument.elementFromPoint(p.x,p.y)===n)return {x:p.x,y:p.y};}throw Error('no exposed cable segment');}),frameBox=await page.locator('#panel-host iframe').boundingBox();await page.mouse.click(visible.x+frameBox.x,visible.y+frameBox.y,{clickCount:2});await until(()=>!state().nodes[2].bindings.duration,'double click disconnect');await frame.getByRole('button',{name:'撤销规则编辑',exact:true}).click();await until(()=>state().nodes[2].bindings?.duration?.nodeId==='seconds','restore double-clicked cable');
  await page.reload();await page.locator('#nav button[data-panel=settings]').click();await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();assert.equal(state().nodes[2].bindings.duration.nodeId,'seconds');await frame.getByLabel('编辑节点 1 收到消息',{exact:true}).click();assert.equal(await frame.getByLabel('在画布显示输出 群名片',{exact:true}).isChecked(),true);
  await page.setViewportSize({width:800,height:1000});assert.ok(await frame.locator('body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await page.screenshot({path:path.join(evidence,'typed-narrow.png')});assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('PASS typed data ports: pointer drag, click binding, fan-out, type rejection, field visibility, inspector source picker, real simulation, values preview, delete/undo, persistence, narrow layout');
}finally{await f.close();}
