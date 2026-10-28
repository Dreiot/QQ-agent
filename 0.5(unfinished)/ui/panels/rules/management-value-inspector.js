import {allValuePorts,visibleValuePorts,VALUE_TYPE_LABELS,VALUE_COLORS} from './management-values.js';
import {inputSource} from './management-sources.js';

export function renderValueInspector({doc,parent,rule,node,catalog,controls,record,onChange,onVisibility,onError}){
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},spec=catalog.find(s=>s.type===node.type),sections=[];
  const button=(text,action,cls='')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
  const filter=el('input','management-value-filter');filter.type='search';filter.placeholder='查找参数、结果或用途';filter.setAttribute('aria-label','查找节点字段');
  let searching=false;
  filter.addEventListener('input',()=>{const query=filter.value.trim().toLowerCase();for(const box of sections){if(query&&!searching)box.dataset.wasOpen=String(box.open);let matches=0;box.querySelectorAll('.management-value-field').forEach(row=>{const matched=!query||row.dataset.search.toLowerCase().includes(query);row.hidden=!matched;if(matched)matches++;const info=row.querySelector('.management-value-explanation');if(query&&matched){if(info.dataset.wasOpen===undefined)info.dataset.wasOpen=String(info.open);info.open=true;}else if(!query&&info.dataset.wasOpen!==undefined){info.open=info.dataset.wasOpen==='true';delete info.dataset.wasOpen;}});if(query){box.open=matches>0;box.hidden=!matches;}else{box.hidden=false;if(box.dataset.wasOpen!==undefined)box.open=box.dataset.wasOpen==='true';delete box.dataset.wasOpen;}}searching=!!query;});parent.append(filter);
  function section(label,open=true,container=parent){const box=el('details','management-value-section');box.open=open;box.append(el('summary','',label));container.append(box);sections.push(box);return box;}
  function header(port,direction){
    const head=el('div','management-value-field-head');head.style.setProperty('--value-color',VALUE_COLORS[port.type]);head.append(el('strong','',port.label),el('small','management-value-type',VALUE_TYPE_LABELS[port.type]));
    const shown=visibleValuePorts(rule,node,catalog,direction).some(p=>p.key===port.key),connected=direction==='inputs'?!!node.bindings?.[port.key]:rule.nodes.some(n=>Object.values(n.bindings??{}).some(b=>b.nodeId===node.id&&b.port===port.key)),check=el('input');
    check.type='checkbox';check.checked=shown;check.disabled=connected;check.setAttribute('aria-label',`在画布显示${direction==='inputs'?'输入':'输出'} ${port.label}`);check.title=connected?'已有连线，保持显示':'在画布显示这个接口';check.addEventListener('change',()=>onVisibility(direction,port.key,check.checked));head.append(check);return head;
  }
  function field(port,direction,box){
    const row=el('div','management-value-field');row.dataset[direction==='inputs'?'inputKey':'outputKey']=port.key;row.dataset.search=[port.label,port.key,port.description,port.example,VALUE_TYPE_LABELS[port.type]].filter(Boolean).join(' ');row.title=port.description??'';
    row.append(header(port,direction));box.append(row);return row;
  }
  function explanation(port,row,source){const info=el('details','management-value-explanation');info.append(el('summary','','用途与取值说明'));if(port.description)info.append(el('p','management-value-description',port.description));if(source?.detail)info.append(el('p','management-input-help',source.detail));if(port.example)info.append(el('small','management-value-example','例如：'+port.example));info.append(el('code','management-value-key','字段名：'+port.key+(port.optional?' · 可能缺失':'')));row.append(info);return info;}
  function manual(port,row){
    const existing=controls.get(port.configKey);if(existing&&!Object.hasOwn(node.values??{},port.key)){const label=existing.querySelector('span');if(label)label.hidden=true;existing.querySelector('input,textarea,select')?.setAttribute('aria-label',port.label);row.append(existing);return;}
    existing?.remove();const value=node.values?.[port.key];let control;
    if(port.options||port.type==='boolean'){
      control=el('select');const options=port.options??[[true,'是'],[false,'否']];for(const [v,title]of [['','使用默认值'],...options]){const option=el('option','',title);option.value=String(v);control.append(option);}control.value=value===undefined?'':String(value);
    }else{
      control=el(['object','list','message','sequence'].includes(port.type)?'textarea':'input');if(control.tagName==='INPUT')control.type=['number','timestamp'].includes(port.type)?'number':'text';control.value=value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
      if(port.type==='stream'){control.disabled=true;control.placeholder='在画布连接事件流';}else control.placeholder=port.targetUser?'输入单个 QQ；留空按成员名单':port.inherit?'留空恢复自动来源':'输入固定值';
    }
    control.setAttribute('aria-label','参数 '+port.label);control.addEventListener('change',()=>{
      try{let next=control.value;if(next==='')next=undefined;else if(port.options)next=port.options.find(([key])=>String(key)===next)?.[0];else if(['number','timestamp'].includes(port.type))next=Number(next);else if(port.type==='boolean')next=next==='true';else if(['user_ids','group_ids'].includes(port.type))next=next.split(/[\s,，]+/).filter(Boolean);else if(port.type==='any'){try{next=JSON.parse(next);}catch{}}else if(['object','list','message','sequence'].includes(port.type))next=JSON.parse(next);onChange(port,next,'value');}catch(error){onError(error);}
    });row.append(control);
  }
  const inputs=allValuePorts(node,catalog,'inputs');if(inputs.length){const box=section(`参数 · 本节点使用什么 · ${inputs.length}`),extra=inputs.filter(p=>p.visible===false&&!node.bindings?.[p.key]&&!Object.hasOwn(node.values??{},p.key)),extraBox=extra.length?section(`更多参数 · ${extra.length}`,false):null;for(const port of inputs){
    const row=field(port,'inputs',extra.includes(port)?extraBox:box),source=inputSource(rule,node,catalog,port),binding=node.bindings?.[port.key],line=el('div',binding?'management-value-binding':'management-value-origin');line.dataset.requirement=source.kind;line.title=source.detail;line.append(el('small','management-source-kind',source.label),el('span','management-source-text',source.text));row.dataset.search+=' '+source.text;
    if(binding){
      const disconnect=button('×',()=>onChange(port,null,'binding'),'management-value-disconnect');disconnect.title='断开此参数的连线';disconnect.setAttribute('aria-label','断开连线 '+port.label);line.append(disconnect);controls.get(port.configKey)?.remove();
      const preview=record?.values?.[binding.nodeId]?.[binding.port];if(preview!==undefined)row.append(el('output','management-value-preview','上次试运行：'+preview));
    }
    row.append(line);
    if(!binding){
      if(source.kind==='auto'||source.kind==='optional'){
        const editor=el('div','management-manual-editor');editor.hidden=true;manual(port,editor);const edit=button('改用固定值',()=>{editor.hidden=!editor.hidden;edit.textContent=editor.hidden?'改用固定值':'取消填写';edit.setAttribute('aria-expanded',String(!editor.hidden));if(!editor.hidden)editor.querySelector('input,textarea,select')?.focus();},'management-source-edit');edit.setAttribute('aria-expanded','false');line.append(edit);row.append(editor);
      }else manual(port,row);
      if(Object.hasOwn(node.values??{},port.key))row.append(button(port.inherit?'恢复自动来源':'恢复默认值',()=>onChange(port,undefined,'value'),'management-source-reset'));
    }
    explanation(port,row,source);
  }}
  const outputs=allValuePorts(node,catalog,'outputs');if(outputs.length){const usedPorts=outputs.filter(port=>rule.nodes.some(n=>Object.values(n.bindings??{}).some(b=>b.nodeId===node.id&&b.port===port.key))),box=section(`结果 · 可传给下一步 · ${outputs.length}${usedPorts.length?' · 已连接 '+usedPorts.length:''}`,!inputs.length||!!spec.pure),extra=outputs.filter(p=>p.visible===false&&!usedPorts.includes(p)),extraBox=extra.length?section(`其他结果 · ${extra.length}`,false):null;for(const port of outputs){
    const row=field(port,'outputs',extra.includes(port)?extraBox:box),info=explanation(port,row);if(port.iterationOnly)info.append(el('small','management-input-help','只在这个循环的“每项”路径中使用；循环结束后使用处理项数等汇总结果。'));if(port.optional)info.append(el('small','management-input-help','事件可能没有提供此项；可接“缺省值”设置备用内容。'));
    const preview=record?.values?.[node.id]?.[port.key];if(preview!==undefined)row.append(el('output','management-value-preview',preview));
  }}
  if(spec.pure)parent.append(el('small','muted','连接到其他节点的参数后才计算，不会自行发送消息或处理成员。'));
}
