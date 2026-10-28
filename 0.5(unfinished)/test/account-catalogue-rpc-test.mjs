// Real scoped iframes and real loader. Two module URLs intentionally share the
// same frame nonce to reproduce the previous parallel-response id collision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';

const child='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',prefix='/accounts/'+child;
const source=fs.readFileSync(new URL('../ui/panels/skills/panel.js',import.meta.url),'utf8');
const probe=`\nimport {request as aliasRequest} from '/panels/panel-client.js';
  Promise.all([aliasRequest('GET','/api/skills'),request('GET','/api/extensions/updates')])
    .then(([catalogue,updates])=>{window.__catalogueAliasProbe={catalogue:Array.isArray(catalogue.skills),updates:Array.isArray(updates.updates),skills:catalogue.skills?.filter(x=>x.kind==='skill').map(x=>x.id)};})
    .catch(error=>{window.__catalogueAliasProbe={error:error.message};});\n`;
const f=await modelUiFixture(),{page,frame}=f;
fs.writeFileSync(path.join(f.appRoot,'ui/panels/skills/panel.js'),source+probe);
const observed=[],results=[];
try{
  for(const kind of ['skill','plugin']){
    const id='catalogue-'+kind,root=kind==='skill'?'skills':'plugins',dir=path.join(f.appRoot,root,id);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,kind+'.json'),JSON.stringify({id,kind,apiVersion:1,name:'合成'+kind,settings:{tag:'default'},configSchema:{tag:{type:'string'}}}));
    fs.writeFileSync(path.join(dir,'index.js'),'export function setup(){}');await f.kernel.loader.loadDir(root,dir);
  }
  await page.route('**/api/accounts',r=>r.fulfill({json:{accounts:[{id:'primary',nickname:'合成主账号',connected:true,status:'running'},{id:child,nickname:'合成第二账号',accountId:'100002',connected:true,status:'running',paused:true}]}}));
  await page.route('**/api/accounts/events',r=>r.fulfill({status:200,contentType:'text/event-stream',body:'event: accounts\ndata: {}\n\n'}));
  await page.route('**'+prefix+'/**',async route=>{
    const url=new URL(route.request().url());observed.push({path:url.pathname,method:route.request().method()});
    if(url.pathname===prefix+'/api/extensions/updates')return route.fulfill({json:{updates:[],availableCount:0,checking:false}});
    if(url.pathname===prefix+'/api/skills')await new Promise(r=>setTimeout(r,120));
    url.pathname=url.pathname.slice(prefix.length);await route.continue({url:url.href});
  });
  await page.goto(f.base+'/?account='+child+'&panel=skills');
  const card=frame.locator('[data-extension-id="catalogue-skill"]');await card.waitFor();
  const probeResult=await frame.locator('body').evaluate(async()=>{for(let i=0;i<150&&!window.__catalogueAliasProbe;i++)await new Promise(r=>setTimeout(r,20));return window.__catalogueAliasProbe;});
  assert.deepEqual(probeResult,{catalogue:true,updates:true,skills:['catalogue-skill']});
  assert.match(await frame.locator('#meta').innerText(),/^1 项 · 已加载 1/);
  assert.equal(await frame.locator('[data-extension-id="catalogue-plugin"]').count(),0);
  for(let i=0;i<3;i++){
    f.kernel.bus.emit('status',{configUpdated:true});await page.waitForTimeout(220);
    assert.match(await frame.locator('#meta').innerText(),/^1 项/);assert.equal(await card.count(),1);
  }
  await card.getByRole('button',{name:'停用',exact:true}).click();await card.getByRole('button',{name:'启用',exact:true}).waitFor();
  assert.equal(f.kernel.config.get().skills['catalogue-skill'].enabled,false);
  await card.getByRole('button',{name:'启用',exact:true}).click();await frame.locator('dialog.confirm-panel').getByRole('button',{name:'确认',exact:true}).click();await card.getByRole('button',{name:'停用',exact:true}).waitFor();
  await card.getByRole('button',{name:'设置',exact:true}).click();const settings=frame.locator('dialog');await settings.locator('input').fill('child-saved');await settings.getByRole('button',{name:'保存修改',exact:true}).click();await settings.waitFor({state:'hidden'});
  assert.equal(f.kernel.config.get().skills['catalogue-skill'].settings.tag,'child-saved');
  await page.locator('#nav button[data-panel=plugins]').click();await frame.locator('[data-extension-id="catalogue-plugin"]').waitFor();assert.equal(await frame.locator('[data-extension-id="catalogue-skill"]').count(),0);
  await page.locator('#nav button[data-panel=skills]').click();await card.waitFor();assert.match(await frame.locator('#meta').innerText(),/^1 项/);
  await page.reload();await card.waitFor();assert.match(await frame.locator('#meta').innerText(),/^1 项/);
  assert.ok(observed.some(x=>x.path===prefix+'/api/skills/catalogue-skill'&&x.method==='POST'));
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
  results.push('scoped parallel catalogue/update responses stay separate with two client module URLs','count and cards survive status, navigation and browser reload','enable/disable and settings reach the scoped account');
  console.log('✓ account catalogue RPC: '+results.join('; '));
}finally{await f.close();}
