// agent-runner：一次运行的工具循环（§6.7）。
// maxRounds 12；工具集过滤唯一口径（excludedTools 可解释）；hooks 五时序；剩余 3 轮催发；
// 媒体 parts 不进 tool 消息（随 user 补发 R-19）；内联工具调用解析；finish 收尾。
import { chatCompletionWithRetry, addUsage, emptyUsage } from './llm.js';
import { isDeepStrictEqual } from 'node:util';
import { rescueUnsentReply } from './reply-rescue.js';
import { parseInlineToolCalls } from './inline-tools.js';
import { leaseReplyProvider } from './reply-provider.js';
import { replyBatchPayload } from './reply-batch.js';
export { parseInlineToolCalls } from './inline-tools.js';

const HOOK_TIMEOUT_MS = 5000; // SPEC §17.1：Skill hook 超时（定时器不可 unref——否则进程静默退出）

function inlineDefinition(call) {
  const value=call?.function??call;
  if(typeof value?.name!=='string'||!value.name.trim())return null;
  try {
    return {name:value.name,arguments:typeof value.arguments==='string'?value.arguments:JSON.stringify(value.args??value.arguments??{})};
  } catch {return null;}
}
function sameInline(a,b) {
  if(a.name!==b.name)return false;
  try{return isDeepStrictEqual(JSON.parse(a.arguments),JSON.parse(b.arguments));}
  catch{return a.arguments===b.arguments;}
}

async function runHooks(hooks, payload, log) {
  const results = [];
  for (const { ownerId, fn, recordError, managesTimeout } of hooks) {
    let timer;
    try {
      const call = Promise.resolve(fn(payload));
      const r = await (managesTimeout ? call : Promise.race([
        call,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), HOOK_TIMEOUT_MS); }),
      ]));
      if (r?.__timeout) { recordError?.(new Error(`hook 超时（${HOOK_TIMEOUT_MS}ms）`)); log.warn?.(`[runner] hook ${ownerId} 超时（${HOOK_TIMEOUT_MS}ms），跳过`); }
      else results.push({ ownerId, result: r });
    } catch (err) {
      log.error?.(`[runner] hook ${ownerId} 异常（不阻断）：${err?.message ?? err}`); // 单个抛错只记日志
    } finally { clearTimeout(timer); }
  }
  return results;
}

let generationSequence=0;
/**
 * 跑一次 agent 循环。
 * @returns { sent, rounds, usage, finishReason, messages, error }
 */
export async function runAgent({
  session, systemPrompt, userPrompt, tools, execContext,
  cfg, log = console, callLLM = null, llmInvoker = null, capabilities = null, components = null, lifecycle = null,
  invokeTool, hooksOf = () => [], signal = null, onRound = null, onStream = null,
  skipBeforeContext = false, triggerEntries = [],
} = {}) {
  const doCallLLM = callLLM ?? llmInvoker ?? components?.['llm.complete'] ?? chatCompletionWithRetry;
  const parseInlineCalls = components?.['core.tools.parseInline'] ?? parseInlineToolCalls;
  const rescueReply = components?.['core.reply.rescue'] ?? rescueUnsentReply;
  const replyState = {};
  const groundedProvider = capabilities?.providers?.('reply.grounded-select')?.[0]?.provider;
  const replySignal = [signal,execContext?.signal,lifecycle?.signal].filter(Boolean);
  const providerSignal = replySignal.length > 1 ? AbortSignal.any(replySignal) : replySignal[0];
  const selectReply = name => leaseReplyProvider(capabilities,name,{signal:providerSignal,timeoutMs:cfg?.api?.timeoutMs});
  const maxRounds = Math.max(1, Number(cfg?.api?.maxRounds) || 12);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const sent = [];
  const usage = session.usage ?? emptyUsage();
  let finishReason = null;
  let rounds = 0;
  let lastError = null;
  let finished = false;
  let searched = Number(session.webSearchCount) > 0;
  // 请求保持标准 messages；详情需要的 raw/toolCall 只加到落盘快照。
  const metadata = new Map();
  // Progress belongs to the trace, never to the model's messages. The pending
  // slot has the same message index as the eventual response/result.
  let operation = null;
  function beginOperation(kind, extra = {}) {
    const started = performance.now(), step = { kind, messageIndex: messages.length, startedAt: Date.now(), state: 'running', elapsedMs: 0, ...extra };
    let done = false;
    const finish = state => {
      if (!done) { done = true; step.state = state; step.elapsedMs = Math.max(0, performance.now() - started); signal?.removeEventListener('abort', abort); }
      return step;
    };
    const abort = () => { finish('aborted'); publish(); };
    operation = { step, finish, sample: () => ({ ...step, elapsedMs: done ? step.elapsedMs : Math.max(0, performance.now() - started) }) };
    if (signal?.aborted) finish('aborted'); else signal?.addEventListener('abort', abort, { once: true });
    return operation;
  }
  const allSent = () => {
    const out = [];
    for (const item of [...sent, ...(session.sent ?? []), ...(execContext?.session?.sent ?? [])]) {
      if (!out.some((x) => x === item || (x.msgId != null && item.msgId != null && x.msgId === item.msgId && x.text === item.text))) out.push(item);
    }
    return out;
  };
  const publish = () => onRound?.({ round: rounds, messages: messages.map((m) => ({ ...m, ...metadata.get(m) })), sent: allSent(), usage,
    providerId: session.providerId, provider: session.provider, model: session.model, vendor: session.vendor, activeStep: operation?.sample() ?? null });
  const canceled = () => {
    if (!signal?.aborted) return false;
    lastError = signal.reason ?? Object.assign(new Error('已中止'), { __aborted: true });
    return true;
  };
  publish();

  // before-context（组装前）——已在调用侧做（系统提示/用户提示已组装），此处只跑一次
  const hookContext = { session, signal, chatKey: execContext?.chatKey ?? session.chatKey, botName: execContext?.botName };
  if (!skipBeforeContext) await runHooks(hooksOf('before-context'), { ...hookContext, messages }, log);
  // before-llm-messages：可原地修改 messages（同一数组引用）
  await runHooks(hooksOf('before-llm-messages'), { ...hookContext, messages }, log);

  let toolDefs = [...tools];
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    if (canceled()) break;

    // 本地策略能力可在工具循环前提前收尾；没有 provider 完全回退原行为。
    const preflight = selectReply('reply.local-policy');
    if (preflight) {
      try {
        const policy = await preflight.invoke({ phase:'preflight', session, messages, round, remaining: maxRounds - round });
        if (policy?.shouldEnd) { finishReason = policy.reason ?? 'local_policy'; break; }
      } catch (err) { log.warn?.(`[runner] reply.local-policy 异常，回退默认循环：${err?.message ?? err}`); }
      finally {preflight.dispose();}
    }
    // 剩余 3 轮且未发言 → 注入催发（否则轮次耗尽想说的话发不出去）
    const remaining = maxRounds - round;
    if (remaining <= 3 && sent.length === 0 && round > 0) {
      messages.push({
        role: 'user',
        content: `【系统提醒】还剩 ${remaining} 轮工具调用机会。如果你有话想说，请立刻调用 send_message 发出来；不想说就别调用了。`,
      });
    }

    let res, generationDurationMs, generation;
    try {
      if (canceled()) break;
      const tracksRequests = doCallLLM === chatCompletionWithRetry;
      let requests = 0;
      if (!tracksRequests) usage.calls += 1; // 注入调用仍按一次逻辑请求兼容；内置链按实际 HTTP 尝试计费。
      let streamAttempt=0;
      const streamKey=`${session.id}:${Date.now()}:${++generationSequence}`;
      generation = beginOperation('generation',{streamId:`${streamKey}:0`,streamAttempt:0,revision:0,content:'',reasoning:''});publish();
      if (canceled()) break;
      res = await doCallLLM({ messages, tools: toolDefs, cfg, signal, capabilities, log, components, lifecycle, onRequest: () => {
        if (tracksRequests || requests > 0) usage.calls += 1;
        requests++;
        publish();
      }, onDelta: delta => {
        if(signal?.aborted||generation.step.state!=='running')return;
        const step=generation.step;
        if(delta.reset){step.streamId=`${streamKey}:${++streamAttempt}`;step.streamAttempt=streamAttempt;step.revision=0;step.content='';step.reasoning='';}
        const fromRevision=step.revision;
        step.content+=String(delta.content||'');step.reasoning+=String(delta.reasoning||'');step.revision++;
        const sample=generation.sample();
        if(onStream)onStream({step:sample,delta:{reset:!!delta.reset,content:String(delta.content||''),reasoning:String(delta.reasoning||''),fromRevision,revision:step.revision}});
        else publish();
      } }, 2);
      generationDurationMs = generation.finish('completed').elapsedMs;publish();
    } catch (err) {
      generation?.finish(signal?.aborted ? 'aborted' : 'error');publish();
      lastError = err;
      break;
    }
    if (res.usage) addUsage(usage, res.usage);
    for (const [key, value] of Object.entries(res.extraUsage ?? {})) {
      const n = Number(value);
      if (!Number.isFinite(n) || !n) continue;
      usage.extra ??= {};
      usage.extra[key] = (Number(usage.extra[key]) || 0) + n;
    }
    session.model = res._usedModel ?? res.model ?? session.model;
    session.vendor = res._usedApi?.baseUrl ?? session.vendor; // 渠道与模型同源（成本报表）
    session.providerId = res._usedApi?.provider ?? cfg?.api?.provider ?? '';
    session.provider = session.providerId;
    session.reasoning = res.reasoning ?? session.reasoning;
    const raw = res.raw ?? (res.usage ? { usage: res.usage } : undefined);
    const recordResponse = (message = res.message ?? {}) => {
      // Tool/inline/rescue paths replace content and tool_calls. Keep the final
      // reasoning for both the trace and providers that require it next round.
      const reasoning = res.message?.reasoning_content ?? res.reasoning;
      const entry = { role: 'assistant', ...(typeof reasoning === 'string' ? { reasoning_content: reasoning } : {}), ...message };
      messages.push(entry);
      metadata.set(entry, { ...(raw ? { raw } : {}), generationDurationMs, generationStartedAt: generation.step.startedAt, generationState: generation.step.state });
      if (operation === generation) operation = null;
      return entry;
    };
    if (canceled()) {
      recordResponse();
      break;
    }

    await runHooks(hooksOf('after-response'), { ...hookContext, response: res }, log);
    if (canceled()) { recordResponse(); break; }

    const msg = res.message ?? {};
    const originalReplyBody = typeof msg.content==='string'?msg.content:'';
    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    let rescueGuard = null;
    let rescueLease = null;
    let inlineLease = null;
    let inlineGuard = null;
    try {
    // 内联工具调用（模型把调用写成文本）→ 改写 assistant 条目为 tool_calls 形态
    if (toolCalls.length === 0 && typeof msg.content === 'string') {
      let inline = null;
      inlineLease = selectReply('reply.inline-calls');
      if (inlineLease) {
        try { inline = await inlineLease.invoke({ text: msg.content, response: res, session }); } catch (err) { log.warn?.(`[runner] reply.inline-calls 异常，回退内置解析：${err?.message ?? err}`); }
      }
      const contributed = Array.isArray(inline) || (inline && Array.isArray(inline.calls));
      if (contributed) inlineGuard=inlineLease.valid;
      else {inlineLease?.dispose();inlineLease=null;}
      if (inline && !Array.isArray(inline) && Array.isArray(inline.calls)) {
        // Old reply providers contribute {calls:[{name,args}]}; preserve the
        // selected core parser and merge only their additional definitions.
        const combined=(parseInlineCalls(msg.content)??[]).map(inlineDefinition).filter(Boolean);
        for(const call of inline.calls){const next=inlineDefinition(call);if(next&&!combined.some(old=>sameInline(old,next)))combined.push(next);}
        inline=combined;
      } else if (!Array.isArray(inline)) inline = parseInlineCalls(msg.content);
      inline=(Array.isArray(inline)?inline:[]).map(inlineDefinition).filter(Boolean);
      if (inline.length > 0) {
        toolCalls = inline.map((c, i) => ({ id: `inline_${round}_${i}`, type: 'function', function: c }));
        log.warn?.(`[runner] 从文本中解析出 ${inline.length} 个内联工具调用`);
      }
    }

    if (toolCalls.length === 0) {
      // grounded-select：让外部 reply-rescue/provider 记录候选草稿或重置候选；
      // 没有 provider 时完全回退原始响应，不影响默认行为。
      if (typeof groundedProvider === 'function') {
        try {
          const decision = await groundedProvider({ response: res, content: msg.content ?? '', session, messages });
          if (decision?.reset === true) session.replyDrafts = [];
          if (decision?.remember) { session.replyDrafts = session.replyDrafts ?? []; session.replyDrafts.push(String(decision.remember).slice(0, 400)); }
          if (decision?.content) msg.content = String(decision.content);
        } catch (err) { log.warn?.(`[runner] reply.grounded-select 异常，回退原文：${err?.message ?? err}`); }
      }
      if (canceled()) { recordResponse(msg); break; }
      let rescued;
      try {
        const trigger=typeof session.triggerText==='string'?session.triggerText:(Array.isArray(session.trigger)?session.trigger:[]).map(item=>String(item?.text??'')).join('\n').slice(0,400);
        if(originalReplyBody.trim())rescued=await rescueReply({text:originalReplyBody,trigger,sent:allSent(),api:res._usedApi??cfg?.api,
          capabilities,signal,state:replyState,timeoutMs:cfg?.api?.timeoutMs,log});
        rescueLease=rescued;
        const proposed=Array.isArray(rescued?.calls)?rescued.calls.map(inlineDefinition).filter(Boolean):[];
        if(typeof rescued?.valid==='function'&&rescued.valid()&&proposed.length&&proposed.every(call=>call.name==='send_message')){
          rescueGuard=rescued.valid;
          toolCalls=proposed.map((definition,index)=>({id:`rescue_${round}_${index}`,type:'function',function:definition}));
        }
      } catch(error) {log.warn?.(`[runner] reply rescue 失败，保留未发送正文：${error?.message??error}`);}
      if (canceled()) { recordResponse(msg); break; }
      if(!toolCalls.length){
        finishReason = res.finishReason ?? 'stop';
        recordResponse({ content: msg.content ?? '' });
        break;
      }
    }

    const assistant=recordResponse({ content: rescueGuard?null:msg.content??'', tool_calls: toolCalls });
    if(rescueGuard)metadata.set(assistant,{...metadata.get(assistant),rescued:true});
    publish();
    const mediaParts = []; // 媒体 parts 不进 tool 消息（R-19）
    const beforeSent = allSent().length, batchResults = [];
    for (const tc of toolCalls) {
      if (canceled()) break;
      const name = tc.function?.name;
      if (name === 'web_search' || name === 'web_fetch') { searched=true;session.webSearchCount=(Number(session.webSearchCount)||0)+1; }
      let args = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { args = {}; }
      const sentBeforeTool = allSent();
      const toolOperation = beginOperation('tool', { name, args });
      try { publish(); } catch (error) { toolOperation.finish('error');throw error; }
      // before-tool（可否决）
      let blocked = null;
      for (const { ownerId, fn, recordError, managesTimeout } of hooksOf('before-tool')) {
        let timer;
        try {
          const call = Promise.resolve(fn({ ...hookContext, toolName: name, argsRaw: tc.function?.arguments }));
          const v = await (managesTimeout ? call : Promise.race([
            call,
            new Promise((r) => { timer = setTimeout(() => { recordError?.(new Error(`before-tool 超时（${HOOK_TIMEOUT_MS}ms）`)); r(null); }, HOOK_TIMEOUT_MS); }),
          ]));
          if (v && v.block) { blocked = v; break; }
          void ownerId;
        } catch (err) { log.error?.(`[runner] before-tool hook 异常：${err?.message}`); }
        finally { clearTimeout(timer); }
      }
      let resultText;
      let toolOk = false;
      let rescueCurrent=true;
      const proposalGuard = inlineGuard ?? rescueGuard;
      const proposalLease = inlineLease ?? rescueLease;
      try {if(proposalGuard)rescueCurrent=proposalGuard()===true;}catch{rescueCurrent=false;}
      if (blocked) {
        resultText = `错误：${blocked.reason ?? '该工具调用被插件否决'}`;
      } else if(!rescueCurrent) {
        resultText = '错误：回复提供者已变更，未执行这次发送';
      } else {
        try {
          if (canceled()) break;
          const toolContext = proposalGuard && proposalLease?.signal
            ? {...execContext,signal:AbortSignal.any([signal,execContext?.signal,proposalLease.signal].filter(Boolean))}
            : execContext;
          let r = await invokeTool(name, args, toolContext);
          // registry 包一层执行结果；捆绑工具自身也有业务 ok/result，兼容直接注入调用。
          if (r?.ok && r.result && typeof r.result === 'object' && typeof r.result.ok === 'boolean') r = r.result;
          const toolSent = r?.sent ?? r?.result?.sent;
          for (const item of Array.isArray(toolSent) ? toolSent : []) {
            if (!sent.some((x) => x === item || (x.msgId != null && item.msgId != null && x.msgId === item.msgId && x.text === item.text))) sent.push(item);
          }
          // Already-returned ToolResult media stays outside text on failures too;
          // collection adds no media/network operation or permission bypass.
          if (Array.isArray(r.mediaParts) && r.mediaParts.length > 0) mediaParts.push(...r.mediaParts);
          if (r.ok) {
            toolOk = true;
            // 业务对象也可直接返回 {ok:true,text:...}，不能将其压成空的成功标记。
            // mediaParts 独立补发到 user 消息，不混入 tool 文本。
            const { mediaParts: omittedMedia, ...business } = r;
            const value = Object.hasOwn(r, 'result') ? r.result : business;
            resultText = typeof value === 'string' ? value : JSON.stringify(value);
            if (name === 'finish') {
              finishReason = session.finishReason ?? args.reason ?? args.summary ?? 'finish';
              finished = true;
            }
          } else {
            resultText = `错误：${r.error ?? '执行失败'}`;
          }
        } catch (err) {
          resultText = `错误：${err?.message ?? err}`;
        }
      }
      const entry = { role: 'tool', tool_call_id: tc.id, content: resultText };
      messages.push(entry);
      batchResults.push({...entry,name,isError:!toolOk});
      const timing = toolOperation.finish(toolOk ? 'completed' : 'error');
      const toolSent = allSent().filter(item => !sentBeforeTool.some(old => old === item || (old.msgId != null && item.msgId != null && old.msgId === item.msgId && old.text === item.text)));
      metadata.set(entry, { toolCall: { name, args, result: resultText, ok: toolOk, sent: toolSent, durationMs: timing.elapsedMs, startedAt: timing.startedAt, state: timing.state } });
      if (operation === toolOperation) operation = null;
      publish(); // 已发的部分消息立即回写，后续错误不得自动复读
      await runHooks(hooksOf('after-tool'), { ...hookContext, toolName: name, argsRaw: tc.function?.arguments, result: resultText }, log);
      if (canceled() || finished) break;
    }
    if (finished || lastError) break;
    // 媒体 parts 随 user 消息补发（tool 消息只带文本——多数端点不接受 media in tool）
    if (mediaParts.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[系统：以下是工具返回的 ${mediaParts.length} 个媒体，请直接"看"了回应]` },
          ...mediaParts,
        ],
      });
    }
    publish();
    if (!canceled()) {
      const afterBatch = selectReply('reply.after-tool-batch');
      if (afterBatch) try {
        const policy = await afterBatch.invoke(replyBatchPayload({api:res._usedApi??cfg?.api,
          entries:triggerEntries,calls:toolCalls,results:batchResults,beforeSent,allSent:allSent(),searched,
          session,round,remaining:maxRounds-round-1}));
        if (policy?.shouldEnd) {finishReason=policy.reason??'local_policy_batch';break;}
      } catch (err) {log.warn?.(`[runner] reply.after-tool-batch 异常，回退默认循环：${err?.message??err}`);}
      finally {afterBatch.dispose();}
    }
    if (round === maxRounds - 1) { finishReason = 'max_rounds'; }
    } finally {
      try {inlineLease?.dispose?.();} catch(error) {log.warn?.(`[runner] inline lease 清理失败：${error?.message??error}`);}
      try {rescueLease?.dispose?.();} catch(error) {log.warn?.(`[runner] reply lease 清理失败：${error?.message??error}`);}
    }
  }

  // sent 的单一真相是 execContext.session.sent（send_message/finish 工具直写）；
  // runner 本地 sent 数组只兜"工具返回 {sent} 但未写 session"的路径（不重复计）
  const finalSent = allSent();
  canceled();
  publish();
  return { sent: finalSent, rounds, usage, finishReason, messages: messages.map((m) => ({ ...m, ...metadata.get(m) })), activeStep: operation?.sample() ?? null, error: lastError };
}
