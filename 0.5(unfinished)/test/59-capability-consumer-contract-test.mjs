// 59 · SPEC §7.5 capability consumer contract：声明的增强能力必须有生产消费点；
// provider 缺失时保持默认行为回退，不把能力 registry 存在当成已实现功能。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySelectedMediaConsumer } from './media-consumer-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const orchestrator=read('src/kernel/orchestrator.js');
const runner=read('src/kernel/agent-runner.js');
const kernel=read('src/kernel/kernel.js');

console.log('=== message.owner-check ===');
assert.ok(orchestrator.includes("capability?.providers?.('message.owner-check')"),'orchestrator consumes owner-check');
assert.match(orchestrator,/verdict\?\.persona/,'owner verdict can replace persona');
assert.match(orchestrator,/ownerRules = verdict\.rules/,'owner rules enter prompt extra sections');
console.log('✓ owner-check production consumer');

console.log('=== media.download ===');
assert.ok(kernel.includes("components['core.media.forward']"), 'kernel dispatches its selected media consumer');
await verifySelectedMediaConsumer();
console.log('✓ media.download production consumer');

console.log('=== reply capabilities ===');
const replyProvider=read('src/kernel/reply-provider.js');
assert.ok(runner.includes("selectReply('reply.inline-calls')"),'inline-calls provider queried at its response phase');
assert.ok(runner.includes("selectReply('reply.local-policy')"),'local-policy provider queried at preflight');
assert.match(runner,/leaseReplyProvider\(capabilities,name/,'the consumer delegates to the selected-provider lease');
assert.match(replyProvider,/capabilities\?\.providers\?\.\(name\)/,'the lease queries the actual provider registry');
assert.ok(runner.includes("providers?.('reply.grounded-select')"),'grounded-select provider queried');
assert.match(runner,/inlineLease\.invoke\(\{/,'inline provider can override parser through the live lease');
assert.match(runner,/policy\?\.shouldEnd/,'local policy can early finish');
assert.ok(runner.includes('decision?.remember')&&runner.includes('decision?.reset'),'grounded select remember/reset consumed');
console.log('✓ reply capability production consumers with safe fallback');

// 行为验证：真实 LLM 消费函数 + fixture provider + mock fetch。
const { createCapabilityRegistry } = await import('../src/kernel/capability.js');
const { chatCompletion, chatCompletionWithRetry } = await import('../src/kernel/llm.js');
const { runAgent } = await import('../src/kernel/agent-runner.js');
const cfg = { api: { baseUrl: 'https://fixture.invalid/v1', model: 'main', thinkingMode: 'off' } };
const policyCaps=createCapabilityRegistry();
policyCaps.register('reply.local-policy','fixture-policy',()=>({shouldEnd:true,reason:'consumer-policy'}));
const policyResult=await runAgent({session:{},systemPrompt:'fixture',userPrompt:'fixture',tools:[],cfg,capabilities:policyCaps,
  invokeTool:async()=>{throw Error('preflight must not execute a tool');},callLLM:async()=>{throw Error('preflight must not invoke a model');}});
assert.equal(policyResult.finishReason,'consumer-policy');
const inlineCaps=createCapabilityRegistry(),inlineInvocations=[];
inlineCaps.register('reply.inline-calls','fixture-inline',()=>({calls:[{name:'finish',args:{reason:'consumer-inline'}}]}));
const inlineResult=await runAgent({session:{},systemPrompt:'fixture',userPrompt:'fixture',tools:[{type:'function',function:{name:'finish',parameters:{type:'object'}}}],cfg,capabilities:inlineCaps,
  invokeTool:async(name,args)=>{inlineInvocations.push({name,args});return{ok:true};},callLLM:async()=>({message:{content:'ordinary text without a tool call'}})});
assert.deepEqual(inlineInvocations,[{name:'finish',args:{reason:'consumer-inline'}}]);
assert.equal(inlineResult.finishReason,'consumer-inline');
const logs = [];
const log = { warn: (text) => logs.push(text) };
const caps = createCapabilityRegistry({ log });
const response = (status = 200) => ({
  ok: status === 200, status, headers: { get: () => 'application/json' },
  text: async () => status === 200
    ? JSON.stringify({ model: 'main', choices: [{ message: { content: 'original' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3 } })
    : 'fixture rejected parameter',
});
caps.register('llm.request-params', 'broken', () => { throw new Error('fixture provider error'); });
caps.register('llm.request-params', 'first', ({ body }) => ({ body: { ...body, marker: 'first' } }));
caps.register('llm.request-params', 'second', ({ body }) => {
  assert.equal(body.marker, 'first', '转换器串行');
  return { body: { ...body, marker: 'second' }, omitTemperature: true };
});
caps.register('llm.response', 'response', ({ result }) => ({ result: { message: { ...result.message, content: 'transformed' } } }));
caps.register('llm.usage', 'usage-one', () => ({ fixtureTokens: 2 }));
caps.register('llm.usage', 'usage-two', () => ({ fixtureTokens: 3 }));
const transformed = await chatCompletion({ cfg, messages: [], capabilities: caps, log, fetchFn: async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.marker, 'second');
  assert.equal('temperature' in body, false);
  return response();
} });
assert.equal(transformed.message.content, 'transformed');
assert.equal(transformed.extraUsage.fixtureTokens, 5);
assert.equal(transformed.usage.prompt_tokens, 3);
assert.equal(logs.length, 1, '坏转换器仅记录异常，不阻断');

const adviceCaps = createCapabilityRegistry();
let advised = 0, attempts = 0;
adviceCaps.register('llm.retry-advisor', 'skip', () => null);
adviceCaps.register('llm.retry-advisor', 'advice', ({ body, status }) => {
  advised++;
  assert.equal(status, 415);
  return { body: { ...body, repaired: true }, reason: 'fixture repair' };
});
const repaired = await chatCompletion({ cfg, messages: [], capabilities: adviceCaps, fetchFn: async (_url, init) => {
  attempts++;
  return JSON.parse(init.body).repaired ? response() : response(415);
} });
assert.equal(attempts, 2);
assert.equal(advised, 1);
assert.equal(repaired.degraded, true);
attempts = 0; advised = 0;
await assert.rejects(chatCompletion({ cfg, messages: [], capabilities: adviceCaps, fetchFn: async () => { attempts++; return response(415); } }), /HTTP 415/);
assert.equal(attempts, 2, '降级最多重试一次');
assert.equal(advised, 1);

const pool = createCapabilityRegistry();
let picks = 0;
const feedback = [];
pool.register('llm.endpoint-pick', 'pool', () => { picks++; return { id: 'account-fixture', baseUrl: 'https://pool.invalid/v1', model: 'pooled' }; });
pool.register('llm.endpoint-feedback', 'pool', (payload) => feedback.push(payload));
const used = await chatCompletionWithRetry({ cfg, messages: [], capabilities: pool, fetchFn: async (url) => {
  assert.equal(url, 'https://pool.invalid/v1/chat/completions');
  return response();
} }, 0);
assert.equal(picks, 1);
assert.equal(used._usedApi.baseUrl, 'https://pool.invalid/v1');
assert.equal(feedback[0].accountId, 'account-fixture');
assert.equal(feedback[0].ok, true);
await chatCompletionWithRetry({
  cfg: { api: { ...cfg.api, fallbackModels: [{ model: 'backup' }] } },
  messages: [], capabilities: pool,
  fetchFn: async (_url, init) => JSON.parse(init.body).model === 'backup' ? response() : response(401),
}, 0);
assert.equal(picks, 2, '只有主候选走池，backup 不重新选池');
assert.equal(feedback[1].ok, false);

const fallbackCaps = createCapabilityRegistry();
fallbackCaps.register('llm.endpoint-pick', 'empty', () => null);
const plain = await chatCompletion({ cfg, messages: [], capabilities: fallbackCaps, fetchFn: async (url) => {
  assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
  return response();
} });
assert.equal(plain.message.content, 'original', '空池完全回退');
const aborter = new AbortController();
aborter.abort(new Error('fixture cancelled'));
await assert.rejects(chatCompletion({ cfg, messages: [], signal: aborter.signal, capabilities: pool, fetchFn: () => { throw new Error('不应发请求'); } }), /fixture cancelled/);
assert.equal(picks, 2, '已取消不调用池');

await runAgent({
  session: {}, systemPrompt: 'fixture', userPrompt: 'fixture', tools: [], cfg,
  capabilities: caps, log, invokeTool: async () => ({}),
  callLLM: async (args) => {
    assert.equal(args.capabilities, caps, '生产 runner 传递注册表');
    return { message: { content: '' }, finishReason: 'stop' };
  },
});
console.log('✓ LLM 六个消费接口：串行转换/异常隔离/用量/单次降级/池反馈/备选回退/取消/runner传递');
console.log('\n✓ 59 capability consumer contract: all passed');
