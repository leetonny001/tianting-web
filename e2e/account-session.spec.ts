import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountLogin,
  accountPage,
  api,
  apiRegister,
  c2cId,
  comeBack,
  dateOf,
  goOffline,
  chatUrl,
  NEW_PASSWORD,
  PASSWORD,
  storedSession,
  uid,
  WIDE,
} from './helpers';

// FE-614：会话、多标签页、账号安全。环境：本机 Chrome，真实 im-server（测试模式，SQLite）。

const SIX_HOURS = 6 * 3_600_000;

async function sendTo(page: Page, conv: string, text: string) {
  await page.goto(chatUrl(conv));
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
}

/** 页面 P1 上记录所有 HTTP 响应的状态码，看有没有 401。 */
function record401(page: Page) {
  const bad: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 401) bad.push(r.url());
  });
  return bad;
}

test('TC-ACC-03-09 刷新后仍登录，关闭后新标签页回登录页，localStorage 没有 token', async ({ browser }) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  const raw = JSON.parse((await storedSession(page))!) as { accessToken: string; refreshToken: string };
  for (let i = 0; i < 5; i++) {
    await page.reload(); // 多刷新几次：旧文档的锁可能还没放掉，不能把刷新当成第二个标签页
    await expect(page.getByTestId('tab-chats')).toBeVisible();
    await expect(page).toHaveURL(/\/chats$/);
  }
  const local = await page.evaluate(() => JSON.stringify(localStorage));
  expect(local).not.toContain(raw.accessToken);
  expect(local).not.toContain(raw.refreshToken);
  const ctx = page.context();
  await page.close();
  const next = await ctx.newPage();
  await next.goto('/chats');
  await expect(next).toHaveURL(/\/login/);
  await ctx.close();
});

test.describe('TC-ACC-03-14 sessionStorage 被复制', () => {
  test('场景一 window.open：新页面清 token 回登录页，原页面不受影响、没有 401、发消息成功', async ({ browser }) => {
    const u = await apiRegister();
    const p1 = await accountPage(browser, u.username);
    const bad = record401(p1);
    const [p2] = await Promise.all([
      p1.context().waitForEvent('page'),
      p1.evaluate(() => void window.open('/chats', '_blank')),
    ]);
    await expect(p2).toHaveURL(/\/login/);
    await expect(p2.getByTestId('tab-conflict')).toBeVisible();
    expect(await storedSession(p2)).toBeNull();
    expect(await storedSession(p1)).not.toBeNull();
    await sendTo(p1, c2cId(u.username, u.username), 'still fine');
    expect(bad).toEqual([]);
    await p1.context().close();
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数是解构
  test('场景二 真实"复制标签页"（扩展调 chrome.tabs.duplicate）：运行中和冻结时复制，新页面都回登录页，原页面不受影响', async ({}, info) => {
    const u = await apiRegister();
    const ext = info.outputPath('ext');
    mkdirSync(ext, { recursive: true });
    writeFileSync(
      join(ext, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'dup', version: '1', permissions: ['tabs'] }),
    );
    writeFileSync(join(ext, 'p.html'), '<!doctype html><title>p</title>');
    const ctx = await chromium.launchPersistentContext(info.outputPath('profile'), {
      channel: 'chrome',
      baseURL: info.project.use.baseURL,
      args: ['--enable-unsafe-extension-debugging'],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    const cdpB = await ctx.browser()!.newBrowserCDPSession();
    const { id } = await cdpB.send('Extensions.loadUnpacked', { path: ext });
    const tool = await ctx.newPage();
    await tool.goto(`chrome-extension://${id}/p.html`);
    const p1 = await ctx.newPage();
    await accountLogin(p1, u.username);
    await expect(p1).toHaveURL(/\/chats$/);
    const bad = record401(p1);
    const duplicate = async () => {
      const [dup] = await Promise.all([
        ctx.waitForEvent('page'),
        tool.evaluate(async () => {
          const api = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(q: object): Promise<{ id: number; url: string }[]>;
                  duplicate(id: number): Promise<unknown>;
                };
              };
            }
          ).chrome.tabs;
          const tabs = await api.query({});
          await api.duplicate(tabs.find((t) => t.url.endsWith('/chats'))!.id);
        }),
      ]);
      await expect(dup).toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(dup.getByTestId('tab-conflict')).toBeVisible();
      expect(await storedSession(dup)).toBeNull();
      await dup.close();
    };
    await duplicate();
    const cdp = await ctx.newCDPSession(p1);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await duplicate();
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    expect(await storedSession(p1)).not.toBeNull();
    await sendTo(p1, c2cId(u.username, u.username), 'after duplicate');
    expect(bad).toEqual([]);
    await ctx.close();
  });

  test('场景三 原页面被 CDP 冻结时复制：新页面照样拿不到锁；原页面解冻后不受影响', async ({ browser }) => {
    const u = await apiRegister();
    const p1 = await accountPage(browser, u.username);
    const bad = record401(p1);
    const cdp = await p1.context().newCDPSession(p1);
    // 先开窗口（opener 必须活着才能 window.open），再立刻冻结原页面，新页面启动时原页面是冻结的。
    const [p2] = await Promise.all([
      p1.context().waitForEvent('page'),
      p1.evaluate(() => {
        const w = window.open('about:blank', '_blank');
        (window as unknown as { __w: Window | null }).__w = w;
      }),
    ]);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    // about:blank 继承了 sessionStorage 的副本；同源导航后读到的就是复制来的 token。
    await p2.goto(new URL('/chats', p1.url()).href);
    await expect(p2).toHaveURL(/\/login/, { timeout: 10_000 });
    await expect(p2.getByTestId('tab-conflict')).toBeVisible();
    expect(await storedSession(p2)).toBeNull();
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await sendTo(p1, c2cId(u.username, u.username), 'after thaw');
    expect(bad).toEqual([]);
    await p1.context().close();
  });

  test('没有 navigator.locks：退回 BroadcastChannel，新页面同样回登录页，原页面不受影响', async ({ browser }) => {
    const u = await apiRegister();
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined });
    });
    const p1 = await ctx.newPage();
    await accountLogin(p1, u.username);
    await expect(p1).toHaveURL(/\/chats$/);
    const [p2] = await Promise.all([ctx.waitForEvent('page'), p1.evaluate(() => void window.open('/chats', '_blank'))]);
    await expect(p2).toHaveURL(/\/login/);
    await expect(p2.getByTestId('tab-conflict')).toBeVisible();
    await sendTo(p1, c2cId(u.username, u.username), 'bc fine');
    await ctx.close();
  });
});

test('TC-ACC-03-10 剩余不足 6 小时：自动刷新，1000 断开重连，不提示，消息照常（SDK 钟 = page.clock）', async ({
  browser,
}) => {
  const u = await apiRegister();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.clock.install();
  const closes: (number | undefined)[] = [];
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose((code, reason) => {
      closes.push(code);
      server.close({ code, reason });
    });
  });
  await accountLogin(page, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  const before = JSON.parse((await storedSession(page))!) as { accessExpiresAt: number; refreshToken: string };
  await page.waitForTimeout(300);
  let refreshes = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/account/token/refresh')) refreshes += 1;
  });
  const now = await page.evaluate(() => Date.now());
  const refreshed = page.waitForResponse('**/v1/account/token/refresh');
  await page.clock.fastForward(before.accessExpiresAt - SIX_HOURS - now + 60_000);
  expect((await refreshed).status()).toBe(200);
  await expect.poll(() => closes).toContain(1000);
  await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
  await expect(page.getByText('连接中')).toHaveCount(0);
  await expect.poll(async () => JSON.parse((await storedSession(page))!).refreshToken).not.toBe(before.refreshToken);
  expect(refreshes).toBe(1);
  await sendTo(page, c2cId(u.username, u.username), 'after refresh');
  await ctx.close();
});

test('TC-ACC-03-12 刷新返回 503：留在当前页退避，成功后恢复', async ({ browser }) => {
  const u = await apiRegister();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.clock.install();
  await accountLogin(page, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  await page.waitForTimeout(300);
  let n = 0;
  await page.route('**/v1/account/token/refresh', (r) => {
    n += 1;
    return n === 1 ? r.fulfill({ status: 503, json: { code: 5030, msg: 'x' } }) : r.fallback();
  });
  const s = JSON.parse((await storedSession(page))!) as { accessExpiresAt: number; refreshToken: string };
  const now = await page.evaluate(() => Date.now());
  await page.clock.fastForward(s.accessExpiresAt - SIX_HOURS - now + 60_000);
  await expect.poll(() => n).toBeGreaterThanOrEqual(1);
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
  await page.clock.fastForward(3000);
  await expect.poll(() => n, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => JSON.parse((await storedSession(page))!).refreshToken).not.toBe(s.refreshToken);
  await ctx.close();
});

test('TC-ACC-03-26 replayDetected（假接口）：刷新得到 4019，弹窗，确定后 token 清除', async ({ browser }) => {
  const u = await apiRegister();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**/v1/account/token/refresh', (r) =>
    r.fulfill({ status: 401, json: { code: 4019, msg: 'x', reason: 'replayDetected' } }),
  );
  await accountLogin(page, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  // 让 access 看起来已过期，刷新页面走 start 入口
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('tt.session')!);
    s.accessExpiresAt = Date.now() - 1000;
    sessionStorage.setItem('tt.session', JSON.stringify(s));
  });
  await page.reload();
  await expect(page.getByTestId('kicked-dialog')).toContainText(
    '检测到登录凭证异常，这台设备已下线。如果不是你本人操作，请尽快改密码',
  );
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await storedSession(page)).toBeNull();
  await ctx.close();
});

test('TC-ACC-03-34 离线受害者遇到攻击者改密：access 未过期收 kicked，已过期刷新得 4019，都显示找回日期', async ({
  browser,
}) => {
  const v = await apiRegister('vic');
  const a = await goOffline(await accountPage(browser, v.username));
  const b = await goOffline(await accountPage(browser, v.username));
  const x = await api('/v1/account/login', { username: v.username, password: PASSWORD, platform: 'android' });
  const r = await api(
    '/v1/account/password',
    { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
    (x.data as unknown as { accessToken: string }).accessToken,
  );
  expect(r.status).toBe(200);
  const want = `你的账号凭证有变化。如果不是你本人操作，请在 ${dateOf(Date.now() + 7 * 86_400_000)} 前用恢复码找回`;
  const da = await comeBack(browser, a);
  await expect(da.getByTestId('kicked-dialog')).toContainText(want);
  const ctx = await browser.newContext();
  const db = await ctx.newPage();
  await db.goto('/login');
  await db.evaluate((raw) => {
    const s = JSON.parse(raw);
    s.accessExpiresAt = Date.now() - 1000;
    sessionStorage.setItem('tt.session', JSON.stringify(s));
  }, b);
  const refreshResp = db.waitForResponse('**/v1/account/token/refresh');
  await db.goto('/chats');
  const resp = await refreshResp;
  expect(resp.status()).toBe(401);
  expect(((await resp.json()) as { reason: string }).reason).toBe('credentialsChanged');
  await expect(db.getByTestId('kicked-dialog')).toContainText(want);
  await expect(db.getByTestId('kicked-dialog')).not.toContainText('凭证异常');
  await da.context().close();
  await ctx.close();
});

test('TC-ACC-04-05 D1 改密：D2 不重连，弹窗显示日期，确定后清空回登录页', async ({ browser }) => {
  const u = await apiRegister();
  const d1 = await accountPage(browser, u.username);
  const d2 = await accountPage(browser, u.username);
  await d2.waitForTimeout(300);
  let reconnects = 0;
  d2.on('websocket', () => (reconnects += 1));
  await d1.goto('/me/settings/security/password');
  await d1.getByTestId('password-old').fill(PASSWORD);
  await d1.getByTestId('password-new').fill(NEW_PASSWORD);
  await d1.getByTestId('password-submit').click();
  await expect(d1.getByTestId('recovery-code')).toBeVisible();
  expect(await storedSession(d1)).toBeNull();
  await d1.getByTestId('recovery-ack').click();
  await expect(d1.getByTestId('recovery-page')).toHaveCount(0);
  expect(await storedSession(d1)).not.toBeNull();
  await d1
    .getByTestId('kicked-dialog')
    .waitFor({ state: 'detached', timeout: 1000 })
    .catch(() => {});

  await expect(d2.getByTestId('kicked-dialog')).toContainText(
    `请在 ${dateOf(Date.now() + 7 * 86_400_000)} 前用恢复码找回`,
  );
  await d2.waitForTimeout(5000);
  expect(reconnects).toBe(0);
  await d2.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(d2).toHaveURL(/\/login/);
  expect(await storedSession(d2)).toBeNull();
  // D1 用新 sid 正常收发（改密不把自己踢掉）
  await sendTo(d1, c2cId(u.username, u.username), 'after password change');
  await d1.context().close();
  await d2.context().close();
});

test('TC-ACC-04-09 退出其他设备：密码错原地提示；密码对 D2 下线，D1 换 sid 重连，无提示，密码不变', async ({
  browser,
}) => {
  const u = await apiRegister();
  const d1 = await accountPage(browser, u.username);
  const d2 = await accountPage(browser, u.username);
  await d1.goto('/me/settings/security');
  await d1.getByTestId('security-logout-others').click();
  await d1.getByTestId('logoutOthers-password').fill('wrong-password-1');
  await d1.getByTestId('logoutOthers-ok').click();
  await expect(d1.getByTestId('logoutOthers-error')).toHaveText('密码错误');
  await expect(d2.getByTestId('kicked-dialog')).toHaveCount(0);
  const sidBefore = JSON.parse((await storedSession(d1))!).refreshToken.split('.')[1];
  await d1.getByTestId('logoutOthers-password').fill(PASSWORD);
  await d1.getByTestId('logoutOthers-ok').click();
  await expect(d1.getByTestId('toast')).toHaveText('已退出其他设备');
  await expect(d2.getByTestId('kicked-dialog')).toBeVisible();
  await expect(d1.getByTestId('kicked-dialog')).toHaveCount(0);
  await expect(d1.getByText('连接中')).toHaveCount(0);
  expect(JSON.parse((await storedSession(d1))!).refreshToken.split('.')[1]).not.toBe(sidBefore);
  await sendTo(d1, c2cId(u.username, u.username), 'after logout others');
  expect(
    (await api('/v1/account/login', { username: u.username, password: PASSWORD, platform: 'android' })).status,
  ).toBe(200);
  await d1.context().close();
  await d2.context().close();
});

test('TC-ACC-04-15 改密响应丢失：提示失败，踢线生效，不弹"凭证异常"；用新密码登录拿到更新的码', async ({ browser }) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  await page.waitForTimeout(300);
  await page.route('**/v1/account/password', async (r) => {
    await r.fetch(); // 服务端已提交
    await r.abort(); // 响应丢失
  });
  await page.goto('/me/settings/security/password');
  await page.getByTestId('password-old').fill(PASSWORD);
  await page.getByTestId('password-new').fill(NEW_PASSWORD);
  await page.getByTestId('password-submit').click();
  await expect(page.getByTestId('password-error')).toHaveText('网络异常，请稍后重试');
  await expect(page.getByTestId('kicked-dialog')).toContainText('你的账号凭证有变化');
  await expect(page.getByTestId('kicked-dialog')).not.toContainText('凭证异常');
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  await page.unroute('**/v1/account/password');
  await accountLogin(page, u.username, NEW_PASSWORD);
  await expect(page.getByTestId('recovery-code')).toBeVisible();
  await page.context().close();
});

test.describe('TC-ACC-04-24 四条序列都显示第 7 天', () => {
  const day7 = () => dateOf(Date.now() + 7 * 86_400_000);
  const tokenOf = (r: { data: unknown }) => (r.data as { accessToken: string }).accessToken;
  const xLogin = async (username: string, password = PASSWORD) =>
    tokenOf(await api('/v1/account/login', { username, password, platform: 'android' }));

  test('序列甲：X 先退出其他设备再改密；受害者第 1 天上线', async ({ browser }) => {
    const v = await apiRegister('seq');
    const saved = await goOffline(await accountPage(browser, v.username));
    const o = await api('/v1/account/logout-others', { password: PASSWORD }, await xLogin(v.username));
    expect(o.status).toBe(200);
    expect(
      (await api('/v1/account/password', { oldPassword: PASSWORD, newPassword: NEW_PASSWORD }, tokenOf(o))).status,
    ).toBe(200);
    const page = await comeBack(browser, saved);
    await expect(page.getByTestId('kicked-dialog')).toContainText(`请在 ${day7()} 前用恢复码找回`);
    await page.context().close();
  });

  test('序列乙：X 改密后申请注销；受害者上线', async ({ browser }) => {
    const v = await apiRegister('seq');
    const saved = await goOffline(await accountPage(browser, v.username));
    const c = await api(
      '/v1/account/password',
      { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
      await xLogin(v.username),
    );
    expect(c.status).toBe(200);
    expect((await api('/v1/account/delete', { password: NEW_PASSWORD }, tokenOf(c))).status).toBe(200);
    const page = await comeBack(browser, saved);
    await expect(page.getByTestId('kicked-dialog')).toContainText(`请在 ${day7()} 前用恢复码找回`);
    await page.context().close();
  });

  test('序列丁：C1 第 0 天换代后，受害者在线时 X 退出其他设备', async ({ browser }) => {
    const v = await apiRegister('seq');
    const c = await api(
      '/v1/account/password',
      { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
      await xLogin(v.username),
    );
    expect(c.status).toBe(200);
    const gen = (c.data as unknown as { recoveryCodeGen: number }).recoveryCodeGen;
    expect((await api('/v1/account/recovery-code/ack', { gen }, tokenOf(c))).status).toBe(200);
    const page = await accountPage(browser, v.username, undefined, NEW_PASSWORD);
    await page.waitForTimeout(300);
    expect((await api('/v1/account/logout-others', { password: NEW_PASSWORD }, tokenOf(c))).status).toBe(200);
    await expect(page.getByTestId('kicked-dialog')).toContainText(`请在 ${day7()} 前用恢复码找回`);
    await page.context().close();
  });
});

test('TC-ACC-05-18 场景一：已登录，recovery-code 响应丢失：刷新后强制进保存页，输入密码拿到新码，确认后解除', async ({
  browser,
}) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  const x = await api('/v1/account/login', { username: u.username, password: PASSWORD, platform: 'android' });
  const r = await api(
    '/v1/account/recovery-code',
    { password: PASSWORD },
    (x.data as unknown as { accessToken: string }).accessToken,
  );
  expect(r.status).toBe(200); // 响应丢给了"丢失"：页面没有见过这个码
  await page.reload();
  await expect(page.getByTestId('recovery-page')).toBeVisible();
  await expect(page.getByTestId('tab-chats')).toHaveCount(0);
  await page.getByTestId('recovery-password').fill('wrong-password-1');
  await page.getByTestId('recovery-regenerate').click();
  await expect(page.getByTestId('recovery-error')).toHaveText('密码错误');
  await page.getByTestId('recovery-password').fill(PASSWORD);
  await page.getByTestId('recovery-regenerate').click();
  const code = await page.getByTestId('recovery-code').textContent();
  expect(code).not.toBe(u.recoveryCode);
  await page.getByTestId('recovery-ack').click();
  await expect(page.getByTestId('recovery-page')).toHaveCount(0);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  await page.context().close();
});

test('TC-ACC-05-18 场景二：改密响应到达后在保存页刷新：token 没有落盘，回登录页，用新密码登录拿到新码', async ({
  browser,
}) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  await page.goto('/me/settings/security/password');
  await page.getByTestId('password-old').fill(PASSWORD);
  await page.getByTestId('password-new').fill(NEW_PASSWORD);
  await page.getByTestId('password-submit').click();
  const first = await page.getByTestId('recovery-code').textContent();
  expect(await storedSession(page)).toBeNull(); // 旧 token 也清了（问题 8）
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId('kicked-dialog')).toHaveCount(0);
  await accountLogin(page, u.username, NEW_PASSWORD);
  const second = await page.getByTestId('recovery-code').textContent();
  expect(second).not.toBe(first);
  await page.context().close();
});

test('TC-ACC-06-05 改昵称："我"页和聊天页立即显示，其他端 9 分钟还是旧值，10 分钟后更新（SDK 钟）', async ({
  browser,
}) => {
  const u1 = await apiRegister('nick');
  const d1 = await accountPage(browser, u1.username);
  const peer = uid('peer');
  // u2：演示用户，先看过 u1 的昵称。
  const ctx2 = await browser.newContext();
  const d2 = await ctx2.newPage();
  await d2.clock.install();
  await d2.goto('/login');
  await d2.getByTestId('login-username').fill(peer);
  await d2.getByTestId('login-username').press('Enter');
  await expect(d2).not.toHaveURL(/\/login/);
  const conv = c2cId(u1.username, peer);
  const profileUrl = `/user/${encodeURIComponent(u1.username)}`;
  await d2.goto(profileUrl);
  await expect(d2.locator('body')).toContainText(u1.username);

  await d1.goto('/me');
  await d1.getByTestId('me-edit').click();
  await d1.getByTestId('nickname-input').fill('新昵称');
  await d1.getByTestId('nickname-done').click();
  await expect(d1.getByTestId('me-name')).toContainText('新昵称');
  await d1.goto(chatUrl(c2cId(u1.username, u1.username)));
  await expect(d1.locator('.tt-topbar-title')).toContainText('新昵称');
  await d1.goto(chatUrl(conv));
  await d1.getByTestId('composer-input').fill('hi');
  await d1.getByTestId('composer-input').press('Enter');
  await expect(d1.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');

  // 其他端不刷新页面（缓存在内存），站内切页再回来：9 分钟旧值，超过 10 分钟新值。
  const revisit = async () => {
    await d2.evaluate(() => {
      history.pushState(null, '', '/me');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(d2.getByTestId('me-settings')).toBeVisible();
    await d2.evaluate((url) => {
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, profileUrl);
  };
  await d2.clock.fastForward(9 * 60_000);
  await revisit();
  await expect(d2.locator('body')).toContainText(u1.username);
  await d2.waitForTimeout(500);
  await expect(d2.locator('body')).not.toContainText('新昵称');
  await d2.clock.fastForward(61_000 + 5_000);
  await revisit();
  await expect(d2.locator('body')).toContainText('新昵称', { timeout: 15_000 });
  await d1.context().close();
  await ctx2.close();
});

test('TC-ACC-06-05 宽屏：改昵称后左栏"我"不用重新挂载就显示新昵称', async ({ browser }) => {
  const u = await apiRegister('nick');
  const page = await accountPage(browser, u.username, WIDE);
  await page.goto('/me/profile');
  await expect(page.getByTestId('me-name')).toContainText(u.username);
  await page.getByTestId('nickname-input').fill('宽屏昵称');
  await page.getByTestId('nickname-done').click();
  await expect(page.getByTestId('me-name')).toContainText('宽屏昵称');
  await page.context().close();
});

test('TC-ACC-08-06 注销确认框的文字；错误密码原地提示；正确密码后回登录页，冷静期内可撤销', async ({ browser }) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  await page.goto('/me/settings/security');
  await page.getByTestId('security-delete').click();
  await expect(page.getByTestId('delete-dialog')).toContainText('7 天后不可恢复，用户名不能再使用，已发的消息会保留');
  await page.getByTestId('delete-password').fill('wrong-password-1');
  await page.getByTestId('delete-ok').click();
  await expect(page.getByTestId('delete-error')).toHaveText('密码错误');
  await expect(page).toHaveURL(/\/me\/settings\/security$/);
  await page.getByTestId('delete-password').fill(PASSWORD);
  await page.getByTestId('delete-ok').click();
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await storedSession(page)).toBeNull();
  await accountLogin(page, u.username);
  await expect(page.getByTestId('delete-pending-dialog')).toContainText('账号正在注销');
  await page.getByTestId('delete-cancel-ok').click();
  await expect(page.getByTestId('toast')).toContainText('已撤销注销');
  await accountLogin(page, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  await page.context().close();
});

test('退出登录：界面不等 logout 返回；logout 挂起时存储已清空；服务端随后吊销', async ({ browser }) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  const raw = JSON.parse((await storedSession(page))!) as { refreshToken: string };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/v1/account/logout', async (r) => {
    await held;
    await r.fallback();
  });
  await page.goto('/me/settings');
  await page.getByTestId('logout').click();
  await page.getByTestId('logout-dialog').getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await storedSession(page)).toBeNull();
  const done = page.waitForResponse('**/v1/account/logout');
  release();
  expect((await done).status()).toBe(200);
  const r = await api('/v1/account/token/refresh', { refreshToken: raw.refreshToken });
  expect(r.status).toBe(401);
  await page.context().close();
});

test('日志和 URL 不带凭证（CH-26）：注册、登录、刷新、改密全流程搜不到 token、refresh、恢复码、密码', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs: string[] = [];
  const urls: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e)));
  page.on('request', (r) => urls.push(r.url()));
  page.on('websocket', (w) => urls.push(w.url()));
  page.on('framenavigated', (f) => urls.push(f.url()));
  const u = await apiRegister();
  await accountLogin(page, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  const stored = JSON.parse((await storedSession(page))!) as { accessToken: string; refreshToken: string };
  await page.goto('/me/settings/security/password');
  await page.getByTestId('password-old').fill(PASSWORD);
  await page.getByTestId('password-new').fill(NEW_PASSWORD);
  await page.getByTestId('password-submit').click();
  const code = (await page.getByTestId('recovery-code').textContent())!;
  await page.getByTestId('recovery-ack').click();
  await expect(page.getByTestId('recovery-page')).toHaveCount(0);
  const now = JSON.parse((await storedSession(page))!) as { accessToken: string; refreshToken: string };
  const text = logs.join('\n') + '\n' + urls.join('\n');
  for (const secret of [
    stored.accessToken,
    stored.refreshToken,
    now.accessToken,
    now.refreshToken,
    code,
    u.recoveryCode,
    PASSWORD,
    NEW_PASSWORD,
  ]) {
    expect(text).not.toContain(secret);
  }
  const local = await page.evaluate(() => JSON.stringify(localStorage));
  for (const secret of [now.accessToken, now.refreshToken, code]) expect(local).not.toContain(secret);
  await ctx.close();
});
