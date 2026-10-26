// User-visible navigation for business regressions after the settings page
// adopted purpose-based sections and automatic saving. No force clicks or DOM mutation.
const canonical=id=>({wake:'chat',send:'chat',active:'chat',blocklist:'chat',reset:'desktop',data:'desktop',interface:'desktop',updates:'desktop',prices:'models',uikit:'appearance'}[id]||id);
export async function closeSettingsEditors(frame){
  for(const dialog of (await frame.locator('dialog[data-settings-editor][open]').all()).reverse())await dialog.locator('.settings-dialog-head button').click();
}
export async function openSettingsFold(frame,key){
  const fold=frame.locator(`details[data-settings-group="${key}"]`);
  await fold.evaluate(async node=>{await Promise.allSettled(node.getAnimations().map(animation=>animation.finished));});
  if(!await fold.evaluate(node=>node.open))await fold.locator(':scope > summary').click();
  await fold.evaluate(async node=>{await Promise.allSettled(node.getAnimations().map(animation=>animation.finished));});
}
export async function settingsSection(frame,id){
  await closeSettingsEditors(frame);
  await frame.locator(`#settings-sidebar a[data-target="${canonical(id)}"]`).click();
  if(id==='uikit')for(const key of ['advanced','preview']){const group=frame.locator(`details[data-appearance-group="${key}"]`);if(await group.count()&&!await group.evaluate(n=>n.open))await group.locator(':scope>summary').click();}
  const fold={wake:'activity',send:'send',active:'proactive',reset:'data',data:'data',interface:'desktop-interface',updates:'desktop-update',prices:'prices'}[id];if(fold)await openSettingsFold(frame,`layout-${fold}`);
}
export async function settingsEditor(frame,id){
  if(id==='model-config'){await settingsSection(frame,'models');return frame.locator('.model-config-layout');}
  if(id==='appearance'){await settingsSection(frame,'appearance');return frame.locator('#section-appearance');}
  const owner={'model-config':'models','model-manager':'models','search-source':'search','search-manager':'search','tier-params':'chat','global-persona':'persona',appearance:'desktop','prompt-preview':'persona'}[id];
  await settingsSection(frame,id==='appearance'?'interface':owner);await frame.locator(`[data-settings-open="${id}"]`).click();
  return frame.locator(`dialog[data-settings-editor="${id}"]`);
}
export async function settingsProvider(frame,id,{advanced=false}={}){
  await frame.locator(`#provider-manager-nav button[data-provider-id="${id}"]`).click();
  if(advanced&&await frame.locator(`details[data-settings-group="provider-actions-${id}"]`).count())await openSettingsFold(frame,`provider-actions-${id}`);
  return frame.locator(`#provider-list > article[data-provider-id="${id}"]`);
}
export async function settingsPickModel(frame,kind,provider,model){
  const label={main:'从目录选择主模型',vision:'选择图片模型',video:'选择视频模型',memory:'选择整理专用模型'}[kind];
  await frame.getByRole('button',{name:label,exact:true}).click();const picker=frame.locator('dialog.model-picker');await picker.locator(`nav [data-provider-id="${provider}"]`).click();await picker.locator(`button[data-model-id="${model}"]`).click();await picker.waitFor({state:'detached'});
}
export async function settingsSave(frame){
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
}
export async function settingsReload(frame){
  const editor=frame.locator('dialog[data-settings-editor][open]').last();
  if(await editor.count()&&await editor.locator('[data-settings-reload]').count())await editor.locator('[data-settings-reload]').click();
  else await frame.locator('#reload').click();
}
export async function settingsBlocklist(frame){await settingsSection(frame,'chat');}
export async function settingsControl(frame,selector){
  const control=frame.locator(selector);
  const owner=await control.evaluate(el=>{
    const parking=el.closest('.settings-editor-parking'),dialog=el.closest('dialog[data-settings-editor]');
    return{editor:dialog?.dataset.settingsEditor||parking?.parentElement.querySelector('[data-settings-open]')?.dataset.settingsOpen,section:el.closest('#fields > .settings-section')?.id.replace(/^section-/,'')};
  });
  if(owner.editor&&!await frame.locator(`dialog[data-settings-editor="${owner.editor}"][open]`).count())await settingsEditor(frame,owner.editor);
  else if(!owner.editor&&owner.section&&!await frame.locator(`#settings-sidebar a[data-target="${owner.section}"].is-active`).count())await settingsSection(frame,owner.section);
  const folds=await control.evaluate(el=>{const keys=[];for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&parent.dataset.settingsGroup)keys.unshift(parent.dataset.settingsGroup);return keys;});
  for(const key of folds)await openSettingsFold(frame,key);
  return control;
}
