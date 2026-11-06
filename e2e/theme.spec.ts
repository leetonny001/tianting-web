import AxeBuilder from '@axe-core/playwright';
import { PROD } from './ports';
import { expect, test, type Page } from '@playwright/test';
import { admin, chatUrl, loginAs, uid } from './helpers';

// 深色模式与外观设置（PRD-ui F-UI-22、FE-302）。

const DARK = 'rgb(17, 19, 24)'; // color.bg #111318
const LIGHT = 'rgb(242, 243, 247)'; // color.bg #F2F3F7
const bodyBg = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('跟随系统：深色 #111318，切到浅色 1 秒内变 #F2F3F7，不刷新（AC-UI-22-1）', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  expect(await bodyBg(page)).toBe(DARK);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true));
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => bodyBg(page), { timeout: 1_000 }).toBe(LIGHT);
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => bodyBg(page), { timeout: 1_000 }).toBe(DARK);
});

test('选了浅色 / 深色就不再跟随系统；外观页选项和 ui.theme 对应（AC-UI-22-5）', async ({ browser }) => {
  const page = await loginAs(browser, uid('alice'), '/me/settings');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('settings-appearance').click();
  await expect(page).toHaveURL(/\/me\/settings\/appearance$/);
  await expect(page.getByTestId('appearance-system')).toBeChecked(); // 默认跟随系统
  expect(await bodyBg(page)).toBe(DARK);

  await page.getByTestId('appearance-light').check();
  expect(await page.evaluate(() => localStorage.getItem('ui.theme'))).toBe('light');
  expect(await bodyBg(page)).toBe(LIGHT);
  await page.reload();
  expect(await bodyBg(page)).toBe(LIGHT);
  await expect(page.getByTestId('appearance-light')).toBeChecked();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  expect(await bodyBg(page)).toBe(LIGHT); // 系统变化不影响手动选择

  await page.getByTestId('appearance-system').check();
  expect(await page.evaluate(() => localStorage.getItem('ui.theme'))).toBe('system');
  await expect.poll(() => bodyBg(page)).toBe(DARK);
});

test('生产构建 + CSP 响应头：刷新后首帧前就是深色，同源 /theme-init.js，没有 CSP 违规（AC-UI-22-2）', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const page = await ctx.newPage();
  // 在页面脚本之前装好：<body> 刚出现时读 data-theme（这时模块脚本还没执行），DOMContentLoaded 时读背景色。
  await page.addInitScript(() => {
    const w = window as unknown as { __theme: { atBody?: string | null; dcl?: string; csp: string[] } };
    w.__theme = { csp: [] };
    document.addEventListener('securitypolicyviolation', (e) => w.__theme.csp.push(e.violatedDirective));
    new MutationObserver((_, o) => {
      if (document.body) {
        w.__theme.atBody = document.documentElement.getAttribute('data-theme');
        o.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => {
      w.__theme.dcl = getComputedStyle(document.body).backgroundColor;
    });
  });
  const consoleCsp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
  });
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });

  const first = await page.goto(`${PROD}/login`);
  const header = first!.headers()['content-security-policy']!;
  expect(header).toContain("script-src 'self'");
  expect(header).toContain("frame-ancestors 'none'");
  expect(header).not.toContain("'unsafe-inline' 'self'");
  expect(header).not.toMatch(/script-src[^;]*unsafe/);

  await page.getByTestId('login-username').fill(uid('alice'));
  await page.getByTestId('login-username').press('Enter');
  await expect(page).toHaveURL(/\/chats$/);
  await page.goto(`${PROD}/me/settings/appearance`);
  await page.getByTestId('appearance-dark').check();

  scripts.length = 0;
  await page.reload();
  const seen = await page.evaluate(() => (window as unknown as { __theme: object }).__theme);
  expect(seen).toEqual({ atBody: 'dark', dcl: DARK, csp: [] });
  expect(scripts[0]).toBe(`${PROD}/theme-init.js`);
  expect(await page.evaluate(() => document.head.querySelector('script')?.getAttribute('src'))).toBe('/theme-init.js');
  expect(await page.locator('script:not([src])').count()).toBe(0);
  expect(consoleCsp).toEqual([]);
});

test('外观选深色后退出登录：登录页仍是深色，ui.theme 还在（AC-UI-16-5）', async ({ browser }) => {
  const page = await loginAs(browser, uid('alice'), '/me/settings/appearance');
  await page.getByTestId('appearance-dark').check();
  await page.getByLabel('返回').click();
  await page.getByTestId('logout').click();
  await page.getByTestId('logout-dialog').getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await bodyBg(page)).toBe(DARK);
  expect(await page.evaluate(() => localStorage.getItem('ui.theme'))).toBe('dark');
  await page.reload();
  expect(await bodyBg(page)).toBe(DARK);
});

test('系统深色时 M4 构建跟随系统（AC-UI-22-4 只约束 M3，由 AC-UI-22-1 取代）；手动选浅色时和 M3 一样是浅色', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/login');
  expect(await bodyBg(page)).toBe(DARK);
  await page.evaluate(() => localStorage.setItem('ui.theme', 'light'));
  await page.reload();
  expect(await bodyBg(page)).toBe(LIGHT);
});

test('可访问性：深色下主要页面没有 color-contrast、button-name 违规（AC-UI-90-4 的 M4 部分、TC-UI-22-06）', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const a = uid('alice');
  const b = uid('bob');
  const g = uid('g');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  await admin('POST', '/admin/groups', { groupId: g, name: '深色群', members: [a, b] });
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const login = await ctx.newPage();
  await login.goto('/login');
  const scan = async (p: Page, label: string) => {
    expect(await bodyBg(p), label).toBe(DARK);
    const r = await new AxeBuilder({ page: p }).withRules(['color-contrast', 'button-name']).analyze();
    expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
      [],
    );
  };
  await scan(login, 'login');
  await login.getByTestId('login-username').fill(a);
  await login.getByTestId('login-username').press('Enter');
  await expect(login).toHaveURL(/\/chats$/);
  const page = login;
  const groupConv = `group:${g}`;
  await page.goto(chatUrl(groupConv));
  await page.getByTestId('composer-input').fill('深色检查');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
  await scan(page, 'chat');
  await page.getByTestId('emoji-button').click();
  await scan(page, 'emoji');
  for (const path of [
    '/chats',
    '/contacts',
    '/contacts/requests',
    '/contacts/groups',
    '/contacts/add',
    `/contacts/apply/${b}`,
    `/user/${b}`,
    '/me',
    '/me/settings',
    '/me/settings/appearance',
    '/me/settings/blocks',
    '/me/settings/privacy',
    '/groups/new',
    `${chatUrl(groupConv)}/info`,
    `${chatUrl(groupConv)}/notice`,
    `${chatUrl(groupConv)}/members`,
    `${chatUrl(groupConv)}/invite`,
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await scan(page, path);
  }
});
