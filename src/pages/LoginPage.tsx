import { countCodePoints } from '@tianting/sdk';
import { useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { useIm } from '../im/ImProvider';
import { DEMO_LOGIN } from '../lib/config';
import { bannedText, messageFor } from '../lib/errors';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NICKNAME = 32;
const LOGIN_TIMEOUT_MS = 10_000;

/** 登录页（PRD-ui F-UI-03）：一期只有演示登录。 */
export function LoginPage() {
  const { login } = useIm();
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  if (!DEMO_LOGIN) {
    return (
      <main className="tt-login">
        <Logo />
        <p className="tt-login-hint">请从业务方入口进入天听</p>
      </main>
    );
  }

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
      setError('网络异常，请稍后重试');
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="tt-login">
      <Logo />
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
    </main>
  );
}
