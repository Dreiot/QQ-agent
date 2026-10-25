import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** Prove that the paired OneBot WebSocket serves the selected account. HTTP
 * identity is checked by the caller. No address or API path comes from the UI. */
export function verifyProtocolWebSocket({ wsPort, token, accountId, signal,
  WebSocketImpl = WebSocket, timeoutMs = 2000 } = {}) {
  if (!Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535 ||
      typeof token !== 'string' || !token || token.length > 8192 || /[\x00-\x1f\x7f]/.test(token) ||
      typeof accountId !== 'string' || !/^\d{5,10}$/.test(accountId) || signal?.aborted) {
    return Promise.resolve(false);
  }
  const timeout = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(5000, timeoutMs)) : 2000;
  const echo = `qq-agent-login-${randomUUID()}`;
  return new Promise(resolve => {
    let socket, timer, finished = false, result = false;
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (socket) {
        socket.off('open', onOpen);
        socket.off('message', onMessage);
        socket.off('error', onError);
        socket.off('close', onClose);
      }
      resolve(result);
    };
    const finish = value => {
      if (finished) return;
      finished = true;
      result = value;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!socket || socket.readyState === WebSocket.CLOSED) return dispose();
      socket.off('open', onOpen);
      socket.off('message', onMessage);
      // ws emits an error followed by close when a connecting socket is
      // terminated. Retain these two guards until close, then remove both.
      try { socket.terminate(); } catch { dispose(); }
    };
    const onAbort = () => finish(false);
    const onError = () => finish(false);
    const onClose = () => { if (!finished) { finished = true; result = false; } dispose(); };
    const onOpen = () => {
      if (finished || signal?.aborted) return finish(false);
      try { socket.send(JSON.stringify({ action: 'get_login_info', params: {}, echo })); }
      catch { finish(false); }
    };
    const onMessage = (data, isBinary) => {
      if (finished || isBinary) return;
      let body;
      try { body = JSON.parse(data.toString()); } catch { return; }
      if (!body || body.echo !== echo) return;
      finish(body.status === 'ok' && body.retcode === 0 &&
        String(body.data?.user_id ?? '') === accountId);
    };
    try {
      socket = new WebSocketImpl(`ws://127.0.0.1:${wsPort}/`, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: timeout, followRedirects: false,
        perMessageDeflate: false, maxPayload: 65536,
      });
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(false), timeout);
      if (signal?.aborted) finish(false);
    } catch { finish(false); }
  });
}
