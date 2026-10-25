import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';
const f=await modelUiFixture(),id='2bee208a-3f6f-46a8-8145-fb2222222222';
let state={accounts:[{id:'primary',accountId:'55555555',nickname:'主账号',wanted:true,status:'running',connected:true},{id,accountId:'12345678',nickname:'第二个账号',wanted:true,status:'running',connected:true}],removedAccounts:[]},failure=true;
const removes=[];
try{
 await f.page.route('**/api/accounts',r=>r.fulfill({json:state}));
 await f.page.route('**/api/accounts/remove',async r=>{const body=r.request().postDataJSON();removes.push(body);if(failure)return r.fulfill({status:500,json:{error:'合成移除失败'}});state={accounts:state.accounts.filter(a=>a.accountId!==body.accountId),removedAccounts:[...state.removedAccounts,{accountId:body.accountId}]};await r.fulfill({json:state});});
 await f.page.route('**/api/local-protocols',r=>r.fulfill({json:{root:f.dir,autoStart:false,running:null,providers:[{id:'napcat',items:[{id:'remembered-fixture',provider:'napcat',name:'示例协议端',ready:true,accounts:['12345678']}]}]}}));
 await f.page.reload();await f.frame.locator('#settings-sidebar').waitFor();await settingsSection(f.frame,'onebot');const cards=f.frame.locator('.account-connection-card'),button=f.frame.getByRole('button',{name:'删除账号 第二个账号',exact:true});await button.waitFor();assert.equal(await cards.count(),2);
 await button.click();assert.equal(removes.length,0,'first click only arms removal');await button.click();await f.frame.getByRole('alert').filter({hasText:'合成移除失败'}).waitFor();assert.equal(await cards.count(),2,'failure retains the account');assert.equal(await cards.first().getAttribute('aria-checked'),'true','other account remains connected');
 failure=false;await button.click();await button.click();await button.waitFor({state:'detached'});assert.equal(await cards.count(),1);assert.deepEqual(removes.at(-1),{id,accountId:'12345678'});assert.equal(await cards.first().getAttribute('aria-checked'),'true');
 await f.page.reload();await f.frame.locator('#settings-sidebar').waitFor();await settingsSection(f.frame,'onebot');await f.frame.locator('.account-connection-card[data-qq-account="55555555"]').waitFor();assert.equal(await f.frame.locator('.account-connection-card[data-qq-account="12345678"]').count(),0,'remembered protocol profiles cannot immediately resurrect a removed QQ');
 assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);console.log('✓ Account removal requires two clicks, retains cards on error, uses the root control route and leaves the other account connected across refresh');
}finally{await f.close();}
