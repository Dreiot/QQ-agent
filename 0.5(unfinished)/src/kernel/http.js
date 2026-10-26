// 本地 HTTP 服务：鉴权 → 来源校验 → 路由匹配 → 请求体；SSE；静态两段式防穿越；端口顺延。
// 出处：SPEC §4.7；notes/09b §0 公共守卫契约（顺序即契约：鉴权先于来源校验）。
// 魔法数（SPEC §17.1）：2MB 软上限(413) / 16MB 硬断链 / 15s SSE 心跳 / 端口顺延最多 10 个。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { KEY_READ_DENIED_MESSAGE, keyEndpointAllowed } from '../console/key-access.js';
import { createScopedRouteRegistry } from './scoped-routes.js';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;   // 2MB：超限 413，继续读完丢弃（连接可复用）
export const HARD_BODY_LIMIT = 16 * 1024 * 1024; // 16MB：直接 req.destroy() 断链
const SSE_PING_MS = 15_000;                       // 半开 TCP 没有 FIN 时靠心跳清理僵尸客户端
const CLOSE_GRACE_MS = 1_000;                     // 退出最多等 1s 排空；浏览器预连接可能一直不发送请求
const PORT_TRIES = 10;

const LOOPBACK_HOSTS = [
  /^127\.0\.0\.1(:\d+)?$/, /^localhost(:\d+)?$/, /^\[::1\](:\d+)?$/, // SPEC §17.2 回环 Host 判定
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// CSP 语义复刻（SPEC §4.7）：0.4 是 'self' + 内联脚本 sha256；0.5 前端全部外链文件，
// 无需 hash 例外；外域白名单保持一致。
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' https://o.alicdn.com https://kondius.cn",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://*.aliyuncs.com https://*.alicdn.com https://kondius.cn",
  "frame-ancestors 'none'",
].join('; ');

// Panel 必须能被同源 shell iframe 嵌入；sandbox 后模块请求的 Origin 是 null，
// 因此仅对 /panels/ 的静态子资源按 Origin:null 回应 CORS，避免放开给常规网页。
const PANEL_CSP = SHELL_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

// 来源校验（SPEC §4.7 originAllowed）：服务只监听回环，但浏览器里任意网页都能向
// 127.0.0.1 发简单请求——CORS 只挡读响应、挡不住副作用，所以要看 Host/Origin/Referer。
function originAllowed(req) {
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOSTS.some((re) => re.test(host))) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).host === host; } catch { return false; }
  }
  return true; // 无来源信息（curl/本机脚本）放行
}

// This credential bootstrap is narrower than ordinary API origin checks. A
// browser must identify a same-origin shell fetch; missing/opaque provenance
// never receives a credential. Untrusted panels remain opaque sandbox frames.
export function localConsoleBootstrapAllowed(req, port) {
  if (req.method !== 'POST' || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const address = String(req.socket?.remoteAddress ?? '').toLowerCase();
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (address !== '::1' && !(isIP(ipv4) === 4 && ipv4.startsWith('127.'))) return false;
  const headers = req.headers ?? {}, host = headers.host;
  const hostnames = ['127.0.0.1', 'localhost', '[::1]'];
  const allowedHosts = hostnames.map(hostname => `${hostname}:${port}`);
  if (port === 80) allowedHosts.push(...hostnames);
  if (!allowedHosts.includes(host)) return false;
  const origin = new URL(`http://${host}`).origin;
  if (headers.origin !== origin || headers['sec-fetch-site'] !== 'same-origin'
    || !['same-origin', 'cors'].includes(headers['sec-fetch-mode']) || headers['sec-fetch-dest'] !== 'empty'
    || headers['x-qq-agent-bootstrap'] !== '1' || typeof headers.referer !== 'string') return false;
  try {
    const referer = new URL(headers.referer);
    return referer.origin === origin && !referer.username && !referer.password
      && ['/', '/index.html'].includes(referer.pathname);
  } catch { return false; }
}

function readRawBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overSoft = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy(); // 硬断链（SPEC §4.7）
        reject(Object.assign(new Error('请求体超过硬上限'), { status: 413, destroyed: true }));
        return;
      }
      if (size > maxBytes) overSoft = true; // 继续读完丢弃，连接可复用
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (overSoft) return reject(Object.assign(new Error(`请求体超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限`), { status: 413, expose: true }));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function readBody(req, options) {
  return readRawBody(req, options).then((raw) => {
    if (raw.length === 0) return {};
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, expose: true }); }
  });
}

// 静态服务两段式防穿越（SPEC §16 血泪 6：单靠 replace('..','') 会被 /....// 绕过）：
// ① URL 解码后按 / \ 切段，逐段拒绝空段/./../控制字符；② path.join 后再 path.relative 二次校验。
function safeJoinStatic(root, urlPathname) {
  let decoded;
  try { decoded = decodeURIComponent(urlPathname); } catch { return null; }
  const segs = decoded.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (/[\x00-\x1f]/.test(seg)) return null;
  }
  const joined = path.join(root, ...segs);
  const rel = path.relative(root, joined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return joined;
}

export function createHttpServer({ config, log = console, bus = null, staticDir, extraStaticRoots = [], panelAssetResolver = null, uiAssetResolver = null, apiGuard = null, accountGateway = null }) {
  const { route, createRouteScope, matchRoute } = createScopedRouteRegistry();
  let server = null;
  let actualPort = null;
  const sseClients = new Set();
  let pingTimer = null;
  let tokenWatch = null;
  function endSseClients() {
    for (const res of [...sseClients]) {
      sseClients.delete(res);
      try { res.end(); } catch { /* 已断 */ }
    }
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function handleConsoleBootstrap(req, res) {
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'POST') return sendJson(res, 405, { error: '控制台自动认证仅接受 POST' });
    if (!localConsoleBootstrapAllowed(req, actualPort)) return sendJson(res, 403, { error: '控制台自动认证仅接受本机同源宿主页面' });
    // No cookies or disk state: rotation and a fresh process take effect on the
    // next fetch. The resulting credential still passes every ordinary guard.
    return sendJson(res, 200, { token: config.get().server?.token ?? '' });
  }

  // SSE 裸处理（在路由表之前，SPEC §9b 守卫 6）
  function handleSse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {}\n\n'); // 先写 hello（连接确认，SPEC §9.2）
    sseClients.add(res);
    const cleanup = () => {
      sseClients.delete(res);
      try { res.end(); } catch { /* 已断 */ }
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  function broadcast(event, payload) {
    if(!sseClients.size)return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of [...sseClients]) {
      // A suspended reader must reconnect and recover a snapshot rather than
      // retaining an unbounded stream of tokens/logs in the server heap.
      if(res.writableLength>2*1024*1024){sseClients.delete(res);res.destroy();continue;}
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  }

  async function handleApi(req, res, pathname, urlObj) {
    // 明文密钥读取端点必须单独校验：精确 token 或本机同源来源；不能只依赖通用 API 守卫。
    const keyReadPaths = new Set(['/api/providers/key', '/api/api-key', '/api/search-key', '/api/onebot-token']);
    const isKeyRead = keyReadPaths.has(pathname);
    const token = config.get().server?.token ?? '';
    if (isKeyRead && !keyEndpointAllowed(req, token)) {
      return sendJson(res, 403, { error: KEY_READ_DENIED_MESSAGE });
    }
    // 守卫 1：鉴权（SPEC §4.7）：密钥端点已由上方的“令牌或受信来源”组合守卫覆盖。
    if (token && !isKeyRead) {
      const provided = req.headers['x-console-token'] ?? urlObj.searchParams.get('token');
      if (provided !== token) return sendJson(res, 401, { error: '未授权', code: 'CONSOLE_AUTH_REQUIRED' });
    }
    // 守卫 2：来源校验（密钥端点已由组合守卫覆盖）
    if (!isKeyRead && !originAllowed(req)) {
      return sendJson(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
    }
    const guard = () => apiGuard?.({ method: req.method, pathname });
    let blocked = guard();
    if (blocked) return sendJson(res, blocked.status ?? 409, blocked.body);
    // 守卫 3：路由匹配（显式替换优先，其余保持注册顺序）
    const hit = matchRoute(req.method, pathname);
    if (!hit) return sendJson(res, 404, { error: `未知 API：${req.method} ${pathname}` });

    let body = {};
    let rawBody = Buffer.alloc(0);
    const captchaForward = pathname === '/api/captcha-forward' || pathname === '/api/captcha-forward/';
    const needsJsonBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
    if (captchaForward || needsJsonBody) {
      try {
        if (captchaForward) {
          rawBody = await readRawBody(req, { maxBytes: 8 * 1024 * 1024 });
        } else {
          // 8MB ZIP/背景图的 base64 JSON 约为10.7MB；这两个上传入口允许12MB，通用入口仍是2MB。
          const pluginInstall = pathname === '/api/skills/install' || pathname === '/api/skills/install/';
          const backgroundUpload = req.method === 'POST' && (pathname === '/api/uikit/background' || pathname === '/api/uikit/background/');
          body = await readBody(req, pluginInstall || backgroundUpload ? { maxBytes: 12 * 1024 * 1024 } : undefined);
          rawBody = Buffer.from(JSON.stringify(body));
        }
      } catch (err) {
        if (err.destroyed) return; // 16MB 已断链
        return sendJson(res, err.status === 413 ? 413 : 400, { error: err.message });
      }
    }
    try {
      // Body reads may await while another request submits a reset.
      blocked = guard();
      if (blocked) return sendJson(res, blocked.status ?? 409, blocked.body);
      const out = await hit.r.handler({ req, res, params: hit.params, query: Object.fromEntries(urlObj.searchParams), body, rawBody });
      if (out !== undefined && !res.writableEnded) sendJson(res, 200, out);
    } catch (err) {
      // 守卫 4：处理器错误（SPEC §9b）：expose+status → 4xx；其余 log + 500
      if (err && err.expose && Number.isInteger(err.status)) {
        return sendJson(res, err.status, { error: err.message });
      }
      log.error(`[http] ${req.method} ${pathname} 处理异常：${err?.stack || err}`);
      if (!res.writableEnded) sendJson(res, 500, { error: '服务器内部错误' });
    }
  }

  function serveStatic(req, res, pathname) {
    const panelPrefix = '/panels/';
    // extraStaticRoots：前缀式静态别名（如 /panels/u/ → 用户插件目录）。
    // 命中前缀时整段替换根与相对路径；safeJoinStatic 仍做两段式防穿越。
    const isUserPanel = pathname.startsWith('/panels/u/');
    const alias = extraStaticRoots.find((a) => pathname.startsWith(a.prefix));
    let root;
    let rel;
    let resolvedPanelFile = null;
    // Ordinary plugin URLs always keep their generation/permission guard. Only
    // the trusted boot resolver may replace default shell or bundled UI assets.
    const resolvedUiFile = isUserPanel ? null : uiAssetResolver?.(pathname) ?? null;
    if (resolvedUiFile === false) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    if (isUserPanel) {
      resolvedPanelFile = panelAssetResolver?.(pathname) ?? null;
      if (!resolvedPanelFile) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
    } else if (alias) {
      root = alias.root;
      rel = pathname.slice(alias.prefix.length);
      // minSegments：别名只服务「子目录/文件」两级内容，禁止把别名根下的散文件直接暴露
      //（如 /panels/u/secret.html —— rel 无子目录段时一律 404）
      const segCount = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.').length;
      if (alias.minSegments && segCount < alias.minSegments) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
    } else {
      root = pathname.startsWith(panelPrefix) ? path.join(path.dirname(staticDir), 'panels') : staticDir;
      rel = pathname === '/' ? 'index.html' : pathname.startsWith(panelPrefix) ? pathname.slice(panelPrefix.length) : pathname.slice(1);
    }
    const file = resolvedPanelFile ?? resolvedUiFile ?? safeJoinStatic(root, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    };
    const isPanel = pathname.startsWith(panelPrefix) || Boolean(alias?.prefix?.startsWith(panelPrefix));
    if (ext === '.html' || ext === '.htm') headers['content-security-policy'] = isPanel ? PANEL_CSP : SHELL_CSP;
    // Keep downloaded UI opaque even when its URL is opened directly rather
    // than inside the host iframe. Apply to SVG/other document types as well.
    if (isUserPanel) headers['content-security-policy'] = `${PANEL_CSP}; sandbox allow-scripts`;
    if (isPanel && req?.headers?.origin === 'null') headers['access-control-allow-origin'] = 'null';
    const size=fs.statSync(file).size;
    headers['content-length']=size;
    let start=0,end=size-1,status=200;
    if(ext==='.mp4'||ext==='.webm'){
      headers['accept-ranges']='bytes';
      if(req.headers.range){
        const range=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
        if(range&&(range[1]||range[2])){
          if(range[1]){start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),size-1):size-1;}
          else{const suffix=Number(range[2]);start=Math.max(0,size-suffix);end=size-1;}
        }else start=NaN;
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){
          res.writeHead(416,{...headers,'content-range':`bytes */${size}`,'content-length':0});return res.end();
        }
        status=206;headers['content-range']=`bytes ${start}-${end}/${size}`;headers['content-length']=end-start+1;
      }
    }
    res.writeHead(status, headers);
    if(req.method==='HEAD'||size===0)return res.end();
    const stream=fs.createReadStream(file,{start,end});
    stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
  }

  async function handleHttp(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = urlObj.pathname;
    try {
      if(pathname.startsWith('/accounts/')){
        const match=/^\/accounts\/[^/]+(\/.*)$/.exec(pathname),effectivePath=match?.[1]||'';
        if(effectivePath.startsWith('/api/')){
          const token=config.get().server?.token??'',provided=req.headers['x-console-token']??urlObj.searchParams.get('token');
          if(token&&provided!==token)return sendJson(res,401,{error:'未授权',code:'CONSOLE_AUTH_REQUIRED'});
          if(!originAllowed(req))return sendJson(res,403,{error:'请求来源不被信任（仅接受本机控制台的同源请求）'});
          const blocked=apiGuard?.({method:req.method,pathname:effectivePath});if(blocked)return sendJson(res,blocked.status??409,blocked.body);
        }
        if(!accountGateway)return sendJson(res,404,{error:'当前实例未提供账号网关'});
        return accountGateway({req,res,pathname,urlObj});
      }
      if (pathname === '/api/console/bootstrap') return handleConsoleBootstrap(req, res);
      if (pathname === '/api/events' && req.method === 'GET') {
        // SSE must use the exact same token and origin guards as REST APIs.
        const token = config.get().server?.token ?? '';
        if (token) {
          const provided = req.headers['x-console-token'] ?? urlObj.searchParams.get('token');
          if (provided !== token) return sendJson(res, 401, { error: '未授权', code: 'CONSOLE_AUTH_REQUIRED' });
        }
        if (!originAllowed(req)) return sendJson(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
        return handleSse(req, res);
      }
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, urlObj);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405');
    } catch (err) {
      log.error(`[http] 未捕获异常：${err?.stack || err}`);
      if (!res.writableEnded) sendJson(res, 500, { error: '服务器内部错误' });
    }
  }

  async function listen() {
    if (!tokenWatch && typeof config.onChange === 'function') {
      let previous = config.get().server?.token ?? '';
      tokenWatch = config.onChange(() => {
        const current = config.get().server?.token ?? '';
        if (current !== previous) { previous = current; endSseClients(); }
      });
    }
    // basePort = config.server.port（DEFAULT 已含 PROFILE 偏移；QQ_AGENT_PORT env 优先在 config 层处理，SPEC §5.1）
    const configuredPort = config.get().server?.port;
    const basePort = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535 ? configuredPort : 3210;
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryListen = () => {
        const port = basePort + attempt;
        const srv = http.createServer(handleHttp);
        srv.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempt < PORT_TRIES - 1) {
            attempt += 1;
            srv.close?.();
            tryListen(); // EADDRINUSE 顺延；其它错误直接抛（SPEC §4.3）
          } else {
            reject(err);
          }
        });
        srv.listen(port, '127.0.0.1', () => {
          server = srv;
          actualPort = srv.address().port;
          pingTimer = setInterval(() => {
            for (const res of [...sseClients]) {
              try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
            }
          }, SSE_PING_MS);
          if (typeof pingTimer.unref === 'function') pingTimer.unref();
          resolve(actualPort); // 返回真实端口（含系统分配的临时端口）。
        });
      };
      tryListen();
    });
  }

  async function close() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    tokenWatch?.(); tokenWatch = null;
    endSseClients();
    if (!server) return;
    const closingServer = server;
    await new Promise((resolve) => {
      // close() stops accepting connections, but a browser's spare TCP socket
      // can remain open without ever starting a request. Bound the drain so it
      // cannot hold kernel.stop(), the instance lock and Electron quit forever.
      const timer = setTimeout(() => closingServer.closeAllConnections(), CLOSE_GRACE_MS);
      closingServer.close(() => { clearTimeout(timer); resolve(); });
    });
    server = null;
  }

  return { listen, close, route, createRouteScope, broadcast, get port() { return actualPort; }, sseCount: () => sseClients.size };
}
