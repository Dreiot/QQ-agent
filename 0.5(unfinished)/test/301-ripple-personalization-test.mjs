// User controls -> saved theme -> shell/iframe paint -> real ripple geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {resolveScheme,DEFAULT_THEME} from '../ui/panels/theme.js';

const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark'}}}}),{page,frame}=qa;
const evidence=path.resolve('.qa-local/ripple-personalization-20261024');fs.mkdirSync(evidence,{recursive:true});
const checks=[],record=label=>{checks.push(label);console.log('✓ 301 '+label);};
const until=async(read,accept,label)=>{for(let i=0;i<160;i++){const result=await read();if(accept(result))return result;await new Promise(resolve=>setTimeout(resolve,40));}throw Error(label);};
const scheme=()=>resolveScheme(qa.disk().ui.uikit);
const saved=async values=>{
  await until(scheme,result=>Object.entries(values).every(([key,value])=>result[key]===value),'ripple preferences did not save');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
};
const control=key=>frame.locator(`#field-uikit-${key}`);
const group=frame.locator('details[data-appearance-group="personal-ripple"]');
const open=async()=>{await settingsSection(frame,'appearance');if(!await group.evaluate(node=>node.open))await group.locator(':scope>summary').click();};
const tokens=node=>({enabled:node.dataset.rippleMotion,color:getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--ripple-color').trim(),spread:getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--ripple-spread').trim(),speed:getComputedStyle(node.ownerDocument.documentElement).getPropertyValue('--ripple-speed').trim()});
async function wave(root,button){
  // Freeze the real pointer-created ring at its first frame, before an unusually
  // fast user preference could finish between automation round trips.
  await root.locator('body').evaluate(body=>{body.ownerDocument.addEventListener('pointerdown',()=>{for(const ring of body.querySelectorAll('.press-feedback-ring'))for(const animation of ring.getAnimations())animation.pause();},{once:true});});
  await button.click();const ring=root.locator('.press-feedback-ring');await ring.waitFor({state:'attached'});
  return ring.evaluate(node=>{const a=node.getAnimations()[0],frames=a.effect.getKeyframes();return{color:getComputedStyle(node).color,duration:a.effect.getTiming().duration,spread:(Number.parseFloat(frames.at(-1).width)-Number.parseFloat(frames[0].width))/2};});
}
const finish=async root=>{await root.locator('body').evaluate(body=>{for(const n of body.querySelectorAll('.press-feedback-ring'))for(const a of n.getAnimations())a.finish();});await root.locator('.press-feedback-ring').waitFor({state:'detached'});};

try{
  await page.emulateMedia({reducedMotion:'no-preference'});await open();
  assert.equal(await group.locator('.personalization-field').count(),4);
  for(const key of ['rippleEnabled','rippleColor','rippleSpread','rippleSpeed'])assert.equal(await control(key).isVisible(),true);
  assert.equal(await control('rippleEnabled').isChecked(),true);
  await control('rippleEnabled').uncheck();await saved({rippleEnabled:false});
  await frame.getByRole('button',{name:'次按钮',exact:true}).click();assert.equal(await frame.locator('.press-feedback-ring').count(),0);
  record('four grouped controls are reachable and the independent switch disables real button waves');

  await group.getByRole('switch',{name:'波纹颜色自动',exact:true}).click();
  await control('rippleColor').evaluate(input=>{input.value='#12abde';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await frame.locator('#field-uikit-rippleSpread-number').fill('20');
  await frame.locator('#field-uikit-rippleSpeed-number').fill('2');
  await saved({rippleEnabled:false,rippleColor:'#12abde',rippleSpread:20,rippleSpeed:2});
  await until(async()=>page.locator('body').evaluate(tokens),value=>value.color==='#12abde'&&value.enabled==='off','shell did not receive ripple preferences');
  assert.deepEqual(await frame.locator('body').evaluate(tokens),await page.locator('body').evaluate(tokens));
  assert.deepEqual(await frame.locator('body').evaluate(tokens),{enabled:'off',color:'#12abde',spread:'20px',speed:'2'});
  record('color, pixel range and speed auto-save and paint identical tokens in shell and isolated panels');

  await qa.openSettings();await open();
  assert.equal(await control('rippleEnabled').isChecked(),false);assert.equal(await control('rippleColor').inputValue(),'#12abde');
  assert.equal(await frame.locator('#field-uikit-rippleSpread-number').inputValue(),'20');assert.equal(await frame.locator('#field-uikit-rippleSpeed-number').inputValue(),'2');
  await control('rippleEnabled').check();await saved({rippleEnabled:true});
  const preview=frame.getByRole('button',{name:'次按钮',exact:true});
  assert.deepEqual(await wave(frame,preview),{color:'rgb(18, 171, 222)',duration:210,spread:20});
  await frame.locator('body').evaluate(body=>body.ownerDocument.documentElement.style.setProperty('--ripple-speed','1.5'));
  await frame.locator('.press-feedback-ring').waitFor({state:'detached'});
  await frame.locator('body').evaluate(body=>body.ownerDocument.documentElement.style.setProperty('--ripple-speed','2'));
  await frame.locator('#field-uikit-rippleSpread-number').fill('12');await saved({rippleSpread:12});await frame.locator('.press-feedback-ring').waitFor({state:'detached'});
  assert.deepEqual(await wave(page,page.locator('#nav button[data-panel=settings]')),{color:'rgb(18, 171, 222)',duration:210,spread:12});await finish(page);
  record('reopening retains all values; configured color, range and faster duration drive actual panel and shell animations');

  await group.getByRole('switch',{name:'波纹颜色自动',exact:true}).click();await saved({rippleColor:''});
  const color=await wave(frame,preview);const expected=await frame.locator('body').evaluate(body=>{const n=document.createElement('span');n.style.color='var(--accent)';body.append(n);const color=getComputedStyle(n).color;n.remove();return color;});assert.equal(color.color,expected);await finish(frame);
  const danger=await wave(frame,frame.getByRole('button',{name:'危险按钮',exact:true}));const bad=await frame.locator('body').evaluate(body=>{const n=document.createElement('span');n.style.color='var(--bad)';body.append(n);const color=getComputedStyle(n).color;n.remove();return color;});assert.equal(danger.color,bad);await finish(frame);
  record('automatic paint follows the current theme and preserves the danger action color');

  for(const [key,label] of [['rippleSpread','扩散范围'],['rippleSpeed','波纹速度']]){await group.getByRole('button',{name:`恢复${label}默认值`,exact:true}).click();await saved({[key]:DEFAULT_THEME[key]});}
  await frame.locator('#field-uikit-rippleSpread-number').fill('0');await saved({rippleSpread:0});await preview.click();assert.equal(await frame.locator('.press-feedback-ring').count(),0);
  await group.getByRole('button',{name:'恢复扩散范围默认值',exact:true}).click();await saved({rippleSpread:8});
  await wave(frame,preview);await control('rippleEnabled').uncheck();await saved({rippleEnabled:false});await frame.locator('.press-feedback-ring').waitFor({state:'detached'});
  await control('rippleEnabled').check();await saved({rippleEnabled:true});await page.emulateMedia({reducedMotion:'reduce'});await preview.click();assert.equal(await frame.locator('.press-feedback-ring').count(),0);
  record('per-field reset, zero range, live cancellation and system reduced motion remain effective');

  await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:560,height:920});
  await group.scrollIntoViewIfNeeded();await frame.locator('body').evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));});
  assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:path.join(evidence,'controls-narrow.png')});
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  record('new controls fit narrow windows without browser errors or external service traffic');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,errors:qa.errors,outbound:qa.outbound()},null,2));
}finally{await qa.close();}
