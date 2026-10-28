// Keep the common group/private envelope; the non-numeric namespace is never a QQ ID.
export const DESKTOP_WECHAT_PREFIX = 'wxdesktop_';
export function isDesktopWechatKey(key) {
  return /^(group|private):wxdesktop_[a-f0-9]{32}_[a-f0-9]{32}$/.test(String(key || ''));
}
export function isDesktopWechatId(id) {
  return isDesktopWechatKey(`group:${id}`);
}
export function desktopWechatKey(accountId, roomId, kind = 'group') {
  const key = `${kind}:wxdesktop_${accountId}_${roomId}`;
  if (!isDesktopWechatKey(key)) throw new Error('微信会话标识无效');
  return key;
}
