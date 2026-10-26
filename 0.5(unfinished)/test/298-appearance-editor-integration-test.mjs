// User-visible controls must edit the same complete theme that reaches shell,
// isolated panels, disk and named schemes. No current preview data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {PERSONALIZATION_FIELDS as fields,PERSONALIZATION_GROUPS as groups,DEFAULT_THEME,resolveScheme} from '../ui/panels/theme.js';

const evidence=path.resolve('.qa-local/appearance-editor-20261023');fs.mkdirSync(evidence,{recursive:true});
const checks=[];
const record=label=>{checks.push(label);console.log(`✓ 298 ${label}`);};
const until=async(read,accept,label)=>{for(let i=0;i<140;i++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(label);};
const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark'}}}});
const {page,frame}=qa;
const current=()=>resolveScheme(qa.disk().ui.uikit);
const row=key=>frame.locator(`.personalization-field[data-personalization-key="${key}"]`);
const field=key=>frame.locator(`#field-uikit-${key}`);
const auto=spec=>row(spec.key).getByRole('switch',{name:`${spec.label}自动`,exact:true});
const openGroup=async key=>{
  const advanced=frame.locator('details[data-appearance-group="advanced"]');if(!await advanced.evaluate(n=>n.open))await advanced.locator(':scope>summary').click();
  const group=frame.locator(`details[data-appearance-group="personal-${key}"]`);
  if(!await group.evaluate(element=>element.open))await group.locator(':scope>summary').click();
  await group.waitFor({state:'visible'});return group;
};
const settle=async()=>{
  await frame.locator('body').evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
  await page.locator('.rail').evaluate(async rail=>{await Promise.allSettled(rail.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
};
const saved=async expected=>{
  await until(current,scheme=>Object.entries(expected).every(([key,value])=>scheme[key]===value),'appearance values did not reach disk: '+Object.keys(expected).join(', '));
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
};
async function edit(spec,value){
  await openGroup(spec.group);
  if(spec.type==='range'){
    if(spec.autoValue!==undefined&&await auto(spec).getAttribute('aria-checked')==='true')await auto(spec).click();
    await frame.locator(`#field-uikit-${spec.key}-number`).fill(String(value*(spec.displayScale||1)));
  }else if(spec.type==='color'){
    if(await auto(spec).getAttribute('aria-checked')==='true')await auto(spec).click();
    // Native color pickers have no portable headless OS dialog; exercise their
    // real input/change binding with a valid native value in this fixture.
    await field(spec.key).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);
  }else if(spec.type==='select'){
    await row(spec.key).locator(`[role=radio][data-value="${value}"]`).click();
  }else if(spec.type==='font')await field(spec.key).fill(value);else await field(spec.key).setChecked(value);
}
async function mode(value){
  const owner=frame.locator('.setting-field:has(#field-ui-uikit-mode)');
  if(await owner.locator(`[role=radio][data-value="${value}"]`).count())await owner.locator(`[role=radio][data-value="${value}"]`).click();
  else await frame.locator('#field-ui-uikit-mode').selectOption(value);
}
const edits={fontFamily:'humanist',fontSize:14,fontWeight:500,headingWeight:700,headingScale:1.05,lineHeight:1.7,letterSpacing:.1,codeFontSize:12,radiusButton:10,radiusInput:9,radiusCard:12,radiusDialog:14,buttonShape:'round',borderWidth:1.5,shadowStrength:1.1,shadowBlur:36,controlHeight:40,controlFontSize:13,controlFontWeight:700,inputFontSize:14,choiceSize:16,rangeHeight:22,buttonPaddingX:13,buttonPaddingY:8,inputPaddingX:13,inputPaddingY:8,sidebarWidth:240,rail:'#202324',settingsSidebarWidth:190,navigationFontSize:14,navigationHeight:48,navigationIconScale:1.05,navigationGap:6,topbarHeight:48,pagePadding:18,cardPadding:18,listGap:14,tablePaddingX:14,tablePaddingY:10,tableFontSize:13,scrollbarWidth:7,dialogWidth:600,dialogPadding:26,overlayOpacity:.55,backdropBlur:2,hoverColor:'#416b63',selectedColor:'#615c85',focusColor:'#aabb88',hoverTint:12,selectedTint:14,focusWidth:2.5,hoverLift:1.5,disabledOpacity:.5,iconSize:22,iconStroke:2,iconMotionScale:1.2,iconMotionSpeed:1.2,iconMotionEnabled:false,motionDuration:1.1,motionScale:1.1,interfaceMotionEnabled:false};

Object.assign(edits,{rippleEnabled:false,rippleColor:'#27a8cb',rippleSpread:18,rippleSpeed:1.75});
Object.assign(edits,{brandIconSize:44,brandMotionSpeed:.5,bodyFont:'微软雅黑',titleFont:'Georgia',codeFont:'Consolas'});

try{
  await settingsSection(frame,'appearance');
  assert.equal(await frame.locator('.personalization-field').count(),fields.length);
  for(const group of groups){
    await openGroup(group.id);
    for(const spec of fields.filter(field=>field.group===group.id)){
      assert.equal(await row(spec.key).isVisible(),true,spec.key+' is reachable from its labeled group');
      assert.equal(await field(spec.key).count(),1,spec.key+' has a unique native value owner');
      assert.equal(await row(spec.key).getByRole('button',{name:`恢复${spec.label}默认值`,exact:true}).count(),1,spec.key+' has an individual reset');
      if(spec.type==='range')assert.equal(await frame.locator(`#field-uikit-${spec.key}-number`).isVisible(),true,spec.key+' supports precise entry');
      if(spec.type==='select')assert.equal(await row(spec.key).getByRole('radiogroup').isVisible(),true,spec.key+' choices are exposed directly');
    }
  }
  record(`all ${fields.length} fields have reachable grouped controls, precise range entry and individual reset`);

  const radius=fields.find(field=>field.key==='radiusButton');
  assert.equal(await auto(radius).getAttribute('aria-checked'),'true');
  assert.equal(await frame.locator('#field-uikit-radiusButton-number').isDisabled(),true);
  await edit(radius,0);await saved({radiusButton:0});
  await auto(radius).click();await saved({radiusButton:-1});
  const focus=fields.find(field=>field.key==='focusColor');
  assert.equal(await auto(focus).getAttribute('aria-checked'),'true');
  await edit(focus,'#ff6600');await saved({focusColor:'#ff6600'});
  await auto(focus).click();await saved({focusColor:''});
  record('automatic radius and state colors persist -1 and empty color while precise zero remains a valid independent shape');

  const outerSearch=frame.getByRole('searchbox',{name:'搜索设置',exact:true});
  await settingsSection(frame,'models');await outerSearch.fill('导航字号');
  await frame.locator('.settings-search-result').filter({hasText:'导航字号'}).first().click();
  assert.equal(await row('navigationFontSize').isVisible(),true);
  assert.equal(await row('navigationFontSize').evaluate(element=>element.classList.contains('settings-focus-target')&&element.contains(document.activeElement)),true);
  const innerSearch=frame.getByRole('searchbox',{name:'找外观设置',exact:true});
  await innerSearch.fill('遮罩模糊');
  assert.equal(await row('backdropBlur').isVisible(),true);
  assert.equal(await frame.locator('.personalization-field:visible').count(),1);
  await innerSearch.fill('');
  assert.equal(await innerSearch.inputValue(),'');
  record('global search focuses the actual appearance field and appearance search opens and filters the matching group');

  await openGroup('motion');
  const stroke=frame.locator('#field-uikit-iconStroke-number');
  await stroke.fill('');await stroke.pressSequentially('1.9');await stroke.blur();
  assert.equal(await stroke.inputValue(),'1.9','sequential typing keeps the intermediate decimal separator');
  await saved({iconStroke:1.9});
  await until(()=>frame.locator('body').evaluate(body=>getComputedStyle(body.ownerDocument.documentElement).getPropertyValue('--icon-stroke').trim()),value=>value==='1.9','iframe stroke preview did not follow decimal typing');
  await until(()=>page.locator('body').evaluate(body=>getComputedStyle(body.ownerDocument.documentElement).getPropertyValue('--icon-stroke').trim()),value=>value==='1.9','shell stroke preview did not follow decimal typing');
  const writeStart=qa.writes.length;
  await stroke.fill('999');assert.equal(await stroke.getAttribute('aria-invalid'),'true');
  await new Promise(resolve=>setTimeout(resolve,900));
  assert.equal(current().iconStroke,1.9,'an invalid value cannot enter the debounce save');
  await stroke.blur();assert.equal(await stroke.inputValue(),'1.9','blur restores the most recent valid value');
  await stroke.fill('0');assert.equal(await stroke.getAttribute('aria-invalid'),'true');await stroke.blur();
  assert.equal(await stroke.inputValue(),'1.9');assert.equal(current().iconStroke,1.9);
  const containsInvalidStroke=value=>value&&typeof value==='object'&&(Object.entries(value).some(([key,item])=>key==='iconStroke'&&(item===999||item===0))||Object.values(value).some(containsInvalidStroke));
  assert.ok(!qa.writes.slice(writeStart).some(write=>containsInvalidStroke(write.body)),'no invalid stroke value is sent to persistence');
  record('character-by-character decimal typing persists and previews 1.9; invalid bounds remain temporary and blur restores the last valid value');

  for(const spec of fields){assert.ok(Object.hasOwn(edits,spec.key),'fixture needs a customized value for '+spec.key);await edit(spec,edits[spec.key]);}
  await frame.locator('#field-uikit-motionScale-number').blur();await saved(edits);await settle();
  const tokenNames=['--font-size','--font-weight','--heading-weight','--line-height','--radius-button','--radius-input','--radius-card','--radius-dialog','--control-height','--control-font-size','--input-font-size','--border-width','--sidebar-width','--settings-sidebar-width','--navigation-font-size','--card-padding','--table-font-size','--dialog-width','--overlay-opacity','--backdrop-blur','--focus','--icon-size','--icon-stroke','--icon-motion-scale','--icon-motion-speed','--brand-icon-size','--brand-motion-speed','--motion-duration-factor','--motion-scale','--ripple-color','--ripple-spread','--ripple-speed'];
  const readTokens=(node,names)=>Object.fromEntries(names.map(name=>[name,getComputedStyle(node.ownerDocument.documentElement).getPropertyValue(name).trim()]));
  const iframeTokens=await frame.locator('body').evaluate(readTokens,tokenNames);
  const shellTokens=await page.locator('body').evaluate(readTokens,tokenNames);
  assert.deepEqual(iframeTokens,shellTokens);
  assert.equal(iframeTokens['--radius-button'],'10px');assert.equal(iframeTokens['--sidebar-width'],'240px');assert.equal(iframeTokens['--icon-stroke'],'2');assert.equal(iframeTokens['--motion-duration-factor'],'0');
  assert.equal(await page.locator('body').getAttribute('data-icon-motion'),'off');
  assert.equal(await frame.locator('body').getAttribute('data-icon-motion'),'off');
  assert.equal(await page.locator('body').getAttribute('data-ripple-motion'),'off');
  assert.equal(await frame.locator('body').getAttribute('data-ripple-motion'),'off');
  record('all customized values save automatically and matching shell/iframe tokens preview independent dimensions, states and animation preferences');

  await row('fontSize').getByRole('button',{name:'恢复正文字号默认值',exact:true}).click();await saved({fontSize:DEFAULT_THEME.fontSize});
  await edit(fields.find(field=>field.key==='fontSize'),edits.fontSize);await saved(edits);
  await qa.openSettings();await settingsSection(frame,'appearance');
  for(const spec of fields){await openGroup(spec.group);const native=field(spec.key);if(spec.type==='range')assert.equal(Number(await frame.locator(`#field-uikit-${spec.key}-number`).inputValue())/(spec.displayScale||1),edits[spec.key],spec.key+' reloads');else if(spec.type==='boolean')assert.equal(await native.isChecked(),edits[spec.key],spec.key+' reloads');else assert.equal(await native.inputValue(),String(edits[spec.key]),spec.key+' reloads');}
  record('individual reset uses the factory value and reopening the application restores all saved fields');

  const themes=frame.locator('details[data-appearance-group="themes"]');if(!await themes.evaluate(element=>element.open))await themes.locator(':scope>summary').click();
  await frame.locator('#uikit-scheme-name').fill('Synthetic detailed theme');
  await themes.getByRole('button',{name:/^(＋\s*)?另存主题$/}).click();
  const customMode=await until(()=>qa.disk().ui.uikit.mode,value=>value.startsWith('custom:'),'custom scheme was not created');
  await saved(edits);assert.deepEqual(Object.fromEntries(fields.map(field=>[field.key,resolveScheme(qa.disk().ui.uikit)[field.key]])),edits);
  await mode('light');await until(()=>qa.disk().ui.uikit.mode,value=>value==='light','light base did not save');
  for(const spec of fields)assert.equal(current()[spec.key],DEFAULT_THEME[spec.key],spec.key+' does not leak from custom scheme into the light base');
  await mode(customMode);await saved(edits);
  record('named themes preserve the complete field set while light and dark factory schemes remain independent');

  await page.setViewportSize({width:560,height:920});
  for(const group of groups)await openGroup(group.id);await settle();
  const geometry=await frame.locator('body').evaluate(body=>{
    const width=document.documentElement.clientWidth;
    return{width,scrollWidth:document.documentElement.scrollWidth,rows:[...body.querySelectorAll('.personalization-field')].filter(element=>element.getClientRects().length).map(element=>{const r=element.getBoundingClientRect();return{key:element.dataset.personalizationKey,left:r.left,right:r.right,width:r.width,children:[...element.querySelectorAll('.personalization-range>*')].map(child=>{const r=child.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};})};})};
  });
  assert.ok(geometry.scrollWidth<=geometry.width+1,'narrow appearance page must not create horizontal overflow: '+JSON.stringify({width:geometry.width,scrollWidth:geometry.scrollWidth}));
  for(const item of geometry.rows){assert.ok(item.left>=-1&&item.right<=geometry.width+1,item.key+' stays in the narrow viewport');for(const child of item.children)assert.ok(child.width>0&&child.left>=item.left-1&&child.right<=item.right+1,item.key+' precise controls stay within their field');}
  await page.screenshot({path:path.join(evidence,'narrow.png')});
  record('all expanded personalization groups and precise controls fit a narrow viewport without horizontal overflow');
  await page.setViewportSize({width:1360,height:900});

  const reset=frame.getByRole('button',{name:'把当前方案重置为暗色基准',exact:true});for(let n=0;n<3;n++)await reset.click();
  await saved(Object.fromEntries(fields.map(spec=>[spec.key,DEFAULT_THEME[spec.key]])));
  assert.equal(qa.disk().ui.uikit.mode,customMode,'resetting a custom theme keeps its independent identity');
  record('restoring a named scheme to factory appearance resets every expanded field without deleting the scheme');
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  record('the complete editor flow finishes without page errors or external service traffic');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,fields:fields.length,errors:qa.errors,outbound:qa.outbound()},null,2));
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')});fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({message:error.message,checks,errors:qa.errors},null,2));throw error;}finally{await qa.close();}
console.log(`✓ 298 ${checks.length} appearance editor integration contracts passed`);
