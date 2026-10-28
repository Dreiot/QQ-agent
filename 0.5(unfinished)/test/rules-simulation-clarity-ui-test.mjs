import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';

const rule={id:'simulation-clarity',name:'模拟结果可读性',enabled:false,groups:['12345'],cooldownSeconds:0,nodes:[
  {id:'event',type:'message',config:{},next:'send'},
  {id:'send',type:'send_text',config:{text:'只在模拟中显示'},next:'mute'},
  {id:'mute',type:'mute',config:{seconds:60},next:'recall'},
  {id:'recall',type:'recall',config:{},next:'rename'},
  {id:'rename',type:'rename_group',config:{text:'模拟群名'},next:'$end'},
]};
const f=await modelUiFixture({config:{management:{rules:[rule]}}}),{page,frame}=f;
try{
  const before=structuredClone(f.disk().management);
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();
  await frame.getByRole('button',{name:'试运行',exact:true}).click();const dialog=frame.locator('dialog.management-dialog');
  assert.ok(await dialog.getByText('仅模拟，不发送消息、不处理真实成员。等待会快进；运行后可在画布查看经过的节点。',{exact:true}).isVisible());
  await dialog.getByText('时间、身份与连续消息样本',{exact:true}).click();
  assert.ok(await dialog.getByLabel('用户昵称',{exact:true}).isVisible());
  for(const label of ['概率样本（0–99）','预置计次数','预置状态（JSON，可选）','已入群多久（秒）','后续发言：每行「第几秒 QQ号 内容」','此前发言：秒数使用负数'])assert.equal(await dialog.getByLabel(label,{exact:true}).isVisible(),false,label+' is irrelevant to this rule');
  await dialog.getByLabel('触发消息',{exact:true}).fill('模拟输入');await dialog.getByRole('button',{name:'运行模拟',exact:true}).click();
  await dialog.locator('.management-result-summary').waitFor();
  assert.match(await dialog.locator('.management-result-summary').textContent(),/预计执行 4 次操作/);
  const previews=dialog.locator('.management-action-preview');assert.equal(await previews.count(),4);
  assert.match(await previews.nth(0).textContent(),/群 12345.*只在模拟中显示/);
  assert.match(await previews.nth(1).textContent(),/QQ 10002.*禁言 60 秒/);
  assert.match(await previews.nth(2).textContent(),/消息 .*撤回这条消息/);
  assert.match(await previews.nth(3).textContent(),/群 12345.*模拟群名/);
  assert.equal(await dialog.locator('.management-execution-trace').getAttribute('open'),null,'steps are available without dominating results');
  await dialog.getByLabel('模拟会话类型',{exact:true}).selectOption('private');
  for(const label of ['模拟机器人身份','模拟群成员 QQ（空格分隔）','触发用户身份','群名片'])assert.equal(await dialog.getByLabel(label,{exact:true}).isVisible(),false,'private chat hides '+label);
  await dialog.getByLabel('模拟会话类型',{exact:true}).selectOption('group');assert.ok(await dialog.getByLabel('模拟机器人身份',{exact:true}).isVisible());
  assert.deepEqual(f.disk().management,before,'simulation and sample visibility do not alter the saved rule');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('PASS simulation clarity: relevant samples, private field visibility, all four operation previews with correct targets, collapsed trace and no saved/live effects');
}finally{await f.close();}
