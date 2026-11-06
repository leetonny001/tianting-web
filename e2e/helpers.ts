import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CALLER_ID, CALLER_SECRET } from './caller';
import { ADMIN, SERVER } from './ports';

export { ADMIN };
const ADMIN_KEY = 'dev-admin-key'; // 开发环境默认的旧密钥（测试模式，只在本机测试服务端上）

let n = 0;
/** 每个用例用不同的用户名，测试之间互不影响（同一个服务端实例）。 */
export const uid = (base: string) => `${base}${Date.now().toString(36)}${n++}`;

export async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(ADMIN + path, {
    method,
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

/** 调用方签名调用管理接口（protocol/ADMIN.md「鉴权」）：封禁、禁言、删除消息只接受这种方式。 */
export async function signed(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const toSign = ['POST', path, timestamp, nonce, hash, 'e2e', '', ''].join('\n');
  const res = await fetch(ADMIN + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IM-Caller': CALLER_ID,
      'X-IM-Timestamp': timestamp,
      'X-IM-Nonce': nonce,
      'X-IM-Operator': 'e2e',
      'X-IM-Signature': createHmac('sha256', CALLER_SECRET).update(toSign, 'utf8').digest('base64url'),
    },
    body: raw,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

/** 在新的浏览器上下文里以 userId 登录（两个上下文 = 两个用户互聊）。 */
export async function loginAs(
  browser: Browser,
  userId: string,
  path = '/login',
  options?: BrowserContextOptions,
): Promise<Page> {
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  await page.goto(path);
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

/** 宽屏（PRD-ui 2.1 节）：1280×800 且 (hover: hover) and (pointer: fine)。默认的项目是手机（Pixel 7，触屏）。 */
export const WIDE: BrowserContextOptions = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };

export const chatUrl = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
export const c2cId = (a: string, b: string) => (a < b ? `c2c:${a}:${b}` : `c2c:${b}:${a}`);

/** 让后面 fail 为 true 期间的 send 返回 code（PRD-ui 2.2 节：routeWebSocket 改写应答），其余帧原样转发。 */
export async function failSends(page: Page, code = 5000) {
  const state = { fail: true };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as { id?: string; cmd?: string };
      if (f.cmd === 'send' && state.fail) ws.send(JSON.stringify({ id: f.id, cmd: 'ack', error: { code, msg: 'x' } }));
      else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return state;
}

// ---- 账号（PRD-chat C1） ----

export const PASSWORD = 'correct-horse-9';
export const NEW_PASSWORD = 'battery-staple-7';

/** 发一个邀请码（F-ACC-09）。 */
export async function invite(maxUses = 1): Promise<string> {
  const r = (await signed('/admin/invites', { count: 1, maxUses, expiresAt: Date.now() + 30 * 86_400_000 })) as {
    invites: { code: string }[];
  };
  return r.invites[0]!.code;
}

export async function api(path: string, body?: unknown, token?: string, method = 'POST') {
  const res = await fetch(SERVER + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, never> };
}

export interface ApiUser {
  username: string;
  access: string;
  refresh: string;
  recoveryCode: string;
  gen: number;
}

/** 用接口注册一个账号。ack=false 时最新一代恢复码没有确认。 */
export async function apiRegister(base = 'acc', ack = true, platform = 'android'): Promise<ApiUser> {
  const username = uid(base).toLowerCase();
  const r = await api('/v1/account/register', {
    username,
    password: PASSWORD,
    inviteCode: await invite(),
    platform,
  });
  if (r.status !== 200) throw new Error(`register ${r.status} ${JSON.stringify(r.data)}`);
  const d = r.data as unknown as {
    accessToken: string;
    refreshToken: string;
    recoveryCode: string;
    recoveryCodeGen?: number;
  };
  // 注册响应可能不带代号（第一代）：确认用 1。
  const gen = d.recoveryCodeGen ?? 1;
  if (ack) {
    const a = await api('/v1/account/recovery-code/ack', { gen }, d.accessToken);
    if (a.status !== 200) throw new Error(`ack ${a.status} ${JSON.stringify(a.data)}`);
  }
  return { username, access: d.accessToken, refresh: d.refreshToken, recoveryCode: d.recoveryCode, gen };
}

/** 账号登录页登录（恢复码已确认的账号）。 */
export async function accountLogin(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login/account');
  await page.getByTestId('account-username').fill(username);
  await page.getByTestId('account-password').fill(password);
  await page.getByTestId('account-submit').click();
}

/** 在新上下文里账号登录，等到会话列表。 */
export async function accountPage(
  browser: Browser,
  username: string,
  options?: BrowserContextOptions,
  password = PASSWORD,
) {
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  await accountLogin(page, username, password);
  await expect(page).toHaveURL(/\/chats$/);
  return page;
}

/** 让 GET /v1/config 回这些字段（其他字段来自真实服务端的默认值）。 */
export async function fakeConfig(page: Page, over: Record<string, unknown>) {
  await page.route('**/v1/config', (route) =>
    route.fulfill({
      json: {
        registerMode: 'invite',
        demoLogin: false,
        features: { files: false },
        limits: {
          usernameMinLen: 4,
          usernameMaxLen: 32,
          passwordMinLen: 8,
          passwordMaxLen: 128,
          nicknameMaxLen: 32,
          deviceNameMaxLen: 64,
        },
        ...over,
      },
    }),
  );
}

export const storedSession = (page: Page) => page.evaluate(() => sessionStorage.getItem('tt.session'));

export const dateOf = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** "离线"：context.setOffline 不会断开已有的 WebSocket，所以记下存储里的会话，关掉页面，真的不在线。 */
export async function goOffline(page: Page): Promise<string> {
  const saved = (await storedSession(page))!;
  await page.context().close();
  return saved;
}

/** 重新上线：同一份存储打开应用。 */
export async function comeBack(browser: Browser, saved: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.evaluate((raw) => sessionStorage.setItem('tt.session', raw), saved);
  await page.goto('/chats');
  return page;
}
