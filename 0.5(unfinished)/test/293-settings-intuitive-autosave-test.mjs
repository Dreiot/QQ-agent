import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createAutoSave,flushAutoSaves,hasAutoSaves} from '../ui/panels/settings/auto-save.js';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {openSettingsFold} from './settings-navigation.mjs';

let passed=0;
const check=(condition,label)=>{assert.ok(condition,label);console.log(`✓ ${++passed}. ${label}`);};
const until=async(read,accept,label)=>{for(let n=0;n<120;n++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(label);};
const root=new EventTarget();root.ownerDocument=new EventTarget();root.contains=()=>false;
let desired=1,stored=0,release,started,fail=false;
const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),receipts=[];
const queue=createAutoSave({root,delay:10000,dirty:()=>desired!==stored,save:async()=>{const value=desired;if(value===1){started();await gate;}if(fail){fail=false;throw Error('synthetic rejection');}stored=value;receipts.push(value);}});
queue.schedule();const first=queue.flush();await began;desired=2;queue.schedule();release();await first;
check(stored===2&&receipts.join(',')==='1,2'&&!hasAutoSaves(),'a late receipt cannot discard a newer queued edit');
desired=3;fail=true;queue.schedule();await assert.rejects(queue.flush(),/synthetic rejection/);
check(hasAutoSaves()&&stored===2,'failed writes remain pending and never acknowledge success');
await flushAutoSaves();check(stored===3&&!hasAutoSaves(),'retry and navigation flush commit the retained value');queue.dispose();

const evidence=path.resolve('.qa-local/settings-ux-repair-20261023/acceptance');fs.mkdirSync(evidence,{recursive:true});
const qa=await modelUiFixture({config:{persona:{roleText:'Synthetic original role'},memory:{useChatModel:true,consolidateEnabled:false},webSearch:{enabled:false},blocklist:{'10001':['20001']},proactive:{enabled:false,probability:.25}}});
qa.kernel.registry.register({id:'synthetic_note',name:'记印象',category:'memory',ownerId:'kernel',execute:async()=>({ok:true})});
qa.kernel.registry.register({id:'synthetic_query',name:'查印象',category:'query',ownerId:'kernel',execute:async()=>({ok:true})});
await qa.openSettings();
const {page,frame}=qa;
const section=async id=>{await frame.locator(`#settings-sidebar a[data-target="${id}"]`).click();await frame.locator(`#section-${id}`).waitFor({state:'visible'});};
const saved=()=>frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'attached'});
const read=async url=>(await qa.request('GET',url)).data;
const open=async id=>{await frame.locator(`[data-settings-open="${id}"]`).click();const dialog=frame.locator(`dialog[data-settings-editor="${id}"]`);await dialog.waitFor();return dialog;};
const close=async dialog=>{await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'detached'});};
try{
  check(await frame.locator('#settings-sidebar a').count()===11,'purpose-based sections include independent appearance and privacy');
  check(await frame.getByRole('button',{name:/^保存改动$/}).count()===0,'ordinary settings expose no manual save action');
  const search=frame.getByRole('searchbox',{name:'搜索设置',exact:true});await search.fill('温度');
  await frame.locator('.settings-search-result').getByText('温度',{exact:true}).click();
  const temperature=frame.locator('#field-api-temperature');await temperature.waitFor({state:'visible'});
  await temperature.fill('1.2');await temperature.fill('1.4');await saved();
  await until(()=>qa.disk().api.temperature,value=>value===1.4,'temperature was not saved');
  check(true,'search locates and expands a concrete field; fast input saves the final value');
  let rejectNext=true;
  await page.route('**/api/config/lifecycle',route=>{if(rejectNext){rejectNext=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic write failure'})});}return route.continue();});
  await temperature.fill('1.1');await frame.locator('.settings-save-toast[data-state=error]').waitFor({state:'visible'});
  check(qa.disk().api.temperature===1.4&&await temperature.inputValue()==='1.1','a rejected save preserves input and does not write a false success');
  await frame.getByRole('button',{name:'重试保存',exact:true}).click();await saved();
  await until(()=>qa.disk().api.temperature,value=>value===1.1,'retry was not saved');
  check(true,'floating failure feedback can retry the exact retained settings');
  await page.unroute('**/api/config/lifecycle');

  await section('memory');const memory=frame.getByRole('switch',{name:'自动整理记忆',exact:true});
  check(!/开启|关闭/.test(await memory.innerText()),'switch cards express state without on/off words');
  await memory.click();await saved();await until(()=>qa.disk().memory.consolidateEnabled,value=>value===true,'memory switch was not saved');
  check(await memory.getAttribute('aria-checked')==='true','the full card click updates native accessible state and disk');
  await memory.press('Space');await saved();await until(()=>qa.disk().memory.consolidateEnabled,value=>value===false,'keyboard switch was not saved');
  check(await memory.getAttribute('aria-checked')==='false','keyboard activation follows the same automatic save path');

  await section('chat');await frame.getByRole('slider',{name:'当前响应档位',exact:true}).press('Home');
  await until(()=>qa.disk().store.contextSliderPos,value=>value===0,'response frequency was not saved');
  check(true,'response frequency automatically commits its own transaction');
  const unified=frame.getByRole('checkbox',{name:'所有群统一档位',exact:true});await unified.uncheck();await saved();await until(()=>qa.disk().store.unifiedTier,value=>value===false,'per-group card not saved');await unified.check();await saved();await until(()=>qa.disk().store.unifiedTier,value=>value===true,'unified card not saved');
  check(true,'native header cards save both group-specific and unified modes');
  await frame.getByRole('button',{name:'编辑回复时段',exact:true}).click();const peak=frame.locator('dialog.settings-peak-presets');await peak.waitFor();
  await peak.locator('[data-peak-field=start]').fill('08:30');await peak.locator('[data-peak-field=end]').fill('18:45');await saved();
  await until(()=>read('/api/peak-schedule?target=global'),value=>value.active?.values.start==='08:30'&&value.active?.values.end==='18:45','peak time was not saved');
  check(await peak.getByRole('button',{name:'保存',exact:true}).count()===0,'peak fields automatically save without a separate commit button');
  const schedule=await read('/api/peak-schedule?target=global');
  await peak.locator('article > select').selectOption('group:10001');
  await until(()=>peak.locator('[data-peak-field=peak]').inputValue(),value=>value===String(schedule.global.peak),'inherited group peak displays the wrong value');
  check(await peak.locator('[data-peak-field=valley]').inputValue()===String(schedule.global.valley),'inherited group sliders display the effective global values');
  await peak.locator('article > select').selectOption('global');
  await peak.locator('[data-peak-field=enabled]').waitFor();
  await page.setViewportSize({width:1280,height:800});
  const geometry=await peak.locator('.peak-fields > label').evaluateAll(labels=>labels.map(label=>{const r=label.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};}));
  for(let i=0;i<geometry.length;i++)for(let j=i+1;j<geometry.length;j++){const a=geometry[i],b=geometry[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,'peak controls overlap');}
  await page.screenshot({path:path.join(evidence,'peak-1280.png')});
  check(true,'peak labels and controls do not overlap in a 1280 by 800 viewport');
  await peak.getByRole('button',{name:'完成',exact:true}).click();await peak.waitFor({state:'detached'});
  await page.setViewportSize({width:1360,height:900});
  await frame.locator('details[data-settings-group=layout-proactive] > summary').click();
  await frame.getByRole('switch',{name:'主动发起聊天',exact:true}).click();await saved();
  await frame.locator('#field-proactive-probability').fill('37');await saved();
  check(qa.disk().proactive.probability===.37,'displayed percentages persist precise fractional probabilities');

  await section('models');let manager=await open('model-manager');
  await qa.card('a').getByRole('textbox',{name:'渠道名称',exact:true}).fill('Channel A renamed');await close(manager);
  check((await read('/api/providers')).providers.find(item=>item.id==='a').displayName==='Channel A renamed','closing a channel editor flushes the last edit before dismissal');
  manager=await open('model-manager');await qa.card('a').getByRole('button',{name:'编辑模型 shared',exact:true}).click();
  const modelEditor=frame.locator('dialog:has(input[name=id])');const modelName=modelEditor.locator('input[name=name]');
  const modelLabel=async()=>{const provider=(await read('/api/providers')).providers.find(item=>item.id==='a');return provider.modelNames?.shared||provider.models.find(item=>item.id==='shared')?.name;};
  await modelName.fill('First friendly name');await saved();await until(modelLabel,value=>value==='First friendly name','first model name missing');
  await modelName.fill('Second friendly name');await saved();await until(modelLabel,value=>value==='Second friendly name','second model name missing');
  check(true,'successive model edits advance the comparison baseline without conflicts');
  await modelEditor.getByRole('button',{name:'完成',exact:true}).click();await modelEditor.waitFor({state:'detached'});await close(manager);

  await section('persona');let persona=await open('persona-manager');
  await persona.locator('textarea[name=text]').fill('Synthetic revised role');await persona.locator('textarea[name=customRules]').fill('Synthetic concise rule');await saved();
  await until(()=>qa.disk().persona,value=>value.roleText==='Synthetic revised role'&&value.customRules==='Synthetic concise rule','global persona not saved');
  check(true,'role and response rules automatically save as the current global persona');
  await close(persona);

  await section('chat');await frame.getByRole('button',{name:'按群选择屏蔽成员',exact:true}).click();
  const blocklist=frame.locator('dialog[data-blocklist-members]'),blocked=blocklist.locator('[data-block-uid="20001"] input[data-block-scope=group]');await blocked.waitFor();
  await blocked.uncheck();await saved();await until(()=>qa.disk().blocklist['10001']||[],value=>!value.includes('20001'),'local unblock not saved');
  await blocklist.locator('[data-block-uid="20001"] input[data-block-scope=group]').check();await saved();await until(()=>qa.disk().blocklist['10001']||[],value=>value.includes('20001'),'local block not saved');
  check(true,'member card edits automatically save and retain per-member comparison versions');
  await blocklist.getByRole('button',{name:'完成',exact:true}).click();await blocklist.waitFor({state:'detached'});

  await section('search');const sources=await open('search-manager');
  await sources.locator('input[name=name]').fill('Synthetic Bing');await sources.getByRole('button',{name:'关闭',exact:true}).click();await sources.waitFor({state:'detached'});
  check(qa.disk().webSearch.bing.name==='Synthetic Bing','closing the search manager saves its pending edit');
  await section('access');await frame.getByRole('button',{name:/群聊 ·/}).click();const choices=frame.locator('dialog.settings-list-choice');
  await choices.getByRole('switch').click();await saved();await until(()=>qa.disk().allow.allGroups,value=>value===true,'allow all was not saved');
  await choices.getByRole('switch').click();await saved();await until(()=>qa.disk().allow.allGroups,value=>value===false,'selected-only was not saved');
  check(await choices.isVisible(),'allow-list policy saves repeatedly while keeping the picker open');
  await choices.getByRole('button',{name:'完成',exact:true}).click();await choices.waitFor({state:'detached'});

  await section('appearance');check(await frame.locator('#section-appearance .palette-choice').count()>4,'themes are represented by actual color swatches');
  check(await frame.locator('[data-appearance-group=colors]:not([open])').count()===1,'fine color controls stay collapsed behind the common theme controls');
  await frame.getByRole('button',{name:'0.4 亮色（经典）',exact:true}).click();await saved();
  await frame.getByRole('button',{name:'撤销本次外观调整',exact:true}).click();await saved();
  const frameBackground=await frame.locator('body').evaluate(body=>getComputedStyle(body.ownerDocument.documentElement).getPropertyValue('--bg').trim());
  await page.waitForFunction(background=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()===background,frameBackground);
  check(true,'theme previews persist automatically and can be undone');

  await section('tools');await frame.getByRole('searchbox',{name:'搜索工具',exact:true}).fill('记印象');
  check(await frame.locator('#tool-list > label:visible').count()===1,'tool filtering works with plain-language names');
  await section('models');await openSettingsFold(frame,'layout-model-parameters');await temperature.fill('1.7');
  const beforeNavigation={input:await temperature.inputValue(),status:await frame.locator('#status').innerText()};
  await page.locator('#nav button[data-panel=sessions]').click();
  try{await page.locator('#panel-host iframe[title="会话"]').waitFor();await until(()=>qa.disk().api.temperature,value=>value===1.7,'navigation lost the last edit');}catch(error){fs.writeFileSync(path.join(evidence,'navigation.json'),JSON.stringify({beforeNavigation,persisted:qa.disk().api.temperature,writes:qa.writes.map(row=>({path:row.path,temperature:row.body?.patch?.api?.temperature??row.body?.api?.temperature})).filter(row=>row.temperature!==undefined),errors:qa.errors},null,2));throw error;}
  check(true,'leaving settings flushes a final edit before the debounce expires');
  await qa.openSettings();await section('desktop');await frame.locator('details[data-settings-group=layout-console-connection] > summary').click();
  await frame.getByRole('button',{name:'管理控制台访问令牌',exact:true}).click();const token=page.getByRole('dialog',{name:'控制台访问令牌',exact:true});
  await token.getByRole('textbox',{name:'新访问令牌',exact:true}).fill('synthetic-settings-auto-token');
  await until(()=>qa.disk().server.token,value=>value==='synthetic-settings-auto-token','token auto-save failed');
  await page.locator('.settings-save-toast[data-state=saved]').waitFor({state:'visible'});
  check(true,'host-owned token edits automatically save and confirm authentication before success');
  await token.getByRole('button',{name:'关闭',exact:true}).click();
  check(qa.errors.length===0&&qa.outbound()===0,'all flows finish without page errors or external service calls');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,errors:qa.errors,outbound:qa.outbound()},null,2));
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')});throw error;}finally{await qa.close();}
console.log(`Settings UX: ${passed} checks passed`);
