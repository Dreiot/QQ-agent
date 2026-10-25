// Real Chromium selection-driven icons in an opaque synthetic panel; no API/storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ICON_NAMES } from '../ui/panels/icons.js';
const root = path.resolve(import.meta.dirname, '..');
const evidenceDir = path.join(root, '.qa-local/icon-redesign-20261023');
fs.mkdirSync(evidenceDir, { recursive: true });
const names = [...ICON_NAMES, 'unknown'];
const statusFamilies = ['onebot', 'model'];
for (const family of statusFamilies) for (const state of ['ready', 'pending']) assert.ok(ICON_NAMES.includes('status-' + family + '-' + state));
const fixture = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/panels/common.css"><style>.gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.gallery button{color:var(--accent)}.extras{display:none}body[data-sidebar="hidden"] #css-rail{display:none}body.navigation-peek #css-rail{display:block}</style><main><div class="gallery" role="tablist" aria-label="Icon pages"></div><input id="blur-target" aria-label="Ordinary field"><details id="icon-details" data-icon-active="false" open><summary id="icon-details-summary" data-icon-active="false">Summary </summary><div id="icon-details-content">Content </div></details><button id="budget-a">Ordinary A</button><button id="budget-b">Ordinary B</button><aside id="css-rail"><button id="css-hidden-owner">CSS rail</button></aside><button id="nested-visibility-owner">Visible owner <span id="nested-icon-wrapper"></span></button><a id="selected-link" href="#selection">Page link</a><p id="empty-preview" class="empty">Empty preview</p><div class="extras"></div></main><script type="module">
import{createIcon}from'/panels/icons.js';import{installIconMotion}from'/panels/icon-motion.js';import{writeTheme,DEFAULT_THEME}from'/panels/theme.js';
for(const name of ${JSON.stringify(names)}){const button=document.createElement('button');button.id='icon-'+name;button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-selected','false');button.append(createIcon(name==='unknown'?'<img onerror=alert(1)>':name,{size:28}),document.createTextNode(name));button.addEventListener('click',()=>window.chooseIcon(name));document.querySelector('.gallery').append(button);}
for(let i=0;i<120;i++)document.querySelector('.extras').append(createIcon('plugins'));
document.querySelector('#icon-details-summary').append(createIcon('settings'));
document.querySelector('#icon-details-content').append(createIcon('memory'));
for(const id of ['budget-a','budget-b'])for(let i=0;i<6;i++)document.querySelector('#'+id).append(createIcon('usage'));
document.querySelector('#css-hidden-owner').append(createIcon('sessions'));
document.querySelector('#nested-icon-wrapper').append(createIcon('plugins'));
document.querySelector('#selected-link').append(createIcon('chats'));
window.clearSelection=()=>{document.activeElement?.blur?.();for(const node of document.querySelectorAll('[aria-selected],[aria-current],[data-icon-active]')){if(node.hasAttribute('aria-selected'))node.setAttribute('aria-selected','false');node.removeAttribute('aria-current');if(node.hasAttribute('data-icon-active'))node.dataset.iconActive='false';}};
window.chooseIcon=name=>{window.clearSelection();document.querySelector('#icon-'+name).setAttribute('aria-selected','true');};
window.restorePluginGlyph=()=>document.querySelector('#icon-plugins').append(createIcon('plugins',{size:28}));
window.iconEffects=()=>document.getAnimations().filter(a=>a.effect?.target?.closest?.('.qq-icon'));
window.effectsFor=id=>window.iconEffects().filter(a=>document.getElementById(id)?.contains(a.effect.target));
window.iconStill=()=>[...document.querySelectorAll('.qq-icon,.qq-icon [data-icon-part],.qq-icon [data-icon-orbit]')].every(node=>getComputedStyle(node).transform==='none');
window.iconCleanup=installIconMotion();window.reinstallIconMotion=()=>{window.iconCleanup=installIconMotion();};window.changeIconTheme=accent=>writeTheme({...DEFAULT_THEME,accent},{persist:false});window.qaIconReady=true;
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<!doctype html><button id="outside">Outside</button><iframe id="panel" sandbox="allow-scripts" src="/fixture" style="display:block;width:960px;height:680px;border:0"></iframe>'); return; }
  if (url.pathname === '/fixture') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(fixture); return; }
  if (!url.pathname.startsWith('/panels/')) { res.writeHead(404);res.end();return; }
  const base = path.join(root,'ui/panels'), file = path.resolve(base, url.pathname.slice('/panels/'.length)), relative = path.relative(base,file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404);res.end();return; }
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const playwright = createRequire(import.meta.url)('playwright-core');
const cache = path.join(process.env.LOCALAPPDATA,'ms-playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9))).map(name=>path.join(cache,name,'chrome-win64/chrome.exe')).find(file=>fs.existsSync(file));
const result = { recordedAt: new Date().toISOString(), method: 'Real Chromium selected tab/current page/explicit opt-in semantics in an opaque fixture. Document visibility uses a controlled flag; no OS scheduling or FPS claim.', semantic: [], errors: [] };
let browser;
try {
  browser = await playwright.chromium.launch({ executablePath, headless:true });
  const context = await browser.newContext({ viewport:{width:1100,height:800} });
  await context.addInitScript(()=>{
    window.iconProbe={observers:0,disconnects:0,activeObservers:0,peakObservers:0,iconRafCalls:0};
    const NativeObserver=window.MutationObserver,nativeRaf=window.requestAnimationFrame.bind(window);
    window.MutationObserver=class extends NativeObserver {
      constructor(fn){super(fn);this.qaIconObserver=new Error().stack.includes('/panels/icon-motion.js');if(this.qaIconObserver){window.iconProbe.observers++;window.iconProbe.activeObservers++;window.iconProbe.peakObservers=Math.max(window.iconProbe.peakObservers,window.iconProbe.activeObservers);}}
      disconnect(){if(this.qaIconObserver&&!this.qaDisconnected){this.qaDisconnected=true;window.iconProbe.disconnects++;window.iconProbe.activeObservers--;}super.disconnect();}
    };
    window.requestAnimationFrame=fn=>{if(new Error().stack.includes('/panels/icon-motion.js'))window.iconProbe.iconRafCalls++;return nativeRaf(fn);};
  });
  const page = await context.newPage(); page.on('pageerror', error=>result.errors.push(error.message));
  await page.route('**/*', route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await page.goto(base);const frame=page.frames().find(frame=>frame.url().endsWith('/fixture')),panel=page.frameLocator('#panel');
  await frame.waitForFunction(()=>window.qaIconReady===true);
  const waitActive=id=>frame.waitForFunction(id=>window.effectsFor(id).length>0,id);
  const waitStill=()=>frame.waitForFunction(()=>window.iconEffects().length===0);
  const clear=async()=>{await frame.evaluate(()=>window.clearSelection());await waitStill();};
  const select=async(id,attribute='aria-selected',value='true')=>{await frame.evaluate(({id,attribute,value})=>{window.clearSelection();document.getElementById(id).setAttribute(attribute,value);},{id,attribute,value});await waitActive(id);};
  assert.equal(await frame.evaluate(()=>document.querySelectorAll('.qq-icon').length),names.length+137);
  assert.equal(await frame.evaluate(()=>window.iconProbe.observers),1,'Many glyphs share one document observer');
  assert.equal(await frame.evaluate(()=>window.iconEffects().length),0);
  assert.equal(await frame.evaluate(()=>window.iconStill()),true);
  result.glyphStructure=await frame.evaluate(()=>[...document.querySelectorAll('.gallery .qq-icon')].map(node=>({tag:node.tagName.toLowerCase(),name:node.dataset.iconMotion,classValid:node.classList.contains('icon-'+node.dataset.iconMotion),roles:[...node.querySelectorAll('[data-icon-role]')].map(part=>part.dataset.iconRole),stroke:node.getAttribute('stroke')})));
  assert.equal(result.glyphStructure.length,names.length);
  assert.ok(result.glyphStructure.every(glyph=>glyph.tag==='svg'&&glyph.classValid&&glyph.roles.length>0&&glyph.stroke==='currentColor'),'Every allowlisted glyph, brand and empty-state symbol uses one role-addressed currentColor SVG');
  result.statusShapes=await frame.evaluate(families=>families.map(family=>({family,...Object.fromEntries(['ready','pending'].map(state=>{const svg=document.querySelector('#icon-status-'+family+'-'+state+' svg');return[state,{paths:[...svg.querySelectorAll('path')].map(part=>part.getAttribute('d')),readyFill:svg.querySelector('[data-icon-role="ready"]')?.getAttribute('fill')??null,hasGap:!!svg.querySelector('[data-icon-role="gap"]')}];}))})),statusFamilies);
  for(const pair of result.statusShapes){
    assert.notDeepEqual(pair.ready.paths,pair.pending.paths,pair.family+' readiness differs in geometry, not only color');
    assert.equal(pair.ready.readyFill,'currentColor');assert.equal(pair.ready.hasGap,false);
    assert.equal(pair.pending.readyFill,null);assert.equal(pair.pending.hasGap,true);
  }
  for(const name of names){
    await panel.locator('#icon-'+name).hover();
    assert.equal(await frame.evaluate(()=>window.iconEffects().length),0,'Unselected hover never starts a glyph');
  }
  await page.locator('#outside').focus();await page.keyboard.press('Tab');
  await frame.waitForFunction(()=>document.activeElement?.id==='icon-sessions');
  assert.equal(await panel.locator('#icon-sessions').evaluate(button=>button.matches(':focus-visible')),true);
  await waitActive('icon-sessions');
  assert.ok(await frame.evaluate(()=>window.effectsFor('icon-sessions').every(a=>a.playState==='running')),'A page tab loops throughout visible keyboard focus');
  await panel.locator('#budget-a').hover();await panel.locator('#budget-a').focus();
  await frame.evaluate(()=>{document.querySelector('#budget-a').classList.add('active');document.body.dataset.iconActive='true';});
  assert.equal(await frame.evaluate(()=>window.iconEffects().length),0,'Ordinary action buttons remain static even inside an opted-in ancestor');
  await clear();
  for(const name of names){
    await panel.locator('#icon-'+name).click();await waitActive('icon-'+name);
    const effects=await frame.evaluate(id=>window.effectsFor(id).map(animation=>({duration:animation.effect.getTiming().duration,iterations:animation.effect.getTiming().iterations===Infinity?'infinite':animation.effect.getTiming().iterations,target:animation.effect.target.tagName,part:animation.effect.target.dataset.iconPart??null,role:animation.effect.target.dataset.iconRole??animation.effect.target.dataset.iconMotion??null})),'icon-'+name);
    assert.ok(effects.length>0&&effects.length<=3,name+' has bounded simple semantic effects');
    assert.ok(effects.every(effect=>effect.iterations==='infinite'&&(name==='emblem'?effect.duration===1000:effect.duration>=1400&&effect.duration<=2400)&&effect.role),'Selected motion addresses semantic parts within its bounded cycle duration; the brand advances eight generations per second');
    if(name==='memory')assert.deepEqual(effects.map(effect=>effect.role),['portrait'],'Only the member portrait moves, not the surrounding impression records');
    if(name==='usage')assert.deepEqual(effects.map(effect=>effect.role).sort(),['meter-a','meter-b','meter-c']);
    if(name==='settings')assert.deepEqual(effects.map(effect=>effect.role).sort(),['control-a','control-b','control-c']);
    result.semantic.push({name,effects});
    await clear();assert.equal(await frame.evaluate(()=>window.iconStill()),true);
  }
  // Freeze native effects at sampled phases, then inspect the actual SVG paths
  // through their transformed screen matrices. This includes the largest user
  // motion/stroke choices rather than only comparing two still screenshots.
  await frame.evaluate(()=>{document.body.style.setProperty('--icon-motion-scale','1.8');document.body.style.setProperty('--icon-stroke','3');});
  result.canvasSamples=[];
  for(const name of names){
    await select('icon-'+name);
    const sample=await frame.evaluate(id=>{
      const svg=document.querySelector('#'+id+' svg'),box=svg.getBoundingClientRect(),effects=window.effectsFor(id);
      const bounds={left:box.left,top:box.top,right:box.right,bottom:box.bottom};
      const failures=[];let samples=0;
      for(let phase=0;phase<16;phase++){
        for(const effect of effects){effect.pause();effect.currentTime=effect.effect.getTiming().duration*phase/16;}
        for(const path of svg.querySelectorAll('path')){
          const matrix=path.getScreenCTM(),style=getComputedStyle(path),radius=style.stroke==='none'?0:parseFloat(style.strokeWidth)*Math.hypot(matrix.a,matrix.b)/2;
          const length=path.getTotalLength();
          for(let step=0;step<=128;step++){
            const p=path.getPointAtLength(length*step/128),point=new DOMPoint(p.x,p.y).matrixTransform(matrix);samples++;
            if(point.x-radius<bounds.left-.4||point.x+radius>bounds.right+.4||point.y-radius<bounds.top-.4||point.y+radius>bounds.bottom+.4){failures.push({role:path.dataset.iconRole,phase,point:{x:point.x-bounds.left,y:point.y-bounds.top},radius});break;}
          }
        }
      }
      const frames=effects.map(a=>a.effect.getKeyframes());
      return{samples,failures,holds:frames.flatMap(parts=>parts.slice(1).filter((p,i)=>p.d!==undefined?p.d===parts[i].d:p.transform===parts[i].transform)).length,opacity:frames.some(parts=>parts.some(p=>p.opacity!==undefined))};
    },'icon-'+name);
    assert.deepEqual(sample.failures,[],name+' stays within its canvas at the largest motion and stroke');
    assert.equal(sample.holds,0,name+' has no repeated idle-tail frames');
    assert.equal(sample.opacity,false,name+' remains legible without opacity flashing');
    result.canvasSamples.push({name,samples:sample.samples});await clear();
  }
  await frame.evaluate(()=>{document.body.style.removeProperty('--icon-motion-scale');document.body.style.removeProperty('--icon-stroke');});
  await select('icon-settings');
  result.personalization=await frame.evaluate(()=>{
    const svg=document.querySelector('#icon-settings svg');return{width:svg.getBoundingClientRect().width,stroke:getComputedStyle(svg).strokeWidth,duration:window.effectsFor('icon-settings')[0].effect.getTiming().duration};
  });
  await frame.evaluate(()=>{document.body.style.setProperty('--icon-size','30px');document.body.style.setProperty('--icon-stroke','2.5');document.body.style.setProperty('--icon-motion-speed','2');});
  await frame.waitForFunction(()=>window.effectsFor('icon-settings')[0]?.effect.getTiming().duration===1000);
  assert.equal(await panel.locator('#icon-settings svg').evaluate(svg=>svg.getBoundingClientRect().width),42,'Global icon size retains the 28/20 page-tab hierarchy');
  assert.equal(await panel.locator('#icon-settings svg').evaluate(svg=>getComputedStyle(svg).strokeWidth),'2.5px');
  await frame.evaluate(()=>document.body.dataset.iconMotion='off');await waitStill();
  await frame.evaluate(()=>document.body.dataset.iconMotion='on');await waitActive('icon-settings');
  await frame.evaluate(()=>document.body.style.setProperty('--icon-motion-scale','0'));await waitStill();
  await frame.evaluate(()=>{for(const name of ['--icon-size','--icon-stroke','--icon-motion-speed','--icon-motion-scale'])document.body.style.removeProperty(name);});await waitActive('icon-settings');
  await clear();
  await panel.locator('#icon-sessions').click();await waitActive('icon-sessions');
  await frame.evaluate(()=>window.retainedEffects=window.iconEffects());
  await panel.locator('#icon-memory').hover();await panel.locator('#blur-target').focus();
  await frame.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await frame.evaluate(()=>window.retainedEffects.every(a=>a.playState==='running'&&window.iconEffects().includes(a))),true,'Moving focus/clicking elsewhere or window blur does not discard page selection');
  await frame.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(3100);
  result.heldSelection=await frame.evaluate(()=>window.effectsFor('icon-sessions').map(a=>({state:a.playState,iteration:a.effect.getComputedTiming().currentIteration,currentTime:a.currentTime})));
  assert.ok(result.heldSelection.some(a=>a.state==='running'&&a.iteration>=1),'Selected page continues beyond the first cycle without hover or keyboard focus');
  await panel.locator('#icon-memory').click();await waitActive('icon-memory');
  assert.equal(await frame.evaluate(()=>window.retainedEffects.every(a=>a.playState==='idle')),true,'Changing the selected page stops the previous glyph');
  assert.equal(await frame.evaluate(()=>window.effectsFor('icon-sessions').length),0);
  await select('icon-chats','aria-current','page');
  await frame.evaluate(()=>document.querySelector('#icon-chats').setAttribute('aria-current','false'));await waitStill();
  await select('selected-link','aria-current','page');
  await clear();
  await frame.evaluate(()=>{document.querySelector('#budget-a').dataset.iconActive='true';document.querySelector('#budget-b').dataset.iconActive='true';});
  await frame.waitForFunction(()=>window.iconEffects().length===24);
  result.budget=await frame.evaluate(()=>({effects:window.iconEffects().length,glyphs:new Set(window.iconEffects().map(a=>a.effect.target.closest('.qq-icon'))).size}));
  assert.deepEqual(result.budget,{effects:24,glyphs:8});
  await frame.evaluate(()=>document.querySelector('#budget-a .qq-icon').remove());await frame.waitForFunction(()=>window.iconEffects().length===24);
  assert.equal(await frame.evaluate(()=>new Set(window.iconEffects().map(a=>a.effect.target.closest('.qq-icon'))).size),8,'Removed selected glyphs release their budget slot');
  await clear();
  await frame.evaluate(()=>{document.querySelector('#icon-details').dataset.iconActive='true';document.querySelector('#icon-details-summary').dataset.iconActive='true';});
  await waitActive('icon-details-content');await waitActive('icon-details-summary');
  await frame.evaluate(()=>document.querySelector('#icon-details').open=false);
  await frame.waitForFunction(()=>window.effectsFor('icon-details-content').length===0);
  assert.ok(await frame.evaluate(()=>window.effectsFor('icon-details-summary').length)>0,'A selected closed summary remains visible');
  await frame.evaluate(()=>document.querySelector('#icon-details').open=true);await waitActive('icon-details-content');
  await clear();
  await select('css-hidden-owner','aria-current','page');
  await frame.evaluate(()=>document.body.dataset.sidebar='hidden');await waitStill();
  await frame.evaluate(()=>document.body.classList.add('navigation-peek'));await waitActive('css-hidden-owner');
  await frame.evaluate(()=>document.body.classList.remove('navigation-peek'));await waitStill();
  await frame.evaluate(()=>delete document.body.dataset.sidebar);await waitActive('css-hidden-owner');
  await select('nested-visibility-owner','data-icon-active','true');
  await frame.evaluate(()=>document.querySelector('#nested-icon-wrapper').style.display='none');await waitStill();
  assert.equal(await panel.locator('#nested-visibility-owner').evaluate(button=>button.checkVisibility()),true);
  await frame.evaluate(()=>document.querySelector('#nested-icon-wrapper').style.display='');await waitActive('nested-visibility-owner');
  await frame.evaluate(()=>document.querySelector('#nested-icon-wrapper .qq-icon').style.visibility='hidden');await waitStill();
  await frame.evaluate(()=>document.querySelector('#nested-icon-wrapper .qq-icon').style.visibility='');await waitActive('nested-visibility-owner');
  await select('icon-memory');
  await frame.evaluate(()=>document.querySelector('#icon-memory [data-icon-role="portrait"]').style.display='none');await waitStill();
  await frame.evaluate(()=>document.querySelector('#icon-memory [data-icon-role="portrait"]').style.display='');await waitActive('icon-memory');
  await frame.evaluate(()=>document.querySelector('#icon-memory').disabled=true);await waitStill();
  await frame.evaluate(()=>document.querySelector('#icon-memory').disabled=false);await waitActive('icon-memory');
  await select('icon-emblem');await page.emulateMedia({reducedMotion:'reduce'});await waitStill();
  assert.equal(await frame.evaluate(()=>document.querySelector('#icon-emblem').getAttribute('aria-selected')), 'true');
  await page.emulateMedia({reducedMotion:'no-preference'});await waitActive('icon-emblem');
  await frame.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.qaIconHidden?'hidden':'visible'});window.qaIconHidden=true;document.dispatchEvent(new Event('visibilitychange'));});await waitStill();
  await panel.locator('#icon-chats').click();assert.equal(await frame.evaluate(()=>window.iconEffects().length),0);
  await frame.evaluate(()=>{window.qaIconHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await waitActive('icon-chats');
  assert.equal(await frame.evaluate(()=>window.effectsFor('icon-emblem').length),0,'Returning visibility resumes the current selection, not the old one');
  await select('icon-plugins');
  await frame.evaluate(()=>{window.removedEffects=window.iconEffects();document.querySelector('#icon-plugins .qq-icon').remove();});await waitStill();
  assert.equal(await frame.evaluate(()=>window.removedEffects.every(a=>a.playState==='idle')),true);
  await clear();await frame.evaluate(()=>window.restorePluginGlyph());
  assert.equal(await frame.evaluate(()=>window.iconEffects().length),0,'Restoring an unselected glyph does not restart motion');
  await select('icon-memory');
  const optInStatusIds=['icon-status-onebot-ready','icon-status-onebot-pending'];
  await frame.evaluate(ids=>{for(const id of ids)document.getElementById(id).dataset.iconActive='true';},optInStatusIds);
  for(const id of optInStatusIds)await waitActive(id);
  await frame.evaluate(ids=>{window.statusOptInEffects=ids.flatMap(id=>window.effectsFor(id));},optInStatusIds);
  await page.waitForTimeout(3200);
  result.statusOptIn=await frame.evaluate(ids=>ids.map(id=>({id,selected:document.getElementById(id).getAttribute('aria-selected'),current:document.getElementById(id).getAttribute('aria-current'),active:document.getElementById(id).dataset.iconActive,effects:window.effectsFor(id).map(a=>({role:a.effect.target.dataset.iconRole,state:a.playState,iteration:a.effect.getComputedTiming().currentIteration}))})),optInStatusIds);
  assert.ok(result.statusOptIn.every(status=>status.selected==='false'&&status.current===null&&status.active==='true'&&status.effects.length===2&&status.effects.every(effect=>effect.state==='running'&&effect.iteration>=1)),'Ready and pending indicators continue through explicit opt-in without selecting their tab');
  assert.deepEqual(result.statusOptIn[0].effects.map(effect=>effect.role).sort(),['bridge','ready']);
  assert.deepEqual(result.statusOptIn[1].effects.map(effect=>effect.role).sort(),['bridge','gap']);
  await frame.evaluate(()=>{window.colorChangeEffects=window.iconEffects();window.changeIconTheme('#4499ff');});
  await frame.waitForFunction(()=>getComputedStyle(document.querySelector('#icon-memory svg')).stroke==='rgb(68, 153, 255)');
  result.colors=await frame.evaluate(()=>({glyphs:[...document.querySelectorAll('.gallery .qq-icon')].map(svg=>({name:svg.dataset.iconMotion,stroke:getComputedStyle(svg).stroke,solid:[...svg.querySelectorAll('[fill="currentColor"]')].map(part=>({role:part.dataset.iconRole,fill:getComputedStyle(part).fill})),lines:[...svg.querySelectorAll('[data-icon-role]:not([stroke="none"])')].map(part=>getComputedStyle(part).stroke)})),brandFill:getComputedStyle(document.querySelector('#icon-emblem path')).fill,empty:{source:getComputedStyle(document.querySelector('#empty-preview'),'::before').maskImage,fill:getComputedStyle(document.querySelector('#empty-preview'),'::before').backgroundColor,color:getComputedStyle(document.querySelector('#empty-preview')).color},fallback:document.querySelector('#icon-unknown .qq-icon').dataset.iconMotion,unexpectedMarkup:document.querySelector('#icon-unknown .qq-icon').querySelectorAll('script,img,foreignObject').length,hostStorage:(()=>{try{localStorage.getItem('x');return'accessible';}catch{return'opaque';}})()}));
  const accent='rgb(68, 153, 255)';
  assert.equal(result.colors.glyphs.length,names.length,'Every factory glyph is present again for the theme check');
  assert.deepEqual([...new Set(result.colors.glyphs.map(glyph=>glyph.name))].sort(),[...ICON_NAMES].sort(),'Theme inheritance covers the complete allowlist as well as the unknown-name fallback');
  assert.ok(result.colors.glyphs.every(glyph=>glyph.stroke===accent&&glyph.lines.every(color=>color===accent)&&glyph.solid.every(part=>part.fill===accent)),'Every SVG stroke and solid semantic part inherits the changed theme color');
  assert.equal(result.colors.brandFill,'rgb(61, 155, 255)','The reference brand retains its blue cells when the interface accent changes');
  assert.ok(result.colors.glyphs.reduce((count,glyph)=>count+glyph.solid.length,0)>0,'The color check includes solid anchors and controls');
  assert.ok(result.colors.empty.source.includes('/assets/endfield/archive.svg'));assert.equal(result.colors.empty.fill,result.colors.empty.color,'Local SVG empty-state mask uses currentColor');
  assert.equal(result.colors.fallback,'panel');assert.equal(result.colors.unexpectedMarkup,0);assert.equal(result.colors.hostStorage,'opaque');
  assert.equal(await frame.evaluate(()=>window.colorChangeEffects.every(a=>a.playState==='running'&&window.iconEffects().includes(a))),true,'Theme changes preserve selected loops and update currentColor');
  await frame.evaluate(ids=>{for(const id of ids)document.getElementById(id).dataset.iconActive='false';},optInStatusIds);
  await frame.waitForFunction(ids=>ids.every(id=>window.effectsFor(id).length===0),optInStatusIds);
  assert.equal(await frame.evaluate(()=>window.statusOptInEffects.every(a=>a.playState==='idle')),true,'Disabling status opt-in immediately cancels both state variants');
  assert.ok(await frame.evaluate(()=>window.effectsFor('icon-memory').length)>0,'Status cleanup keeps the selected page motion intact');
  await frame.evaluate(()=>{window.iconCleanup();window.iconCleanup();});await waitStill();
  assert.equal(await frame.evaluate(()=>window.iconProbe.disconnects),1);
  await panel.locator('#icon-archive').click();assert.equal(await frame.evaluate(()=>window.iconEffects().length),0,'Disposed documents do not respond to later selection mutations');
  await frame.evaluate(()=>window.reinstallIconMotion());await waitActive('icon-archive');
  assert.equal(await frame.evaluate(()=>window.iconProbe.peakObservers),1,'Reinstallation never leaves two icon observers alive');
  await frame.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await waitStill();
  result.lifecycle=await frame.evaluate(()=>({...window.iconProbe,still:window.iconStill(),selectedAfterCleanup:document.querySelector('#icon-archive').getAttribute('aria-selected')}));
  assert.equal(result.lifecycle.observers,2);assert.equal(result.lifecycle.disconnects,2);assert.equal(result.lifecycle.activeObservers,0);assert.equal(result.lifecycle.peakObservers,1);assert.equal(result.lifecycle.iconRafCalls,0);assert.equal(result.lifecycle.still,true);assert.equal(result.lifecycle.selectedAfterCleanup,'true');assert.deepEqual(result.errors,[]);
  const stamp=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  await page.screenshot({path:path.join(evidenceDir,`icon-selection-gallery-${stamp}.png`)});
  const file=path.join(evidenceDir,`icon-selection-${stamp}.json`);
  fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({file,semantic:result.semantic.length,statusShapes:result.statusShapes,statusOptIn:result.statusOptIn,colors:result.colors,lifecycle:result.lifecycle,errors:result.errors}));
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
