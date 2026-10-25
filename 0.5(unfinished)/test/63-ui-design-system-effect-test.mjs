// 63 · 设计系统实效验证：追加组件时"不写新 CSS"也能自动获得一致外观。
//
// 62 号是静态契约（查 CSS 文本），本测试是真实浏览器实测：
// 在真实运行的 skills 面板上注入一批全新元素（按钮/搜索框/卡片/徽标/空状态），
// 全部不写任何内联样式或新样式表，然后断言它们的计算样式已符合设计系统。
//
// 这正是用户诉求"UI 是活的，追加按钮/页签时不好看"的直接验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createKernel } from '../src/kernel/kernel.js';
import { isolateConsoleFixture } from './console-fixture-isolation.mjs';

const playwright = createRequire(import.meta.url)('playwright-core');
const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright');
const versions = fs.existsSync(cache) ? fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a,b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? versions.map(version => path.join(cache, version, 'chrome-win64/chrome.exe')).find(file => fs.existsSync(file));

console.log('=== A. 启动本地 headless 控制台 ===');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-u63-'));
const isolation = isolateConsoleFixture(dataDir, '63');
const kernel = createKernel({
  appRoot: isolation.appRoot, env: isolation.env, headless: true,
  transport: { id: 'design63', bind() {}, start() {}, stop() {}, status: () => ({ connected: false }), actions: {}, processes: {} },
  priceUpdates: { refresh: async () => ({ok:true}), updateCheck: async () => ({ok:true,current:'0.5.0',latest:'0.5.0',hasUpdate:false}) },
  communityMarket: { syncGlobalBlocklist: async () => ({ok:true,ids:[]}) },
});
kernel.loader.startWatchers = () => {};
kernel.config.update({server:{port:0,token:'design63-synthetic'},telemetry:{enabled:false},proactive:{enabled:false},});
let browser;
try {
  const port = await kernel.start();
  const base = isolation.allowOrigin(`http://127.0.0.1:${port}`);
  isolation.assertEmpty(kernel);
  assert.ok((await fetch(`${base}/panels/common.css`)).ok, '控制台启动成功且面板资源可访问');
  console.log('✓ 控制台已启动，设计系统可加载');
  browser = await playwright.chromium.launch({executablePath,headless:process.env.QQ_AGENT_HEADED !== '1'});
  const page = await browser.newPage({viewport:{width:1600,height:900},colorScheme:'dark',reducedMotion:'reduce'});
  await isolation.bindPage(page, base);
  console.log('=== B. 追加组件：注入不写任何样式的新元素 ===');
  await page.goto(`${base}/panels/skills/index.html`);
  await page.locator('.head > .actions').waitFor({state:'visible'});

  const m = JSON.parse(await page.evaluate(`(async () => {
      const {createIcon} = await import('/panels/icons.js');
      const head = document.querySelector('.head > .actions');
      const mk = (text, cls) => { const b = document.createElement('button'); b.type='button'; b.textContent = text; if (cls) b.className = cls; head.insertBefore(b, head.firstChild); return b; };
      // 三个不同语义的追加按钮
      const primary = mk('追加主操作', 'primary');
      const danger  = mk('追加破坏操作', 'danger');
      const ghost   = mk('追加次要', 'ghost');
      const disabled = mk('追加禁用', ''); disabled.disabled = true;
      let clicks = 0; primary.addEventListener('click', () => clicks++);
      primary.click(); disabled.addEventListener('click', () => clicks++); disabled.click();
      // 追加一个搜索框
      const search = document.createElement('input'); search.type='search'; search.placeholder='追加筛选'; head.append(search);
      // 追加卡片 + 徽标 + 空状态（只用设计系统已有类）
      const card = document.createElement('article'); card.className='card'; card.dataset.u63 = 'card';
      const badge = document.createElement('span'); badge.className='badge is-good'; badge.textContent='已就绪';
      const inner = document.createElement('button'); inner.textContent='卡片内按钮'; inner.dataset.u63 = 'inner';
      card.append(document.createElement('h3'), badge, inner);
      document.querySelector('main').append(card);
      const empty = document.createElement('div'); empty.className='empty'; empty.textContent='追加空状态';
      document.querySelector('main').append(empty);
      const icon = createIcon('plugins'); inner.append(icon);
      const hostile = createIcon('<img src=x onerror=alert(1)>'); card.append(hostile);
      const closed = document.createElement('dialog'); closed.textContent='应隐藏'; document.body.append(closed);

      const box = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const cs = el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.paddingTop, font:s.fontFamily }; };
      const btns = [primary, danger, ghost, inner].map(b => ({ label: b.textContent, ...box(b), ...cs(b) }));
      return JSON.stringify({
        toolbar: box(head), toolbarHeight: Math.round(head.getBoundingClientRect().height),
        buttons: btns,
        sameRow: new Set(btns.slice(0, 3).map(b => b.y)).size === 1,
        search: box(search),
        searchSameRow: Math.abs(box(search).y - box(primary).y) < 4,
        card: cs(card), badge: cs(badge), empty: cs(empty),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        fontFamily: getComputedStyle(document.body).fontFamily,
        pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
        clicks, disabled: disabled.disabled,
        iconColor: getComputedStyle(icon).color, innerColor: getComputedStyle(inner).color,
        iconStroke:getComputedStyle(icon).stroke,iconFill:getComputedStyle(icon.querySelector('[fill="currentColor"]')).fill,
        hostileSafe: hostile.tagName.toLowerCase()==='svg' && !hostile.querySelector('script,img,foreignObject,[onload],[onerror]'),
        closedHidden: getComputedStyle(closed).display==='none',
      });
    })()`));

  console.log('=== C. 追加的控件可操作、可换行且语义可辨 ===');
  assert.ok(m.toolbarHeight > 0, '操作区有可见布局');
  assert.equal(m.pageOverflow, 0, '追加控件不造成页面横向溢出');
  const byLabel = Object.fromEntries(m.buttons.map((b) => [b.label, b]));
  const [p, d, g] = ['追加主操作', '追加破坏操作', '追加次要'].map((l) => byLabel[l]);
  assert.notEqual(p.bg, d.bg, 'primary 与 danger 底色不同（语义可辨）');
  assert.equal(g.bg, 'rgba(0, 0, 0, 0)', 'ghost 按钮透明底');
  for (const b of [p, d, g, byLabel['卡片内按钮']]) {
    assert.ok(b.w > 0 && b.h >= 24, `${b.label} 可见且保留点击区域`);
    assert.ok(Number.parseFloat(b.pad) > 0, `${b.label} 获得通用控件内边距`);
  }
  assert.equal(m.clicks, 1, '普通按钮可交互，禁用按钮不会触发操作');
  assert.equal(m.iconColor, m.innerColor, '图标继承所在控件的主题色');
  assert.equal(m.iconStroke,m.innerColor,'图标的实际描边继承控件颜色');
  assert.equal(m.iconFill,m.innerColor,'图标的实际实心部分继承控件颜色');
  assert.ok(m.hostileSafe, '未知图标元数据不会转成可执行HTML');
  assert.ok(m.closedHidden, '未打开的dialog不进入文档布局');
  console.log('✓ 追加控件获得统一外观、可操作性、语义色与安全图标');
  // Exercise user-controlled shape/color through the actual theme engine.
  const a = JSON.parse(await page.evaluate(`(async () => {
      const {writeTheme, getCurrentTheme} = await import('/panels/theme.js');
      const root = document.documentElement;
      const b = document.querySelector('[data-u63="inner"]');
      const c = document.querySelector('[data-u63="card"]');
      const icon = b.querySelector('.qq-icon');
      const previous = getCurrentTheme();
      const applied=writeTheme({...previous, radius:12, text:'#f1d6fb', surface:'#3b3240', accent:'#cf93e8', gradient:false}, {persist:false});
      const deadline=Date.now()+2000;
      while(Date.now()<deadline) {
        const radius=getComputedStyle(c).borderTopLeftRadius;
        if(radius===getComputedStyle(root).getPropertyValue('--r-md').trim() && radius===applied.radius+'px') break;
        await new Promise(resolve=>setTimeout(resolve,16));
      }
      const out = {
        button: getComputedStyle(b).borderTopLeftRadius,
        card: getComputedStyle(c).borderTopLeftRadius,
        smallToken:getComputedStyle(root).getPropertyValue('--r-sm').trim(),
        mediumToken:getComputedStyle(root).getPropertyValue('--r-md').trim(),
        pad: getComputedStyle(b).paddingTop,
        cardPaint:getComputedStyle(c).backgroundColor,
        text:getComputedStyle(b).color, icon:getComputedStyle(icon).color,
        diagnostics:{rootStyle:root.getAttribute('style'),bodyStyle:document.body.getAttribute('style'),cardStyle:c.getAttribute('style'),
          rootRadius:getComputedStyle(root).getPropertyValue('--r-md').trim(),bodyRadius:getComputedStyle(document.body).getPropertyValue('--r-md').trim(),cardRadius:getComputedStyle(c).getPropertyValue('--r-md').trim(),
          rootText:getComputedStyle(root).getPropertyValue('--text').trim(),bodyText:getComputedStyle(document.body).getPropertyValue('--text').trim(),cardText:getComputedStyle(c).getPropertyValue('--text').trim()},
      };
      writeTheme(previous, {persist:false});
      return JSON.stringify(out);
    })()`));
  console.log('  Theme application measurement:',a);
  assert.equal(a.button, a.smallToken, '追加普通按钮跟随当前形状令牌');
  assert.equal(a.card, a.mediumToken, '追加卡片跟随当前形状令牌');
  assert.notEqual(a.button, byLabel['卡片内按钮'].radius, '用户调整形状确实改变控件');
  assert.equal(a.pad, byLabel['卡片内按钮'].pad, '圆角调整不改变控件内边距');
  assert.notEqual(a.cardPaint, m.card.bg, '实际主题改变卡片绘制');
  assert.notEqual(a.text, byLabel['卡片内按钮'].color, '实际主题改变控件文字');
  assert.equal(a.icon, a.text, '改色后图标继续同步继承');
  console.log('✓ 用户形状/颜色设置由真实主题链传给追加控件与图标');

  console.log('=== D. 追加的卡片/徽标/空状态同样自动合规 ===');
  assert.ok(Number.parseFloat(m.empty.pad) > 0, '空状态获得共享留白');
  assert.ok(m.card.bg !== 'rgba(0, 0, 0, 0)', '卡片提供可见工作表面');
  assert.ok(m.badge.color !== m.card.color, '徽标文字与卡片正文有区分');
  console.log('✓ 卡片/徽标/空状态零样式即符合设计语言');

  console.log('=== E. 页面基础风格与 shell 同源 ===');
  // 面板 body 背景必须**透明**：背景图由 shell 统一绘制（body[data-bg-owner="shell"]
  // 会关掉面板自己的背景层），iframe 若有不透明底色就会整块盖住 shell 的背景图。
  // 之前这里断言"底色为深色"，正是那个 bug 的帮凶——它把不透明当成了正确。
  assert.equal(m.bodyBg, 'rgba(0, 0, 0, 0)', `面板 body 背景透明（实际 ${m.bodyBg}）`);
  assert.ok(m.fontFamily.length > 0, '字体栈已设定');
  for(const b of m.buttons) assert.equal(b.font,m.fontFamily,`${b.label} 继承共享界面字体`);
  console.log('✓ 面板底色透明（背景图由 shell 绘制），字体栈统一');
  await page.setViewportSize({width:640,height:900});
  const narrow = JSON.parse(await page.evaluate(`JSON.stringify({overflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth,clipped:[...document.querySelectorAll('.head button,.head input')].filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<0);}).map(node=>node.textContent||node.placeholder)})`));
  assert.equal(narrow.overflow, 0, '窄窗口追加控件不造成水平溢出');
  assert.deepEqual(narrow.clipped, [], '窄窗口追加操作/筛选全部保留可见宽度');
} finally {
  await browser?.close();
  await kernel.stop();
  try { isolation.restore(); }
  finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

console.log('\n✓ 63 设计系统实效验证：全部通过');
