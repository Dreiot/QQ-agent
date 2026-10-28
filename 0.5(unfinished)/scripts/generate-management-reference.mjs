import fs from 'node:fs';
import path from 'node:path';
import {NODE_CATALOG} from '../src/management/catalog.js';
import {TYPE_LABELS} from '../src/management/ports.js';
const root=path.resolve(import.meta.dirname,'..');
let text=`# 规则节点目录\n\n目录包含 ${NODE_CATALOG.length} 种节点，其中 ${NODE_CATALOG.filter(node=>!node.legacy).length} 种显示在默认库；其余只兼容已有规则。圆形接口控制下一步执行什么，方形接口把一项数据交给另一个参数。需要参数时可填写，也可连线，不要求每个接口都接线。\n\n参数优先使用连线，其次使用手动填写的值；没有指定时才使用节点设置、自动来源或默认值。连线来源本轮没有执行时会报错，不会退回自动来源；“缺省值”节点可以显式处理缺失。\n\n自动来源并不是“前一个节点的同名字段”。群号、事件相关 QQ、消息和事件时间默认来自启动这一轮的事件；本节点另行指定时，只改变本节点。待处理成员沿执行路径传递：选人节点可以改变名单，多路实际到达同一节点时去重合并。普通节点指定的处理名单只影响本节点。计算节点默认读取本轮触发资料；要使用选人结果或循环当前项，请明确连接相应数据输出。\n\n`;
let category;
for(const spec of NODE_CATALOG){
  if(category!==spec.category){category=spec.category;text+=`## ${category??spec.group}\n\n`;}
  text+=`### ${spec.label}\n\n${spec.description}${spec.legacy?'（兼容节点，不显示在默认库。）':''}\n\n- 执行方式：${spec.pure?'按需计算，不接执行线':spec.trigger?'由对应事件或定时器启动':spec.loop?'每项进入循环区域，完成后继续主流程':spec.terminal?'到此结束':spec.branch?'是 / 否分支':spec.routeKind?'匹配项 / 其他分支':'沿执行输出继续'}\n- 例如：${spec.example}\n\n`;
  for(const direction of ['inputs','outputs']){const ports=spec.ports[direction];if(!ports.length)continue;text+=`| ${direction==='inputs'?'使用的参数':'可提供的结果'} | 字段 | 类型 | 用途与来源 |\n| --- | --- | --- | --- |\n`;for(const port of ports){const detail=[port.description,port.example?'例如：'+port.example:'',direction==='inputs'&&port.required?'需要提供有效值，可填写或连线':'',port.optional?'可能没有此值':'',port.visible===false?'画布默认收起':''].filter(Boolean).join('；').replaceAll('|','\\|').replaceAll('\n','<br>');text+=`| ${port.label} | \`${port.key}\` | ${TYPE_LABELS[port.type]} | ${detail} |\n`;}text+='\n';}
  if(spec.fields.length){text+='| 参数 | 默认值或要求 |\n| --- | --- |\n';for(const field of spec.fields)text+=`| ${field.label} | ${String(field.default??(field.required?'必填':'可选')).replaceAll('|','\\|')} |\n`;text+='\n';}
}
fs.writeFileSync(path.join(root,'docs/group-management-node-reference.md'),text);
