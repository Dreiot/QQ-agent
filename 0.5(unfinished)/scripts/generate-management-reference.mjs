import fs from 'node:fs';
import path from 'node:path';
import {NODE_CATALOG} from '../src/management/catalog.js';
import {TYPE_LABELS} from '../src/management/ports.js';
const root=path.resolve(import.meta.dirname,'..');
let text=`# 群管理节点目录\n\n目录包含 ${NODE_CATALOG.length} 种节点，其中 ${NODE_CATALOG.filter(node=>!node.legacy).length} 种显示在默认库；其余只兼容已有规则。执行线控制运行顺序，数据线连接独立字段。自动 / 已填不需要额外连线；必填可手动填写或连线。\n\n`;
let category;
for(const spec of NODE_CATALOG){
  if(category!==spec.category){category=spec.category;text+=`## ${category??spec.group}\n\n`;}
  text+=`### ${spec.label}\n\n${spec.description}${spec.legacy?'（兼容节点，不显示在默认库。）':''}\n\n- 执行方式：${spec.pure?'按需计算，不接执行线':spec.trigger?'由对应事件或定时器启动':spec.loop?'每项进入循环区域，完成后继续主流程':spec.terminal?'到此结束':spec.branch?'是 / 否分支':spec.routeKind?'匹配项 / 其他分支':'沿执行输出继续'}\n- 例如：${spec.example}\n\n`;
  for(const direction of ['inputs','outputs']){const ports=spec.ports[direction];if(!ports.length)continue;text+=`| ${direction==='inputs'?'数据输入':'数据输出'} | 字段 | 类型 | 说明 |\n| --- | --- | --- | --- |\n`;for(const port of ports)text+=`| ${port.label} | \`${port.key}\` | ${TYPE_LABELS[port.type]} | ${[port.inherit?'自动沿用当前流程，无需连线':'',port.configKey?'可手动设置':'',port.required?'需要值，可填可连':'',port.optional?'允许缺失':'',port.visible===false?'默认收起':''].filter(Boolean).join('；')} |\n`;text+='\n';}
  if(spec.fields.length){text+='| 参数 | 默认值或要求 |\n| --- | --- |\n';for(const field of spec.fields)text+=`| ${field.label} | ${String(field.default??(field.required?'必填':'可选')).replaceAll('|','\\|')} |\n`;text+='\n';}
}
fs.writeFileSync(path.join(root,'docs/group-management-node-reference.md'),text);
