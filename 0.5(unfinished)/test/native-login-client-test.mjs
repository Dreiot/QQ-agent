import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  authenticateNative, readNativeLogin, refreshNativeQr, injectNativeProcess,
  normalizeSnowProcesses, prepareSnowConnection, snowConnection, NativeLoginError,
} from '../src/protocols/native-login-client.js';

let passed = 0;
const cases = [];
const test = (name, run) => cases.push({ name, run });
const credential = 'isolated-test-native-session';
const password = 'isolated-test-password';
const scanText = 'https://qq.example.test/scan?secret=isolated-qr-only';
const png = 'data:image/png;base64,iVBORw0KGgo=';
const ok = data => ({ code: 0, data, message: 'success' });
function scripted(steps) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    const step = steps.shift();
    assert.ok(step, `unexpected native call: ${path}`);
    assert.equal(path, step.path);
    if (step.check) step.check(options);
    if (step.error) throw step.error;
    return step.value;
  };
  return { request, calls, done: () => assert.equal(steps.length, 0, 'all expected native calls happened') };
}
const isPrivateError = error => {
  assert.ok(error instanceof NativeLoginError);
  const visible = JSON.stringify({ message: error.message, ...error });
  assert.equal(visible.includes(password), false);
  assert.equal(visible.includes(credential), false);
  assert.equal(visible.includes(scanText), false);
  assert.equal(visible.includes('raw-secret'), false);
  return true;
};

test('NapCat token exchange uses exact salted SHA256 contract and Bearer session', async () => {
  const stub = scripted([{ path: '/api/auth/login', value: ok({ Credential: credential }), check: options => {
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.body, { hash: createHash('sha256').update(password + '.napcat').digest('hex') });
    assert.equal(options.body.password, undefined);
  } }]);
  assert.deepEqual(await authenticateNative({ provider: 'napcat', request: stub.request, password }),
    { credential, needsTotp: false, needsNative: false, message: '' });
  stub.done();
});

test('NapCat two-factor challenge and explicit code are supported without retries', async () => {
  let count = 0;
  const request = async (path, options) => {
    count++;
    if (count === 1) return ok({ require2FA: true });
    assert.equal(options.body.totpCode, '123456');
    return ok({ Credential: credential, require2FA: false });
  };
  assert.equal((await authenticateNative({ provider: 'napcat', request, password })).needsTotp, true);
  assert.equal(count, 1);
  assert.equal((await authenticateNative({ provider: 'napcat', request, password, totp: '123456' })).credential, credential);
  assert.equal(count, 2);
});

test('SnowLuma password/TOTP/recovery and native first-password gate', async () => {
  const stub = scripted([{ path: '/api/login', value: { success: false, needsTotp: true } },
    { path: '/api/login', value: { success: true, token: credential, mustChangePassword: true }, check: options => {
      assert.deepEqual(options.body, { password, totp: '123456', recoveryCode: 'recovery-code' });
    } }]);
  assert.equal((await authenticateNative({ provider: 'snowluma', request: stub.request, password })).needsTotp, true);
  const result = await authenticateNative({ provider: 'snowluma', request: stub.request, password, totp: '123456', recoveryCode: 'recovery-code' });
  assert.equal(result.credential, credential);
  assert.equal(result.needsNative, true);
  stub.done();
});

test('credential failure and rate limiting never echo native messages or retry', async () => {
  for (const provider of ['napcat', 'snowluma']) {
    let calls = 0;
    await assert.rejects(authenticateNative({ provider, password, request: async () => {
      calls++; throw { status: 401, body: { message: `${password} ${credential} raw-secret` } };
    } }), error => isPrivateError(error) && error.needsCredentials === true);
    assert.equal(calls, 1);
    await assert.rejects(authenticateNative({ provider, password, request: async () => {
      throw { status: 429, body: { message: `${password} raw-secret` } };
    } }), error => isPrivateError(error) && error.status === 429);
  }
  await assert.rejects(authenticateNative({ provider: 'napcat', password, request: async () => ({ code: -1, message: 'login rate limit raw-secret' }) }),
    error => isPrivateError(error) && error.status === 429);
});

test('NapCat reads raw scan text only into local PNG encoder and exposes no URL', async () => {
  const stub = scripted([{ path: '/api/QQLogin/CheckLoginStatus', value: ok({ isLogin: false, loginPhase: 'waiting_qrcode', qrcodeurl: scanText }), check: options => {
    assert.deepEqual(options.headers, { Authorization: `Bearer ${credential}` });
    assert.equal(options.method, 'POST');
  } }]);
  const result = await readNativeLogin({ provider: 'napcat', request: stub.request, credential, qrImageFor: async text => {
    assert.equal(text, scanText); return png;
  } });
  assert.equal(result.qrImage, png);
  assert.equal(result.canRefresh, true);
  assert.equal(result.stage, 'waiting');
  assert.equal(JSON.stringify(result).includes(scanText), false);
  stub.done();
});

test('NapCat scanned/initializing/reconnecting stages preserve transitions', async () => {
  for (const [phase, stage] of [['qrcode_scanned', 'scanned'], ['initializing', 'initializing'], ['reconnecting', 'initializing'], ['generating_qrcode', 'waiting']]) {
    const result = await readNativeLogin({ provider: 'napcat', credential, request: async () => ok({ isLogin: false, qrLoginAccepted: true, loginPhase: phase }) });
    assert.equal(result.stage, stage);
    assert.equal(result.phase, phase);
    assert.equal(result.canRefresh, false);
    assert.equal(result.pollAfterMs, 500);
  }
});

test('NapCat logged-in read queries account without QR refresh or other mutations', async () => {
  const stub = scripted([{ path: '/api/QQLogin/CheckLoginStatus', value: ok({ isLogin: true, coreReady: true, loginPhase: 'ready', qrcodeurl: scanText }) },
    { path: '/api/QQLogin/GetQQLoginInfo', value: ok({ uid: 'not-exposed', uin: '12345678', nick: '小鲸\n鱼', online: true, token: 'raw-secret' }) }]);
  const result = await readNativeLogin({ provider: 'napcat', credential, request: stub.request,
    qrImageFor: () => assert.fail('logged-in sessions must not render old QR') });
  assert.equal(result.stage, 'connected');
  assert.deepEqual(result.account, { id: '12345678', nickname: '小鲸鱼' });
  assert.equal(result.qrImage, '');
  assert.equal(result.pollAfterMs, 0);
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
  stub.done();
});

test('NapCat core-ready with no actual account remains initializing', async () => {
  for (const info of [{}, { uin: '0', nick: 'not-ready' }, { uin: null }, { uin: 'invalid' }]) {
    const stub = scripted([{ path: '/api/QQLogin/CheckLoginStatus', value: ok({ isLogin: true, coreReady: true, loginPhase: 'ready' }) },
      { path: '/api/QQLogin/GetQQLoginInfo', value: ok(info) }]);
    const state = await readNativeLogin({ provider: 'napcat', credential, request: stub.request });
    assert.equal(state.stage, 'initializing'); assert.equal(state.account, null); assert.equal(state.pollAfterMs, 500); stub.done();
  }
});

test('NapCat ignores unsafe QR results and upstream login errors are sanitized', async () => {
  for (const qrResult of [scanText, '<svg onload="raw-secret">', 'data:image/svg+xml;base64,raw-secret']) {
    const result = await readNativeLogin({ provider: 'napcat', credential, request: async () => ok({ isLogin: false, loginPhase: 'offline', qrcodeurl: scanText, loginError: 'raw-secret' }), qrImageFor: () => qrResult });
    assert.equal(result.stage, 'error');
    assert.equal(result.qrImage, '');
    assert.equal(JSON.stringify(result).includes('raw-secret'), false);
  }
  const expired = await readNativeLogin({ provider: 'napcat', credential, request: async () => ok({ loginPhase: 'waiting_qrcode', loginError: '二维码已过期，请刷新' }) });
  assert.match(expired.error, /已过期/);
});

test('NapCat business Unauthorized is a credentials gate even with HTTP 200', async () => {
  await assert.rejects(readNativeLogin({ provider: 'napcat', credential, request: async () => ({ code: -1, message: `Unauthorized ${credential}` }) }),
    error => isPrivateError(error) && error.needsCredentials === true);
});

test('NapCat refresh is explicit, fixed-path and allows native reconnect responses', async () => {
  for (const value of [ok({ qrcodeurl: scanText }), ok({ qrcodeurl: '', restarting: true })]) {
    const stub = scripted([{ path: '/api/QQLogin/RefreshQRcode', value, check: options => {
      assert.equal(options.timeoutMs, 15000); assert.equal(options.method, 'POST');
    } }]);
    assert.equal(await refreshNativeQr({ request: stub.request, credential }), undefined);
    stub.done();
  }
  await assert.rejects(refreshNativeQr({ credential, request: async () => ({ code: -1, message: `raw-secret ${scanText}` }) }), isPrivateError);
});

test('SnowLuma first consent/password gates preserve native user steps', async () => {
  const consent = scripted([{ path: '/api/agreements', value: { consentRequired: true, documents: ['not-exposed'] } }]);
  const state = await readNativeLogin({ provider: 'snowluma', credential, request: consent.request });
  assert.equal(state.stage, 'native'); assert.equal(state.needsNative, true); assert.equal(state.pollAfterMs, 0);
  consent.done();
  const change = scripted([{ path: '/api/agreements', value: { consentRequired: false } }, { path: '/api/auth/state', value: { mustChangePassword: true } }]);
  assert.equal((await readNativeLogin({ provider: 'snowluma', credential, request: change.request })).needsNative, true);
  change.done();
  for (const gate of ['consentRequired', 'mustChangePassword']) {
    assert.equal((await readNativeLogin({ provider: 'snowluma', credential, request: async () => { throw { status: 403, body: { [gate]: true, message: 'raw-secret' } }; } })).needsNative, true);
  }
});

test('SnowLuma process snapshot exposes only usable process descriptions', async () => {
  const raw = [{ pid: 101, injected: false, connected: false, uin: '0', status: 'available', path: 'raw-secret', error: credential },
    { pid: 102, injected: true, connected: true, loggedIn: true, status: 'online', uin: '87654321', account: { uin: '12345678', nickname: '测试账号', token: credential } },
    { pid: 103, injected: false, connected: false, status: 'error' },
    { pid: 104, injected: false, connected: false, status: 'loading' },
    { pid: 105, injected: true, connected: false, status: 'disconnected' },
    { pid: -1, status: 'available' }];
  const processes = normalizeSnowProcesses(raw);
  assert.equal(processes.length, 5);
  assert.equal(processes[0].accountId, '');
  assert.equal(processes[0].selectable, true);
  assert.equal(processes[1].accountId, '87654321');
  assert.equal(processes[1].nickname, '', 'a historical account nickname must not label a different live account');
  assert.equal(processes[1].selectable, false);
  assert.equal(processes[2].selectable, true);
  assert.equal(processes[3].selectable, false);
  assert.equal(processes[4].selectable, true, 'an injected but disconnected process supports pipe refresh');
  assert.equal(JSON.stringify(processes).includes('raw-secret'), false);
  assert.equal(JSON.stringify(processes).includes(credential), false);
  const stub = scripted([{ path: '/api/agreements', value: {} }, { path: '/api/auth/state', value: {} }, { path: '/api/processes', value: { list: raw }, check: options => {
    assert.deepEqual(options.headers, { 'x-snowluma-token': credential });
  } }]);
  const result = await readNativeLogin({ provider: 'snowluma', credential, request: stub.request });
  assert.equal(result.stage, 'connected');
  assert.deepEqual(result.account, { id: '87654321', nickname: '' });
  assert.deepEqual(result.processes, processes);
  stub.done();
});

test('SnowLuma waiting and initialization avoid guessed account identities', async () => {
  for (const [list, stage, message] of [[[], 'waiting', true], [[{ pid: 1, status: 'loading' }], 'initializing', false], [[{ pid: 2, uin: '0', status: 'available' }], 'waiting', false]]) {
    const result = await readNativeLogin({ provider: 'snowluma', credential, request: async path => path === '/api/processes' ? { list } : {} });
    assert.equal(result.stage, stage); assert.equal(result.account, null); assert.equal(Boolean(result.message), message);
  }
});

test('SnowLuma load rechecks the exact PID immediately before fixed-path POST', async () => {
  const stub = scripted([{ path: '/api/processes', value: { list: [{ pid: 123, status: 'available', injected: false, connected: false }] } },
    { path: '/api/processes/123/load', value: { success: true, process: { token: 'raw-secret' } }, check: options => {
      assert.equal(options.method, 'POST'); assert.equal(options.body, undefined); assert.equal(options.timeoutMs, 30000);
    } }]);
  assert.equal(await injectNativeProcess({ request: stub.request, credential, pid: 123 }), undefined);
  stub.done();
});

test('stale, malformed or already attached PIDs never issue a load', async () => {
  for (const list of [[], [{ pid: 123, status: 'online', injected: true }], [{ pid: 123, status: 'available', connected: true }]]) {
    const stub = scripted([{ path: '/api/processes', value: { list } }]);
    await assert.rejects(injectNativeProcess({ request: stub.request, credential, pid: 123 }), isPrivateError);
    assert.equal(stub.calls.length, 1); stub.done();
  }
  for (const pid of ['123', 0, -1, 1.5, 2 ** 31, '123/load']) {
    await assert.rejects(injectNativeProcess({ request: () => assert.fail('no call for invalid PID'), credential, pid }), isPrivateError);
  }
});

test('SnowLuma HTTP 200 load failure and credentials/status errors are not success', async () => {
  const stub = scripted([{ path: '/api/processes', value: { list: [{ pid: 123, status: 'available' }] } },
    { path: '/api/processes/123/load', value: { success: false, message: `raw-secret ${credential}` } }]);
  await assert.rejects(injectNativeProcess({ request: stub.request, credential, pid: 123 }), isPrivateError);
  stub.done();
  for (const status of [401, 403]) {
    await assert.rejects(readNativeLogin({ provider: 'snowluma', credential, request: async () => { throw { status, body: { message: `${credential} raw-secret` } }; } }),
      error => isPrivateError(error) && error.needsCredentials === true);
  }
});

test('unsupported providers and missing credentials never call native services', async () => {
  const request = () => assert.fail('should not call');
  await assert.rejects(authenticateNative({ provider: 'other', request, password }), isPrivateError);
  await assert.rejects(authenticateNative({ provider: 'napcat', request, password: '' }), error => isPrivateError(error) && error.needsCredentials);
  await assert.rejects(readNativeLogin({ provider: 'napcat', request, credential: '' }), error => isPrivateError(error) && error.needsCredentials);
});

test('Snow connection preparation preserves a full per-account snapshot and unrelated endpoints', async () => {
  const snapshot = {
    unknownRoot: { nested: ['preserved'] }, accountSnapshot: { uin: '12345678', description: 'snapshot-only' },
    networks: {
      unknownNetwork: ['preserved'], httpClients: [{ name: 'other-client', url: 'http://127.0.0.1:19010' }],
      httpServers: [{ name: 'other-http', port: 19001, custom: true }, { name: 'qq-agent-http', port: 19002, retained: 'keep' }],
      wsServers: [{ name: 'other-ws', port: 19003 }, { name: 'qq-agent-ws', port: 19004, customWs: 'keep' }],
    },
  };
  const before = structuredClone(snapshot);
  const stub = scripted([{ path: '/api/config/12345678', value: { config: snapshot }, check: options => assert.equal(options.method, 'GET') },
    { path: '/api/config/12345678', value: { success: true, saved: true, applied: false, online: false, errors: [] }, check: options => {
      assert.equal(options.method, 'POST'); assert.equal(options.timeoutMs, 30000);
      assert.equal(options.body.config, undefined, 'native expects the whole config directly');
      assert.deepEqual(options.body.unknownRoot, snapshot.unknownRoot);
      assert.deepEqual(options.body.accountSnapshot, snapshot.accountSnapshot);
      assert.deepEqual(options.body.networks.unknownNetwork, snapshot.networks.unknownNetwork);
      assert.deepEqual(options.body.networks.httpClients, snapshot.networks.httpClients);
      assert.deepEqual(options.body.networks.httpServers[0], snapshot.networks.httpServers[0]);
      assert.deepEqual(options.body.networks.wsServers[0], snapshot.networks.wsServers[0]);
      assert.deepEqual(options.body.networks.httpServers[1], { name: 'qq-agent-http', port: 19201, retained: 'keep', enabled: true,
        host: '127.0.0.1', messageFormat: 'array', accessToken: credential, reportSelfMessage: false, path: '/' });
      assert.equal(options.body.networks.wsServers[1].port, 19202);
      assert.equal(options.body.networks.wsServers[1].role, 'Universal');
      assert.equal(options.body.networks.wsServers[1].customWs, 'keep');
    } }]);
  const prepared = await prepareSnowConnection({ request: stub.request, credential, accountId: '12345678', httpPort: 19201, wsPort: 19202, token: credential });
  assert.equal(prepared.httpPort, 19201); assert.equal(prepared.wsPort, 19202); assert.equal(typeof prepared.rollback, 'function');
  assert.deepEqual(snapshot, before, 'the read snapshot is never mutated'); stub.done();
});

test('Snow connection preparation requires save success and complete online application', async () => {
  for (const result of [
    { success: false, saved: true, applied: true, online: true },
    { success: true, saved: false, applied: true, online: true },
    { success: true, applied: true, online: true },
    { success: true, saved: true, applied: false, online: true },
    { success: true, saved: true, applied: true, online: true, errors: ['raw-secret'] },
    { success: true, saved: true, applied: true, online: true, errors: { endpoint: credential } },
  ]) {
    const stub = scripted([{ path: '/api/config/12345678', value: { config: { arbitrarySnapshot: 'keep' } } },
      { path: '/api/config/12345678', value: result }]);
    await assert.rejects(prepareSnowConnection({ request: stub.request, credential, accountId: '12345678', httpPort: 19201, wsPort: 19202, token: credential }), isPrivateError);
    stub.done();
  }
  for (const result of [{ success: true, saved: true, applied: true, online: true },
    { success: true, saved: true, applied: false, online: false }]) {
    const stub = scripted([{ path: '/api/config/12345678', value: { config: {} } }, { path: '/api/config/12345678', value: result }]);
    await prepareSnowConnection({ request: stub.request, credential, accountId: '12345678', httpPort: 19201, wsPort: 19202, token: credential }); stub.done();
  }
});

test('Snow connection preparation rejects invalid accounts, malformed snapshots and endpoint options before writing', async () => {
  for (const accountId of ['', '1234', '12345678901', '12345/other', 12345678, null]) {
    await assert.rejects(prepareSnowConnection({ request: () => assert.fail('invalid account must not query config'), credential, accountId, httpPort: 19201, wsPort: 19202, token: credential }), isPrivateError);
  }
  for (const config of [null, [], 'raw-secret', { networks: { httpServers: 'raw-secret' } }]) {
    const stub = scripted([{ path: '/api/config/12345678', value: { config } }]);
    await assert.rejects(prepareSnowConnection({ request: stub.request, credential, accountId: '12345678', httpPort: 19201, wsPort: 19202, token: credential }), isPrivateError); stub.done();
  }
  const stub = scripted([{ path: '/api/config/12345678', value: { config: {} } }]);
  await assert.rejects(prepareSnowConnection({ request: stub.request, credential, accountId: '12345678', httpPort: 19201, wsPort: 19201, token: credential }), isPrivateError); stub.done();
});

test('Snow load rejects same PID with changed account after connection preparation', async () => {
  const stub = scripted([{ path: '/api/processes', value: { list: [{ pid: 123, account: { uin: '87654321' }, status: 'available' }] } }]);
  await assert.rejects(injectNativeProcess({ request: stub.request, credential, pid: 123, expectedAccountId: '12345678' }), error => {
    assert.match(error.message, /账号已变化/); return isPrivateError(error);
  }); stub.done();
  const same = scripted([{ path: '/api/processes', value: { list: [{ pid: 123, account: { uin: '12345678' }, status: 'available' }] } },
    { path: '/api/processes/123/load', value: { success: true } }]);
  await injectNativeProcess({ request: same.request, credential, pid: 123, expectedAccountId: '12345678' }); same.done();
});

test('Snow live identity never falls back to an outdated or invalid desktop account snapshot', async () => {
  const rows = normalizeSnowProcesses([
    { pid: 1, loggedIn: true, uin: '87654321', account: { uin: '12345678', nickname: '旧账号' }, status: 'online' },
    { pid: 2, loggedIn: true, uin: '12345678', account: { uin: '12345678', nickname: '当前账号' }, status: 'online' },
    { pid: 3, loggedIn: true, uin: '0', account: { uin: '12345678', nickname: '旧账号' }, status: 'online' },
    { pid: 4, loggedIn: false, uin: '0', account: { uin: '12345678', nickname: '桌面账号' }, status: 'available' },
  ]);
  assert.deepEqual(rows.map(item => [item.accountId, item.nickname]), [['87654321', ''], ['12345678', '当前账号'], ['', ''], ['12345678', '桌面账号']]);
});

test('injected disconnected processes refresh their pipe instead of loading a second DLL',async()=>{
  const stub=scripted([{path:'/api/processes',value:{list:[{pid:123,account:{uin:'12345678'},injected:true,connected:false,status:'disconnected'}]}},{path:'/api/processes/123/refresh',value:{success:true}}]);
  await injectNativeProcess({request:stub.request,credential,pid:123,expectedAccountId:'12345678'});stub.done();
});
test('connection reuse performs no write and rejects insecure or ambiguous named listeners',async()=>{
  const {mergeProtocolConnection}=await import('../src/protocols/adapters.js');
  const config=mergeProtocolConnection({},{provider:'snowluma',httpPort:19201,wsPort:19202,token:credential});
  const stub=scripted([{path:'/api/config/12345678',value:{config}}]);
  const result=await prepareSnowConnection({request:stub.request,credential,accountId:'12345678',httpPort:19301,wsPort:19302,token:'replacement',reuseExisting:true,verifySaved:true});
  assert.deepEqual(result,{httpPort:19201,wsPort:19202,token:credential});stub.done();
  for(const edit of [c=>c.networks.httpServers.push(c.networks.httpServers[0]),c=>c.networks.wsServers[0].accessToken='different',c=>c.networks.httpServers[0].host='0.0.0.0',c=>c.networks.wsServers[0].enabled=false]){const c=structuredClone(config);edit(c);assert.equal(snowConnection(c),null);}
});
test('successful save must read back the expected settings; rollback keeps unrelated new endpoints',async()=>{
  let config={networks:{httpServers:[{name:'foreign',port:19101}],wsServers:[]}},posts=0;
  const request=async(_path,options)=>{if(options.method==='POST'){posts++;config=structuredClone(options.body);return{success:true,saved:true,applied:true,online:true};}return{config:structuredClone(config)};};
  const prepared=await prepareSnowConnection({request,credential,accountId:'12345678',httpPort:19201,wsPort:19202,token:credential,verifySaved:true});
  config.networks.httpServers.push({name:'another-program',port:19103});await prepared.rollback();assert.equal(posts,2);assert.deepEqual(config.networks.httpServers,[{name:'foreign',port:19101},{name:'another-program',port:19103}]);assert.deepEqual(config.networks.wsServers,[]);
});
test('a partial apply restores owned settings; a concurrent owned edit is never overwritten',async()=>{
  for(const concurrent of [false,true]){
    let config={networks:{httpServers:[],wsServers:[]}},posts=0;
    const request=async(_path,options)=>{if(options.method==='POST'){posts++;config=structuredClone(options.body);if(concurrent)config.networks.httpServers[0].port=19401;return{success:true,saved:true,applied:false,online:true};}return{config:structuredClone(config)};};
    await assert.rejects(prepareSnowConnection({request,credential,accountId:'12345678',httpPort:19201,wsPort:19202,token:credential,verifySaved:true}),isPrivateError);
    assert.equal(posts,concurrent?1:2);assert.deepEqual(config.networks.httpServers,concurrent?config.networks.httpServers:[]);
  }
});
test('a lying successful save cannot be accepted as configured',async()=>{
  let posts=0;const request=async(_path,options)=>{if(options.method==='POST'){posts++;return{success:true,saved:true,applied:true,online:true};}return{config:{networks:{httpServers:[],wsServers:[]}}};};
  await assert.rejects(prepareSnowConnection({request,credential,accountId:'12345678',httpPort:19201,wsPort:19202,token:credential,verifySaved:true}),isPrivateError);assert.equal(posts,1);
});
test('SnowLuma 2.2 canonical defaults support reuse, readback and lossless rollback',async()=>{
  const {mergeProtocolConnection}=await import('../src/protocols/adapters.js');
  const canonical=c=>{const copy=structuredClone(c);for(const row of copy.networks?.httpServers||[]){delete row.enabled;row.enableWebSocket??=false;}for(const row of copy.networks?.wsServers||[])delete row.enabled;return copy;};
  let config=canonical(mergeProtocolConnection({},{provider:'snowluma',httpPort:19201,wsPort:19202,token:credential})),posts=0;
  const request=async(_path,options)=>{if(options.method==='POST'){posts++;config=canonical(options.body);return{success:true,saved:true,applied:true,online:true};}return{config:structuredClone(config)};};
  const reused=await prepareSnowConnection({request,credential,accountId:'12345678',httpPort:19301,wsPort:19302,token:'unused',reuseExisting:true,verifySaved:true});assert.equal(reused.httpPort,19201);assert.equal(posts,0);
  const changed=await prepareSnowConnection({request,credential,accountId:'12345678',httpPort:19301,wsPort:19302,token:credential,verifySaved:true});assert.equal(snowConnection(config).httpPort,19301);await changed.rollback();assert.equal(snowConnection(config).httpPort,19201);assert.equal(posts,2);
});

for (const { name, run } of cases) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`native-login-client: ${passed}/${cases.length} isolated checks passed; no native service requests`);
