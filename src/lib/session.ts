import type { AccountSession, SessionStore } from '@tianting/sdk';

// 登录凭证只放 sessionStorage（PRD-core 第 5 节"刷新行为"、D4、PRD-chat CH-26）：每个标签页独立，方便同一浏览器开两个标签页演示互聊；
// 关闭标签页后要重新登录。token 不进 URL、不进日志（C-52）。
const KEY = 'tt.session';

/** 演示会话。老版本留下的 {userId, token} 没有 mode，也按演示处理（R-CF-11）。 */
export interface Session {
  userId: string;
  token: string;
}

function read(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  const s = read();
  if (!s || s.mode === 'account') return null;
  return typeof s.userId === 'string' && typeof s.token === 'string' ? { userId: s.userId, token: s.token } : null;
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 存储不可用时本来也没有写进去
  }
}

/** 存储里的账号会话。字段不全的按没有，不把半条数据交给 SDK。 */
export function loadAccountSession(): AccountSession | null {
  const s = read();
  if (!s || s.mode !== 'account') return null;
  if (typeof s.userId !== 'string' || typeof s.accessToken !== 'string' || typeof s.accessExpiresAt !== 'number') {
    return null;
  }
  return s as unknown as AccountSession;
}

/**
 * 账号会话的存储（F-ACC-03 规则 8）。什么时候写由 SDK 决定：确认恢复码之前 SDK 不调 save（F-ACC-05 规则 1，问题 S4），
 * 页面不要绕过它自己写。detach 之后这个实例不再碰存储：退出时界面不等 logout 返回，新登录的 token 不能被旧实例清掉。
 */
export function createSessionStore(): SessionStore & { detach(): void } {
  let attached = true;
  return {
    load: () => (attached ? loadAccountSession() : null),
    save: (s) => {
      if (attached) sessionStorage.setItem(KEY, JSON.stringify(s));
    },
    clear: () => {
      if (attached) clearSession();
    },
    detach: () => {
      attached = false;
    },
  };
}
