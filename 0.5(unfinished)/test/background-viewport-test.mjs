import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {resolveScheme} from '../ui/panels/theme.js';

const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark',dark:{bgZoom:.6,bgOffsetX:9,bgOffsetY:-7,bgOpacity:.3}}}}});
const {page,frame}=qa,evidence=path.resolve('.qa-local/background-viewport-20261026');fs.mkdirSync(evidence,{recursive:true});
const checks=[],current=()=>resolveScheme(qa.disk().ui.uikit),until=async(fn,label)=>{for(let i=0;i<160;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error(label);};
const sizes=[{width:1440,height:810},{width:1360,height:900},{width:900,height:900},{width:720,height:1100},{width:1780,height:600}];
async function background(){await settingsSection(frame,'appearance');const fold=frame.locator('details[data-appearance-group=background]');if(!await fold.evaluate(n=>n.open))await fold.locator(':scope>summary').click();}
async function geometry(){return frame.locator('.bg-stage').evaluate(stage=>{
  const rect=el=>{const b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
  return{stage:rect(stage),crop:rect(stage.querySelector('.bg-crop')),mask:rect(stage.querySelector('.bg-stage-mask')),label:stage.querySelector('.bg-crop-size').textContent};
});}
async function assertRatio(size){
  await until(async()=>{const g=await geometry();return g.stage.height>0&&Math.abs(g.stage.width/g.stage.height-size.width/size.height)<.003;},'host viewport did not reach the opaque settings frame');
  const g=await geometry(),expected=size.width/size.height;
  assert.ok(Math.abs(g.crop.width/g.crop.height-expected)<.004,JSON.stringify(g));
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(g.crop[key]-g.mask[key])<1,'mask does not follow crop');
  const host=await page.evaluate(()=>{const video=document.querySelector('#background-video'),s=video?getComputedStyle(video):getComputedStyle(document.body,'::before');return{width:parseFloat(s.width),height:parseFloat(s.height),left:parseFloat(s.left),top:parseFloat(s.top)};});
  assert.equal(host.width,size.width);assert.equal(host.height,size.height);assert.equal(host.left,0);assert.equal(host.top,0);
  assert.match(g.label,/跟随窗口/);return g;
}
try{
  const png=fs.readFileSync(path.resolve('assets/icon.png')),image=await qa.request('POST','/api/uikit/background',{data:'data:image/png;base64,'+png.toString('base64')});assert.equal(image.status,200);
  await qa.request('POST','/api/config',{ui:{uikit:{dark:{bgImage:image.data.url}}}});await qa.openSettings();await background();
  const initial=JSON.stringify(qa.disk().ui.uikit),writes=qa.writes.length;
  for(const size of sizes){await page.setViewportSize(size);await assertRatio(size);await page.screenshot({path:path.join(evidence,`${size.width}x${size.height}.png`)});}
  assert.equal(JSON.stringify(qa.disk().ui.uikit),initial);assert.equal(qa.writes.length,writes,'window resizing must not save config or reupload media');
  checks.push('five live window proportions keep stage, crop, mask and host plane aligned without configuration writes');
  await page.setViewportSize({width:1360,height:900});await assertRatio({width:1360,height:900});
  const crop=frame.locator('.bg-crop');await crop.scrollIntoViewIfNeeded();
  const box=await crop.boundingBox(),before=current(),point={x:box.x+box.width*.3,y:box.y+box.height*.65};
  const stage=await frame.locator('.bg-stage').boundingBox();
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+12,point.y+9,{steps:6});await page.mouse.up();
  await until(()=>Math.abs(current().bgOffsetX-(before.bgOffsetX+12/stage.width*100))<.35&&Math.abs(current().bgOffsetY-(before.bgOffsetY+9/stage.height*100))<.35,'drag jumped away from the grabbed position');
  checks.push('dragging from an off-center grab point moves the crop by exactly the pointer distance');
  const saved=JSON.stringify(qa.disk().ui.uikit);await page.setViewportSize({width:720,height:1100});await assertRatio({width:720,height:1100});assert.equal(JSON.stringify(qa.disk().ui.uikit),saved);
  const corner=frame.locator('.bg-crop-handle[data-corner=se]');await corner.scrollIntoViewIfNeeded();const handle=await corner.boundingBox(),oldZoom=current().bgZoom;
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x-12,handle.y-18,{steps:5});await page.mouse.up();
  await until(()=>current().bgZoom<oldZoom,'portrait corner drag did not resize crop');await assertRatio({width:720,height:1100});
  checks.push('portrait corner resizing preserves the live ratio and saves normalized crop values');
  const dial=frame.locator('.bg-rotate-dial');await dial.scrollIntoViewIfNeeded();const dialBox=await dial.boundingBox(),rotateStage=await frame.locator('.bg-stage').boundingBox(),distance=Math.min(rotateStage.width,rotateStage.height)*.25;
  await page.mouse.move(dialBox.x+dialBox.width/2,dialBox.y+dialBox.height/2);await page.mouse.down();await page.mouse.move(rotateStage.x+rotateStage.width/2+distance,rotateStage.y+rotateStage.height/2-distance,{steps:6});await page.mouse.up();
  await until(()=>Math.abs(current().bgRotate-45)<2,'rotation angle must use physical pixels on a portrait preview');
  checks.push('rotation uses actual pointer angles on a non-square preview');
  const video=fs.readFileSync(new URL('./fixtures/background-loop.mp4',import.meta.url)),init=await qa.request('POST','/api/uikit/background/uploads',{size:video.length});
  await qa.request('POST',`/api/uikit/background/uploads/${init.data.id}/chunk`,{offset:0,data:video.toString('base64')});const complete=await qa.request('POST',`/api/uikit/background/uploads/${init.data.id}/complete`,{});assert.equal(complete.status,200);
  await qa.request('POST','/api/config',{ui:{uikit:{dark:{bgImage:complete.data.url}}}});
  await until(()=>page.locator('#background-video').count(),'video was not mounted');await until(()=>page.locator('#background-video').evaluate(v=>!v.paused&&v.currentTime>0),'video did not start');
  await page.locator('#background-video').evaluate(v=>v.dataset.instance='keep');const videoConfig=JSON.stringify(qa.disk().ui.uikit),videoWrites=qa.writes.length;
  for(const size of sizes){await page.setViewportSize(size);await assertRatio(size);assert.equal(await page.locator('#background-video').getAttribute('data-instance'),'keep');assert.equal(await page.locator('#background-video').count(),1);}
  assert.equal(JSON.stringify(qa.disk().ui.uikit),videoConfig);assert.equal(qa.writes.length,videoWrites);assert.equal(await page.locator('#background-video').evaluate(v=>v.paused),false);
  checks.push('video follows window resizing with one uninterrupted native player and no writes');
  assert.deepEqual(qa.errors,[]);fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,externalCalls:qa.outbound()},null,2));
  for(const check of checks)console.log('✓ '+check);
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')});throw error;}finally{await qa.close();}
