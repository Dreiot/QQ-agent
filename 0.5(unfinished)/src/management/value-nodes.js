import {ownPath} from './ports.js';
const field=(key,label,type,extra={})=>({key,label,type,...extra});
const pin=(key,label,type,extra={})=>({key,label,type,...extra});
const value=(type,label,fields,inputs,outputs,description,example)=>({type,label,group:'数据',category:'数据运算',pure:true,fields,valuePorts:{inputs,outputs},description,example,inputHint:'按数据连线取值，不需要执行线',outputHint:'按需计算结果；连接到下游的数据输入',featured:true});
export const VALUE_NODES=[
  value('format_text','填充文字模板',[field('template','文字模板','multiline',{default:'{{a}}',required:true,maxLength:2000})],[pin('template','文字模板','text',{configKey:'template'}),...['a','b','c','d'].map(key=>pin(key,'变量 '+key,'any',{optional:true}))],[pin('text','完整文字','text')],'用 {{a}}、{{b}}、{{c}}、{{d}} 填充文字；模板用到的变量必须提供值，支持数值和 QQ 号。不会执行代码。','商品 {{a}}，数量 {{b}}，总额 {{c}}；也可组合记录、日期或通知文字'),
  value('value_text','文字值',[field('value','文字','text',{default:''})],[pin('value','文字','text',{configKey:'value'})],[pin('value','文字','text')],'提供一段固定文字，也可以接入其他文字作为转接值。','文字值“广告” → 文字比较'),
  value('value_number','数值',[field('value','数值','number',{min:-1e12,max:1e12,default:600})],[pin('value','数值','number',{configKey:'value'})],[pin('value','数值','number')],'提供一个数值，可用于时长、次数和数值比较。','数值 600 → 禁言时长'),
  value('value_bool','真假值',[field('value','值','boolean',{default:true})],[pin('value','值','boolean',{configKey:'value'})],[pin('value','真假值','boolean')],'提供“是”或“否”，可接入条件分支。','真假值“是” → 条件分支'),
  value('message_text','提取消息文字',[],[pin('message','消息内容','message',{inherit:'message'})],[pin('text','文字','text'),pin('only_text','只含文字','boolean')],'从消息段取出文字部分；图片、语音等片段不会被拼成文字。','群消息的消息内容 → 提取文字 → 检查关键词'),
  value('data_field','读取字段',[field('path','字段路径','text',{default:'sender.nickname',required:true,maxLength:120})],[pin('object','对象','object',{inherit:'event'}),pin('path','字段路径','text',{configKey:'path'})],[pin('value','字段值','any',{optional:true})],'读取对象的嵌套字段，如 sender.nickname；缺失字段产生空值，可接“缺省值”。','完整事件 → 读取 sender.nickname → 拼接文字'),
  value('default_value','缺省值',[field('fallback','缺省文字','text',{default:'未提供'})],[pin('value','原值','any',{optional:true,allowMissing:true}),pin('fallback','缺省值','any',{configKey:'fallback'})],[pin('value','结果','any')],'原值为空时使用缺省值；可处理协议端未提供的昵称等字段。','昵称 → 缺省值“新朋友” → 欢迎消息'),
  value('text_join','拼接文字',[field('a','前段文字','text',{default:'欢迎 '}),field('b','后段文字','text',{default:''})],[pin('a','前段文字','text',{configKey:'a'}),pin('b','后段文字','text',{configKey:'b'})],[pin('text','拼接结果','text')],'将两段文字按顺序连接，可接昵称、消息文字或其他计算结果。','“欢迎 ” + 发送者昵称 → 发送群消息'),
  value('number_compare','数值比较',[field('a','左值','number',{min:-1e12,max:1e12,default:0}),field('operator','比较','select',{options:[['gte','≥'],['gt','>'],['eq','='],['lt','<'],['lte','≤'],['ne','≠']],default:'gte'}),field('b','右值','number',{min:-1e12,max:1e12,default:3})],[pin('a','左值','number',{configKey:'a'}),pin('operator','比较方式','text',{configKey:'operator'}),pin('b','右值','number',{configKey:'b'})],[pin('result','比较结果','boolean')],'比较两个数值，输出真假值；只计算结果，不直接执行管理动作。','计数值 ≥ 3 → 条件分支'),
  value('time_format','格式化时间',[field('format','显示格式','select',{options:[['datetime','日期与时间'],['date','日期'],['time','时间']],default:'datetime'})],[pin('time','时间戳（秒）','timestamp',{inherit:'time'}),pin('format','显示格式','text',{configKey:'format'})],[pin('text','时间文字','text')],'把秒单位时间戳转换为本机时区的可读文字。','发送时间 → 格式化时间 → 拼接日志'),
  value('list_count','列表长度',[],[pin('list','列表','list',{default:[]})],[pin('count','数量','number')],'计算列表元素个数，支持用户列表与消息段列表。','目标用户列表 → 数量 → 数值比较'),
];
export function evaluateValueNode(node,inputs){
  switch(node.type){
    case 'format_text':return {text:inputs.template.replace(/\{\{([a-d])\}\}/g,(_token,key)=>{const value=inputs[key];if(value===undefined||value===null)throw Error(`模板变量 ${key} 必须填写或连接`);if(!['string','number','boolean'].includes(typeof value))throw Error(`模板变量 ${key} 需要文字、数值或真假值`);return String(value);})};
    case 'value_text':case 'value_number':case 'value_bool':return {value:inputs.value};
    case 'message_text':return {only_text:Array.isArray(inputs.message)?inputs.message.length>0&&inputs.message.every(s=>s.type==='text'):! /\[CQ:/.test(String(inputs.message??'')),text:Array.isArray(inputs.message)?inputs.message.filter(s=>s.type==='text').map(s=>s.data?.text??s.text??'').join(''):String(inputs.message??'').replace(/\[CQ:[^\]]*\]/g,'').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&#44;/g,',').replace(/&amp;/g,'&')};
    case 'data_field':return {value:ownPath(inputs.object,inputs.path)};
    case 'default_value':return {value:inputs.value===undefined||inputs.value===null?inputs.fallback:inputs.value};
    case 'text_join':return {text:inputs.a+inputs.b};
    case 'number_compare':return {result:({gte:()=>inputs.a>=inputs.b,gt:()=>inputs.a>inputs.b,eq:()=>inputs.a===inputs.b,lt:()=>inputs.a<inputs.b,lte:()=>inputs.a<=inputs.b,ne:()=>inputs.a!==inputs.b})[inputs.operator]()};
    case 'time_format':{const date=new Date(inputs.time*1000);if(!Number.isFinite(date.getTime()))throw Error('时间戳超出日期范围');const part=n=>String(n).padStart(2,'0'),day=`${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}`,time=`${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;return {text:inputs.format==='date'?day:inputs.format==='time'?time:`${day} ${time}`};}
    case 'list_count':return {count:inputs.list.length};
    default:throw Error('数据节点尚无计算器');
  }
}
