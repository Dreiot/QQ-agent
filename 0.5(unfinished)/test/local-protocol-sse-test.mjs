// Real fs.watch -> manager -> bus -> HTTP SSE -> host RPC -> settings DOM.
// Only the child-process boundary is synthetic; no third-party code runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createLocalProtocols} from '../src/protocols/manager.js';
import {inspectRuntimeArchive} from '../scripts/lib/runtime-archive.mjs';
import {registerLocalProtocolRoutes} from '../src/console/local-protocols.js';
import {filesFor,writeFiles,makeZip,fakeChild} from './local-protocol-fixtures.mjs';
import {modelUiFixture} from './model-ui-fixture.mjs';
import {settingsSection} from './settings-navigation.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label)=>{for(let i=0;i<240;i++){if(await check())return;await wait(25);}throw Error(label);};
const children=[],spawnCalls=[],terminations=[],events=[],requests=[],checks=[],openedFolders=[];
let archiveInspections=0;
const qa=await modelUiFixture({config:{ui:{refreshMs:3600000}},components:{'runtime.localProtocols':args=>createLocalProtocols({...args,platform:'win32',arch:'x64',
  spawnImpl:(executable,args,options)=>{const child=fakeChild();children.push(child);spawnCalls.push({executable,args,cwd:options.cwd});return child;},
  terminateImpl:async child=>{terminations.push(child.pid);child.kill('SIGTERM');},
  inspectArchive:(...values)=>{archiveInspections++;return inspectRuntimeArchive(...values);},
}), 'console.localProtocols':(http,deps)=>registerLocalProtocolRoutes(http,{...deps,openProtocolDirectory:directory=>{openedFolders.push(directory);return{ok:true,dir:directory};}})}});
const {page,frame}=qa,manager=qa.kernel.localProtocols;
const off=qa.kernel.bus.on('local-protocols',payload=>events.push({at:Date.now(),payload:structuredClone(payload)}),{internal:true});
const getCount=()=>requests.filter(request=>request.method==='GET'&&request.path==='/api/local-protocols').length;
const outputCount=()=>requests.filter(request=>request.path==='/api/local-protocols/output').length;
const evidence=path.resolve('.qa-local/local-protocol-sse-20261025');await fs.mkdir(evidence,{recursive:true});
const wire=()=>page.evaluate(()=>({events:window.__qaProtocolWireEvents||[],raw:window.__qaProtocolWireText||''}));
const panelEvents=()=>frame.locator('body').evaluate(()=>window.__qaProtocolPanelEvents||[]);
try{
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/local-protocols'))requests.push({method:request.method(),path:url.pathname,at:Date.now()});});
  await page.addInitScript(()=>{
    window.__qaProtocolPanelEvents=[];
    window.addEventListener('message',event=>{if(event.data?.method==='shell.event'&&event.data.params?.name==='local-protocols')window.__qaProtocolPanelEvents.push({at:Date.now(),payload:event.data.params.payload});});
    if(window!==top)return;
    window.__qaProtocolWireEvents=[];window.__qaProtocolWireText='';
    const native=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await native(...args);
      if(new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname==='/api/events'&&response.ok){
        const reader=response.clone().body.getReader(),decoder=new TextDecoder();
        void(async()=>{let buffer='';try{while(true){const {value,done}=await reader.read();if(done)break;const text=decoder.decode(value,{stream:true});window.__qaProtocolWireText=(window.__qaProtocolWireText+text).slice(-2*1024*1024);buffer+=text;let match;while((match=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);if(!/^event:\s*local-protocols\s*$/m.test(block))continue;const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');window.__qaProtocolWireEvents.push({at:Date.now(),payload:JSON.parse(data)});}}}catch{/* The genuine response is aborted when the fixture leaves. */}})();
      }
      return response;
    };
  });
  await qa.openSettings();await settingsSection(frame,'onebot');await page.locator('#status-dot.online').waitFor();
  await frame.locator('[data-local-protocols]').waitFor({state:'visible'});
  const diagnostics=frame.locator('.local-protocol-service');assert.equal(await diagnostics.evaluate(node=>node.open),false,'diagnostics start folded without hiding account onboarding');
  assert.equal((await qa.request('GET','/api/local-protocols')).data.root,manager.root);
  assert.equal(spawnCalls.length,0);assert.equal(outputCount(),0);
  const unknown=await qa.request('POST','/api/local-protocols/start',{id:'not-a-detected-package'});
  assert.equal(unknown.status,404);assert.match(unknown.data.error,/未找到此发行包/);
  const invalidAuto=await qa.request('POST','/api/local-protocols/settings',{autoStart:'yes'});
  assert.equal(invalidAuto.status,400);assert.match(invalidAuto.data.error,/自动启动设置必须为开关/);
  assert.equal(manager.snapshot().settings.autoStart,false);assert.equal(spawnCalls.length,0);
  await diagnostics.locator(':scope > summary').click();await frame.getByRole('button',{name:'打开协议端文件夹',exact:true}).click();await until(()=>openedFolders.length===1,'folder open did not cross the host RPC and HTTP route');assert.deepEqual(openedFolders,[manager.root]);await diagnostics.locator(':scope > summary').click();assert.equal(await frame.locator('.local-protocol-provider:visible').count(),0,'no empty provider cards appear');
  await frame.getByRole('button',{name:'添加 QQ',exact:true}).click();await frame.locator('dialog[data-protocol-choice]').getByRole('button',{name:/Snowluma/}).click();
  const setup=frame.locator('dialog[data-protocol-choice="setup"]');await setup.locator('.local-protocol-setup-detection[data-state="waiting"]').waitFor({state:'visible'});assert.equal(await setup.getByRole('button',{name:'继续连接',exact:true}).isVisible(),false);
  assert.equal((await fs.readdir(manager.root)).length,0,'the user starts onboarding with an empty protocol folder');
  const placedAt=Date.now();
  await writeFiles(manager.root,{...filesFor('napcat','NapCat-Synthetic/'),...filesFor('snowluma','SnowLuma-Synthetic/'),
    'NapCat-Synthetic/napcat/config/onebot11_12345.json':'{}','SnowLuma-Synthetic/config/onebot_56789.json':'{}'});
  await fs.writeFile(path.join(manager.root,'NapCat-Synthetic.zip'),makeZip(filesFor('napcat','ZipRelease/')));
  await fs.writeFile(path.join(manager.root,'SnowLuma-Synthetic.zip'),makeZip(filesFor('snowluma','SnowZipRelease/')));
  const nap=frame.locator('.local-protocol-item').filter({hasText:'NapCat-Synthetic'}).filter({hasNotText:'NapCat-Synthetic.zip'}),snow=frame.locator('.local-protocol-item').filter({hasText:'SnowLuma-Synthetic'});
  await setup.locator('.local-protocol-setup-detection[data-state="ready"]').waitFor({state:'visible'});await setup.getByRole('button',{name:'继续连接',exact:true}).waitFor({state:'visible'});assert.equal(spawnCalls.length,0,'automatic detection never starts a package before the user continues');
  assert.equal(await diagnostics.evaluate(node=>node.open),false,'the primary setup receives detection while diagnostics remain folded');
  await setup.getByRole('button',{name:'关闭弹窗',exact:true}).click();await diagnostics.locator(':scope > summary').click();
  const snowDirectory=snow.filter({hasNotText:'SnowLuma-Synthetic.zip'});
  await nap.waitFor({state:'visible'});await snowDirectory.waitFor({state:'visible'});await frame.getByText('NapCat-Synthetic.zip',{exact:true}).waitFor({state:'visible'});await frame.getByText('SnowLuma-Synthetic.zip',{exact:true}).waitFor({state:'visible'});
  const detectedAt=Date.now();assert.ok(events.some(event=>event.at>=placedAt));await until(async()=>(await wire()).events.some(event=>event.at>=placedAt),'the real SSE stream received no event after file placement');await until(async()=>(await panelEvents()).some(event=>event.at>=placedAt),'the host did not deliver the placement notification to the iframe');
  assert.equal(requests.filter(request=>request.path.endsWith('/rescan')).length,0,'automatic package discovery must come from fs.watch rather than a test-triggered scan');
  assert.ok(archiveInspections>=2,'the actual ZIP scanner saw both inert release archives');
  checks.push('from an empty folder, both NapCat/SnowLuma ZIPs and directories are detected through real fs.watch, bus, HTTP SSE, host and iframe; open setup becomes ready without any manual rescan');

  const originalConnection=structuredClone(qa.kernel.config.get().onebot);
  await nap.getByRole('button',{name:'启动并连接'}).click();const savedChoice=frame.locator('dialog[data-protocol-choice="napcat-accounts"]');await savedChoice.getByRole('heading',{name:'选择登录的 QQ',exact:true}).waitFor({state:'visible'});assert.equal(spawnCalls.length,0,'saved QQ selection must precede process startup');await savedChoice.locator('button.local-protocol-saved-account').filter({hasText:'12345'}).click();await until(()=>manager.snapshot().running?.status==='running','real start API did not finish');
  assert.equal(spawnCalls.length,1);assert.ok(spawnCalls[0].executable.endsWith(path.join('NapCat-Synthetic','node.exe')));
  const prepared=manager.loginContext().preparedConnection;assert.equal(prepared.accountId,'12345');const connection={wsUrl:`ws://127.0.0.1:${prepared.wsPort}`,httpUrl:`http://127.0.0.1:${prepared.httpPort}`,accessToken:prepared.token,httpAccessToken:prepared.token};assert.match(connection.wsUrl,/^ws:\/\/127\.0\.0\.1:\d+$/);assert.match(connection.httpUrl,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal(connection.accessToken.length,64);assert.equal(connection.httpAccessToken,connection.accessToken);assert.deepEqual(qa.kernel.config.get().onebot,originalConnection,'native identity must be verified before rebinding the primary workspace');
  const savedNap=JSON.parse(await fs.readFile(path.join(manager.root,'NapCat-Synthetic/napcat/config/onebot11_12345.json'),'utf8'));
  assert.equal(savedNap.network.websocketServers.find(item=>item.name==='qq-agent-ws').token,connection.accessToken);
  const nativeDialog=frame.locator('dialog[data-protocol-login]');await nativeDialog.getByRole('heading',{name:'扫码连接 QQ',exact:true}).waitFor({state:'visible'});await nativeDialog.getByRole('button',{name:'关闭账号接入',exact:true}).click();
  const password='SYNTHETIC_INITIAL_PASSWORD_QA_ONLY',logToken='SYNTHETIC_WEBUI_TOKEN_QA_ONLY';
  children[0].stdout.write(`WebUi available at http://0.0.0.0:6099/webui?token=${logToken}\nInitial password: ${password}\nAccess token: ${connection.accessToken}\n`);
  await frame.getByRole('button',{name:'打开协议端页面',exact:true}).waitFor({state:'visible'});
  const state=(await qa.request('GET','/api/local-protocols')).data;
  assert.equal(state.running.webUiUrl,'http://127.0.0.1:6099/webui');assert.equal(outputCount(),0);
  await wait(650);const before={inspections:archiveInspections,gets:getCount(),wire:(await wire()).events.length};
  for(let i=0;i<12;i++)children[0].stdout.write(`Synthetic startup progress ${i}\n`);
  await until(async()=>(await wire()).events.length>before.wire,'stdout did not travel through SSE');await wait(400);
  assert.equal(archiveInspections,before.inspections,'stdout notifications and snapshot GET must not rescan the unchanged ZIP');assert.equal(outputCount(),0,'stdout metadata must not automatically request raw output');
  const privateParts=[password,logToken,connection.accessToken],observed=await wire(),delivered=await panelEvents();
  for(const value of privateParts){assert.equal(JSON.stringify(state).includes(value),false);assert.equal(JSON.stringify(events).includes(value),false);assert.equal(observed.raw.includes(value),false);assert.equal(JSON.stringify(delivered).includes(value),false);}
  for(const event of observed.events)assert.deepEqual(Object.keys(event.payload).sort(),['id','outputVersion','status']);
  checks.push('real deferred start writes matching native credentials and opens QQ login without changing the primary binding; stdout reveals only a sanitized login URL through SSE');

  await frame.getByRole('button',{name:'启动输出',exact:true}).click();const dialog=frame.locator('dialog[data-local-protocol-output]');await until(async()=>(await dialog.locator('pre').textContent())?.includes(password),'the explicitly opened output did not show the synthetic initial password');
  assert.equal(outputCount(),1);const handle=await dialog.elementHandle(),reads=outputCount();children[0].stdout.write('Synthetic additional progress\n');await wait(450);assert.equal(await handle.evaluate(node=>node.isConnected),true);assert.equal(outputCount(),reads);
  await dialog.getByRole('button',{name:'关闭启动输出'}).click();await wait(400);const idleGets=getCount(),idleInspections=archiveInspections;await wait(1400);assert.equal(getCount(),idleGets,'idle settings must not poll protocol snapshots');assert.equal(archiveInspections,idleInspections);
  await frame.getByRole('button',{name:'停止共享协议端',exact:true}).click();const stopConfirm=frame.locator('dialog[data-protocol-stop]');await stopConfirm.getByRole('button',{name:'停止服务',exact:true}).waitFor({state:'visible'});assert.equal(manager.snapshot().running.status,'running','the shared process stays running until confirmation');await stopConfirm.getByRole('button',{name:'停止服务',exact:true}).click();await until(()=>manager.snapshot().running?.status==='stopped','real stop API did not stop the fake child');assert.deepEqual(terminations,[children[0].pid]);assert.deepEqual(children[0].kills,['SIGTERM']);
  checks.push('raw startup output is read only on the explicit action, its dialog survives SSE, idle performs no periodic GET or archive scan, and stop uses only the injected termination boundary');

  await snowDirectory.getByRole('button',{name:'启动并连接'}).click();await until(()=>manager.snapshot().running?.provider==='snowluma'&&manager.snapshot().running?.status==='running','SnowLuma synthetic start did not finish');
  assert.equal(spawnCalls.length,2);assert.equal(manager.snapshot().running.account,'','generic Snow startup leaves desktop QQ selection to native login');assert.ok(spawnCalls[1].args[0].endsWith(path.join('SnowLuma-Synthetic','index.mjs')));
  const savedSnow=JSON.parse(await fs.readFile(path.join(manager.root,'SnowLuma-Synthetic/config/onebot.json'),'utf8'));assert.ok(savedSnow.networks.wsServers.some(server=>server.name==='qq-agent-ws'&&server.enabled));assert.equal(await fs.readFile(path.join(manager.root,'SnowLuma-Synthetic/config/onebot_56789.json'),'utf8'),'{}','generic startup preserves saved QQ-specific settings');assert.deepEqual(qa.kernel.config.get().onebot,originalConnection);
  await nativeDialog.getByRole('heading',{name:'选择 QQ',exact:true}).waitFor({state:'visible'});await nativeDialog.getByRole('button',{name:'关闭账号接入',exact:true}).click();
  children[1].stdout.write('WebUI address http://127.0.0.1:5099/\nSynthetic initial password: SYNTHETIC_SNOW_PASSWORD_QA_ONLY\n');await frame.getByRole('button',{name:'打开协议端页面',exact:true}).waitFor({state:'visible'});
  assert.equal(await frame.getByRole('button',{name:/接受.*协议|同意/}).count(),0);await page.screenshot({path:path.join(evidence,'connected.png'),fullPage:true});
  await frame.getByRole('button',{name:'停止共享协议端',exact:true}).click();await stopConfirm.getByRole('button',{name:'停止服务',exact:true}).click();await until(()=>manager.snapshot().running?.status==='stopped','SnowLuma synthetic stop did not finish');assert.equal(terminations.length,2);
  const brokenFile=path.join(manager.root,'SnowLuma-Synthetic/config/onebot_56789.json');
  await fs.writeFile(brokenFile,'{invalid-json');
  const broken=await qa.request('POST','/api/local-protocols/start',{id:manager.snapshot().running.id,account:'56789'});
  assert.equal(broken.status,400);assert.match(broken.data.error,/配置文件不是有效 JSON，未覆盖：onebot_56789\.json/);
  assert.equal(await fs.readFile(brokenFile,'utf8'),'{invalid-json');assert.equal(spawnCalls.length,2);
  checks.push('actual HTTP errors preserve unknown-package 404 and invalid-setting/configuration 400 with actionable messages, without spawning or overwriting broken configuration');
  assert.deepEqual(qa.errors,[]);assert.equal(qa.outbound(),0);assert.equal(spawnCalls.length,2);assert.equal(requests.filter(request=>request.path.endsWith('/rescan')).length,0);checks.push('both provider schemas configure through the actual API with explicit native choices and inert children, no manual rescan, automatic legal acceptance, QQ login or external traffic');
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({checks,placedAt,detectedAt,discoveryMs:detectedAt-placedAt,busEvents:events,wireEvents:(await wire()).events,iframeEvents:await panelEvents(),requests,archiveInspections,spawns:spawnCalls.length,terminations:terminations.length,errors:qa.errors,outbound:qa.outbound()},null,2));
  for(const check of checks)console.log('✓ local protocol SSE '+check);
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true});throw error;}finally{off();await qa.close();}
