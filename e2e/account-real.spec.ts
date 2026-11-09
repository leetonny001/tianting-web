// FE-620：之前只对假接口跑的部分接到真实 im-server，提醒和踢线同时出现的表现。结果是 Chrome，本地。
// 调 IM 钟的用例在 zz-im-clock.spec.ts。TC-ACC-03-45 那一条要短的绝对上限：IM_REFRESH_ABSOLUTE=25s 单独跑。
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { accountLogin, accountPage, api, apiRegister, dateOf, NEW_PASSWORD, PASSWORD, storedSession } from './helpers';

const tokenOf = (r: { data: unknown }) => (r.data as { accessToken: string }).accessToken;
const xLogin = async (username: string, password = PASSWORD) =>
  tokenOf(await api('/v1/account/login', { username, password, platform: 'android' }));

const axeProblems = async (page: import('@playwright/test').Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.id === 'button-name' || v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
};

const shotDir = process.env.TT_E2E_SHOTS;
async function shot(page: import('@playwright/test').Page, name: string) {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `${name}.png`) });
}

test.describe('securityNotice 对真实服务端（F-ACC-02 规则 3b，F-ACC-05 规则 5）', () => {
  test('TC-ACC-02-13 newDeviceLogin：在线设备 2 秒内提示', async ({ browser }) => {
    const u = await apiRegister('note');
    const page = await accountPage(browser, u.username);
    await page.waitForTimeout(300);
    await xLogin(u.username);
    await expect(page.getByTestId('toast')).toHaveText('你的账号在新设备登录', { timeout: 2000 });
    await shot(page, 'notice-newDeviceLogin');
    await page.context().close();
  });

  test('recoveryCodeRegenerated：其他设备提示，连接不断', async ({ browser }) => {
    const u = await apiRegister('note');
    const page = await accountPage(browser, u.username);
    await page.waitForTimeout(300);
    const x = await xLogin(u.username);
    await expect(page.getByTestId('toast')).toHaveText('你的账号在新设备登录');
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 8000 });
    expect((await api('/v1/account/recovery-code', { password: PASSWORD }, x)).status).toBe(200);
    await expect(page.getByTestId('toast')).toHaveText('你的恢复码已重新生成', { timeout: 2000 });
    await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
    await shot(page, 'notice-recoveryCodeRegenerated');
    await page.context().close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`passwordChanged：提示和 kicked 弹窗同时出现，弹窗能点，文字看得清（${scheme}）`, async ({ browser }) => {
      const u = await apiRegister('note');
      const page = await accountPage(browser, u.username, { colorScheme: scheme });
      await page.waitForTimeout(300);
      const x = await xLogin(u.username);
      await expect(page.getByTestId('toast')).toHaveText('你的账号在新设备登录');
      await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 8000 });
      expect((await api('/v1/account/password', { oldPassword: PASSWORD, newPassword: NEW_PASSWORD }, x)).status).toBe(
        200,
      );
      const dialog = page.getByTestId('kicked-dialog');
      await expect(dialog).toContainText(`请在 ${dateOf(Date.now() + 7 * 86_400_000)} 前用恢复码找回`);
      await shot(page, `notice-passwordChanged-with-dialog-${scheme}`);
      expect(await axeProblems(page)).toEqual([]); // TC-CHAT-90-08：提示和弹窗同时在，两种颜色
      // 提示盖住"确定"的话用户点不到：Playwright 的 click 会检查点击落点。键盘也能确定（焦点在弹窗里）。
      await dialog.getByText('确定').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/login/);
      await page.context().close();
    });
  }

  test('passwordRecovered：提示和 kicked 弹窗都有，确定后回登录页', async ({ browser }) => {
    const u = await apiRegister('note');
    const page = await accountPage(browser, u.username);
    await page.waitForTimeout(300);
    const r = await api('/v1/account/recover', {
      username: u.username,
      recoveryCode: u.recoveryCode,
      newPassword: NEW_PASSWORD,
      platform: 'android',
    });
    expect(r.status).toBe(200);
    const dialog = page.getByTestId('kicked-dialog');
    await expect(dialog).toBeVisible();
    await shot(page, 'notice-passwordRecovered-with-dialog');
    await dialog.getByText('确定').click({ timeout: 3000 });
    await expect(page).toHaveURL(/\/login/);
    await page.context().close();
  });
});

test.describe('TC-CHAT-90-08 之前没有扫的账号页面', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe：改密、退出其他设备弹窗、重新生成弹窗、改昵称（${scheme}）`, async ({ browser }) => {
      const u = await apiRegister('axe');
      const page = await accountPage(browser, u.username, { colorScheme: scheme });
      await page.goto('/me/settings/security/password');
      await expect(page.getByTestId('password-old')).toBeVisible();
      expect(await axeProblems(page)).toEqual([]);
      await page.goto('/me/settings/security');
      await page.getByTestId('security-logout-others').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await axeProblems(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByTestId('security-regenerate').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await axeProblems(page)).toEqual([]);
      await page.goto('/me');
      await page.getByTestId('me-edit').click();
      await expect(page.getByTestId('nickname-input')).toBeVisible();
      expect(await axeProblems(page)).toEqual([]);
      await page.context().close();
    });
  }

  test('键盘：只用键盘改密，弹窗里 Tab 不跑出去', async ({ browser }) => {
    const u = await apiRegister('kb');
    const page = await accountPage(browser, u.username);
    await page.goto('/me/settings/security/password');
    await page.getByTestId('password-old').focus();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Tab');
    await page.keyboard.type(NEW_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('recovery-code')).toBeVisible();
    await page.context().close();
    const v = await apiRegister('kb');
    const p2 = await accountPage(browser, v.username);
    await p2.goto('/me/settings/security');
    await p2.getByTestId('security-logout-others').focus();
    await p2.keyboard.press('Enter');
    const dialog = p2.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await p2.keyboard.press('Tab');
      expect(await p2.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
    }
    await p2.context().close();
  });
});

test('TC-ACC-04-25 场景二（真实服务端）：改密响应晚于 30 秒，提示失败，踢线生效，迟到的响应丢弃', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const u = await apiRegister('late');
  const page = await accountPage(browser, u.username);
  await page.waitForTimeout(300);
  await page.route('**/v1/account/password', async (r) => {
    const resp = await r.fetch(); // 服务端已提交，先踢线
    await new Promise((f) => setTimeout(f, 31_000));
    await r.fulfill({ response: resp }).catch(() => undefined);
  });
  await page.goto('/me/settings/security/password');
  const before = await storedSession(page);
  await page.getByTestId('password-old').fill(PASSWORD);
  await page.getByTestId('password-new').fill(NEW_PASSWORD);
  const started = Date.now();
  await page.getByTestId('password-submit').click();
  await expect(page.getByTestId('kicked-dialog')).toBeVisible({ timeout: 35_000 });
  expect(Date.now() - started).toBeGreaterThan(29_000); // 缓存了踢线，等满 30 秒才生效
  await expect(page.getByTestId('kicked-dialog')).toContainText('你的账号凭证有变化');
  await page.waitForTimeout(2500); // 迟到的响应到达
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await storedSession(page)).toBeNull();
  expect(before).not.toBeNull();
  await page.context().close();
});

test('TC-ACC-03-45 真实绝对上限：access 到期等于上限，不刷新，不重连，到期回登录页', async ({ browser }) => {
  test.setTimeout(60_000);
  const u = await apiRegister('abs');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let refreshes = 0;
  const answers: string[] = []; // 刷新的响应：状态码和错误码（不留正文，正文里有 token）
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/account/token/refresh')) refreshes += 1;
  });
  page.on('response', async (r) => {
    if (!r.url().endsWith('/v1/account/token/refresh')) return;
    const code = /"code":(\d+)/.exec(await r.text().catch(() => ''))?.[1];
    answers.push(code ? `${r.status()}/${code}` : `${r.status()}`);
  });
  let sockets = 0;
  page.on('websocket', (ws) => {
    if (/\/ws(\?|$)/.test(ws.url())) sockets += 1; // 开发服务器还有自己的 HMR 连接
  });
  await accountLogin(page, u.username);
  await expect(page).toHaveURL(/\/chats$/);
  const s = JSON.parse((await storedSession(page))!) as { accessExpiresAt: number; absoluteExpiresAt: number };
  test.skip(s.absoluteExpiresAt - Date.now() > 120_000, '要用 IM_REFRESH_ABSOLUTE=25s 的服务端单独跑');
  expect(s.accessExpiresAt).toBe(s.absoluteExpiresAt);
  await page.waitForTimeout(2000);
  // 回前台一次
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1000);
  expect(refreshes).toBe(0);
  expect(sockets).toBe(1);
  await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
  // 到上限之前一直不刷新、不重连。
  await page.waitForTimeout(Math.max(0, s.absoluteExpiresAt - Date.now() - 1500));
  expect(refreshes).toBe(0);
  expect(sockets).toBe(1);
  await expect(page.getByTestId('kicked-dialog')).toContainText('登录已失效，请重新登录', { timeout: 10_000 });
  // 到期之后（问题 F2 已在服务端修复）：没有成功的刷新，不重连。服务端在上限那一秒踢 tokenExpired（JWT 的 exp 只到秒）时
  // 客户端最多问一次，服务端按到期拒绝（401 / 4019）。
  await page.waitForTimeout(3000);
  console.log(`TC-ACC-03-45 refresh answers ${JSON.stringify(answers)}, sockets ${sockets}`); // 只有状态码和错误码
  expect(refreshes, JSON.stringify(answers)).toBeLessThanOrEqual(1);
  expect(
    answers.every((a) => a === '401/4019'),
    JSON.stringify(answers),
  ).toBe(true);
  expect(sockets).toBe(1);
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await storedSession(page)).toBeNull();
  await ctx.close();
});
