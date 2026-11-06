import { countCodePoints } from '@tianting/sdk';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Dialog } from '../components/Dialog';
import { Logo } from '../components/Logo';
import { useToast } from '../components/Toast';
import { setPrivacyAck, useIm } from '../im/ImProvider';
import {
  accountErrorText,
  deletionPendingAt,
  isWrongCredentials,
  NETWORK_ERROR,
  PRIVACY_OPEN_FAILED,
  RECOVERY_LOST_WARNING,
} from '../lib/accountText';
import { demoFormEnabled } from '../lib/config';
import { bannedText, messageFor } from '../lib/errors';
import { formatDate } from '../lib/time';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NICKNAME = 32;
const LOGIN_TIMEOUT_MS = 10_000;

/** 隐私说明地址只接受 http、https：来自配置，但这是一个会被点开的链接。 */
function privacyHref(url: string): URL | null {
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * 隐私说明入口（F-ACC-10）。同源地址先探测一次，打不开时原地提示，不阻止登录。
 * 其他域名探测不了（CSP connect-src 只有 'self'），直接打开，失败时由浏览器显示。
 */
export function PrivacyLink({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const href = privacyHref(url);
  if (!href) return null;
  return (
    <>
      <a
        className="tt-link"
        href={href.href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="privacy-link"
        onClick={(e) => {
          if (href.origin !== window.location.origin) return;
          e.preventDefault();
          setFailed(false);
          const w = window.open('', '_blank'); // 要在点击的同一步打开，等探测结果再开会被浏览器拦住
          void fetch(href.href, { credentials: 'omit', cache: 'no-store' })
            .then((res) => {
              if (!res.ok) throw new Error('privacy notice unavailable');
              if (w) {
                w.opener = null;
                w.location.href = href.href;
              }
            })
            .catch(() => {
              w?.close();
              setFailed(true);
            });
        }}
      >
        隐私说明
      </a>
      {failed && (
        <span className="tt-field-error" role="alert" data-testid="privacy-error">
          {' '}
          {PRIVACY_OPEN_FAILED}
        </span>
      )}
    </>
  );
}

/** 登录、注册、找回共用的外壳：配置没拿到时不猜测模式，不显示任何表单（F-ACC-07 异常、AC-ACC-07-9）。 */
function AuthShell({ children }: { children: (config: NonNullable<ReturnType<typeof useLoadedConfig>>) => ReactNode }) {
  const { config, reloadConfig, tabConflict } = useIm();
  const loaded = useLoadedConfig();
  return (
    <div className="tt-login">
      <Logo />
      {tabConflict && (
        <p className="tt-login-hint" role="status" data-testid="tab-conflict">
          这个账号已在其他标签页打开，请重新登录
        </p>
      )}
      {config.status === 'loading' && <p className="tt-login-hint">加载中…</p>}
      {config.status === 'failed' && (
        <>
          <p className="tt-field-error" role="alert" data-testid="config-error">
            {NETWORK_ERROR}
          </p>
          <button className="tt-btn tt-btn-primary" onClick={reloadConfig} data-testid="config-retry">
            重试
          </button>
        </>
      )}
      {loaded && children(loaded)}
    </div>
  );
}

function useLoadedConfig() {
  const { config } = useIm();
  return config.status === 'ok' ? config.value : null;
}

/** 表单之间跳转时带上 redirect，登录后回到原来要去的页面（F-UI-01 规则 3）。 */
function useKeepSearch() {
  return useLocation().search;
}

function PrivacyFooter({ url }: { url?: string }) {
  return url ? (
    <p className="tt-login-hint">
      <PrivacyLink url={url} />
    </p>
  ) : null;
}

/** 登录页（PRD-chat F-ACC-07 规则 5）：演示开启时是现有演示表单和"使用账号登录"入口，否则只有账号登录。 */
export function LoginPage() {
  return <AuthShell>{(config) => (demoFormEnabled(config) ? <DemoForm /> : <AccountForm />)}</AuthShell>;
}

export function AccountLoginPage() {
  return <AuthShell>{() => <AccountForm />}</AuthShell>;
}

/** 演示表单（PRD-ui F-UI-03）。 */
function DemoForm() {
  const { login } = useIm();
  const search = useKeepSearch();
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const trimmed = username.trim();
  const nicknameTooLong = countCodePoints(nickname.trim()) > MAX_NICKNAME;
  const canSubmit = trimmed !== '' && !nicknameTooLong && !busy;

  async function submit() {
    if (!canSubmit || inFlight.current) return; // 防重复提交（AC-UI-03-3）
    if (!USER_ID_RE.test(trimmed)) {
      setError(messageFor(4004));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOGIN_TIMEOUT_MS);
    try {
      const body: Record<string, string> = { username: trimmed };
      if (nickname.trim()) body.nickname = nickname.trim();
      const res = await fetch('/demo/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 404) {
        setError('登录服务未开启');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        userId?: string;
        token?: string;
        code?: number;
        details?: { bannedUntil?: number | null };
      };
      // 4034 不是 ws 码，文案在这里维护（PRD-ui F-UI-43 规则 1）。
      if (data.code === 4034) {
        setError(bannedText(data.details?.bannedUntil));
        return;
      }
      if (!res.ok || !data.token || !data.userId) {
        setError(messageFor(data.code ?? 5000));
        return;
      }
      login({ userId: data.userId, token: data.token }); // /login 路由随后按 redirect 跳转（App.tsx）
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className="tt-login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="tt-field">
          <span>用户名</span>
          <input
            className="tt-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            data-testid="login-username"
          />
        </label>
        <label className="tt-field">
          <span>昵称（选填）</span>
          <input
            className="tt-input"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            data-testid="login-nickname"
          />
        </label>
        {nicknameTooLong && <p className="tt-field-error">昵称最多 32 个字</p>}
        {error && (
          <p className="tt-field-error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <button
          className="tt-btn tt-btn-primary tt-btn-block"
          type="submit"
          disabled={!canSubmit}
          data-testid="login-submit"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <p className="tt-login-hint">演示环境：输入任意用户名即可登录</p>
      <div className="tt-login-links">
        <Link className="tt-link" to={`/login/account${search}`} data-testid="use-account-login">
          使用账号登录
        </Link>
      </div>
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  testId,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'password';
  autoComplete?: string;
  testId: string;
  error?: string;
}) {
  return (
    <label className="tt-field">
      <span>{label}</span>
      <input
        className="tt-input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        data-testid={testId}
      />
      {error && (
        <span className="tt-field-error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}

function FormError({ text, testId }: { text: string; testId: string }) {
  return text ? (
    <p className="tt-field-error" role="alert" data-testid={testId}>
      {text}
    </p>
  ) : null;
}

/** 账号登录（F-ACC-02）。 */
function AccountForm() {
  const { account, accountAuthed, config } = useIm();
  const toast = useToast();
  const search = useKeepSearch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteAt, setDeleteAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const cfg = config.status === 'ok' ? config.value : null;
  const canSubmit = username.trim() !== '' && password !== '' && !busy;

  async function submit() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      accountAuthed(await account.login(username.trim(), password));
    } catch (e) {
      const pending = deletionPendingAt(e);
      if (pending !== null) setDeleteAt(pending);
      else if (isWrongCredentials(e)) {
        setError('用户名或密码错误');
        setPassword('');
      } else setError(accountErrorText(e)); // 4294 不自动重试（AC-ACC-02-9）
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function cancelDelete() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await account.cancelDelete(username.trim(), password);
      setDeleteAt(null);
      toast('已撤销注销，请重新登录');
      setPassword('');
    } catch (e) {
      setDeleteAt(null);
      if (isWrongCredentials(e)) {
        setError('用户名或密码错误');
        setPassword('');
      } else setError(accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className="tt-login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="用户名"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          testId="account-username"
        />
        <TextField
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          testId="account-password"
        />
        <FormError text={error} testId="account-error" />
        <button
          className="tt-btn tt-btn-primary tt-btn-block"
          type="submit"
          disabled={!canSubmit}
          data-testid="account-submit"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <div className="tt-login-links">
        {cfg?.registerMode !== 'closed' && (
          <Link className="tt-link" to={`/register${search}`} data-testid="go-register">
            注册
          </Link>
        )}
        <Link className="tt-link" to={`/forgot${search}`} data-testid="go-forgot">
          忘记密码
        </Link>
      </div>
      <PrivacyFooter url={cfg?.privacyNotice?.url} />
      {deleteAt !== null && (
        <Dialog
          testId="delete-pending-dialog"
          onDismiss={() => setDeleteAt(null)}
          actions={
            <>
              <button className="tt-btn" onClick={() => setDeleteAt(null)}>
                暂不
              </button>
              <button
                className="tt-btn tt-btn-primary"
                disabled={busy}
                onClick={() => void cancelDelete()}
                data-testid="delete-cancel-ok"
              >
                撤销注销
              </button>
            </>
          }
        >
          {`账号正在注销，${formatDate(deleteAt)}后不可恢复，是否撤销？`}
        </Dialog>
      )}
    </>
  );
}

/** 注册（F-ACC-01、F-ACC-10 规则 2）。 */
export function RegisterPage() {
  return <AuthShell>{() => <RegisterForm />}</AuthShell>;
}

function RegisterForm() {
  const { account, accountAuthed, config } = useIm();
  const search = useKeepSearch();
  const cfg = config.status === 'ok' ? config.value : null;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const needInvite = cfg?.registerMode === 'invite';
  const canSubmit = username.trim() !== '' && password !== '' && (!needInvite || invite.trim() !== '') && !busy;
  const privacy = cfg?.privacyNotice;

  async function submit() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setUsernameError('');
    try {
      const r = await account.register({
        username: username.trim(),
        password,
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        ...(needInvite ? { inviteCode: invite.trim() } : {}),
      });
      if (privacy) setPrivacyAck(r.userId, privacy.version); // 注册页已告知（F-ACC-10 规则 2）
      accountAuthed(r);
    } catch (e) {
      if (isCode(e, 4095)) setUsernameError('这个用户名不能使用');
      else setError(accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (cfg?.registerMode === 'closed') {
    return (
      <>
        <p className="tt-login-hint" data-testid="register-closed">
          当前不开放注册
        </p>
        <div className="tt-login-links">
          <Link className="tt-link" to={`/login/account${search}`}>
            返回登录
          </Link>
        </div>
      </>
    );
  }
  return (
    <>
      <form
        className="tt-login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="用户名"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          testId="register-username"
          error={usernameError}
        />
        <TextField
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          testId="register-password"
        />
        <TextField label="昵称（选填）" value={nickname} onChange={setNickname} testId="register-nickname" />
        {needInvite && <TextField label="邀请码" value={invite} onChange={setInvite} testId="register-invite" />}
        <FormError text={error} testId="register-error" />
        <p className="tt-recovery-warning">注册后会生成恢复码，{RECOVERY_LOST_WARNING}</p>
        <button
          className="tt-btn tt-btn-primary tt-btn-block"
          type="submit"
          disabled={!canSubmit}
          data-testid="register-submit"
        >
          {busy ? '提交中…' : '注册'}
        </button>
      </form>
      {privacy?.url && (
        <p className="tt-login-hint" data-testid="register-privacy">
          注册即表示你已阅读 <PrivacyLink url={privacy.url} />
        </p>
      )}
      <div className="tt-login-links">
        <Link className="tt-link" to={`/login/account${search}`}>
          返回登录
        </Link>
      </div>
    </>
  );
}

function isCode(e: unknown, code: number): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** 忘记密码：只有恢复码流程，没有客服入口（F-ACC-05 规则 4、6）。 */
export function ForgotPage() {
  return <AuthShell>{() => <ForgotForm />}</AuthShell>;
}

function ForgotForm() {
  const { account, accountAuthed } = useIm();
  const search = useKeepSearch();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const canSubmit = username.trim() !== '' && code.trim() !== '' && password !== '' && !busy;

  async function submit() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      accountAuthed(await account.recover(username.trim(), code.trim(), password));
    } catch (e) {
      setError(isWrongCredentials(e) ? '用户名或恢复码错误' : accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className="tt-login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="用户名"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          testId="forgot-username"
        />
        <TextField label="恢复码" value={code} onChange={setCode} autoComplete="off" testId="forgot-code" />
        <TextField
          label="新密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          testId="forgot-password"
        />
        <FormError text={error} testId="forgot-error" />
        <p className="tt-recovery-warning">{RECOVERY_LOST_WARNING}</p>
        <button
          className="tt-btn tt-btn-primary tt-btn-block"
          type="submit"
          disabled={!canSubmit}
          data-testid="forgot-submit"
        >
          {busy ? '提交中…' : '重设密码'}
        </button>
      </form>
      <div className="tt-login-links">
        <Link className="tt-link" to={`/login/account${search}`}>
          返回登录
        </Link>
      </div>
    </>
  );
}

/** 让 Dialog 里的输入框用同一个样式。 */
export { TextField, FormError };
