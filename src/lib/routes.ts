// 路由表（PRD-ui 3.2 节）与登录回跳地址校验（F-UI-01 规则 3、R-UI-13）。
export const ROUTE_PATTERNS = [
  '/login',
  '/chats',
  '/chat/:convId',
  '/chat/:convId/info',
  '/chat/:convId/notice',
  '/chat/:convId/members',
  '/chat/:convId/invite',
  '/groups/new',
  '/contacts',
  '/contacts/requests',
  '/contacts/groups',
  '/contacts/add',
  '/contacts/apply/:userId',
  '/user/:userId',
  '/user/:userId/remark',
  '/me',
  '/me/settings',
  '/me/settings/blocks',
  '/me/settings/privacy',
  '/me/settings/appearance',
] as const;

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const s = path.split('/');
  return p.length === s.length && p.every((seg, i) => (seg.startsWith(':') ? s[i] !== '' : seg === s[i]));
}

/**
 * 只接受站内路径：以单个 / 开头、第二个字符不是 / 或 \、第一个 / 之前没有协议，且必须匹配路由表；
 * 否则回到 /chats。防止 /login?redirect=//evil.com 这类开放重定向。
 */
export function safeRedirect(raw: string | null): string {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\' || raw.includes('\\')) return '/chats';
  const path = raw.split(/[?#]/)[0]!;
  if (path === '/login') return '/chats';
  return ROUTE_PATTERNS.some((p) => matches(p, path)) ? raw : '/chats';
}

export const chatPath = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
