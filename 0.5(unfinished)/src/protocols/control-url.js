import fs from 'node:fs';
import path from 'node:path';

// Read only the control listener settings. Log lines may contain arbitrary QQ messages.
export function snowControlUrl(root, env = {}) {
  let config = {}, current = root;
  for (const part of ['config', 'runtime.json']) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || (part === 'config' ? !stat.isDirectory() : !stat.isFile() || stat.size > 65536)) throw new Error('SnowLuma 管理配置不是有效的普通文件。');
    if (part === 'runtime.json') {
      try { config = JSON.parse(fs.readFileSync(current, 'utf8')); }
      catch { throw new Error('SnowLuma 管理配置格式无效。'); }
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('SnowLuma 管理配置格式无效。');
  const port = Number(env.SNOWLUMA_WEBUI_PORT || config.webuiPort || 5099);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SnowLuma 管理端口无效。');
  let host = String(env.SNOWLUMA_WEBUI_HOST || config.webuiHost || '127.0.0.1').trim();
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '::1') host = '[::1]';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('QQA 只能打开本机的 SnowLuma 管理地址。');
  const override = env.SNOWLUMA_WEBUI_TLS;
  if (override !== undefined && !/^(?:true|false|1|0)$/i.test(String(override))) throw new Error('SnowLuma 管理页面 TLS 设置无效。');
  const tls = override === undefined ? config.webuiTls?.enabled === true : /^(?:true|1)$/i.test(String(override));
  return `${tls ? 'https' : 'http'}://${host}:${port}/`;
}
