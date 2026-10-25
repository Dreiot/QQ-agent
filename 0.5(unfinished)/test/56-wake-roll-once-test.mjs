// 56 · 唤醒档位「只骰一次」端到端契约（用户钦定 2026-10-06）。
//
// 权威口径（SPEC §6.4）：3 档 = @/关键词之外骰一次，命中就响应，不命中这条置已读。
// 核心不变量：**一条消息在整条判定链上最多掷一次骰**——从 onIncoming 首次判定、
// 到机械批补判定、再到建立会话时的档位固定，全程不得二次抽签。
//
// 这条不变量如果破了，症状是：会话页显示的 contextReason 与真实触发原因不符
// （SPEC:913 要求「骰子结果存进 session.contextReason，会话页可解释」）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveContextTier } from '../src/kernel/wake.js';
import { createOrchestrator } from '../src/kernel/orchestrator.js';
import { createChatStore } from '../src/kernel/store.js';
import { createSessionRegistry } from '../src/kernel/sessions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wake = fs.readFileSync(path.join(root, 'src/kernel/wake.js'), 'utf8');

console.log('=== A. 真实 Orchestrator：首次/机械批判定后固定会话不重新掷骰 ===');

async function verifyProductionPath(mechanical) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-wake-roll-once-'));
  const chatKey = 'group:5600';
  const config = {
    api: { model: 'offline-fixture' },
    store: { contextTier: 3, randomPercent: 50, keywords: [], promptAnchor: { enabled: false } },
    persona: { botName: 'fixture' }, memory: { consolidateEnabled: false },
    chatActive: { enabled: false }, wakeDelayMs: 60_000, sessionRetryAttempts: 0,
  };
  const store = createChatStore({ dataDir, log: {} });
  const sessions = createSessionRegistry({ dataDir, log: {} });
  const verdicts = [];
  let runs = 0;
  const orch = createOrchestrator({
    cfg: () => config, store, sessions, log: {}, memory: {},
    loader: { hooksOf: () => [], promptSections: () => [] },
    components: {
      'core.wake.resolve': args => {
        // A second invocation would miss, exposing any accidental reroll.
        const verdict = resolveContextTier({ ...args, roll: verdicts.length ? 90 : 20 });
        verdicts.push(verdict);
        return verdict;
      },
      'core.agentRunner': async ({ session }) => {
        runs++;
        return { sent: [], rounds: 1, usage: session.usage, finishReason: 'fixture complete' };
      },
    },
  });
  try {
    const entry = store.appendIncoming(chatKey, { mid: 56, ts: Date.now(), senderId: '5601', senderName: 'fixture', text: '闲聊', atMe: false });
    if (mechanical) {
      await orch.wake(chatKey);
    } else {
      await orch.onIncoming(chatKey, entry);
      const waiting = sessions.current(chatKey);
      assert.ok(waiting, '首次判定命中后确实创建等待会话');
      await orch.wake(chatKey, { waitingSessionId: waiting.id, verified: true });
    }
    assert.equal(runs, 1, '真实提示词装配与 runner 路径运行一次');
    assert.equal(verdicts.length, 1, 'onIncoming/机械批补判定之后，固定会话不得第二次调用唤醒策略');
    const summary = sessions.listSummaries()[0];
    const session = sessions.get(summary.id);
    assert.equal(session.status, 'noreply');
    assert.equal(session.contextTier, 3);
    assert.equal(session.contextReason, verdicts[0].reason, '持久化会话保留真实触发原因');
    assert.match(session.contextReason, /20\.0<50/);
    assert.equal(store.unread(chatKey).length, 0);
  } finally {
    orch.stop(); sessions.stop();
    const target = path.resolve(dataDir);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('qqa-wake-roll-once-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
await verifyProductionPath(false);
await verifyProductionPath(true);
console.log('✓ 首次判定和机械批补判定两条真实路径都只调用一次策略，contextReason 保持首次结果');

console.log('\n=== B. 源码事实：3 档随机分支是终态，不存在 continue 下探 ===');
const wakeBody = wake.slice(wake.indexOf('export function resolveContextTier'));
assert.ok(
  /tier >= 3[\s\S]*?Math\.random\(\) \* 100[\s\S]*?return \{ shouldRespond: false, tier: 3/.test(wakeBody),
  '3 档随机未命中直接 return（置已读路径），不继续下探 2/1 档',
);
// 旧实现的 for 循环必须已经不存在
assert.ok(!/for \(const t of \[4, 3, 2, 1\]\)/.test(wakeBody), '旧的 for 循环下探写法已移除');
assert.ok(!/continue;\s*\/\/ 3 档没命中/.test(wakeBody), '旧的下探 continue 已移除');
// 独立短路结构
assert.match(wakeBody, /if \(tier === 4\) return \{ shouldRespond: true, tier: 4/, '4 档独立短路');
assert.match(wakeBody, /if \(tier >= 2 && kw\)/, '2/3 档共用关键词分支');
console.log('✓ 四档独立短路，3 档未命中即终止');

console.log('\n=== C. 行为验证：判定链只掷一次 ===');
const base = { contextTier: 3, randomPercent: 50, keywords: ['鱼'] };
const plain = { text: '闲聊', atMe: false };

// C1. 单条判定全程一次
let count = 0;
const real = Math.random;
try {
  Math.random = () => { count += 1; return 0.2; };
  const v = resolveContextTier({ entry: plain, cfg: base, isPrivate: false });
  assert.equal(v.shouldRespond, true);
  assert.equal(count, 1, '单条判定只掷一次');
} finally { Math.random = real; }
console.log('✓ 单条判定掷骰 1 次');

// C2. 反证：若固定阶段重新掷，可能得到相反结论（旧缺陷的形态）
count = 0;
try {
  const seq = [0.2, 0.9];
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  const first = resolveContextTier({ entry: plain, cfg: base, isPrivate: false, roll: null });
  const reuse = first; // 修复后：复用
  const wouldReroll = resolveContextTier({ entry: plain, cfg: base, isPrivate: false, roll: null }); // 旧缺陷：重掷
  assert.equal(reuse.shouldRespond, true);
  assert.equal(wouldReroll.shouldRespond, false, '若重掷会得到相反结论（这正是要修的）');
  assert.equal(reuse.shouldRespond, true, '修复路径：复用首次结果，结论稳定');
} finally { Math.random = real; }
console.log('✓ 反证：重掷会翻转结论，复用则稳定');

console.log('\n=== D. 拍一拍不分档位 ===');
for (const t of [1, 2, 3, 4]) {
  const v = resolveContextTier({
    entry: { text: '[拍一拍] A 拍了拍 我', atMe: false, isPoke: true },
    cfg: { contextTier: t, randomPercent: 0, keywords: [] }, isPrivate: false,
  });
  assert.equal(v.shouldRespond, true, `${t} 档拍一拍应触发`);
}
console.log('✓ 1/2/3/4 档拍一拍均触发（旧实现把拍一拍塞在 t===1 分支，3 档会漏）');

console.log('\n✓ 56 只骰一次契约：全部通过');