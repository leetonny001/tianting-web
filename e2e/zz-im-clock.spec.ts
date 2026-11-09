import { expect, test } from '@playwright/test';
import { accountPage, admin, api, apiRegister, comeBack, dateOf, goOffline, NEW_PASSWORD, PASSWORD } from './helpers';

// 这个文件要最后跑（文件名 zz-，workers=1）：把 IM 钟调快再调回之后，服务端的限流桶记着"未来"的时间，
// 在真实时间追上之前不再补充。握手限流（每 IP）的 50 个令牌用完后，后面所有用例都连不上 WebSocket。

const tokenOf = (r: { data: unknown }) => (r.data as { accessToken: string }).accessToken;
const xLogin = async (username: string, password = PASSWORD) =>
  tokenOf(await api('/v1/account/login', { username, password, platform: 'android' }));

test('TC-ACC-04-24 序列丙：第 0 天改密，第 5 天再改一次（IM 钟）；受害者第 6 天上线，日期没有推后', async ({
  browser,
}) => {
  const v = await apiRegister('seq');
  const saved = await goOffline(await accountPage(browser, v.username));
  const expected = dateOf(Date.now() + 7 * 86_400_000);
  const t0 = Date.now();
  try {
    expect(
      (
        await api(
          '/v1/account/password',
          { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
          await xLogin(v.username),
        )
      ).status,
    ).toBe(200);
    await admin('POST', '/admin/test/clock', { nowMs: t0 + 5 * 86_400_000 });
    const t2 = await xLogin(v.username, NEW_PASSWORD);
    expect(
      (await api('/v1/account/password', { oldPassword: NEW_PASSWORD, newPassword: 'third-password-3' }, t2)).status,
    ).toBe(200);
    await admin('POST', '/admin/test/clock', { nowMs: t0 + 6 * 86_400_000 });
    const page = await comeBack(browser, saved);
    await expect(page.getByTestId('kicked-dialog')).toContainText(`请在 ${expected} 前用恢复码找回`);
    await page.context().close();
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
  }
});

const stolenFrom = (saved: string) => (JSON.parse(saved) as { refreshToken: string }).refreshToken;
const reopenExpired = async (browser: import('@playwright/test').Browser, saved: string) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.evaluate((raw) => {
    const s = JSON.parse(raw);
    s.accessExpiresAt = Date.now() - 1000;
    sessionStorage.setItem('tt.session', JSON.stringify(s));
  }, saved);
  return page;
};
const MINUTE = 60_000;

test('TC-ACC-03-26 replayDetected（真实服务端）：攻击者转正，窗口过后受害者刷新得到 4019，弹窗，确定后 token 清除', async ({
  browser,
}) => {
  const v = await apiRegister('rep');
  const saved = await goOffline(await accountPage(browser, v.username));
  const t0 = Date.now();
  try {
    await admin('POST', '/admin/test/clock', { nowMs: t0 });
    const x = await api('/v1/account/token/refresh', { refreshToken: stolenFrom(saved) });
    expect(x.status).toBe(200);
    expect((await api('/v1/account/events', undefined, tokenOf(x), 'GET')).status).toBe(200); // 转正
    await admin('POST', '/admin/test/clock', { nowMs: t0 + 3 * MINUTE });
    const page = await reopenExpired(browser, saved);
    const resp = page.waitForResponse('**/v1/account/token/refresh');
    await page.goto('/chats');
    expect((await resp).status()).toBe(401);
    expect(((await (await resp).json()) as { reason: string }).reason).toBe('replayDetected');
    await expect(page.getByTestId('kicked-dialog')).toContainText(
      '检测到登录凭证异常，这台设备已下线。如果不是你本人操作，请尽快改密码',
    );
    await page.getByTestId('kicked-dialog').getByText('确定').click();
    await expect(page).toHaveURL(/\/login/);
    await page.context().close();
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
  }
});

test('TC-ACC-03-41 superseded（真实服务端，1 次）：留在当前页，按 retryAfterSeconds 重试；窗口过后重放，弹窗。连续 3 次造不出来，在假接口', async ({
  browser,
}) => {
  const v = await apiRegister('sup');
  const saved = await goOffline(await accountPage(browser, v.username));
  const t0 = Date.now();
  try {
    await admin('POST', '/admin/test/clock', { nowMs: t0 });
    const x = await api('/v1/account/token/refresh', { refreshToken: stolenFrom(saved) });
    expect(x.status).toBe(200);
    expect((await api('/v1/account/events', undefined, tokenOf(x), 'GET')).status).toBe(200); // 转正，窗口 2 分钟
    await admin('POST', '/admin/test/clock', { nowMs: t0 + 2 * MINUTE - 3000 });
    const page = await reopenExpired(browser, saved);
    const statuses: { reason: string; retry?: number }[] = [];
    page.on('response', async (r) => {
      if (!r.url().endsWith('/v1/account/token/refresh')) return;
      const b = (await r.json()) as { reason: string; details?: { retryAfterSeconds?: number } };
      statuses.push({ reason: b.reason, retry: b.details?.retryAfterSeconds });
    });
    await page.goto('/chats');
    await expect.poll(() => statuses.length).toBeGreaterThan(0);
    expect(statuses[0]).toEqual({ reason: 'superseded', retry: 3 });
    await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
    expect(page.url()).toMatch(/\/chats$/);
    await admin('POST', '/admin/test/clock', { nowMs: t0 + 2 * MINUTE + 1000 });
    await expect(page.getByTestId('kicked-dialog')).toContainText('检测到登录凭证异常', { timeout: 10_000 });
    expect(statuses.map((s) => s.reason)).toEqual(['superseded', 'replayDetected']);
    await page.context().close();
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
  }
});
