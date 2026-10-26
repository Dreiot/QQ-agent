import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
import {resolveScheme} from '../ui/panels/theme.js';
import {uploadBackgroundFile,MAX_BACKGROUND_SOURCE_BYTES} from '../ui/panels/settings/background-upload.js';

// A disposable, recognizable test image. No user file or real account is used.
const width=64,height=36,raw=Buffer.alloc((width*3+1)*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const p=y*(width*3+1)+x*3+1;raw[p]=x*4;raw[p+1]=y*7;raw[p+2]=180;
}
function chunk(name,bytes){
  const body=Buffer.concat([Buffer.from(name),bytes]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const evidence=path.resolve('.qa-local/background-selection-20261026');fs.mkdirSync(evidence,{recursive:true});
const qa=await modelUiFixture({config:{ui:{uikit:{mode:'dark',dark:{bgImage:'',bgOpacity:0},light:{bgImage:'',bgOpacity:.51}}}}});
const {page,frame}=qa,checks=[];
const diagnostics=[];page.on('console',message=>{if(['error','warning'].includes(message.type()))diagnostics.push(message.text());});page.on('requestfailed',request=>diagnostics.push(request.url()+' '+request.failure()?.errorText));
const current=()=>resolveScheme(qa.disk().ui.uikit);
const until=async(fn,label)=>{for(let i=0;i<160;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error(label);};
async function background(){
  await settingsSection(frame,'appearance');
  const fold=frame.locator('details[data-appearance-group=background]');
  if(!await fold.evaluate(n=>n.open))await fold.locator(':scope>summary').click();
}
async function choose(name){
  const pending=page.waitForEvent('filechooser');await frame.getByRole('button',{name:'选择图片或视频',exact:true}).click();
  const chooser=await pending;await chooser.setFiles({name:name+'.png',mimeType:'image/png',buffer:png});
}
async function chooseBytes(name,buffer,mimeType='image/png'){
  const pending=page.waitForEvent('filechooser');await frame.getByRole('button',{name:'选择图片或视频',exact:true}).click();
  await(await pending).setFiles({name,mimeType,buffer});
}
async function opacity(value){
  await frame.locator('#field-uikit-bgOpacity').evaluate((input,v)=>{input.value=String(v);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
  await until(()=>current().bgOpacity===value,'opacity not saved');
}
async function paint(expected){
  await until(()=>page.evaluate(value=>{
    const paint=getComputedStyle(document.body,'::before');
    return document.body.dataset.bgImage==='on'&&paint.backgroundImage.includes('/ui/backgrounds/')&&Number(paint.opacity)===value&&paint.display==='block';
  },expected),'host background not visible');
  const image=frame.locator('.bg-stage-img');await image.waitFor({state:'visible'});
  assert.equal(await image.evaluate(async img=>{await img.decode();return img.naturalWidth;}),width);
}
try{
  await background();await choose('visible-from-zero');
  await until(()=>current().bgImage&&current().bgOpacity===.2,'selected image or visible opacity not saved');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
  const savedUrl=current().bgImage;await paint(.2);
  assert.equal(qa.disk().ui.uikit.light.bgOpacity,.51,'another theme must remain untouched');
  checks.push('real chooser, upload, decoding, automatic visibility and saving');
  await page.screenshot({path:path.join(evidence,'selected-and-saved.png')});
  await page.reload();await page.locator('#nav button[data-panel=settings]').click();await background();
  assert.equal(current().bgImage,savedUrl);assert.equal(await frame.locator('#field-uikit-bgOpacity').inputValue(),'0.2');await paint(.2);
  checks.push('image and opacity survive browser reload');
  await opacity(.38);await choose('preserve-opacity');
  await until(()=>current().bgImage!==savedUrl,'replacement did not finish');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
  await paint(.38);assert.equal(current().bgOpacity,.38);
  checks.push('replacing an image preserves a nonzero personal opacity');
  const replacementUrl=current().bgImage;await opacity(0);assert.equal(current().bgImage,replacementUrl);await paint(0);
  checks.push('intentional hiding after selection remains available');
  const uploads=()=>qa.writes.filter(w=>w.path==='/api/uikit/background/uploads').length;
  const before=JSON.stringify(qa.disk().ui.uikit),posts=uploads();
  const pending=page.waitForEvent('filechooser');await frame.getByRole('button',{name:'选择图片或视频',exact:true}).click();await(await pending).setFiles([]);
  await page.waitForTimeout(650);assert.equal(JSON.stringify(qa.disk().ui.uikit),before);assert.equal(uploads(),posts);
  checks.push('canceling selection does not upload or alter the current theme');
  const padding=Buffer.alloc(9*1024*1024,97);padding[0]=81;padding[1]=0;
  const large=Buffer.concat([png.subarray(0,33),chunk('tEXt',padding),png.subarray(33)]);
  await chooseBytes('large-artwork.png',large);
  await until(()=>current().bgImage!==replacementUrl,'large original image not saved');await paint(.2);
  assert.match(current().bgImage,/\.png$/);assert.match(await frame.locator('.bg-upload-status').innerText(),/原文件导入/);
  assert.ok(fs.readFileSync(path.join(qa.dir,'ui/backgrounds',path.basename(current().bgImage))).equals(large));
  checks.push('large PNG passes through bounded chunks with every source byte preserved');
  const installed=current().bgImage;
  await chooseBytes('not-media.bin',Buffer.from('not a valid background media file'),'application/octet-stream');
  await frame.locator('.bg-upload-status.field-error').filter({hasText:'PNG'}).waitFor({state:'visible'});
  assert.equal(current().bgImage,installed);
  checks.push('invalid media reports an error beside the button without altering the background');
  const animation=Buffer.alloc(8);animation.writeUInt32BE(2);
  const apng=Buffer.concat([png.subarray(0,33),chunk('acTL',animation),chunk('tEXt',padding),png.subarray(33)]);
  await chooseBytes('large-animation.png',apng);
  await until(()=>current().bgImage!==installed,'large animation not saved');
  assert.ok(fs.readFileSync(path.join(qa.dir,'ui/backgrounds',path.basename(current().bgImage))).equals(apng));
  checks.push('large animated PNG is retained byte for byte');
  if(process.env.QQA_BACKGROUND_TEST_IMAGE){
    const source=process.env.QQA_BACKGROUND_TEST_IMAGE,original=fs.readFileSync(source),previous=current().bgImage;
    await chooseBytes(path.basename(source),original);
    await until(()=>current().bgImage!==previous,'the supplied original image was not saved');
    const decoded=await frame.locator('.bg-stage-img').evaluate(async img=>{await img.decode();return{width:img.naturalWidth,height:img.naturalHeight};});
    assert.deepEqual(decoded,{width:original.readUInt32BE(16),height:original.readUInt32BE(20)});
    assert.ok(fs.readFileSync(path.join(qa.dir,'ui/backgrounds',path.basename(current().bgImage))).equals(original));
    assert.ok(fs.readFileSync(source).equals(original),'the original image must remain untouched');
    await page.screenshot({path:path.join(evidence,'original-large-image.png')});
    checks.push('supplied large original retains its resolution, saves and displays without modifying the source file');
  }
  const videoBytes=fs.readFileSync(new URL('./fixtures/background-loop.webm',import.meta.url));
  fs.writeFileSync(path.join(evidence,'loop.webm'),videoBytes);
  const beforeVideo=current().bgImage;await chooseBytes('loop.webm',videoBytes,'video/webm');
  await until(()=>current().bgImage!==beforeVideo,'video not saved');
  const videoUrl=current().bgImage;assert.match(videoUrl,/\.webm$/);assert.ok(fs.readFileSync(path.join(qa.dir,'ui/backgrounds',path.basename(videoUrl))).equals(videoBytes));
  await page.locator('#background-video').waitFor({state:'attached'});
  await until(()=>page.locator('#background-video').evaluate(v=>!v.paused&&v.currentTime>0&&v.videoWidth===320),'background video not playing');
  assert.deepEqual(await page.locator('#background-video').evaluate(v=>({muted:v.muted,loop:v.loop,inline:v.playsInline})),{muted:true,loop:true,inline:true});
  const looped=await page.locator('#background-video').evaluate(v=>new Promise(resolve=>{let previous=v.currentTime,steps=0;const timer=setInterval(()=>{const now=v.currentTime;if(now<previous-.2){clearInterval(timer);resolve(true);}else if(++steps>45){clearInterval(timer);resolve(false);}previous=now;},100);}));assert.equal(looped,true,'the native video must actually wrap and continue');
  checks.push('real WebM imports unchanged, plays muted and loops past its first ending');
  await frame.locator('details[data-appearance-group=background]>summary').click();
  await until(()=>frame.locator('.bg-stage-video').evaluate(v=>v.paused),'collapsed preview should pause');
  assert.equal(await page.locator('#background-video').evaluate(v=>v.paused),false,'host continues while editor is collapsed');
  await background();await page.locator('#background-video').evaluate(v=>v.dataset.identity='original');await opacity(.36);
  assert.equal(await page.locator('#background-video').getAttribute('data-identity'),'original');assert.equal(await page.locator('#background-video').count(),1);
  checks.push('collapsed previews pause and ordinary theme changes reuse the same host decoder');
  const response=await fetch(qa.base+videoUrl,{headers:{Range:'bytes=0-31'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/webm');assert.deepEqual(Buffer.from(await response.arrayBuffer()),videoBytes.subarray(0,32));
  assert.equal((await fetch(qa.base+videoUrl,{headers:{Range:`bytes=${videoBytes.length+1}-`}})).status,416);
  const head=await fetch(qa.base+videoUrl,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),videoBytes.length);
  checks.push('video HTTP range, invalid ranges and HEAD support native playback and seeking');
  await page.screenshot({path:path.join(evidence,'video-background.png')});
  await page.reload();await page.locator('#nav button[data-panel=settings]').click();await background();assert.equal(current().bgImage,videoUrl);
  await until(()=>page.locator('#background-video').evaluate(v=>!v.paused&&v.currentTime>0),'video not restored after reload');
  const oldVideo=current().bgImage;await choose('image-after-video');await until(()=>current().bgImage!==oldVideo,'image replacement not saved');await paint(.36);assert.equal(await page.locator('#background-video').count(),0);
  checks.push('reload restores video and replacing it with an image releases the video');
  const mp4=fs.readFileSync(new URL('./fixtures/background-loop.mp4',import.meta.url)),beforeMp4=current().bgImage;
  await chooseBytes('loop.mp4',mp4,'video/mp4');await until(()=>current().bgImage!==beforeMp4,'MP4 not saved');
  await until(()=>page.locator('#background-video').evaluate(v=>!v.paused&&v.currentTime>0&&v.videoWidth===320),'MP4 not playing');
  assert.match(current().bgImage,/\.mp4$/);assert.ok(fs.readFileSync(path.join(qa.dir,'ui/backgrounds',path.basename(current().bgImage))).equals(mp4));
  checks.push('H.264 MP4 imports unchanged and plays through the same native background');
  let releaseChunk,announceChunk,finishChunk;
  const heldChunk=new Promise(resolve=>releaseChunk=resolve),enteredChunk=new Promise(resolve=>announceChunk=resolve),chunkDone=new Promise(resolve=>finishChunk=resolve);
  const holdChunk=async route=>{const response=await route.fetch();announceChunk(new URL(route.request().url()).pathname.split('/').at(-2));await heldChunk;try{await route.fulfill({response});}catch{/* the retiring iframe can already have aborted its request */}finally{finishChunk();}};
  await page.route('**/api/uikit/background/uploads/*/chunk',holdChunk);const keptVideo=current().bgImage;
  await chooseBytes('leave-during-original.png',large);const retiringId=await enteredChunk;
  await page.locator('#nav button[data-panel=chats]').click();
  await until(()=>!fs.existsSync(path.join(qa.dir,'ui/background-uploads',`upload-${retiringId}.part`)),'leaving settings did not clean up the partial upload');
  releaseChunk();await chunkDone;await page.unroute('**/api/uikit/background/uploads/*/chunk',holdChunk);
  assert.equal(current().bgImage,keptVideo);await page.locator('#nav button[data-panel=settings]').click();await background();
  checks.push('leaving settings cancels the chunked transfer and reclaims the private partial file');
  const rejected=await qa.request('POST','/api/uikit/background/uploads',{size:MAX_BACKGROUND_SOURCE_BYTES+1});assert.equal(rejected.status,400);
  await assert.rejects(uploadBackgroundFile({size:MAX_BACKGROUND_SOURCE_BYTES+1},{request:()=>assert.fail('oversized file must not start uploading')}),/256MB/);
  assert.equal((await fetch(qa.base+'/api/uikit/background/uploads',{method:'POST',headers:{'content-type':'application/json','x-console-token':'wrong'},body:'{"size":100}'})).status,401);
  const staged=await qa.request('POST','/api/uikit/background/uploads',{size:100}),id=staged.data.id;
  assert.equal((await qa.request('POST',`/api/uikit/background/uploads/${id}/complete`,{})).status,409);
  assert.equal((await qa.request('POST',`/api/uikit/background/uploads/${id}/chunk`,{offset:1,data:'AAAA'})).status,409);
  assert.equal((await qa.request('POST',`/api/uikit/background/uploads/${id}/chunk`,{offset:0,data:'A???'})).status,400);
  const part=path.join(qa.dir,'ui/background-uploads',`upload-${id}.part`);assert.equal(fs.statSync(part).size,0);
  assert.equal((await fetch(qa.base+`/ui/background-uploads/upload-${id}.part`)).status,404);
  await qa.request('DELETE',`/api/uikit/background/uploads/${id}`);assert.equal(fs.existsSync(part),false);
  checks.push('size/authentication/order/base64 guards reject invalid uploads and cancellation removes private partial files');
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,realModelCalls:0,realAccountUsed:false},null,2));
  for(const check of checks)console.log('✓ '+check);
}catch(error){console.error(JSON.stringify(diagnostics));await page.screenshot({path:path.join(evidence,'failure.png')});throw error;}finally{await qa.close();}
