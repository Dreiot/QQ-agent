import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { verifyProtocolWebSocket } from '../src/protocols/verify-connection.js';

const TOKEN = 'synthetic-connection-verification-token';
const ACCOUNT = '900001';

async function fixture(t, respond, { authorized = true, handshake = true } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = [], requests = [];
  server.on('upgrade', (request, socket, head) => {
    requests.push(request);
    if (!handshake) return;
    if (!authorized || request.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', ws => {
    clients.push(ws);
    ws.on('error', () => {});
    ws.on('message', raw => respond?.(ws, JSON.parse(raw.toString())));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const tracked = [];
  class TrackedSocket extends WebSocket {
    constructor(...args) { super(...args); tracked.push(this); }
  }
  const verify = options => verifyProtocolWebSocket({ wsPort: server.address().port,
    token: TOKEN, accountId: ACCOUNT, WebSocketImpl: TrackedSocket, ...options });
  const clean = () => {
    for (const client of tracked) {
      assert.equal(client.readyState, WebSocket.CLOSED);
      for (const name of ['open', 'message', 'error', 'close']) assert.equal(client.listenerCount(name), 0, name);
    }
  };
  return { verify, clean, clients, requests, tracked };
}

test('authenticates on loopback, matches unique echo and account, then releases the socket', async t => {
  const echoes = [];
  const f = await fixture(t, (ws, request) => {
    assert.equal(request.action, 'get_login_info');
    assert.deepEqual(request.params, {});
    echoes.push(request.echo);
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: ACCOUNT }, echo: 'unrelated-event' }));
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: Number(ACCOUNT) }, echo: request.echo }));
  });
  assert.equal(await f.verify(), true);
  assert.equal(await f.verify(), true);
  assert.notEqual(echoes[0], echoes[1]);
  assert.equal(f.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.requests[0].url, '/');
  f.clean();
});

test('rejects a different logged-in account', async t => {
  const f = await fixture(t, (ws, request) => ws.send(JSON.stringify({
    status: 'ok', retcode: 0, data: { user_id: '900002' }, echo: request.echo,
  })));
  assert.equal(await f.verify(), false);
  f.clean();
});

test('rejects OneBot failure envelopes', async t => {
  const f = await fixture(t, (ws, request) => ws.send(JSON.stringify({
    status: 'failed', retcode: 1400, data: { user_id: ACCOUNT }, echo: request.echo,
  })));
  assert.equal(await f.verify(), false);
  f.clean();
});

test('rejects an unauthorized upgrade without leaking an exception', async t => {
  const f = await fixture(t, null, { authorized: false });
  assert.equal(await f.verify(), false);
  f.clean();
});

test('rejects upstream close before identity arrives', async t => {
  const f = await fixture(t, ws => ws.close());
  assert.equal(await f.verify(), false);
  f.clean();
});

test('times out a silent peer and terminates its connection', async t => {
  const f = await fixture(t, () => {});
  assert.equal(await f.verify({ timeoutMs: 40 }), false);
  f.clean();
});

test('closing the view aborts an in-flight verification and removes its abort listener', async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => controller.abort());
  assert.equal(await f.verify({ signal: controller.signal }), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  f.clean();
});

test('already aborted or invalid input never opens a socket', async t => {
  const controller = new AbortController(); controller.abort();
  const f = await fixture(t, () => {});
  assert.equal(await f.verify({ signal: controller.signal }), false);
  assert.equal(await f.verify({ wsPort: 0 }), false);
  assert.equal(await f.verify({ token: 'bad\r\nheader' }), false);
  assert.equal(f.tracked.length, 0);
});
