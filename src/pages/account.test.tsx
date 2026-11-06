import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DELETE_WARNING, fatalText, RECOVERY_LOST_WARNING } from '../lib/accountText';
import { demoFormEnabled } from '../lib/config';
import { accountBench, authResponse, seedAccountSession, settle } from '../test/harness';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.unstubAllEnvs());

const type = (id: string, text: string) => fireEvent.change(screen.getByTestId(id), { target: { value: text } });
const text = (id: string) => screen.getByTestId(id).textContent;

async function fillLogin(b: ReturnType<typeof accountBench>, password = 'pw-correct-1') {
  await screen.findByTestId('account-username');
  type('account-username', 'alice');
  type('account-password', password);
  fireEvent.click(screen.getByTestId('account-submit'));
  await settle();
  return b.last('/v1/account/login');
}

async function fillRegister() {
  await screen.findByTestId('register-username');
  type('register-username', 'alice');
  type('register-password', 'pw-correct-1');
  if (screen.queryByTestId('register-invite')) type('register-invite', 'INV');
  fireEvent.click(screen.getByTestId('register-submit'));
  await settle();
}

const nodemo = { demoLogin: false };

describe('登录页和配置（FE-613）', () => {
  it('TC-ACC-07-05 demoLogin=false、invite：账号表单和注册入口，注册页有邀请码，没有演示表单和"业务方"', async () => {
    accountBench({ config: nodemo }).show('/login');
    await screen.findByTestId('account-username');
    expect(screen.getByTestId('account-password')).toBeInTheDocument();
    expect(screen.queryByTestId('login-username')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('业务方');
    fireEvent.click(screen.getByTestId('go-register'));
    expect(await screen.findByTestId('register-invite')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('业务方');
  });

  it('TC-ACC-07-06 demoLogin=true：演示表单照常，有"使用账号登录"入口', async () => {
    accountBench({ config: { demoLogin: true } }).show('/login');
    await screen.findByTestId('login-username');
    fireEvent.click(screen.getByTestId('use-account-login'));
    expect(await screen.findByTestId('account-username')).toBeInTheDocument();
  });

  it.each([
    ['false', true, false],
    ['false', false, false],
    [undefined, false, false],
    [undefined, true, true],
    ['true', true, true],
  ])('TC-ACC-07-07 构建开关 %s + demoLogin=%s：演示表单 %s（演示表单双开关）', async (flag, demoLogin, shown) => {
    if (flag !== undefined) vi.stubEnv('VITE_DEMO_LOGIN', flag);
    expect(demoFormEnabled({ demoLogin })).toBe(shown);
    accountBench({ config: { demoLogin } }).show('/login');
    await screen.findByTestId(shown ? 'login-username' : 'account-username');
    expect(!!screen.queryByTestId('login-username')).toBe(shown);
  });

  it('TC-ACC-07-09 closed 没有注册入口，直接打开注册页也不能注册', async () => {
    const b = accountBench({ config: { ...nodemo, registerMode: 'closed' } });
    const view = b.show('/login');
    await screen.findByTestId('account-username');
    expect(screen.queryByTestId('go-register')).not.toBeInTheDocument();
    view.unmount();
    b.show('/register');
    await screen.findByTestId('register-closed');
    expect(screen.queryByTestId('register-submit')).not.toBeInTheDocument();
  });

  it('TC-ACC-07-09 config 失败：显示错误和重试，不显示任何表单（不猜测模式），有旧缓存也一样；重试后按配置显示', async () => {
    localStorage.setItem('ui.config', JSON.stringify({ registerMode: 'open', demoLogin: true }));
    let up = false;
    const b = accountBench();
    b.http.onRequest = (c) => {
      if (c.path !== '/v1/config') return;
      if (up) c.respond(200, { registerMode: 'closed', demoLogin: false, features: { files: false }, limits: {} });
      else c.fail();
    };
    b.show('/login');
    expect(await screen.findByTestId('config-error')).toHaveTextContent('网络异常，请稍后重试');
    for (const id of ['login-username', 'account-username', 'go-register', 'go-forgot']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    up = true;
    fireEvent.click(screen.getByTestId('config-retry'));
    await screen.findByTestId('account-username');
    expect(screen.queryByTestId('go-register')).not.toBeInTheDocument();
  });

  it('TC-ACC-07-09 已登录时 config 失败用上次缓存，从未成功过时隐藏入口（F-ACC-07 规则 4）', async () => {
    const b = accountBench({ config: 'fail' });
    seedAccountSession(authResponse(b.clock));
    const view = b.show('/me/settings');
    await b.online();
    await screen.findByTestId('settings-security');
    expect(screen.queryByTestId('privacy-link')).not.toBeInTheDocument();
    view.unmount();
    localStorage.setItem(
      'ui.config',
      JSON.stringify({ registerMode: 'invite', demoLogin: false, privacyNotice: { version: 'v1', url: '/p.html' } }),
    );
    const c = accountBench({ config: 'fail' });
    seedAccountSession(authResponse(c.clock));
    c.show('/me/settings');
    await c.online();
    expect(within(screen.getByTestId('about')).getByTestId('privacy-link')).toBeInTheDocument();
  });

  it('TC-ACC-10-01 配置为空时登录、注册、关于天听都没有隐私入口；配置了就有', async () => {
    const privacyNotice = { version: 'v1', url: '/privacy.html' };
    const a = accountBench({ config: { ...nodemo, privacyNotice } });
    const view = a.show('/login');
    expect(await screen.findByTestId('privacy-link')).toHaveAttribute('rel', 'noopener noreferrer');
    view.unmount();
    const r = a.show('/register');
    expect(await screen.findByTestId('register-privacy')).toHaveTextContent('注册即表示你已阅读');
    r.unmount();
    const e = accountBench({ config: nodemo });
    e.show('/register');
    await screen.findByTestId('register-username');
    expect(screen.queryByTestId('privacy-link')).not.toBeInTheDocument();
  });

  it('TC-ACC-10-01 javascript: 地址不显示入口', async () => {
    accountBench({ config: { ...nodemo, privacyNotice: { version: 'v1', url: 'javascript:alert(1)' } } }).show(
      '/login',
    );
    await screen.findByTestId('account-username');
    expect(screen.queryByTestId('privacy-link')).not.toBeInTheDocument();
  });

  it('TC-ACC-10-03 隐私说明版本更新：登录后提示一次，确认后不再提示；注册时已告知不提示', async () => {
    const privacyNotice = { version: 'v2', url: '/privacy.html' };
    const login = async () => {
      const b = accountBench({ config: { ...nodemo, privacyNotice } });
      const view = b.show('/login');
      const call = await fillLogin(b);
      await act(async () => call.respond(200, authResponse(b.clock)));
      await b.online();
      return view;
    };
    const first = await login();
    expect(await screen.findByTestId('privacy-update-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('privacy-update-ok'));
    expect(screen.queryByTestId('privacy-update-dialog')).not.toBeInTheDocument();
    first.unmount();
    sessionStorage.clear();
    await login();
    expect(screen.queryByTestId('privacy-update-dialog')).not.toBeInTheDocument();
  });

  it('TC-ACC-10-03 不确认也能继续使用，下次登录再提示', async () => {
    const b = accountBench({ config: { ...nodemo, privacyNotice: { version: 'v2' } } });
    seedAccountSession(authResponse(b.clock));
    b.show('/chats');
    await b.online();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('privacy-update-dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('ui.privacyAck')).toBeNull();
  });
});

describe('注册页状态（FE-613，第 13.4 节）', () => {
  it('TC-ACC-01-13 4095：提示在用户名框下方，其他输入保留，留在注册页', async () => {
    const b = accountBench();
    b.show('/register');
    await fillRegister();
    await act(async () => b.last('/v1/account/register').respondError(409, 4095));
    await settle();
    expect(text('register-username-error')).toBe('这个用户名不能使用');
    expect(screen.getByTestId('register-username').parentElement).toContainElement(
      screen.getByTestId('register-username-error'),
    );
    expect(screen.getByTestId('register-password')).toHaveValue('pw-correct-1');
    expect(screen.getByTestId('register-invite')).toHaveValue('INV');
    expect(window.location.pathname).toBe('/register');
  });

  it.each([
    [400, 4004, undefined, '用户名格式不正确'],
    [400, 4000, 'passwordWeak', '密码太简单'],
    [403, 4030, 'inviteInvalid', '邀请码无效'],
    [429, 4290, undefined, '操作太频繁，请稍后再试'],
    [503, 5030, undefined, '服务暂不可用'],
  ])('TC-ACC-01-18 %s / %s：文案正确，已填内容保留，按钮恢复', async (status, code, reason, want) => {
    const b = accountBench();
    b.show('/register');
    await fillRegister();
    expect(screen.getByTestId('register-submit')).toHaveTextContent('提交中');
    expect(screen.getByTestId('register-submit')).toBeDisabled();
    await act(async () => b.last('/v1/account/register').respondError(status, code, { reason }));
    await settle();
    expect(text('register-error')).toBe(want);
    expect(screen.getByTestId('register-username')).toHaveValue('alice');
    expect(screen.getByTestId('register-password')).toHaveValue('pw-correct-1');
    expect(screen.getByTestId('register-submit')).toBeEnabled();
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-01-18 网络错误、响应不是约定的 JSON：网络异常，已填内容保留', async () => {
    const b = accountBench();
    b.show('/register');
    await fillRegister();
    await act(async () => b.last('/v1/account/register').fail());
    await settle();
    expect(text('register-error')).toBe('网络异常，请稍后重试');
    fireEvent.click(screen.getByTestId('register-submit'));
    await settle();
    await act(async () => b.last('/v1/account/register').respond(502, '<html>bad gateway</html>'));
    await settle();
    expect(text('register-error')).toBe('网络异常，请稍后重试');
  });

  it('TC-ACC-05-09 注册页、忘记密码页、保存页都有"丢失后无法找回"，都没有客服入口', async () => {
    const b = accountBench();
    const r = b.show('/register');
    await screen.findByTestId('register-username');
    expect(document.body.textContent).toContain(RECOVERY_LOST_WARNING);
    expect(document.body.textContent).not.toMatch(/客服|联系我们/);
    r.unmount();
    const f = b.show('/forgot');
    await screen.findByTestId('forgot-username');
    expect(document.body.textContent).toContain(RECOVERY_LOST_WARNING);
    expect(document.body.textContent).not.toMatch(/客服|联系我们/);
    f.unmount();
    b.show('/register');
    await fillRegister();
    await act(async () =>
      b
        .last('/v1/account/register')
        .respond(200, authResponse(b.clock, { extra: { recoveryCode: 'CODE-1', recoveryCodeGen: 1 } })),
    );
    await settle();
    expect(screen.getByTestId('recovery-warning')).toHaveTextContent(RECOVERY_LOST_WARNING);
    expect(document.body.textContent).not.toMatch(/客服|联系我们/);
  });
});

describe('保存恢复码（FE-613）', () => {
  async function toSavePage(path = '/register') {
    const b = accountBench();
    b.show(path);
    await fillRegister();
    await act(async () =>
      b
        .last('/v1/account/register')
        .respond(200, authResponse(b.clock, { extra: { recoveryCode: 'CODE-1', recoveryCodeGen: 3 } })),
    );
    await settle();
    return b;
  }

  it('TC-ACC-01-12 确认前进不了会话列表，只有一个"我已保存"；确认后才写存储、才连接（确认前不写存储）', async () => {
    const b = await toSavePage();
    expect(text('recovery-code')).toBe('CODE-1');
    expect(screen.getAllByRole('button', { name: '我已保存' })).toHaveLength(1);
    expect(screen.queryByTestId('tab-chats')).not.toBeInTheDocument();
    // 确认前存储里没有 token，也没有连接（F-ACC-05 规则 1）。
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem('tt.session')).toBeNull();
    expect(b.transport.connections).toHaveLength(0);
    // 后退、改地址都还是保存页。
    await act(async () => window.history.pushState(null, '', '/chats'));
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(screen.getByTestId('recovery-page')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    expect(b.last('/v1/account/recovery-code/ack').json).toEqual({ gen: 3 });
    expect(sessionStorage.length).toBe(0); // ack 成功才写
    await act(async () => b.last('/v1/account/recovery-code/ack').respond(200, {}));
    await settle();
    expect(screen.queryByTestId('recovery-page')).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).mode).toBe('account');
    expect(b.transport.connections).toHaveLength(1);
  });

  it('TC-ACC-01-12 第 13.4 节：复制成功和复制失败都有提示', async () => {
    await toSavePage();
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    fireEvent.click(screen.getByTestId('recovery-copy'));
    await waitFor(() => expect(text('recovery-copy-status')).toBe('已复制'));
    expect(write).toHaveBeenCalledWith('CODE-1');
    write.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByTestId('recovery-copy'));
    await waitFor(() => expect(text('recovery-copy-status')).toContain('复制失败'));
  });

  it('TC-ACC-05-06 确认网络错误：留在保存页，可以再点', async () => {
    const b = await toSavePage();
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code/ack').fail());
    await settle();
    expect(text('recovery-error')).toBe('网络异常，请稍后重试');
    expect(screen.getByTestId('recovery-ack')).toBeEnabled();
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-05-14 recoveryCodeStale：提示"恢复码已更新，请重新登录查看"，确定后回登录页', async () => {
    const b = await toSavePage();
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () =>
      b.last('/v1/account/recovery-code/ack').respondError(400, 4000, { reason: 'recoveryCodeStale' }),
    );
    await settle();
    const dialog = screen.getByTestId('kicked-dialog');
    expect(dialog).toHaveTextContent('恢复码已更新，请重新登录查看');
    fireEvent.click(within(dialog).getByText('确定'));
    await screen.findByTestId('login-username');
    expect(screen.queryByTestId('recovery-page')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-05-04 找回成功：显示新恢复码，确认后进入会话列表', async () => {
    const b = accountBench();
    b.show('/forgot');
    await screen.findByTestId('forgot-username');
    type('forgot-username', 'alice');
    type('forgot-code', 'OLD-CODE');
    type('forgot-password', 'pw-new-12345');
    fireEvent.click(screen.getByTestId('forgot-submit'));
    await settle();
    await act(async () =>
      b
        .last('/v1/account/recover')
        .respond(200, authResponse(b.clock, { sid: 's2', extra: { recoveryCode: 'NEW-CODE', recoveryCodeGen: 2 } })),
    );
    await settle();
    expect(text('recovery-code')).toBe('NEW-CODE');
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code/ack').respond(200, {}));
    await settle();
    expect(window.location.pathname).toBe('/chats');
  });

  it('TC-ACC-05-18 场景一：auth ack 带 recoveryCodeUnacked，强制进保存页，输入密码拿到新码，确认后解除', async () => {
    const b = accountBench({ config: nodemo });
    seedAccountSession(authResponse(b.clock));
    b.show('/chats');
    await b.online('alice', { recoveryCodeUnacked: true });
    expect(screen.getByTestId('recovery-page')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-ack')).not.toBeInTheDocument();
    type('recovery-password', 'wrong');
    fireEvent.click(screen.getByTestId('recovery-regenerate'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code').respondError(401, 4018));
    await settle();
    expect(text('recovery-error')).toBe('密码错误');
    type('recovery-password', 'pw-correct-1');
    fireEvent.click(screen.getByTestId('recovery-regenerate'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code').respond(200, { recoveryCode: 'C9', recoveryCodeGen: 9 }));
    await settle();
    expect(text('recovery-code')).toBe('C9');
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code/ack').respond(200, {}));
    await settle();
    expect(screen.queryByTestId('recovery-page')).not.toBeInTheDocument();
  });
});

describe('账号登录（FE-613）', () => {
  it('TC-ACC-02-08 4018：提示"用户名或密码错误"，密码框清空，用户名保留', async () => {
    const b = accountBench({ config: nodemo });
    b.show('/login');
    const call = await fillLogin(b);
    await act(async () => call.respondError(401, 4018));
    await settle();
    expect(text('account-error')).toBe('用户名或密码错误');
    expect(screen.getByTestId('account-password')).toHaveValue('');
    expect(screen.getByTestId('account-username')).toHaveValue('alice');
    expect(screen.getByTestId('go-forgot')).toBeInTheDocument(); // 登录失败页常驻（F-ACC-05 规则 5）
  });

  it('TC-ACC-02-09 4294：提示分钟数，不自动重试', async () => {
    const b = accountBench({ config: nodemo });
    b.show('/login');
    const call = await fillLogin(b);
    await act(async () => call.respondError(429, 4294, { details: { retryAfterSeconds: 600 } }));
    await settle();
    expect(text('account-error')).toBe('尝试次数过多，请 10 分钟后再试');
    act(() => b.clock.advance(3_600_000));
    await settle();
    expect(b.calls('/v1/account/login')).toHaveLength(1);
  });

  it('TC-ACC-08-04 冷静期内登录：提示日期和撤销；撤销走匿名接口', async () => {
    const b = accountBench({ config: nodemo });
    b.show('/login');
    const call = await fillLogin(b);
    const deleteAt = new Date(2031, 0, 2).getTime();
    await act(async () => call.respondError(403, 4030, { reason: 'accountDeletionPending', details: { deleteAt } }));
    await settle();
    expect(screen.getByTestId('delete-pending-dialog')).toHaveTextContent(
      '账号正在注销，2031-01-02后不可恢复，是否撤销？',
    );
    fireEvent.click(screen.getByTestId('delete-cancel-ok'));
    await settle();
    const cancel = b.last('/v1/account/delete/cancel');
    expect(cancel.json).toEqual({ username: 'alice', password: 'pw-correct-1' });
    expect(cancel.bearer).toBeUndefined();
    await act(async () => cancel.respond(200, {}));
    await settle();
    expect(screen.queryByTestId('delete-pending-dialog')).not.toBeInTheDocument();
  });

  it('登录成功没有恢复码：写存储、取锁、连接；用户名不进 URL（TC-ACC-03-09）', async () => {
    const b = accountBench({ config: nodemo });
    b.show('/login?redirect=%2Fme');
    const call = await fillLogin(b);
    expect(call.json).toMatchObject({ username: 'alice', platform: 'web' });
    await act(async () => call.respond(200, authResponse(b.clock)));
    await b.online();
    expect(window.location.pathname).toBe('/me');
    expect(window.location.href).not.toMatch(/nonce|pw-correct/);
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('nonce');
    expect(b.guard.claim).toHaveBeenCalledWith('s1');
  });
});

describe('会话（FE-614）', () => {
  const kick = (reason: string, extra: object = {}) => ({
    cmd: 'event',
    data: { type: 'kicked', reason, ...extra },
  });

  /** 已经登录、在线的账号会话。 */
  async function signedIn(path = '/chats', ttlMs?: number, config: Record<string, unknown> = nodemo) {
    const b = accountBench({ config });
    const resp = authResponse(b.clock, { ttlMs });
    seedAccountSession(resp);
    b.show(path);
    const c = await b.online();
    return { b, c, resp };
  }

  it('TC-ACC-03-09 刷新后取到锁才用 token；演示会话不取锁，老数据按演示', async () => {
    const { b } = await signedIn();
    expect(b.guard.claim).toHaveBeenCalledWith('s1');
    expect(b.transport.current.frames()[0]!.cmd).toBe('auth');
    expect(b.transport.current.url).not.toContain('nonce');
    const d = accountBench({ config: nodemo });
    sessionStorage.setItem('tt.session', JSON.stringify({ userId: 'old', token: 't' }));
    d.show('/me/settings');
    await d.online('old');
    expect(d.guard.claim).not.toHaveBeenCalled();
  });

  it('TC-ACC-07-08 演示会话没有"账号安全"，账号会话有；演示打开账号页回设置', async () => {
    const d = accountBench({ config: { demoLogin: true } });
    sessionStorage.setItem('tt.session', JSON.stringify({ userId: 'demo1', token: 't' }));
    const view = d.show('/me/settings');
    await d.online('demo1');
    expect(screen.queryByTestId('settings-security')).not.toBeInTheDocument();
    view.unmount();
    d.show('/me/settings/security');
    await d.online('demo1');
    expect(window.location.pathname).toBe('/me/settings');
    expect(screen.queryByTestId('me-edit')).not.toBeInTheDocument();
  });

  it('TC-ACC-03-14 拿不到锁：清掉这个页面的 token，回登录页，不发任何账号请求，不连接（多标签页互斥）', async () => {
    const b = accountBench({ claim: false, config: nodemo });
    seedAccountSession(authResponse(b.clock, { ttlMs: 60_000 })); // 快过期：如果交给 SDK 就会刷新
    b.show('/chats');
    await screen.findByTestId('account-username');
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
    expect(b.calls()).toHaveLength(0);
    expect(b.transport.connections).toHaveLength(0);
    expect(screen.getByTestId('tab-conflict')).toBeInTheDocument();
  });

  it('TC-ACC-03-14 刷新前再确认：确认失败不发刷新请求、不发 logout，本地结束会话回登录页', async () => {
    const { b } = await signedIn('/chats', 7 * 3_600_000);
    b.guard.confirm.mockResolvedValue(false);
    act(() => b.clock.advance(3_600_000 + 1000));
    await settle();
    expect(b.guard.confirm).toHaveBeenCalled();
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(0);
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('登录已失效，请重新登录');
    fireEvent.click(within(screen.getByTestId('kicked-dialog')).getByText('确定'));
    await settle();
    expect(b.calls('/v1/account/logout')).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-03-10 剩余不足 6 小时：自动刷新，1000 断开后用新 token 重连，不弹窗、无连接提示', async () => {
    const { b, c } = await signedIn('/chats', 6 * 3_600_000 + 60_000);
    act(() => b.clock.advance(61_000));
    await settle();
    expect(b.guard.confirm).toHaveBeenCalled();
    const refresh = b.last('/v1/account/token/refresh');
    await act(async () => refresh.respond(200, authResponse(b.clock, { gen: 2 })));
    await settle();
    expect(c.closedWith?.code).toBe(1000);
    expect(b.transport.connections).toHaveLength(2);
    const next = await b.online();
    expect(next.frames()[0]!.data).toMatchObject({ token: authResponse(b.clock, { gen: 2 }).accessToken });
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conn-banner')).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('nonce-2');
  });

  it('TC-ACC-03-12 刷新 503：留在当前页退避重试；kicked/tokenExpired 且刷新成功不弹窗、自动重连', async () => {
    const { b, c } = await signedIn('/chats', 6 * 3_600_000 + 60_000);
    act(() => b.clock.advance(61_000));
    await settle();
    await act(async () => b.last('/v1/account/token/refresh').respondError(503, 5030));
    await settle();
    expect(window.location.pathname).toBe('/chats');
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
    act(() => b.clock.advance(2000));
    await settle();
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(2);
    await act(async () => b.last('/v1/account/token/refresh').respond(200, authResponse(b.clock, { gen: 2 })));
    await settle();
    expect(b.transport.connections).toHaveLength(2);
    expect(c.closedWith?.code).toBe(1000);
    const c2 = await b.online();
    await act(async () => {
      c2.receive(kick('tokenExpired'));
      c2.drop(4011);
    });
    await settle();
    await act(async () => b.last('/v1/account/token/refresh').respond(200, authResponse(b.clock, { gen: 3 })));
    await settle();
    expect(b.transport.connections).toHaveLength(3);
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
  });

  it('TC-ACC-03-23 启动、回前台、定时器、kicked 合并成一次刷新；超时后的迟到响应丢弃', async () => {
    const b = accountBench({ config: nodemo, browserEvents: true });
    seedAccountSession(authResponse(b.clock, { ttlMs: 60_000 })); // 启动时已不足 6 小时：start 入口
    b.show('/chats');
    const c = await b.online();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange')); // 回前台
      c.receive(kick('tokenExpired'));
      c.drop(4011);
    });
    act(() => b.clock.advance(1000)); // 定时器
    await settle();
    const first = b.last('/v1/account/token/refresh');
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(1);
    act(() => b.clock.advance(30_000)); // 30 秒超时放弃
    await settle();
    act(() => b.clock.advance(2000)); // 退避到点
    await settle();
    const calls = b.calls('/v1/account/token/refresh');
    expect(calls).toHaveLength(2);
    await act(async () => calls[1]!.respond(200, authResponse(b.clock, { gen: 3 })));
    await settle();
    await act(async () => first.respond(200, authResponse(b.clock, { gen: 2 })));
    await settle();
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('nonce-3');
  });

  it('TC-ACC-03-26 replayDetected：回登录页前弹窗，确定后 token 清除', async () => {
    const { b } = await signedIn('/chats', 6 * 3_600_000 + 60_000);
    act(() => b.clock.advance(61_000));
    await settle();
    await act(async () => b.last('/v1/account/token/refresh').respondError(401, 4019, { reason: 'replayDetected' }));
    await settle();
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent(
      '检测到登录凭证异常，这台设备已下线。如果不是你本人操作，请尽快改密码',
    );
    expect(window.location.pathname).toBe('/chats'); // 确定之前还在原页面
    fireEvent.click(within(screen.getByTestId('kicked-dialog')).getByText('确定'));
    await settle();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-03-41 superseded：留在当前页，按 retryAfter 重试，第 3 次后回登录页', async () => {
    const { b } = await signedIn('/chats', 6 * 3_600_000 + 60_000);
    act(() => b.clock.advance(61_000));
    await settle();
    for (let i = 1; i <= 3; i++) {
      expect(b.calls('/v1/account/token/refresh')).toHaveLength(i);
      await act(async () =>
        b.last('/v1/account/token/refresh').respondError(401, 4019, {
          reason: 'superseded',
          details: { retryAfterSeconds: 120 },
        }),
      );
      await settle();
      if (i < 3) {
        expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
        act(() => b.clock.advance(119_000));
        await settle();
        expect(b.calls('/v1/account/token/refresh')).toHaveLength(i);
        act(() => b.clock.advance(1000));
        await settle();
      }
    }
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('登录已失效，请重新登录');
  });

  it('TC-ACC-03-44 在途请求带旧 token 得到 4011：用本地新 token 重试，不多发刷新（/v1/account/events 代替 C2 的 files/urls）', async () => {
    const { b } = await signedIn('/me/settings/security', 6 * 3_600_000 + 20_000);
    const first = b.last('/v1/account/events');
    act(() => b.clock.advance(21_000));
    await settle();
    const { accessToken } = authResponse(b.clock, { gen: 2 });
    await act(async () => b.last('/v1/account/token/refresh').respond(200, authResponse(b.clock, { gen: 2 })));
    await settle();
    expect(first.bearer).not.toBe(accessToken);
    await act(async () => first.respondError(401, 4011, { reason: 'tokenSuperseded' }));
    await settle();
    const retry = b.last('/v1/account/events');
    expect(retry).not.toBe(first);
    expect(retry.bearer).toBe(accessToken);
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(1);
  });

  it('TC-ACC-03-39 第 21 次重发 4290：SDK 退避，留在当前页，不回登录页（100 天和绝对上限在服务端 e2e）', async () => {
    const { b } = await signedIn('/chats', 6 * 3_600_000 + 20_000);
    act(() => b.clock.advance(21_000));
    await settle();
    await act(async () => b.last('/v1/account/token/refresh').respondError(429, 4290));
    await settle();
    expect(window.location.pathname).toBe('/chats');
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
    act(() => b.clock.advance(2000));
    await settle();
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(2);
  });

  it('TC-ACC-03-45 access 到期等于绝对上限：不再刷新，不重连；到期后回登录页', async () => {
    const b = accountBench({ config: nodemo });
    const resp = authResponse(b.clock, { ttlMs: 5 * 3_600_000 });
    resp.absoluteExpiresAt = resp.accessExpiresAt;
    seedAccountSession(resp);
    b.show('/chats');
    await b.online();
    act(() => b.clock.advance(3_600_000));
    await settle();
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(0);
    expect(b.transport.connections).toHaveLength(1);
    act(() => b.clock.advance(4 * 3_600_000 + 1000));
    await settle();
    expect(screen.getByTestId('kicked-dialog')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('kicked-dialog')).getByText('确定'));
    await settle();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-04-05 passwordChanged 带 recoverBefore：不重连，弹窗显示日期，确定后清空回登录页', async () => {
    const { b, c } = await signedIn();
    const recoverBefore = new Date(2031, 0, 8).getTime();
    await act(async () => {
      c.receive(kick('passwordChanged', { recoverBefore }));
      c.drop(4012);
    });
    await settle();
    const dialog = screen.getByTestId('kicked-dialog');
    expect(dialog).toHaveTextContent('你的账号凭证有变化。如果不是你本人操作，请在 2031-01-08 前用恢复码找回');
    act(() => b.clock.advance(300_000));
    await settle();
    expect(b.transport.connections).toHaveLength(1);
    fireEvent.click(within(dialog).getByText('确定'));
    await settle();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
    expect(b.calls('/v1/account/logout')).toHaveLength(0); // 会话已经结束，不再发 logout
  });

  it('TC-ACC-04-05 不带 recoverBefore：显示现有文案', async () => {
    const { c } = await signedIn();
    await act(async () => {
      c.receive(kick('passwordChanged'));
      c.drop(4012);
    });
    await settle();
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('账号已被下线');
  });

  it('TC-ACC-03-34 access 过期，刷新 4019 credentialsChanged + recoverBefore：弹窗日期，不是"凭证异常"（TC-ACC-04-15 同一条路径）', async () => {
    const b = accountBench({ config: nodemo });
    seedAccountSession(authResponse(b.clock, { ttlMs: -1000 }));
    b.show('/chats');
    await settle();
    await act(async () =>
      b.last('/v1/account/token/refresh').respondError(401, 4019, {
        reason: 'credentialsChanged',
        details: { recoverBefore: new Date(2031, 0, 8).getTime() },
      }),
    );
    await settle();
    expect(b.transport.connections).toHaveLength(0); // 没发 auth
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('请在 2031-01-08 前用恢复码找回');
    expect(screen.getByTestId('kicked-dialog')).not.toHaveTextContent('凭证异常');
  });

  it('K7 没有会话不连接；fatalText 覆盖所有 session 类结果', async () => {
    const b = accountBench({ config: nodemo });
    b.show('/chats');
    await screen.findByTestId('account-username');
    expect(b.transport.connections).toHaveLength(0);
    expect(fatalText({ kind: 'session', action: 'login' })).toBe('登录已失效，请重新登录');
    expect(fatalText({ kind: 'session', action: 'banNotice' })).toBe('账号已被封禁');
    expect(fatalText({ kind: 'session', action: 'login', reason: 'accountDeleted' })).toContain('已申请注销');
    expect(fatalText({ kind: 'session', action: 'login', dialog: 'sessionExpired', reason: 'accountDeleted' })).toBe(
      '登录已失效，请重新登录',
    );
  });

  it('TC-ACC-04-25 改密：响应一直不来、失败时提示失败，缓存的踢线随后生效，队列不堵', async () => {
    const { b, c } = await signedIn('/me/settings/security/password');
    type('password-old', 'pw-old-12345');
    type('password-new', 'pw-new-12345');
    fireEvent.click(screen.getByTestId('password-submit'));
    await settle();
    await act(async () => {
      c.receive(kick('passwordChanged', { recoverBefore: new Date(2031, 0, 8).getTime() }));
      c.drop(4012);
    });
    await settle();
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument(); // 缓存，等响应
    act(() => b.clock.advance(30_000));
    await settle();
    expect(text('password-error')).toBe('网络异常，请稍后重试');
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('2031-01-08');
    // 迟到响应丢弃
    await act(async () => b.last('/v1/account/password').respond(200, authResponse(b.clock, { sid: 's2' })));
    await settle();
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-04-16 定时刷新和改密同时触发：串行发送，改密带刷新后的 token，没有误吊销', async () => {
    const { b } = await signedIn('/me/settings/security/password', 6 * 3_600_000 + 20_000);
    act(() => b.clock.advance(21_000));
    await settle();
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(1);
    type('password-old', 'pw-old-12345');
    type('password-new', 'pw-new-12345');
    fireEvent.click(screen.getByTestId('password-submit'));
    await settle();
    expect(b.calls('/v1/account/password')).toHaveLength(0); // 等刷新结束
    const refreshed = authResponse(b.clock, { gen: 2 });
    await act(async () => b.last('/v1/account/token/refresh').respond(200, refreshed));
    await settle();
    expect(b.calls('/v1/account/password')).toHaveLength(1);
    expect(b.last('/v1/account/password').bearer).toBe(refreshed.accessToken);
    expect(b.calls('/v1/account/token/refresh')).toHaveLength(1);
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
  });

  it('TC-ACC-04-25 响应先到踢线后到：不弹窗，正常重连；进保存页', async () => {
    const { b, c } = await signedIn('/me/settings/security/password');
    type('password-old', 'pw-old-12345');
    type('password-new', 'pw-new-12345');
    fireEvent.click(screen.getByTestId('password-submit'));
    await settle();
    await act(async () =>
      b
        .last('/v1/account/password')
        .respond(200, authResponse(b.clock, { sid: 's2', extra: { recoveryCode: 'C2', recoveryCodeGen: 2 } })),
    );
    await settle();
    await act(async () => {
      c.receive(kick('passwordChanged'));
      c.drop(4012);
    });
    await settle();
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
    expect(text('recovery-code')).toBe('C2');
    expect(b.guard.claim).toHaveBeenCalledWith('s2'); // 换 sid 换锁
    expect(b.transport.connections).toHaveLength(2);
    // 新 token 确认前不落盘：存储里也没有旧 token（AC-ACC-05-19 场景二）。
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code/ack').respond(200, {}));
    await settle();
    expect(window.location.pathname).toBe('/me/settings/security');
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('s2');
  });

  it('TC-ACC-04-25 改密 500 + 踢线：提示失败，踢线生效；旧密码错误原地提示', async () => {
    const { b, c } = await signedIn('/me/settings/security/password');
    type('password-old', 'wrong');
    type('password-new', 'pw-new-12345');
    fireEvent.click(screen.getByTestId('password-submit'));
    await settle();
    await act(async () => b.last('/v1/account/password').respondError(401, 4018));
    await settle();
    expect(text('password-error')).toBe('当前密码错误');
    type('password-old', 'pw-old-12345');
    fireEvent.click(screen.getByTestId('password-submit'));
    await settle();
    await act(async () => {
      c.receive(kick('passwordChanged'));
      c.drop(4012);
    });
    await act(async () => b.last('/v1/account/password').respondError(500, 5000));
    await settle();
    expect(text('password-error')).toBe('服务异常，请稍后重试');
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('账号已被下线');
  });

  it('退出登录：界面不等 logout 返回；存储立刻清除；logout 回来之前新登录的 token 不被旧实例清掉', async () => {
    const { b } = await signedIn('/me/settings');
    fireEvent.click(screen.getByTestId('logout'));
    fireEvent.click(within(screen.getByTestId('logout-dialog')).getByText('退出'));
    await settle();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
    const logoutCall = b.last('/v1/account/logout');
    expect(logoutCall.settled).toBe(false);
    expect(logoutCall.json.refreshToken).toContain('nonce');
    // 还没回应时登录另一次
    const call = await fillLogin(b);
    await act(async () => call.respond(200, authResponse(b.clock, { sid: 's9', gen: 1 })));
    await settle();
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('s9');
    await act(async () => logoutCall.respond(200, {}));
    await settle();
    expect(JSON.parse(sessionStorage.getItem('tt.session')!).refreshToken).toContain('s9');
    expect(window.location.pathname).not.toBe('/login');
  });

  it('TC-ACC-02-13 securityNotice：提示"你的账号在新设备登录"；账号安全页有记录和其他会话数量', async () => {
    const { b, c } = await signedIn('/me/settings/security');
    await act(async () =>
      c.receive({ cmd: 'event', data: { type: 'securityNotice', kind: 'newDeviceLogin', at: 1, platform: 'android' } }),
    );
    expect(text('toast')).toBe('你的账号在新设备登录');
    await act(async () =>
      b.last('/v1/account/events').respond(200, {
        events: [{ kind: 'newDeviceLogin', at: new Date(2031, 0, 2, 3, 4).getTime(), platform: 'android' }],
        otherSessions: { count: 2, lastActiveAt: new Date(2031, 0, 2, 3, 4).getTime() },
      }),
    );
    await settle();
    expect(text('security-event')).toContain('新设备登录（Android）');
    expect(text('security-event')).toContain('2031-01-02 03:04');
    expect(text('security-other-sessions')).toBe('其他 2 个会话，最近活跃 2031-01-02 03:04');
  });

  it('securityNotice 其他 kind：按 kind 提示，不认识的不提示（AC-ACC-03-25、AC-ACC-03-45、F-ACC-05 规则 5）', async () => {
    const { c } = await signedIn('/me/settings/security');
    const notice = (kind: string) =>
      act(async () => c.receive({ cmd: 'event', data: { type: 'securityNotice', kind, at: 1, platform: 'android' } }));
    await notice('futureKind');
    expect(screen.queryByTestId('toast')).toBeNull();
    await notice('recoveryCodeRegenerated');
    expect(text('toast')).toBe('你的恢复码已重新生成');
    await notice('refreshReplay');
    expect(text('toast')).toBe('检测到你的账号登录凭证异常');
    await notice('refreshRateLimited');
    expect(text('toast')).toBe('你的账号登录凭证刷新过于频繁');
    await notice('futureKind');
    expect(text('toast')).toBe('你的账号登录凭证刷新过于频繁');
  });

  it('TC-ACC-04-09 退出其他设备：密码错原地提示，没有变化；密码对换 sid 重连，无弹窗', async () => {
    const { b, c } = await signedIn('/me/settings/security');
    fireEvent.click(screen.getByTestId('security-logout-others'));
    type('logoutOthers-password', 'wrong');
    fireEvent.click(screen.getByTestId('logoutOthers-ok'));
    await settle();
    await act(async () => b.last('/v1/account/logout-others').respondError(401, 4018));
    await settle();
    expect(text('logoutOthers-error')).toBe('密码错误');
    expect(c.closedWith).toBeNull();
    type('logoutOthers-password', 'pw-correct-1');
    fireEvent.click(screen.getByTestId('logoutOthers-ok'));
    await settle();
    await act(async () => b.last('/v1/account/logout-others').respond(200, authResponse(b.clock, { sid: 's2' })));
    await settle();
    expect(b.guard.claim).toHaveBeenCalledWith('s2');
    expect(c.closedWith?.code).toBe(1000);
    expect(b.transport.connections).toHaveLength(2);
    expect(screen.queryByTestId('logoutOthers-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kicked-dialog')).not.toBeInTheDocument();
  });

  it('TC-ACC-08-06 注销确认框的文字；密码错误原地提示；成功后回登录页', async () => {
    const { b } = await signedIn('/me/settings/security');
    fireEvent.click(screen.getByTestId('security-delete'));
    expect(screen.getByTestId('delete-dialog')).toHaveTextContent(DELETE_WARNING);
    expect(DELETE_WARNING).toBe('7 天后不可恢复，用户名不能再使用，已发的消息会保留');
    type('delete-password', 'wrong');
    fireEvent.click(screen.getByTestId('delete-ok'));
    await settle();
    await act(async () => b.last('/v1/account/delete').respondError(401, 4018));
    await settle();
    expect(text('delete-error')).toBe('密码错误');
    expect(window.location.pathname).toBe('/me/settings/security');
    type('delete-password', 'pw-correct-1');
    fireEvent.click(screen.getByTestId('delete-ok'));
    await settle();
    await act(async () => b.last('/v1/account/delete').respond(200, {}));
    await settle();
    fireEvent.click(within(screen.getByTestId('kicked-dialog')).getByText('确定'));
    await settle();
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('TC-ACC-06-05 改昵称："我"页立即显示；空白和超长不能提交；失败提示', async () => {
    const { b, c } = await signedIn('/me');
    await act(async () => c.ack('users', { users: [{ userId: 'alice', nickname: '旧名' }] }));
    await settle();
    expect(text('me-name')).toContain('旧名');
    fireEvent.click(screen.getByTestId('me-edit'));
    await settle();
    await act(async () => c.ack('users', { users: [{ userId: 'alice', nickname: '旧名' }] }));
    await settle();
    expect(screen.getByTestId('nickname-input')).toHaveValue('旧名');
    type('nickname-input', '   ');
    expect(screen.getByTestId('nickname-done')).toBeDisabled();
    type('nickname-input', '字'.repeat(33));
    expect(screen.getByTestId('nickname-done')).toBeDisabled();
    type('nickname-input', '新名');
    fireEvent.click(screen.getByTestId('nickname-done'));
    await settle();
    expect(b.last('/v1/account/profile').json).toEqual({ nickname: '新名' });
    await act(async () => b.last('/v1/account/profile').respond(200, {}));
    await settle();
    expect(window.location.pathname).toBe('/me');
    expect(text('me-name')).toContain('新名');
  });

  it('日志和 URL 不带凭证：全流程 console 没有 token、refresh、恢复码、密码', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a.map(String).join(' ')));
    }
    const b = accountBench({ config: nodemo });
    b.show('/register');
    await fillRegister();
    const resp = authResponse(b.clock, { extra: { recoveryCode: 'SECRET-CODE', recoveryCodeGen: 1 } });
    await act(async () => b.last('/v1/account/register').respond(200, resp));
    await settle();
    fireEvent.click(screen.getByTestId('recovery-ack'));
    await settle();
    await act(async () => b.last('/v1/account/recovery-code/ack').respond(200, {}));
    const c = await b.online();
    await act(async () => {
      c.receive(kick('passwordChanged'));
      c.drop(4012);
    });
    await settle();
    const all = lines.join('\n') + window.location.href + document.title;
    for (const secret of [resp.accessToken, resp.refreshToken, 'SECRET-CODE', 'pw-correct-1']) {
      expect(all).not.toContain(secret);
    }
    for (const c2 of b.http.calls) {
      for (const secret of [resp.accessToken, resp.refreshToken, 'SECRET-CODE', 'pw-correct-1']) {
        expect(c2.req.url).not.toContain(secret);
      }
    }
    expect(b.transport.current.url).not.toContain(resp.accessToken);
  });
});
