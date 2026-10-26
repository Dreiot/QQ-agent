export function inScope(rule,node,scope){let current=node.scope;for(let i=0;i<8&&current;i++){if(current===scope)return true;current=rule.nodes.find(n=>n.id===current)?.scope;}return false;}
export function scopeLinkIssue(rule,source,target,port,output){
  if(port==='each')return target.scope===source.id?'':'每项出口只能连接到属于该循环的节点';
  if(port)return (source.scope??null)===(target.scope??null)?'':'执行线不能跨越循环范围';
  if(output?.iterationOnly&&!inScope(rule,target,source.id))return '当前项与序号只能在该循环内使用';
  if(source.scope&&!inScope(rule,target,source.scope))return '循环内的数据不能直接传到外部，请使用循环的汇总输出';
  return '';
}
