// 类型化配置仓：DEFAULT_CONFIG 全量键表 + 读取链（BOM/损坏备份/迁移/废弃键/deepMerge）
// + 写回链（派生标记剥离/密钥保留/滑条派生/原子写）。
// 出处：SPEC §5.0 机制、§5.1 全量键表、notes/05-config-contracts.md（C-* 行为契约）。
// 滑条唯一真相：store.contextSliderPos 缺省 = 100 = 4 档（U-01 终论：显式默认，有意语义）。
import fs from 'node:fs';
import path from 'node:path';
import { buildSearchProviderDefaults } from '../../bundled/web-tools/search-policy.js';

export const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i;
export const SECRET_KEY_EXCLUDE = /from$/i; // apiKeyFrom 是来源标识不是密钥（SPEC §5.2）
const DERIVED_FLAG_RE = /^has[A-Z][A-Za-z0-9]*$/; // SPEC §17.2：派生标记剔除

// 废弃键（loadConfig/updateConfig 时剔除；SPEC §5.1 api.* 废弃键表）
const OBSOLETE = [
  ['api', 'stream'], ['api', 'priceRemoteUrl'], ['budget'], ['providersImported'],
  ['store', 'atCount'], ['store', 'keywordCount'], ['store', 'randomCount'], ['store', 'allCount'],
  ['store', 'peakSchedule', 'valley', 'start'], ['store', 'peakSchedule', 'valley', 'end'],
  ['store', 'peakSchedule', 'custom', 'valley', 'start'], ['store', 'peakSchedule', 'custom', 'valley', 'end'],
];

// 旧字段迁移（表驱动幂等：目标键已存在则跳过；SPEC §5.1 迁移键）
const LEGACY_MIGRATIONS = [
  { from: ['tools', 'knowledgeEnabled'], to: ['skills', 'knowledge-base', 'enabled'] },
  { from: ['tools', 'videoEnabled'], to: ['skills', 'video-frames', 'enabled'] },
  { from: ['tools', 'stickerAnnotate'], to: ['skills', 'sticker-annotate', 'enabled'] },
];

export function buildDefaultConfig({ portOffset = 0, personaText = '' } = {}) {
  return {
    api: {
      baseUrl: '', apiKey: '', model: '', provider: '',
      fallbackModels: [], visionModel: '', videoModel: '', visionProvider: '', videoProvider: '',
      videoMode: 'auto', vision: true, video: false,
      temperature: 0.8, maxRounds: 12, timeoutMs: 180000,
      thinkingMode: 'auto', thinkingEffort: '', thinkingBudget: 0,
      priceInputPerM: 0, priceOutputPerM: 0, priceCachedPerM: 0,
      useOfficialPrice: true, modelPrices: {},
    },
    management:{version:1,rules:[]},
    providers: [],
    dshProviderKeys: {},
    providersSourceYaml: '',
    webSearch: {
      enabled: true, searchUrl: 'https://cn.bing.com/search', maxResults: 6, provider: 'bing',
      ...buildSearchProviderDefaults(),
      providers: [],
      custom: { name: '', type: 'openai', baseUrl: '', apiKey: '', model: '', count: 0, timeoutMs: 0 },
    },
    security: {
      allowPrivateImageHosts: false,
      browseLock: { enabled: false, hosts: [], siteSearchUrl: '' },
      imageSend: { requirePreview: true, maxPerRun: 3, maxPreviewsPerRun: 5, maxBytesMB: 5 },
    },
    onebot: {
      wsUrl: `ws://127.0.0.1:${3001 + portOffset}`,
      httpUrl: `http://127.0.0.1:${3000 + portOffset}`,
      accessToken: '', httpAccessToken: '',
    },
    localProtocols: { selectedId: '', account: '', autoStart: false, deferConnection: false },
    persona: {
      botName: '小鲸鱼', selfNickname: '',
      roleText: personaText,           // 默认 = 出厂人设全文（SPEC §17.4，逐字复刻）
      participation: 'medium', customRules: '', systemPromptOverride: '',
    },
    customPersonas: [], personaByChat: {}, personaUnified: true,
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}, globalBlocklist: [], communityExemptions: [],
    wakeDelayMs: 2000, drainDelayMs: 1200, maxConcurrentRuns: 2, sessionRetryAttempts: 2,
    send: {
      minGapMs: 1000, maxGapMs: 3000, byLengthMs: 20,
      maxPerMinute: 80, maxPerHour: 500, hardSplitAt: 4000, dedupeWindowMs: 8000,
    },
    proactive: {
      enabled: false, checkIntervalMinMs: 1800000, checkIntervalMaxMs: 5400000,
      idleThresholdMs: 1800000, probability: 0.25,
    },
    chatActive: { enabled: false, ttlMinutes: 30 },
    sticker: {
      enabled: true, promptMaxStickers: 10, collectEnabled: true, maxCollectPerHour: 10, encourage: 1,
    },
    store: {
      maxMessagesPerChat: 0,
      // 注意：contextSliderPos 不设默认键 —— 缺省经 clampSliderPos 回 100 = 4 档（U-01 终论，SPEC §5.1）
      contextTier: 4, historyCount: 80, keywords: [], randomPercent: 10,
      promptAnchor: { enabled: true, maxExtraRead: 5 },
      unifiedTier: true, groupSliderPos: {}, groupPeakPos: {},
      keepSessionFiles: 0,
      peakSchedule: {
        enabled: false,
        peak: { start: '09:00', end: '18:00', sliderPos: 10 },
        valley: { sliderPos: 100 },   // 只认 sliderPos；start/end 已废弃剔除（R-21）
      },
    },
    commandMute: { enabled: true, command: '/安静', durationMin: 30, active: {} },
    memory: {
      consolidateEnabled: true, consolidateMinIntervalMs: 21600000, useChatModel: true,
      provider: '', model: '', maxImpressionsPerMember: 5,
      consolidateMinImpressions: 4, discoverMinMessages: 20, discoverMaxMembers: 3,
    },
    tools: {
      enabled: true, overrides: {}, crossChatSend: false,
      categories: { messaging: true, sticker: true, query: true, memory: true, web: true, knowledge: true, media: true, system: true },
    },
    skills: {},
    extensions: { hotReload: true, providers: {} },
    server: {
      port: 3210 + portOffset,   // env QQ_AGENT_PORT 优先（SPEC §5.1）；PROFILE 偏移已并入
      token: '', autoStart: false, closeToTray: true,
    },
    ui: { theme: 'dark', showVision: true, refreshMs: 15000, listWidth: 288 },
  };
}

// 深合并语义（SPEC §5.0）：对象递归；数组整体替换；{ __replace__: X } = 直接用 X 不递归。
export function deepMerge(base, patch) {
  if (patch && typeof patch === 'object' && !Array.isArray(patch) && Object.hasOwn(patch, '__replace__')) {
    return patch.__replace__;
  }
  if (Array.isArray(base) || Array.isArray(patch)) return patch; // 数组整体替换
  if (!patch || typeof patch !== 'object' || !base || typeof base !== 'object') return patch ?? base;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}

export function clampSliderPos(pos) {
  const n = typeof pos === 'number' && Number.isFinite(pos) ? pos : 100; // U-01：缺省 = 100 = 4 档
  return Math.max(0, Math.min(100, n));
}

// 滑条 → 档位换算（notes/05 C-store-01）：0-10=1 档仅艾特 / 10-20=2 档+关键词 /
// 20-90=3 档概率线性 0→100% / 90-100=4 档全响应。档位与概率永远由后端派生。
export function sliderToTier(pos) {
  const p = clampSliderPos(pos);
  if (p <= 10) return { contextTier: 1, randomPercent: 10 };
  if (p <= 20) return { contextTier: 2, randomPercent: 10 };
  if (p < 90) return { contextTier: 3, randomPercent: Math.round(((p - 20) / 70) * 100) };
  return { contextTier: 4, randomPercent: 100 };
}

function stripObsolete(obj) {
  for (const pathArr of OBSOLETE) {
    let cur = obj;
    let ok = true;
    for (let i = 0; i < pathArr.length - 1; i++) {
      cur = cur[pathArr[i]];
      if (!cur || typeof cur !== 'object') { ok = false; break; }
    }
    if (ok && cur && typeof cur === 'object') delete cur[pathArr[pathArr.length - 1]];
  }
  return obj;
}

function getPath(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (!cur[pathArr[i]] || typeof cur[pathArr[i]] !== 'object') cur[pathArr[i]] = {};
    cur = cur[pathArr[i]];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

// 表驱动幂等迁移：目标键已存在则跳过（SPEC §5.0 migrateLegacySkills）
function migrateLegacySkills(cfg) {
  for (const m of LEGACY_MIGRATIONS) {
    const fromVal = getPath(cfg, m.from);
    if (fromVal === undefined) continue;
    if (getPath(cfg, m.to) === undefined) setPath(cfg, m.to, fromVal);
  }
  // api.thinking(bool) → api.thinkingMode('on'/'off')
  if (typeof cfg.api?.thinking === 'boolean') {
    if (cfg.api.thinkingMode === undefined || cfg.api.thinkingMode === 'auto') {
      cfg.api.thinkingMode = cfg.api.thinking ? 'on' : 'off';
    }
    delete cfg.api.thinking;
  }
  return cfg;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // Windows 编辑器默认写 BOM（SPEC §7.1）
}

export function createConfig({ dataDir, defaults, log = console }) {
  const file = path.join(dataDir, 'config.json');
  let data = structuredClone(defaults);
  const listeners = new Set();

  function load() {
    let parsed = null;
    if (fs.existsSync(file)) {
      try {
        parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        // 损坏兜底（SPEC §5.0，事故注释：曾静默回默认后被云端名单整体写回抹掉用户 Key/白名单）
        // → 先改名备份，再沿用内存值（首次加载是默认值）；不改变后续保存合同。
        // JSON.parse/文件系统的 message 可能含配置片段或路径，只记录错误类别。
        const errorCode = error => /^E[A-Z0-9]{1,30}$/.test(error?.code ?? '') ? error.code : '未知错误';
        const reason = err instanceof SyntaxError ? 'JSON 语法错误' : `读取错误 ${errorCode(err)}`;
        let backup, backedUp = false, backupError;
        try {
          const base = path.join(dataDir, `config.json.corrupt-${Date.now()}`);
          backup = base;
          for (let suffix = 1; fs.existsSync(backup); suffix++) backup = `${base}-${suffix}`;
          fs.renameSync(file, backup);
          backedUp = true;
        } catch (error) { backupError = error; }
        const fallback = '本次继续使用内存配置（首次加载为默认配置）；后续保存会覆盖全量 config.json';
        if (backedUp) {
          log.warn(`config.json 读取或解析失败（${reason}），已备份到 ${path.basename(backup)}；${fallback}。请尽快从备份恢复配置。`);
        } else {
          const original = fs.existsSync(file) ? '原 config.json 仍在原位，未改写' : '未能确认原 config.json 仍在原位';
          log.warn(`config.json 读取或解析失败（${reason}），备份失败（${errorCode(backupError)}）；${original}；${fallback}。请先检查并手动保留原件。`);
        }
        parsed = null;
      }
    }
    if (parsed) {
      migrateLegacySkills(parsed);
      stripObsolete(parsed);
      data = deepMerge(structuredClone(defaults), parsed);
    }
    return data;
  }

  // 密钥回填：脱敏端点只回传 hasXxx 不回传真值，前端展开回传时不能把真 Key 抹掉。
  // 数组型密钥容器（providers[]）按 id 回填缺 apiKey 的条目；显式传空串 = 真清除（SPEC §5.0）。
  function preserveSanitizedSecrets(current, patch) {
    const curProviders = current.providers ?? [];
    if (Array.isArray(patch.providers)) {
      for (const p of patch.providers) {
        if (p && p.id != null && (p.apiKey === undefined || p.apiKey === null)) {
          const old = curProviders.find((x) => x && x.id === p.id);
          if (old && old.apiKey) p.apiKey = old.apiKey;
        }
      }
    }
    const curKeys = current.dshProviderKeys ?? {};
    if (patch.dshProviderKeys && typeof patch.dshProviderKeys === 'object' && !Array.isArray(patch.dshProviderKeys)) {
      for (const id of Object.keys(patch.dshProviderKeys)) {
        if (patch.dshProviderKeys[id] == null && curKeys[id]) patch.dshProviderKeys[id] = curKeys[id];
      }
    }
    // 标量密钥：GET 脱敏时字段被删（不是置空串），回传对象里没有该键 → deepMerge 保住现值，无需处理。
  }

  function update(patch, preserveRaw = false) {
    // ① 剥派生标记（/^has[A-Z]/，防前端回传写进磁盘，SPEC §5.0）
    if (!preserveRaw) stripDerivedFlags(patch);
    // ② 剔除废弃键
    if (patch && typeof patch === 'object') stripObsolete(patch);
    // ③ 密钥保留
    preserveSanitizedSecrets(data, patch);
    // ④ merge
    const next = deepMerge(structuredClone(data), patch);
    // ⑤ 滑条换算：contextSliderPos 是档位唯一真相；接口直改 tier/randomPercent 不生效（C-store-01）
    if (patch?.store && typeof patch.store === 'object') {
      if (Object.hasOwn(patch.store, 'contextSliderPos')) {
        const derived = sliderToTier(clampSliderPos(patch.store.contextSliderPos));
        next.store.contextSliderPos = clampSliderPos(patch.store.contextSliderPos);
        next.store.contextTier = derived.contextTier;
        next.store.randomPercent = derived.randomPercent;
      } else if (Object.hasOwn(patch.store, 'contextTier') || Object.hasOwn(patch.store, 'randomPercent')) {
        // 直改派生值 → 还原为现配置值（updateConfig 只认 sliderPos）
        const prev = sliderToTier(clampSliderPos(next.store.contextSliderPos));
        next.store.contextTier = prev.contextTier;
        next.store.randomPercent = prev.randomPercent;
      }
    }
    // ⑥ 原子写（.tmp → rename）
    save(next);
    data = next;
    for (const fn of listeners) { try { fn(data); } catch (e) { log.error?.(`config onChange 异常：${e}`); } }
    return data;
  }

  function save(candidate = data) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2), 'utf8'); // 2 空格缩进（SPEC §5.0）
    fs.renameSync(tmp, file);
  }

  function reset() {
    const next = structuredClone(defaults);
    save(next);
    data = next;
    for (const fn of listeners) { try { fn(data); } catch (e) { log.error?.(`config onChange 异常：${e}`); } }
    return data;
  }

  return {
    load,
    get: () => data,
    update,
    // Host-only raw-field transaction; SDK facets expose their own narrow
    // methods. Keep historical values intact without weakening normal writes.
    updateRawFields(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['blocklist', 'globalBlocklist', 'communityExemptions'].includes(key))) throw new TypeError('原始名单事务仅允许名单字段');
      return update(structuredClone(patch), true);
    },
    reset,
    file,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export function stripDerivedFlags(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    if (DERIVED_FLAG_RE.test(k)) delete obj[k];
    else if (obj[k] && typeof obj[k] === 'object') stripDerivedFlags(obj[k]);
  }
  return obj;
}

// GET /api/config 脱敏（SPEC §5.2）：命中就删除字段（不能置空串——回传时会覆盖真 Key），
// 补 hasXxx 布尔；hasXxx 本身会被 pattern 命中，需防护连锁生成 hasHasXxx。
export function sanitizeConfigForApi(cfg) {
  const out = structuredClone(cfg);
  const protect = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (SECRET_KEY_PATTERN.test(k) && !SECRET_KEY_EXCLUDE.test(k) && !DERIVED_FLAG_RE.test(k)) {
        const flag = 'has' + k[0].toUpperCase() + k.slice(1);
        if (typeof v === 'string' && v.length > 0) {
          delete node[k];
          node[flag] = true;
          protect.add(flag);
        } else {
          delete node[k];
          node[flag] = false;
          protect.add(flag);
        }
      } else if (v && typeof v === 'object') walk(v);
    }
  })(out);
  if (out.dshProviderKeys) {
    out.dshProviderKeyPresence = Object.fromEntries(
      Object.entries(out.dshProviderKeys).map(([id, v]) => [id, Boolean(v)])
    );
    out.dshProviderKeys = {};
  }
  return out;
}
