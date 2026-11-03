// 登录凭证只放 sessionStorage（PRD-core 第 5 节"刷新行为"、D4）：每个标签页独立，方便同一浏览器开两个标签页演示互聊；
// 关闭标签页即失效。token 不进 URL、不进日志（C-52）。
const KEY = 'tt.session';

export interface Session {
  userId: string;
  token: string;
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return typeof s.userId === 'string' && typeof s.token === 'string' ? { userId: s.userId, token: s.token } : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}
