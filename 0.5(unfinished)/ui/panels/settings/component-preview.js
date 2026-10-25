import { createIcon,ICON_NAMES } from '../icons.js';
import { bindDestructiveAction } from '../destructive-action.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';

let previewSequence = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A local specimen, independent of configuration and business requests. */
export function renderComponentPreview(parent) {
  const prefix = `component-preview-${++previewSequence}`;
  const gallery = node('section', 'setting-field full component-preview');
  gallery.setAttribute('aria-label', '组件外观预览');
  const header = node('div', 'component-preview-head');
  const title = node('h4', '', '实时预览');
  const caption = node('p', 'field-hint', '仅示例');caption.title='此处的操作只预览控件外观';
  header.append(title, caption);

  const buttons = node('div', 'component-preview-actions actions');
  buttons.setAttribute('role', 'group');
  buttons.setAttribute('aria-label', '按钮示例');
  const feedback = node('output', 'component-preview-feedback visually-hidden');
  feedback.setAttribute('role', 'status');
  feedback.textContent = '0 次示例交互';
  let presses = 0;
  for (const [label, kind, icon] of [
    ['主按钮', 'primary', 'check'],
    ['次按钮', '', 'refresh'],
    ['危险按钮', 'danger', 'trash'],
    ['禁用按钮', '', 'check'],
  ]) {
    const control = node('button', kind);
    control.type = 'button';
    control.append(createIcon(icon), node('span', '', label));
    control.disabled = label === '禁用按钮';
    const interact=() => {
      feedback.textContent = `${++presses} 次示例交互 · ${label}`;
    };
    if(kind==='danger')bindDestructiveAction(control,{action:interact,clicks:2,target:()=>gallery,impact:'仅演示：连续点击两次后更新示例计数，不会删除任何数据。'});
    else control.addEventListener('click',interact);
    buttons.append(control);
  }

  const samples = node('div', 'component-preview-controls');
  const checkLabel = node('label', 'component-preview-check');
  const check = node('input');
  check.type = 'checkbox'; check.checked = true;
  const checkedState = node('span', '', '示例开关');
  checkLabel.append(check, checkedState);

  const rangeLabel = node('label', 'setting-field');
  const rangeTitle = node('span', 'field-title', '示例调节');
  const range = node('input');
  range.type = 'range'; range.min = '0'; range.max = '100'; range.value = '64';
  range.id = `${prefix}-range`;
  const readout = node('output', 'component-preview-value', '64%');
  readout.htmlFor = range.id;
  range.addEventListener('input', () => { readout.textContent = `${range.value}%`; });
  rangeLabel.append(rangeTitle, range, readout);

  const selectLabel = node('label', 'setting-field');
  const selectTitle = node('span', 'field-title', '示例模式');
  const select = node('select');
  for (const text of ['标准', '紧凑', '宽松']) select.append(new Option(text, text));
  selectLabel.append(selectTitle, select);

  const inputLabel = node('label', 'setting-field');
  const inputTitle = node('span', 'field-title', '示例文字');
  const input = node('input');
  input.type = 'text'; input.placeholder = '输入文字，查看排版'; input.maxLength = 120;
  input.autocomplete = 'off';
  inputLabel.append(inputTitle, input);
  samples.append(checkLabel, rangeLabel, selectLabel, inputLabel);

  const specimens = node('div', 'component-preview-specimens');
  const type = node('div', 'component-preview-type');
  type.append(node('small', 'component-preview-caption', '文字与数字'));
  const specimenTitle = node('div', 'component-preview-type-title', '系统已就绪');
  type.append(specimenTitle, node('span', 'component-preview-digits', '128.00 · 64%'));
  input.addEventListener('input', () => { specimenTitle.textContent = input.value || '系统已就绪'; });

  const indicators = node('div', 'component-preview-indicators');
  const badges = node('div', 'component-preview-badges');
  for (const [label, state] of [['就绪', 'good'], ['等待', 'warn'], ['异常', 'bad']]) {
    badges.append(node('span', `badge ${state}`, label));
  }
  const icons = node('div', 'component-preview-icons');
  icons.setAttribute('role', 'group'); icons.setAttribute('aria-label', '主题图标示例');
  for (const [name, label] of [['plugins', '扩展'], ['activity', '运行'], ['archive', '存档'], ['refresh', '刷新'], ['check', '确认']]) {
    const sample = node('span', 'component-preview-icon');
    sample.title = label;
    sample.setAttribute('aria-label',label);sample.append(createIcon(name));
    icons.append(sample);
  }
  indicators.append(badges, icons);
  specimens.append(type, indicators);
  const previewDialog=node('button','','预览弹窗');previewDialog.type='button';previewDialog.prepend(createIcon('panel',{size:16}));previewDialog.addEventListener('click',()=>{
    const dialog=node('dialog','component-sample-dialog'),heading=node('h3','','弹窗预览'),body=node('div','card','示例内容'),close=node('button','','完成');close.type='button';close.addEventListener('click',()=>dialog.close());dialog.append(heading,body,close);installDisposableDialog(dialog);document.body.append(dialog);dialog.showModal();
  });buttons.append(previewDialog);
  const browser=node('details','component-icon-browser'),summary=node('summary','','图标一览'),grid=node('div','component-icon-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label','全部图标预览');
  for(const name of ICON_NAMES){const pick=node('button');pick.type='button';pick.title=name;pick.setAttribute('aria-label',`预览图标 ${name}`);pick.setAttribute('aria-pressed','false');pick.append(createIcon(name));pick.addEventListener('click',()=>{for(const item of grid.children){item.setAttribute('aria-pressed',String(item===pick));item.dataset.iconActive=String(item===pick);}});grid.append(pick);}
  browser.append(summary,grid);gallery.append(header, specimens, buttons, feedback, samples,browser);
  parent.append(gallery);
  return gallery;
}
