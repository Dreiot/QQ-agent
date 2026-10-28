// Isolated real core start/stop, without connecting a QQ account or a real model.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
process.env.QQ_AGENT_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-v04-core-smoke-'));
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const {updateConfig}=await import('../src/config.js');updateConfig({server:{port},api:{baseUrl:'http://127.0.0.1:1/v1',model:''},onebot:{wsUrl:'ws://127.0.0.1:1',httpUrl:'http://127.0.0.1:1'},proactive:{enabled:false},extensions:{hotReload:false}});
const {createApp}=await import('../src/app.js');const core=createApp({log:()=>{},kernelControl:{status:()=>({restartAvailable:true,pid:process.pid}),requestRestart:()=>{throw Error('no real restart in fixture');}}});
try{const actual=await core.start();assert.equal(actual,port);const status=await(await fetch(`http://127.0.0.1:${port}/api/kernel/status`)).json();assert.equal(status.restartAvailable,true);
 const wx=await(await fetch(`http://127.0.0.1:${port}/api/desktop-wechat`)).json();assert.equal(wx.enabled,false);assert.equal(core.desktopWechat.database.proc,null);
 assert.ok(core.orchestrator.toolDefs.some(tool=>tool.id==='read_wechat_image'));
 const script=await fetch(`http://127.0.0.1:${port}/app/desktop-wechat.js`);assert.equal(script.status,200);
 const socket=net.connect(port,'127.0.0.1');socket.on('error',()=>{});await new Promise(r=>socket.once('connect',r));socket.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n');
 await core.stop();socket.destroy();assert.equal(core.server.listening,false);assert.equal(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR,'qq-agent.lock')),false);
 console.log(JSON.stringify({ok:true,realCoreBoot:true,wechatDefaultDisabled:true,wechatRouteAndAsset:true,partialUiReconnectHandled:true,realQQMessages:0,productionDataTouched:false}));process.exit(0);
}catch(error){console.error(error);try{await core.stop();}catch{}process.exit(1);}
