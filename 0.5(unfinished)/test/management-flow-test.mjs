import test from 'node:test';
import assert from 'node:assert/strict';
import {executeManagementFlow} from '../src/management/flow.js';
import {NODE_CATALOG,validateManagement} from '../src/management/catalog.js';
test('wide fan-out is bounded to eight concurrent steps and a shared continuation runs only once',async()=>{
  const start={id:'start',type:'message',config:{},next:[]},branches=[],leaves=[],join={id:'join',type:'join',config:{},next:'stop'},stop={id:'stop',type:'stop',config:{}};
  for(let i=0;i<8;i++){const fork={id:`fork-${i}`,type:'fork',config:{},next:[]};start.next.push(fork.id);branches.push(fork);for(let j=0;j<8;j++){const leaf={id:`leaf-${i}-${j}`,type:'note',config:{text:'leaf'},next:'join'};fork.next.push(leaf.id);leaves.push(leaf);}}
  const rule=validateManagement({rules:[{id:'bounded',name:'bounded',enabled:false,groups:[],nodes:[start,...branches,...leaves,join,stop]}]}).rules[0],controller=new AbortController(),calls=[];let running=0,peak=0,merged;
  await executeManagementFlow({rule,catalog:NODE_CATALOG,initial:{targets:[],consumed:new Set(),elapsed:0},signal:controller.signal,step:async(context,node)=>{calls.push(node.id);running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,1));if(node.id.startsWith('leaf'))context.targets=[node.id];if(node.id==='join')merged=context.targets;running--;return 'next';}});
  assert.ok(peak>1&&peak<=8);assert.equal(calls.length,rule.nodes.length);assert.equal(calls.filter(id=>id==='join').length,1);assert.equal(merged.length,64);
});
test('a failed path cancels waiting siblings and never schedules the shared action',async()=>{
  const controller=new AbortController(),start={id:'start',type:'message',config:{},next:['fail','wait']},nodes=[start,{id:'fail',type:'note',config:{text:'fail'},next:'join'},{id:'wait',type:'delay',config:{seconds:1},next:'join'},{id:'join',type:'join',config:{}}],calls=[];
  await assert.rejects(executeManagementFlow({rule:{nodes},catalog:NODE_CATALOG,initial:{targets:[],consumed:new Set(),elapsed:0},signal:controller.signal,onFailure:()=>controller.abort(),step:async(_context,node)=>{calls.push(node.id);if(node.id==='fail'){await new Promise(r=>setTimeout(r,2));throw Error('synthetic failure');}if(node.id==='wait')await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));return 'next';}}),/synthetic failure/);
  assert.ok(calls.includes('wait'));assert.ok(!calls.includes('join'));assert.equal(controller.signal.aborted,true);
});
