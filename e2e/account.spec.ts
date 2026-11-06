import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  accountLogin,
  accountPage,
  api,
  apiRegister,
  fakeConfig,
  invite,
  loginAs,
  NEW_PASSWORD,
  PASSWORD,
  storedSession,
  uid,
} from './helpers';
import { NODEMO } from './ports';

// FE-613：登录、注册、恢复码、配置。环境：本机 Chrome，真实 im-server（测试模式，SQLite），"假接口"的地方用 page.route。

const fillRegister = async (page: import('@playwright/test').Page, username: string, code: string) => {
  await page.getByTestId('register-username').fill(username);
  await page.getByTestId('register-password').fill(PASSWORD);
  await page.getByTestId('register-invite').fill(code);
};

test('TC-ACC-01-12 注册成功进入保存恢复码页，确认前进不了会话列表，确认前存储没有 token', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/login/account');
  await page.getByTestId('go-register').click();
  await fillRegister(page, uid('reg').toLowerCase(), await invite());
  await page.getByTestId('register-submit').click();
  const code = (await page.getByTestId('recovery-code').textContent())!;
  expect(code.length).toBeGreaterThan(16);
  await expect(page.getByTestId('recovery-warning')).toHaveText('恢复码丢失后账号无法找回');
  await expect(page.getByRole('button', { name: '我已保存' })).toHaveCount(1);
  expect(await storedSession(page)).toBeNull();

  await page.getByTestId('recovery-copy').click();
  await expect(page.getByTestId('recovery-copy-status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  // 后退、直接改路由都还在保存页。
  await page.goBack();
  await expect(page.getByTestId('recovery-page')).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, '', '/chats');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('tab-chats')).toHaveCount(0);
  expect(await storedSession(page)).toBeNull();
  const ack = page.waitForRequest('**/v1/account/recovery-code/ack');
  await page.getByTestId('recovery-ack').click();
  await ack;
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  expect(JSON.parse((await storedSession(page))!).mode).toBe('account');
});

test('TC-ACC-01-12 反例：刷新保存页回登录页，token 没有持久化', async ({ page }) => {
  await page.goto('/register');
  await fillRegister(page, uid('reg').toLowerCase(), await invite());
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('recovery-code')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('recovery-page')).toHaveCount(0);
  expect(await storedSession(page)).toBeNull();
});

test('TC-ACC-01-13 用户名已占用：提示在用户名框下方，其他输入保留', async ({ page }) => {
  const taken = await apiRegister();
  const code = await invite();
  await page.goto('/register');
  await fillRegister(page, taken.username, code);
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-username-error')).toHaveText('这个用户名不能使用');
  await expect(page.getByTestId('register-password')).toHaveValue(PASSWORD);
  await expect(page.getByTestId('register-invite')).toHaveValue(code);
  await expect(page).toHaveURL(/\/register$/);
});

test('TC-ACC-01-18 注册页各种错误的文案，已填内容保留，按钮恢复（假接口）', async ({ page }) => {
  await page.goto('/register');
  await fillRegister(page, 'someone', 'INV');
  const cases: [number, object, string][] = [
    [400, { code: 4004, msg: 'x' }, '用户名格式不正确'],
    [400, { code: 4000, msg: 'x', reason: 'passwordWeak' }, '密码太简单'],
    [403, { code: 4030, msg: 'x', reason: 'inviteInvalid' }, '邀请码无效'],
    [429, { code: 4290, msg: 'x' }, '操作太频繁，请稍后再试'],
    [503, { code: 5030, msg: 'x' }, '服务暂不可用'],
  ];
  for (const [status, json, want] of cases) {
    await page.route('**/v1/account/register', (r) => r.fulfill({ status, json }));
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('register-error')).toHaveText(want);
    await expect(page.getByTestId('register-submit')).toBeEnabled();
    await expect(page.getByTestId('register-username')).toHaveValue('someone');
    await expect(page.getByTestId('register-password')).toHaveValue(PASSWORD);
    await expect(page.getByTestId('register-invite')).toHaveValue('INV');
    await page.unroute('**/v1/account/register');
  }
  await page.route('**/v1/account/register', (r) => r.abort());
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-error')).toHaveText('网络异常，请稍后重试');
  await expect(page.getByTestId('register-invite')).toHaveValue('INV');
});

test('TC-ACC-02-08 4018：密码框清空，用户名保留（真实服务端）', async ({ page }) => {
  const u = await apiRegister();
  await accountLogin(page, u.username, 'wrong-password-1');
  await expect(page.getByTestId('account-error')).toHaveText('用户名或密码错误');
  await expect(page.getByTestId('account-password')).toHaveValue('');
  await expect(page.getByTestId('account-username')).toHaveValue(u.username);
  await expect(page.getByTestId('go-forgot')).toBeVisible();
});

test('TC-ACC-02-09 4294：显示分钟数，5 秒内只有 1 个登录请求（假接口）', async ({ page }) => {
  let calls = 0;
  await page.route('**/v1/account/login', (r) => {
    calls += 1;
    return r.fulfill({ status: 429, json: { code: 4294, msg: 'x', details: { retryAfterSeconds: 600 } } });
  });
  await accountLogin(page, 'someone', PASSWORD);
  await expect(page.getByTestId('account-error')).toHaveText('尝试次数过多，请 10 分钟后再试');
  await page.waitForTimeout(5000);
  expect(calls).toBe(1);
});

test('TC-ACC-02-13 新设备登录：在线设备 2 秒内提示，账号安全页有记录，响应没有 IP 全文和 sid', async ({ browser }) => {
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  await page.waitForTimeout(500); // 等 auth 完成，在线
  const t0 = Date.now();
  await api('/v1/account/login', { username: u.username, password: PASSWORD, platform: 'android' });
  await expect(page.getByTestId('toast')).toHaveText('你的账号在新设备登录', { timeout: 2000 });
  expect(Date.now() - t0).toBeLessThan(2000);
  await page.getByTestId('tab-me').click();
  await page.getByTestId('me-settings').click();
  await page.getByTestId('settings-security').click();
  await expect(page.getByTestId('security-event').first()).toContainText('新设备登录（Android）');
  await expect(page.getByTestId('security-other-sessions')).toContainText('其他');
  await page.context().close();
});

test('TC-ACC-05-04 找回成功：显示新恢复码，确认后进入会话列表；旧密码失效', async ({ page }) => {
  const u = await apiRegister();
  await page.goto('/forgot');
  await page.getByTestId('forgot-username').fill(u.username);
  await page.getByTestId('forgot-code').fill(u.recoveryCode);
  await page.getByTestId('forgot-password').fill(NEW_PASSWORD);
  await page.getByTestId('forgot-submit').click();
  const code = await page.getByTestId('recovery-code').textContent();
  expect(code).not.toBe(u.recoveryCode);
  expect(await storedSession(page)).toBeNull();
  await page.getByTestId('recovery-ack').click();
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  const old = await api('/v1/account/login', { username: u.username, password: PASSWORD, platform: 'web' });
  expect(old.status).toBe(401);
});

test('TC-ACC-05-06 在保存页刷新：再次进入保存页，新码，确认前存储没有 token', async ({ page }) => {
  const u = await apiRegister('acc', false);
  await accountLogin(page, u.username);
  const first = await page.getByTestId('recovery-code').textContent();
  expect(first).not.toBe(u.recoveryCode);
  expect(await storedSession(page)).toBeNull();
  const local = await page.evaluate(() => JSON.stringify(localStorage));
  expect(local).not.toContain(first!);
  await page.reload();
  await expect(page.getByTestId('recovery-page')).toHaveCount(0);
  await accountLogin(page, u.username);
  const second = await page.getByTestId('recovery-code').textContent();
  expect(second).not.toBe(first);
  await page.getByTestId('recovery-ack').click();
  await expect(page.getByTestId('tab-chats')).toBeVisible();
});

test('TC-ACC-05-09 注册页、保存页、忘记密码页都有"丢失后无法找回"，都没有客服入口', async ({ page }) => {
  const noSupport = async () => expect(await page.locator('body').innerText()).not.toMatch(/客服|联系我们/);
  await page.goto('/register');
  await expect(page.locator('body')).toContainText('恢复码丢失后账号无法找回');
  await noSupport();
  await page.goto('/forgot');
  await expect(page.locator('body')).toContainText('恢复码丢失后账号无法找回');
  await noSupport();
  await page.goto('/register');
  await fillRegister(page, uid('reg').toLowerCase(), await invite());
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('recovery-warning')).toContainText('恢复码丢失后账号无法找回');
  await noSupport();
});

test('TC-ACC-05-14 recoveryCodeStale：提示后回登录页（假接口）', async ({ page }) => {
  const u = await apiRegister('acc', false);
  await page.route('**/v1/account/recovery-code/ack', (r) =>
    r.fulfill({ status: 400, json: { code: 4000, msg: 'x', reason: 'recoveryCodeStale' } }),
  );
  await accountLogin(page, u.username);
  await page.getByTestId('recovery-ack').click();
  await expect(page.getByTestId('kicked-dialog')).toHaveText(/恢复码已更新，请重新登录查看/);
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId('recovery-page')).toHaveCount(0);
  expect(await storedSession(page)).toBeNull();
});

test('TC-ACC-07-05 demoLogin=false、invite：账号表单和注册入口，没有演示表单和"业务方"', async ({ page }) => {
  await fakeConfig(page, { demoLogin: false, registerMode: 'invite' });
  await page.goto('/login');
  await expect(page.getByTestId('account-username')).toBeVisible();
  await expect(page.getByTestId('account-password')).toBeVisible();
  await expect(page.getByTestId('login-username')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('业务方');
  await page.getByTestId('go-register').click();
  await expect(page.getByTestId('register-invite')).toBeVisible();
});

test('TC-ACC-07-06 demoLogin=true：演示表单照常（真实服务端），有"使用账号登录"入口', async ({ browser }) => {
  const page = await loginAs(browser, uid('demo'));
  await expect(page).toHaveURL(/\/chats$/);
  await page.context().close();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/login');
  await expect(p.getByTestId('login-username')).toBeVisible();
  await expect(p.getByTestId('login-nickname')).toBeVisible();
  await p.getByTestId('use-account-login').click();
  await expect(p.getByTestId('account-username')).toBeVisible();
  await ctx.close();
});

test.describe('TC-ACC-07-07 构建开关是上限（真实生产构建）', () => {
  test.use({ baseURL: NODEMO });
  test('构建开关关 + demoLogin=true：不显示演示表单', async ({ page }) => {
    await fakeConfig(page, { demoLogin: true });
    await page.goto('/login');
    await expect(page.getByTestId('account-username')).toBeVisible();
    await expect(page.getByTestId('login-username')).toHaveCount(0);
  });
  test('真实服务端（IM_DEMO_LOGIN=1）+ 构建开关关：不显示演示表单，账号能登录', async ({ page }) => {
    const u = await apiRegister();
    await page.goto('/login');
    await expect(page.getByTestId('login-username')).toHaveCount(0);
    await page.getByTestId('account-username').fill(u.username);
    await page.getByTestId('account-password').fill(PASSWORD);
    await page.getByTestId('account-submit').click();
    await expect(page.getByTestId('tab-chats')).toBeVisible();
  });
});

test('TC-ACC-07-07 构建开关开 + demoLogin=false：不显示演示表单', async ({ page }) => {
  await fakeConfig(page, { demoLogin: false });
  await page.goto('/login');
  await expect(page.getByTestId('account-username')).toBeVisible();
  await expect(page.getByTestId('login-username')).toHaveCount(0);
});

test('TC-ACC-07-08 演示会话没有"账号安全"，账号会话有', async ({ browser }) => {
  const demo = await loginAs(browser, uid('demo'), '/me/settings');
  await expect(demo.getByTestId('settings-privacy')).toBeVisible();
  await expect(demo.getByTestId('settings-security')).toHaveCount(0);
  await demo.goto('/me/settings/security');
  await expect(demo).toHaveURL(/\/me\/settings$/);
  await demo.context().close();
  const u = await apiRegister();
  const page = await accountPage(browser, u.username);
  await page.goto('/me/settings');
  await expect(page.getByTestId('settings-security')).toBeVisible();
  await page.context().close();
});

test('TC-ACC-07-09 closed 没有注册入口；config 失败不猜测模式；恢复后按配置显示', async ({ page }) => {
  await fakeConfig(page, { registerMode: 'closed' });
  await page.goto('/login');
  await expect(page.getByTestId('account-username')).toBeVisible();
  await expect(page.getByTestId('go-register')).toHaveCount(0);
  await page.unroute('**/v1/config');

  await page.route('**/v1/config', (r) => r.abort());
  await page.goto('/login');
  await expect(page.getByTestId('config-error')).toHaveText('网络异常，请稍后重试');
  for (const id of ['login-username', 'account-username', 'go-register', 'go-forgot']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  await page.unroute('**/v1/config');
  await fakeConfig(page, { registerMode: 'open' });
  await page.getByTestId('config-retry').click();
  await expect(page.getByTestId('go-register')).toBeVisible();
});

test('TC-ACC-09-01 maxUses=2：两个用户在 H5 注册成功，第三个"邀请码无效"（后台页面属于 FE-619，这里查管理接口）', async ({
  page,
  browser,
}) => {
  const code = await invite(2);
  for (const name of ['r1', 'r2']) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/register');
    await fillRegister(p, uid(name).toLowerCase(), code);
    await p.getByTestId('register-submit').click();
    await expect(p.getByTestId('recovery-code')).toBeVisible();
    await ctx.close();
  }
  await page.goto('/register');
  await fillRegister(page, uid('r3').toLowerCase(), code);
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-error')).toHaveText('邀请码无效');
});

test.describe('TC-ACC-10 隐私说明', () => {
  const privacyNotice = { version: 'v1', url: '/privacy-test.html' };

  test('TC-ACC-10-01 登录页、注册页、关于天听都能打开；500 提示打不开，不阻止登录；配置为空时隐藏', async ({
    page,
    browser,
  }) => {
    await fakeConfig(page, { privacyNotice });
    let status = 200;
    await page
      .context()
      .route('**/privacy-test.html', (r) => r.fulfill({ status, contentType: 'text/html', body: 'ok' }));
    await page.goto('/login');
    const [popup] = await Promise.all([page.context().waitForEvent('page'), page.getByTestId('privacy-link').click()]);
    await expect.poll(() => popup.url()).toContain('/privacy-test.html');
    await popup.close();
    await page.goto('/register');
    await expect(page.getByTestId('register-privacy')).toContainText('注册即表示你已阅读');
    await expect(page.getByTestId('privacy-link')).toBeVisible();
    status = 500;
    await page.getByTestId('privacy-link').click();
    await expect(page.getByTestId('privacy-error')).toContainText('暂时打不开，请稍后重试');
    await expect(page.getByTestId('register-submit')).toBeVisible();

    const u = await apiRegister();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await fakeConfig(p, { privacyNotice });
    await accountLogin(p, u.username);
    await p.getByTestId('privacy-update-ok').click();
    await p.goto('/me/settings');
    await expect(p.getByTestId('about').getByTestId('privacy-link')).toBeVisible();
    await ctx.close();

    const empty = await browser.newContext();
    const q = await empty.newPage();
    await fakeConfig(q, {});
    await q.goto('/login');
    await expect(q.getByTestId('account-username')).toBeVisible();
    await expect(q.getByTestId('privacy-link')).toHaveCount(0);
    await empty.close();
  });

  test('TC-ACC-10-03 版本更新：登录后提示一次，确认后再登录不提示', async ({ page }) => {
    const u = await apiRegister();
    await fakeConfig(page, { privacyNotice: { version: 'v2', url: '/privacy-test.html' } });
    await accountLogin(page, u.username);
    await expect(page.getByTestId('privacy-update-dialog')).toContainText('隐私说明已更新');
    await page.getByTestId('privacy-update-ok').click();
    await expect(page.getByTestId('privacy-update-dialog')).toHaveCount(0);
    await page.goto('/me/settings');
    await page.getByTestId('logout').click();
    await page.getByTestId('logout-dialog').getByRole('button', { name: '退出' }).click();
    await expect(page).toHaveURL(/\/login/);
    await accountLogin(page, u.username);
    await expect(page.getByTestId('tab-chats')).toBeVisible();
    await expect(page.getByTestId('privacy-update-dialog')).toHaveCount(0);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ui.privacyAck.')));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(u.username); // 退出后还留着的记录不写用户名
  });
});

test.describe('TC-CHAT-90-08 新页面的无障碍（Chrome，本地；FE-620 还要扩到三端）', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe：注册、找回、登录、保存恢复码、账号安全没有 button-name 违规，没有严重问题（${scheme}）`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const scan = async () => {
        const r = await new AxeBuilder({ page }).analyze();
        const bad = r.violations.filter(
          (v) => v.id === 'button-name' || v.impact === 'critical' || v.impact === 'serious',
        );
        expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
      };
      await page.goto('/login/account');
      await expect(page.getByTestId('account-username')).toBeVisible();
      await scan();
      await page.goto('/register');
      await expect(page.getByTestId('register-username')).toBeVisible();
      await scan();
      await page.goto('/forgot');
      await expect(page.getByTestId('forgot-username')).toBeVisible();
      await scan();
      await page.goto('/register');
      await fillRegister(page, uid('axe').toLowerCase(), await invite());
      await page.getByTestId('register-submit').click();
      await expect(page.getByTestId('recovery-code')).toBeVisible();
      await scan();
      await page.getByTestId('recovery-ack').click();
      await expect(page.getByTestId('tab-chats')).toBeVisible();
      await page.goto('/me/settings/security');
      await expect(page.getByTestId('security-other-sessions')).toBeVisible();
      await scan();
      await page.getByTestId('security-delete').click();
      await expect(page.getByTestId('delete-dialog')).toBeVisible();
      await scan();
    });
  }

  test('键盘：只用键盘走完注册和保存恢复码，焦点可见', async ({ page }) => {
    const code = await invite();
    await page.goto('/register');
    await page.getByTestId('register-username').focus();
    await page.keyboard.type(uid('kb').toLowerCase());
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Tab'); // 昵称
    await page.keyboard.press('Tab'); // 邀请码
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('recovery-code')).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'recovery-ack') break;
    }
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tab-chats')).toBeVisible();
  });
});
