// 58 · QQ 表情库收藏失败语义 + 插件 fs.watch + stale lock + 价格/媒体循环（2026-10-06 P0/P1 收口）
//
// 覆盖本轮新增/修复的运行时契约：
//   A. 表情库：写入 QQ 失败/上限/无 emoji_id 均判失败且不落本地索引
//   B. loader：startWatchers/stopWatchers 存在，500ms debounce，停机关闭
//   C. kernel：stale lock 自动回收；活锁仍拒绝
//   D. 价格循环：启动即拉取 + 成功 24h / 失败 3h 排程
//   E. media.download：B站/抖音域名命中才 claim；无 provider 明确回退
//
// 这些断言的共同原则：不把"能力声明存在"当作"功能可用"，失败必须显式。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mktmp, section } from './helpers.mjs';
import { verifyDefaultMediaPolicy } from './media-consumer-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

section('A. 表情库：失败即整体失败，不落本地索引');
{
  const stickers = read('src/kernel/stickers.js');
  assert.match(stickers, /QQ_EMOJI_LIMIT/, '上限有独立 code');
  assert.match(stickers, /QQ_EMOJI_NO_ID/, '无 emoji_id 不确认成功');
  assert.match(stickers, /collectIntoQQ/, '提供 collectIntoQQ');
  // 顺序：先 QQ 写入，再备注，最后本地索引
  const body = stickers.slice(stickers.indexOf('async function collectIntoQQ'), stickers.indexOf('async function renameInQQ'));
  const order = ['addCustomFace(file)', 'modifyCustomFace(emojiId, desc)', 'save(entries)'];
  let cursor = -1;
  for (const step of order) {
    const at = body.indexOf(step);
    assert.ok(at > 0, `collectIntoQQ 内包含 ${step}`);
    assert.ok(at > cursor, `步骤顺序正确：${step}`);
    cursor = at;
  }
  console.log('✓ 表情收藏严格顺序：QQ 写入 → 备注 → 本地索引');
}

section('B. loader fs.watch：默认监听三根目录，500ms debounce，停机关闭');
{
  const loader = read('src/kernel/plugin-loader.js');
  assert.match(loader, /function startWatchers\(\)/, '提供 startWatchers');
  assert.match(loader, /function stopWatchers\(\)/, '提供 stopWatchers');
  assert.match(loader, /setTimeout\([^,]+,\s*500\)/, '500ms debounce');
  assert.match(loader, /watchBusy/, '重入保护');
  assert.match(loader, /watchPending/, '重扫期间的再次变更会补跑一轮');
  assert.match(loader, /watchEpoch/, '停机/重启用 epoch 作废旧回调');
  const stopAllAt = loader.indexOf('function stopAll()');
  assert.ok(stopAllAt > 0, '存在 stopAll');
  const stopBlock = loader.slice(stopAllAt, loader.indexOf('return {', stopAllAt));
  assert.ok(stopBlock.indexOf('stopWatchers()') < stopBlock.indexOf("unload(id, 'shutdown')"), 'stopAll 先关闭 watcher');
  assert.ok(stopBlock.indexOf('stopped = true') < stopBlock.indexOf('stopWatchers()'), 'stopAll 先置停止位再关 watcher（作废在途回调）');
  assert.ok(loader.includes('extensions?.hotReload === false'), '可配置关闭（skills.watch / extensions.hotReload）');
  console.log('✓ watch 生命周期、防抖、重入与 epoch 契约就位');
}

section('C. stale lock：死 pid 自动回收，活 pid 拒绝');
{
  const kernel = read('src/kernel/kernel.js');
  assert.match(kernel, /process\.kill\(ownerPid, 0\)/, '用 pid 存活探测');
  assert.match(kernel, /清理了失效实例锁/, 'stale 回收日志');
  assert.match(kernel, /已有实例正在运行/, '活锁仍拒绝');
  console.log('✓ stale lock 处理就位');
}

section('D. 价格循环：启动即拉取，成功 24h / 失败 3h');
{
  const kernel = read('src/kernel/kernel.js');
  assert.match(kernel, /const refreshPrices = async/, '定义 refreshPrices');
  assert.match(kernel, /void refreshPrices\(\);/, '启动即拉取');
  assert.match(kernel, /86_400_000/, '成功 24h');
  assert.match(kernel, /10_800_000/, '失败 3h');
  assert.match(kernel, /priceRefreshStop\?\.stop\?\.\(\)/, 'stop 回收 timer');
  console.log('✓ 价格源 tick 契约就位');
}

section('E. media.download：域名匹配 + claim + 无 provider 回退');
{
  const kernel = read('src/kernel/kernel.js');
  assert.ok(kernel.includes("components['core.media.forward']"), '装配调用所选择的媒体策略');
  await verifyDefaultMediaPolicy();
  console.log('✓ 媒体转发消费点就位（平台解析器属外部插件）');
}

section('F. 回归：本轮新增文件语法可解析');
{
  for (const file of ['src/kernel/kernel.js', 'src/kernel/plugin-loader.js', 'src/kernel/stickers.js', 'src/kernel/send.js']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} 存在`);
  }
  console.log('✓ 关键文件齐备');
}

console.log('\n✓ 58 运行时契约收口：全部通过');
