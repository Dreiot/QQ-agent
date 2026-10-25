// M1 测试 runner
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = [
  'run-m0.mjs',              // M0 回归（作为子 runner 嵌套调用）
  '10-transport-test.mjs',
  '11-store-test.mjs',
  '12-wake-test.mjs',
  '13-memory-sessions-test.mjs',
  '14-prompt-test.mjs',
  '15-llm-test.mjs',
  '16-send-test.mjs',
  '17-ingest-test.mjs',
  '18-orchestrator-test.mjs',
  '19-onebot-e2e-test.mjs',
  '49-transport-inject-test.mjs','56-wake-roll-once-test.mjs','60-telemetry-totals-test.mjs',
  '305-session-flow-test.mjs',
];

let pass = 0, fail = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { stdio: 'inherit', timeout: 240000 });
  if (r.status === 0) pass += 1; else fail += 1;
}
console.log(`\n${fail === 0 ? '✓ M1 全部通过' : '✗ 有失败'}：${pass}/${pass + fail} 个测试文件`);
process.exit(fail === 0 ? 0 : 1);
