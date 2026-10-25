import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const f=await modelUiFixture({marketClientFactory:()=>({listAccounts:()=>({accounts:[]})}),transport:{id:'modal-fixture',start(){},stop(){},status:()=>({connected:true,selfId:'90000'}),actions:{listGroups:async()=>[{id:'10001',group_id:'10001',name:'合成验证群'}],listFriends:async()=>[{id:'20001',user_id:'20001',name:'合成联系人'}],getGroupMembers:async()=>[{user_id:20001,nickname:'合成成员',card:'合成名片'}]}}}),{page,frame}=f;
const dir=path.resolve('.qa-local/visual-realtime-20261024/modals');fs.mkdirSync(dir,{recursive:true});const records=[];
const settle=()=>page.waitForTimeout(420);
async function inspect(name,root=frame){
 const dialog=root.locator('dialog[open]').last();await dialog.waitFor();await settle();
 const heading=await dialog.evaluate(n=>({label:n.getAttribute('aria-label')||n.ownerDocument.getElementById(n.getAttribute('aria-labelledby'))?.textContent,managed:n.hasAttribute('data-managed-dialog')}));assert.ok(heading.label,`${name} accessible name`);assert.ok(heading.managed,`${name} managed lifecycle`);
 const buttons=await dialog.locator('button').allTextContents();
 for(const [width,height]of [[1360,900],[640,720],[390,700]]){
   await page.setViewportSize({width,height});await settle();
   const box=await dialog.evaluate(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:n.scrollWidth-n.clientWidth};});
   assert.ok(box.x>=-1&&box.y>=-1&&box.right<=box.width+1&&box.bottom<=box.height+1,`${name} ${width} viewport containment ${JSON.stringify(box)}`);
   assert.ok(box.overflow<=2,`${name} ${width} horizontal overflow ${box.overflow}`);
   if(width===1360||width===390)await page.screenshot({path:path.join(dir,`${name}-${width}.png`)});
 }
 await page.setViewportSize({width:1360,height:900});await settle();records.push({name,label:heading.label,buttons});console.log('✓ 304 '+name);
}
async function close(root=frame){const dialog=root.locator('dialog[open]').last(),dismiss=dialog.getByRole('button',{name:'关闭弹窗',exact:true});if(await dismiss.count())await dismiss.click();else await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});}
try{
 const plugin=path.join(f.appRoot,'plugins','qa-visual-modal');fs.mkdirSync(plugin,{recursive:true});fs.writeFileSync(path.join(plugin,'plugin.json'),JSON.stringify({id:'qa-visual-modal',kind:'plugin',name:'弹窗验证',version:'1.0.0',apiVersion:1,entry:'index.js',permissions:[]}));fs.writeFileSync(path.join(plugin,'index.js'),'export default {setup(){}};');await f.kernel.loader.loadDir('plugins',plugin);
 f.kernel.memory.append('group:10001',{userId:'20001',name:'合成成员',content:'先核对事实，再清楚表达。'});
 f.kernel.store.appendIncoming('group:10001',{mid:'visual-modal',senderId:'20001',senderName:'合成成员',text:'只用于本机视觉检查的合成消息。'});
 const sample=f.kernel.sessions.create('group:10001',{trigger:'合成用量示例'});f.kernel.sessions.update(sample,{providerId:'a',model:'shared',messages:[{role:'assistant',content:'完成示例'}],usage:{calls:1,promptTokens:100,completionTokens:30,totalTokens:130,cachedTokens:20}});f.kernel.sessions.finish(sample.id,'done');
 await f.openSettings();
 for(const section of ['onebot','models','access','persona','chat','memory','search','tools','appearance','security','desktop']){
  await settingsSection(frame,section);await settle();
  const ids=await frame.locator(`#section-${section} [data-settings-open]`).evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>n.dataset.settingsOpen));
  for(const id of ids){await frame.locator(`[data-settings-open="${id}"]`).click();await inspect(id);await close();}
 }
 await settingsSection(frame,'appearance');await frame.getByRole('button',{name:'预览弹窗',exact:true}).click();await inspect('component-preview');await close();
 // Exercise leaf factories shared by nested editors as well, with read-only
 // local fixtures. Do not save, publish, grant permissions or install anything.
 const leaves=['provider','model-add','model-catalog','model-selector','model-prices','fallbacks','group-response','catalog-import','search-source','group-choice','friend-choice','peak-presets','blocklist-members','persona-chat','extension-settings','confirmation'];
 for(const name of leaves){
  await frame.locator('body').evaluate(async(_node,name)=>{
   const {request}=await import('/panels/panel-client.js'),noop=async()=>{},config=await request('GET','/api/config'),providers=(await request('GET','/api/providers')).providers;
   const form={value:key=>key.split('.').reduce((value,part)=>value?.[part],config)};
   const common={request,form,providers,provider:providers[0],queue(){},save:noop,render(){},reload:noop,beforeWrite:noop,changed:noop,cleared:noop};
   if(name==='provider')(await import('/panels/settings/provider-editor.js')).openProviderEditor(common);
   if(name==='model-add')(await import('/panels/settings/model-catalog.js')).addProviderModel(common);
   if(name==='model-catalog')(await import('/panels/settings/model-catalog.js')).openModelCatalog(common);
   if(name==='model-selector')(await import('/panels/settings/model-selector-view.js')).shell('选择模型','qa-selector');
   if(name==='model-prices'){window.__modalEditor=(await import('/panels/settings/model-prices.js')).createModelPriceEditor({request,providers:()=>providers});await window.__modalEditor.open();}
   if(name==='fallbacks')(await import('/panels/settings/spec-editors.js')).editFallbacks(common);
   if(name==='group-response')await(await import('/panels/settings/spec-editors.js')).editGroupResponse(common);
   if(name==='catalog-import')(await import('/panels/settings/spec-editors.js')).importCatalog(common);
   if(name==='search-source')(await import('/panels/settings/spec-editors.js')).editSearchProvider({...common,provider:{}});
   if(name.endsWith('-choice'))(await import('/panels/settings/list-choice.js')).openListChoice({kind:name==='group-choice'?'groups':'friends',load:async()=>name==='group-choice'?{groups:[{id:'10001',name:'合成群'}]}:{friends:[{id:'20001',name:'合成好友'}]},getSelected:()=>[],commit:noop});
   if(name==='peak-presets'){window.__modalEditor=(await import('/panels/settings/peak-presets.js')).createPeakPresetEditor({request});await window.__modalEditor.open();}
   if(name==='blocklist-members'){window.__modalEditor=(await import('/panels/settings/blocklist-members.js')).createBlocklistMembers({request});await window.__modalEditor.open();}
   if(name==='persona-chat'){window.__modalEditor=(await import('/panels/settings/persona-by-chat.js')).createPersonaByChatUI({request});const host=document.createElement('div');document.body.append(host);window.__modalEditor.mount(host);await window.__modalEditor.refresh();host.querySelector('[data-persona-chat="group:10001"] .persona-chat-choice').click();}
   if(name==='extension-settings')(await import('/panels/extension-manager.js')).settingsDialog({id:'qa-settings',name:'扩展示例',settings:{level:2},configSchema:{level:{type:'number',label:'等级',min:0,max:10}}},noop);
   if(name==='permissions')await(await import('/panels/ui.js')).managePermissions({id:'qa-visual-modal',name:'扩展示例'});
   if(name==='confirmation')void(await import('/panels/ui.js')).confirmAction('确认示例操作？');
  },name);
  await inspect(name);await close();await frame.locator('body').evaluate(()=>{window.__modalEditor?.dispose?.();window.__modalEditor=null;});
 }
 await page.locator('#nav [data-panel=plugins]').click();await frame.locator('body').evaluate(async()=>{await(await import('/panels/ui.js')).managePermissions({id:'qa-visual-modal',name:'扩展示例'});});await inspect('permissions');await close();
 await page.locator('#nav [data-panel=sessions]').click();await frame.getByRole('button',{name:'群发测试',exact:true}).click();await inspect('session-broadcast');await close();
 await page.locator('#nav [data-panel=memory]').click();await frame.getByRole('button',{name:'新增聊天记忆',exact:true}).click();await inspect('memory-new');await close();
 await frame.locator('[data-memory-chat="group:10001"] strong').click();await frame.getByRole('button',{name:'新增成员',exact:true}).click();await inspect('memory-member-new');await close();
 await frame.getByRole('button',{name:'编辑印象',exact:true}).click();await inspect('memory-member-edit');await close();
 await frame.getByRole('button',{name:'编辑备注',exact:true}).click();await inspect('memory-member-note');await close();
 await frame.getByRole('button',{name:'成员列表',exact:true}).click();await inspect('memory-group-members');await close();
 await page.locator('#nav [data-panel=chats]').click();await frame.locator('[data-chat="group_10001"] strong').click();await frame.getByRole('button',{name:'选择消息',exact:true}).click();await frame.locator('.messages input[type=checkbox]').first().check();await frame.locator('#quote-preview').click();await inspect('quote-preview');await close();
 await page.locator('#nav [data-panel=usage]').click();await frame.getByRole('button',{name:'查看工具调用',exact:true}).click();await inspect('usage-tools');await close();
 await frame.locator('#days tbody button').first().click();await inspect('usage-breakdown');await close();
 await f.openSettings();await settingsSection(frame,'desktop');await frame.locator('details[data-settings-group=layout-console-connection] > summary').click();await frame.getByRole('button',{name:'管理控制台访问令牌',exact:true}).click();await inspect('console-token',page);await close(page);
 for(const id of ['skills','plugins','community']){
  await page.locator(`#nav [data-panel=${id}]`).click();await frame.getByRole('button',{name:'创作扩展',exact:true}).click();await inspect(`${id}-authoring`);await close();
 }
 await frame.getByRole('button',{name:'意见收集',exact:true}).click();await inspect('feedback');await close();
 await frame.getByRole('button',{name:'验证码诊断',exact:true}).click();await inspect('captcha-diagnostics',page);await close(page);
 fs.writeFileSync(path.join(dir,'inventory.json'),JSON.stringify(records,null,2));assert.deepEqual(f.errors,[]);console.log(`✓ 304 ${records.length} modal entry points, three window sizes, accessible labels and disposable closure`);
}finally{fs.writeFileSync(path.join(dir,'inventory.json'),JSON.stringify(records,null,2));await f.close();}
