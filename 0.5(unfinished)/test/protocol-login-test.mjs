import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProtocolLogin, protocolControlUrl } from '../src/protocols/login.js';

// Everything below is in-memory or a temporary credential fixture. No service is contacted.
const password = 'fixture-native-password';
const napCredential = 'fixture-nap-session';
const snowCredential = 'fixture-snow-session';
const rawQr = 'https://qq.example.test/scan?secret=fixture-qr-text';
const qrPng = 'data:image/png;base64,iVBORw0KGgo=';
const account = '12345678';
const otherAccount = '87654321';
const preparedNapToken = 'b'.repeat(64);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqa-native-login-test-'));
await fs.mkdir(path.join(root, 'napcat', 'config'), { recursive: true });
await fs.writeFile(path.join(root, 'napcat', 'config', 'webui.json'), JSON.stringify({ token: password, ignored: 'fixture-private-config' }));
const tests = [];
const test = (name, run) => tests.push({ name, run });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const napOk = data => ({ code: 0, data });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertPublic(value) {
  const text = JSON.stringify(value);
  for (const secret of [password, napCredential, snowCredential, rawQr, preparedNapToken, 'fixture-private-config', 'fixture-upstream-secret']) {
    assert.equal(text.includes(secret), false, `public state leaked a fixture secret`);
  }
}
function makeHarness({ provider = 'napcat', external = false, onlineAccount = '', nativeGate = null, verifyResult = true, onVerifiedAccount = null, preparedNap = false, canonicalSnow = false, getAccounts = null } = {}) {
  let settings = { onebot: { httpUrl: 'http://127.0.0.1:19101', wsUrl: 'ws://127.0.0.1:19102', accessToken: 'fixture-onebot-token', httpAccessToken: 'fixture-onebot-token' } };
  const changes = new Set(), listeners = new Map(), events = [], calls = [], commits = [], written = [], verifications = [], streamControllers = [];
  let managed = external ? null : { id: 'fixture-package', instanceId: 'fixture-instance', provider, source: 'managed', root,
    webUiUrl: provider === 'napcat' ? 'http://127.0.0.1:6099/webui/' : 'http://127.0.0.1:5099/', httpPort: 19101, wsPort: 19102, account: '',
    ...(preparedNap ? { preparedConnection: { accountId: account, httpPort: 19101, wsPort: 19102, token: preparedNapToken } } : {}) };
  let processes = [{ pid: 101, account: { uin: account, nickname: '测试账号' }, injected: false, connected: false, status: 'available' }];
  let nativeConfig = { snapshotOnly: { retained: true }, networks: { httpClients: [{ name: 'foreign-client', url: 'http://127.0.0.1:19801' }],
    httpServers: [{ name: 'foreign-http', port: 19802, enabled: true }], wsServers: [{ name: 'foreign-ws', port: 19803 }] } };
  let napState = { isLogin: Boolean(onlineAccount), coreReady: Boolean(onlineAccount), loginPhase: onlineAccount ? 'ready' : 'waiting_qrcode', qrcodeurl: rawQr };
  let needTotp = false, authError = null, injectAccountChange = false, configSaved = true, loginInfoAccount = account, streamAborts = 0;
  let beforeNative = null, afterNative = null;
  let port = 19301;
  const bus = { emit(name, body) { events.push({ name, body }); for (const fn of listeners.get(name) || []) fn(body); },
    on(name, fn) { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); } };
  const config = { get: () => settings, update(patch) { settings = { ...settings, ...patch }; for (const fn of changes) fn(settings); }, onChange(fn) { changes.add(fn); return () => changes.delete(fn); } };
  const localProtocols = { loginContext: () => managed, commitLoginConnection(instanceId, selectedAccount, target) {
    assert.equal(instanceId, managed.instanceId); commits.push({ instanceId, account: selectedAccount, target }); managed.account = selectedAccount;
    config.update({ onebot: { httpUrl: `http://127.0.0.1:${target.httpPort}`, wsUrl: `ws://127.0.0.1:${target.wsPort}`, accessToken: target.token, httpAccessToken: target.token } });
  } };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), body = options.body === undefined ? undefined : JSON.parse(options.body);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'all requests remain local');
    assert.equal(options.redirect, 'error');
    calls.push({ url, options, body });
    if (beforeNative) await beforeNative(url, options, body);
    let response;
    if (url.pathname === '/get_version_info') response = json({ status: 'ok', retcode: 0, data: { app_name: provider === 'napcat' ? 'NapCat.Onebot' : 'SnowLuma' } });
    else if (url.pathname === '/api/auth/login') {
      assert.equal(body.hash, createHash('sha256').update(password + '.napcat').digest('hex'));
      response = authError ? json({ message: 'fixture-upstream-secret' }, authError)
        : needTotp && !body.totpCode ? json(napOk({ require2FA: true })) : json(napOk({ Credential: napCredential }));
    } else if (url.pathname === '/api/login') {
      assert.equal(body.password, password);
      response = authError ? json({ message: 'fixture-upstream-secret' }, authError)
        : needTotp && !body.totp ? json({ success: false, needsTotp: true }) : json({ success: true, token: snowCredential, mustChangePassword: false });
    } else if (url.pathname.startsWith('/api/QQLogin/')) {
      assert.equal(options.headers.Authorization, `Bearer ${napCredential}`);
      if (url.pathname.endsWith('/CheckLoginStatus')) response = json(napOk(napState));
      else if (url.pathname.endsWith('/GetQQLoginInfo')) response = json(napOk({ uin: onlineAccount || account, nick: '测试账号', token: 'fixture-upstream-secret' }));
      else if (url.pathname.endsWith('/RefreshQRcode')) { napState = { ...napState, qrcodeurl: rawQr + '&refresh=1' }; response = json(napOk({ qrcodeurl: napState.qrcodeurl })); }
      else assert.fail('unexpected QQLogin endpoint');
    } else if (url.pathname === '/api/state/stream') {
      assert.equal(options.headers['x-snowluma-token'], snowCredential);
      let controller;
      const stream = new ReadableStream({ start(value) { controller = value; streamControllers.push(value); value.enqueue(new TextEncoder().encode('data: {"kind":"ready"}\n\n')); }, cancel() { streamAborts++; } });
      options.signal.addEventListener('abort', () => { streamAborts++; try { controller.close(); } catch {} }, { once: true });
      response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    } else if (url.pathname === '/get_login_info') response = json({ status: 'ok', retcode: 0, data: { user_id: loginInfoAccount } });
    else {
      assert.equal(options.headers['x-snowluma-token'], snowCredential);
      if (nativeGate) response = json({ status: 'failed', [nativeGate]: true, message: 'fixture-upstream-secret' }, 403);
      else if (url.pathname === '/api/agreements') response = json({ consentRequired: false });
      else if (url.pathname === '/api/auth/state') response = json({ mustChangePassword: false });
      else if (url.pathname === '/api/processes') response = json({ list: structuredClone(processes) });
      else if (url.pathname === `/api/config/${account}` && options.method === 'POST') {
        written.push(body); nativeConfig = structuredClone(body);
        if(canonicalSnow){for(const row of nativeConfig.networks.httpServers){delete row.enabled;row.enableWebSocket??=false;}for(const row of nativeConfig.networks.wsServers)delete row.enabled;}
        if (injectAccountChange) processes = processes.map(item => ({ ...item, account: { uin: otherAccount } }));
        const online = processes.some(item => item.status === 'online');
        response = json({ success: configSaved, saved: configSaved, applied: online && configSaved, online });
      } else if (url.pathname === `/api/config/${account}`) response = json({ config: structuredClone(nativeConfig) });
      else if (url.pathname === '/api/processes/101/load') {
        processes = processes.map(item => ({ ...item, injected: true, connected: true, loggedIn: true, uin: item.account.uin, status: 'online' }));
        response = json({ success: true, process: processes[0] });
      } else assert.fail(`unexpected fake endpoint ${url.pathname}`);
    }
    if (afterNative) await afterNative(url, options, body);
    return response;
  };
  const login = createProtocolLogin({ config, localProtocols, bus, fetchImpl, allocatePort: async () => port++, onVerifiedAccount, getAccounts, verifyConnection: async target => {
    verifications.push(target); return verifyResult;
  }, qrImageFor: async text => {
    assert.ok(text.startsWith(rawQr)); return qrPng;
  } });
  return { login, config, bus, calls, commits, written, events, root, verifications,
    emitStream(event) { streamControllers.at(-1)?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
    endStream() { streamControllers.at(-1)?.close(); },
    get streamAborts() { return streamAborts; }, get nativeConfig() { return nativeConfig; }, get managed() { return managed; },
    set processes(value) { processes = value; }, set napState(value) { napState = value; }, set needTotp(value) { needTotp = value; }, set authError(value) { authError = value; },
    set injectAccountChange(value) { injectAccountChange = value; }, set configSaved(value) { configSaved = value; }, set loginInfoAccount(value) { loginInfoAccount = value; },
    set beforeNative(value) { beforeNative = value; }, set afterNative(value) { afterNative = value; }, set managed(value) { managed = value; },
    open: () => login.get(external ? {} : { id: 'fixture-package' }),
  };
}

test('control addresses accept only explicit loopback web roots', async () => {
  for (const address of ['http://127.0.0.1:5099/', 'http://localhost:6099/webui/', 'http://[::1]:6099/webui', 'https://localhost/']) assert.ok(protocolControlUrl(address));
  for (const address of ['https://example.test/', 'http://127.0.0.1.evil.test/', 'http://user:password@localhost/', 'http://localhost/?token=secret', 'http://localhost/#secret', 'http://localhost/api/', 'ws://localhost/', 'file:///C:/secret', '/api/']) assert.equal(protocolControlUrl(address), null);
});

test('managed Nap auto-authenticates once and returns only an encoded QR', async () => {
  const h = makeHarness();
  try {
    const state = await h.open(); assert.equal(state.stage, 'waiting'); assert.equal(state.qrImage, qrPng); assert.equal(state.canRefresh, true); assertPublic(state);
    await h.login.get({ sessionId: state.sessionId });
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/auth/login').length, 1);
    assert.equal(h.calls.some(call => call.url.hostname === 'qq.example.test'), false);
    const fresh = await h.login.refresh({ sessionId: state.sessionId }); assert.equal(fresh.qrImage, qrPng); assertPublic(fresh);
    assert.equal(h.calls.filter(call => call.url.pathname.endsWith('/RefreshQRcode')).length, 1);
  } finally { h.login.close(); }
});

test('managed Nap connected account is read without changing login', async () => {
  const h = makeHarness({ onlineAccount: account, onVerifiedAccount: () => assert.fail('legacy non-deferred Nap must stay read-only') });
  try { const state = await h.open(); assert.equal(state.stage, 'connected'); assert.deepEqual(state.account, { id: account, nickname: '测试账号' }); assert.equal(state.qrImage, ''); assertPublic(state);
    assert.deepEqual(h.calls.map(call => call.url.pathname), ['/api/auth/login', '/api/QQLogin/CheckLoginStatus', '/api/QQLogin/GetQQLoginInfo']);
  } finally { h.login.close(); }
});

test('deferred Nap registers a child only after matching native, HTTP and WS identities', async () => {
  let h, registrations = 0;
  h = makeHarness({ onlineAccount: account, preparedNap: true, onVerifiedAccount: async target => {
    registrations++; assert.equal(target.accountId, account); assert.equal(target.provider, 'napcat'); assert.equal(target.token, preparedNapToken);
    assert.equal(h.verifications.length, 1); assert.ok(h.calls.some(call => call.url.pathname === '/get_login_info' && call.options.headers.Authorization === 'Bearer ' + preparedNapToken));
    return { workspaceId: 'fixture-child-workspace' };
  } });
  try {
    const before = structuredClone(h.config.get()), state = await h.open(); assert.equal(state.stage, 'connected'); assert.equal(state.workspaceId, 'fixture-child-workspace'); assertPublic(state);
    assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), before); assert.equal(registrations, 1);
    const again = await h.login.get({ sessionId: state.sessionId }); assert.equal(again.workspaceId, 'fixture-child-workspace'); assert.equal(registrations, 1); assert.equal(h.verifications.length, 1); assertPublic(again);
  } finally { h.login.close(); }
});

test('deferred Nap primary commits its exact prepared connection after account registration', async () => {
  const h = makeHarness({ onlineAccount: account, preparedNap: true, onVerifiedAccount: async () => ({ workspaceId: 'primary' }) });
  try {
    const state = await h.open(); assert.equal(state.workspaceId, 'primary'); assert.equal(state.stage, 'connected'); assert.equal(h.commits.length, 1); assert.equal(h.commits[0].target.token, preparedNapToken); assertPublic(state);
  } finally { h.login.close(); }
});

test('generic Nap template rejects a remembered QQ without probing or changing it, and explicit selection recovers', async () => {
  let registrations = 0;
  const h = makeHarness({ onlineAccount: account, preparedNap: true, onVerifiedAccount: async () => { registrations++;return { workspaceId: 'selected-child' }; } });
  h.managed = { ...h.managed, preparedConnection: { ...h.managed.preparedConnection, accountId: '', existingAccounts: [account, otherAccount] } };
  try {
    const before = structuredClone(h.config.get()), state = await h.open();
    assert.equal(state.stage, 'error');assert.equal(state.account, null);assert.equal(state.pollAfterMs, 0);assert.equal(state.workspaceId, undefined);
    assert.equal(state.error, '这是已保存的 QQ，请返回选择该账号后连接');assertPublic(state);
    const again = await h.login.get({ sessionId: state.sessionId });assert.equal(again.stage, 'error');
    assert.equal(registrations, 0);assert.equal(h.verifications.length, 0);assert.equal(h.calls.some(call => call.url.pathname === '/get_login_info'), false);assert.equal(h.commits.length, 0);assert.deepEqual(h.config.get(), before);
    h.login.closeView({ sessionId: state.sessionId });
    h.managed = { ...h.managed, instanceId: 'new-explicit-instance', account, preparedConnection: { ...h.managed.preparedConnection, accountId: account } };
    const recovered = await h.open();assert.equal(recovered.stage, 'connected');assert.equal(recovered.workspaceId, 'selected-child');assert.equal(registrations, 1);assert.equal(h.verifications.length, 1);assert.equal(h.commits.length, 0);assert.deepEqual(h.config.get(), before);assertPublic(recovered);
  } finally { h.login.close(); }
});

test('generic Nap template accepts a new QQ only after native, HTTP and WS identity verification', async () => {
  let registrations = 0;
  const h = makeHarness({ onlineAccount: account, preparedNap: true, onVerifiedAccount: async () => { registrations++;return { workspaceId: 'new-qr-child' }; } });
  h.managed = { ...h.managed, preparedConnection: { ...h.managed.preparedConnection, accountId: '', existingAccounts: [otherAccount] } };
  try {
    const before = structuredClone(h.config.get()), state = await h.open();assert.equal(state.stage, 'connected');assert.equal(state.workspaceId, 'new-qr-child');assert.equal(registrations, 1);assert.equal(h.verifications.length, 1);assert.equal(h.calls.filter(call => call.url.pathname === '/get_login_info').length, 1);assert.deepEqual(h.config.get(), before);assert.equal(h.commits.length, 0);assertPublic(state);
  } finally { h.login.close(); }
});

test('deferred Nap refuses a native QQ different from the expected card before probing or registering', async () => {
  let registrations = 0; const h = makeHarness({ onlineAccount: otherAccount, preparedNap: true, onVerifiedAccount: async () => { registrations++; return { workspaceId: 'never' }; } });
  try {
    const before = structuredClone(h.config.get()), state = await h.open(); assert.equal(state.stage, 'error'); assert.equal(state.account, null); assert.match(state.error, /所选账号/);
    assert.equal(registrations, 0); assert.equal(h.verifications.length, 0); assert.equal(h.calls.some(call => call.url.pathname === '/get_login_info'), false); assert.deepEqual(h.config.get(), before); assert.equal(h.commits.length, 0); assertPublic(state);
  } finally { h.login.close(); }
});

test('deferred Nap cannot register or commit until both HTTP and WS are verified', async () => {
  for (const wrongHttp of [true, false]) {
    let registrations = 0; const h = makeHarness({ onlineAccount: account, preparedNap: true, verifyResult: wrongHttp, onVerifiedAccount: async () => { registrations++; return { workspaceId: 'never' }; } });
    if (wrongHttp) h.loginInfoAccount = otherAccount;
    try {
      const before = structuredClone(h.config.get()), state = await h.open(); assert.equal(state.stage, 'initializing'); assert.equal(state.account, null); assert.equal(state.workspaceId, undefined);
      assert.equal(registrations, 0); assert.equal(h.verifications.length, wrongHttp ? 0 : 1); assert.deepEqual(h.config.get(), before); assert.equal(h.commits.length, 0); assertPublic(state);
    } finally { h.login.close(); }
  }
});

test('deferred Nap workspace failure cannot replace the primary connection or expose credentials', async () => {
  const h = makeHarness({ onlineAccount: account, preparedNap: true, onVerifiedAccount: async () => { throw Error('fixture-upstream-secret'); } });
  try {
    const before = structuredClone(h.config.get()); await assert.rejects(h.open(), error => error.status === 502 && !error.message.includes('fixture-upstream-secret'));
    assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), before);
  } finally { h.login.close(); }
});

test('Snow user password is submitted once and cached only within the controller', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  try {
    const initial = await h.open(); assert.equal(initial.needsCredentials, true); assert.equal(h.calls.length, 0);
    const connected = await h.login.connect({ sessionId: initial.sessionId, password }); assert.equal(connected.stage, 'waiting'); assertPublic(connected);
    await h.login.get({ sessionId: initial.sessionId }); await h.open();
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/login').length, 1);
    assert.equal(JSON.stringify(h.config.get()).includes(password), false); assert.equal(JSON.stringify(h.config.get()).includes(snowCredential), false);
  } finally { h.login.close(); }
});

test('two-factor challenge is returned immediately without another password attempt', async () => {
  const h = makeHarness({ provider: 'snowluma' }); h.needTotp = true;
  try { const initial = await h.open(); const challenged = await h.login.connect({ sessionId: initial.sessionId, password });
    assert.equal(challenged.needsTotp, true); assert.equal(challenged.needsCredentials, true); assertPublic(challenged);
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/login').length, 1);
    const next = await h.login.connect({ sessionId: initial.sessionId, password, totp: '123456' }); assert.equal(next.stage, 'waiting');
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/login').length, 2);
  } finally { h.login.close(); }
});

test('Snow first native gates are returned without accepting agreements or changing credentials', async () => {
  for (const gate of ['consentRequired', 'mustChangePassword']) {
    const h = makeHarness({ provider: 'snowluma', nativeGate: gate });
    try { const initial = await h.open(); const state = await h.login.connect({ sessionId: initial.sessionId, password }); assert.equal(state.stage, 'native'); assert.equal(state.needsNative, true); assertPublic(state);
      assert.equal(h.calls.some(call => /accept|password|consent/.test(call.url.pathname)), false);
    } finally { h.login.close(); }
  }
});

test('Snow selected account preserves config and commits only its verified new connection', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const old = structuredClone(h.nativeConfig);
    const state = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(h.written.length, 1); assert.equal(h.written[0].config, undefined);
    assert.deepEqual(h.written[0].snapshotOnly, old.snapshotOnly); assert.deepEqual(h.written[0].networks.httpClients, old.networks.httpClients);
    assert.deepEqual(h.written[0].networks.httpServers[0], old.networks.httpServers[0]); assert.deepEqual(h.written[0].networks.wsServers[0], old.networks.wsServers[0]);
    assert.equal(h.commits.length, 1); assert.equal(h.commits[0].account, account); assert.notEqual(h.commits[0].target.httpPort, h.commits[0].target.wsPort);
    assert.equal(state.stage, 'connected'); assert.equal(state.account.id, account); assertPublic(state);
    assert.equal(JSON.stringify(state).includes(h.commits[0].target.token), false);
  } finally { h.login.close(); }
});

test('Snow mismatching real OneBot account cannot commit the prepared target', async () => {
  const h = makeHarness({ provider: 'snowluma' }); h.loginInfoAccount = otherAccount;
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const old = structuredClone(h.config.get());
    const state = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), old); assert.equal(state.stage, 'initializing'); assert.equal(state.account, null); assertPublic(state);
  } finally { h.login.close(); }
});

test('Snow requires successful WebSocket verification before committing a prepared connection', async () => {
  const h = makeHarness({ provider: 'snowluma', verifyResult: false });
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const old = structuredClone(h.config.get());
    const state = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.ok(h.verifications.length > 0, 'the WebSocket connection must be checked');
    assert.ok(h.verifications.every(target => target.accountId === account), 'WS verification must bind to the selected account, so wrong-account events fail');
    assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), old); assert.equal(state.stage, 'initializing'); assert.equal(state.account, null); assertPublic(state);
  } finally { h.login.close(); }
});

test('external Snow retains the explicitly selected account after committing and subsequent reads', async () => {
  const h = makeHarness({ provider: 'snowluma', external: true });
  try {
    const initial = await h.open();
    await h.login.connect({ sessionId: initial.sessionId, webUiUrl: 'http://127.0.0.1:5099/', password });
    const state = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(state.stage, 'connected'); assert.equal(state.account.id, account);
    assert.equal(h.commits.length, 0, 'external setup writes the application config directly');
    assert.equal(h.config.get().onebot.httpUrl, 'http://127.0.0.1:19301');
    assert.equal(h.config.get().onebot.wsUrl, 'ws://127.0.0.1:19302');
    assert.ok(h.verifications.every(target => target.accountId === account));
    const subsequent = await h.login.get({ sessionId: initial.sessionId });
    assert.equal(subsequent.stage, 'connected'); assert.equal(subsequent.account.id, account);
    assert.equal(subsequent.source, 'external'); assert.equal(subsequent.needsAddress, false); assertPublic(subsequent);
    const reopened = await h.open(); assert.equal(reopened.stage, 'connected'); assert.equal(reopened.account.id, account);
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/login').length, 1);
  } finally { h.login.close(); }
});

test('an already online Snow QQ can become the target without loading it again', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  h.processes = [{ pid: 101, uin: account, account: { uin: account, nickname: '在线账号' }, injected: true, connected: true, loggedIn: true, status: 'online' }];
  try {
    const initial = await h.open(); const choices = await h.login.connect({ sessionId: initial.sessionId, password });
    assert.equal(choices.processes[0].selectable, true, 'online QQ must be selectable as an application connection target');
    const selected = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(h.calls.some(call => call.url.pathname.endsWith('/load')), false, 'no duplicate injection');
    assert.equal(h.written.length, 1, 'native config is hot-updated for this account');
    assert.ok(h.calls.some(call => call.url.pathname === '/get_login_info'), 'HTTP identity is verified');
    assert.ok(h.verifications.length > 0, 'WS identity and token are verified');
    assert.equal(h.commits.length, 1); assert.equal(selected.stage, 'connected'); assert.equal(selected.account.id, account); assertPublic(selected);
  } finally { h.login.close(); }
});

test('already online Snow target still requires matching HTTP and verified WS identity', async () => {
  for (const { wrongHttp, verifyResult } of [{ wrongHttp: true, verifyResult: true }, { wrongHttp: false, verifyResult: false }]) {
    const h = makeHarness({ provider: 'snowluma', verifyResult });
    h.processes = [{ pid: 101, uin: account, account: { uin: account, nickname: '在线账号' }, injected: true, connected: true, loggedIn: true, status: 'online' }];
    if (wrongHttp) h.loginInfoAccount = otherAccount;
    try {
      const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const old = structuredClone(h.config.get());
      const state = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
      assert.equal(h.calls.some(call => call.url.pathname.endsWith('/load')), false);
      assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), old); assert.equal(state.stage, 'initializing'); assert.equal(state.account, null);
    } finally { h.login.close(); }
  }
});

test('verified Snow child workspace preserves primary and stays selected in subsequent GET', async () => {
  const attached = [], workspaceId = '4bee208a-3f6f-46a8-8145-fb2222222222'; let h;
  h = makeHarness({ provider: 'snowluma', onVerifiedAccount: async target => {
    assert.ok(h.verifications.length > 0, 'WS identity is verified before workspace registration');
    assert.equal(target.accountId, account); assert.equal(target.provider, 'snowluma'); attached.push(target); return { workspaceId };
  } });
  try {
    const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const primary = structuredClone(h.config.get());
    const selected = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(selected.workspaceId, workspaceId); assert.equal(selected.account.id, account); assert.equal(selected.stage, 'connected');
    assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), primary); assert.equal(attached.length, 1);
    const next = await h.login.get({ sessionId: initial.sessionId }); assert.equal(next.workspaceId, workspaceId); assert.equal(next.account.id, account); assert.equal(next.stage, 'connected');
    assert.equal(attached.length, 1); assertPublic(next);
  } finally { h.login.close(); }
});

test('verified primary workspace still commits its own connection after identity verification', async () => {
  const h = makeHarness({ provider: 'snowluma', onVerifiedAccount: async target => { assert.equal(target.accountId, account); return { workspaceId: 'primary' }; } });
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const selected = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(selected.workspaceId, 'primary'); assert.equal(h.commits.length, 1); assert.equal(h.commits[0].account, account);
  } finally { h.login.close(); }
});

test('failed workspace registration cannot prematurely replace the primary connection', async () => {
  let attempts = 0;
  const h = makeHarness({ provider: 'snowluma', onVerifiedAccount: async () => { attempts++; throw Error('fixture-upstream-secret'); } });
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); const primary = structuredClone(h.config.get());
    const selected = await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    assert.equal(attempts, 1); assert.equal(h.commits.length, 0); assert.deepEqual(h.config.get(), primary); assert.equal(selected.stage, 'error');
    assert.equal(selected.workspaceId, undefined); assert.equal(selected.account, null); assertPublic(selected);
  } finally { h.login.close(); }
});

test('unverified HTTP or WS accounts never reach workspace registration', async () => {
  for (const wrongHttp of [true, false]) {
    let attempts = 0; const h = makeHarness({ provider: 'snowluma', verifyResult: wrongHttp, onVerifiedAccount: async () => { attempts++; return { workspaceId: 'never' }; } });
    if (wrongHttp) h.loginInfoAccount = otherAccount;
    try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
      assert.equal(attempts, 0); assert.equal(h.commits.length, 0);
    } finally { h.login.close(); }
  }
});

test('pending Snow connection times out with an error and stops trying the uncommitted target', async () => {
  const h = makeHarness({ provider: 'snowluma' }); h.loginInfoAccount = otherAccount;
  const actualNow = Date.now;
  try {
    const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password });
    await h.login.inject({ sessionId: initial.sessionId, pid: 101 });
    const expiredNow = actualNow() + 31000; Date.now = () => expiredNow;
    await wait(820);
    const state = await h.login.get({ sessionId: initial.sessionId });
    assert.equal(state.stage, 'error'); assert.ok(state.error); assert.equal(h.commits.length, 0); assertPublic(state);
    const previous = h.calls.filter(call => call.url.pathname === '/get_login_info').length;
    await h.login.get({ sessionId: initial.sessionId }); await wait(820);
    assert.equal(h.calls.filter(call => call.url.pathname === '/get_login_info').length, previous, 'expired pending target must be cleared');
  } finally { Date.now = actualNow; h.login.close(); }
});

test('Snow changed PID account after preparation is rejected before load', async () => {
  const h = makeHarness({ provider: 'snowluma' }); h.injectAccountChange = true;
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password });
    await assert.rejects(h.login.inject({ sessionId: initial.sessionId, pid: 101 }));
    assert.equal(h.calls.some(call => call.url.pathname.endsWith('/load')), false); assert.equal(h.commits.length, 0);
  } finally { h.login.close(); }
});

test('Snow configuration save failure blocks process injection and connection commit', async () => {
  const h = makeHarness({ provider: 'snowluma' }); h.configSaved = false;
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password });
    await assert.rejects(h.login.inject({ sessionId: initial.sessionId, pid: 101 })); assert.equal(h.calls.some(call => call.url.pathname.endsWith('/load')), false); assert.equal(h.commits.length, 0);
  } finally { h.login.close(); }
});

test('external detection never guesses an admin URL and rejects hostile addresses before authentication', async () => {
  const h = makeHarness({ provider: 'snowluma', external: true });
  try { const initial = await h.open(); assert.equal(initial.provider, 'snowluma'); assert.equal(initial.needsAddress, true);
    assert.deepEqual(h.calls.map(call => call.url.pathname), ['/get_version_info']);
    for (const webUiUrl of ['https://example.test/', 'http://localhost/api/', 'http://localhost/?token=secret']) await assert.rejects(h.login.connect({ sessionId: initial.sessionId, webUiUrl, password }), error => error.status === 400);
    assert.equal(h.calls.length, 1);
    const state = await h.login.connect({ sessionId: initial.sessionId, webUiUrl: 'http://127.0.0.1:5099/', password }); assert.equal(state.stage, 'waiting'); assertPublic(state);
  } finally { h.login.close(); }
});

test('new view, managed restart and external configuration changes invalidate stale sessions', async () => {
  const h = makeHarness();
  try { const first = await h.open(); const second = await h.open(); assert.notEqual(first.sessionId, second.sessionId);
    await assert.rejects(h.login.refresh({ sessionId: first.sessionId }), error => error.status === 409);
    h.managed = { ...h.managed, instanceId: 'next-instance' }; h.bus.emit('local-protocols', {});
    await assert.rejects(h.login.get({ sessionId: second.sessionId }), error => error.status === 409);
  } finally { h.login.close(); }
  const ext = makeHarness({ provider: 'snowluma', external: true });
  try { const first = await ext.open(); ext.config.update({ onebot: { httpUrl: 'http://127.0.0.1:19901' } });
    await assert.rejects(ext.login.get({ sessionId: first.sessionId }), error => error.status === 409);
  } finally { ext.login.close(); }
});

test('concurrent initial opens keep the latest generation and reject a slower previous open', async () => {
  const h = makeHarness({ provider: 'snowluma', external: true });
  try {
    let releaseFirst, firstEntered; const entered = new Promise(resolve => { firstEntered = resolve; }); let versionCalls = 0;
    h.beforeNative = (url) => {
      if (url.pathname !== '/get_version_info' || ++versionCalls !== 1) return;
      firstEntered(); return new Promise(resolve => { releaseFirst = resolve; });
    };
    const old = h.open(); const oldResult = old.then(value => ({ value }), error => ({ error }));
    await entered; const fresh = await h.open(); releaseFirst();
    assert.equal((await oldResult).error?.status, 409);
    const stillFresh = await h.login.get({ sessionId: fresh.sessionId }); assert.equal(stillFresh.sessionId, fresh.sessionId);
  } finally { h.login.close(); }
});

test('a stale GET returning after a reopened view cannot overwrite the new session', async () => {
  const h = makeHarness();
  try {
    const initial = await h.open(); let releaseOld, oldEntered; const entered = new Promise(resolve => { oldEntered = resolve; }); let blocked = false;
    h.beforeNative = url => {
      if (!url.pathname.endsWith('/CheckLoginStatus') || blocked) return;
      blocked = true; oldEntered(); return new Promise(resolve => { releaseOld = resolve; });
    };
    const old = h.login.get({ sessionId: initial.sessionId }); const result = old.then(value => ({ value }), error => ({ error }));
    await entered; const fresh = await h.open(); releaseOld();
    assert.equal((await result).error?.status, 409);
    assert.notEqual(fresh.sessionId, initial.sessionId); assertPublic(fresh);
    assert.equal((await h.login.get({ sessionId: fresh.sessionId })).sessionId, fresh.sessionId);
  } finally { h.login.close(); }
});

test('reauthentication cancels the previous Snow SSE and opens one with the new session', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  try {
    const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); await tick();
    const first = h.calls.filter(call => call.url.pathname === '/api/state/stream'); assert.equal(first.length, 1);
    await h.login.connect({ sessionId: initial.sessionId, password }); await tick();
    assert.equal(first[0].options.signal.aborted, true);
    const current = h.calls.filter(call => call.url.pathname === '/api/state/stream'); assert.equal(current.length, 2); assert.equal(current[1].options.signal.aborted, false);
    h.emitStream({ resource: 'processes', data: [{ pid: 101, token: snowCredential, error: 'fixture-upstream-secret' }] });
    await wait(85);
    const metadata = h.events.filter(event => event.name === 'protocol-login'); assert.ok(metadata.length > 0);
    for (const { body } of metadata) { assert.deepEqual(Object.keys(body).sort(), ['revision', 'sessionId']); assertPublic(body); }
  } finally { h.login.close(); }
});

test('closing a view aborts its in-flight request and late results cannot update it', async () => {
  const h = makeHarness();
  try { const initial = await h.open(); let entered, pendingSignal; const started = new Promise(resolve => { entered = resolve; });
    h.beforeNative = (url, options) => url.pathname.endsWith('/CheckLoginStatus') ? new Promise((resolve, reject) => {
      pendingSignal = options.signal; entered(); options.signal.addEventListener('abort', () => reject(new Error('fixture-upstream-secret')), { once: true });
    }) : undefined;
    const pending = h.login.get({ sessionId: initial.sessionId }); const settled = pending.then(() => null, error => error);
    await started; h.login.closeView({ sessionId: initial.sessionId }); assert.equal(pendingSignal.aborted, true);
    assert.equal((await settled).status, 409);
    await assert.rejects(h.login.get({ sessionId: initial.sessionId }), error => error.status === 409);
  } finally { h.login.close(); }
});

test('hiding and closing a Snow view cancel native SSE and keep bus payloads free of login data', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  try { const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); await tick();
    const stream = h.calls.find(call => call.url.pathname === '/api/state/stream'); assert.ok(stream); assert.equal(stream.options.signal.aborted, false);
    h.login.visibility({ sessionId: initial.sessionId, visible: false }); await tick(); assert.equal(stream.options.signal.aborted, true);
    await h.login.get({ sessionId: initial.sessionId }); await tick(); const streams = h.calls.filter(call => call.url.pathname === '/api/state/stream'); assert.equal(streams.length, 2);
    h.login.closeView({ sessionId: initial.sessionId }); await tick(); assert.equal(streams[1].options.signal.aborted, true);
    await wait(70); for (const event of h.events) assertPublic(event);
  } finally { h.login.close(); }
});

test('Snow native SSE reconnects after normal EOF and never reconnects after its view closes', async () => {
  const h = makeHarness({ provider: 'snowluma' });
  try {
    const initial = await h.open(); await h.login.connect({ sessionId: initial.sessionId, password }); await tick();
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/state/stream').length, 1);
    h.endStream(); await wait(1120);
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/state/stream').length, 2, 'EOF schedules one reconnect');
    const recovered = await h.login.get({ sessionId: initial.sessionId });
    assert.equal(recovered.error, '', 'a recovered stream must clear the interrupted-update warning');
    h.endStream(); h.login.closeView({ sessionId: initial.sessionId }); await wait(1120);
    assert.equal(h.calls.filter(call => call.url.pathname === '/api/state/stream').length, 2, 'closed view cancels pending backoff');
  } finally { h.login.close(); }
});

test('service close blocks future opens and disposes configuration/runtime subscriptions', async () => {
  const h = makeHarness(); await h.open(); h.login.close();
  await assert.rejects(h.open(), error => error.status === 409);
  h.config.update({ onebot: {} }); h.bus.emit('local-protocols', {});
});

test('Snow repeating a verified account connection keeps its native ports and token stable', async()=>{
  const h=makeHarness({provider:'snowluma',canonicalSnow:true});try{
    const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});await h.login.inject({sessionId:initial.sessionId,pid:101});
    const native=structuredClone(h.nativeConfig),connection=structuredClone(h.config.get().onebot),writes=h.written.length;
    await h.login.inject({sessionId:initial.sessionId,pid:101});assert.deepEqual(h.nativeConfig,native,'reconnect must not replace existing listeners');assert.deepEqual(h.config.get().onebot,connection);assert.equal(h.written.length,writes,'unchanged native config needs no rewrite');
  }finally{h.login.close();}
});
test('Snow native online state alone never claims a verified QQA connection',async()=>{
  const h=makeHarness({provider:'snowluma',verifyResult:false});h.managed.account=account;h.processes=[{pid:101,uin:account,account:{uin:account,nickname:'在线但未核验'},injected:true,connected:true,loggedIn:true,status:'online'}];try{
    const initial=await h.open();const state=await h.login.connect({sessionId:initial.sessionId,password});assert.notEqual(state.stage,'connected');assert.equal(state.account,null);assert.equal(h.commits.length,0);
  }finally{h.login.close();}
});
test('Snow workspace failure is explicit and does not silently retry registration',async()=>{
  let attempts=0;const h=makeHarness({provider:'snowluma',onVerifiedAccount:async()=>{attempts++;throw Object.assign(Error('fixture-private-details'),{status:503});}});try{
    const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});const state=await h.login.inject({sessionId:initial.sessionId,pid:101});assert.equal(state.stage,'error');assert.ok(state.error);assertPublic(state);await h.login.get({sessionId:initial.sessionId});assert.equal(attempts,1,'registration must wait for another explicit user attempt');
  }finally{h.login.close();}
});

test('Snow configuration failure remains visible after subsequent metadata refresh',async()=>{
 const h=makeHarness({provider:'snowluma'});h.configSaved=false;try{const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});await assert.rejects(h.login.inject({sessionId:initial.sessionId,pid:101}));const state=await h.login.get({sessionId:initial.sessionId});assert.equal(state.stage,'error');assert.ok(state.error);assert.equal(h.commits.length,0);assertPublic(state);}finally{h.login.close();}
});
test('closing and reopening an unfinished Snow connection never hands off the abandoned target',async()=>{
 let attempts=0;const h=makeHarness({provider:'snowluma',onVerifiedAccount:async()=>{attempts++;return{workspaceId:'primary'};}});h.loginInfoAccount=otherAccount;
 try{const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});await h.login.inject({sessionId:initial.sessionId,pid:101});h.login.closeView({sessionId:initial.sessionId});h.loginInfoAccount=account;const fresh=await h.open();await h.login.get({sessionId:fresh.sessionId});assert.equal(attempts,0);assert.equal(h.commits.length,0);}finally{h.login.close();}
});

test('live workspace metadata controls connected state without self-triggering WS probes',async()=>{
 let connected=true;const h=makeHarness({provider:'snowluma',getAccounts:async()=>({accounts:[{id:'primary',accountId:account,wanted:true,connected}]})});try{
  const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});const selected=await h.login.inject({sessionId:initial.sessionId,pid:101});assert.equal(selected.stage,'connected');const count=h.verifications.length;
  for(let i=0;i<5;i++){h.emitStream({resource:'connections'});assert.equal((await h.login.get({sessionId:initial.sessionId})).stage,'connected');}assert.equal(h.verifications.length,count,'connections events must never open another WS probe');
  connected=false;const offline=await h.login.get({sessionId:initial.sessionId});assert.equal(offline.stage,'waiting');assert.equal(offline.account,null);assert.equal(h.verifications.length,count);
 }finally{h.login.close();}
});

test('a concurrent status GET cannot register the same pending account twice',async()=>{
 let attempts=0,release,entered;const started=new Promise(resolve=>{entered=resolve;});const h=makeHarness({provider:'snowluma',onVerifiedAccount:async()=>{attempts++;entered();await new Promise(resolve=>{release=resolve;});return{workspaceId:'primary'};}});
 try{const initial=await h.open();await h.login.connect({sessionId:initial.sessionId,password});const injection=h.login.inject({sessionId:initial.sessionId,pid:101});await started;await h.login.get({sessionId:initial.sessionId});assert.equal(attempts,1);release();assert.equal((await injection).stage,'connected');assert.equal(attempts,1);}finally{release?.();h.login.close();}
});

let passed = 0;
const failures = [];
try {
  for (const { name, run } of tests) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.message}`); }
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log(`protocol-login: ${passed}/${tests.length} isolated controller checks passed; no service contacted`);
if (failures.length) throw new AggregateError(failures.map(item => item.error), `${failures.length} protocol-login checks failed`);
