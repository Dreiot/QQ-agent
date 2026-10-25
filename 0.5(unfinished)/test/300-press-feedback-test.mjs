// Real pointer/keyboard events and intermediate animation frames, isolated data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const qa=await modelUiFixture(),{page,frame}=qa;
const evidence=path.resolve('.qa-local/press-feedback-20261024');fs.mkdirSync(evidence,{recursive:true});
const checks=[];const record=label=>{checks.push(label);console.log('✓ 300 '+label);};
const settle=async()=>{await frame.locator('body').evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});};
const ring=frame.locator('.press-feedback-ring');
const inspect=()=>ring.evaluate(node=>({width:node.getBoundingClientRect().width,opacity:Number(getComputedStyle(node).opacity),pointerEvents:getComputedStyle(node).pointerEvents}));
const finish=()=>frame.locator('body').evaluate(()=>{for(const n of document.querySelectorAll('.press-feedback-ring'))for(const a of n.getAnimations())a.finish();});
try{
  await page.emulateMedia({reducedMotion:'no-preference'});
  await settingsSection(frame,'appearance');await settle();
  const button=frame.getByRole('button',{name:'次按钮',exact:true});
  await button.click();await ring.waitFor({state:'attached'});
  const dimensions=await button.boundingBox();
  const initial=await ring.evaluate(node=>{const a=node.getAnimations()[0];a.pause();a.currentTime=0;return{width:node.getBoundingClientRect().width,opacity:Number(getComputedStyle(node).opacity),duration:a.effect.getTiming().duration};});
  assert.ok(Math.abs(initial.width-dimensions.width)<3);assert.equal(initial.duration,420);
  await ring.evaluate(node=>{node.getAnimations()[0].currentTime=160;});const middle=await inspect();
  assert.ok(middle.width>initial.width&&middle.opacity>0&&middle.opacity<initial.opacity);assert.equal(middle.pointerEvents,'none');
  await page.screenshot({path:path.join(evidence,'button-wave-middle.png')});
  const preview=await frame.locator('.component-preview').boundingBox();
  await page.screenshot({path:path.join(evidence,'component-wave-middle.png'),clip:{x:preview.x-10,y:preview.y-10,width:preview.width+20,height:preview.height+20}});
  await ring.evaluate(node=>{node.getAnimations()[0].currentTime=360;});const late=await inspect();assert.ok(late.width>middle.width&&late.opacity<middle.opacity);
  await finish();await ring.waitFor({state:'detached'});assert.equal(await frame.locator('.press-feedback-layer').count(),0);
  record('one edge ring expands outward and fades through intermediate frames, then removes its layer');

  const checkbox=frame.getByRole('checkbox',{name:'示例开关',exact:true}),card=frame.locator('.component-preview label.settings-toggle-card');
  const old=await checkbox.isChecked();await card.click();await ring.waitFor({state:'attached'});
  assert.equal(await checkbox.isChecked(),!old);assert.equal(await ring.count(),1,'label forwarding must not create another wave');
  assert.equal(await card.evaluate(node=>getComputedStyle(node).outlineStyle),'none','pointer focus must not keep the oversized outline');
  await finish();await ring.waitFor({state:'detached'});
  await checkbox.press('Space');await ring.waitFor({state:'attached'});
  assert.equal(await checkbox.isChecked(),old);
  const keyboard=await card.evaluate(node=>({style:getComputedStyle(node).outlineStyle,offset:getComputedStyle(node).outlineOffset,visible:node.matches(':has(input:focus-visible)')}));
  assert.deepEqual(keyboard,{style:'solid',offset:'-2px',visible:true});
  await finish();await ring.waitFor({state:'detached'});
  record('mouse card selection has no persistent outer frame; keyboard activation retains a compact visible focus cue');

  const text=frame.getByRole('textbox',{name:'示例文字',exact:true});await text.click();await text.fill('Synthetic input');await text.press('Space');
  assert.equal(await ring.count(),0);assert.equal(await text.inputValue(),'Synthetic input ');
  const disabled=frame.getByRole('button',{name:'禁用按钮',exact:true});const box=await disabled.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);assert.equal(await ring.count(),0);
  record('text entry and disabled controls produce no ripple and keep their native behavior');

  await button.click();await ring.waitFor({state:'attached'});await button.click();assert.equal(await ring.count(),1,'a repeated press replaces its previous ring');await finish();await ring.waitFor({state:'detached'});
  await frame.getByRole('button',{name:'预览弹窗',exact:true}).click();
  const modal=frame.locator('dialog.component-sample-dialog');await modal.waitFor({state:'visible'});
  await finish();await ring.waitFor({state:'detached'});
  const modalButton=modal.getByRole('button',{name:'完成',exact:true});
  // Hold before release so the original modal remains open for geometry checks.
  const modalBox=await modalButton.boundingBox();await page.mouse.move(modalBox.x+modalBox.width/2,modalBox.y+modalBox.height/2);await page.mouse.down();
  await ring.waitFor({state:'attached'});assert.equal(await frame.locator('.press-feedback-layer').evaluate(node=>node.matches(':popover-open')),true);
  await page.mouse.up();await modal.waitFor({state:'detached'});await ring.waitFor({state:'detached'});
  record('rapid presses stay bounded and modal controls show the ring above the modal without trapping input');

  await button.click();await ring.waitFor({state:'attached'});
  await frame.locator('body').evaluate(()=>{document.body.dataset.interfaceMotion='off';});await ring.waitFor({state:'detached'});
  await button.click();assert.equal(await ring.count(),0);
  await frame.locator('body').evaluate(()=>{document.body.dataset.interfaceMotion='on';document.documentElement.style.setProperty('--motion-scale','0');});
  await button.click();assert.equal(await ring.count(),0);
  await frame.locator('body').evaluate(()=>{document.documentElement.style.setProperty('--motion-scale','1');document.documentElement.style.setProperty('--motion-duration-factor','1.5');});
  await button.click();await ring.waitFor({state:'attached'});assert.equal(await ring.evaluate(n=>n.getAnimations()[0].effect.getTiming().duration),630);
  await page.emulateMedia({reducedMotion:'reduce'});await ring.waitFor({state:'detached'});await button.click();assert.equal(await ring.count(),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  record('existing motion preferences scale timing and suppress or cancel ripples immediately, including reduced motion');

  await frame.locator('body').evaluate(()=>{document.documentElement.style.setProperty('--motion-duration-factor','1');});
  await button.click();await ring.waitFor({state:'attached'});await page.setViewportSize({width:560,height:900});await ring.waitFor({state:'detached'});await settle();
  assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.setViewportSize({width:1360,height:900});await button.scrollIntoViewIfNeeded();await settle();
  await button.click();await ring.waitFor({state:'attached'});await frame.locator('body').evaluate(()=>document.dispatchEvent(new Event('scroll')));await ring.waitFor({state:'detached'});
  record('scrolling and resizing cancel detached-looking outlines without affecting page layout');

  const before=qa.writes.length;await page.locator('#pause-btn').click();await page.locator('.press-feedback-ring').waitFor({state:'attached'});
  assert.equal(await page.locator('.press-feedback-ring').count(),1);
  await page.waitForFunction(()=>document.querySelector('#pause-btn').getAttribute('aria-pressed')==='true');
  assert.equal(qa.writes.length,before+1,'feedback must not replay the pause action');
  await page.locator('.press-feedback-ring').waitFor({state:'detached'});
  record('shell buttons share the feedback and execute their original action exactly once');
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,errors:qa.errors,outbound:qa.outbound()},null,2));
}finally{await qa.close();}
