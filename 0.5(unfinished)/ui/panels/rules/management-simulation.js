// Rendering only: simulations are executed by the existing dry-run endpoint.
export function renderRunRecord({doc,parent,record,spec,status}){
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  parent.replaceChildren();
  const head=el('div','management-result-heading');head.append(el('strong','',`${record.name} · ${status(record)}`));parent.append(head);
  if(record.error)parent.append(el('p','field-error',record.error));
  for(const warning of record.warnings??[])parent.append(el('p','field-error',warning));
  if(record.dryRun){
    const actions=record.actions??[],summary=el('p','management-result-summary',`预计执行 ${actions.length} 次操作 · 仅模拟，没有发送消息或处理成员`);parent.append(summary);
    if(!actions.length)parent.append(el('p','muted','本次样本没有触发操作。展开执行步骤，可查看在哪一步停止。'));
    const list=el('div','management-action-list');
    for(const [index,item]of actions.entries()){
      const preview=el('div','management-action-preview'),title=spec(item.action)?.label??item.action;
      const target=item.userId?`QQ ${item.userId}`:['recall','recall_window_message'].includes(item.action)?`消息 ${item.messageId}`:record.chatKind==='private'?`私聊 ${record.chatId}`:`群 ${record.groupId??record.chatId}`;
      preview.append(el('small','muted',`${index+1}. ${title} · ${target}`));
      let value=item.value;
      if(item.action==='send_at')value=`@${(item.users??[]).join(' @')} ${value??''}`.trim();
      if(['mute','unmute'].includes(item.action))value=Number(item.seconds)===0?'解除禁言':`禁言 ${item.seconds} 秒`;
      else if(item.action==='kick')value='移出该成员';
      else if(item.action==='recall'||item.action==='recall_window_message')value='撤回这条消息';
      if(value!==undefined&&value!=='')preview.append(el('p','',String(value)));
      list.append(preview);
    }
    parent.append(list);
  }
  const steps=el('details','management-execution-trace'),calculations=el('details','management-calculation-trace');
  const trace=(record.trace??[]).filter(item=>item.status!=='running');
  steps.append(el('summary','',`执行步骤 · ${trace.filter(item=>!spec(item.type)?.pure).length} 步`));calculations.append(el('summary','','计算过程'));let calculationCount=0;
  for(const item of trace){
    const row=el('div','management-trace',`${item.iterationPath?'第 '+item.iterationPath.join('.')+' 项 · ':''}${item.label} · ${{done:'✓',skipped:'跳过',failed:'失败',cancelled:'已取消'}[item.status]??item.status} ${item.detail??''}`);
    if(spec(item.type)?.pure){calculationCount++;calculations.append(row);}else steps.append(row);
  }
  if(calculationCount)steps.append(calculations);parent.append(steps);
}
