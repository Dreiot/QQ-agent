import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {buildAuthoringPrompt} from '../ui/panels/extension-authoring-prompt.js';

const root=path.resolve(import.meta.dirname,'..'),metadataFiles=['docs/plugin-sdk.md','docs/architecture-composition.md','docs/extension-authoring.md','docs/extension-reference.md','docs/v04-extension-parity.md','docs/ai-extension-prompt.md'],pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
for(const file of [...metadataFiles,'scripts/inspect-composition.mjs']){assert.ok(fs.existsSync(path.join(root,file)),file);assert.ok(pkg.build.files.includes(file),`packaged guide must include ${file}`);}
const context={appRoot:'C:\\Synthetic Project\\app'},neutralPrompt=buildAuthoringPrompt({context});
for(const kind of ['auto','skill','plugin','composition']) {
  const prompt=buildAuthoringPrompt({kind,requirements:'obsolete <script>not executed</script>',publishRequested:true,context});
  assert.equal(prompt,neutralPrompt,'obsolete entry hints, requirement fields and publication options cannot alter the current contract');
}
assert.equal(buildAuthoringPrompt({context:{appRoot:'   '}}),buildAuthoringPrompt());
assertInterviewPrompt(neutralPrompt,{appRoot:context.appRoot});
const documented=fs.readFileSync(path.join(root,'docs/ai-extension-prompt.md'),'utf8').match(/```text\r?\n([\s\S]*?)```/)?.[1];
assert.equal(documented?.replaceAll('\r\n','\n'),buildAuthoringPrompt(),'the standalone copyable contract matches the UI contract exactly apart from the known appRoot');
const copiedFromEmptyEntries=[];
function assertInterviewPrompt(prompt,{appRoot}={}) {
  assert.match(prompt,/你想让机器人学会什么/);
  assert.match(prompt,/复述/);assert.match(prompt,/明确[\s\S]{0,20}确认|确认[\s\S]{0,20}明确/);assert.match(prompt,/等待|停下来/);
  assert.match(prompt,/每次只问1到3个/);assert.match(prompt,/不要问我要做skill还是plugin/);
  assert.match(prompt,/已有明确确认的摘要[\s\S]{0,30}不重复/);
  const gate=prompt.match(/在我明确确认这份摘要之前[\s\S]*?\n/)?.[0]||'';
  for(const blocked of ['读取开发文档','生成代码','安装','打包'])assert.ok(gate.includes(blocked),`before confirmation the AI must not ${blocked}`);
  assert.ok(prompt.indexOf('【第一步')<prompt.indexOf('docs/extension-authoring.md'));
  for(const file of metadataFiles)assert.ok(prompt.includes(file),`current development contract ${file}`);
  assert.match(prompt,/技能（skill）：主要由模型理解用户请求后按需调用/);
  assert.match(prompt,/插件（plugin）：主要由消息事件、固定规则、定时任务或启停生命周期驱动/);
  assert.match(prompt,/技能和插件都可能注册工具或自有面板/);
  assert.match(prompt,/不根据我从哪个页面复制提示词来决定/);
  assert.match(prompt,/仍有歧义就问我日常使用例子/);
  for(const location of ['skills/<id>/','plugins/<id>/','skill.json','plugin.json'])assert.ok(prompt.includes(location));
  assert.match(prompt,/初稿和最终交付清单都必须保持enabledByDefault:false/);
  assert.match(prompt,/禁止替我点击启用、写入enabled:true、修改配置以启用或自动批准权限/);
  assert.match(prompt,/不在用户运行中的宿主启用新扩展/);
  assert.match(prompt,/本次不要登录社区、上传作品或公开发布/);
  assert.match(prompt,/只有我另有打包需求时/);assert.match(prompt,/不要求我下载ZIP再安装/);
  assert.match(prompt,/不能悄悄把普通包升级为覆盖层/);
  for(const operation of ['extension-dev.mjs check','extension-dev.mjs test','extension-dev.mjs pack'])assert.ok(prompt.includes(operation));
  if(appRoot)assert.ok(prompt.includes(JSON.stringify(appRoot)));
}
const f=await modelUiFixture();let release,appended;
const configBeforeAuthoring=fs.readFileSync(f.kernel.config.file,'utf8');
const importMarker='__qa194AuthoringImports';
try {
  const metadata=await f.request('GET','/api/extensions/authoring-context');assert.equal(metadata.status,200);assert.equal(metadata.data.appRoot,f.appRoot);assert.deepEqual(Object.keys(metadata.data).sort(),['appRoot','docs','version']);assert.deepEqual(metadata.data.docs,metadataFiles);assert.equal(JSON.stringify(metadata.data).includes('synthetic-key'),false);
  assert.equal((await fetch(f.base+'/api/extensions/authoring-context')).status,401);
  const dialog=()=>f.frame.locator('dialog.authoring-guide');
  const prompt=()=>dialog().getByRole('textbox',{name:'给AI的提示词'});
  async function copyActualPrompt(panel) {
    assert.equal(await dialog().getByRole('combobox').count(),0,'no extension direction or delivery options');
    assert.equal(await dialog().getByRole('textbox').count(),1,'no requirement form precedes the AI interview');
    assert.equal(await prompt().getAttribute('readonly'),'','the only textbox is the reusable prompt');
    assert.equal(await prompt().evaluate(node=>node.scrollTop),0,'reading the project location must leave the prompt at its beginning');
    assert.match(await dialog().innerText(),/新功能默认禁用，由你在列表中点击启用/);
    await dialog().evaluate(()=>{window.__qaClipboard=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__qaClipboard.push(value);}}});});
    await dialog().getByRole('button',{name:'复制提示词',exact:true}).click();await dialog().getByRole('status').filter({hasText:'提示词已复制'}).waitFor();
    const copied=await dialog().evaluate(()=>window.__qaClipboard);
    assert.equal(copied.length,1);assert.equal(copied[0],await prompt().inputValue());
    assertInterviewPrompt(copied[0],{appRoot:f.appRoot});
    copiedFromEmptyEntries.push({panel,appRoot:f.appRoot,prompt:copied[0]});
    return copied[0];
  }
  for(const panel of ['skills','plugins','community']) {
    await f.page.locator('#nav button[data-panel='+panel+']').click();
    await f.frame.getByRole('button',{name:'创作扩展',exact:true}).click();
    await dialog().getByRole('status').filter({hasText:'已读取项目位置'}).waitFor();
    const copied=await copyActualPrompt(panel);
    assert.equal(copied,copiedFromEmptyEntries[0].prompt,'all three entry points give the AI the same neutral contract');
    // Exercise denial/fallback without changing the real OS clipboard.
    await dialog().evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('synthetic denied');}}});document.execCommand=()=>false;});
    await dialog().getByRole('button',{name:'复制提示词',exact:true}).click();await dialog().getByRole('status').filter({hasText:'请按Ctrl+C'}).waitFor();
    assert.equal(await prompt().evaluate(node=>node.selectionEnd-node.selectionStart),copied.length);
    await dialog().getByRole('button',{name:'关闭',exact:true}).click();
  }
  await f.page.locator('#nav button[data-panel=skills]').click();
  const reject=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic metadata failure'})});await f.page.route(f.base+'/api/extensions/authoring-context',reject);
  await f.frame.getByRole('button',{name:'创作扩展',exact:true}).click();await dialog().getByRole('status').filter({hasText:'可重试'}).waitFor();
  assert.equal(await prompt().inputValue(),buildAuthoringPrompt());assertInterviewPrompt(await prompt().inputValue());
  await f.page.unroute(f.base+'/api/extensions/authoring-context',reject);
  await dialog().getByRole('button',{name:'重试读取位置',exact:true}).click();await dialog().getByRole('status').filter({hasText:'已读取项目位置'}).waitFor();
  assert.equal(await prompt().inputValue(),copiedFromEmptyEntries[0].prompt);
  await dialog().getByRole('button',{name:'关闭',exact:true}).click();
  let entered;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const hold=async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});};await f.page.route(f.base+'/api/extensions/authoring-context',hold);
  await f.frame.getByRole('button',{name:'创作扩展',exact:true}).click();await started;
  const oldReply=f.page.waitForResponse(r=>r.url()===f.base+'/api/extensions/authoring-context').then(r=>r.finished());
  await dialog().getByRole('button',{name:'关闭',exact:true}).click();release();await oldReply;assert.equal(await dialog().count(),0);
  assert.deepEqual(f.writes.filter(r=>r.path!=='/api/console/bootstrap'&&!(r.method==='POST'&&r.path==='/api/config/lifecycle/open')),[],'the guide never installs, enables, grants permissions or publishes');
  assert.equal(fs.readFileSync(f.kernel.config.file,'utf8'),configBeforeAuthoring);
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);

  // Verify the promised directory-first delivery against the real host, not a ZIP
  // installer or a config preset. Both final manifests remain disabled by default.
  fs.writeFileSync(path.join(f.appRoot,'package.json'),'{"type":"module"}');
  for(const kind of ['skill','plugin']) {
    const id='qa-authoring-local-'+kind,dir=path.join(f.appRoot,kind+'s',id),stage=path.join(f.dir,'stage-'+kind);
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage,kind+'.json'),JSON.stringify({id,name:'Local '+kind,kind,version:'1.0.0',apiVersion:1,entry:'index.js',enabledByDefault:false,permissions:[]}));
    fs.writeFileSync(path.join(stage,'index.js'),`globalThis.${importMarker}??={};globalThis.${importMarker}['${id}']=(globalThis.${importMarker}['${id}']||0)+1;export default {setup(ctx){ctx.registerTool({name:'echo',description:'Synthetic local delivery check',parameters:{type:'object',properties:{}},handler:()=>({ok:true})});}};`);
    fs.renameSync(stage,dir);
  }
  for(let pass=0;pass<2;pass++) {
    assert.equal((await f.request('POST','/api/skills/reload',{})).status,200);
    const listing=await f.request('GET','/api/skills');
    for(const kind of ['skill','plugin']) {
      const id='qa-authoring-local-'+kind,item=listing.data.skills.find(item=>item.id===id);
      assert.ok(item);assert.equal(item.kind,kind);assert.equal(item.dir,path.join(f.appRoot,kind+'s',id));
      assert.equal(item.enabled,false);assert.equal(item.loaded,false);assert.equal(item.code,'disabled');
      assert.deepEqual(f.kernel.registry.byOwner(id),[]);
      assert.equal(globalThis[importMarker]?.[id],undefined,'rescan must not import or execute newly delivered disabled code');
      assert.equal(f.kernel.config.get().skills?.[id],undefined,'directory delivery does not create an enabling config override');
    }
  }
  for(const kind of ['skill','plugin']) {
    const id='qa-authoring-local-'+kind;
    const enabled=await f.request('POST','/api/skills/'+id,{enabled:true});
    assert.equal(enabled.status,200);assert.equal(enabled.data.skill.enabled,true);assert.equal(enabled.data.skill.loaded,true);
    assert.equal(globalThis[importMarker][id],1,'only explicit activation imports the extension');
    assert.equal(f.kernel.registry.byOwner(id).length,1);
    assert.equal((await f.request('POST','/api/skills/'+id,{enabled:false})).status,200);
    assert.deepEqual(f.kernel.registry.byOwner(id),[]);
  }
  assert.equal(f.outbound(),0);await f.close();
  appended=await modelUiFixture({uiAssetPath:'panels/extension-authoring.js',uiAsset:`export function bindAuthoringGuide({parent,kind='auto'}){const button=document.createElement('button');button.textContent='追加创作入口';button.onclick=()=>{button.dataset.overrideKind=kind;};parent.append(button);return button;} export function openAuthoringGuide(){}`});
  for(const [panel,kind] of [['skills','skill'],['plugins','plugin'],['community','auto']]) {
    await appended.page.locator('#nav button[data-panel='+panel+']').click();const control=appended.frame.getByRole('button',{name:'追加创作入口',exact:true});await control.click();assert.equal(await control.getAttribute('data-override-kind'),kind);
    assert.equal(await appended.frame.locator(panel==='community'?'#pane-account':'#tab-market').isVisible(),true,'unrelated market navigation remains');
  }
  assert.deepEqual(appended.errors,[]);assert.equal(appended.outbound(),0);
  if(process.env.QA_AUTHORING_PROMPT_EVIDENCE_DIR){
    const evidenceDir=path.resolve(process.env.QA_AUTHORING_PROMPT_EVIDENCE_DIR),relative=path.relative(root,evidenceDir);
    assert.ok(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
    fs.mkdirSync(evidenceDir,{recursive:true});
    const entries=copiedFromEmptyEntries.map(entry=>({...entry,sha256:createHash('sha256').update(entry.prompt).digest('hex')}));
    for(const entry of entries)fs.writeFileSync(path.join(evidenceDir,`browser-empty-${entry.panel}.txt`),entry.prompt);
    fs.writeFileSync(path.join(evidenceDir,'browser-empty-prompts.json'),JSON.stringify({source:'actual browser clipboard callback',generatedAt:new Date().toISOString(),environmentNote:'appRoot belongs to the isolated browser fixture and is removed after this test',entries},null,2)+'\n');
  }
  console.log('✓ authoring guide: three identical copy-only entry points, AI interview/type selection, final disabled local delivery, optional ZIP/no publication, clipboard fallback, metadata retry/late close, no guide business writes; real skill/plugin directories stay unexecuted across rescans until explicit activation; append override preserved');
} finally {release?.();delete globalThis[importMarker];await appended?.close();await f.close();}

