/** Stable, secret-free DTO serializers for console APIs. */
export function serializeStatus({ version, dataDir, uptimeMs, orchestrator, onebot, usage, loader, cfg = () => ({}) }) { const c=cfg(); return {version,dataDir,uptimeMs,paused:!!orchestrator?.paused,pauseReason:c.pauseReason??null,onebot:{connected:!!onebot?.connected,selfId:onebot?.selfId??null,diagnosis:onebot?.diagnosis??null},orchestrator:orchestrator??{},usage:usage??{},cost:null,cacheHitRate:usage?.totalTokens?(usage.cachedTokens??0)/usage.totalTokens:0,plugins:loader?.length??0}; }
export function serializeSessionSummary(s) { if(!s)return null; const out={...s}; delete out.messages; return out; }
export function serializeSessionDetail(s) { return s ? structuredClone(s) : null; }
export const serializeSession=serializeSessionSummary;
export function serializeChat(c) {
  const chatKey = c.chatKey ?? c.key ?? '';
  const key = c.key && /^(group|private)_\d+$/.test(String(c.key))
    ? String(c.key)
    : String(chatKey).replace(/^(group|private):(\d+)$/, '$1_$2');
  return { key, chatKey, total: c.count ?? c.total ?? 0, unread: c.unread ?? 0, lastTs: c.lastActive ?? c.lastTs ?? 0, lastText: c.lastText ?? '', chatName: c.chatName ?? '' };
}
const SECRET_SETTING_RE = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i;

function secretSetting(key, schema) {
  const rule = schema?.[key];
  return SECRET_SETTING_RE.test(key) || rule?.secret === true || rule?.sensitive === true || rule?.format === 'password';
}

function maskedSettings(settings, schema) {
  const out = {};
  for (const key of Object.keys(schema && typeof schema === 'object' ? schema : {})) {
    const value = settings?.[key];
    if (secretSetting(key, schema)) out[key] = value ? '******' : '';
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

export function serializeSkill(e) {
  const schema = e.configSchema && typeof e.configSchema === 'object' ? structuredClone(e.configSchema) : {};
  return {
    id: e.id, name: e.name, version: e.version, kind: e.kind,
    description: e.description ?? '', update: e.update ? structuredClone(e.update) : null, updateError: e.updateError ?? null,
    loaded: e.status === 'active', enabled: !!e.enabled,
    available: !['unmet', 'error'].includes(e.status), active: e.status === 'active',
    code: e.status, reason: e.loadError ?? null,
    lastError: e.lastError ?? null, lastErrorAt: e.lastErrorAt ?? null,
    settings: maskedSettings(e.settings, schema), configSchema: schema,
    requires: Array.isArray(e.requires) ? [...e.requires] : [], toolIds: e.tools ?? [],
    root: e.root ?? null, dir: typeof e.dir === 'string' ? e.dir : null, fingerprint: e.fingerprint ?? null,
    permissions: Array.isArray(e.permissions) ? [...e.permissions] : [],
  };
}
