// Real loader and authenticated requests, with only owned, inert test extensions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {modelUiFixture} from './model-ui-fixture.mjs';

const evidence=process.env.QA285_EVIDENCE,results=[];
if(evidence)fs.mkdirSync(evidence,{recursive:true});
const f=await modelUiFixture({config:{ui:{refreshMs:1000},proactive:{enabled:false}}}),{page,frame}=f;
const settle=()=>frame.locator('body').evaluate(async()=>{let idle=0;await document.fonts.ready;for(let i=0;i<240;i++){await new Promise(requestAnimationFrame);if(!document.getAnimations().some(a=>a.effect?.getTiming().iterations!==Infinity&&(a.playState==='running'||a.pending))){if(++idle===2)return;}else idle=0;}throw Error('Motion did not settle');});
async function toggle(name,card,enabled,{keyboard=false}={}){
  const button=card.getByRole('button',{name:enabled?'启用':'停用',exact:true});await button.scrollIntoViewIfNeeded();await button.hover();await settle();
  await card.evaluate((root,enabled)=>{
    const buttons=[...root.querySelectorAll('.actions button')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'),base=root.getBoundingClientRect();
    const probes=buttons.map(el=>({el,name:el.textContent,height:el.offsetHeight,x:el.getBoundingClientRect().left-base.left,y:el.getBoundingClientRect().top-base.top}));
    window.extensionMotionAudit=new Promise((resolve,reject)=>{
      const samples=[];let count=0,stable=0;
      function sample(){
        const failures=[],r=root.getBoundingClientRect();
        for(const p of probes){const el=p.el;if(!el.isConnected||!el.getClientRects().length||getComputedStyle(el).visibility==='hidden')continue;const rect=el.getBoundingClientRect();
          if(el.offsetHeight!==p.height)failures.push({kind:'stretch',name:p.name,before:p.height,after:el.offsetHeight});
          if(Math.abs(rect.left-r.left-p.x)>2||Math.abs(rect.top-r.top-p.y)>2)failures.push({kind:'action-jump',name:p.name,dx:rect.left-r.left-p.x,dy:rect.top-r.top-p.y});
          if(!document.querySelector('dialog[open]')){
            for(const point of [[rect.left+1.5,rect.top+rect.height/2],[rect.right-1.5,rect.top+rect.height/2],[rect.left+rect.width/2,rect.top+1.5],[rect.left+rect.width/2,rect.bottom-1.5]]){
              if(point[0]<1||point[1]<1||point[0]>=innerWidth-1||point[1]>=innerHeight-1)continue;
              const hit=document.elementFromPoint(...point);if(hit!==el&&!el.contains(hit))failures.push({kind:'occluded',name:p.name,point,cover:hit?.className});
            }
          }
        }
        const visible=[...root.querySelectorAll('button,input,select,textarea')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
        for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++){const a=visible[i].getBoundingClientRect(),b=visible[j].getBoundingClientRect(),w=Math.min(a.right,b.right)-Math.max(a.left,b.left),h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(w>2&&h>2)failures.push({kind:'overlap',a:visible[i].textContent,b:visible[j].textContent,w,h});}
        const target=[...root.querySelectorAll('button')].find(el=>el.textContent===(enabled?'停用':'启用'));
        samples.push({count,failures});
        if(target&&!target.disabled&&!document.querySelector('dialog[open]')&&!document.getAnimations().some(a=>a.effect?.getTiming().iterations!==Infinity&&(a.playState==='running'||a.pending))){if(++stable>8){resolve(samples);return;}}else stable=0;
        if(++count>360){reject(Error('Extension toggle did not settle'));return;}requestAnimationFrame(sample);
      }
      root.addEventListener('click',sample,{once:true});
    });
  },enabled);
  if(keyboard)await button.press('Space');else await button.click();
  const confirm=frame.locator('dialog.confirm-panel');
  if(enabled&&await confirm.count())await confirm.getByRole('button',{name:'确认',exact:true}).click();
  const samples=await card.evaluate(()=>window.extensionMotionAudit);results.push({name,samples});
  const failures=samples.flatMap(s=>s.failures.map(x=>({frame:s.count,...x})));assert.deepEqual(failures.slice(0,6),[],name+' has '+failures.length+' motion failures');
}
try{
  const entries=[];
  for(const kind of ['skill','plugin'])for(let i=0;i<4;i++){
    const root=i===0?'bundled':kind==='skill'?'skills':'plugins',id=`fixture285-${kind}-${i}`,dir=path.join(f.appRoot,root,id);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,kind==='skill'?'skill.json':'plugin.json'),JSON.stringify({id,kind,name:`界面验证${kind==='skill'?'技能':'插件'} ${i}`,version:'1.0.0',entry:'index.js',apiVersion:1,permissions:[],description:'本地空扩展，仅测试按钮、配置和加载状态。',configSchema:{on:{type:'boolean',title:'功能开关',default:true},message:{type:'string',title:'显示文字',default:'测试内容'}}}));
    fs.writeFileSync(path.join(dir,'index.js'),'export default {setup(){}};');entries.push({root,id,dir});
  }
  f.kernel.config.update({skills:Object.fromEntries(entries.map(x=>[x.id,{enabled:true}]))});for(const x of entries)await f.kernel.loader.loadDir(x.root,x.dir);
  for(const width of [1360,560,400])for(const panel of ['skills','plugins']){
    await page.setViewportSize({width,height:1100});await page.locator(`#nav button[data-panel=${panel}]`).click();await frame.locator(`body[data-panel=${panel}]`).waitFor();await settle();
    const kind=panel==='skills'?'skill':'plugin';
    for(const i of [0,1]){
      const card=frame.locator(`[data-extension-id="fixture285-${kind}-${i}"]`);
      if(i===0)await frame.locator('.default-capabilities > summary').click();await card.waitFor();
      await toggle(`${width}-${panel}-${i}-disable`,card,false);
      await toggle(`${width}-${panel}-${i}-enable`,card,true,{keyboard:true});
      await card.getByRole('button',{name:'设置',exact:true}).click();const dialog=frame.locator('dialog.extension-settings');await dialog.waitFor();
      const input=dialog.locator('input[name=on]'),before=await dialog.boundingBox();await input.uncheck();await input.check();
      const after=await dialog.boundingBox();assert.ok(Math.abs(before.height-after.height)<.5,'Boolean settings do not stretch the dialog');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      await card.getByRole('button',{name:'重新加载',exact:true}).click();
      await card.evaluate(async root=>{for(let i=0;i<240;i++){await new Promise(requestAnimationFrame);if([...root.querySelectorAll('button')].some(b=>b.textContent==='重新加载'&&!b.disabled))return;}throw Error('Hot reload did not complete');});await settle();
    }
    if(evidence)await page.screenshot({path:path.join(evidence,`${panel}-${width}.png`),fullPage:true});
  }
  assert.deepEqual(f.errors,[]);assert.equal(f.outbound(),0);
}catch(error){if(evidence)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}
finally{if(evidence)fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks:results.length,results},null,2));await f.close();}
console.log('✓ 285 '+results.length+' real extension enable/disable checks plus configuration/hot reload in skill/plugin pages across wide/narrow layouts; zero external requests');
