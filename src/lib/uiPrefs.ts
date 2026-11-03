// 设备偏好（PRD-ui F-UI-16 规则 3、F-UI-22）：只允许 ui.* 键，不是账号数据，退出登录也保留。
// 账号数据（token、消息、好友）一律不进 localStorage（D4）；ESLint 禁止在其他文件里直接用 localStorage。
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
