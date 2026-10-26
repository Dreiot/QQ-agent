import {evaluatePrimitive} from './primitives.js';
import {isSequence} from './sequences.js';
import {describeNodePorts,validatePortValue,readBindingValue,ownPath} from './ports.js';
import {evaluateValueNode} from './value-nodes.js';
import {messageText} from './nodes.js';

export function createValueRuntime({root,catalog,validateConfig,guard,trace,now=Date.now,hooks={},parentOutputs=null}){
  const specs=new Map(catalog.map(s=>[s.type,s])),nodes=new Map(root.rule.nodes.map(n=>[n.id,n])),outputs=new Map(parentOutputs??[]),cache=new Map();let previewBytes=0;
  const ports=node=>specs.get(node.type).ports??describeNodePorts(specs.get(node.type));
  const preview=value=>isSequence(value)?'事件流':value===undefined?'未提供':value===null?'空值':Array.isArray(value)?`列表 · ${value.length} 项`:typeof value==='object'?`对象 · ${Object.keys(value).length} 个字段`:String(value).slice(0,120);
  function publish(node,data){outputs.set(node.id,data);if(root.dry){const values=Object.fromEntries(Object.entries(data).map(([key,value])=>[key,preview(value)])),size=JSON.stringify(values).length;if(previewBytes+size<=40000){root.record.values??={};root.record.values[node.id]=values;previewBytes+=size;}}}
  async function get(binding,allowMissing=false){guard(root);const source=nodes.get(binding.nodeId);if(specs.get(source.type).pure)await pure(source);const values=outputs.get(source.id);if(!values){if(allowMissing)return undefined;throw Error(`数据来源“${specs.get(source.type).label}”本轮未执行`);}return values[binding.port];}
  function inherited(run,key){return key==='group'?run.group||undefined:key==='user'?run.user||undefined:key==='targets'?[...run.targets]:key==='event'?run.event:key==='message'?run.event.message:key==='message_id'?run.event.message_id:key==='text'?messageText(run.event):key==='event_time'?(run.event.time??(run.dry?run.startedAt/1000:undefined)):key==='current_time'?(run.dry?run.startedAt+run.elapsed*1000:now())/1000:key==='time'?Number(run.event.time??run.startedAt/1000):undefined;}
  async function inputs(run,node){const values={};for(const port of ports(node).inputs){let value;if(node.bindings?.[port.key])value=await get(node.bindings[port.key],port.allowMissing);else if(Object.hasOwn(node.values??{},port.key))value=node.values[port.key];else if(port.configKey){value=node.config[port.configKey]??port.default;if(['user_ids','group_ids'].includes(port.type)&&typeof value==='string')value=value.split(/[\s,，;；]+/).filter(Boolean);}else if(port.inherit)value=inherited(run,port.inherit);else value=port.default;
      if(node.bindings?.[port.key]&&!port.allowMissing)value=readBindingValue(value,port);else value=validatePortValue({...port,required:port.required||!!port.inherit&&!port.optional},value);if(port.options&&value!==undefined&&!port.options.some(o=>o[0]===value))throw Error(`${port.label}不在可选值中`);values[port.key]=value;
    }return values;
  }
  async function pure(node){if(cache.has(node.id))return cache.get(node.id);const work=(async()=>{guard(root);trace(root,node,'running');try{const values=await inputs(root,node),result=evaluatePrimitive(node,values,hooks)??evaluateValueNode(node,values);guard(root);for(const output of ports(node).outputs)if(result[output.key]!==undefined)validatePortValue(output,result[output.key]);publish(node,result);trace(root,node,'done','数据已计算');return result;}catch(error){trace(root,node,error.name==='AbortError'?'cancelled':'failed',error.message);throw error;}})();cache.set(node.id,work);return work;}
  async function prepare(state,original){const spec=specs.get(original.type),values=await inputs(state,original),config={...original.config};for(const port of ports(original).inputs)if(port.configKey&&values[port.key]!==undefined)config[port.configKey]=['user_ids','group_ids'].includes(port.type)?values[port.key].join(' '):values[port.key];const node={...original,config:validateConfig(spec,config,true)},run={...state,event:{...state.event},targets:[...state.targets]};
    const explicit=key=>Object.hasOwn(original.bindings??{},key)||Object.hasOwn(original.values??{},key);
    if(values.group_id!==undefined){if(run.kind==='private')throw Error('私聊流程不能使用群号输入');run.group=String(values.group_id);run.chatId=run.group;run.scopeId=run.group;if(!run.rule.groups.includes(run.group))throw Error('数据输入的群号不在本规则的应用范围');}
    if(values.user_id!==undefined&&explicit('user_id')){if(ports(original).inputs.some(p=>p.key==='user_id'&&p.targetUser))run.targets=[String(values.user_id)];else run.user=String(values.user_id);}
    if(values.targets!==undefined&&explicit('targets'))run.targets=[...values.targets];
    if(values.content!==undefined)run.event.message=[{type:'text',data:{text:values.content}}];if(values.message!==undefined&&explicit('message'))run.event.message=values.message;if(values.message_id!==undefined&&explicit('message_id'))run.event.message_id=values.message_id;
    return {run,node,values};
  }
  function complete(state,original,run,{result=true,member=null,success=true,completedAt,extra={}}={}){
    const spec=specs.get(original.type);state.elapsed=run.elapsed;state.count=run.count;if(spec.group==='选择对象')state.targets=[...run.targets];
    let values;if(spec.trigger){values={};for(const output of ports(original).outputs){let value=output.key==='chat_type'?run.kind??'group':output.key==='chat_id'?run.chatId??run.group:output.key==='chat_key'?(run.kind==='private'?'private:'+run.chatId:'group:'+run.group):output.key==='group_id'?run.group:output.key==='user_id'?run.user||undefined:output.key==='self_id'?run.self:output.key==='text'?messageText(run.event):output.key==='event'?run.event:ownPath(run.event,output.key);if(output.key==='time'&&value==null&&run.dry)value=run.startedAt/1000;values[output.key]=value;}}
    else{values={group_id:run.group,user_id:run.user||undefined,targets:[...run.targets],count:run.targets.length,result:!!result,success:!!success,value:run.count??0};if(member)Object.assign(values,{member,nickname:member.nickname,card:member.card,role:member.role,join_time:member.joinTime>0?member.joinTime:undefined,last_sent_time:member.lastSentTime>0?member.lastSentTime:undefined});}
    Object.assign(values,{completed_at:completedAt},extra);const actual=Object.fromEntries(ports(original).outputs.map(p=>[p.key,values[p.key]]));publish(original,actual);
  }
  return {prepare,complete,fork(loop,data,childRoot){const engine=createValueRuntime({root:childRoot,catalog,validateConfig,guard,trace,now,hooks,parentOutputs:outputs});engine.seed(loop,data);return engine;},seed(node,data){publish(node,data);},inspect:ids=>Promise.all(ids.map(id=>pure(nodes.get(id))))};
}
