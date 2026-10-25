import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {resolveScheme} from '../ui/panels/theme.js';

const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark'}}}});
const {page,frame}=qa;
const until=async(check,label)=>{for(let i=0;i<160;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error(label);};
const current=()=>resolveScheme(qa.disk().ui.uikit);
const read=()=>page.evaluate(()=>{
  const button=document.querySelector('#brand-emblem'),svg=button.querySelector('svg'),animation=svg.querySelector('path').getAnimations()[0];
  return{size:svg.getBoundingClientRect().width,slot:button.getBoundingClientRect().width,effects:svg.querySelector('path').getAnimations().length,duration:animation?.effect.getTiming().duration};
});
const edit=async(key,value)=>{await frame.locator(`#field-uikit-${key}-number`).fill(String(value));await frame.locator(`#field-uikit-${key}-number`).blur();await until(()=>current()[key]===value,key+' did not save');};
const group=async(id)=>{const section=frame.locator(`details[data-appearance-group="personal-${id}"]`);if(!await section.evaluate(element=>element.open))await section.locator(':scope>summary').click();};
try{
  await until(async()=>((await read()).duration===1000),'default brand animation missing');
  assert.deepEqual(await read(),{size:36,slot:45,effects:1,duration:1000});
  const phases=await page.evaluate(()=>{
    const path=document.querySelector('#brand-emblem path'),animation=path.getAnimations()[0],frames=animation.effect.getKeyframes();
    animation.pause();const values=[];
    for(const time of [0,124,125,249,250,874,875,999,1000]){animation.currentTime=time;values.push(getComputedStyle(path).d);}
    animation.play();return{values,offsets:frames.map(frame=>frame.computedOffset),easings:frames.map(frame=>frame.easing)};
  });
  assert.deepEqual(phases.offsets,[0,.125,.25,.375,.5,.625,.75,.875,1]);
  assert.ok(phases.easings.every(easing=>easing==='steps(1)'));
  assert.equal(phases.values[0],phases.values[1]);assert.notEqual(phases.values[1],phases.values[2]);
  assert.equal(phases.values[2],phases.values[3]);assert.notEqual(phases.values[3],phases.values[4]);
  assert.notEqual(phases.values[5],phases.values[6]);assert.equal(phases.values[6],phases.values[7]);assert.equal(phases.values[8],phases.values[0]);
  console.log('✓ brand default is 36px with exactly eight discrete generations per second, one native loop and no interpolated cells');

  await settingsSection(frame,'appearance');await group('brand');
  assert.match(await frame.locator('#field-uikit-brandMotionSpeed-hint').textContent(),/每秒 8 次/);
  assert.equal(await frame.locator('#field-uikit-brandMotionSpeed').getAttribute('aria-describedby'),'field-uikit-brandMotionSpeed-hint');
  await edit('brandIconSize',52);await edit('brandMotionSpeed',.5);
  await until(async()=>((await read()).duration===2000),'brand half speed did not reach shell');
  assert.deepEqual(await read(),{size:52,slot:61,effects:1,duration:2000});
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
  await group('motion');await edit('iconSize',30);await edit('iconMotionSpeed',2);await edit('iconMotionScale',0);
  assert.deepEqual(await read(),{size:52,slot:61,effects:1,duration:2000},'global icon dimensions, speed and amplitude must not change the brand');
  console.log('✓ independent size and cadence preview and auto-save, show saved feedback, and remain unchanged by the other icon controls');

  await qa.openSettings();await settingsSection(frame,'appearance');await group('brand');
  assert.equal(await frame.locator('#field-uikit-brandIconSize-number').inputValue(),'52');
  assert.equal(await frame.locator('#field-uikit-brandMotionSpeed-number').inputValue(),'0.5');
  await edit('brandIconSize',64);await edit('brandMotionSpeed',2);
  await until(async()=>((await read()).duration===500),'brand double speed did not reach shell');
  await page.locator('#brand-emblem').click();
  await page.waitForFunction(()=>document.body.dataset.railCollapsed==='true');
  const bounds=await page.evaluate(()=>{
    const rail=document.querySelector('.rail').getBoundingClientRect(),button=document.querySelector('#brand-emblem').getBoundingClientRect(),svg=document.querySelector('#brand-emblem svg').getBoundingClientRect();
    return{rail:{left:rail.left,right:rail.right},button:{left:button.left,right:button.right,top:button.top,bottom:button.bottom},svg:{left:svg.left,right:svg.right,top:svg.top,bottom:svg.bottom,width:svg.width}};
  });
  assert.equal(bounds.svg.width,64);assert.ok(bounds.svg.left>=bounds.button.left&&bounds.svg.right<=bounds.button.right);assert.ok(bounds.svg.top>=bounds.button.top&&bounds.svg.bottom<=bounds.button.bottom);assert.ok(bounds.button.left>=bounds.rail.left&&bounds.button.right<=bounds.rail.right);
  await page.locator('#brand-emblem').click();
  const row=key=>frame.locator(`[data-personalization-key="${key}"]`);
  await row('brandIconSize').getByRole('button',{name:'恢复左上角图标大小默认值',exact:true}).click();
  await row('brandMotionSpeed').getByRole('button',{name:'恢复左上角图标速度默认值',exact:true}).click();
  await until(()=>current().brandIconSize===36&&current().brandMotionSpeed===1,'individual resets did not save');
  await until(async()=>((await read()).duration===1000),'reset did not repaint');
  assert.deepEqual(await read(),{size:36,slot:45,effects:1,duration:1000});
  assert.equal(current().iconSize,30);assert.equal(current().iconMotionSpeed,2);assert.equal(current().iconMotionScale,0);
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  console.log('✓ persistence, separate reset, half/double speed, and maximum-size collapsed layout work without errors or external traffic');
}finally{await qa.close();}
