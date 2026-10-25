// 62 · UI 设计系统契约：新增面板/组件时"不写新 CSS 也能统一外观"。
//
// 背景：8 个面板里曾有 7 个 style.css 为空或用 `body{font:...;padding:16px}` 覆盖设计系统，
// 另有一套独立的 shell 视觉语言（黄绿 accent + 方角 + 另一套变量），导致"追加组件就不好看"。
// 本测试把设计令牌、组件类覆盖度、禁用写死样式三条规则锁住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const uiRoot = path.join(root, 'ui');
const panelsDir = path.join(uiRoot, 'panels');
// Follow project-owned imports: tokens and primitives have one shared entry.
function cssTree(rel, seen = new Set()) {
  const file = path.resolve(root, rel);
  assert.ok(file.startsWith(`${uiRoot}${path.sep}`), '设计样式引用留在项目 UI 内');
  if (seen.has(file)) return '';
  seen.add(file);
  const css = fs.readFileSync(file, 'utf8');
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;/g)];
  return imports.map(([, target]) => {
    assert.ok(!/^(?:https?:|data:|\/\/)/.test(target), '共享样式不依赖外部导入');
    return cssTree(path.relative(root, path.resolve(path.dirname(file), target)), seen);
  }).join('\n') + '\n' + css;
}

console.log('=== A. 设计令牌：面板与 shell 共用同一套语义变量 ===');
{
  const common = cssTree('ui/panels/common.css');
  const shell = cssTree('ui/shell/style.css');
  const required = ['--bg', '--surface', '--surface-2', '--line', '--line-strong', '--text', '--muted', '--faint',
    '--accent', '--good', '--warn', '--bad', '--focus', '--sp-1', '--sp-4', '--r-sm', '--r-md', '--r-lg',
    '--font-sans', '--font-mono', '--motion-fast', '--motion-base', '--motion-slow', '--ease-out'];
  for (const token of required) {
    assert.ok(common.includes(`${token}:`), `common.css 定义 ${token}`);
    assert.ok(shell.includes(`${token}:`), `shell/style.css 定义 ${token}`);
  }
  assert.match(read('ui/panels/common.css'), /@import\s+url\(['"]\.\/design-system\.css['"]\)/, '面板使用共享设计入口');
  assert.match(read('ui/shell/style.css'), /@import\s+url\(['"]\.\.\/panels\/design-system\.css['"]\)/, 'shell 使用同一设计入口');
  // Require a usable ascending scale without fixing the current art direction's pixels.
  const spacings = [...common.matchAll(/--sp-(\d):\s*(\d+)px/g)].map((m) => Number(m[2]));
  assert.ok(spacings.length >= 6, '至少 6 级间距');
  assert.ok(spacings.every((px, index) => px > 0 && (!index || px > spacings[index - 1])), '间距刻度为正且递增');
  console.log('✓ 面板与 shell 共用同一套语义令牌与间距刻度');
}

console.log('=== B. 组件类：设计系统必须覆盖所有面板在用的 class ===');
{
  const common = cssTree('ui/panels/common.css');
  // 面板 JS 实际使用 / 未来追加组件最可能用到的通用类
  const shared = ['.card', '.list-item', '.metric', '.row', '.actions', '.grid', '.list', '.error', '.empty', '.pre',
    '.head', '.toolbar', '.muted', '.badge', '.tabs', '.tab', 'dialog', 'button', 'input', 'select', 'textarea',
    'table', '.message', '.is-good', '.is-warn', '.is-bad', '.notice', '.qq-icon'];
  for (const cls of shared) {
    assert.ok(common.includes(cls), `common.css 提供 ${cls} 组件类`);
  }
  // 四种按钮语义齐备（追加按钮时直接选类）
  for (const variant of ['button.primary', 'button.danger', 'button.ghost']) {
    assert.ok(common.includes(variant), `提供 ${variant} 语义`);
  }
  // 焦点可见性是可达性底线
  assert.ok(common.includes(':focus-visible'), '统一 focus-visible 焦点环');
  // 动效偏好降级
  assert.ok(common.includes('prefers-reduced-motion'), '尊重 prefers-reduced-motion');
  assert.ok(common.includes('dialog:not([open])'), '关闭的原生弹窗仍隐藏');
  console.log(`✓ ${shared.length} 个通用组件类 + 按钮语义齐备，含可达性与动效降级`);
}

console.log('=== C. 禁止写死：面板样式不得覆盖 body/通用控件/自带色值 ===');
{
  const files = fs.readdirSync(panelsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => path.join(panelsDir, d.name, 'style.css'))
    .filter((p) => fs.existsSync(p));
  assert.ok(files.length >= 8, '8 个面板都有 style.css');
  for (const file of files) {
    const css = fs.readFileSync(file, 'utf8');
    const name = path.basename(path.dirname(file));
    assert.ok(!/(^|[;{\s])body\s*\{/.test(css), `${name}: 不得覆盖 body 样式（字体/背景/间距由设计系统决定）`);
    assert.ok(!/^\s*(button|input|select|textarea)\s*\{/m.test(css), `${name}: 不得重定义通用控件外观`);
    // 自定义属性定义（--x:）也统一由 common.css 提供
    assert.ok(!/^\s*--[a-z-]+\s*:/m.test(css), `${name}: 不得定义新的 CSS 变量（应复用设计令牌）`);
    // 颜色一律走变量；hex 只允许出现在 color-mix 的降级注释里
    const hardCoded = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.equal(hardCoded.length, 0, `${name}: 存在写死色值 ${hardCoded.join(', ')}（应使用 var(--*)）`);
  }
  console.log(`✓ ${files.length} 个面板样式均为纯增量：无 body 覆盖、无控件重定义、无自造变量、无写死色值`);
}

console.log('=== D. 面板 HTML 统一引用设计系统 ===');
{
  const manifest = JSON.parse(read('ui/panels/manifest.json'));
  assert.ok(manifest.panels.length >= 8, '至少 8 个面板');
  for (const panel of manifest.panels) {
    const htmlPath = path.join(panelsDir, panel.id, 'index.html');
    assert.ok(fs.existsSync(htmlPath), `${panel.id}/index.html 存在`);
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('../common.css'), `${panel.id} 引入 common.css（设计系统）`);
    assert.ok(/<meta name="viewport"/.test(html), `${panel.id} 有 viewport（追加内容在窄屏可用）`);
    assert.ok(/<meta charset="utf-8">|charset="UTF-8"/.test(html), `${panel.id} 声明字符集`);
  }
  console.log('✓ 所有面板都引入设计系统并具备基础 meta');
}

console.log('=== E. shell 视觉语言与面板一致 ===');
{
  const shell = cssTree('ui/shell/style.css');
  for (const legacy of ['--canvas-only', '--rail-x']) assert.ok(!shell.includes(legacy), `不再保留孤立变量 ${legacy}`);
  // 追加入口/页签的类必须存在
  for (const cls of ['#nav button', '.runtime-controls', '.toast', '.permission-card', 'dialog', '.dialog-actions']) {
    assert.ok(shell.includes(cls), `shell 提供 ${cls}`);
  }
  assert.ok(shell.includes('.toast.error'), '错误 toast 有语义样式；默认 info 使用通用 toast');
  const theme = read('ui/panels/theme.js');
  assert.ok(theme.includes('LIGHT_BASE') && theme.includes("s.setProperty('color-scheme', light ? 'light' : 'dark')"), '显式主题同步原生控件明暗');
  assert.ok(!/@media\s*\(prefers-color-scheme:\s*light\)/.test(shell), 'shell 不再跟随系统自动切浅色（避免未校准配色）');
  assert.ok(!/@media\s*\(prefers-color-scheme:\s*light\)/.test(read('ui/panels/common.css')), '面板不跟随系统自动切浅色');
  const icons = read('ui/panels/icons.js');
  // Attribute assignment can be data-driven; the rendered stroke and solid
  // fill are verified against the actual control colour in test 63.
  assert.ok(icons.includes('http://www.w3.org/2000/svg') && icons.includes('currentColor'), 'SVG 图标使用命名空间与主题色；实际描边和填色由浏览器检查');
  const emptyRule = /\.empty::before\s*\{([^}]*)\}/.exec(shell)?.[1] || '';
  assert.match(emptyRule, /background:\s*currentColor/, '空态遮罩填色继承主题色');
  const maskSource = /(?:^|[;\s])mask:\s*url\(['"]([^'"]+\.svg)['"]\)/.exec(emptyRule)?.[1];
  assert.ok(maskSource && !/^(?:https?:|data:|\/\/)/.test(maskSource), '空态使用本地 SVG 遮罩');
  const emptyAsset = path.resolve(panelsDir, maskSource);
  assert.ok(emptyAsset.startsWith(panelsDir + path.sep) && fs.existsSync(emptyAsset), '空态 SVG 资源位于项目面板目录且实际存在');
  assert.match(fs.readFileSync(emptyAsset, 'utf8'), /<svg\b/, '空态资源是 SVG');
  console.log('✓ shell 与面板共享入口、toast/导航/对话框齐备、主题与图标同步换色');
}

console.log('\n✓ 62 UI 设计系统契约：全部通过');
