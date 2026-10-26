import {nodeEdges} from './catalog.js';

// A DAG node executes once, after all of its possible predecessors have resolved.
// Inactive conditional branches resolve without producing a token; they never
// hold a merge open. Fan-out contexts share cancellation, but not user selection.
export async function executeManagementFlow({rule,catalog,initial,step,signal,onFailure,concurrency=8,onContext,scope=null,entry=rule.nodes[0].id}){
  const nodes=new Map(rule.nodes.map((node,index)=>({node,index})).filter(({node})=>(node.scope??null)===scope).map(({node,index})=>[node.id,{node,index,parents:new Set(),children:new Set(),edges:nodeEdges(rule.nodes,index,catalog),inputs:[]}]));
  for(const item of nodes.values())for(const edge of item.edges)if(edge.to!=='$end'&&nodes.has(edge.to)){item.children.add(edge.to);nodes.get(edge.to).parents.add(item.node.id);}
  for(const item of nodes.values())for(const binding of Object.values(item.node.bindings??{})){if(!nodes.has(binding.nodeId))continue;nodes.get(binding.nodeId).children.add(item.node.id);item.parents.add(binding.nodeId);}
  const remaining=new Map([...nodes].map(([id,item])=>[id,item.parents.size])),ready=[...nodes].filter(([,item])=>!item.parents.size).map(([id])=>id);if(!nodes.has(entry))throw Error('执行入口不属于当前范围');nodes.get(entry).inputs.push({order:-1,context:initial});
  let active=0,finished=0,failure=null;
  const clone=context=>({...context,targets:[...context.targets],consumed:new Set(context.consumed)});
  function merge(inputs){inputs.sort((a,b)=>a.order-b.order);const result=clone(inputs[0].context);result.targets=[...new Set(inputs.flatMap(i=>i.context.targets))];if(result.targets.length>1000)throw Error('汇合后的目标用户超过 1000 人');result.elapsed=Math.max(...inputs.map(i=>i.context.elapsed));result.consumed=new Set(inputs.flatMap(i=>[...i.context.consumed]));result.count=Math.max(...inputs.map(i=>i.context.count??0));return result;}
  return new Promise((resolve,reject)=>{
    function pump(){
      while(!failure&&!signal.aborted&&active<concurrency&&ready.length){const id=ready.shift(),item=nodes.get(id);active++;
        void(async()=>{let context,port=null;try{if(item.inputs.length){context=merge(item.inputs);port=await step(context,item.node,item.index);onContext?.(context);}}
          catch(error){if(!failure){failure=error;onFailure?.(error);}}
          finally{if(!failure&&!signal.aborted){for(const child of item.children){const edges=item.edges.filter(e=>e.to===child);if(context&&edges.some(e=>e.port===port))nodes.get(child).inputs.push({order:item.index,context:clone(context)});remaining.set(child,remaining.get(child)-1);if(!remaining.get(child))ready.push(child);}}finished++;active--;pump();}
        })();
      }
      if(active)return;if(failure)return reject(failure);if(signal.aborted)return reject(Object.assign(Error('规则已停止'),{name:'AbortError'}));if(finished!==nodes.size)return reject(Error('流程连接无法完成，请检查循环或缺失节点'));resolve();
    }
    pump();
  });
}
