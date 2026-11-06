// 设备偏好（PRD-ui F-UI-16 规则 3、F-UI-22）：只允许 ui.* 键，不是账号数据，退出登录也保留。
// 账号数据（token、消息、好友）一律不进 localStorage（D4）；ESLint 禁止在其他文件里直接用 localStorage。
// 例外一是 ui.noticeSeen.{userId}（NF-UI-13、PRD-live F-PUSH-12 规则 5）：值只有一个数字，不存内容，退出登录时删除。
// 例外二是 ui.privacyAck.{用户名的哈希}（PRD-chat F-ACC-10 规则 2）：值只有隐私说明的版本号，退出登录保留，否则每次登录都提示。
// ui.config 是 GET /v1/config 的缓存（F-ACC-07 规则 4），公开信息。
type UiKey = `ui.${string}`;

export function getPref(key: UiKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPref(key: UiKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等情况下写不进去：偏好只是锦上添花，忽略
  }
}

export function removePref(key: UiKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}
