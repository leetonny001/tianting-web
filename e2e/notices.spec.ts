// 系统通知 × 真实 im-server（IM_PUSH_ENABLED=1）：PRD-ui F-UI-44、NF-UI-13，PRD-live F-PUSH-12。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { admin, loginAs, signed, uid, WIDE } from './helpers';

// 这里开的上下文用完就关：页面留着会一直占 CPU（连接、定时器），拖慢后面 social.spec.ts 的性能用例（AC-SOC-06-14）。
let openBefore = new Set<BrowserContext>();
test.beforeEach(({ browser }) => {
  openBefore = new Set(browser.contexts());
});
test.afterEach(async ({ browser }) => {
  await Promise.all(
    browser
      .contexts()
      .filter((c) => !openBefore.has(c))
      .map((c) => c.close()),
  );
});

const keyOf = (u: string) => `ui.noticeSeen.${u}`;
const seen = (p: Page, u: string) => p.evaluate((k) => localStorage.getItem(k), keyOf(u));

async function pushTo(userId: string, text: string, extra: Record<string, unknown> = {}) {
  const pushId = randomUUID();
  await signed('/admin/push', { target: 'user', userIds: [userId], type: 'notice', data: { text }, pushId, ...extra });
  return pushId;
}

/** 新标签页（同一个上下文，sessionStorage 独立、localStorage 共享）登录：相当于关掉标签页再打开。 */
async function reopen(ctx: BrowserContext, u: string, path = '/login') {
  const page = await ctx.newPage();
  await page.goto(path);
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

async function me(page: Page) {
  await page.goto('/me');
  await expect(page.getByTestId('me-notices')).toBeVisible();
}

/** 等第一轮补拉结束（基线写入 localStorage）。 */
const synced = (page: Page, u: string) => expect.poll(() => seen(page, u)).not.toBeNull();

async function newUser(browser: Browser) {
  const u = uid('n');
  await admin('POST', '/admin/users/import', { users: [{ userId: u }] });
  const page = await loginAs(browser, u);
  await synced(page, u);
  return { u, page };
}

test('在线收到：3 秒内横幅，5 秒后消失，进列表，入口计 1；点横幅进页面并清零（AC-UI-44-1、AC-ADM-50-1）', async ({
  browser,
}) => {
  const { u, page } = await newUser(browser);
  await me(page);
  await synced(page, u);
  await pushTo(u, '今晚 22 点维护');
  const banner = page.getByTestId('notice-banner');
  await expect(banner).toHaveText('系统通知：今晚 22 点维护', { timeout: 3_000 });
  await expect(page.getByTestId('me-notices-count')).toHaveText('1');
  await expect(banner).toBeHidden({ timeout: 6_000 });

  await pushTo(u, '第二条');
  await expect(banner).toHaveText('系统通知：第二条', { timeout: 3_000 });
  await expect(page.getByTestId('me-notices-count')).toHaveText('2');
  await banner.click();
  await expect(page).toHaveURL(/\/me\/notices$/);
  await expect(page.getByTestId('notice-item')).toHaveCount(2);
  await expect(page.getByTestId('notice-item').first()).toContainText('第二条');
  await expect.poll(() => seen(page, u)).toBe('2');
  await page.getByLabel('返回').click();
  await expect(page.getByTestId('me-notices-count')).toHaveCount(0);
});

test('关闭标签页期间的 3 条：再登录未查看 3，不弹横幅；打开清零；刷新后列表还在、不提醒、未查看 0（AC-PUSH-12-4）', async ({
  browser,
}) => {
  const { u, page } = await newUser(browser);
  await page.goto('/me/notices');
  await synced(page, u);
  const ctx = page.context();
  await page.close();
  for (const t of ['一', '二', '三']) await pushTo(u, `离线${t}`);

  const p2 = await reopen(ctx, u, `/login?redirect=${encodeURIComponent('/me')}`);
  await expect(p2.getByTestId('me-notices-count')).toHaveText('3');
  await expect(p2.getByTestId('notice-banner')).toHaveCount(0);
  await p2.getByTestId('me-notices').click();
  await expect(p2.getByTestId('notice-item')).toHaveCount(3);
  await expect(p2.getByTestId('notice-item').first()).toContainText('离线三');
  await expect.poll(() => seen(p2, u)).toBe('3');

  await p2.reload();
  await expect(p2.getByTestId('notice-item')).toHaveCount(3);
  await p2.waitForTimeout(500);
  await expect(p2.getByTestId('notice-banner')).toHaveCount(0);
  await p2.getByLabel('返回').click();
  await expect(p2.getByTestId('me-notices')).toBeVisible();
  await expect(p2.getByTestId('me-notices-count')).toHaveCount(0);

  // 在入口页刷新同样不重复提醒。
  await p2.reload();
  await expect(p2.getByTestId('me-notices')).toBeVisible();
  await p2.waitForTimeout(500);
  await expect(p2.getByTestId('me-notices-count')).toHaveCount(0);
  await expect(p2.getByTestId('notice-banner')).toHaveCount(0);
});

test('退出登录删除 ui.noticeSeen，其他偏好保留；再登录只回放不计数（AC-PUSH-12-6、L-18）', async ({ browser }) => {
  const { u, page } = await newUser(browser);
  await page.evaluate(() => localStorage.setItem('ui.theme', 'light'));
  await pushTo(u, '退出前的通知');
  await expect(page.getByTestId('notice-banner')).toBeVisible({ timeout: 3_000 });
  await page.goto('/me/notices');
  await expect.poll(() => seen(page, u)).toBe('1');

  await page.goto('/me/settings');
  await page.getByTestId('logout').click();
  await page.getByTestId('logout-dialog').getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => seen(page, u)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('ui.theme'))).toBe('light');

  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  await expect.poll(() => seen(page, u)).toBe('1');
  await page.goto('/me');
  await expect(page.getByTestId('me-notices')).toBeVisible();
  await expect(page.getByTestId('me-notices-count')).toHaveCount(0);
});

test('被踢后不删键，重新登录不重复提醒（AC-PUSH-12-6）', async ({ browser }) => {
  const { u, page } = await newUser(browser);
  await pushTo(u, '封禁前');
  await page.goto('/me/notices');
  await expect.poll(() => seen(page, u)).toBe('1');
  await signed(`/admin/users/${u}/ban`, { durationSeconds: 86_400, reason: 'e2e' });
  const dialog = page.getByTestId('kicked-dialog');
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  await dialog.getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await seen(page, u)).toBe('1');

  await signed(`/admin/users/${u}/unban`, { reason: 'e2e' });
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/me');
  await expect(page.getByTestId('me-notices')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('me-notices-count')).toHaveCount(0);
  await expect(page.getByTestId('notice-banner')).toHaveCount(0);
});

test('localStorage 只有 ui.* 键，noticeSeen 是纯数字，搜不到通知文本；token 不进 URL、localStorage 和日志（AC-PUSH-12-10、NF-UI-13）', async ({
  browser,
}) => {
  const u = uid('n');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const urls: string[] = [];
  const logs: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('websocket', (ws) => urls.push(ws.url()));
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e)));
  await page.goto('/login');
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  await synced(page, u);

  const text = `NOTICE-TEXT-${randomUUID()}`;
  await pushTo(u, text);
  await expect(page.getByTestId('notice-banner')).toContainText(text, { timeout: 3_000 });
  const promo = `PROMO-SECRET-${randomUUID()}`;
  await signed('/admin/push', {
    target: 'user',
    userIds: [u],
    type: 'promo',
    data: { text: promo },
    pushId: randomUUID(),
  });
  await page.goto('/me/notices');
  await expect(page.getByTestId('notice-item')).toHaveCount(1); // promo 不显示（AC-UI-44-2）
  await expect.poll(() => seen(page, u)).toMatch(/^\d+$/);

  const dump = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    token: JSON.parse(sessionStorage.getItem('tt.session') ?? '{}').token as string,
  }));
  expect(dump.local.length).toBeGreaterThan(0);
  for (const [k] of dump.local) expect(k.startsWith('ui.')).toBe(true);
  const all = JSON.stringify(dump.local);
  expect(all).not.toContain(text);
  expect(all).not.toContain(dump.token);
  expect(dump.token.length).toBeGreaterThan(10);
  for (const url of urls) expect(url).not.toContain(dump.token);
  expect(page.url()).not.toContain(dump.token);
  const logText = logs.join('\n');
  expect(logText).not.toContain(dump.token);
  expect(logText).not.toContain(text);
  expect(logText).not.toContain(promo);
});

test('XSS：原样显示为文本，不弹窗、不请求 x（AC-UI-44-3）', async ({ browser }) => {
  const { u, page } = await newUser(browser);
  let dialogs = 0;
  const xRequests: string[] = [];
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  page.on('request', (r) => {
    if (/\/x$/.test(new URL(r.url()).pathname)) xRequests.push(r.url());
  });
  const xss = '<img src=x onerror=alert(1)>';
  await pushTo(u, xss);
  await expect(page.getByTestId('notice-banner')).toHaveText(`系统通知：${xss}`, { timeout: 3_000 });
  await page.getByTestId('notice-banner').click();
  await expect(page.getByTestId('notice-item').first()).toContainText(xss);
  await page.waitForTimeout(300);
  expect(dialogs).toBe(0);
  expect(xRequests).toEqual([]);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('全员推送：在线的收到，离线的上线后收不到（AC-ADM-50-3、AC-PUSH-04-1）', async ({ browser }) => {
  const { page } = await newUser(browser);
  const offline = uid('off');
  await admin('POST', '/admin/users/import', { users: [{ userId: offline }] });
  const text = `全员-${randomUUID()}`;
  await signed('/admin/push', { target: 'all', type: 'notice', data: { text }, pushId: randomUUID() });
  await expect(page.getByTestId('notice-banner')).toContainText(text, { timeout: 3_000 });

  const late = await loginAs(browser, offline);
  await synced(late, offline);
  await late.goto('/me/notices');
  await synced(late, offline);
  await expect(late.getByTestId('notices-empty')).toBeVisible();
});

test('断线重连：闪断期间的通知按实时算，弹横幅（4.5 节规则 4，AC-PUSH-08-1）', async ({ page }) => {
  const u = uid('n');
  await admin('POST', '/admin/users/import', { users: [{ userId: u }] });
  // 代理 WebSocket：down 期间新连接直接关闭，当前连接也断开。
  const net = { down: false, close: () => {} };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    if (net.down) {
      void ws.close({ code: 4000, reason: 'down' });
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    net.close = () => void ws.close({ code: 4000, reason: 'flash' });
  });
  await page.goto('/login');
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  await synced(page, u);

  net.down = true;
  net.close();
  await expect(page.getByTestId('conn-banner')).toBeVisible({ timeout: 5_000 });
  await pushTo(u, '闪断期间');
  net.down = false;
  await expect(page.getByTestId('notice-banner')).toHaveText('系统通知：闪断期间', { timeout: 10_000 });
  await expect(page.getByTestId('conn-banner')).toHaveCount(0);
});

test('宽屏：入口在列表栏，通知页在主区；axe 没有对比度和按钮名问题', async ({ browser }) => {
  const u = uid('n');
  const page = await loginAs(browser, u, '/login', WIDE);
  await synced(page, u);
  await page.goto('/me');
  await pushTo(u, '宽屏通知');
  await expect(page.getByTestId('notice-banner')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('list-column').getByTestId('me-notices-count')).toHaveText('1');
  const scan = await new AxeBuilder({ page }).withRules(['color-contrast', 'button-name']).analyze();
  expect(scan.violations).toEqual([]);
  await page.getByTestId('me-notices').click();
  await expect(page.getByTestId('main').getByTestId('notice-item')).toHaveCount(1);
  await expect(page.getByTestId('list-column').getByTestId('me-notices-count')).toHaveCount(0);
});
