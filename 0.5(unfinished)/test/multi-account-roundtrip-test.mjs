// Two real forked kernels, one real parent console/gateway and two loopback
// child OneBot peers plus a separate primary peer. No QQ process, model,
// production data or external service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { test } from 'node:test';

const workspace = path.resolve(import.meta.dirname, '..');
const ACCOUNT_A = '900001', ACCOUNT_B = '900002', GROUP = 800001;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(40); }
  throw new Error('Timed out: ' + description);
}

async function peer(accountId) {
  const token = 'synthetic-onebot-account-' + accountId, sockets = new Set(), actions = [];
  const result = (action, params = {}) => {
    actions.push(action);
    if (action === 'get_login_info') return { user_id: Number(accountId), nickname: 'Fixture ' + accountId };
    if (action === 'get_version_info') return { app_name: 'SnowLuma', app_version: 'fixture', protocol_version: 'v11' };
    if (action === 'get_group_list') return [{ group_id: GROUP, group_name: 'Same group in two accounts' }];
    if (action === 'get_group_info') return { group_id: GROUP, group_name: 'Same group in two accounts' };
    if (action === 'get_group_member_info') return { group_id: GROUP, user_id: params.user_id, nickname: 'Fixture sender', shut_up_timestamp: 0 };
    if (action === 'get_friend_list' || action === 'get_group_member_list') return [];
    if (action === 'get_status') return { online: true, good: true };
    if (/^send_/.test(action)) throw new Error('A paused fixture must never send');
    return {};
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token && new URL(req.url, 'http://127.0.0.1').searchParams.get('access_token') !== token) { res.writeHead(401); res.end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let params = {}; try { params = JSON.parse(raw || '{}'); } catch {}
    try { const data = result(new URL(req.url, 'http://127.0.0.1').pathname.slice(1), params);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    } catch { res.writeHead(500); res.end('{"status":"failed","retcode":1500}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: info => info.req.headers.authorization === 'Bearer ' + token || new URL(info.req.url, 'http://127.0.0.1').searchParams.get('access_token') === token });
  await new Promise(resolve => ws.once('listening', resolve));
  ws.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: Number(accountId), time: Math.floor(Date.now() / 1000) }));
    socket.on('message', raw => { try { const body = JSON.parse(raw.toString()); socket.send(JSON.stringify({
      status: 'ok', retcode: 0, data: result(body.action, body.params), echo: body.echo,
    })); } catch {} });
  });
  return { accountId, token, httpPort: server.address().port, wsPort: ws.address().port, sockets, actions,
    push(text, messageId) { for (const socket of sockets) socket.send(JSON.stringify({
      post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: Number(accountId),
      group_id: GROUP, user_id: 800099, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 800099, nickname: 'Fixture sender', card: '' },
      message: [{ type: 'text', data: { text } }], raw_message: text,
    })); },
    async close() { for (const socket of sockets) socket.terminate(); await new Promise(resolve => ws.close(resolve));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function eventStream(url, token) {
  const controller = new AbortController(), events = [];
  const response = await fetch(url, { headers: { 'x-console-token': token }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); let ended = false;
  const pump = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    try { while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      let end; while ((end = buffer.indexOf('\n\n')) !== -1) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const name = /^event: ?(.+)$/m.exec(frame)?.[1], data = /^data: ?(.+)$/m.exec(frame)?.[1];
        if (name && data) try { events.push({ name, data: JSON.parse(data) }); } catch {}
      }
    } } catch {} finally { ended = true; try { reader.releaseLock(); } catch {} }
  })();
  return { events, get ended() { return ended; }, async close() { controller.abort(); await pump; } };
}

test('two real child kernels isolate messages, sessions, settings, APIs and SSE', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-multi-account-roundtrip-'));
  const appRoot = path.join(root, 'app'), dataDir = path.join(root, 'parent-data');
  const peers = [], streams = []; let kernel;
  t.after(async () => {
    for (const stream of streams) await stream.close();
    await kernel?.stop();
    for (const value of peers) { assert.equal(value.actions.some(action => /^send_/.test(action)), false); await value.close(); }
    assert.equal(fs.existsSync(path.join(appRoot, 'unexpected-model-call')), false);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('qqa-multi-account-roundtrip-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(appRoot);
  for (const name of ['src', 'bundled', 'ui']) fs.cpSync(path.join(workspace, name), path.join(appRoot, name), { recursive: true });
  fs.cpSync(path.join(workspace, 'scripts', 'lib'), path.join(appRoot, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(appRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const layer = path.join(appRoot, 'overrides', '10-local-test'); fs.mkdirSync(layer, { recursive: true });
  fs.writeFileSync(path.join(layer, 'implementation.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
export function prices(){return {resolve:()=>null,refresh:async()=>({ok:true,remote:false})};}
export function forbiddenModel(){fs.writeFileSync(${JSON.stringify(path.join(appRoot, 'unexpected-model-call'))},'forbidden');throw Error('Models disabled in isolated fixture');}
export async function forbiddenFetch(){throw Error('External fetch disabled in isolated fixture');}
export function register(http,context){
  http.route('GET','/api/fixture/identity',()=>({pid:process.pid,dataDir:context.dataDir}));
  http.route('POST','/api/fixture/session',({body})=>{const s=context.sessions.create('group:${GROUP}');context.sessions.finish(s.id,'done',{model:body.label,messages:[{role:'assistant',content:body.label}]});return {id:s.id};});
}
`);
  fs.writeFileSync(path.join(layer, 'composition.json'), JSON.stringify({ version: 1, id: 'isolated-roundtrip',
    components: { 'runtime.priceUpdates': { module: './implementation.mjs', export: 'prices' },
      'llm.complete': { module: './implementation.mjs', export: 'forbiddenModel' },
      'runtime.fetch': { module: './implementation.mjs', export: 'forbiddenFetch' } },
    routes: [{ id: 'fixture', module: './implementation.mjs', export: 'register' }],
  }));
  const [{ createApplication }, { buildDefaultConfig }] = await Promise.all([
    import(pathToFileURL(path.join(appRoot, 'src/kernel/composition.js'))),
    import(pathToFileURL(path.join(appRoot, 'src/kernel/config.js'))),
  ]);
  const initial = buildDefaultConfig(); initial.server.port = 0; initial.server.token = 'synthetic-parent-account-console';
  initial.api.model = 'initial-model'; initial.allowAllWhenEmpty = true; initial.memory.consolidateEnabled = false;
  initial.skills = { watch: false };
  for (const name of fs.readdirSync(path.join(appRoot, 'bundled'))) {
    const file = path.join(appRoot, 'bundled', name, 'plugin.json'); if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); initial.skills[manifest.id] = { enabled: manifest.id === 'transport-onebot' };
  }
  const primaryPeer = await peer('900000'); peers.push(primaryPeer);
  initial.onebot = { httpUrl: 'http://127.0.0.1:' + primaryPeer.httpPort, wsUrl: 'ws://127.0.0.1:' + primaryPeer.wsPort,
    accessToken: primaryPeer.token, httpAccessToken: primaryPeer.token };
  fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(initial));
  kernel = await createApplication({ appRoot, env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0',
    QQ_AGENT_MIGRATE_FROM: path.join(root, 'absent'), QQ_AGENT_EXTENSION_ROOT: appRoot,
    QQ_AGENT_RUNTIME_CACHE_ROOT: path.join(root, 'primary-cache'), QQ_AGENT_ACCOUNTS_CHILD: '0' } });
  kernel.log.setLevel('error'); kernel.orchestrator.pause(); const port = await kernel.start();
  const base = 'http://127.0.0.1:' + port, consoleToken = kernel.config.get().server.token;
  await until(() => kernel.transport.status().connected && kernel.transport.status().selfId === primaryPeer.accountId, 'primary synthetic OneBot handshake');
  const request = async (scope, endpoint, method = 'GET', body) => {
    const response = await fetch(base + (scope ? '/accounts/' + scope : '') + endpoint, { method,
      headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const a = await peer(ACCOUNT_A), b = await peer(ACCOUNT_B); peers.push(a, b);
  const [wa, wb] = await Promise.all([a, b].map(value => kernel.accounts.registerConnection({
    accountId: value.accountId, nickname: 'Fixture ' + value.accountId, provider: 'snowluma',
    httpPort: value.httpPort, wsPort: value.wsPort, token: value.token,
  })));
  assert.notEqual(wa.workspaceId, wb.workspaceId);
  await until(async () => { const snapshot = await kernel.accounts.snapshot(); return [wa, wb].every(value =>
    snapshot.accounts.some(item => item.id === value.workspaceId && item.connected && item.paused)); }, 'two real child OneBot handshakes');
  const identityA = (await request(wa.workspaceId, '/api/fixture/identity')).data;
  const identityB = (await request(wb.workspaceId, '/api/fixture/identity')).data;
  assert.notEqual(identityA.pid, process.pid); assert.notEqual(identityB.pid, process.pid); assert.notEqual(identityA.pid, identityB.pid);
  assert.notEqual(identityA.dataDir, identityB.dataDir);
  // Exercise the actual HTTP card action and verify the real socket closes;
  // pausing model work alone would leave primaryPeer.sockets nonempty.
  const disconnected = await request(null, '/api/accounts/stop', 'POST', { id: 'primary' }); assert.equal(disconnected.status, 200);
  await until(() => primaryPeer.sockets.size === 0, 'primary connection switch closes its real WebSocket');
  assert.equal(disconnected.data.accounts[0].wanted, false); assert.equal(disconnected.data.accounts[0].status, 'stopped'); assert.equal(disconnected.data.accounts[0].connected, false);
  assert.equal((await request(null, '/api/config')).status, 200, 'primary console remains available while disconnected');
  assert.equal((await request(wa.workspaceId, '/api/config')).status, 200); assert.equal((await request(wb.workspaceId, '/api/config')).status, 200);
  assert.equal(a.sockets.size, 1); assert.equal(b.sockets.size, 1);
  kernel.config.update({ api: { model: 'initial-model' } }); await kernel.services.idle();
  assert.equal(primaryPeer.sockets.size, 0, 'a config save cannot silently reconnect an off card');
  const reconnected = await request(null, '/api/accounts/start', 'POST', { id: 'primary' }); assert.equal(reconnected.status, 200);
  await until(() => primaryPeer.sockets.size === 1 && kernel.transport.status().connected, 'primary reconnects its authenticated socket');
  assert.equal(kernel.transport.status().selfId, primaryPeer.accountId); assert.equal(kernel.orchestrator.status().paused, true);
  assert.equal(a.sockets.size, 1); assert.equal(b.sockets.size, 1, 'reconnecting primary does not recycle child transports');
  const snapshotText = JSON.stringify((await request(null, '/api/accounts')).data);
  for (const secret of [a.token, b.token, kernel.accounts.backend(wa.workspaceId).token, kernel.accounts.backend(wb.workspaceId).token]) assert.equal(snapshotText.includes(secret), false);
  const sa = await eventStream(base + '/accounts/' + wa.workspaceId + '/api/events', consoleToken);
  const sb = await eventStream(base + '/accounts/' + wb.workspaceId + '/api/events', consoleToken); streams.push(sa, sb);
  a.push('message-only-account-A', 777); b.push('message-only-account-B', 777);
  const messages = async id => (await request(id, '/api/chats/group_' + GROUP + '/messages')).data.messages || [];
  await until(async () => (await messages(wa.workspaceId)).some(item => item.text === 'message-only-account-A'), 'account A message ingestion');
  await until(async () => (await messages(wb.workspaceId)).some(item => item.text === 'message-only-account-B'), 'account B message ingestion');
  assert.equal(JSON.stringify(await messages(wa.workspaceId)).includes('message-only-account-B'), false);
  assert.equal(JSON.stringify(await messages(wb.workspaceId)).includes('message-only-account-A'), false);
  assert.equal((await request(null, '/api/chats/group_' + GROUP + '/messages')).data.messages.length, 0);
  const sessionA = (await request(wa.workspaceId, '/api/fixture/session', 'POST', { label: 'session-account-A' })).data.id;
  const sessionB = (await request(wb.workspaceId, '/api/fixture/session', 'POST', { label: 'session-account-B' })).data.id;
  assert.ok(sessionA); assert.ok(sessionB); assert.notEqual(sessionA, sessionB);
  assert.equal((await request(wa.workspaceId, '/api/sessions/' + sessionA)).data.model, 'session-account-A');
  assert.equal((await request(wb.workspaceId, '/api/sessions/' + sessionB)).data.model, 'session-account-B');
  assert.equal((await request(wa.workspaceId, '/api/sessions/' + sessionB)).status, 404);
  assert.equal((await request(wb.workspaceId, '/api/sessions/' + sessionA)).status, 404);
  await until(() => sa.events.some(item => item.name === 'session-end' && item.data.id === sessionA), 'scoped A SSE');
  await until(() => sb.events.some(item => item.name === 'session-end' && item.data.id === sessionB), 'scoped B SSE');
  assert.equal(sa.events.some(item => item.name.startsWith('session-') && item.data.id === sessionB), false);
  assert.equal(sb.events.some(item => item.name.startsWith('session-') && item.data.id === sessionA), false);
  assert.equal((await request(wa.workspaceId, '/api/config', 'POST', { api: { model: 'model-account-A' } })).status, 200);
  assert.equal((await request(wb.workspaceId, '/api/config', 'POST', { api: { model: 'model-account-B' } })).status, 200);
  assert.equal((await request(wa.workspaceId, '/api/config')).data.api.model, 'model-account-A');
  assert.equal((await request(wb.workspaceId, '/api/config')).data.api.model, 'model-account-B');
  assert.equal(kernel.config.get().api.model, 'initial-model');
  assert.equal((await fetch(base + '/accounts/' + wa.workspaceId + '/api/config')).status, 401);
  await kernel.accounts.stop(wb.workspaceId);
  await until(() => sb.ended, 'stopped worker SSE closes');
  assert.equal((await request(wb.workspaceId, '/api/config')).status, 409);
  assert.equal((await request(wa.workspaceId, '/api/config')).status, 200);
  assert.equal((await request(null, '/api/accounts')).status, 200);
  assert.equal((await kernel.accounts.snapshot()).accounts.find(item => item.id === wa.workspaceId).connected, true);
  a.push('account-A-still-alive', 778);
  await until(async () => (await messages(wa.workspaceId)).some(item => item.text === 'account-A-still-alive'), 'account A after stopping B');
  assert.equal(peers.every(value => value.actions.every(action => !/^send_/.test(action))), true);
  console.log('Two real child kernels: distinct PIDs, authenticated OneBot handshakes, same-group message/session isolation, scoped APIs/SSE/settings, primary real-socket disconnect/reconnect, and independent stop verified.');
});
