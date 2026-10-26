// One schema must survive scheme storage, the public iframe DTO and real CSS.
import assert from 'node:assert/strict';
import {
  PERSONALIZATION_FIELDS as fields, PERSONALIZATION_GROUPS as groups, DEFAULT_THEME,
  normalizePersonalization, normalizeTheme, normalizeScheme, migrateUikit, resolveScheme,
  saveCustom, resetSlot, publicPanelTheme, applyTheme,
} from '../ui/panels/theme.js';

const checks=[];
const keys=fields.map(field=>field.key);
assert.equal(new Set(keys).size,keys.length);
assert.ok(fields.length>=55);
for(const field of fields){
  assert.ok(groups.some(group=>group.id===field.group),field.key+' has a visible group');
  assert.equal(normalizePersonalization({})[field.key],field.default);
  if(field.type==='range'){
    assert.equal(normalizePersonalization({[field.key]:field.max+1e4})[field.key],field.max);
    assert.equal(normalizePersonalization({[field.key]:field.min-1e4})[field.key],field.min);
    for(const value of [null,'',Infinity,NaN,true,'2px;display:none'])assert.equal(normalizePersonalization({[field.key]:value})[field.key],field.default,field.key);
  }
  if(field.type==='color')assert.equal(normalizePersonalization({[field.key]:'red; background:url(https://invalid.test)'})[field.key],'');
  if(field.type==='select')assert.equal(normalizePersonalization({[field.key]:'url(https://invalid.test)'})[field.key],field.default);
  if(field.type==='boolean')assert.equal(normalizePersonalization({[field.key]:'false'})[field.key],field.default);
}
checks.push('all '+fields.length+' settings share unique keys, defaults, groups and bounded values; CSS-shaped input is rejected');

const edits=Object.fromEntries(fields.map(field=>[field.key,field.type==='range'?field.max:field.type==='boolean'?false:field.type==='color'?'#2468ac':field.type==='font'?'Microsoft YaHei':field.options.at(-1).value]));
const flat=migrateUikit(edits);
for(const key of keys)assert.equal(resolveScheme(flat)[key],edits[key],key+' survives old flat storage');
const mixed=migrateUikit({...edits,mode:'dark',dark:{fontSize:14,rail:'#112233'}});
assert.equal(resolveScheme(mixed).fontSize,14);
assert.equal(resolveScheme(mixed).rail,'#112233');
const saved=saveCustom({mode:'light'},'Detailed appearance',edits);
for(const key of keys)assert.equal(resolveScheme(saved.store)[key],edits[key],key+' survives custom scheme storage');
assert.equal(normalizeScheme({hoverColor:''},{...DEFAULT_THEME,hoverColor:'#123456'}).hoverColor,'','automatic colors can replace an explicit base paint');
for(const key of keys)assert.equal(resolveScheme(resetSlot({mode:'dark',dark:edits},'dark'))[key],DEFAULT_THEME[key],key+' resets to factory default');
checks.push('flat and mixed migration, custom themes, automatic color reset and factory reset preserve every setting');

const paint=publicPanelTheme({...edits,token:'must never cross',privateState:{key:'never'},bgImage:'https://invalid.test/hidden.png',fontFamily:'serif'});
for(const key of keys)assert.equal(paint[key],key==='fontFamily'?'serif':edits[key],key+' reaches isolated panels');
assert.equal(paint.token,undefined);assert.equal(paint.privateState,undefined);assert.equal(paint.bgImage,undefined);
checks.push('isolated panels receive all appearance fields through the paint-only DTO without private configuration');

const vars=new Map();
const oldDocument=globalThis.document;
globalThis.document={documentElement:{style:{setProperty:(key,value)=>vars.set(key,value)}},body:{dataset:{}}};
try{
  applyTheme({...DEFAULT_THEME,radius:10,radiusButton:-1,radiusInput:0,radiusCard:18,radiusDialog:24,iconMotionEnabled:false,interfaceMotionEnabled:false,rippleEnabled:false,rippleColor:'#123abc',rippleSpread:16,rippleSpeed:2});
  assert.equal(vars.get('--radius-button'),'7px');assert.equal(vars.get('--radius-input'),'0px');
  assert.equal(vars.get('--radius-card'),'18px');assert.equal(vars.get('--radius-dialog'),'24px');
  assert.equal(vars.get('--motion-duration-factor'),'0');assert.equal(vars.get('--motion-scale'),'0');
  assert.equal(globalThis.document.body.dataset.iconMotion,'off');assert.equal(globalThis.document.body.dataset.interfaceMotion,'off');
  assert.equal(globalThis.document.body.dataset.rippleMotion,'off');
  assert.equal(vars.get('--ripple-color'),'#123abc');assert.equal(vars.get('--ripple-spread'),'16px');assert.equal(vars.get('--ripple-speed'),'2');
  applyTheme({...DEFAULT_THEME,hoverColor:'#123456',focusColor:'#abcdef',motionDuration:1.5,motionScale:1.6});
  assert.equal(vars.get('--hover-color'),'#123456');assert.equal(vars.get('--focus'),'#abcdef');
  assert.equal(vars.get('--motion-base'),'330ms');assert.equal(vars.get('--press-scale'),String(1-.015*1.6));
}finally{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
checks.push('independent radii, palette states, icon toggle and interface animation preferences paint independent bounded tokens');

if(!process.argv.includes('--pure-only')){
  const {modelUiFixture}=await import('./model-ui-fixture.mjs');
  const fixture=await modelUiFixture();
  try{
    const theme={...DEFAULT_THEME,fontSize:16,fontFamily:'serif',fontWeight:500,headingWeight:800,headingScale:1.2,lineHeight:1.9,letterSpacing:.5,controlHeight:48,controlFontSize:17,inputFontSize:16,radiusButton:20,radiusInput:12,radiusCard:22,radiusDialog:28,buttonShape:'round',borderWidth:2,cardPadding:28,listGap:20,tablePaddingX:22,tablePaddingY:18,tableFontSize:16,dialogWidth:800,dialogPadding:36,overlayOpacity:.7,backdropBlur:6,focusColor:'#ff9900',focusWidth:3,sidebarWidth:300,navigationFontSize:17,navigationHeight:60,topbarHeight:64,hoverColor:'#3366ff',hoverTint:25,selectedColor:'#cc3399',selectedTint:30};
    await fixture.page.evaluate(async theme=>{const mod=await import('/panels/theme.js');mod.writeTheme(theme,{persist:false});},theme);
    await fixture.frame.locator('body').evaluate(async(body,theme)=>{
      const mod=await import('/panels/theme.js');mod.writeTheme(theme,{persist:false});
      const host=document.createElement('section');host.id='qa296';host.innerHTML='<button id="qa-button" class="primary">Button</button><button id="qa-compact" style="min-height:24px;font-size:11px;padding:2px">Compact action</button><input id="qa-input"><h3 id="qa-title">Title</h3><div class="card" id="qa-card">Card</div><div class="list" id="qa-list"><div>1</div><div>2</div></div><table><tbody><tr><td id="qa-cell">Cell</td></tr></tbody></table><dialog id="qa-dialog">Dialog</dialog>';body.append(host);
      document.querySelector('#qa-dialog').showModal();
    },theme);
    const actual=await fixture.frame.locator('body').evaluate(body=>{
      const css=id=>getComputedStyle(document.getElementById(id)),button=css('qa-button'),input=css('qa-input'),card=css('qa-card'),cell=css('qa-cell'),dialog=css('qa-dialog');
      return{bodySize:getComputedStyle(body).fontSize,family:getComputedStyle(body).fontFamily,weight:getComputedStyle(body).fontWeight,lineHeight:getComputedStyle(body).lineHeight,buttonSize:button.fontSize,buttonHeight:button.minHeight,buttonRadius:button.borderRadius,clip:button.clipPath,inputSize:input.fontSize,inputRadius:input.borderRadius,cardRadius:card.borderRadius,cardPadding:card.padding,cardBorder:card.borderTopWidth,listGap:css('qa-list').rowGap,cellSize:cell.fontSize,cellPadding:cell.padding,dialogWidth:dialog.width,dialogPadding:dialog.padding,dialogRadius:dialog.borderRadius,overlay:getComputedStyle(document.getElementById('qa-dialog'),'::backdrop').backgroundColor,blur:getComputedStyle(document.getElementById('qa-dialog'),'::backdrop').backdropFilter,focus:getComputedStyle(document.documentElement).getPropertyValue('--focus')};
    });
    assert.equal(actual.bodySize,'16px');assert.match(actual.family,/serif/);assert.equal(actual.weight,'500');assert.equal(actual.lineHeight,'30.4px');
    assert.equal(actual.buttonSize,'17px');assert.equal(actual.buttonHeight,'48px');assert.equal(actual.buttonRadius,'20px');assert.equal(actual.clip,'none');
    assert.equal(actual.inputSize,'16px');assert.equal(actual.inputRadius,'12px');assert.equal(actual.cardRadius,'22px');assert.equal(actual.cardPadding,'28px');assert.equal(actual.cardBorder,'2px');
    assert.equal(actual.listGap,'20px');assert.equal(actual.cellSize,'16px');assert.equal(actual.cellPadding,'18px 22px');
    assert.equal(actual.dialogWidth,'800px');assert.equal(actual.dialogPadding,'36px');assert.equal(actual.dialogRadius,'28px');assert.match(actual.overlay,/0\.7/);assert.equal(actual.blur,'blur(6px)');assert.equal(actual.focus,'#ff9900');
    const compact=await fixture.frame.locator('#qa-compact').evaluate(async button=>{
      const {applyTheme,DEFAULT_THEME}=await import('/panels/theme.js');
      const read=()=>({size:getComputedStyle(button).fontSize,height:getComputedStyle(button).minHeight});
      const adjusted=read();applyTheme(DEFAULT_THEME);const original=read();return{adjusted,original};
    });
    assert.deepEqual(compact,{adjusted:{size:'17px',height:'48px'},original:{size:'11px',height:'24px'}});
    await fixture.page.locator('.rail').evaluate(async rail=>{await Promise.allSettled(rail.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished));});
    const shell=await fixture.page.evaluate(()=>({rail:getComputedStyle(document.querySelector('.rail')).width,navSize:getComputedStyle(document.querySelector('.nav-label')).fontSize,navHeight:getComputedStyle(document.querySelector('#nav button')).minHeight,topbar:getComputedStyle(document.querySelector('.topbar')).minHeight}));
    assert.equal(shell.rail,'300px');assert.equal(shell.navSize,'17px');assert.equal(shell.navHeight,'60px');assert.equal(shell.topbar,'64px');
    checks.push('real shell and iframe CSS consume typography, controls, independent radii, cards, lists, tables, dialogs, overlay and navigation settings; local compact controls keep factory dimensions until customized');

    const motion=await fixture.frame.locator('body').evaluate(async body=>{
      document.getElementById('qa-dialog').close();
      const {applyTheme,DEFAULT_THEME}=await import('/panels/theme.js');const {createConditionalMotion}=await import('/panels/settings/conditional-motion.js');
      const host=document.createElement('div'),el=document.createElement('div');el.textContent='Motion';host.append(el);body.append(host);
      applyTheme({...DEFAULT_THEME,motionDuration:2});const controller=createConditionalMotion(document);controller.set(el,false);controller.set(el,true);
      const duration=el.getAnimations().find(item=>item.animationName==='settings-options-appear')?.effect.getTiming().duration;
      controller.set(el,false);applyTheme({...DEFAULT_THEME,interfaceMotionEnabled:false});await new Promise(resolve=>requestAnimationFrame(resolve));
      const stopped=el.hidden&&!el.dataset.conditionalPhase;
      controller.set(el,true);const immediate=!el.hidden&&!el.dataset.conditionalPhase;
      controller.dispose();host.remove();document.getElementById('qa296').remove();
      return{duration,stopped,immediate};
    });
    assert.equal(motion.duration,440);assert.equal(motion.stopped,true);assert.equal(motion.immediate,true);
    checks.push('conditional reveals use the requested duration and settle immediately when interface motion is disabled during playback');
    await fixture.page.emulateMedia({reducedMotion:'reduce'});
    const reduced=await fixture.frame.locator('body').evaluate(async body=>{
      const {applyTheme,DEFAULT_THEME}=await import('/panels/theme.js');const {createConditionalMotion}=await import('/panels/settings/conditional-motion.js');
      applyTheme({...DEFAULT_THEME,interfaceMotionEnabled:true,motionDuration:2});
      const host=document.createElement('div'),el=document.createElement('div');host.append(el);body.append(host);
      const controller=createConditionalMotion(document);controller.set(el,false);controller.set(el,true);
      const immediate=!el.hidden&&!el.dataset.conditionalPhase;controller.set(el,false);const hidden=el.hidden;controller.dispose();host.remove();return{immediate,hidden};
    });
    assert.deepEqual(reduced,{immediate:true,hidden:true});
    checks.push('operating-system reduced motion takes precedence over enabled interface effects and a longer requested duration');
  }finally{await fixture.close();}
}
for(const check of checks)console.log('✓ 296 '+check);
console.log(`✓ 296 ${checks.length} personalization contracts passed (${fields.length} editable fields)`);
