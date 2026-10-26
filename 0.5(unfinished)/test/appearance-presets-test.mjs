import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {VISUAL_KINDS,normalizeVisualValue,visualCss} from '../ui/panels/visual-style.js';
import {elementPresetFamily,elementSizePresets,ELEMENT_SHAPES,APPEARANCE_FEELS} from '../ui/panels/visual-presets.js';
import {resolveScheme,normalizeTheme} from '../ui/panels/theme.js';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';

let values=0;for(const kind of Object.keys(VISUAL_KINDS))for(const item of [...elementPresetFamily(kind).items,...elementSizePresets(kind),...ELEMENT_SHAPES])for(const [key,value]of Object.entries(item.styles)){assert.notEqual(normalizeVisualValue(key,value),null,`${kind}/${item.id}/${key}`);values++;}
for(const group of APPEARANCE_FEELS)for(const item of group.items)for(const [key,value]of Object.entries(item.tokens))assert.equal(normalizeTheme({...item.tokens})[key],value,group.id+'/'+key);
assert.equal(normalizeVisualValue('color','theme:accent'),'theme:accent');assert.equal(normalizeVisualValue('color','theme:serverToken'),null);assert.equal(normalizeVisualValue('color','theme:accent:101'),null);assert.equal(normalizeVisualValue('color','var(--server-token)'),null);
assert.match(visualCss({rules:[{id:'theme',page:'*',selector:'button',kind:'button',state:'base',styles:{backgroundColor:'theme:accent'}}]},'settings'),/background-color:var\(--accent\)/);
console.log(`✓ ${values} preset values and all global feel recipes satisfy the shared validation contract`);

const evidence=path.resolve('.qa-local/appearance-presets-20261026');fs.mkdirSync(evidence,{recursive:true});
const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark',dark:{accent:'#689bdf'}}}}});const{page,frame}=qa,editor=page.locator('#visual-editor');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{for(let i=0;i<160;i++){if(await fn())return;await sleep(40);}throw Error(label||'condition timed out');};
const scheme=()=>resolveScheme(qa.disk().ui.uikit),rules=()=>scheme().visual.rules;
const styles=()=>rules().find(r=>r.kind==='button')?.styles||{};
const demo=async()=>{const d=frame.locator('details[data-appearance-group=preview]');if(!await d.evaluate(n=>n.open))await d.locator(':scope>summary').click();};
const fine=async()=>{const d=editor.locator('.visual-advanced');if(!await d.evaluate(n=>n.open))await d.locator(':scope>summary').click();};
try{
  await settingsSection(frame,'appearance');
  assert.equal(await frame.locator('.appearance-feel').count(),3);
  assert.equal(await frame.locator('.personalization-field:visible').count(),0,'fine controls stay out of the default page');
  await frame.getByRole('radiogroup',{name:'页面疏密',exact:true}).getByRole('radio',{name:'舒展',exact:true}).click();await until(()=>scheme().controlHeight===44&&scheme().cardPadding===22,'linked spacing did not save');
  await frame.getByRole('radiogroup',{name:'圆润程度',exact:true}).getByRole('radio',{name:'柔圆',exact:true}).click();await until(()=>scheme().radiusCard===20&&scheme().radiusButton===24,'linked shape did not save');
  await frame.getByRole('radiogroup',{name:'文字大小',exact:true}).getByRole('radio',{name:'大',exact:true}).click();await until(()=>scheme().fontSize===15&&scheme().inputFontSize===15,'linked typography did not save');
  assert.equal(scheme().accent,'#689bdf');
  await frame.getByRole('button',{name:'撤销本次外观调整',exact:true}).click();await until(()=>scheme().fontSize===13&&scheme().controlHeight===36&&scheme().radiusButton===-1,'global feel undo did not restore the untouched theme');
  for(const [group,label]of [['页面疏密','舒展'],['圆润程度','柔圆'],['文字大小','大']])await frame.getByRole('radiogroup',{name:group,exact:true}).getByRole('radio',{name:label,exact:true}).click();await until(()=>scheme().fontSize===15&&scheme().controlHeight===44&&scheme().radiusCard===20);
  await page.screenshot({path:path.join(evidence,'simple-home.png')});console.log('✓ three plain-language controls coordinate spacing, type and shape, save automatically and preserve the palette');
  await demo();await frame.getByRole('button',{name:'点选编辑',exact:true}).click();await editor.waitFor({state:'visible'});
  const primary=frame.locator('.component-preview').getByRole('button',{name:'主按钮',exact:true});await primary.click();await editor.locator('.recipe-grid').waitFor();
  assert.equal(await editor.locator('.property').count(),0,'full property editors are created only on demand');assert.equal(await editor.locator('.recipe:visible').count(),4,'initial choice set stays small');
  const outline=editor.getByRole('radio',{name:'细边样式',exact:true});await outline.hover();await until(async()=>await primary.evaluate(n=>getComputedStyle(n).backgroundColor)==='rgba(0, 0, 0, 0)','hover preview missing');await sleep(700);assert.equal(rules().length,0,'hover must never save a preset');await editor.locator('.heading').hover();await until(async()=>await frame.locator('style[data-visual-owned]').count()===0,'hover preview did not restore');
  await outline.click();await until(()=>styles().backgroundColor==='transparent'&&styles().borderWidth==='1px','preset did not save');await editor.locator('.heading').hover();
  await editor.getByRole('button',{name:'撤销元素样式',exact:true}).click();await until(()=>rules().length===0,'preset needs one atomic undo');await editor.getByRole('button',{name:'重做元素样式',exact:true}).click();await until(()=>styles().backgroundColor==='transparent');
  console.log('✓ style cards preview without persistence, commit as one undo step and keep the default inspector small');
  await editor.getByRole('radiogroup',{name:'大小',exact:true}).getByRole('radio',{name:'舒展',exact:true}).click();await until(()=>styles().minHeight==='46px');
  await editor.getByRole('radiogroup',{name:'圆润',exact:true}).getByRole('radio',{name:'柔圆',exact:true}).click();await until(()=>styles().borderRadius==='28px');
  await fine();await editor.locator('#visual-property-width').fill('216');await until(()=>styles().width==='216px');
  await editor.getByRole('button',{name:'更多样式',exact:true}).click();await editor.getByRole('radio',{name:'粗边样式',exact:true}).click();await until(()=>styles().borderColor==='theme:accent');
  assert.equal(styles().width,'216px');assert.equal(styles().minHeight,'46px');assert.equal(styles().borderRadius,'28px');assert.equal(styles().fontSize,'15px');
  await editor.locator('.visual-advanced>summary').click();await page.screenshot({path:path.join(evidence,'mixed-button.png')});
  await editor.getByRole('button',{name:'完成',exact:true}).click();await editor.waitFor({state:'detached'});await qa.request('POST','/api/config',{ui:{uikit:{dark:{accent:'#d97706'}}}});
  await until(async()=>await primary.evaluate(n=>getComputedStyle(n).borderColor)==='rgb(217, 119, 6)','preset stopped following the theme');assert.equal(styles().borderColor,'theme:accent');
  console.log('✓ finish, size and corner recipes mix independently, preserve a custom width and follow later palette changes');
  await page.reload();await page.locator('#nav button[data-panel=settings]').click();await settingsSection(frame,'appearance');await demo();await frame.getByRole('button',{name:'点选编辑',exact:true}).click();await editor.waitFor({state:'visible'});await frame.locator('.component-preview .component-preview-type-title').click();await editor.locator('.recipe-grid').waitFor();
  assert.equal(await editor.getByRole('radiogroup',{name:'圆润',exact:true}).count(),0,'text does not expose irrelevant corner options');
  await editor.getByRole('button',{name:'完成',exact:true}).click();assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  console.log('✓ reload preserves mixed styles; contextual controls remain relevant and no external calls occur');
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')});throw error;}finally{await qa.close();}
