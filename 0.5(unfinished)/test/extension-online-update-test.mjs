import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extensionUpdateFixture,pack,packageFiles,source} from './extension-update-fixture.mjs';
import {compareVersions,normalizeUpdateSource} from '../src/kernel/extension-update-source.js';
const wait=async(read,label)=>{for(let i=0;i<200;i++){if(await read())return;await new Promise(r=>setTimeout(r,10));}throw Error(label);};
for(const [a,b,value]of [['v1.2.0','1.1.9',1],['1.0.0','1.0.0+build.2',0],['1.0.0-rc.1','1.0.0',-1],['1.0.0-rc.10','1.0.0-rc.2',1],['1.2.0','2.0.0',-1]])assert.equal(compareVersions(a,b),value);
for(const bad of [{type:'github',repo:'../repo',asset:'a.zip'},{type:'github',repo:'a/b',asset:'../a.zip'},{type:'github',repo:'a/b',asset:'a.exe'},{type:'url',url:'http://localhost'}])assert.throws(()=>normalizeUpdateSource(bad));
assert.throws(()=>compareVersions('1.0','1.0.0'));console.log('✓ strict version ordering and public-source metadata');
const f=await extensionUpdateFixture();
try{
 const dir=await f.install(),original=fs.readFileSync(path.join(dir,'index.js'),'utf8');f.offer();
 await f.install({id:'local-only',update:null});
 assert.equal((await f.api('/api/extensions/updates')).body.updates.find(r=>r.id==='local-only').status,'manual');assert.equal(f.calls.length,0);
 let checked=await f.api('/api/extensions/updates/check',{});assert.equal(checked.status,200);let offer=checked.body.updates.find(r=>r.id==='online-one');assert.equal(offer.status,'available');assert.equal(f.calls.filter(c=>!c.url.includes('api.github')).length,0);assert.ok(f.events.some(e=>e.available.some(r=>r.id==='online-one')));
 const before=f.calls.length;await f.controller.check('online-one');assert.equal(f.calls.length,before,'cached automatic checks do not poll');
 for(const body of [{},{confirmed:false,checkId:offer.checkId},{confirmed:true,checkId:'stale'}])assert.equal((await f.api('/api/extensions/online-one/update',body)).status,body.confirmed===true?409:400);
 assert.equal(f.calls.length,before);assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),original);console.log('✓ check only, persistent notice, TTL, manual-only fallback and explicit confirmation');
 const scope=f.kernel.storage?.namespace?.('online-one');scope?.set('marker','keep');
 let applied=await f.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId});assert.equal(applied.status,200,JSON.stringify(applied));assert.equal(applied.body.version,'1.1.0');assert.equal(await f.kernel.registry.get('online-one__value').execute(),'1.1.0');assert.equal(f.kernel.config.get().skills['online-one'].settings.greeting,'preserved');assert.equal(f.kernel.config.get().skills['online-one'].settings.apiKey,'synthetic-own-secret');assert.equal(applied.body.skill.settings.apiKey,'******');assert.ok(fs.existsSync(path.join(f.root,applied.body.backup)));if(scope)assert.equal(scope.get('marker'),'keep');
 assert.equal((await f.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId})).status,409);console.log('✓ real HTTP download, ZIP replacement, helper module reload, backup, settings and data preservation');
 const check=async()=>{const r=await f.api('/api/extensions/updates/check',{id:'online-one'});assert.equal(r.status,200);assert.equal(r.body.update.status,'available',JSON.stringify(r.body));return r.body.update;};
 const reject=async expected=>{const o=await check(),r=await f.api('/api/extensions/online-one/update',{confirmed:true,checkId:o.checkId});assert.ok(r.status>=400,JSON.stringify(r));assert.match(r.body.error,expected);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'skill.json'),'utf8')).version,'1.1.0');assert.equal(await f.kernel.registry.get('online-one__value').execute(),'1.1.0');};
 f.offer('online-one',{version:'1.2.0',digest:'sha256:'+'0'.repeat(64)});await reject(/校验/);
 for(const options of [{id:'wrong-id'},{kind:'plugin'},{version:'1.4.0'},{update:{...source,repo:'different/repo'}}]){f.offer('online-one',{version:'1.2.0',bytes:pack(packageFiles({version:'1.2.0',...options}))});await reject(/身份|类型|版本|来源/);}
 f.offer('online-one',{version:'1.2.0',bytes:pack({'../escape.js':'unsafe'})});await reject(/ZIP|路径|越界/);assert.equal(fs.existsSync(path.join(f.root,'escape.js')),false);
 f.offer('online-one',{version:'1.2.0',broken:true});await reject(/已恢复原版/);console.log('✓ checksum, identity, kind, version, source, traversal guards and actual setup-failure rollback');
 f.offer('online-one',{version:'1.2.0'});offer=await check();fs.appendFileSync(path.join(dir,'helper.js'),'\n// local edit');applied=await f.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId});assert.equal(applied.status,409);assert.match(fs.readFileSync(path.join(dir,'helper.js'),'utf8'),/local edit/);console.log('✓ local edits cannot be overwritten by stale approvals');
 await f.install({id:'disabled-one',enabled:false});f.offer('disabled-one',{version:'1.2.0',code:"throw Error('disabled code must not execute');"});const disabled=(await f.api('/api/extensions/updates/check',{id:'disabled-one'})).body.update;applied=await f.api('/api/extensions/disabled-one/update',{confirmed:true,checkId:disabled.checkId});assert.equal(applied.status,200,JSON.stringify(applied));assert.equal(applied.body.enabled,false);assert.equal(f.kernel.loader.isActive('disabled-one'),false);console.log('✓ disabled extensions update without being enabled or imported');
 f.errors({release:403});const error=await f.api('/api/extensions/updates/check',{id:'online-one'});assert.equal(error.body.update.status,'error');assert.match(error.body.update.error,/受限/);console.log('✓ upstream failures remain retryable and never replace local code');
}finally{await f.close();}
const automatic=await extensionUpdateFixture({autoDelay:20,watch:true});
try{automatic.offer();await automatic.install();await wait(()=>automatic.events.some(e=>e.available.some(r=>r.id==='online-one')),'automatic notice');assert.equal(automatic.calls.filter(c=>!c.url.includes('api.github')).length,0);
 let release;automatic.holdDownload(new Promise(r=>release=r));const offer=automatic.controller.snapshot().updates.find(r=>r.id==='online-one');const pending=automatic.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId});await wait(()=>automatic.calls.some(c=>c.url.includes('releases/download')),'download begins');
 assert.equal((await automatic.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId})).status,409);
 for(const [route,body]of [['/api/skills/online-one',{enabled:false}],['/api/skills/online-one/hot-reload',{}],['/api/skills/online-one/delete',{}]])assert.equal((await automatic.api(route,body)).status,409);
 release();assert.equal((await pending).status,200);assert.equal(await automatic.kernel.registry.get('online-one__value').execute(),'1.1.0');console.log('✓ automatic detection, confirmation boundary, concurrent action rejection and filesystem watcher coordination');
}finally{await automatic.close();}
const authorization=await extensionUpdateFixture();
try{
 await authorization.install({permissions:['net.outbound']});authorization.offer('online-one',{permissions:['net.outbound']});
 const old=authorization.kernel.loader.hostEntry('online-one').fingerprint;authorization.kernel.permissions.setOverride('online-one','net.outbound','allow',{fingerprint:old});assert.equal(authorization.kernel.permissions.isGranted('online-one','net.outbound'),true);
 const offer=(await authorization.api('/api/extensions/updates/check',{id:'online-one'})).body.update;
 const result=await authorization.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId});assert.equal(result.status,200);assert.equal(result.body.needsReauthorize,true);assert.equal(authorization.kernel.permissions.isGranted('online-one','net.outbound'),false);assert.notEqual(result.body.skill.fingerprint,old);console.log('✓ new code receives no inherited host permission and returns the new authorization identity');
}finally{await authorization.close();}
const cancellation=await extensionUpdateFixture();let releaseCanceled;
try{
 const dir=await cancellation.install();cancellation.offer();const offer=(await cancellation.api('/api/extensions/updates/check',{id:'online-one'})).body.update;
 cancellation.holdDownload(new Promise(r=>releaseCanceled=r));const pending=cancellation.api('/api/extensions/online-one/update',{confirmed:true,checkId:offer.checkId});await wait(()=>cancellation.calls.some(c=>c.url.includes('releases/download')),'cancel download starts');await cancellation.controller.close();assert.ok((await pending).status>=400);releaseCanceled();assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'skill.json'),'utf8')).version,'1.0.0');console.log('✓ shutdown cancels a noncooperative download before touching local files');
}finally{releaseCanceled?.();await cancellation.close();}
console.log('Extension online updates: all isolated checks passed; no real network or QQ actions.');
