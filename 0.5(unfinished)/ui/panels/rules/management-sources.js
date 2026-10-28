// Describe the same precedence used by value-runtime without inventing live values.
export function displayValue(value,port={}){
  if(value===undefined)return '未提供';
  if(value===null)return '空值';
  const option=port.options?.find(([key])=>key===value);if(option)return String(option[1]);
  if(typeof value==='boolean')return value?'是':'否';
  if(Array.isArray(value))return value.length?value.join('、'):'空名单';
  if(typeof value==='object')return JSON.stringify(value);
  return value===''?'空文字':String(value);
}
function memberOrigins(rule,node,specs){
  const parents=new Map(rule.nodes.map(n=>[n.id,[]]));
  for(const [index,source]of rule.nodes.entries()){
    const spec=specs.get(source.type);if(!spec||spec.terminal||spec.pure)continue;
    const implicit=rule.nodes[index+1]?.scope===source.scope?rule.nodes[index+1]?.id:'$end';
    const edges=spec.routeKind?[...(source.routes??[]).map(r=>r.next),source.otherwise]:[source.next??implicit,...(spec.branch?[source.otherwise]:[]),...(spec.loop?[source.each]:[])];
    for(const target of edges.flatMap(v=>Array.isArray(v)?v:[v]))parents.get(target)?.push(source);
  }
  const seen=new Set(),found=new Set();function visit(current){if(seen.has(current.id))return;seen.add(current.id);const incoming=parents.get(current.id)??[];if(!incoming.length){found.add(rule.nodes[0]);return;}for(const source of incoming){if(specs.get(source.type)?.group==='选择对象'||specs.get(source.type)?.trigger)found.add(source);else visit(source);}}
  visit(node);return [...found].filter(Boolean);
}
export function inputSource(rule,node,catalog,port){
  const specs=new Map(catalog.map(s=>[s.type,s])),spec=specs.get(node.type),binding=node.bindings?.[port.key];
  const name=n=>`${String(rule.nodes.indexOf(n)+1).padStart(2,'0')} ${specs.get(n?.type)?.label??'已删除节点'}`;
  if(binding){
    const source=rule.nodes.find(n=>n.id===binding.nodeId),output=specs.get(source?.type)?.ports?.outputs.find(p=>p.key===binding.port);
    return {kind:'linked',label:'连线',text:source?`${name(source)} / ${output?.label??binding.port}`:'来源节点已不存在',detail:'使用这条数据线传入的结果；不会再使用固定值或自动来源。来源节点本轮未执行时不会复用上次结果。',sourceId:source?.id};
  }
  if(Object.hasOwn(node.values??{},port.key))return {kind:'filled',label:'固定值',text:displayValue(node.values[port.key],port),detail:'使用为这个参数填写的固定值，覆盖自动来源和节点默认值。',value:node.values[port.key]};
  if(port.configKey){const value=node.config?.[port.configKey]??port.default;return {kind:value===undefined||value===''&&port.required?'required':'filled',label:'设置值',text:displayValue(value,port),detail:'使用下方设置；连接数据线后，改用连入的结果。',value};}
  if(port.inherit){
    const trigger=rule.nodes[0],triggerSpec=specs.get(trigger?.type),eventUser=triggerSpec?.ports?.outputs.find(p=>p.key==='user_id')?.label??'事件相关 QQ';
    const triggerName=trigger?name(trigger):'本次触发事件',origins=spec?.pure?[trigger]:memberOrigins(rule,node,specs),memberSource=origins.length===1?`${name(origins[0])} / ${origins[0]===trigger?eventUser:'选出的成员'}`:'按实际到达的路径合并成员';
    const memberDetail=`可能的来源：${origins.map(name).join('、')||triggerName}。最初来自触发事件相关 QQ；沿执行线经过的选人节点会替换或筛选名单。多路汇合时合并实际到达的名单并去重。普通节点的单独参数不会改写后续名单。`;
    if(port.targetUser){const targets=spec?.ports?.inputs.find(p=>p.key==='targets');if(targets&&(node.bindings?.targets||Object.hasOwn(node.values??{},'targets'))){const source=inputSource(rule,node,catalog,targets);return {kind:'auto',label:'自动',text:`按本节点成员名单：${source.text}`,detail:`未指定单个 QQ，按本节点的“待处理成员”逐人操作。${source.detail}这份单独指定的名单只影响当前操作，不会沿执行线改写后续名单。`};}return {kind:'auto',label:'自动',text:memberSource,detail:`未指定单个 QQ，按“待处理成员”逐人操作。${memberDetail}填写单个 QQ 后仅影响这一步。`};}
    if(port.inherit==='targets')return {kind:'auto',label:'自动',text:memberSource,detail:spec?.pure?`取本轮开始时的名单（${triggerName} 的${eventUser}）。计算节点不会自动读取某个分支的选人结果；需要时请从该选人节点接数据线。`:memberDetail};
    if(port.inherit==='current_time')return {kind:'auto',label:'自动',text:'执行到这一步的电脑时间',detail:'每次实际读取时重新取当前时间；单位为秒。试运行按模拟时间推进。'};
    const from={group:['group_id','事件所在群号'],user:['user_id',eventUser],text:['text','消息纯文字'],message:['message','完整消息'],message_id:['message_id','消息 ID'],event:['event','完整事件资料'],event_time:['time','事件发生时间'],time:['time','事件发生时间']}[port.inherit];
    if(from){const output=triggerSpec?.ports?.outputs.find(p=>p.key===from[0]),label=output?.label??from[1];return {kind:'auto',label:'自动',text:`${triggerName} / ${label}`,detail:port.inherit==='group'?'来自本轮触发事件所在群；私聊没有群号。普通节点临时改用别的群号只影响该节点。':port.inherit==='user'?`来自触发这轮规则的${eventUser}。选人节点只改变待处理成员，不会改变这个 QQ；其他节点临时指定 QQ 也只影响该节点。`:port.inherit==='event_time'?'来自触发事件上报的时间；真实事件缺少时间时，此值可能没有提供。':port.inherit==='time'?'优先使用触发事件时间；未上报时使用本轮开始时间。':`来自启动本轮规则的事件。前面节点临时修改文字、消息或消息 ID，不会改写这个自动来源。`};}
    return {kind:'auto',label:'自动',text:'本轮触发资料',detail:'使用本次规则运行的对应资料；不会复用上轮结果。'};
  }
  if(port.default!==undefined)return {kind:'filled',label:'默认值',text:displayValue(port.default,port),detail:'未填写固定值，也未连接数据线，使用节点默认值。',value:port.default};
  const templateVariable=node.type==='format_text'&&['a','b','c','d'].includes(port.key);
  if(templateVariable&&node.bindings?.template)return {kind:'optional',label:'看模板',text:'是否需要由连入的文字模板决定',detail:'连入的模板若含 {{'+port.key+'}}，就必须为此变量填写内容或连接结果；模板未引用时可留空。'};
  const template=Object.hasOwn(node.values??{},'template')?node.values.template:node.config?.template,templateRequired=templateVariable&&new RegExp('\\{\\{'+port.key+'\\}\\}').test(template??''),required=port.required||templateRequired;
  return {kind:required?'required':'optional',label:required?'待填写':'可留空',text:required?'填写内容或连接一个结果':'不提供此参数',detail:templateRequired?'这段文字中使用了 {{'+port.key+'}}，请为它填写内容或连接一个结果。':required?'这个参数没有自动来源，必须填写固定值或连接数据线。':'留空时不提供这个参数，按节点说明处理。'};
}
