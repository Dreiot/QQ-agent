// 55：技能页冲突提示的端到端契约（前端消费 /api/tools/conflicts）。
// 关键回归点：rpc-bridge.js 的 allowed() 只放行 manifest.api 里声明过的路径，
// 面板里 request() 一个未声明路径会拿到 FORBIDDEN —— 所以 manifest 必须同步声明，
// 且面板 JS 必须真的去调它。这两条任一漏掉，冲突提示就静默失效。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, summary } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ui/panels/manifest.json'), 'utf8'));
const routes = fs.readFileSync(path.join(root, 'src/console/routes.js'), 'utf8');
const panelJs = fs.readFileSync(path.join(root, 'ui/panels/skills/panel.js'), 'utf8');
const shellHtml = fs.readFileSync(path.join(root, 'ui/panels/skills/index.html'), 'utf8');
const sessionsPanel = fs.readFileSync(path.join(root, 'ui/panels/sessions/panel.js'), 'utf8');
const commonCss = fs.readFileSync(path.join(root, 'ui/panels/common.css'), 'utf8');

section('M5 工具冲突提示链路');

// Sessions GET 必须显式传 undefined body，避免 RPC 将 query 当 body，首屏加载不能抛异常。
ok(/request\(\s*['"]GET['"]\s*,\s*['"]\/api\/sessions['"]\s*,\s*undefined\s*,\s*\{\s*limit\s*:\s*[1-9]\d*\s*(?:,|\})/.test(sessionsPanel), 'sessions 首屏 GET 使用 undefined body + 含正整数 limit 的 query');

// 1. 宿主确实注册了端点
ok(routes.includes("'/api/tools/conflicts'"), 'routes.js 注册 GET /api/tools/conflicts');
ok(routes.includes('registry?.collisionsInfo?.() ?? []'), '端点读取 registry.collisionsInfo()');

// 2. manifest 白名单已声明（否则 rpc-bridge allowed() 会 FORBIDDEN）
const skills = manifest.panels.find((p) => p.id === 'skills');
ok(skills, 'manifest 有 skills 面板');
ok(skills.api.some((r) => r.method === 'GET' && r.path === '/api/tools/conflicts'),
  'skills 面板 manifest 已声明 GET /api/tools/conflicts');

// 3. 面板 JS 真的去调这个端点
ok(panelJs.includes("request('GET','/api/tools/conflicts')"), 'panel.js 调用 /api/tools/conflicts');

// 4. 有承载冲突提示的 DOM 容器与样式
ok(shellHtml.includes('id="conflicts"'), 'skills/index.html 有 #conflicts 容器');
ok(commonCss.includes('.conflict-note'), 'common.css 有 .conflict-note 样式');
ok(panelJs.includes("className='conflict-note'"), 'panel.js 用 conflict-note 类渲染');

// 5. 空冲突时必须清空容器，不能残留上一次的上帝提示
ok(/function renderConflicts\(\)\{clear\(conflictBox\)/.test(panelJs), 'renderConflicts 开头即清空容器');
ok(panelJs.includes('if(!conflicts.length)return;'), '无冲突时不渲染提示块');

// 6. 面板失败不应炸掉整个技能页（诊断端点挂了也要能正常列技能）
ok(panelJs.includes('async function loadConflicts(){try{'), 'loadConflicts 用 try 包裹');
ok(/catch\{\s*conflicts=\[\];\s*\}/.test(panelJs), '加载失败降级为空冲突而不是抛错');

// 7. 所有面板的 api 声明仍满足安全形状（不能因为本次改动破坏既有约束）
const SAFE = /^\/api(?:\/[A-Za-z0-9._~-]+|\/:id|\/:key|\/:uid)*$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
for (const p of manifest.panels) {
  for (const rule of p.api) {
    ok(METHODS.has(rule.method), `${p.id} 方法合法：${rule.method}`);
    ok(SAFE.test(rule.path), `${p.id} 路径安全：${rule.path}`);
  }
}

eq(new Set(manifest.panels.map((x) => x.id)).size, manifest.panels.length, '面板 id 无重复（新增面板后仍自洽）');

summary('55-panel-conflict-notice');
