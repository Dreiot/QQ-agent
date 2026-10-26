// SendQueue：出站队列。每会话串行链 + 限频 + 去重（成功后才记账 R-02）+ 真人停顿 + 硬切分 + 回退链。
// 契约：SPEC §6.10 全条 + §16 血泪 11（图片去重键 url>file>data:长度:前64）/ 15MB base64 回退上限。
// 内核不认识具体平台（DSH §3.1 模块 10 禁止项）——发送动作经 transport provider 的 send()。
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMediaReader } from './media.js';
import { mdToPlain, splitText, prepareTextBatch } from './send-text.js';
export { mdToPlain } from './send-text.js';

// Windows 路径 → OneBot file URI（SPEC §16 血泪 5：file:///C:/...，#/? 手动转义，UNC 特判，幂等）
export function toFileUri(p) {
  const s = String(p ?? '').trim().replaceAll('\\', '/');
  if (!s) return s;
  if (s.slice(0, 7).toLowerCase() === 'file://') return s; // 幂等
  const unc = s.startsWith('//');
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  // 原始路径里的百分号/空格/Unicode 需编码；encodeURI 保留的 #/? 另行转义。
  const encoded = encodeURI(body).replaceAll('#', '%23').replaceAll('?', '%3F');
  return unc ? `file://${encoded}` : `file:///${encoded}`;
}

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// 图片去重键（§16 血泪 11）：url > file > data:长度:前64
export function imageFingerprint(item) {
  if (item?.url) return `url:${item.url}`;
  if (item?.file) return `file:${item.file}`;
  const d = String(item?.dataUrl ?? item?.base64 ?? '');
  return `data:${d.length}:${d.slice(0, 64)}`;
}

export function createSendQueue({
  transport, store, log = console, cfg, onSent = null, bus = null, mediaReader = null, components = null,
} = {}) {
  const chains = new Map();  // chatKey -> Promise（每会话一条串行链）
  const rate = new Map();    // chatKey -> { minute: [], hour: [] }
  const dedupe = new Map();  // chatKey -> Map<fingerprint, ts>（成功后才记账）

  // cfg 可能是 getter 函数（内核装配约定）或对象——统一取值
  const readCfg = () => (typeof cfg === 'function' ? cfg() : cfg) ?? {};
  let fallbackReader;
  const getReader = () => (typeof mediaReader === 'function' ? mediaReader() : mediaReader)
    ?? (fallbackReader ??= createMediaReader({ cfg, transport, log }));
  function base64Segment(source) {
    const value = String(source ?? '');
    const match = value.match(/^data:[^,]*;base64,([\s\S]+)$/i);
    if (/^data:/i.test(value) && !match) throw new Error('发送失败：图片 dataUrl 必须使用 base64 编码');
    const payload = (match ? match[1] : value.replace(/^base64:\/\//i, '')).replace(/\s/g, '');
    if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('发送失败：图片 base64 为空或格式无效');
    if (Buffer.byteLength(payload, 'base64') > 15 * 1024 * 1024) throw new Error('发送失败：base64 图片超过 15 MB 回退上限');
    return { type: 'image', file: `base64://${payload}` };
  }
  const sendCfg = () => {
    const s = readCfg().send ?? {};
    return {
      minGapMs: Math.max(200, Number(s.minGapMs) || 1000),
      maxGapMs: Number(s.maxGapMs) || 3000,
      byLengthMs: Number(s.byLengthMs) || 20,
      maxPerMinute: Number(s.maxPerMinute) || 80,
      maxPerHour: Number(s.maxPerHour) || 500,
      hardSplitAt: Number.isFinite(Number(s.hardSplitAt)) ? Number(s.hardSplitAt) : 4000,
      dedupeWindowMs: Number.isFinite(Number(s.dedupeWindowMs)) ? Number(s.dedupeWindowMs) : 8000,
    };
  };

  function rateCheck(chatKey) {
    const c = sendCfg();
    const now = Date.now();
    let r = rate.get(chatKey);
    if (!r) { r = { minute: [], hour: [] }; rate.set(chatKey, r); }
    r.minute = r.minute.filter((t) => now - t < 60_000);
    r.hour = r.hour.filter((t) => now - t < 3_600_000);
    if (r.minute.length >= c.maxPerMinute) {
      throw new Error(`发送失败：本会话一分钟内已发 ${c.maxPerMinute} 条（每分钟上限 ${c.maxPerMinute} 条），请稍后再发或结束本轮`);
    }
    if (r.hour.length >= c.maxPerHour) {
      throw new Error(`发送失败：本会话一小时已发 ${c.maxPerHour} 条（每小时上限 ${c.maxPerHour} 条），请稍后再发`);
    }
    return r;
  }

  function markSent(chatKey, fps) {
    const c = sendCfg();
    const now = Date.now();
    let d = dedupe.get(chatKey);
    if (!d) { d = new Map(); dedupe.set(chatKey, d); }
    for (const fp of fps) d.set(fp, now);
    for (const [k, ts] of d) if (now - ts > c.dedupeWindowMs) d.delete(k);
    const r = rate.get(chatKey);
    if (r) { r.minute.push(now); r.hour.push(now); }
  }

  function isDup(chatKey, fp) {
    const c = sendCfg();
    if (!c.dedupeWindowMs) return false;
    const d = dedupe.get(chatKey);
    if (!d) return false;
    const ts = d.get(fp);
    return ts !== undefined && Date.now() - ts < c.dedupeWindowMs;
  }

  // 文本预处理（§6.10.1）：md 清理 → [object Object] 拦截 → hardSplitAt 切分
  function preprocessText(text, prepared = false) {
    return prepareTextBatch(text, {
      plainText: components?.['core.text.plain'] ?? mdToPlain,
      split: components?.['core.text.split'] ?? splitText,
      limit: sendCfg().hardSplitAt, prepared,
    });
  }

  // 真人停顿（§6.10.3）：gap = clamp(randInt(min,max)*0.5 + 字数*byLengthMs*0.5)，最后一条 0
  function computeGap(text, isLast) {
    const c = sendCfg();
    if (isLast) return 0;
    const base = randInt(c.minGapMs, c.maxGapMs) * 0.5;
    const byLen = Math.min(8000, String(text ?? '').length * c.byLengthMs) * 0.5;
    return Math.round(clamp(base + byLen, 0, 8000));
  }

  function abortError(signal) {
    const error = new Error('发送已中止', { cause: signal?.reason });
    error.__aborted = true;
    return error;
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw abortError(signal);
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError(signal)); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // 每会话串行链（§6.10：同一会话的发送动作必须串行，保证停顿与去重语义）
  function enqueue(chatKey, task) {
    const prev = chains.get(chatKey) ?? Promise.resolve();
    const next = prev.then(task, task); // 前一条失败不阻断后续
    chains.set(chatKey, next.catch(() => {}));
    return next;
  }

  async function chainSend(chatKey, segmentsList, { replyToMessageId = null, atUserId = null, fingerprints = [], signal, beforeSend } = {}) {
    const sentResults = [];
    let skipped = 0;
    for (let i = 0; i < segmentsList.length; i++) {
      let segs = segmentsList[i];
      const isLast = i === segmentsList.length - 1;
      let res;
      try {
        checkAbort(signal);
        const fp = fingerprints[i];
        if (fp && isDup(chatKey, fp)) { skipped += 1; continue; }
        rateCheck(chatKey);
        // 点名仅附在本批第一条实际发出的消息上，前面的重复条目可以被跳过。
        if (atUserId && sentResults.length === 0 && !segs.some((s) => s.type === 'at')) segs = [...segs, { type: 'at', id: String(atUserId) }];
        // 一次逻辑回复只在第一条实际发出的消息上引用；重复内容跳过后仍以首个成功项为准。
        if(beforeSend)await beforeSend();checkAbort(signal);
        res = await transport.send(chatKey, segs, { replyToMessageId: sentResults.length === 0 ? replyToMessageId : null, atUserId, signal });
      } catch (err) {
        // 部分失败：failed[] 带 index+原文+错误（模型能知道哪条失败）
        const attempted = segs.map((s) => s.text ?? `[${s.type}]`).join('');
        return { ok: false, sent: sentResults, failed: [{ index: i, text: attempted, error: String(err?.message ?? err) }], ...(err?.__aborted ? { aborted: true } : {}) };
      }
      // 每个成功的物理消息立即记账，即便本批后续发送失败，也不能忘记已发消息。
      markSent(chatKey, fingerprints[i] ? [fingerprints[i]] : []);
      const msgId = Array.isArray(res) ? res[0]?.msgId ?? null : res?.msgId ?? null;
      const textForStore = segs.map((s) => (s.type === 'text' ? s.text : s.type === 'image' ? '[图片]' : s.type === 'face' ? `[表情${s.id}]` : `[${s.type}]`)).join('');
      sentResults.push({ index: i, text: textForStore, msgId, at: Date.now() });
      try {
        store?.appendSelf?.(chatKey, { mid: msgId, text: textForStore, media: segs.filter((s) => s.type !== 'text' && s.type !== 'at') });
        bus?.emit('message.sent', { chatKey, index: i, text: textForStore, msgId });
        onSent?.({ chatKey, msgId, text: textForStore });
      } catch (err) { log.error?.(`[send] 消息已发送，但记录或通知失败：${err?.message ?? err}`); }
      if (!isLast) {
        try { await sleep(computeGap(textForStore, false), signal); }
        catch (err) { return { ok: false, sent: sentResults, failed: [{ index: i + 1, text: segmentsList[i + 1].map((s) => s.text ?? `[${s.type}]`).join(''), error: err.message }], aborted: true }; }
      }
    }
    return { ok: true, sent: sentResults, failed: [], ...(skipped && !sentResults.length ? { deduped: true, note: '内容刚刚发送过，已静默跳过（防刷屏）' } : {}) };
  }

  /** 发文本批（模型调用 send_message）。texts 为字符串或字符串数组。 */
  async function sendTextBatch(chatKey, texts, opts = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    // 展开成单条消息数组
    const messages = [];
    const appendParts = (parts) => {
      const whole = parts.length > 1 ? crypto.createHash('sha256').update(parts.join('')).digest('hex') : null;
      for (let i = 0; i < parts.length; i++) {
        // 同一长消息的相邻切片可以相同，不能把合法切片误判为重复消息。
        messages.push({ text: parts[i], fp: whole ? `split:${whole}:${i}` : `text:${parts[i]}` });
      }
    };
    if (opts.textFormat === 'prepared') {
      // These are physical fragments of one logical plan. Validate together so
      // whitespace-only fragments survive, and equal slices keep distinct IDs.
      appendParts(preprocessText(list, true));
    } else for (const raw of list) {
      if (raw == null) continue;
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw new Error(`发送失败：消息内容必须是字符串（收到 ${typeof raw}）`);
      }
      appendParts(preprocessText(String(raw)));
    }
    if (messages.length === 0) throw new Error('消息内容为空');

    return enqueue(chatKey, async () => {
      const segs = messages.map(({ text }) => [{ type: 'text', text }]);
      const res = await chainSend(chatKey, segs, { ...opts, fingerprints: messages.map(({ fp }) => fp) });
      if (!res.ok && res.sent.length === 0) throw new Error(res.failed[0]?.error ?? '发送失败');
      return res;
    });
  }

  /** 发图片：优先 URL / file URI，失败后使用已校验的 base64。 */
  async function sendImage(chatKey, { url, file, dataUrl, base64 } = {}, opts = {}) {
    const fp = imageFingerprint({ url, file, dataUrl, base64 });
    return enqueue(chatKey, async () => {
      if (!url && !file && !dataUrl && !base64) throw new Error('发送失败：图片缺少 url/file/dataUrl');
      const candidates = [];
      if (url) candidates.push(() => ({ type: 'image', url }));
      if (file) candidates.push(() => ({ type: 'image', file: toFileUri(file) }));
      if (dataUrl || base64) candidates.push(() => base64Segment(dataUrl ?? base64));
      let lastErr;
      for (const candidate of candidates) {
        const seg = candidate();
        const message = opts.note ? [{ type: 'text', text: String(opts.note).slice(0, 500) }, seg] : [seg];
        const res = await chainSend(chatKey, [message], { ...opts, fingerprints: [`image:${fp}`] });
        if (res.ok) return res;
        if (res.aborted) throw abortError(opts.signal);
        lastErr = res.failed[0]?.error;
      }
      throw new Error(lastErr ?? '图片发送失败');
    });
  }

  /** 发收藏表情（send_sticker）：三级回退 file → get_image → base64 ≤15MB。 */
  async function sendSticker(chatKey, sticker, opts = {}) {
    const fp = sticker?.id || sticker?.fileId ? `id:${sticker.id ?? sticker.fileId}` : imageFingerprint({ file: sticker?.localPath, url: sticker?.url });
    return enqueue(chatKey, async () => {
      if (!sticker?.localPath && !sticker?.fileId && !sticker?.url) throw new Error('发送失败：这张表情没有可用的文件或链接');
      let lastErr = null;
      const attempt = async (seg) => {
        const res = await chainSend(chatKey, [[seg]], { ...opts, fingerprints: [`sticker:${fp}`] });
        if (res.ok) return res;
        if (res.aborted) throw abortError(opts.signal);
        lastErr = res.failed[0]?.error;
        return null;
      };
      if (sticker.localPath) {
        const result = await attempt({ type: 'image', file: toFileUri(sticker.localPath) });
        if (result) return result;
      }
      let cached;
      if (sticker.fileId && transport.actions?.getImage) {
        try {
          if (opts.signal?.aborted) throw abortError(opts.signal);
          cached = await transport.actions.getImage(sticker.fileId, { signal: opts.signal });
          if (opts.signal?.aborted) throw abortError(opts.signal);
          const file = cached?.file ?? cached?.path;
          if (file && !/^https?:\/\//i.test(file)) {
            const result = await attempt({ type: 'image', file: toFileUri(file) });
            if (result) return result;
          }
        } catch (err) { if (opts.signal?.aborted) throw abortError(opts.signal); lastErr = String(err?.message ?? err); }
      }
      try {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        const file = cached?.file ?? cached?.path ?? sticker.localPath;
        let dataUrl;
        if (file && !/^https?:\/\//i.test(file)) {
          try {
            const filename = /^file:/i.test(String(file)) ? fileURLToPath(file) : String(file);
            const stat = await fs.promises.stat(filename);
            if (stat.size > 15 * 1024 * 1024) throw new Error('图片超过 15 MB 回退上限');
            dataUrl = `data:application/octet-stream;base64,${(await fs.promises.readFile(filename)).toString('base64')}`;
          } catch (err) {
            if (!cached?.url && !sticker.url) throw err;
          }
        }
        if (!dataUrl) {
          const downloaded = await getReader().image({ file: sticker.fileId, url: cached?.url ?? sticker.url }, { signal: opts.signal, maxBytes: 15 * 1024 * 1024 });
          dataUrl = downloaded.dataUrl;
        }
        const result = await attempt(base64Segment(dataUrl));
        if (result) return result;
      } catch (err) {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        lastErr = String(err?.message ?? err);
      }
      throw new Error(lastErr ?? '表情发送失败（三级回退均失败）');
    });
  }

  /** 拍一拍（send_poke）——轻交互，不进发送限频（0.4 语义：poke 不占消息配额）。 */
  async function poke(chatKey, { groupId, userId } = {}) {
    return transport.actions?.poke
      ? transport.actions.poke(chatKey, { groupId, userId })
      : Promise.reject(new Error('当前传输不支持拍一拍'));
  }

  async function sendSegments(chatKey, segments, opts = {}) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error('发送失败：媒体消息为空');
    const fp = 'segments:' + crypto.createHash('sha256').update(JSON.stringify(segments)).digest('hex');
    return enqueue(chatKey, async () => {
      const res = await chainSend(chatKey, [segments], { ...opts, fingerprints: [fp] });
      if (!res.ok && res.sent.length === 0) throw new Error(res.failed[0]?.error ?? '媒体发送失败');
      return res;
    });
  }

  function clearChain(chatKey) { chains.delete(chatKey); }

  return { sendTextBatch, sendImage, sendSticker, sendSegments, poke, clearChain, _toFileUri: toFileUri };
}
