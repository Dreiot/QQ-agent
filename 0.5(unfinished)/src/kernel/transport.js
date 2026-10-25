// 传输归一化模型：chatKey / segments / msg + segmentsToText（§2.3 占位表 + §6.2.5）。
// 内核不认识 QQ/OneBot 细节（DSH §3.1 模块 5 禁止项）——平台词只允许出现在 provider 里。
// segments 同时兼容 DSH 扁平段（{type:'text',text}）与 OneBot v11 原生段（{type,data:{...}}），
// provider 侧做原生→扁平的归一，这里统一消费扁平段。
export const PLACEHOLDER = {
  at_all: '@全体成员',
  face: (id) => `[表情${id}]`,
  image: '[图片]',
  record: '[语音]',
  recordTranscribed: (t) => `[语音转文字] ${t}`,
  video: '[视频]',
  file: (name) => `[文件${name ?? ''}]`,
  json: '[卡片消息]',
  forward: '[合并转发聊天记录]',
  forwardNested: '[转发消息]',
  unknown: (type) => `[${type}]`,
};

// chatKey 采用 0.4 两段式 `<kind>:<id>`（存量数据文件名 group_123.json 的直接来源，
// D-4 兼容生死线）；DSH §6.1 的三段式 `<platform>:<kind>:<id>` 由 parseChatKey 兼容读取。
// qq-agent 是 QQ 专用机器人（2026-10-04 决策：已删除「换平台」目标，qq-agent 定位为 QQ 专用）。
// 三段式读取能力保留即可，不为跨平台服务——它在这里只是 0.4 存量数据的兼容兜底。
// 换协议端（不同 OneBot 实现互替）走 provider，差异在 provider 内消化。
export function parseChatKey(chatKey) {
  const s = String(chatKey);
  const m3 = s.match(/^([a-z][a-z0-9_-]*):(group|private):(.+)$/i); // 三段式兼容
  if (m3) return { platform: m3[1].toLowerCase(), kind: m3[2], id: m3[3] };
  const m2 = s.match(/^(group|private):(.+)$/i); // 两段式（0.4 口径，主流）
  if (m2) return { platform: 'qq', kind: m2[1], id: m2[2] };
  return null;
}

export function makeChatKey(kind, id, platform = null) {
  // platform 缺省 = 两段式（0.4 口径，OneBot provider 主流）；
  // 显式传 platform 时产三段式（provider 隔离场景预留，当前无生产者）。
  return platform ? `${platform}:${kind}:${id}` : `${kind}:${id}`;
}

// 提示注入主防线（notes/06b §10.2 / util.js:64-69）：用户文本里伪装成系统段的 [xxx]
// 方括号标记弱化为圆括号——只处理外观不改语义。
const INJECTION_MARKER_RE = /\[(未读信息|已读信息|新已读信息|新加入成员|本次唤醒|过去状态|系统|管理员|owner| Owner|OWNER|角色扮演|会话令牌|当前时间)[^\]]*\]/gi;
export function sanitizeUserText(text) {
  if (!text) return text;
  return String(text).replace(INJECTION_MARKER_RE, (m) => `(${m.slice(1, -1)})`);
}

// 发送侧 CQ 转义（util.js:56-57）：[CQ: → [CQ：全角，防 OneBot 网关把用户文本误解析成 CQ 码。
export function escapeCqText(text) {
  if (!text) return text;
  return String(text).replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 归一化段 → 纯文本 + atMarks。
 * notes/06b §4.3 占位表逐条对应。
 * @param segments DSH 扁平段数组
 * @param opts { transcribe?: async (seg) => string|null, atNameCache?: Map<id,name>, resolveAtName?: async (id) => string|null }
 *   transcribe：media.transcribe 能力（语音转文字；失败返回 null → [语音] 占位）
 *   atNameCache：@ 群名片解析缓存（provider 提供；命中失败回落 @QQ号）
 * @returns { text, atMarks: string[]（@ 段的 QQ 号，'all' 保留）, atNames: string[]（@ 片段原文，≤20） }
 */
export async function segmentsToText(segments, opts = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { text: '', atMarks: [], atNames: [] };
  }
  // 兼容 OneBot v11 原生 {type, data} 段 → 归一成扁平段
  const flat = segments.map((s) => {
    if (s && typeof s === 'object' && s.data && typeof s.data === 'object' && !('text' in s || 'id' in s || 'url' in s || 'file' in s || 'name' in s || 'data' in s && typeof s.data !== 'object')) {
      const d = s.data;
      switch (s.type) {
        case 'text': return { type: 'text', text: d.text ?? '' };
        case 'at': return { type: 'at', id: d.qq ?? '' };
        case 'face': return { type: 'face', id: d.id };
        case 'image': return { type: 'image', url: d.url, file: d.file, summary: d.summary };
        case 'record': return { type: 'record', url: d.url, file: d.file };
        case 'video': return { type: 'video', url: d.url, file: d.file };
        case 'file': return { type: 'file', name: d.name ?? d.file, url: d.url };
        case 'json': return { type: 'json', data: d.data };
        case 'forward': return { type: 'forward', id: d.id };
        case 'reply': return { type: 'reply', id: d.id };
        default: return { type: s.type };
      }
    }
    return s;
  });

  const parts = [];
  const atMarks = [];
  const atNames = [];
  for (const seg of flat) {
    if (!seg || typeof seg !== 'object') continue;
    switch (seg.type) {
      case 'text':
        parts.push(String(seg.text ?? ''));
        break;
      case 'at': {
        const id = String(seg.id ?? '');
        atMarks.push(id); // 'all' 保留原样——判定层自己排除（§6.2.8）
        let label;
        if (id === 'all') {
          label = PLACEHOLDER.at_all;
        } else {
          const cached = opts.atNameCache?.get(id);
          let name = cached;
          if (name == null && typeof opts.resolveAtName === 'function') {
            try { name = await opts.resolveAtName(id); } catch { /* unavailable names retain the QQ id */ }
          }
          label = `@${name ?? id}`;
        }
        parts.push(label);
        if (atNames.length < 20) atNames.push(label);
        break;
      }
      case 'face':
        parts.push(PLACEHOLDER.face(seg.id));
        break;
      case 'image':
        parts.push(PLACEHOLDER.image);
        break;
      case 'record': {
        let transcribed = null;
        if (typeof opts.transcribe === 'function') {
          try { transcribed = await opts.transcribe(seg); } catch { transcribed = null; }
        }
        parts.push(transcribed ? PLACEHOLDER.recordTranscribed(transcribed) : PLACEHOLDER.record);
        break;
      }
      case 'video':
        parts.push(PLACEHOLDER.video);
        break;
      case 'file':
        parts.push(PLACEHOLDER.file(seg.name));
        break;
      case 'json':
        parts.push(PLACEHOLDER.json);
        break;
      case 'forward':
        parts.push(PLACEHOLDER.forward);
        break;
      case 'reply':
        // reply 段在段数组里通常只有 id——[引用 …] 的原文渲染由 ingest 层
        // （拿 reply 摘要后）完成；段级渲染保底 [引用消息]
        parts.push(seg.sender || seg.text ? `[引用 ${[seg.sender, seg.text].filter(Boolean).join('：')}]` : '[引用消息]');
        break;
      default:
        parts.push(PLACEHOLDER.unknown(seg.type));
    }
  }
  return { text: sanitizeUserText(parts.join('')), atMarks, atNames };
}

// 撤回/拍一拍等事件在存档层的文本化（事件 → 占位消息）
export const POKE_TEXT = (operatorName, operatorId, targetName, targetId) =>
  `[拍一拍] ${operatorName}(QQ:${operatorId}) 拍了拍 ${targetName}(QQ:${targetId})`;
