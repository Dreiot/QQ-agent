import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApplication} from '../src/kernel/composition.js';
import {createGroupManagement} from '../src/management/runtime.js';
import {createOneBotProvider} from '../bundled/transport-onebot/provider.js';

// Exercise the provider -> kernel -> rule -> OneBot action path. The client
// never opens a socket, and every moderation request ends in this local stub.
test('OneBot messages reach a branching rule after an ordinary message without consuming cooldown',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-rule-onebot-')),appRoot=path.join(dir,'app'),calls=[];
  for(const name of ['bundled','plugins','skills'])fs.mkdirSync(path.join(appRoot,name),{recursive:true});
  let raw,clock=100000,kernel;
  class Client{
    constructor(options){this.options=options;raw=options.onEvent;this.selfId=111;this.connected=false;}
    configure(){}
    connect(){this.connected=true;this.options.onStatus({connected:true,selfId:'111',transportReady:true});}
    close(){this.connected=false;}
    async call(action,params){
      calls.push({action,params});
      if(action==='get_group_member_info')return {status:'ok',retcode:0,data:{user_id:params.user_id,role:params.user_id===111?'admin':'member'}};
      if(action==='get_msg')return {status:'ok',retcode:0,data:{message_type:'group',group_id:12345,sender:{user_id:222}}};
      if(action==='get_group_info')return {status:'ok',retcode:0,data:{group_id:12345,group_name:'Local fixture'}};
      if(action==='get_group_list'||action==='get_friend_list')return {status:'ok',retcode:0,data:[]};
      if(!['set_group_kick','delete_msg'].includes(action))throw Error('Unexpected OneBot operation: '+action);
      return {status:'ok',retcode:0};
    }
  }
  const provider=createOneBotProvider({cfg:()=>({onebot:{}}),clientFactory:Client,log:{info(){},warn(){},error(){}}});
  const rule={id:'cooldown-regression',name:'Branching keyword rule',enabled:true,groups:['12345'],cooldownSeconds:30,nodes:[
    {id:'start',type:'message',config:{},next:['sl','status']},
    {id:'sl',type:'text_match',config:{match:'equals',text:'#sl'},bindings:{content:{nodeId:'start',port:'text'}},next:'target',otherwise:'end'},
    {id:'target',type:'target_sender',config:{},bindings:{user_id:{nodeId:'start',port:'user_id'}},next:'kick'},
    {id:'kick',type:'kick',config:{},next:'end'},
    {id:'status',type:'text_match',config:{match:'contains',text:'SnowLuma 状态'},bindings:{content:{nodeId:'start',port:'text'}},next:'recall',otherwise:'$end'},
    {id:'recall',type:'recall',config:{},next:'end'},
    {id:'end',type:'stop',config:{}},
  ]};
  const until=async fn=>{const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error('Rule completion timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
  let mid=0;
  const push=async(text,user=222,group=12345)=>{
    raw({post_type:'message',message_type:'group',group_id:group,user_id:user,message_id:++mid,time:clock/1000,message:[{type:'text',data:{text}}],sender:{user_id:user,role:'member'}});
    await new Promise(resolve=>setImmediate(resolve));
    await until(()=>!kernel.management.snapshot().active);
  };
  try{
    kernel=await createApplication({appRoot,headless:true,transport:provider,env:{QQ_AGENT_DATA_DIR:path.join(dir,'data'),QQ_AGENT_MIGRATE_FROM:path.join(dir,'absent')},
      components:{'core.management':args=>createGroupManagement({...args,now:()=>clock})},
      fetchImpl:async()=>{throw Error('External traffic forbidden');},priceUpdates:{refresh:async()=>({ok:true}),updateCheck:async()=>({ok:true,hasUpdate:false})},communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})}});
    kernel.log.setLevel('error');kernel.loader.startWatchers=()=>{};
    kernel.config.update({server:{port:0,token:'synthetic-rule-console'},telemetry:{enabled:false},allow:{groups:[],private:[],allGroups:false,allPrivate:false},management:{rules:[rule]}});
    await kernel.start();
    const count=()=>calls.filter(c=>c.action==='set_group_kick').length;
    await push('普通消息');assert.equal(count(),0);assert.equal(kernel.management.snapshot().runs[0].effectCount,0);
    clock+=24357;await push('#sl');assert.equal(count(),1,JSON.stringify({calls,runs:kernel.management.snapshot().runs}));assert.equal(kernel.management.snapshot().runs[0].actionCount,1);
    assert.equal(calls.find(c=>c.action==='set_group_kick').params.user_id,222);
    clock+=1000;await push('#sl');assert.equal(count(),1);
    await push('#sl',333);assert.equal(count(),2,'another sender has an independent cooldown');
    await push('#sl',444,99999);assert.equal(count(),2,'scope checks still apply');
    await push('SnowLuma 状态',555);assert.equal(calls.filter(c=>c.action==='delete_msg').length,1);
    const runCount=kernel.management.snapshot().runs.length;kernel.orchestrator.pause();
    await push('#sl',666);assert.equal(count(),2);assert.equal(kernel.management.snapshot().runs.length,runCount);
    assert.equal(calls.some(c=>c.action.startsWith('send_')),false);
  }finally{
    await kernel?.stop();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('qqa-rule-onebot-'));fs.rmSync(dir,{recursive:true,force:true});
  }
});
