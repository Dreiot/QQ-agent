// Actual console route, production panel source and browser settings form.
// Synthetic external protocol states only; no provider process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { registerConsoleRoutes } from '../src/console/routes.js';
import { buildDefaultConfig } from '../src/kernel/config.js';
import { modelUiFixture } from './model-ui-fixture.mjs';

const shellSource = fs.readFileSync(new URL('../ui/shell/app.js', import.meta.url), 'utf8');
const renderSource = shellSource.slice(shellSource.indexOf('function renderRuntime(){'), shellSource.indexOf('function applyRuntimeStatus('));
async function statusPage(t, transport) {
  const handlers = new Map(), cfg = buildDefaultConfig();
  registerConsoleRoutes({ route(method, url, handler) { handlers.set(method + ' ' + url, handler); } }, {
    config: { get: () => structuredClone(cfg), update() {} }, sessions: { todayUsage: () => ({}) }, loader: { listEntries: () => [] },
    orchestrator: { status: () => ({}) }, dataDir: os.tmpdir(), priceUpdates: { resolve: () => null }, marketClient: {}, communityClient: {},
    transportStatus: () => structuredClone(transport),
  });
  const state = await handlers.get('GET /api/status')({});
  const readiness = new Map(), node = { classList: { toggle() {} } };
  const context = vm.createContext({ runtimeStatus: state, runtimeConfig: null, pauseButton: node, pauseBusy: false,
    runtimeLabel: node, cacheHitLabel: node, pauseControls: null, setControlContent() {}, setText() {}, setAttribute() {},
    setReadiness(id, level, label, detail) { readiness.set(id, { level, label, detail }); } });
  vm.runInContext(renderSource + '\nrenderRuntime();', context, { filename: 'production-shell-readiness.js' });
  const onebot = readiness.get('onebot');
  return { state, text: `${onebot.label}：${onebot.detail}`, readiness };
}

test('port failure remains a port diagnosis even after a previous successful login', async t => {
  const { state, text } = await statusPage(t, { connected: false, everConnected: true, error: 'connect ECONNREFUSED 127.0.0.1:31991' });
  assert.match(state.onebot.diagnosis, /端口未监听/); assert.match(text, /31991/);
  assert.doesNotMatch(text, /无账号登录/);
});
test('401 remains an authentication diagnosis', async t => {
  const { state, text } = await statusPage(t, { connected: false, error: 'Unexpected server response: 401' });
  assert.match(state.onebot.diagnosis, /认证失败/); assert.match(text, /对应协议的令牌/);
});
test('a WS socket alone is shown as verifying when the provider has not verified HTTP/account readiness', async t => {
  const { state, text } = await statusPage(t, { connected: true, transportReady: false, stage: 'verifying', selfId: null });
  assert.equal(state.onebot.transportReady, false); assert.match(text, /验证中/); assert.doesNotMatch(text, /已连接/);
});

test('a disconnected status cannot retain a cached ready flag', async t => {
  const { state, text } = await statusPage(t, { connected: false, transportReady: true, selfId: null });
  assert.equal(state.onebot.transportReady, false); assert.match(text, /未连接/); assert.doesNotMatch(text, /已连接/);
});
test('verified account status exposes actual endpoints and no private binding or credential metadata', async t => {
  const { state, text } = await statusPage(t, { connected: true, transportReady: true, selfId: '27801', stage: 'ready',
    bindingKey: 'PRIVATE_BINDING_278', candidateScope: 'PRIVATE_SCOPE_278', accessToken: 'PRIVATE_TOKEN_278',
    connection: { mode: 'manual', accountId: '27801', wsUrl: 'ws://127.0.0.1:31992/events', httpUrl: 'http://127.0.0.1:31993/actions', accessToken: 'PRIVATE_TOKEN_278' } });
  assert.equal(state.onebot.diagnosis, null); assert.match(text, /已连接/); assert.equal(state.onebot.connection.wsUrl, 'ws://127.0.0.1:31992/events'); assert.equal(state.onebot.selfId, '27801');
  assert.doesNotMatch(JSON.stringify(state.onebot), /PRIVATE_/);
});
test('account mismatch from the provider is preserved even with an open socket', async t => {
  const { state, text } = await statusPage(t, { connected: true, transportReady: false, stage: 'account_mismatch', errorCode: 'ONEBOT_ACCOUNT_MISMATCH', diagnosis: 'HTTP、WS 与所选 QQ 账号不一致' });
  assert.equal(state.onebot.errorCode, 'ONEBOT_ACCOUNT_MISMATCH'); assert.match(text, /账号不一致/); assert.doesNotMatch(text, /已连接/);
});
test('replacement transports without the optional readiness extension retain their connected contract', async t => {
  const { state, text } = await statusPage(t, { id: 'replacement-transport', connected: true, selfId: '27802' });
  assert.equal(Object.hasOwn(state.onebot, 'transportReady'), false); assert.match(text, /已连接/);
});

test('credential-shaped errors are redacted before reaching the status DTO or panel', async t => {
  const { state, text } = await statusPage(t, { connected: false, error: 'error token=PRIVATE_278 bearer PRIVATE_BEARER_278', connection: { wsUrl: 'ws://127.0.0.1:31994/?access_token=PRIVATE_QUERY_278' } });
  assert.doesNotMatch(JSON.stringify(state.onebot), /PRIVATE_/); assert.doesNotMatch(text, /PRIVATE_/);
});
test('real settings form saves independent manual endpoints and keeps credentials separate', async t => {
  const qa = await modelUiFixture({ config: { onebot: { wsUrl: 'ws://127.0.0.1:31701/events', httpUrl: 'http://127.0.0.1:31700/actions', accessToken: 'SYNTHETIC_SHOW_WS_278', httpAccessToken: '' } } });
  t.after(() => qa.close());
  const frame = qa.frame;
  await frame.locator('#settings-sidebar a[data-target="onebot"]').click();
  const ws = frame.locator('[data-config-path="onebot.wsUrl"]'), http = frame.locator('[data-config-path="onebot.httpUrl"]');
  await ws.waitFor({ state: 'visible' }); await http.waitFor({ state: 'visible' });
  await ws.fill('ws://127.0.0.1:31702/events'); await http.fill('http://127.0.0.1:31703/actions');
  await frame.locator('.settings-save-toast[data-state=saved]').waitFor({state:'visible'});
  assert.equal(qa.disk().onebot.wsUrl, 'ws://127.0.0.1:31702/events'); assert.equal(qa.disk().onebot.httpUrl, 'http://127.0.0.1:31703/actions');
  assert.equal((await qa.request('GET', '/api/onebot-token?which=ws')).data.token, 'SYNTHETIC_SHOW_WS_278');
  assert.equal((await qa.request('GET', '/api/onebot-token?which=http')).data.token, '', 'show existing HTTP credential must not display an inherited WS credential');
  // Real SSE -> shell state -> readiness UI across default/legacy providers.
  const readiness = qa.page.locator('#ready-onebot');
  const show = async (snapshot, expected, label) => {
    qa.kernel.bus.emit('onebot.status', snapshot);
    await qa.page.waitForFunction(({ expected, label }) => {
      const node = document.querySelector('#ready-onebot');
      return node?.dataset.state === expected && node.textContent.includes(label);
    }, { expected, label });
    assert.equal(await readiness.getAttribute('data-state'), expected);
  };
  await show({ id: 'onebot', connected: true, transportReady: false, stage: 'verifying' }, 'warn', '验证中');
  await show({ id: 'replacement278', connected: true, selfId: '27802' }, 'good', '已连接');
  await show({ id: 'onebot', connected: true, transportReady: false, stage: 'verifying' }, 'warn', '验证中');
  await show({ id: 'onebot', connected: true, transportReady: true, selfId: '27801' }, 'good', '已连接');
  await show({ id: 'onebot', connected: false, transportReady: true, selfId: null }, 'warn', '未连接');
  await show({ id: 'onebot', connected: true, selfId: '27801' }, 'good', '已连接');
  assert.equal(qa.errors.length, 0); assert.equal(qa.outbound(), 0);
});
