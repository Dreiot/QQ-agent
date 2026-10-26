import {scopeLinkIssue} from './scopes.js';
import {PRIMITIVE_NODES} from './primitives.js';
import {nodeInfo} from './node-info.js';
import {describeNodePorts,canBindType,validatePortValue,validateLiteralValue} from './ports.js';
import {VALUE_NODES} from './value-nodes.js';
// Data-only contracts consumed by the editor and replaceable management runtime.
const text=(key,label,extra={})=>({key,label,type:'text',...extra});
const number=(key,label,min,max,value)=>({key,label,type:'number',min,max,default:value});
const choice=(key,label,options,value=options[0][0])=>({key,label,type:'select',options,default:value});
const users=text('users','QQ 号（空格或逗号分隔）',{required:true,ids:true});
const roles=[['member','普通成员'],['admin','管理员'],['owner','群主']];
const matchOptions=[['contains','包含文字'],['equals','文字完全相同'],['prefix','文字开头'],['suffix','文字结尾']];
const detection=[choice('match','匹配方式',[...matchOptions,['image','图片'],['video','视频'],['record','语音'],['file','文件'],['at','@ 提及'],['reply','回复消息'],['forward','转发消息'],['link','网址']]),text('text','查找内容（文字匹配时必填）')];
const wait=[number('seconds','观察时长（秒）',1,86400,60),text('text','只观察包含此文字的发言（留空为任意发言）'),choice('quantifier','观察对象',[['any','所选用户中任意一人'],['all','所选的每一位用户']])];
const counter=[text('key','计数器名称',{default:'提醒次数',required:true,maxLength:40}),choice('scope','分别计数',[['user','每位触发用户'],['group','整个群']])];
const keyword=text('text','关键词（每行一个）',{type:'multiline',required:true});
const nameFields=[choice('match','匹配方式',matchOptions),text('text','查找文字',{required:true})];
const trigger=(type,label,description='',fields=[])=>({type,label,description,fields,group:'开始',trigger:true});
const condition=(type,label,fields=[],description='')=>({type,label,fields,description,group:'判断',branch:true});
const target=(type,label,fields=[],description='')=>({type,label,fields,description,group:'选择对象'});
const action=(type,label,fields=[],description='',extra={})=>({type,label,fields,description,group:'执行',adminOnly:!['send_text','send_at'].includes(type),...extra});
const groupOnly=spec=>spec.trigger&&!['message','interval'].includes(spec.type)||spec.group==='执行'&&spec.type!=='send_text'||['event_source','member_info','role_is','joined_recently','card_matches','nickname_matches','has_card','bot_owner','switch_role','target_all','target_role','target_by_card','target_by_nickname'].includes(spec.type);

export const NODE_CATALOG=Object.freeze([
  trigger('message','收到消息','所选群聊或私聊的每条消息触发一次。'),trigger('member_join','成员入群'),
  trigger('interval','定时执行','从开始运行时计时，暂停或断线期间不补跑。',[number('seconds','间隔（秒）',10,86400,3600)]),
  trigger('member_leave','成员离群'),trigger('member_muted','成员被禁言'),trigger('member_unmuted','成员被解除禁言'),
  trigger('admin_changed','管理员变动'),trigger('message_recalled','群消息被撤回'),trigger('group_poke','群内戳一戳'),trigger('group_upload','群文件上传'),
  trigger('join_request','收到入群申请','仅处理申请加入当前群的请求，不自动接受邀请机器人入群。'),
  condition('found','消息匹配',detection),condition('not_found','消息不匹配',detection),condition('sender_is','特定用户发送',[users]),
  condition('message_equals','整条消息完全相同',[text('text','完整文字',{required:true,maxLength:2000})]),
  condition('text_match','文字匹配',nameFields),condition('message_kind','消息类型',[choice('kind','消息类型',[['text','文字'],['image','图片'],['video','视频'],['record','语音'],['file','文件'],['at','提及'],['reply','回复'],['forward','转发']])]),condition('has_link','包含网址'),
  condition('role_is','用户身份',[choice('role','身份',roles)]),
  condition('time_between','时间范围',[text('start','开始时间 HH:mm',{default:'08:00'}),text('end','结束时间 HH:mm',{default:'22:00'})]),
  condition('text_length','文字长度',[number('min','最少字符',0,100000,0),number('max','最多字符',0,100000,500)]),
  condition('contains_any','任一关键词',[keyword]),condition('contains_all','全部关键词',[keyword]),
  condition('mentions_bot','提及机器人'),condition('mentions_users','提及特定用户',[users]),
  condition('message_frequency','短时连续发言',[number('seconds','统计窗口（秒）',1,3600,10),number('count','达到消息数',2,1000,5),choice('scope','统计范围',[['user','同一位用户'],['group','整个群']])],'统计本次运行实际收到的群消息，包含当前消息。'),
  condition('repeated_message','重复发言',[number('seconds','统计窗口（秒）',1,3600,60),number('count','相同内容达到次数',2,1000,3)],'仅比较当前用户的消息内容指纹，不把消息全文写入记录。'),
  condition('weekday','星期范围',[text('days','星期（1–7，空格分隔；7 为周日）',{default:'1 2 3 4 5',required:true})]),
  condition('date_range','日期范围',[text('start','开始日期 YYYY-MM-DD',{required:true}),text('end','结束日期 YYYY-MM-DD',{required:true})]),
  condition('joined_recently','新入群用户',[number('seconds','入群未满（秒）',1,2592000,86400)],'协议端无法提供入群时间时走“否”。'),
  condition('card_matches','群名片匹配',nameFields),condition('nickname_matches','昵称匹配',nameFields),
  condition('has_card','已设置群名片'),condition('bot_owner','机器人是群主'),
  condition('target_count','已选用户数量',[number('min','至少人数',0,1000,1),number('max','至多人数',0,1000,1000)]),
  condition('group_is','指定群聊',[text('groups','群号（空格分隔）',{required:true,ids:true})]),
  condition('chance','概率判断',[number('percent','通过概率（%）',0,100,50)]),
  ...[['switch_text','按消息内容分流','text'],['switch_user','按用户分流','user'],['switch_role','按身份分流','role']].map(([type,label,routeKind])=>({type,label,routeKind,group:'分流',branch:true,fields:[],description:'从上到下匹配，进入第一条符合条件的分支；都不匹配时走“其他”。最多 12 条分支。'})),
  target('target_sender','触发用户'),target('target_users','特定用户',[users]),
  target('target_union','补充指定用户',[users]),target('target_clear','清空目标用户'),target('target_by_nickname','按昵称选人',nameFields),
  target('target_all','全体用户',[],'选择当前全部普通成员，跳过机器人、群主和管理员。'),
  target('target_mentions','消息中提及的用户',[],'忽略“@全体成员”，不把它展开为群成员。'),
  target('target_exclude','排除特定用户',[users]),target('target_intersect','只保留特定用户',[users]),target('target_except_sender','排除当前用户'),
  target('target_role','按身份选人',[choice('role','身份',roles)],'后续动作仍分别核验权限，不会因为选择了管理员就允许禁言或踢出管理员。'),
  target('target_recent','最近发言用户',[number('seconds','最近（秒）',1,3600,300)]),
  target('target_random','随机保留用户',[number('count','保留人数',1,1000,1)],'从已选用户中随机抽取，不自动扩大范围。'),
  target('target_by_card','按群名片选人',nameFields),
  {type:'delay',label:'等待',group:'时间',fields:[number('seconds','等待时长（秒）',1,86400,10)]},
  {type:'user_sent',label:'等待用户发送',group:'时间',fields:wait,branch:true,description:'观察所选用户，满足条件走“是”，到期走“否”。'},
  {type:'user_not_sent',label:'用户未发送',group:'时间',fields:wait,branch:true,description:'到期仍未满足发言条件走“是”，满足则走“否”。'},
  {type:'wait_until',label:'等到指定时间',group:'时间',fields:[text('time','时间 HH:mm',{default:'08:00'})],description:'按本机时间等待下一次到达该时刻，最多等待 24 小时。'},
  {type:'random_delay',label:'随机等待',group:'时间',fields:[number('min','最少等待（秒）',1,86400,3),number('max','最多等待（秒）',1,86400,10)]},
  {type:'cooldown_gate',label:'冷却闸门',group:'时间',branch:true,fields:[number('seconds','冷却时长（秒）',1,86400,60)],description:'本规则、群与用户分别计时，冷却期间走“否”；重启后重新计时。'},
  {type:'counter_add',label:'增加计次',group:'计数',fields:[...counter,number('amount','增加次数',1,1000,1),number('seconds','计数保留（秒）',1,2592000,86400)],description:'计数属于本条规则，可跨轮次和应用重启保留。'},
  {type:'counter_check',label:'次数达到',group:'计数',branch:true,fields:[...counter,number('count','达到次数',1,1000000,3)]},
  {type:'counter_reset',label:'清空计次',group:'计数',fields:counter},
  {type:'counter_daily',label:'每日计数加一',group:'计数',fields:[...counter,number('amount','增加数量',1,1000,1)]},
  action('recall_window','持续撤回窗口消息',[number('seconds','窗口长度（秒）',1,60,5)]),
  action('mute','执行禁言',[number('seconds','禁言时长（秒）',1,2592000,600)]),action('unmute','解除禁言'),action('kick','踢出群聊'),
  action('rename_group','修改群名',[text('text','新的群名',{required:true,maxLength:60,template:true})]),
  action('rename_card','修改群名片',[text('text','新的群名片',{required:true,maxLength:60,template:true})]),
  action('whole_mute','全员禁言'),action('whole_unmute','解除全员禁言'),action('recall','撤回消息'),
  action('send_text','发送群消息',[text('text','消息内容',{type:'multiline',required:true,maxLength:2000,template:true})],'通过应用发送队列发送，自动响应暂停时也会停止。'),
  action('send_at','提醒所选用户',[text('text','提醒内容',{type:'multiline',required:true,maxLength:2000,template:true})],'只提醒已选用户，每次最多 20 人。'),
  action('grant_admin','设为管理员',[],'仅机器人为群主时可执行。',{ownerOnly:true}),
  action('revoke_admin','取消管理员',[],'仅机器人为群主时可执行，不能更改群主或机器人自身。',{ownerOnly:true}),
  action('special_title','设置专属头衔',[text('text','专属头衔',{required:true,maxLength:18,template:true})],'仅机器人为群主时可执行。',{ownerOnly:true}),
  action('approve_join','同意入群申请',[],'只处理本轮真实收到的入群申请。'),action('reject_join','拒绝入群申请',[text('text','拒绝理由',{maxLength:100,template:true})]),
  {type:'note',label:'记录说明',group:'结束',fields:[text('text','记录内容',{required:true,maxLength:300,template:true})]},
  {type:'join',label:'汇合点',group:'结束',fields:[],description:'多条互斥分支可连接到这里，继续执行共同的后续节点。'},
  {type:'stop',label:'结束',group:'结束',fields:[],terminal:true},
  {type:'fork',label:'并行分发',group:'分流',fields:[]},
  {type:'branch_value',label:'按真假值分支',group:'分流',branch:true,fields:[{key:'condition',label:'条件',type:'boolean',default:false}]},
  {type:'member_info',label:'读取群成员信息',group:'查询',fields:[]},
  ...VALUE_NODES,
  ...PRIMITIVE_NODES,
].map(spec=>Object.freeze({...spec,groupOnly:!!groupOnly(spec),...(!spec.pure&&!spec.primitive?nodeInfo(spec):{}),...(['message_equals','counter_daily','recall_window'].includes(spec.type)?{legacy:true,featured:false}:{}),ports:describeNodePorts(spec)})));

export const ids=value=>[...new Set(String(value??'').split(/[\s,，;；]+/).filter(Boolean))];
export const validId=id=>/^[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
export function nodeEdges(nodes,index,catalog=NODE_CATALOG){
  const node=nodes[index],spec=catalog.find(s=>s.type===node.type);if(!spec||spec.terminal||spec.pure)return [];
  const implicit=nodes[index+1]?.scope===node.scope?nodes[index+1]?.id:'$end';
  const ports=spec.loop?[{port:'each',to:node.each??'$end',label:'每项'},{port:'next',to:node.next??implicit??'$end',label:'完成'}]:spec.routeKind?[...(node.routes??[]).map(route=>({port:`route:${route.id}`,to:route.next??'$end',label:route.label})),{port:'otherwise',to:node.otherwise??'$end',label:'其他'}]:[{port:'next',to:node.next??implicit??'$end',label:spec.branch?'是':'然后'},...(spec.branch?[{port:'otherwise',to:node.otherwise??'$end',label:'否'}]:[])];
  return ports.flatMap(edge=>(Array.isArray(edge.to)?edge.to:[edge.to]).map(to=>({...edge,to})));
}
function normalizeLinks(value){if(value===undefined||value===null)return '$end';const list=Array.isArray(value)?value:[value];if(list.length>8||list.some(id=>typeof id!=='string'||id!=='$end'&&!/^[\w-]{1,80}$/.test(id))||list.includes('$end')&&list.length>1)throw Error('每个输出最多连接 8 个节点，不能混用结束标记');const targets=[...new Set(list)];return targets.length>1?targets:targets[0]??'$end';}
const clock=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
export function validateNodeConfig(spec,raw={},enabled=true,bound=new Set()){
  const config={};for(const field of spec.fields){let value=raw[field.key]??field.default??'';
    if(bound.has(field.key)){const keep=field.type==='number'?typeof value==='number'&&Number.isFinite(value)&&value>=field.min&&value<=field.max:field.type==='boolean'?typeof value==='boolean':field.type==='select'?field.options.some(o=>o[0]===value):typeof value==='string'&&value.length<=(field.maxLength??1000)&&!value.includes('\0');config[field.key]=keep?value:field.default??(field.type==='number'?field.min:field.type==='boolean'?false:'');continue;}
    if(field.type==='number'){if(typeof value==='boolean'||value==='')throw Error(`${field.label}无效`);value=Number(value);if(!Number.isFinite(value)||value<field.min||value>field.max)throw Error(`${field.label}超出范围`);}
    else if(field.type==='boolean'){if(typeof value!=='boolean')throw Error(`${field.label}需要真假值`);}
    else if(field.type==='select'){if(!field.options.some(o=>o[0]===value))throw Error(`${field.label}无效`);}
    else{if(typeof value!=='string'||value.length>(field.maxLength??1000)||/[\x00]/.test(value))throw Error(`${field.label}无效`);if(!spec.pure)value=value.trim();if(enabled&&field.required&&!value.trim())throw Error(`请填写${field.label}`);if(field.ids&&(ids(value).length>1000||ids(value).some(id=>!validId(id))))throw Error(`${field.label}格式错误`);}
    config[field.key]=value;
  }
  const hasBound=keys=>keys.some(key=>bound.has(key));
  if(!hasBound(['match','text'])&&enabled&&['found','not_found'].includes(spec.type)&&matchOptions.some(o=>o[0]===config.match)&&!config.text)throw Error('文字判断需要填写查找内容');
  if(!hasBound(['start','end'])&&spec.type==='time_between'&&[config.start,config.end].some(t=>!clock(t)))throw Error('时间格式应为 HH:mm');if(!hasBound(['time'])&&spec.type==='wait_until'&&!clock(config.time))throw Error('时间格式应为 HH:mm');
  if(!hasBound(['start','end'])&&spec.type==='date_range'&&(enabled&&(!config.start||!config.end)||config.start&&!date(config.start)||config.end&&!date(config.end)||config.start&&config.end&&config.start>config.end))throw Error('请填写有效且顺序正确的日期范围');
  if(!hasBound(['days'])&&spec.type==='weekday'&&ids(config.days).some(day=>!/^([1-7])$/.test(day)))throw Error('星期请使用 1–7');
  if(!hasBound(['min','max'])&&['text_length','target_count','random_delay'].includes(spec.type)&&config.min>config.max)throw Error('最小值不能大于最大值');return config;
}
export function validateManagement(input={},catalog=NODE_CATALOG){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.rules)||input.rules.length>100)throw Error('管理规则格式无效，最多 100 条规则');
  const types=new Map(catalog.map(n=>[n.type,n])),ruleIds=new Set();
  return {version:1,rules:input.rules.map(rule=>{
    if(!rule||!/^[\w-]{1,80}$/.test(rule.id)||ruleIds.has(rule.id))throw Error('规则标识重复或无效');ruleIds.add(rule.id);
    if(typeof rule.name!=='string'||!rule.name.trim()||rule.name.length>100)throw Error('请填写规则名称（最多 100 字）');
    const groups=Array.isArray(rule.groups)?[...new Set(rule.groups.map(String))]:[];
    const privateIds=Array.isArray(rule.private)?[...new Set(rule.private.map(String))]:[];
    if(rule.private!==undefined&&!Array.isArray(rule.private)||privateIds.length>100||privateIds.some(id=>!validId(id)))throw Error('私聊 QQ 号格式错误');
    if(groups.length>100||groups.some(id=>!validId(id)))throw Error('群号格式错误');if(rule.enabled&&!groups.length&&!privateIds.length)throw Error('启用前请选择至少一个群聊或私聊');
    if(!Array.isArray(rule.nodes)||!rule.nodes.length||rule.nodes.length>200)throw Error('每条规则需要 1–200 个节点');
    const nodeIds=new Set(),nodes=rule.nodes.map((node,index)=>{try{
      const spec=types.get(node?.type);if(!spec)throw Error('包含未知节点');
      if(!/^[\w-]{1,80}$/.test(node.id)||nodeIds.has(node.id))throw Error('节点标识重复或无效');nodeIds.add(node.id);
      if(!!spec.trigger!==(index===0))throw Error('第一个节点必须是开始节点，后续节点不能再次开始');
      const ports=spec.ports??describeNodePorts(spec),bindings={},values={};
      if(node.bindings!=null){if(typeof node.bindings!=='object'||Array.isArray(node.bindings)||Object.keys(node.bindings).length>50)throw Error('数据连线格式无效');for(const [key,value]of Object.entries(node.bindings)){if(!ports.inputs.some(p=>p.key===key)||!value||typeof value!=='object'||!/^[\w-]{1,80}$/.test(value.nodeId)||typeof value.port!=='string'||value.port.length>100)throw Error('数据输入或来源无效');bindings[key]={nodeId:value.nodeId,port:value.port};}}
      if(node.values!=null){if(typeof node.values!=='object'||Array.isArray(node.values)||Object.keys(node.values).length>50)throw Error('输入值格式无效');for(const [key,value]of Object.entries(node.values)){const port=ports.inputs.find(p=>p.key===key);if(!port||port.configKey)throw Error('数据输入值无效');values[key]=validatePortValue({...port,required:true},validateLiteralValue(value));}}
      if((bindings.user_id||Object.hasOwn(values,'user_id'))&&(bindings.targets||Object.hasOwn(values,'targets')))throw Error('操作用户 QQ 与目标用户列表请只指定一项');
      const bound=new Set(ports.inputs.filter(p=>bindings[p.key]&&p.configKey).map(p=>p.configKey)),config=validateNodeConfig(spec,node.config,rule.enabled,bound);
      let routes;if(spec.routeKind){
        if(!Array.isArray(node.routes)||!node.routes.length||node.routes.length>12)throw Error('多路分流需要 1–12 条分支');const routeIds=new Set();
        routes=node.routes.map((route,i)=>{
          if(!route||!/^[\w-]{1,80}$/.test(route.id)||routeIds.has(route.id))throw Error('分支标识重复或无效');routeIds.add(route.id);
          const label=String(route.label??`分支 ${i+1}`).trim();if(!label||label.length>40)throw Error('分支名称需要 1–40 字');
          const value=String(route.value??'').trim();if(value.length>500||rule.enabled&&!value)throw Error(`请填写“${label}”分支条件`);
          const match=route.match??'contains';if(spec.routeKind==='text'&&!matchOptions.some(o=>o[0]===match))throw Error('分支匹配方式无效');
          if(spec.routeKind==='user'&&ids(value).some(id=>!validId(id)))throw Error('分支 QQ 号无效');if(spec.routeKind==='role'&&!roles.some(o=>o[0]===value))throw Error('分支身份无效');
          return {id:route.id,label,value,...(spec.routeKind==='text'?{match}:{}),next:normalizeLinks(route.next)};
        });
      }
      if(node.scope!=null&&!/^[\w-]{1,80}$/.test(node.scope))throw Error('循环范围无效');
      return {id:node.id,type:node.type,config,...(node.scope?{scope:node.scope}:{}),...(spec.loop?{each:normalizeLinks(node.each)}:{}),...(!spec.routeKind&&node.next!==undefined?{next:normalizeLinks(node.next)}:{}),...(spec.branch?{otherwise:normalizeLinks(node.otherwise)}:{}),...(routes?{routes}:{}),...(Object.keys(bindings).length?{bindings}:{}),...(Object.keys(values).length?{values}:{})};
      }catch(error){throw Error(`${index+1}. ${types.get(node?.type)?.label??'节点'}：${error.message}`);}
    });
    for(const node of nodes)if(types.get(node.type)?.loop&&Array.isArray(node.each))throw Error('每项出口只接一个入口，需要并行时请连接分发节点');
    const scopedRule={nodes};for(const node of nodes)if(node.scope){const parent=nodes.find(n=>n.id===node.scope);if(!parent||!types.get(parent.type)?.loop||parent.id===node.id)throw Error('循环范围必须指向有效的逐项处理节点');let level=0,current=node;const seen=new Set();while(current.scope){if(seen.has(current.id)||++level>8)throw Error('循环嵌套不能成环或超过 8 层');seen.add(current.id);current=nodes.find(n=>n.id===current.scope);if(!current)throw Error('循环范围不存在');}}
    let edgeCount=0;for(let i=0;i<nodes.length;i++)for(const edge of nodeEdges(nodes,i,catalog)){edgeCount++;if(edge.to!=='$end'){const target=nodes.find(n=>n.id===edge.to);if(target){const issue=scopeLinkIssue(scopedRule,nodes[i],target,edge.port);if(issue)throw Error(issue);}}if(edge.to!=='$end'&&!nodeIds.has(edge.to))throw Error('分支指向了不存在的节点');if(edge.to===nodes[0].id)throw Error('开始节点不能接收输入');if(edge.to!=='$end'&&types.get(nodes.find(n=>n.id===edge.to).type)?.pure)throw Error('数据计算节点不接执行线，请连接数据端口');}if(edgeCount>1600)throw Error('每条规则最多 1600 条连接');
    const visiting=new Set(),seen=new Set(),indices=new Map(nodes.map((n,i)=>[n.id,i])),dataChildren=new Map(nodes.map(n=>[n.id,[]]));
    for(const node of nodes)for(const [key,binding]of Object.entries(node.bindings??{})){const source=nodes.find(n=>n.id===binding.nodeId);if(!source)throw Error('数据来源节点不存在');const output=(types.get(source.type).ports??describeNodePorts(types.get(source.type))).outputs.find(p=>p.key===binding.port),input=(types.get(node.type).ports??describeNodePorts(types.get(node.type))).inputs.find(p=>p.key===key);if(!output||!input)throw Error('数据字段已不存在');const scopeIssue=scopeLinkIssue(scopedRule,source,node,null,output);if(scopeIssue)throw Error(scopeIssue);if(!canBindType(output.type,input.type))throw Error(`无法把${output.label}连接到${input.label}：类型不兼容`);dataChildren.get(source.id).push(node.id);edgeCount++;}if(edgeCount>1600)throw Error('每条规则最多 1600 条连接');
    function visit(index){if(visiting.has(index))throw Error('执行线或数据线不能形成循环');if(seen.has(index))return;visiting.add(index);for(const edge of nodeEdges(nodes,index,catalog))if(edge.to!=='$end')visit(indices.get(edge.to));for(const child of dataChildren.get(nodes[index].id))visit(indices.get(child));visiting.delete(index);seen.add(index);}
    for(let i=0;i<nodes.length;i++)visit(i);
    const cooldownSeconds=Number(rule.cooldownSeconds??30);if(!Number.isFinite(cooldownSeconds)||cooldownSeconds<0||cooldownSeconds>86400)throw Error('冷却时间需要在 0–86400 秒之间');
    let layout;
    if(rule.layout!==undefined){
      if(!rule.layout||typeof rule.layout!=='object'||Array.isArray(rule.layout)||rule.layout.version!==1||!rule.layout.positions||typeof rule.layout.positions!=='object'||Array.isArray(rule.layout.positions)||Object.keys(rule.layout.positions).length>200)throw Error('画布布局格式无效');
      const positions=Object.create(null);
      for(const [id,point]of Object.entries(rule.layout.positions)){
        if(!nodeIds.has(id))continue;
        if(!point||typeof point.x!=='number'||typeof point.y!=='number'||!Number.isFinite(point.x)||!Number.isFinite(point.y)||Math.abs(point.x)>100000||Math.abs(point.y)>100000)throw Error('节点位置超出画布范围');
        positions[id]={x:Math.round(point.x),y:Math.round(point.y)};
      }
      const visiblePorts={};if(rule.layout.visiblePorts!==undefined){if(!rule.layout.visiblePorts||typeof rule.layout.visiblePorts!=='object'||Array.isArray(rule.layout.visiblePorts)||Object.keys(rule.layout.visiblePorts).length>200)throw Error('端口显示设置无效');for(const [id,selection]of Object.entries(rule.layout.visiblePorts)){const node=nodes.find(n=>n.id===id);if(!node)continue;if(!selection||typeof selection!=='object'||Array.isArray(selection))throw Error('端口显示设置无效');const selected={};for(const direction of ['inputs','outputs'])if(selection[direction]!==undefined){const values=selection[direction],available=types.get(node.type).ports?.[direction]??[];if(!Array.isArray(values)||values.length>50||values.some(k=>typeof k!=='string'||!available.some(p=>p.key===k)))throw Error('显示的端口已不存在');selected[direction]=[...new Set(values)];}visiblePorts[id]=selected;}}
      layout={version:1,positions,...(Object.keys(visiblePorts).length?{visiblePorts}:{})};
    }
    return {id:rule.id,name:rule.name.trim(),enabled:rule.enabled===true,groups,...(rule.private!==undefined?{private:privateIds}:{}),cooldownSeconds,nodes,...(layout?{layout}:{})};
  })};
}
