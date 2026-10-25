// 57 · 表情库归属改造 + 插件增删 + 热更新（2026-06 三件功能的契约测试）
//
// 1. 表情：默认本地库与可选账号收藏能力的边界，
//    sticker_note 已删除；写入失败（如QQ 表情库 1000 上限）视为收藏失败且不落本地索引。
// 2. 插件删除：只允许删用户域、必须先停用、realpath 复核防路径穿越。
// 3. 插件新增：从 ZIP 走市场同一套受限解压，不自造解压逻辑。
// 4. 热更新：hot=true 绕过 ESM 子模块缓存；指纹变化即作废旧授权。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStickerManager } from '../src/kernel/stickers.js';
import { mktmp } from './helpers.mjs';
import { fixtureCapability } from './bundled-fixture-sdk.mjs';
import { createOneBotProvider } from '../bundled/transport-onebot/provider.js';
import transportPlugin from '../bundled/transport-onebot/index.js';
import { createKernel } from '../src/kernel/kernel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

console.log('=== 默认传输不提供额外收藏表情扩展；通用表情能力由插件提供 ===');
const registeredCapabilities = new Map(); let definition;
transportPlugin.setup({ capability: name => name === 'host.config' ? { get: () => ({}) } : { appRoot: root },
  registerTransport(value) { definition = value; }, registerCapability(name, value, options) { registeredCapabilities.set(name, { value, options }); },
  lifecycle: { onStop() {} }, log: {},
});
assert.equal(typeof definition.create, 'function'); assert.equal(definition.default, true);
assert.equal(registeredCapabilities.has('qq.emoji-favorites'), false);
const stickersSrc = read('src/kernel/stickers.js');
assert.ok(stickersSrc.includes('collectIntoQQ'), 'stickers 提供 collectIntoQQ');
assert.ok(stickersSrc.includes('QQ_EMOJI_LIMIT'), '上限有独立错误码');
assert.ok(stickersSrc.includes('QQ_EMOJI_NO_ID'), '拿不到 emoji_id 视为失败（不确认成功）');
// 严格顺序：先写 QQ 拿 id → 再写备注 → 最后落本地索引
// 注意 save(entries) 在文件里多处出现，必须在 collectIntoQQ 函数体内定位
const fnStart = stickersSrc.indexOf('async function collectIntoQQ');
const fnEnd = stickersSrc.indexOf('async function renameInQQ');
assert.ok(fnStart > 0 && fnEnd > fnStart, '定位 collectIntoQQ 函数体');
const fnBody = stickersSrc.slice(fnStart, fnEnd);
const order = ['addCustomFace(file)', 'modifyCustomFace(emojiId, desc)', 'save(entries)'];
let cursor = -1;
for (const step of order) {
  const at = fnBody.indexOf(step);
  assert.ok(at > 0, `collectIntoQQ 内找到步骤：${step}`);
  assert.ok(at > cursor, `步骤顺序正确：${step}`);
  cursor = at;
}
console.log('✓ 严格顺序：写入 QQ → 写备注 → 落本地索引');

console.log('\n=== C. 表情：失败不落本地索引（无幽灵条目）===');
{
  const dataDir = mktmp('qqa-sticker-');
  // 无 capability → 明确失败
  const m1 = createStickerManager({ dataDir });
  await assert.rejects(() => m1.collectIntoQQ({ file: 'http://x/a.png', desc: 'x' }), /未提供 qq.emoji-favorites/, '缺能力时抛错');
  assert.equal(m1.all().length, 0, '缺能力时不写本地索引');

  // 上限错误 → 分类为 QQ_EMOJI_LIMIT 且不写本地
  const m2 = createStickerManager({
    dataDir,
    capability: { providers: (n) => (n === 'qq.emoji-favorites' ? [{ provider: {
      addCustomFace: async () => { throw new Error('表情包数量已达上限 1000'); },
      modifyCustomFace: async () => ({ ok: true }), deleteCustomFace: async () => ({ ok: true }), fetchCustomFaces: async () => [],
    } }] : []) },
  });
  const r = await m2.collectIntoQQ({ file: 'http://x/a.png', desc: 'x' });
  assert.equal(r.ok, false, '上限时视为失败');
  assert.equal(r.code, 'QQ_EMOJI_LIMIT', '上限有独立 code');
  assert.match(r.error, /1000/, '错误话术带上限数');
  assert.equal(m2.all().length, 0, '失败后不落本地索引（无幽灵条目）');
  console.log('✓ 无能力 / 上限 两种失败都不写本地索引');

  // 成功路径：emoji_id 缺失也算失败
  const m3 = createStickerManager({
    dataDir,
    capability: { providers: () => [{ provider: { addCustomFace: async () => ({}), modifyCustomFace: async () => ({ ok: true }), deleteCustomFace: async () => ({ ok: true }), fetchCustomFaces: async () => [] } }] },
  });
  const r3 = await m3.collectIntoQQ({ file: 'http://x/a.png', desc: 'x' });
  assert.equal(r3.ok, false, '拿不到 emoji_id 不算成功');
  assert.equal(r3.code, 'QQ_EMOJI_NO_ID');
  assert.equal(m3.all().length, 0, '未确认成功不落索引');
  console.log('✓ 拿不到 emoji_id 判失败（不确认成功）');

  // 备注失败不能新增或覆盖本地索引，也不能写图片缓存。
  for (const modify of [
    async () => ({ ok: false }),
    async () => { throw new Error('备注请求失败'); },
    async () => undefined,
  ]) {
    const failedDir = mktmp('qqa-sticker-note-');
    const manager = createStickerManager({
      dataDir: failedDir,
      capability: { providers: () => [{ provider: {
        addCustomFace: async () => ({ emojiId: 'EXISTING' }),
        modifyCustomFace: modify,
      } }] },
    });
    manager.collect({ id: 'EXISTING', desc: '原备注', url: 'http://x/old.png', source: 'qq' });
    const indexFile = path.join(failedDir, 'stickers.json');
    const before = fs.readFileSync(indexFile);
    const failed = await manager.collectIntoQQ({
      file: 'http://x/new.png', desc: '新备注', buffer: Buffer.from('fixture'),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'QQ_EMOJI_NOTE_FAILED');
    assert.deepEqual(fs.readFileSync(indexFile), before, '失败不覆盖现有索引');
    assert.deepEqual(fs.readdirSync(path.join(failedDir, 'sticker-images')), [], '失败不写缓存');
  }

  // 成功路径：emoji_id 正常
  const m4 = createStickerManager({
    dataDir,
    capability: { providers: () => [{ provider: {
      addCustomFace: async () => ({ emojiId: 'EMO1' }),
      modifyCustomFace: async () => ({ ok: true }),
      deleteCustomFace: async () => ({ ok: true }),
      fetchCustomFaces: async () => ['http://x/1.png'],
    } }] },
  });
  const r4 = await m4.collectIntoQQ({ file: 'http://x/a.png', desc: '好图偷了' });
  assert.equal(r4.ok, true, '正常收藏成功');
  assert.equal(r4.entry.emojiId, 'EMO1', '本地索引记 emoji_id');
  assert.equal(r4.entry.desc, '好图偷了', '备注进索引');
  assert.equal(m4.all().length, 1);
  assert.equal(r4.noted, true);
  const again = await m4.collectIntoQQ({ file: 'http://x/a.png', desc: '重复收藏' });
  assert.equal(again.ok, true);
  assert.equal(m4.all().length, 1, '相同 emoji_id 不重复建索引');
  const { default: stickerTools } = await import('../bundled/sticker-tools/index.js');
  const registered = new Map();
  stickerTools.setup({
    capability: fixtureCapability({
      stickers: m4,
      store: { findByMid: () => ({ media: [{ kind: 'image', url: 'http://x/a.png' }] }) },
    }),
    registerTool: (tool) => registered.set(tool.id, tool),
  });
  const dto = await registered.get('collect_sticker').execute(
    { messageId: 1, note: '工具备注' }, { chatKey: 'group:fixture' },
  );
  assert.deepEqual(dto, { ok: true, result: { id: 'EMO1', emojiId: 'EMO1', noted: true } });
  // 改备注（写 QQ 侧）
  const rn = await m4.renameInQQ('EMO1', '新备注');
  assert.equal(rn.ok, true);
  assert.equal(m4.get('EMO1').desc, '新备注', '改备注同步本地索引');
  // 删除
  assert.equal((await m4.removeFromQQ('EMO1')).ok, true);
  assert.equal(m4.all().length, 0, '删除后索引清空');
  console.log('✓ 成功路径：收藏/改备注/删除都贯通');
}

console.log('\n=== D. sticker_note 已删除且工具描述里不再提它===');
{
  const tool = read('bundled/sticker-tools/index.js');
  assert.ok(!/id: 'sticker_note'/.test(tool), 'sticker_note 已删除');
  assert.ok(!/id: 'sticker_note'/.test(read('test/25-bundled-tools-test.mjs')), '测试已改为断言其不存在');
  // 账号收藏必须声明可选能力依赖，不暗示默认 OneBot 传输支持。
  assert.match(tool, /requires: \['qq\.emoji-favorites'\]/, '账号收藏声明可选能力依赖');
  assert.match(tool, /满了会失败|上限/, 'collect_sticker 描述提示上限');
  // 工具层透传内核错误码，不硬编码字符串
  assert.match(tool, /code: res\.code/, '工具层透传内核错误码（QQ_EMOJI_LIMIT 等）');
  assert.match(tool, /if \(!res\.ok\)[\s\S]{0,120}return \{ ok: false, error: res\.error, code: res\.code \}/, '内核失败即工具失败');
  console.log('✓ sticker_note 移除干净，collect_sticker 语义已更新');
}

console.log('\n=== E. 插件删除 / 新增 / 热更新 API ===');
{
  const routes = read('src/console/routes.js');
  // 删除：只允许用户域直接子目录、拒绝符号链接、必须先停用、移入隔离区而非 rmSync
  assert.ok(routes.includes('/delete'), '有删除端点');
  assert.ok(routes.includes('只能卸载用户安装的扩展'), '拒绝删捆绑域扩展');
  assert.ok(routes.includes('请先停用该扩展再卸载'), '拒绝删运行中的扩展');
  assert.ok(routes.includes('拒绝卸载符号链接目录'), '拒绝符号链接目录');
  assert.ok(routes.includes('卸载目标必须是用户域的直接子目录'), '限定用户域直接子目录');
  assert.ok(routes.includes('realpathSync'), 'realpath 复核真实路径');
  assert.ok(routes.includes('revokePlugin'), '卸载时撤销宿主授权');
  assert.ok(routes.includes('uninstalled-v1'), '移入隔离区而非直接删除（可恢复）');
  assert.ok(!/rmSync\(real, \{ recursive: true, force: true \}\)/.test(routes), '不用 rmSync 直接抹掉用户插件目录');
  // 新增：staging 解压 → 清单校验 → 指纹 → 目标冲突检测
  assert.ok(routes.includes('/api/skills/install'), '有安装端点');
  assert.ok(routes.includes('extractZipSafely'), '复用市场受限解压，不自造');
  assert.ok(routes.includes("safeManagementDirectory('staging')"), '先解到 staging 暂存区');
  assert.ok(routes.includes('安装包根目录必须有且只有一个'), '校验清单唯一性');
  assert.ok(routes.includes('清单必须声明合法 id'), '校验清单 id 合法性');
  assert.ok(routes.includes('清单 entry 必须是安装目录内的普通文件'), 'entry 防路径穿越');
  assert.ok(routes.includes('pluginFingerprint(stage)'), '安装前算指纹（进入授权体系）');
  assert.ok(routes.includes('不是合法 base64') || routes.includes('不是合法 base64'), 'base64 严格校验');
  assert.ok(routes.includes('con|prn|aux|nul'), '拒绝 Windows 保留设备名做目录');
  assert.ok(routes.includes('目标或身份已存在'), '目标/身份冲突拒绝（不覆盖）');
  assert.ok(routes.includes('用户扩展根目录不安全'), '用户扩展根目录拒绝符号链接');
  // 热更新：指纹变化通过 needsReauthorize 引导重新授权（loader 已绑新身份，不能 unbind）
  assert.ok(routes.includes('/hot-reload'), '有热更新端点');
  assert.ok(routes.includes('hot: true'), '以 hot 模式调 loadDir');
  assert.ok(routes.includes('热更新不能改变扩展 id'), '热更新不得改扩展 id');
  assert.ok(routes.includes('fingerprintChanged'), '报告指纹是否变化');
  assert.ok(routes.includes('needsReauthorize'), '指纹变化要求重新授权');
  // A source comment cannot prove the new instance remains bound. Exercise the
  // actual route, loader and permission identity below instead.
  console.log('✓ 删除/新增/热更新 端点齐备，闸门与安全清理都在');

  const loader = read('src/kernel/plugin-loader.js');
  assert.ok(loader.includes('{ hot = false'), 'loadDir/loadDirectory 接收 hot 参数');
  assert.ok(loader.includes('&& !hot)'), '非热更新仍走保守分支（依赖图变了要求重启）');
  assert.ok(loader.includes('ESM 子模块缓存需要重启'), '保守分支保留「要求重启」提示');
  assert.ok(loader.includes('graphImports'), '用导入预算记账，而不是无限制造新 import 命名空间');
  assert.ok(!/ns=\$\{crypto\.randomUUID\(\)\}/.test(loader), '不用 import namespace 破缓存（避免模块实例泄漏）');
  assert.ok(loader.includes('loadQueue'), '装载串行化（避免同 id 并发 import 顺序不确定）');
  assert.ok(loader.includes('watchBusy'), 'watch 重入保护');
  console.log('✓ loader 保守默认 + 导入预算 + 串行队列，热更新为显式 opt-in');
}

console.log('\n=== E2. 热更新后的真实权限身份 ===');
{
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-hot-identity57-'));
  const id = 'hot-identity57', token = 'synthetic-hot-identity57';
  for (const folder of ['bundled', 'plugins', 'skills']) fs.mkdirSync(path.join(appRoot, folder));
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
  const dir = path.join(appRoot, 'plugins', id); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, kind: 'plugin', apiVersion: 1, enabledByDefault: true, entry: 'index.js', permissions: ['net.outbound'] }));
  fs.writeFileSync(path.join(dir, 'index.js'), "import {value} from './helper.js'; export default {setup(ctx){ctx.registerTool({id:'value',name:'Value',execute:()=>value});}};");
  fs.writeFileSync(path.join(dir, 'helper.js'), "export const value = 'v1';");
  const kernel = createKernel({ appRoot, env: { QQ_AGENT_DATA_DIR: path.join(appRoot, 'data'), QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(appRoot, 'absent') },
    transport: { id: 'offline57', start() {}, stop() {}, status: () => ({ connected: true }), actions: {} },
    fetchImpl: async () => { throw new Error('57 fixture forbids external HTTP'); }, priceUpdates: { refresh: async () => ({ ok: true }) },
  });
  kernel.config.update({ server: { port: 0, token }, telemetry: { enabled: false }, proactive: { enabled: false }, });
  kernel.log.setLevel('error'); kernel.loader.startWatchers = () => {};
  try {
    const port = await kernel.start();
    const reload = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/skills/${id}/hot-reload`, { method: 'POST', headers: { 'x-console-token': token, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200); return response.json();
    };
    const first = kernel.loader.hostEntry(id), oldTool = kernel.registry.get(`${id}__value`);
    assert.equal(await oldTool.execute(), 'v1');
    assert.equal(kernel.permissions.setOverride(id, 'net.outbound', 'allow', { fingerprint: first.fingerprint }), true);
    const oldReceipt = kernel.permissions.check(id, 'net.outbound', { fingerprint: first.fingerprint }); assert.equal(oldReceipt.isValid(), true);
    fs.writeFileSync(path.join(dir, 'helper.js'), "export const value = 'v2';");
    const result = await reload(); assert.equal(result.ok, true); assert.equal(result.fingerprintChanged, true); assert.equal(result.needsReauthorize, true);
    const current = kernel.loader.hostEntry(id); assert.notEqual(current.generation, first.generation); assert.notEqual(current.fingerprint, first.fingerprint);
    assert.equal(kernel.permissions.isCurrent(id, current.fingerprint), true, 'new identity was not unbound by the hot-reload route');
    assert.equal(kernel.permissions.isCurrent(id, first.fingerprint), false); assert.equal(oldReceipt.isValid(), false);
    assert.equal(kernel.permissions.status(id, 'net.outbound').override, null, 'old fingerprint grant is not reused');
    assert.equal(kernel.permissions.setOverride(id, 'net.outbound', 'allow', { fingerprint: current.fingerprint }), true, 'the new instance can actually be authorized');
    assert.equal(kernel.permissions.check(id, 'net.outbound', { fingerprint: current.fingerprint }).isValid(), true);
    assert.equal(await kernel.registry.get(`${id}__value`).execute(), 'v2');
    await assert.rejects(Promise.resolve().then(() => oldTool.execute()), /失效|停止/);
    const unchanged = await reload(); assert.equal(unchanged.ok, true); assert.equal(unchanged.fingerprintChanged, false); assert.equal(unchanged.needsReauthorize, false);
    const reloaded = kernel.loader.hostEntry(id); assert.equal(kernel.permissions.isCurrent(id, reloaded.fingerprint), true);
    assert.equal(kernel.permissions.status(id, 'net.outbound').override, 'allow');
    assert.equal(kernel.permissions.check(id, 'net.outbound', { fingerprint: reloaded.fingerprint }).isValid(), true);
    assert.equal(await kernel.registry.get(`${id}__value`).execute(), 'v2');
    console.log('✓ 真实 HTTP 热更新：旧授权失效、新代可授权、工具运行新子模块，原代码再次加载保留授权');
  } finally {
    await kernel.stop(); assert.equal(kernel.scheduler.count(), 0);
    assert.equal(fs.existsSync(path.join(appRoot, 'data', 'qq-agent.lock')), false);
    assert.equal(path.dirname(path.resolve(appRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
}

console.log('\n=== F. 面板白名单与按钮 ===');
{
  const manifest = JSON.parse(read('ui/panels/manifest.json'));
  for (const id of ['skills', 'plugins']) {
    const p = manifest.panels.find((x) => x.id === id);
    assert.ok(p, `${id} 面板存在`);
    const paths = p.api.map((a) => a.path);
    for (const need of ['/api/skills/install', '/api/skills/:id/delete', '/api/skills/:id/hot-reload']) {
      assert.ok(paths.includes(need), `${id} 面板白名单含${need}`);
    }
  }
  // 管理动作已抽到共享模块 ui/panels/extension-manager.js（两页共用），不再写在各自 panel.js
  const manager = read('ui/panels/extension-manager.js');
  assert.ok(manager.includes("destructiveButton('卸载'"), '扩展管理有渐进确认的卸载动作');
  assert.ok(manager.includes('installZip'), '有 ZIP 安装动作');
  assert.ok(manager.includes("button('重新加载'"), '有热更新动作');
  assert.ok(manager.includes("button('宿主授权'"), '有宿主授权动作');
  assert.match(manager,/clicks:\s*4/,'卸载使用四次点击确认');
  assert.ok(read('ui/panels/destructive-action.js').includes("classList.add('danger'"), '统一删除组件保留危险样式');
  assert.match(manager,/extension\.root\s*!==\s*'bundled'/,'只有用户域扩展才给卸载/授权按钮');
  for (const id of ['skills', 'plugins']) {
    assert.ok(read(`ui/panels/${id}/index.html`).includes('id="install"'), `${id}/index.html 有安装按钮`);
    assert.ok(read(`ui/panels/${id}/panel.js`).includes("from'../extension-manager.js'"), `${id} 面板接入共享管理模块`);
  }
  console.log('✓ 白名单 + 共享管理动作（启停/设置/热更新/授权/卸载/安装）全部到位');
}

console.log('\n✓ 57 表情库/插件增删/热更新：全部通过');
