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
