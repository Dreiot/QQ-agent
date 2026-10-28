import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';

const calls=[];
let reject=false;
const transport={id:'rule-feedback-fixture',selfId:'111',start(){},stop(){},status:()=>({connected:true}),actions:{
  listGroups:async()=>[{id:'12345',name:'Local fixture'}],listFriends:async()=>[],
  getModerationMember:async(_group,user)=>({userId:user,role:user==='111'?'admin':'member'}),
  moderateGroup:async(_group,operation,options)=>{options.current();if(reject)throw Error('synthetic permission failure');calls.push(operation);},
}};
const rule={id:'feedback-rule',name:'反馈测试',enabled:true,groups:['12345'],cooldownSeconds:30,nodes:[
  {id:'start',type:'message',config:{},next:'match'},
  {id:'match',type:'text_match',config:{match:'equals',text:'#sl'},next:'mute',otherwise:'$end'},
  {id:'mute',type:'mute',config:{seconds:60},next:'$end'},
]};
const f=await modelUiFixture({transport,config:{management:{rules:[rule]}}}),{page,frame,kernel}=f;
const until=async fn=>{const end=Date.now()+6000;while(!await fn()){if(Date.now()>end)throw Error('Feedback timeout');await new Promise(resolve=>setTimeout(resolve,20));}};
let mid=0;
const fire=async(text,user='222')=>{kernel.management.handleEvent({kind:'group',id:'12345',type:'message',event:{user_id:user,message_id:++mid,message:[{type:'text',data:{text}}]}});await until(()=>!kernel.management.snapshot().active);};
try{
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();
  assert.equal(await frame.getByLabel('同一用户执行冷却（秒）',{exact:true}).getAttribute('title'),'成功执行操作后开始计时；未匹配的消息不占用冷却');
  await frame.locator('.management-logs > summary').click();
  await fire('ordinary');await until(()=>frame.locator('.management-logs > div > details > summary').filter({hasText:'未执行操作'}).count());
  await fire('#sl');await until(()=>frame.locator('.management-logs > div > details > summary').filter({hasText:'已执行'}).count());assert.equal(calls.length,1);
  reject=true;await fire('#sl','333');await until(()=>frame.locator('.management-logs > div > details > summary').filter({hasText:'执行失败'}).count());
  await frame.locator('.management-logs > div > details > summary').filter({hasText:'执行失败'}).click();
  await until(()=>frame.locator('.management-logs').textContent().then(text=>text.includes('synthetic permission failure')));
  const summary=await f.request('GET','/api/management/runs');assert.ok(summary.data.runs.every(run=>Number.isInteger(run.effectCount)));assert.equal(summary.data.runs[0].effectCount,0);
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('PASS rule feedback: unmatched, executed and failed rows; detailed failure; clarified cooldown; API counts without action payloads');
}finally{await f.close();}
