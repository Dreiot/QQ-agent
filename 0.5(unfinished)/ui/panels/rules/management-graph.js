import {visibleValuePorts,valueEdges,valueInputPoint,valueOutputPoint,graphWouldCycle} from './management-values.js';
// Pure graph helpers: layout is independent of the live editor and never rewrites
// execution order. Explicit edges preserve existing branches during insert/reorder.
export function outgoing(rule,node,catalog){
  const spec=catalog.find(s=>s.type===node.type);if(!spec||spec.terminal||spec.pure)return [];
  if(spec.routeKind)return [...(node.routes??[]).map(route=>({port:`route:${route.id}`,to:route.next??'$end',label:route.label})),{port:'otherwise',to:node.otherwise??'$end',label:'其他'}];
  const i=rule.nodes.indexOf(node),implicit=rule.nodes[i+1]?.scope===node.scope?rule.nodes[i+1]?.id:'$end';if(spec.loop)return [{port:'each',to:node.each??'$end',label:'每项'},{port:'next',to:node.next??implicit??'$end',label:'完成'}];return [{port:'next',to:node.next??implicit??'$end',label:spec.branch?'是':'然后'},...(spec.branch?[{port:'otherwise',to:node.otherwise??'$end',label:'否'}]:[])];
}
export function setConnection(node,port,target){if(port.startsWith('route:')){const route=node.routes?.find(r=>r.id===port.slice(6));if(!route)throw Error('分支已不存在');route.next=target;}else node[port]=target;}
export const linkTargets=value=>(Array.isArray(value)?value:[value??'$end']).filter(id=>id!=='$end');
export function packTargets(value){const targets=[...new Set(value.filter(id=>id!=='$end'))];if(targets.length>8)throw Error('每个输出最多连接 8 个节点');return targets.length>1?targets:targets[0]??'$end';}
export function addConnection(rule,node,catalog,port,target,replaceTarget=null){const edge=outgoing(rule,node,catalog).find(e=>e.port===port);if(port==='each'){setConnection(node,port,target);return;}setConnection(node,port,packTargets([...linkTargets(edge?.to).filter(id=>id!==replaceTarget),target]));}
export function disconnect(rule,node,catalog,port,target){const edge=outgoing(rule,node,catalog).find(e=>e.port===port);setConnection(node,port,packTargets(linkTargets(edge?.to).filter(id=>id!==target)));}
export function canConnect(rule,catalog,source,port,target){
  if(target==='$end')return true;if(source===target||rule.nodes[0]?.id===target)return false;
  const byId=new Map(rule.nodes.map(n=>[n.id,n]));if(!byId.has(target)||catalog.find(s=>s.type===byId.get(target).type)?.pure)return false;const from=byId.get(source),to=byId.get(target);if(!from)return false;if(port==='each'?to.scope!==source:(from.scope??null)!==(to.scope??null))return false;return !graphWouldCycle(rule,catalog,source,target);
}
export function explicitConnections(rule,catalog){for(const node of rule.nodes)for(const edge of outgoing(rule,node,catalog))setConnection(node,edge.port,edge.to);}
export function insertNode(rule,catalog,sourceId,port,node,{target=null,append=false}={}){
  if(rule.nodes.length>=200)throw Error('每条规则最多 200 个节点');
  const source=rule.nodes.find(n=>n.id===sourceId),edge=source?outgoing(rule,source,catalog).find(e=>e.port===port):null;
  if(source){const scope=port==='each'?source.id:source.scope;if(scope)node.scope=scope;}explicitConnections(rule,catalog);const spec=catalog.find(s=>s.type===node.type);if(spec.pure){rule.nodes.push(node);return;}
  const continuation=append?'$end':target??edge?.to??'$end';
  if(!spec.terminal){if(spec.routeKind){if(node.routes?.[0])node.routes[0].next=continuation;node.otherwise='$end';}else node.next=continuation;}
  rule.nodes.splice(source?rule.nodes.indexOf(source)+1:rule.nodes.length,0,node);if(edge){if(append||target)addConnection(rule,source,catalog,port,node.id,target);else setConnection(source,port,node.id);}
}
export function removeNode(rule,catalog,id){
  if(rule.nodes[0]?.id===id)throw Error('开始节点不能删除，可以更换开始方式');
  const removed=rule.nodes.find(n=>n.id===id);for(const child of rule.nodes)if(child.scope===id){if(removed.scope)child.scope=removed.scope;else delete child.scope;}explicitConnections(rule,catalog);for(const node of rule.nodes){for(const edge of outgoing(rule,node,catalog))if(linkTargets(edge.to).includes(id))disconnect(rule,node, catalog,edge.port,id);for(const [key,b]of Object.entries(node.bindings??{}))if(b.nodeId===id)delete node.bindings[key];}rule.nodes=rule.nodes.filter(n=>n.id!==id);if(rule.layout?.positions)delete rule.layout.positions[id];if(rule.layout?.visiblePorts)delete rule.layout.visiblePorts[id];
}

// Editable canvas: node coordinates are independent from execution order.
export function canvasLayout(rule,catalog,{automatic=false}={}){
  const base=graphLayout(rule,catalog),positions=new Map(),columns=new Map(),saved=automatic?{}:rule.layout?.positions??{};
  const data=valueEdges(rule,catalog),children=new Map(rule.nodes.map(n=>[n.id,new Set()])),parents=new Map(rule.nodes.map(n=>[n.id,new Set()])),ranks=new Map(rule.nodes.map(n=>[n.id,0]));for(const edge of [...base.edges.filter(e=>!e.end),...data]){children.get(edge.from)?.add(edge.to);parents.get(edge.to)?.add(edge.from);}const queue=rule.nodes.filter(n=>!parents.get(n.id).size).map(n=>n.id),degree=new Map([...parents].map(([id,p])=>[id,p.size]));while(queue.length){const id=queue.shift();for(const child of children.get(id)){ranks.set(child,Math.max(ranks.get(child),ranks.get(id)+1));degree.set(child,degree.get(child)-1);if(!degree.get(child))queue.push(child);}}for(const node of rule.nodes)base.positions.get(node.id).rank=ranks.get(node.id);
  for(const node of rule.nodes){const item=base.positions.get(node.id);const column=columns.get(item.rank)??[];column.push(item);columns.set(item.rank,column);}
  const enrich=item=>{const inputs=visibleValuePorts(rule,item.node,catalog,'inputs'),outputs=visibleValuePorts(rule,item.node,catalog,'outputs'),flowCount=outgoing(rule,item.node,catalog).length,start=catalog.find(s=>s.type===item.node.type)?.pure?104:104+flowCount*26+24;return {inputs,outputs,start,height:Math.max(112,start+Math.max(inputs.length,outputs.length)*26+18)};};
  const nodeHeight=item=>enrich(item).height;
  const pure=item=>!!catalog.find(s=>s.type===item.node.type)?.pure,sum=items=>items.reduce((total,item)=>total+nodeHeight(item)+42,0)-42;
  const maxHeight=Math.max(180,...[...columns.values()].map(column=>sum(column.filter(item=>!pure(item)))));
  for(const [rank,column]of columns){const main=column.filter(item=>!pure(item)),height=sum(main);let y=50+(maxHeight-height)/2,valueY=50+maxHeight+90;
    for(const item of [...main,...column.filter(pure)]){const details=enrich(item),height=details.height,point=saved[item.id],isValue=pure(item),top=point?.y??(isValue?valueY:y);positions.set(item.id,{...item,x:point?.x??50+rank*380,y:top,width:280,height,inputs:details.inputs,outputs:details.outputs,dataStart:details.start});if(isValue)valueY+=height+42;else y+=height+42;}
  }
  let scopeY=Math.max(0,...[...positions.values()].filter(p=>!p.node.scope).map(p=>p.y+p.height))+120;
  for(const loop of rule.nodes.filter(n=>catalog.find(s=>s.type===n.type)?.loop)){const children=[...positions.values()].filter(p=>p.node.scope===loop.id);if(!children.length)continue;const parent=positions.get(loop.id),minRank=Math.min(...children.map(p=>p.rank)),rows=new Map();for(const child of children){const column=child.rank-minRank,row=rows.get(column)??0;rows.set(column,row+1);if(automatic||!saved[child.id]){child.x=parent.x+column*340;child.y=scopeY+row*(child.height+45);}}scopeY=Math.max(scopeY,...children.map(p=>p.y+p.height))+100;}
  const edges=base.edges.filter(e=>!e.end).map(edge=>({...edge})),active=new Set(rule.nodes.filter(n=>!base.unreachable.includes(n.id)).map(n=>n.id));function includeValues(node){for(const b of Object.values(node.bindings??{})){const source=rule.nodes.find(n=>n.id===b.nodeId);if(source&&catalog.find(s=>s.type===source.type)?.pure&&!active.has(source.id)){active.add(source.id);includeValues(source);}}}for(const node of rule.nodes)if(active.has(node.id))includeValues(node);
  const model={...base,positions,edges,dataEdges:data,unreachable:rule.nodes.filter(n=>!active.has(n.id)).map(n=>n.id),items:[...positions.values()]};updateCanvasEdges(model);return model;
}
export function canvasOutputPoint(item,index){return {x:item.x+item.width,y:item.y+104+index*26};}
export function canvasInputPoint(item){return {x:item.x,y:item.y+52};}
export function canvasCurve(from,to){const bend=Math.max(55,Math.abs(to.x-from.x)*.45);return `M${from.x},${from.y} C${from.x+bend},${from.y} ${to.x-bend},${to.y} ${to.x},${to.y}`;}
export function updateCanvasEdges(model,nodeId){for(const edge of [...model.edges,...(model.dataEdges??[])]){if(nodeId&&edge.from!==nodeId&&edge.to!==nodeId)continue;const source=model.positions.get(edge.from),target=model.positions.get(edge.to);if(!source||!target)continue;edge.path=edge.kind==='data'?canvasCurve(valueOutputPoint(source,edge.output),valueInputPoint(target,edge.input)):canvasCurve(canvasOutputPoint(source,edge.index),canvasInputPoint(target));}}
export function canvasBounds(model){const items=[...model.positions.values()];return {x:Math.min(0,...items.map(p=>p.x))-35,y:Math.min(0,...items.map(p=>p.y))-35,right:Math.max(300,...items.map(p=>p.x+p.width))+35,bottom:Math.max(180,...items.map(p=>p.y+p.height))+35};}
export function graphLayout(rule,catalog){
  const byId=new Map(rule.nodes.map((node,index)=>[node.id,{node,index,rank:0,incoming:[],outgoing:[],reachable:false}])),edges=[],issues=[];
  for(const item of byId.values())for(const [index,port]of outgoing(rule,item.node,catalog).entries())for(const target of linkTargets(port.to).length?linkTargets(port.to):['$end']){const edge={...port,to:target};
    const end=edge.to==='$end',key=`${item.node.id}:${edge.port}:${target}`,to=end?`$end:${key}`:edge.to;
    if(!end&&!byId.has(to)){issues.push('存在未连接的目标');continue;}
    const e={...edge,key,from:item.node.id,to,end,index};edges.push(e);item.outgoing.push(e);if(!end)byId.get(to).incoming.push(e);
  }
  const reachable=new Set(),visit=id=>{if(reachable.has(id)||!byId.has(id))return;reachable.add(id);for(const e of byId.get(id).outgoing)visit(e.to);};visit(rule.nodes[0]?.id);
  const degrees=new Map([...byId].map(([id,item])=>[id,item.incoming.length])),queue=[...byId.keys()].filter(id=>!degrees.get(id));let count=0;
  while(queue.length){const id=queue.shift(),item=byId.get(id);count++;for(const e of item.outgoing)if(!e.end){const target=byId.get(e.to);target.rank=Math.max(target.rank,item.rank+1);degrees.set(e.to,degrees.get(e.to)-1);if(degrees.get(e.to)===0)queue.push(e.to);}}
  if(count!==byId.size){issues.push('连接形成循环');for(const item of byId.values())item.rank=item.index;}
  const items=[...byId.values()].map(item=>({...item,id:item.node.id,reachable:reachable.has(item.node.id),width:220,height:75+Math.ceil(item.outgoing.length/3)*25}));
  for(const e of edges)if(e.end){const from=byId.get(e.from);items.push({id:e.to,rank:from.rank+1,incoming:[e],outgoing:[],end:true,width:86,height:30,index:from.index+.5+e.index/100,reachable:reachable.has(e.from)});}
  const levels=[];for(const item of items){levels[item.rank]??=[];levels[item.rank].push(item);}
  const slots=new Map();let maxColumns=1;
  for(const row of levels){if(!row)continue;row.sort((a,b)=>{const weight=item=>item.incoming.length?item.incoming.reduce((sum,e)=>sum+(slots.get(e.from)??0)+(e.index-.5)*.7,0)/item.incoming.length:item.index;return weight(a)-weight(b)||a.index-b.index;});row.forEach((item,i)=>slots.set(item.id,i));maxColumns=Math.max(maxColumns,row.length);}
  const nodeArea=Math.max(300,maxColumns*248),positions=new Map();let y=38;
  for(const row of levels){if(!row)continue;const height=Math.max(...row.map(item=>item.height));row.forEach((item,i)=>{item.x=30+(nodeArea-row.length*248)/2+i*248+(220-item.width)/2;item.y=y;item.rowBottom=y+height;positions.set(item.id,item);});y+=height+60;}
  let longEdge=0;
  for(const edge of edges){const from=positions.get(edge.from),to=positions.get(edge.to);if(!from||!to)continue;const siblings=from.outgoing.length,sx=from.x+16+(edge.index+.5)*(from.width-32)/Math.max(1,siblings),sy=from.y+from.height,tx=to.x+to.width/2,ty=to.y;
    const middle=from.rowBottom+30+Math.min(12,edge.index*2);
    if(to.rank>from.rank+1){const lane=nodeArea+54+(longEdge++%10)*12;edge.path=`M${sx},${sy} V${middle-8} Q${sx},${middle} ${sx+8},${middle} H${lane-8} Q${lane},${middle} ${lane},${middle+8} V${ty-26} Q${lane},${ty-18} ${lane-8},${ty-18} H${tx+8} Q${tx},${ty-18} ${tx},${ty-10} V${ty}`;edge.labelX=lane-2;edge.labelY=middle-9;}
    else {edge.path=`M${sx},${sy} C${sx},${middle} ${tx},${middle} ${tx},${ty}`;edge.labelX=(sx+tx)/2;edge.labelY=middle-7;}
    edge.active=from.reachable;edge.merge=to.incoming.length>1;
  }
  return {items,edges,positions,width:nodeArea+(longEdge?190:60),height:Math.max(220,y-30),issues,unreachable:rule.nodes.filter(n=>!reachable.has(n.id)).map(n=>n.id)};
}
