// 67 · 面板 API 声明完整性：panel.js 里请求的每个端点都必须在 manifest.json 声明。
//
// 踩坑记录（严重）：设置页打开后**一个设置项都没有**，只有"未授权的面板 API"。
// 根因：settings/panel.js 请求了 3 个未声明的端点（/api/tools、/api/tools/availability、
// /api/skills/capabilities），rpc-bridge 的 allowed() 拒绝 → 返回 403，
// 而面板用的是 `Promise.all([...6个请求])` —— **一个被拒，全部失败**，
// 于是 load() 直接进 catch，整个设置页空白。
//
// 这类 bug 的可怕之处：不报错、不进日志、静态契约测试也看不出（它们是两边的独立检查）。
// 必须把"面板请求集合 ⊆ manifest 声明集合"这条关系本身锁死。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLocalProtocolRoutes } from '../src/console/local-protocols.js';
import { registerAccountRoutes } from '../src/accounts/routes.js';
import {registerLocalFontRoutes} from '../src/console/local-fonts.js';
import {registerGroupManagementRoutes} from '../src/console/group-management.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ui/panels/manifest.json'), 'utf8'));

/** 与 rpc-bridge.js 的 routePattern 保持同源（:id 匹配单段）。 */
const routePattern = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '[^/]+')}$`);

/** 从面板 JS 里提取静态可判定的 request('METHOD','/api/...') 调用。 */
function extractRequests(src) {
  const out = new Set();
  for (const m of src.matchAll(/request\(\s*'([A-Z]+)'\s*,\s*[`'"]([^`'"]+)[`'"]/g)) {
    const [, method, p] = m;
    if (p.includes('${')) continue; // 动态拼接的路径无法静态判定，跳过
    out.add(`${method} ${p}`);
  }
  return out;
}

console.log('=== A. 每个面板请求的端点都已在 manifest 声明 ===');
{
  const problems = [];
  let panelsChecked = 0, requestsChecked = 0;
  for (const panel of manifest.panels) {
    const file = path.join(root, 'ui/panels', panel.id, 'panel.js');
    if (!fs.existsSync(file)) continue;
    panelsChecked += 1;
    const reqs = extractRequests(fs.readFileSync(file, 'utf8'));
    requestsChecked += reqs.size;
    const declared = panel.api ?? [];
    for (const req of reqs) {
      const [method, ...rest] = req.split(' ');
      const p = rest.join(' ');
      const ok = declared.some((rule) => rule.method === method && routePattern(rule.path).test(p));
      if (!ok) problems.push(`${panel.id}: ${req}`);
    }
  }
  assert.equal(problems.length, 0,
    `以下请求未在 manifest.json 声明（会返回 403「未授权的面板 API」，并可能让面板整体空白）：\n  ${problems.join('\n  ')}`);
  console.log(`✓ ${panelsChecked} 个面板、${requestsChecked} 个静态请求，全部已声明`);
}

console.log('=== B. 声明的每条端点后端都真实存在 ===');
{
  // routes.js 里路由有两种形态：字符串字面量 + 正则（动态段）。
  // 只查字符串会漏掉 16 条正则路由（我曾据此误判"动态路由全部缺失"）。
  // 这里做字符级解析：定位 http.route( 后按括号配对取出前两个参数，
  // 正确处理正则体里的转义（\/）与字符类（[^/]+）——正则字面量的结束符
  // 不能用"下一个 /"判断。
  // routes.js + panel-adapters.js 两处都可能注册路由
  // （/api/plugins/:id/permissions 就注册在 panel-adapters.js，只扫 routes.js 会误报缺失）。
  const src = fs.readFileSync(path.join(root, 'src/console/routes.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'src/console/panel-adapters.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'src/console/background-uploads.js'), 'utf8');

  /** 从 pos 起读一个 JS 字面量（字符串或正则），返回 { raw, next }。 */
  function readLiteral(s, pos) {
    if (s[pos] === "'" || s[pos] === '"') {
      const quote = s[pos];
      let i = pos + 1, out = '';
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\') { out += s[i] + s[i + 1]; i += 2; } else { out += s[i]; i += 1; }
      }
      return { raw: out, isRegex: false, next: i + 1 };
    }
    if (s[pos] === '/') {
      let i = pos + 1, out = '', inClass = false;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') { out += s[i] + s[i + 1]; i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        out += ch; i += 1;
      }
      return { raw: out, isRegex: true, next: i + 1 };
    }
    return null;
  }

  /** 抽出 routes.js 里所有 http.route(method, pattern) 的 (method, raw, isRegex)。 */
  function extractRoutes(s) {
    const out = [];
    const marker = 'http.route(';
    let at = s.indexOf(marker);
    while (at !== -1) {
      let i = at + marker.length;
      while (i < s.length && /\s/.test(s[i])) i += 1;
      const methodLit = readLiteral(s, i);
      if (!methodLit) { at = s.indexOf(marker, at + 1); continue; }
      i = methodLit.next;
      while (i < s.length && (s[i] === ',' || /\s/.test(s[i]))) i += 1;
      const patLit = readLiteral(s, i);
      if (patLit) out.push({ method: methodLit.raw.toUpperCase(), raw: patLit.raw, isRegex: patLit.isRegex });
      at = s.indexOf(marker, at + 1);
    }
    return out;
  }

  const routes = [];
  const toSegments = (raw, isRegex) => {
    let body = raw;
    if (isRegex) body = body.replace(/^\^?\\?\//, '').replace(/\$$/, '');
    else body = body.replace(/^\//, '');
    return body
      .split(isRegex ? /\\\// : /\//)
      .filter(Boolean)
      .map((seg) => (/^:[A-Za-z]/.test(seg) || /[()[\]{}|]/.test(seg) ? '*' : seg));
  };
  for (const r of extractRoutes(src)) {
    routes.push({ method: r.isRegex ? '*' : r.method, segments: toSegments(r.raw, r.isRegex) });
  }
  // Delegated routes include computed action paths. Record the real registrar
  // without invoking handlers so every method/path still needs a concrete
  // backend registration; no prefix or wildcard exception is introduced.
  const registrar={route(method,pattern,handler){
    assert.ok(['GET','POST','PUT','DELETE'].includes(method));
    assert.ok(typeof pattern==='string'||pattern instanceof RegExp);if(typeof pattern==='string')assert.ok(pattern.startsWith('/api/'));
    assert.equal(typeof handler,'function');
    routes.push({method,segments:toSegments(pattern instanceof RegExp?pattern.source:pattern,pattern instanceof RegExp)});
  }};
  registerLocalProtocolRoutes(registrar);
  registerAccountRoutes(registrar);
  registerLocalFontRoutes(registrar);
  registerGroupManagementRoutes(registrar,{});

  const missing = [];
  let checked = 0;
  for (const panel of manifest.panels) {
    for (const rule of panel.api ?? []) {
      checked += 1;
      const want = toSegments(rule.path);
      const hit = routes.some((r) => (r.method === rule.method || r.method === '*')
        && r.segments.length === want.length
        // 段匹配规则：路由通配段(*)可吃任何声明段；字面段须相等；
        // 声明的参数段(:xxx)经 rpc-bridge 编译为 [^/]+，可匹配路由的任意段（含枚举正则）。
        && r.segments.every((s, i) => s === '*' || s === want[i] || want[i].startsWith(':')));
      if (!hit) missing.push(`${panel.id}: ${rule.method} ${rule.path}`);
    }
  }
  assert.equal(missing.length, 0, `以下声明在后端找不到对应路由：\n  ${missing.join('\n  ')}`);
  console.log(`✓ ${checked} 条声明全部有后端实现（已含 ${routes.length} 条路由中的正则动态路由）`);
}

console.log('=== C. api 规则必须是 {method,path} 对象（字符串会被 normalize 丢弃）===');
{
  const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
  const SAFE_PATH = /^\/api\/[A-Za-z0-9_/:-]+$/;
  for (const panel of manifest.panels) {
    for (const rule of panel.api ?? []) {
      assert.ok(rule && typeof rule === 'object' && !Array.isArray(rule), `${panel.id}: api 规则必须是对象`);
      assert.ok(METHODS.has(rule.method), `${panel.id}: 方法合法（${rule.method}）`);
      assert.ok(SAFE_PATH.test(rule.path), `${panel.id}: 路径安全（${rule.path}）`);
    }
  }
  console.log('✓ 所有 api 规则格式合法');
}

console.log('=== D. 面板 id 唯一且 entry 存在 ===');
{
  const ids = manifest.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '面板 id 无重复');
  for (const panel of manifest.panels) {
    const html = path.join(root, 'ui/panels', panel.id, 'index.html');
    const js = path.join(root, 'ui/panels', panel.id, 'panel.js');
    assert.ok(fs.existsSync(html), `${panel.id}/index.html 存在`);
    assert.ok(fs.existsSync(js), `${panel.id}/panel.js 存在`);
  }
  console.log(`✓ ${ids.length} 个面板文件齐备`);
}

console.log('\n✓ 67 面板 API 声明完整性：全部通过');
