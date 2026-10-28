// Icon preferences contain image data or a built-in symbol name, never markup.
export const ICON_LABELS = Object.freeze({rules:'规则',sessions:'会话',chats:'聊天',memory:'记忆',usage:'用量',skills:'技能',plugins:'插件',logs:'应用日志',settings:'设置',community:'我的 / 账号',model:'模型',shield:'安全',globe:'网络',smile:'表情',panel:'面板',activity:'活动',menu:'菜单',arrow:'向右', 'arrow-up':'向上','arrow-down':'向下',chevron:'展开',check:'勾选',close:'关闭',search:'搜索',refresh:'刷新',undo:'撤销',plus:'添加',qrcode:'二维码',trash:'删除',pause:'暂停',play:'运行',upload:'上传',folder:'文件夹',link:'连接',copy:'复制',save:'保存',info:'说明',warning:'警告',clock:'时间',loading:'加载中',sun:'亮色',moon:'暗色',contrast:'外观',emblem:'左上角图标',archive:'存档','status-onebot-ready':'QQ 已连接','status-onebot-pending':'QQ 未连接','status-model-ready':'模型已配置','status-model-pending':'模型未配置'});
export const ICON_IMAGE_LIMIT = 192 * 1024;
export function safeIconImage(value) {
  if (typeof value !== 'string' || value.length > ICON_IMAGE_LIMIT) return '';
  const match = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return '';
  try {
    const bytes = atob(match[2]);
    if (match[1] === 'svg+xml') {
      if (!/<svg[\s>]/i.test(bytes) || /<(?:script|foreignObject|image|use|a|style|animate\w*|set)\b|<!|[&\\]|\bon\w+\s*=|\bstyle\s*=|(?:href|src)\s*=|url\(\s*[^#]|javascript:|data:/i.test(bytes)) return '';
    } else if (!(match[1] === 'png' && bytes.startsWith('\x89PNG\r\n\x1a\n') || match[1] === 'jpeg' && bytes.startsWith('\xff\xd8\xff') || match[1] === 'gif' && /^GIF8[79]a/.test(bytes) || match[1] === 'webp' && bytes.startsWith('RIFF') && bytes.slice(8,12) === 'WEBP')) return '';
    return value;
  } catch { return ''; }
}
export function normalizeIconOverrides(input) {
  const out = {}; let bytes = 0;
  for (const name of Object.keys(ICON_LABELS)) {
    const value = input?.[name];
    if (Object.hasOwn(ICON_LABELS, value?.glyph) && value.glyph !== name) out[name] = {glyph:value.glyph};
    else {
      const image = safeIconImage(value?.image);
      if (image && (bytes += image.length) <= 512 * 1024) out[name] = {image};
    }
  }
  return out;
}
