import test from 'node:test';
import assert from 'node:assert/strict';
import {installedFonts,registerLocalFontRoutes} from '../src/console/local-fonts.js';
import {normalizePersonalization,publicPanelTheme} from '../ui/panels/theme.js';
import {normalizeVisualValue} from '../ui/panels/visual-style.js';
test('OS font enumeration uses a fixed command and returns unique family names',async()=>{
  let called;const families=await installedFonts({platform:'win32',execute:async(...args)=>{called=args;return {stdout:'["中文字体","A & B (Text)","中文字体",null,"bad\\u0000name"]'};}});
  assert.deepEqual(families,['中文字体','A & B (Text)'].sort((a,b)=>a.localeCompare(b,'zh-CN')));assert.equal(called[0],'powershell.exe');assert.equal(called[2].windowsHide,true);
  assert.ok(called[1].at(-1).includes('InstalledFontCollection'));
});
test('font list caches and coalesces requests; failures remain recoverable',async()=>{
  let handler,refresh,calls=0;registerLocalFontRoutes({route(_m,path,fn){if(path.endsWith('/refresh'))refresh=fn;else handler=fn;}},{enumerate:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return ['字体'];}});
  const [a,b]=await Promise.all([handler({query:{}}),handler({query:{}})]);assert.equal(calls,1);assert.deepEqual(a,b);await handler({query:{}});assert.equal(calls,1);await handler({query:{refresh:'1'}});assert.equal(calls,2);
  await refresh();assert.equal(calls,3);
  registerLocalFontRoutes({route(_m,path,fn){if(!path.endsWith('/refresh'))handler=fn;}},{enumerate:async()=>{throw Error('private OS detail');}});const fail=await handler({query:{}});assert.equal(fail.available,false);assert.ok(!fail.error.includes('private'));
});
test('local font names survive paint DTO and reject CSS/control injection',()=>{
  const p=normalizePersonalization({bodyFont:'字体 (Text)',titleFont:'A & B',codeFont:'Consolas'});assert.equal(publicPanelTheme(p).bodyFont,p.bodyFont);assert.equal(publicPanelTheme(p).titleFont,p.titleFont);
  for(const name of ['x; color:red','x\nbackground','x{}','<style>','x\\y'])assert.equal(normalizePersonalization({bodyFont:name}).bodyFont,'');
  assert.equal(normalizeVisualValue('fontFamily','"A & B (Text)", sans-serif'),'"A & B (Text)", sans-serif');assert.equal(normalizeVisualValue('fontFamily','x; color:red'),null);
});
