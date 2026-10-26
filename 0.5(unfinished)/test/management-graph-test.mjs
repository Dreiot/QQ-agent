import test from 'node:test';
import assert from 'node:assert/strict';
import {NODE_CATALOG,nodeEdges,validateManagement} from '../src/management/catalog.js';
import {outgoing,insertNode,removeNode,canConnect,graphLayout,canvasLayout,canvasInputPoint,canvasOutputPoint,updateCanvasEdges,addConnection,disconnect} from '../ui/panels/rules/management-graph.js';
const n=(id,type,extra={})=>({id,type,config:{},...extra});
function branching(){return {id:'branch-rule',name:'分流',enabled:false,groups:[],nodes:[n('start','message',{next:'split'}),n('split','switch_text',{routes:[{id:'help',label:'帮助',match:'contains',value:'帮助',next:'help-node'},{id:'bad',label:'违规',match:'contains',value:'违规',next:'bad-node'}],otherwise:'join'}),n('help-node','note',{config:{text:'帮助'},next:'join'}),n('bad-node','mute',{config:{seconds:60},next:'join'}),n('join','join',{next:'stop'}),n('stop','stop')]};}
test('frontend and runtime agree on binary, multiway, default and terminal edges',()=>{
  const rule=branching();rule.nodes.splice(3,0,n('condition','found',{config:{text:'x'},otherwise:'stop'}));
  for(const [index,node]of rule.nodes.entries())assert.deepEqual(outgoing(rule,node,NODE_CATALOG),nodeEdges(rule.nodes,index,NODE_CATALOG));assert.doesNotThrow(()=>validateManagement({rules:[rule]}));
});
test('inserting on a selected branch preserves every unrelated edge and its continuation',()=>{
  const rule=branching(),original=structuredClone(rule);insertNode(rule,NODE_CATALOG,'split','route:bad',n('new','note',{config:{text:'新节点'}}));
  assert.equal(rule.nodes[1].routes[1].next,'new');assert.equal(rule.nodes.find(n=>n.id==='new').next,'bad-node');assert.deepEqual(rule.nodes[1].routes[0],original.nodes[1].routes[0]);assert.equal(rule.nodes[1].otherwise,'join');assert.equal(rule.nodes.find(n=>n.id==='help-node').next,'join');assert.doesNotThrow(()=>validateManagement({rules:[rule]}));
});
test('independent insertion does not accidentally extend the old last step; deletion only ends affected branches',()=>{
  const rule={id:'linear',name:'线性',enabled:false,groups:[],nodes:[n('start','message'),n('a','note',{config:{text:'a'}})]};insertNode(rule,NODE_CATALOG,null,'next',n('independent','note',{config:{text:'b'}}));assert.equal(rule.nodes[1].next,'$end');assert.deepEqual(graphLayout(rule,NODE_CATALOG).unreachable,['independent']);
  const multi=branching();removeNode(multi,NODE_CATALOG,'help-node');assert.equal(multi.nodes[1].routes[0].next,'$end');assert.equal(multi.nodes[1].routes[1].next,'bad-node');assert.equal(multi.nodes[1].otherwise,'join');
});
test('cycles are excluded from target choices and rejected on the server including multiway routes',()=>{
  const rule=branching();assert.equal(canConnect(rule,NODE_CATALOG,'bad-node','next','split'),false);assert.equal(canConnect(rule,NODE_CATALOG,'split','otherwise','start'),false);assert.equal(canConnect(rule,NODE_CATALOG,'bad-node','next','join'),true);
  rule.nodes[1].routes[0].next='split';assert.throws(()=>validateManagement({rules:[rule]}),/循环/);assert.ok(graphLayout(rule,NODE_CATALOG).issues.includes('连接形成循环'));
});
test('nested branches, long jumps and a shared join have nonoverlapping node rectangles',()=>{
  const rule=branching();insertNode(rule,NODE_CATALOG,'split','route:bad',n('nested','found',{config:{text:'x'},otherwise:'join'}));const model=graphLayout(rule,NODE_CATALOG);
  assert.equal(model.positions.get('join').incoming.length,4);assert.equal(model.unreachable.length,0);assert.equal(model.issues.length,0);
  for(const a of model.items)for(const b of model.items)if(a!==b)assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,`${a.id}/${b.id} overlap`);
  for(const edge of model.edges){assert.ok(model.positions.get(edge.to).y>model.positions.get(edge.from).y);assert.ok(edge.path.startsWith('M'));assert.ok(Number.isFinite(edge.labelX));}
});
test('200-node layout stays bounded and does not drop nodes or edges',()=>{
  const nodes=Array.from({length:200},(_,i)=>n('n'+i,i===0?'message':i===199?'stop':'found',{config:i===0||i===199?{}:{text:'x'},...(i&&i<199?{otherwise:'$end'}:{})})),rule={id:'large',name:'大流程',enabled:false,groups:[],nodes};const start=performance.now(),model=graphLayout(rule,NODE_CATALOG);assert.equal(model.positions.size,398);assert.equal(model.issues.length,0);assert.ok(performance.now()-start<500,'bounded graph layout must not block the UI for half a second');assert.doesNotThrow(()=>validateManagement({rules:[rule]}));
});

test('editable canvas has side ports, honors saved positions, and updates incoming and outgoing curves',()=>{
  const rule=branching(),model=canvasLayout(rule,NODE_CATALOG);assert.equal(model.positions.size,rule.nodes.length);assert.equal(model.edges.length,7);
  for(const a of model.items)for(const b of model.items)if(a!==b)assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,`${a.id}/${b.id} overlap`);
  const source=model.positions.get('split'),target=model.positions.get('join'),edge=model.edges.find(e=>e.from==='split'&&e.to==='join'),before=edge.path;
  assert.equal(canvasOutputPoint(source,0).x,source.x+source.width);assert.equal(canvasInputPoint(target).x,target.x);target.x+=50;updateCanvasEdges(model,'join');assert.notEqual(edge.path,before);
  rule.layout={version:1,positions:{split:{x:-100,y:999}}};const normalized=validateManagement({rules:[rule]}).rules[0];assert.deepEqual(normalized.layout.positions.split,{x:-100,y:999});assert.equal(canvasLayout(normalized,NODE_CATALOG).positions.get('split').x,-100);assert.notEqual(canvasLayout(normalized,NODE_CATALOG,{automatic:true}).positions.get('split').x,-100);
  rule.layout.positions.split.x=Infinity;assert.throws(()=>validateManagement({rules:[rule]}),/位置/);rule.layout.positions.split.x=100001;assert.throws(()=>validateManagement({rules:[rule]}),/位置/);
});

test('one output retains multiple targets, deleting/inserting one cable preserves siblings, limits and cycles still hold',()=>{
  const r=branching(),split=r.nodes[1];addConnection(r,split,NODE_CATALOG,'route:help','bad-node');assert.deepEqual(split.routes[0].next,['help-node','bad-node']);assert.equal(canConnect(r,NODE_CATALOG,'bad-node','next','split'),false);
  const actual=validateManagement({rules:[r]}).rules[0];assert.deepEqual(actual.nodes[1].routes[0].next,['help-node','bad-node']);assert.equal(nodeEdges(actual.nodes,1).filter(e=>e.port==='route:help').length,2);assert.equal(canvasLayout(r,NODE_CATALOG).edges.filter(e=>e.port==='route:help').length,2);
  insertNode(r,NODE_CATALOG,'split','route:help',n('new','note',{config:{text:'insert'}}),{target:'help-node'});assert.deepEqual(new Set(split.routes[0].next),new Set(['bad-node','new']));assert.equal(r.nodes.find(n=>n.id==='new').next,'help-node');disconnect(r,split,NODE_CATALOG,'route:help','bad-node');assert.equal(split.routes[0].next,'new');
  const invalid=branching();invalid.nodes[0].next=Array.from({length:9},()=> 'split');assert.throws(()=>validateManagement({rules:[invalid]}),/8/);invalid.nodes[0].next=['split','$end'];assert.throws(()=>validateManagement({rules:[invalid]}),/结束/);invalid.nodes[0].next=['split',false];assert.throws(()=>validateManagement({rules:[invalid]}),/输出/);
  for(const spec of NODE_CATALOG){assert.ok(spec.description?.length>12,`${spec.type} needs a useful description`);assert.ok(spec.category&&spec.inputHint&&spec.outputHint&&spec.example?.length>8);}
});
