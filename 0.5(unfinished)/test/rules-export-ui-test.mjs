import assert from 'node:assert/strict';
import fs from 'node:fs';
import {modelUiFixture} from './model-ui-fixture.mjs';

const rule={id:'export-source',name:'#sl / 导出:测试',enabled:false,groups:['12345'],private:['77777'],cooldownSeconds:30,nodes:[
  {id:'start',type:'message',config:{},next:'match'},
  {id:'match',type:'text_match',config:{match:'equals',text:'#sl'},bindings:{content:{nodeId:'start',port:'text'}},next:'record',otherwise:'$end'},
  {id:'record',type:'note',config:{text:'测试保存：中文与 #sl'},next:'$end'},
],layout:{version:1,positions:{start:{x:20,y:30},match:{x:340,y:30},record:{x:660,y:30}}}};
const f=await modelUiFixture({config:{management:{rules:[rule]}}}),{page,frame}=f;
const until=async fn=>{const end=Date.now()+8000;while(!await fn()){if(Date.now()>end)throw Error('Rule export/import timeout');await new Promise(resolve=>setTimeout(resolve,20));}};
try{
  assert.ok(!(await page.locator('#panel-host iframe').getAttribute('sandbox')).split(' ').includes('allow-downloads'),'unrelated panels keep downloads disabled');
  await page.locator('#nav button[data-panel=rules]').click();await frame.locator('.management-toolbar').waitFor();
  assert.ok(!(await page.locator('#panel-host iframe').getAttribute('sandbox')).split(' ').includes('allow-downloads'),'rule files are downloaded by the host while the frame stays isolated');
  const before=structuredClone(f.disk().management.rules[0]);
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:2500}),frame.getByRole('button',{name:'导出',exact:true}).click()]);
  assert.equal(await download.failure(),null);assert.match(download.suggestedFilename(),/\.json$/);assert.ok(!/[<>:"/\\|?*]/.test(download.suggestedFilename()));
  const file=await download.path(),payload=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(payload.format,'qqa-management-v1');assert.deepEqual(payload.rule,before,'download must contain all nodes, bindings, scope and positions');assert.deepEqual(f.disk().management.rules,[before],'export must not change the source rule');
  await frame.locator('.management-toolbar input[type=file]').setInputFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:fs.readFileSync(file)});
  await until(()=>f.disk().management.rules.length===2);
  const imported=f.disk().management.rules[1];assert.notEqual(imported.id,before.id);assert.equal(imported.enabled,false);assert.deepEqual({...imported,id:before.id},before,'the exported file must import without losing any rule data');
  await frame.getByLabel('规则名称',{exact:true}).fill('最新编辑');
  const [latest]=await Promise.all([page.waitForEvent('download',{timeout:2500}),frame.getByRole('button',{name:'导出',exact:true}).click()]);
  assert.equal(await latest.failure(),null);assert.equal(latest.suggestedFilename(),'最新编辑.json');assert.equal(JSON.parse(fs.readFileSync(await latest.path(),'utf8')).rule.name,'最新编辑','export includes the field currently being edited');
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  console.log('PASS rules export: actual sandboxed download, safe filename, latest edits, complete fields, import round trip and unchanged source');
}finally{await f.close();}
