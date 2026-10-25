// Real document effects consume appearance preferences, independently of RPCs
// and confirmation timing. Every page and datum belongs to this local fixture.
import assert from 'node:assert/strict';
import {modelUiFixture} from './model-ui-fixture.mjs';

const f=await modelUiFixture();
try{
  await f.page.emulateMedia({reducedMotion:'no-preference'});
  const fold=await f.frame.locator('body').evaluate(async()=>{
    const {animateMount}=await import('/panels/motion.js');
    const {installCollapsibles}=await import('/panels/collapsible.js');installCollapsibles(document);
    const root=document.documentElement,host=document.createElement('section'),details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
    host.style.cssText='position:fixed;left:10px;top:10px;width:300px;z-index:10000';summary.textContent='Synthetic motion preference';summary.style.lineHeight='30px';body.style.height='120px';details.dataset.collapsible='';details.append(summary,body);host.append(details);document.body.append(host);
    const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    root.style.setProperty('--motion-duration-factor','2');root.style.setProperty('--motion-scale','1.5');document.body.dataset.interfaceMotion='on';await frame();
    const mount=animateMount(host),mountTiming=mount.effect.getTiming(),mountFrames=mount.effect.getKeyframes();mount.cancel();
    summary.click();const opening=details.getAnimations()[0],openingDuration=opening.effect.getTiming().duration;
    root.style.setProperty('--motion-duration-factor','.5');await frame();const settledOpen=details.open&&!body.inert&&details.getAnimations().length===0;
    summary.click();const closingDuration=details.getAnimations()[0].effect.getTiming().duration;document.body.dataset.interfaceMotion='off';await frame();const settledClosed=!details.open&&!body.inert&&details.getAnimations().length===0;
    document.body.dataset.interfaceMotion='on';root.style.setProperty('--motion-scale','0');await frame();summary.click();const zeroInstant=details.open&&details.getAnimations().length===0;
    host.remove();return{mountDuration:mountTiming.duration,mountTransform:mountFrames[0].transform,openingDuration,closingDuration,settledOpen,settledClosed,zeroInstant};
  });
  assert.equal(fold.mountDuration,440);assert.match(fold.mountTransform,/12/);assert.equal(fold.openingDuration,440);assert.equal(fold.closingDuration,110);assert.ok(fold.settledOpen&&fold.settledClosed&&fold.zeroInstant);
  console.log('✓ 297 real mount and fold timing, displacement, in-flight settlement and zero-amplitude layout');

  const rail=await f.page.evaluate(async()=>{
    const {applyTheme,DEFAULT_THEME}=await import('/panels/theme.js');
    const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    applyTheme({...DEFAULT_THEME,motionDuration:2,motionScale:1,interfaceMotionEnabled:true});await frame();
    document.querySelector('#brand-emblem').click();await frame();
    const active=document.querySelector('.rail').getAnimations().find(a=>a.transitionProperty==='width'),duration=active?.effect.getTiming().duration;
    applyTheme({...DEFAULT_THEME,motionDuration:.5,motionScale:1,interfaceMotionEnabled:true});await frame();
    const settled=!document.querySelector('.rail').getAnimations().some(a=>a.transitionProperty==='width'&&a.playState==='running');
    document.querySelector('#brand-emblem').click();await frame();
    const next=document.querySelector('.rail').getAnimations().find(a=>a.transitionProperty==='width');return{duration,settled,nextDuration:next?.effect.getTiming().duration};
  });
  assert.deepEqual(rail,{duration:640,settled:true,nextDuration:160});console.log('✓ 297 shell rail settles a superseded transition and uses the next chosen duration');

  const deletion=await f.frame.locator('body').evaluate(async()=>{
    const {gsapReady}=await import('/panels/vendor/gsap-runtime.js');await gsapReady;
    const {createDestructiveMotion}=await import('/panels/destructive-motion.js');
    const root=document.documentElement,node=document.createElement('article');node.textContent='Synthetic deletion visual';node.style.cssText='position:fixed;left:10px;top:10px;width:300px;height:100px';document.body.append(node);
    root.style.setProperty('--motion-duration-factor','2');root.style.setProperty('--motion-scale','1');document.body.dataset.interfaceMotion='on';
    const effect=createDestructiveMotion(node),flight=effect.exit();const duration=node.getAnimations()[0]?.effect.getTiming().duration;
    document.body.dataset.interfaceMotion='off';await flight;effect.dispose();const cleaned=document.querySelectorAll('.danger-motion').length===0;
    const off=createDestructiveMotion(node);await off.exit();const offAnimations=node.getAnimations().length;off.dispose();node.remove();return{duration,cleaned,offAnimations};
  });
  assert.deepEqual(deletion,{duration:1080,cleaned:true,offAnimations:0});console.log('✓ 297 deletion graphics use the visual duration and stop cleanly when disabled');
  await f.page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await f.frame.locator('body').evaluate(async()=>{const {animateMount}=await import('/panels/motion.js');document.body.dataset.interfaceMotion='on';return animateMount(document.body)===null;});assert.ok(reduced);
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);console.log('✓ 297 system reduced motion takes priority; no page errors or external services');
}finally{await f.close();}
