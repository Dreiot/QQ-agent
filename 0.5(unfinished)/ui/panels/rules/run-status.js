export function ruleRunStatus(record){
  if(record.status==='running')return '处理中';
  const effects=Number.isInteger(record.effectCount)?record.effectCount:null;
  if(record.status==='done')return effects===0?'未执行操作':effects===null?'流程结束':'已执行';
  if(record.status==='failed')return effects>0?'部分完成':'执行失败';
  if(record.status==='cancelled')return effects>0?'已停止 · 已执行部分操作':'已停止';
  return record.status??'';
}
