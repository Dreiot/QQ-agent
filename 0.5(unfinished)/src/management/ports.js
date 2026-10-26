import {isSequence} from './sequences.js';
// Typed value contracts. This module has no transport or editor dependencies.
const p=(key,label,type,extra={})=>({key,label,type,...extra});
const uid=p('user_id','QQ 号','user_id',{inherit:'user',optional:true});
const gid=p('group_id','群号','group_id',{inherit:'group',optional:true});
const targets=p('targets','目标用户','user_ids',{inherit:'targets'});
const eventOutputs=[p('chat_type','会话类型','text'),p('chat_id','会话号码','text'),p('chat_key','会话标识','text',{visible:false}),p('group_id','群号','group_id',{optional:true}),p('user_id','发送者 QQ','user_id',{optional:true}),p('time','事件时间','timestamp',{optional:true}),p('text','消息文字','text'),p('message','消息内容','message',{optional:true}),p('message_id','消息 ID','message_id',{optional:true}),p('self_id','机器人 QQ','user_id'),p('sender.nickname','发送者昵称','text',{optional:true}),p('sender.card','群名片','text',{optional:true,visible:false}),p('sender.role','发送者身份','text',{optional:true,visible:false}),p('sender.sex','性别','text',{optional:true,visible:false}),p('sender.age','年龄','number',{optional:true,visible:false}),p('sender.area','地区','text',{optional:true,visible:false}),p('sender.level','等级','text',{optional:true,visible:false}),p('sender.title','专属头衔','text',{optional:true,visible:false}),p('sender','发送人信息','object',{optional:true,visible:false}),p('raw_message','原始消息','text',{optional:true,visible:false}),p('post_type','事件类型','text',{optional:true,visible:false}),p('message_type','消息类型','text',{optional:true,visible:false}),p('sub_type','子类型','text',{optional:true,visible:false}),p('event','完整事件','object',{visible:false})];
const fieldKey=(spec,f)=>spec.type==='mute'&&f.key==='seconds'?'duration':spec.type==='rename_group'&&f.key==='text'?'group_name':spec.type==='rename_card'&&f.key==='text'?'card':spec.type==='special_title'&&f.key==='text'?'special_title':f.key;
const userNodes=new Set(['sender_is','role_is','joined_recently','card_matches','nickname_matches','has_card','target_sender','target_except_sender','switch_user','switch_role','member_info']);
const targeted=new Set(['mute','unmute','kick','rename_card','grant_admin','revoke_admin','special_title','send_at']);
const messageNodes=new Set(['found','not_found','text_match','text_length','contains_any','contains_all','has_link','switch_text']);
export function describeNodePorts(spec){
  if(spec.valuePorts)return {inputs:spec.valuePorts.inputs.map(port=>{const f=spec.fields.find(f=>f.key===port.configKey);return {...(f?{default:f.default,min:f.min,max:f.max,maxLength:f.maxLength,options:f.options,required:!!f.required}:{}),...port};}),outputs:spec.valuePorts.outputs};
  if(spec.trigger){let outputs=eventOutputs.map(x=>({...x}));if(spec.type!=='message'){outputs=outputs.filter(x=>!['message','message_id','sender.sex','sender.age','sender.area','sender.level','sender.title'].includes(x.key));outputs=outputs.map(x=>x.key==='user_id'?{...x,label:'触发用户 QQ'}:x);}
    if(['member_leave','member_muted','member_unmuted','admin_changed'].includes(spec.type))outputs.push(p('operator_id','操作者 QQ','user_id',{optional:true}));
    if(['member_muted','member_unmuted'].includes(spec.type))outputs.push(p('duration','禁言时长','number',{optional:true}));
    if(spec.type==='message_recalled')outputs.push(p('message_id','撤回消息 ID','message_id',{optional:true}));if(spec.type==='group_upload')outputs.push(p('file','文件信息','object',{optional:true}));
    if(spec.type==='join_request')outputs.push(p('comment','申请说明','text',{optional:true}));return {inputs:[],outputs};
  }
  const inputs=spec.fields.map(f=>p(fieldKey(spec,f),f.label,f.dataType??(f.type==='number'?'number':f.type==='boolean'?'boolean':f.ids?(f.key==='groups'?'group_ids':'user_ids'):'text'),{configKey:f.key,default:f.default,required:!!f.required,...(f.min!==undefined?{min:f.min,max:f.max}:{}),...(f.maxLength?{maxLength:f.maxLength}:{}),...(f.options?{options:f.options}:{}),fieldType:f.type}));
  if(!spec.pure){inputs.unshift({...gid,visible:spec.group==='执行'||spec.group==='选择对象'||spec.type==='member_info'});if(targeted.has(spec.type)&&spec.type!=='send_at')inputs.unshift({...uid,label:'操作用户 QQ',targetUser:true});else inputs.unshift({...uid,visible:userNodes.has(spec.type)});inputs.push({...targets,visible:spec.group==='选择对象'||targeted.has(spec.type)||['user_sent','user_not_sent','target_count'].includes(spec.type)});
    if(messageNodes.has(spec.type))inputs.unshift(p('content','待检查文字','text',{inherit:'text'}));
    if(['message_kind','mentions_bot','mentions_users','target_mentions'].includes(spec.type))inputs.unshift(p('message','消息内容','message',{inherit:'message'}));
    if(spec.type==='recall')inputs.unshift(p('message_id','要撤回的消息 ID','message_id',{inherit:'message_id'}));
    if(spec.type==='recall_window')inputs.unshift(p('start_time','窗口起始时间','timestamp',{inherit:'event_time',required:true}));
    if(spec.type==='counter_daily')inputs.unshift(p('at','统计所属时间','timestamp',{inherit:'current_time'}));
  }
  const outputs=[p('group_id','群号','group_id',{visible:false,optional:true}),p('user_id','触发用户 QQ','user_id',{optional:true,visible:false}),p('targets','目标用户','user_ids'),p('count','目标人数','number')];
  if(spec.branch)outputs.unshift(p('result','判断结果','boolean'));if(spec.group==='计数')outputs.unshift(p('value','计数值','number'));if(spec.group==='执行')outputs.unshift(p('success','执行成功','boolean'));
  if(spec.group==='执行')outputs.push(p('completed_at','完成时间','timestamp',{optional:true,visible:spec.type==='kick'}));
  if(spec.type==='recall_window')outputs.unshift(p('recalled','已撤回数量','number'),p('failed','撤回失败数量','number'));
  if(spec.type==='member_info')outputs.unshift(p('member','成员信息','object'),p('nickname','昵称','text'),p('card','群名片','text'),p('role','群身份','text'),p('join_time','入群时间','timestamp',{optional:true}),p('last_sent_time','最后发言时间','timestamp',{optional:true}));
  return {inputs,outputs};
}
export function canBindType(output,input){return output===input||input==='sequence'&&['stream','list','user_ids','group_ids','message'].includes(output)||output==='any'||input==='any'||input==='list'&&['user_ids','group_ids','message'].includes(output);}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export function validateLiteralValue(value){let count=0,bytes=0;const seen=new Set();function visit(item,depth){if(++count>12000||depth>16)throw Error('参数值层级或数量过多');if(item===null)return;if(typeof item==='string'){bytes+=item.length;if(bytes>100000||item.includes('\0'))throw Error('参数内容过长或含无效字符');return;}if(typeof item==='number'){if(!Number.isFinite(item))throw Error('参数数值无效');return;}if(typeof item==='boolean')return;if(typeof item!=='object'||!Array.isArray(item)&&!plain(item)||seen.has(item))throw Error('参数需要有效的 JSON 值');seen.add(item);for(const [key,child]of Object.entries(item)){if(['__proto__','constructor','prototype'].includes(key))throw Error('参数字段无效');bytes+=key.length;visit(child,depth+1);}seen.delete(item);}visit(value,0);return value;}
export function validatePortValue(port,value){
  if(value===null&&port.type==='any')return null;
  if(value===undefined||value===null){if(port.optional||!port.required&&value===undefined)return undefined;throw Error(`${port.label}未提供值`);}
  const type=port.type;let valid=true;
  if(type==='text')valid=typeof value==='string'&&value.length<=(port.maxLength??100000)&&!value.includes('\0');
  else if(type==='boolean')valid=typeof value==='boolean';
  else if(type==='number'||type==='timestamp')valid=typeof value==='number'&&Number.isFinite(value)&&(type!=='timestamp'||value>=0);
  else if(type==='group_id'||type==='user_id')valid=/^[1-9]\d{0,15}$/.test(String(value))&&Number.isSafeInteger(Number(value));
  else if(type==='message_id')valid=/^-?[1-9]\d{0,15}$/.test(String(value))&&Number.isSafeInteger(Number(value));
  else if(['user_ids','group_ids'].includes(type))valid=Array.isArray(value)&&value.length<=1000&&value.every(v=>/^[1-9]\d{0,15}$/.test(String(v))&&Number.isSafeInteger(Number(v)));
  else if(type==='list')valid=Array.isArray(value)&&value.length<=10000;
  else if(type==='stream')valid=isSequence(value);
  else if(type==='sequence')valid=isSequence(value)||Array.isArray(value)&&value.length<=10000;
  else if(type==='message')valid=typeof value==='string'&&value.length<=100000||Array.isArray(value)&&value.length<=1000&&value.every(s=>plain(s)&&typeof s.type==='string');
  else if(type==='object')valid=plain(value);
  if(!valid)throw Error(`${port.label}需要${TYPE_LABELS[type]??type}`);
  if(typeof value==='number'&&(port.min!==undefined&&value<port.min||port.max!==undefined&&value>port.max))throw Error(`${port.label}超出范围`);
  if(['user_id','group_id','message_id'].includes(type))return String(value);if(['user_ids','group_ids'].includes(type))return [...new Set(value.map(String))];return value;
}
export const TYPE_LABELS={stream:'事件流',sequence:'列表或事件流',text:'文字',number:'数值',boolean:'真假值',timestamp:'时间戳（秒）',user_id:'QQ 号',group_id:'群号',message_id:'消息 ID',group_ids:'群号列表',user_ids:'QQ 列表',message:'消息内容',object:'对象',list:'列表',any:'任意值'};
export function ownPath(object,path){const keys=String(path).split('.');if(keys.length>12||keys.some(k=>!k||['__proto__','prototype','constructor'].includes(k)))throw Error('字段路径无效');let value=object;for(const key of keys){if(value==null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
export function readBindingValue(value,port){const normalized=validatePortValue({...port,required:true,optional:false},value);if(port.options&&!port.options.some(o=>o[0]===normalized))throw Error(`${port.label}不在可选值中`);return normalized;}
