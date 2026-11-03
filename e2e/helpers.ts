import { expect, type Browser, type Page } from '@playwright/test';

export const ADMIN = 'http://127.0.0.1:18081';
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

/** 在新的浏览器上下文里以 userId 登录（两个上下文 = 两个用户互聊）。 */
export async function loginAs(browser: Browser, userId: string, path = '/login'): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(path);
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}
