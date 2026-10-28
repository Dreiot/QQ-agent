// Explicit OneBot endpoints only. No installation, process, or account-file discovery.
import { createHmac, randomBytes } from 'node:crypto';

export function createOneBotConnectionResolver() {
  const secret = randomBytes(32);
  return function resolve(config = {}) {
    const source = config.onebot ?? {};
    const value = key => typeof source[key] === 'string' ? source[key] : '';
    const result = { wsUrl: value('wsUrl'), httpUrl: value('httpUrl'), accessToken: value('accessToken'),
      httpToken: value('httpAccessToken'), mode: 'manual', expectedSelfId: value('expectedSelfId'), accountId: value('expectedSelfId'),
      candidateScope: 'onebot', scopedCredentials: true, connectionError: null, connectionCode: null };
    try {
      if(result.expectedSelfId&&!/^[0-9]{5,10}$/.test(result.expectedSelfId))throw Error('此账号的连接身份无效，请重新接入 QQ');
      const endpoint = (value, protocols) => {
        const url = new URL(value);
        if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\x00-\x20\\]/.test(value)) throw new Error('OneBot 地址无效；请单独填写令牌，不要在地址中包含凭据、查询参数或片段');
        return url;
      };
      const ws = endpoint(result.wsUrl, ['ws:', 'wss:']);
      const http = endpoint(result.httpUrl, ['http:', 'https:']);
      const hostname = url => url.hostname.toLowerCase() === 'localhost' ? '127.0.0.1' : url.hostname.toLowerCase();
      // Never forward a WebSocket credential to an unrelated host or lower TLS level.
      if (!result.httpToken && hostname(ws) === hostname(http) && (ws.protocol === 'wss:') === (http.protocol === 'https:')) result.httpToken = result.accessToken;
    } catch (error) {
      result.connectionError = error.message;
      result.connectionCode = 'ONEBOT_URL_INVALID';
    }
    result.bindingKey = createHmac('sha256', secret).update(JSON.stringify(result)).digest('hex');
    return result;
  };
}
