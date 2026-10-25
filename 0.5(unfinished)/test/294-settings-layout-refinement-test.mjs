import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';

const out=path.resolve('.qa-local/settings-refinement-20261023/acceptance');fs.mkdirSync(out,{recursive:true});
const qa=await modelUiFixture({config:{memory:{consolidateEnabled:true,useChatModel:false},webSearch:{enabled:true},security:{browseLock:{enabled:false,hosts:['example.org'],siteSearchUrl:'https://example.org/reserved'}}}});
const {page,frame}=qa;let passed=0;
const check=(condition,message)=>{assert.ok(condition,message);console.log(`✓ ${++passed}. ${message}`);};
const until=async(read,accept,message)=>{for(let n=0;n<160;n++){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,35));}throw Error(message);};
async function settle(){await frame.locator('body').evaluate(async()=>{await document.fonts.ready;let idle=0;for(let n=0;n<180;n++){await new Promise(requestAnimationFrame);if(!document.querySelector('[data-conditional-phase]')&&!document.getAnimations().some(a=>a.effect?.getTiming().iterations!==Infinity&&(a.playState==='running'||a.pending))){if(++idle===2)return;}else idle=0;}throw Error('Layout did not settle');});}
const section=async id=>{await settingsSection(frame,id);await settle();};
try{
  await qa.openSettings();await section('chat');
  check(await frame.locator('.settings-activity').isVisible()&&await frame.locator('summary .activity-head-controls').count()===0,'response controls are exposed outside disclosure headings');
  await frame.getByRole('checkbox',{name:'所有群统一档位',exact:true}).uncheck();
  await until(()=>qa.disk().store.unifiedTier,value=>value===false,'unified card was not saved');
  check(await frame.getByRole('slider',{name:'当前响应档位',exact:true}).isVisible(),'changing a response header card keeps its slider visible');
  await section('security');
  check(await frame.locator('[data-preference-group=browsing] #field-security-browseLock-hosts').count()===1&&await frame.locator('.zone-danger #field-security-browseLock-hosts').count()===0,'allowed domains belong to web access rather than network exceptions');
  check(await frame.locator('[data-preference-group=images] input[type=number]').count()===3,'image limits share one coherent group');
  check(await frame.locator('#field-security-browseLock-siteSearchUrl').isHidden()&&qa.disk().security.browseLock.siteSearchUrl==='https://example.org/reserved','inactive legacy search configuration is preserved without advertising it');
  await section('appearance');
  const modes=frame.locator('[data-path="ui.uikit.mode"] [role=radiogroup]');
  check(await modes.getByRole('radio',{name:'深色',exact:true}).isVisible()&&await modes.getByRole('radio',{name:'浅色',exact:true}).isVisible(),'appearance modes are directly visible choices');
  await modes.getByRole('radio',{name:'浅色',exact:true}).click();
  await until(()=>qa.disk().ui.uikit?.mode,value=>value==='light','light mode card did not save');
  await frame.getByRole('button',{name:'撤销本次外观调整',exact:true}).click();
  await until(()=>qa.disk().ui.uikit?.mode,value=>value==='dark','first appearance edit could not be undone');
  check(await modes.getByRole('radio',{name:'深色',exact:true}).getAttribute('aria-checked')==='true','undo restores the effective original appearance even before any custom settings exist');
  await modes.getByRole('radio',{name:'深色',exact:true}).press('ArrowRight');
  await until(()=>qa.disk().ui.uikit?.mode,value=>value==='light','keyboard light selection did not save');
  await modes.getByRole('radio',{name:'浅色',exact:true}).press('ArrowLeft');
  await until(()=>qa.disk().ui.uikit?.mode,value=>value==='dark','keyboard mode selection did not save');
  check(await modes.getByRole('radio',{name:'深色',exact:true}).getAttribute('aria-checked')==='true','mouse and arrow keys use the existing automatic theme save');
  await frame.locator('[data-appearance-group=layout]>summary').click();await settle();
  const density=frame.locator('#field-uikit-density').locator('..').getByRole('radiogroup');
  await density.getByRole('radio',{name:'紧凑',exact:true}).click();
  await until(()=>qa.disk().ui.uikit?.dark?.density,value=>value===.85,'density card did not save a number');
  await density.getByRole('radio',{name:'紧凑',exact:true}).press('ArrowRight');
  await until(()=>qa.disk().ui.uikit?.dark?.density,value=>value===1,'density keyboard selection did not save');
  check(true,'layout cards preserve numeric values and keyboard behavior');
  const before=JSON.stringify(qa.disk()),writes=qa.writes.length,gallery=frame.locator('.component-preview');
  await gallery.getByRole('button',{name:'主按钮',exact:true}).click();await gallery.getByRole('checkbox').uncheck();
  await gallery.locator('input[type=range]').fill('35');await gallery.locator('input[type=text]').fill('本地预览');
  await page.waitForTimeout(1000);
  check(JSON.stringify(qa.disk())===before&&qa.writes.length===writes,'live preview interactions never modify configuration');
  check(await gallery.locator('.component-preview-type-title').innerText()==='本地预览'&&await gallery.locator('.component-preview-value').innerText()==='35%','live preview reflects the demonstration controls');
  await frame.getByRole('searchbox',{name:'搜索设置',exact:true}).fill('间距密度');
  await frame.locator('.settings-search-result').getByText('间距密度',{exact:true}).click();await settle();
  check(await density.getByRole('radio',{name:'标准',exact:true}).evaluate(button=>button===button.ownerDocument.activeElement),'search opens the real layout control and focuses its selected card');
  await section('models');await frame.locator('[data-settings-open=model-manager]').click();
  const manager=frame.locator('dialog[data-settings-editor=model-manager]');
  check(await manager.locator('.settings-dialog-footer').isHidden(),'automatic editors do not retain an empty footer');
  await manager.getByRole('button',{name:'关闭',exact:true}).click();await manager.waitFor({state:'detached'});
  await section('tools');
  check(await frame.getByRole('status').filter({hasText:'暂无已注册工具'}).isVisible(),'an empty tool registry gives a clear empty state');
  await frame.locator('.settings-tool-search').fill('no-such-tool');
  check(await frame.getByText('暂无已注册工具',{exact:true}).isVisible(),'empty tool filtering retains an accurate empty state');
  const sections=await frame.locator('#settings-sidebar a').evaluateAll(links=>links.map(link=>link.dataset.target)),matrix=[];
  for(const width of [1360,1024,560,400]){
    await page.setViewportSize({width,height:900});
    for(const id of sections){
      await section(id);
      const dimensions=await frame.locator('#section-'+id).evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
      assert.ok(dimensions.scroll<=dimensions.client+1,`${id} overflows at ${width}`);
      assert.equal(await frame.locator('#settings-sidebar [aria-current=page]').count(),1,'one navigation item must be current');
      assert.equal(await frame.locator('#settings-sidebar [aria-current=page]').getAttribute('data-target'),id);
      matrix.push({width,id,...dimensions});
      if(width===1360&&['appearance','security','chat'].includes(id)||width===560&&id==='appearance')await page.screenshot({path:path.join(out,`${width}-${id}.png`)});
    }
    if(width===1024||width===560){const nav=await frame.locator('#settings-sidebar').evaluate(el=>({display:getComputedStyle(el).display,client:el.clientWidth,scroll:el.scrollWidth,height:el.getBoundingClientRect().height}));check(nav.display==='flex'&&nav.height<80&&(width!==560||nav.scroll>nav.client),'compact navigation stays in one row and scrolls when needed at '+width);}
  }
  check(matrix.length===44,'all eleven settings pages stay within their content width at four viewport sizes');
  check(qa.errors.length===0&&qa.outbound()===0,'refinement flows finish without browser errors or external traffic');
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,matrix,errors:qa.errors,outbound:qa.outbound()},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await qa.close();}
console.log(`Settings refinement: ${passed} checks passed`);
