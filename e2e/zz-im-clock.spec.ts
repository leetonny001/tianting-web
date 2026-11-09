import { expect, test } from '@playwright/test';
import { demoToken, makePng, uploadFile, watchFiles, wsSend } from './files';
import {
  accountPage,
  admin,
  api,
  apiRegister,
  c2cId,
  chatUrl,
  comeBack,
  dateOf,
  goOffline,
  loginAs,
  NEW_PASSWORD,
  PASSWORD,
  uid,
} from './helpers';

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

// ---- 图片和文件（FE-633、FE-634）：要调 IM 钟、跑 file_purge 的用例 ----

test('TC-FILE-06-05（H5，AC-FILE-06-6）：过期的图片和文件显示"图片已过期""文件已过期"，点了也不申请地址', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const a = uid('ea');
  const b = uid('eb');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const token = await demoToken(a);
  const img = await uploadFile(
    token,
    'image',
    'image.png',
    makePng(40, 30, () => [1, 2, 3]),
    'image/png',
    {
      data: makePng(20, 15, () => [1, 2, 3]),
      mime: 'image/png',
    },
  );
  const file = await uploadFile(token, 'file', 'ZXQ-EXP.pdf', Buffer.from('%PDF-1.4 exp'), 'application/pdf');
  await wsSend(token, [
    { convType: 'c2c', to: b, type: 'image', body: { image: { fileId: img } } },
    { convType: 'c2c', to: b, type: 'file', body: { file: { fileId: file } } },
  ]);
  try {
    // 保留期 180 天（IM_FILE_RETENTION_DAYS 默认）：推进 181 天跑清理，对象删除、消息带 expired=true。
    await admin('POST', '/admin/test/clock', { nowMs: Date.now() + 181 * 86_400_000 });
    await admin('POST', '/admin/test/jobs/file_purge/run');
    const bob = await loginAs(browser, b);
    const net = watchFiles(bob);
    await bob.goto(chatUrl(c2cId(a, b)));
    await expect(bob.getByTestId('img-expired')).toHaveText('图片已过期');
    await expect(bob.getByTestId('file-expired')).toHaveText('文件已过期');
    await bob.getByTestId('file-bubble').click();
    await bob.getByTestId('img-bubble').click();
    await bob.waitForTimeout(500);
    expect(net.urls).toEqual([]);
    expect(net.gets).toEqual([]);
    expect(await bob.content()).not.toContain('ZXQ-EXP');
    await bob.context().close();
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
  }
});

test('TC-FILE-07-10（H5，页面没刷新）：待发送的图片文件 24 小时后被清理，重发时 send 得到 4096，用内存里的源重新上传后发出', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  // 现在的服务端：file_purge 把超过 24 小时没绑定的文件整行删掉，之后 send 回 4048（文件不存在），不是 F-FILE-07 规则 4、
  // AC-FILE-07-10 写的 4096，SDK 不会重新上传，消息停在"文件不存在或已过期"。断言按 PRD 写，服务端修好之前预期失败（问题 H15）。
  test.fail(true, 'im-server 清理后 send 回 4048 而不是 4096（问题 H15）');
  const a = uid('ra');
  const b = uid('rb');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const alice = await loginAs(browser, a);
  let dropped = false;
  const sendErrors: number[] = [];
  await alice.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as { cmd?: string; data?: { type?: string } };
      if (f.cmd === 'send' && f.data?.type === 'image' && !dropped) {
        dropped = true; // 第一次的 send 不转给服务端：没有 ack，10 秒后失败，文件停在 ready
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const code = /"error":\{"code":(\d+)/.exec(String(m))?.[1];
      if (code) sendErrors.push(Number(code));
      ws.send(m);
    });
  });
  await alice.goto(chatUrl(c2cId(a, b)));
  const net = watchFiles(alice);
  await alice.getByTestId('pick-image').setInputFiles({
    name: 'a.png',
    mimeType: 'image/png',
    buffer: makePng(60, 40, () => [7, 7, 7]),
  });
  const msg = alice.getByTestId('message').last();
  await expect(msg).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
  const firstFile = await alice.getByTestId('img-bubble').getAttribute('data-file-id');
  const putsBefore = net.puts.length;
  try {
    await admin('POST', '/admin/test/clock', { nowMs: Date.now() + 25 * 3_600_000 });
    await admin('POST', '/admin/test/jobs/file_purge/run');
    await alice.getByTestId('failed-icon').click();
    await alice.getByTestId('retry-dialog').getByRole('button', { name: '重发' }).click();
    await expect(msg)
      .toHaveAttribute('data-status', 'sent', { timeout: 20_000 })
      .catch((e: unknown) => {
        console.log(`TC-FILE-07-10 send errors ${JSON.stringify(sendErrors)}`); // 只有错误码
        throw e;
      });
    expect(sendErrors).toContain(4096);
    expect(net.puts.length).toBe(putsBefore + 2); // 从头重新上传了原图和缩略图（RC2-23）
    const secondFile = await alice.getByTestId('img-bubble').getAttribute('data-file-id');
    expect(secondFile).not.toBe(firstFile);
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(c2cId(a, b)));
    await expect(bob.getByTestId('img-bubble')).toHaveCount(1);
    await bob.context().close();
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
  }
  await alice.context().close();
});
