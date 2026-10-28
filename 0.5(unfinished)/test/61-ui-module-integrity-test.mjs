// 61 · 前端模块完整性：import 必须能解析、面板引用的 DOM id 必须存在。
// 背景：曾出现 ui/panels/{skills,plugins}/panel.js import 了不存在的 ui/extension-manager.js，
// 导致两个管理页在浏览器里直接白屏，而 M3 契约测试全绿（它们只查字符串）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(root, 'ui');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('=== A. 所有前端 import 可解析 ===');
{
  const missing = [];
  for (const file of walk(uiRoot)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      let target;
      if (spec.startsWith('/panels/')) target = path.join(uiRoot, 'panels', spec.slice('/panels/'.length));
      else if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
      else continue;
      if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} -> ${spec}`);
    }
  }
  assert.equal(missing.length, 0, `存在无法解析的 import：${missing.join('; ')}`);
  console.log('✓ 所有相对/绝对 import 均可解析');
}

console.log('=== B. 共享扩展管理模块存在且导出完整 ===');
{
  const file = path.join(uiRoot, 'panels', 'extension-manager.js');
  assert.ok(fs.existsSync(file), 'ui/panels/extension-manager.js 存在（技能页与插件页共用）');
  const src = fs.readFileSync(file, 'utf8');
  for (const name of ['renderExtensions', 'installZip', 'pickZip', 'settingsDialog']) {
    assert.ok(src.includes(`export function ${name}`) || src.includes(`export async function ${name}`), `导出 ${name}`);
  }
  // 管理动作齐全：启停 / 设置 / 热更新 / 宿主授权 / 卸载 / 安装
  for (const [action, endpoint] of [
    ['启停', 'enabled:!current.enabled'],
    ['热更新', '/hot-reload'],
    ['卸载', '/delete'],
    ['安装', '/api/skills/install'],
  ]) {
    assert.ok(src.includes(endpoint), `${action}动作调用 ${endpoint}`);
  }
  assert.ok(src.includes("destructiveButton('卸载'"), '有渐进确认的卸载动作');
  assert.match(src,/clicks:\s*4/, '卸载使用四次点击确认');
  assert.ok(fs.readFileSync(path.join(uiRoot,'panels/destructive-action.js'),'utf8').includes("classList.add('danger'"), '统一删除组件提供危险样式');
  assert.match(src,/extension\.root\s*!==\s*'bundled'/, '只有用户域扩展才给卸载/授权按钮');
  assert.ok(src.includes('managePermissions'), '宿主授权走真实授权面板');
  assert.ok(src.includes('configSchema'), '按 configSchema 渲染设置对话框');
  assert.ok(src.includes('secretKey'), '密钥字段遮蔽（不回传明文）');
  // 不得存在同名的第二份实现（回退曾造成重复模块）
  assert.ok(!fs.existsSync(path.join(uiRoot, 'extension-manager.js')), '不存在重复的 ui/extension-manager.js');
  console.log('✓ 扩展管理模块动作齐全（启停/设置/热更新/授权/卸载/安装）且无重复实现');
}

console.log('=== C. 技能页与插件页接上共享模块 ===');
{
  for (const id of ['skills', 'plugins']) {
    const src = fs.readFileSync(path.join(uiRoot, 'panels', id, 'panel.js'), 'utf8');
    assert.ok(src.includes("from'../extension-manager.js'"), `${id} 面板 import 共享模块`);
    assert.ok(src.includes("from'../panel-client.js'"), `${id} 面板沿同一账号路径加载面板 RPC，避免重复模块`);
  }
  console.log('✓ 两页共用渲染且都走面板 RPC');
}

console.log('=== D. 面板 HTML 提供脚本引用的 DOM id ===');
{
  for (const id of ['skills', 'plugins']) {
    const dir = path.join(uiRoot, 'panels', id);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(dir, 'panel.js'), 'utf8');
    for (const m of js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) {
      assert.ok(html.includes(`id="${m[1]}"`), `${id}/index.html 提供 #${m[1]}`);
    }
  }
  console.log('✓ 脚本引用的 DOM id 均存在');
}

console.log('=== E. 关键后端端点被前端引用时确实存在 ===');
{
  const routes = fs.readFileSync(path.join(root, 'src', 'console', 'routes.js'), 'utf8');
  const panelRoutes = fs.readFileSync(path.join(root, 'src', 'console', 'panel-adapters.js'), 'utf8');
  const endpoints = ['/api/skills', '/api/skills/reload', '/api/skills/install', '/api/tools/conflicts'];
  for (const ep of endpoints) {
    assert.ok(routes.includes(ep), `routes.js 提供 ${ep}`);
  }
  assert.ok(panelRoutes.includes('/permissions'), '面板路由提供插件授权端点');
  for (const frag of ['/delete', '/hot-reload']) {
    assert.ok(routes.includes(frag), `routes.js 提供 ${frag} 动作`);
  }
  console.log('✓ 前端依赖的端点全部在后端存在');
}

console.log('\n✓ 61 前端模块完整性：全部通过');
