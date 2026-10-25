// Genuine kernel HTTP -> host RPC -> settings iframe -> local native fixture.
// The package, child and QQ login state are synthetic. No upstream executable or QQ endpoint is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLocalProtocols } from '../src/protocols/manager.js';
import { createProtocolLogin } from '../src/protocols/login.js';
import { filesFor, makeZip, fakeChild } from './local-protocol-fixtures.mjs';
import { modelUiFixture } from './model-ui-fixture.mjs';
import { settingsSection } from './settings-navigation.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => { for (let i = 0; i < 280; i++) { if (await check()) return; await wait(25); } throw new Error(label); };
const password = 'SYNTHETIC_NATIVE_PASSWORD_ONLY';
const credential = 'SYNTHETIC_NATIVE_SESSION_ONLY';
const scanText = 'https://qq.example.test/synthetic-scan?fixture=private-qr-text';
const account = '12345678';
const nativeRequests = [], onebotRequests = [], apiRequests = [], publicReplies = [], children = [], checks = [], serverErrors = [];
let phase = 'waiting_qrcode', generation = 0, qa, prepared, onebotHttp, onebotWs, onebotWsHttp;
const statusGets = () => nativeRequests.filter(item => item.path === '/api/QQLogin/CheckLoginStatus').length;
const native = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); nativeRequests.push({ method: req.method, path: url.pathname });
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };
    if (url.pathname === '/api/auth/login') {
      assert.equal(body.hash, createHash('sha256').update(password + '.napcat').digest('hex'));
      assert.equal(body.password, undefined); send({ Credential: credential }); return;
    }
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    assert.equal(req.method, 'POST');
    if (url.pathname === '/api/QQLogin/CheckLoginStatus') {
      send({ isLogin: phase === 'ready', coreReady: phase === 'ready', loginPhase: phase,
        qrLoginAccepted: phase === 'qrcode_scanned', qrcodeurl: scanText + '&generation=' + generation, loginError: '' }); return;
    }
    if (url.pathname === '/api/QQLogin/RefreshQRcode') { generation++; send({ qrcodeurl: scanText + '&generation=' + generation }); return; }
    if (url.pathname === '/api/QQLogin/GetQQLoginInfo') { send({ uid: 'synthetic-internal-uid', uin: account, nick: '本地模拟账号', online: true, token: 'SYNTHETIC_EXTRA_PRIVATE_ONLY' }); return; }
    assert.fail(`Unexpected native fixture path ${url.pathname}`);
  } catch (error) {
    serverErrors.push(error.message); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: -1, message: 'Synthetic native fixture failure' }));
  }
});
await new Promise(resolve => native.listen(0, '127.0.0.1', resolve));
const nativePort = native.address().port;
const evidence = path.resolve('.qa-local/protocol-login-roundtrip-20261025'); await fs.mkdir(evidence, { recursive: true });

try {
  qa = await modelUiFixture({ config: { ui: { refreshMs: 3600000 } }, transport: {
    // Keep this single-account fixture bound to its original synthetic QQ. The
    // native controller still proves both actual local sockets below before
    // committing the production manager's prepared connection.
    id:'inert-native-fixture',start(){},stop(){},actions:{},
    status:()=>({connected:phase==='ready',selfId:account,selfNickname:'本地模拟账号'}),
  }, components: {
    'runtime.localProtocols': args => createLocalProtocols({ ...args, platform: 'win32', arch: 'x64',
      spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
      terminateImpl: async child => { child.kill('SIGTERM'); },
    }),
    'runtime.protocolLogin': args => createProtocolLogin({ ...args, fetchImpl: async (input, options) => {
      const url = new URL(input); assert.equal(url.hostname, '127.0.0.1');
      if(Number(url.port)===nativePort)assert.ok(url.pathname.startsWith('/api/'));
      else{assert.equal(Number(url.port),prepared?.httpPort);assert.equal(url.pathname,'/get_login_info');}
      return fetch(input, options);
    } }),
  } });
  const { page, frame, kernel } = qa, manager = kernel.localProtocols;
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/local-protocols/login')) apiRequests.push({ method: request.method(), path: url.pathname, query: url.search, body: request.postDataJSON() }); });
  page.on('response', async response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/local-protocols/login')) try { publicReplies.push(await response.json()); } catch {} });
  await page.addInitScript(() => {
    window.__qaLoginReplies = [];
    window.addEventListener('message', event => { if (event.data?.result?.sessionId && event.data.result.provider) window.__qaLoginReplies.push(event.data.result); });
  });
  await qa.openSettings(); await settingsSection(frame, 'onebot');
  const files = { ...filesFor('napcat', 'Synthetic-NapCat/'),
    'Synthetic-NapCat/napcat/config/webui.json': JSON.stringify({ token: password }),
    [`Synthetic-NapCat/napcat/config/onebot11_${account}.json`]: '{}',
  };
  await fs.writeFile(path.join(manager.root, 'Synthetic-NapCat.zip'), makeZip(files));
  const service=frame.locator('.local-protocol-service');assert.equal(await service.evaluate(node=>node.open),false);await service.locator(':scope > summary').click();
  const packageCard = frame.locator('.local-protocol-item').filter({ hasText: 'Synthetic-NapCat.zip' });
  await packageCard.waitFor({ state: 'visible' }); await packageCard.getByRole('button', { name: '启动并连接', exact: true }).click();
  const saved=frame.locator('dialog[data-protocol-choice="napcat-accounts"]');await saved.getByRole('heading',{name:'选择登录的 QQ',exact:true}).waitFor({state:'visible'});assert.equal(children.length,0,'saved QQ selection must precede starting the package');await saved.locator('button.local-protocol-saved-account').filter({hasText:account}).click();
  await until(() => manager.snapshot().running?.status === 'running', 'synthetic package did not start through the real API');
  assert.equal(children.length, 1); assert.equal(manager.snapshot().running.account, account);
  prepared=manager.loginContext().preparedConnection;assert.equal(prepared.accountId,account);
  onebotHttp=http.createServer((req,res)=>{try{assert.equal(req.url,'/get_login_info');assert.equal(req.headers.authorization,'Bearer '+prepared.token);onebotRequests.push({kind:'http',action:'get_login_info',account});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:Number(account),nickname:'本地模拟账号'}}));}catch(error){serverErrors.push(error.message);res.writeHead(500);res.end();}});
  onebotWs=new WebSocketServer({noServer:true});onebotWsHttp=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  onebotWsHttp.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer '+prepared.token){serverErrors.push('OneBot WebSocket auth missing');socket.destroy();return;}onebotWs.handleUpgrade(req,socket,head,ws=>onebotWs.emit('connection',ws));});
  onebotWs.on('connection',ws=>ws.on('message',raw=>{try{const body=JSON.parse(raw.toString());assert.equal(body.action,'get_login_info');assert.equal(typeof body.echo,'string');onebotRequests.push({kind:'websocket',action:body.action,account});ws.send(JSON.stringify({status:'ok',retcode:0,data:{user_id:Number(account),nickname:'本地模拟账号'},echo:body.echo}));}catch(error){serverErrors.push(error.message);ws.terminate();}}));
  await Promise.all([new Promise((resolve,reject)=>{onebotHttp.once('error',reject);onebotHttp.listen(prepared.httpPort,'127.0.0.1',resolve);}),new Promise((resolve,reject)=>{onebotWsHttp.once('error',reject);onebotWsHttp.listen(prepared.wsPort,'127.0.0.1',resolve);})]);
  children[0].stdout.write(`WebUi available at http://127.0.0.1:${nativePort}/webui?token=${password}\n`);
  await frame.getByRole('button', { name: '打开协议端页面', exact: true }).waitFor({ state: 'visible' });
  checks.push('a genuine ZIP is detected, extracted and started by the production manager with only the child boundary synthetic');

  const dialog = frame.locator('dialog[data-protocol-login]'), status = dialog.locator('.protocol-login-status'), image = dialog.getByRole('img', { name: 'NapCat 登录二维码' });
  const settledScreenshot = async name => {
    await dialog.evaluate(async node => { await Promise.allSettled(node.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)); });
    await page.screenshot({ path: path.join(evidence, name), fullPage: true });
  };
  await dialog.locator('.protocol-login-status[data-state="waiting"]').waitFor({ state: 'visible' }); await image.waitFor({ state: 'visible' });
  await until(async () => image.evaluate(node => node.complete && node.naturalWidth > 0), 'the real PNG QR did not decode in the iframe');
  const firstImage = await image.getAttribute('src'); assert.match(firstImage, /^data:image\/png;base64,/);
  assert.deepEqual([...Buffer.from(firstImage.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(await dialog.getByRole('textbox', { name: '协议端管理密码' }).isVisible(), false, 'managed Nap uses only its own credential file');
  assert.equal(nativeRequests.filter(item => item.path === '/api/auth/login').length, 1);
  await settledScreenshot('waiting-qr.png');
  checks.push('real host RPC and authenticated HTTP routes auto-authenticate the owned Nap fixture and deliver a decodable locally generated PNG to the settings iframe');

  await dialog.getByRole('button', { name: '刷新二维码', exact: true }).click();
  await until(async () => (await image.getAttribute('src')) !== firstImage, 'explicit refresh did not produce a new QR PNG');
  assert.equal(nativeRequests.filter(item => item.path === '/api/QQLogin/RefreshQRcode').length, 1);
  phase = 'qrcode_scanned'; await dialog.locator('.protocol-login-status[data-state="scanned"]').waitFor({ state: 'visible' }); assert.match(await status.textContent(), /已扫码/);
  await settledScreenshot('scanned.png');
  phase = 'ready'; await dialog.locator('.protocol-login-status[data-state="connected"]').waitFor({ state: 'visible' });
  await dialog.getByText('本地模拟账号', { exact: true }).waitFor({ state: 'visible' }); await dialog.getByText(account, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await image.isVisible(), false); await settledScreenshot('connected.png');
  assert.ok(apiRequests.some(item => item.path === '/api/local-protocols/login/refresh'));
  assert.ok(onebotRequests.some(item=>item.kind==='http'),'production controller must verify the actual OneBot HTTP identity');assert.ok(onebotRequests.some(item=>item.kind==='websocket'),'production verifier must verify the matching actual WebSocket identity');assert.equal(kernel.config.get().onebot.httpUrl,`http://127.0.0.1:${prepared.httpPort}`);assert.equal(kernel.config.get().onebot.wsUrl,`ws://127.0.0.1:${prepared.wsPort}`);
  checks.push('explicit QR refresh, waiting -> scanned -> connected and the actual account traverse native HTTP, production controller, route, host RPC and iframe without mocked API responses');
  checks.push('deferred saved-account selection proves the authenticated OneBot HTTP and WebSocket identities on manager-allocated sockets before committing that same account');

  const replies = await frame.locator('body').evaluate(() => window.__qaLoginReplies || []);
  assert.ok(replies.some(item => item.stage === 'waiting')); assert.ok(replies.some(item => item.stage === 'scanned')); assert.ok(replies.some(item => item.stage === 'connected'));
  for (const visible of [...publicReplies, ...replies]) {
    const text = JSON.stringify(visible); for (const secret of [password, credential, scanText, prepared.token, 'synthetic-internal-uid', 'SYNTHETIC_EXTRA_PRIVATE_ONLY']) assert.equal(text.includes(secret), false, 'native private fields must not cross the HTTP or RPC boundary');
  }
  const sessionId = replies.at(-1).sessionId;
  await dialog.getByRole('button', { name: '完成', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  await until(() => apiRequests.some(item => item.path === '/api/local-protocols/login/close' && item.body?.sessionId === sessionId), 'the genuine close route did not receive the session');
  const stoppedReads = statusGets(); await wait(1700); assert.equal(statusGets(), stoppedReads, 'a closed login dialog must stop status polling');
  assert.equal((await qa.request('GET', '/api/local-protocols/login?sessionId=' + sessionId)).status, 409);
  checks.push('private password/session/raw QR/native UID stay in the host, while completing the dialog closes its actual backend session and stops native reads');

  phase = 'waiting_qrcode'; await frame.locator('[data-local-protocols]').getByRole('button', { name: '选择 QQ', exact: true }).click();
  await frame.locator('dialog[data-protocol-login] .protocol-login-status[data-state="waiting"]').waitFor({ state: 'visible' });
  const freshReplies = await frame.locator('body').evaluate(() => window.__qaLoginReplies || []), leavingId = freshReplies.at(-1).sessionId;
  await page.locator('#nav button[data-panel=sessions]').click(); await page.waitForFunction(() => document.querySelector('#panel-host iframe')?.src.includes('/sessions/'));
  await until(() => apiRequests.some(item => item.path === '/api/local-protocols/login/close' && item.body?.sessionId === leavingId), 'host did not release the registered session when removing the iframe');
  const leftReads = statusGets(); await wait(1700); assert.equal(statusGets(), leftReads);
  assert.equal((await qa.request('GET', '/api/local-protocols/login?sessionId=' + leavingId)).status, 409);
  assert.equal(nativeRequests.filter(item => item.path === '/api/auth/login').length, 1, 'reopen reuses only the same managed instance session');
  assert.deepEqual(serverErrors, []); assert.deepEqual(qa.errors, []); assert.equal(qa.outbound(), 0);
  checks.push('removing settings while a waiting QR is polling releases the host-owned session, stops timers and rejects late use, with no external traffic or real QQ execution');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ checks, nativeRequests, onebotRequests, apiRequests,
    publicStages: replies.map(item => item.stage), children: children.length, serverErrors, errors: qa.errors, outbound: qa.outbound(), realQQ: false }, null, 2));
  for (const check of checks) console.log('PASS protocol login roundtrip ' + check);
} catch (error) {
  if (qa) await qa.page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await qa?.close();for(const ws of onebotWs?.clients||[])ws.terminate();if(onebotWs)await new Promise(resolve=>onebotWs.close(resolve));for(const server of [onebotHttp,onebotWsHttp,native])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
