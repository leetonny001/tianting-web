import { expect, type Browser, type Page } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CALLER_ID, CALLER_SECRET } from './caller';

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
export async function loginAs(browser: Browser, userId: string, path = '/login'): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(path);
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}
