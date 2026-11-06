import { useRef, useState } from 'react';
import { AccountError, SessionEndedError } from '@tianting/sdk';
import { Logo } from '../components/Logo';
import { useIm } from '../im/ImProvider';
import { accountErrorText, isWrongCredentials, RECOVERY_LOST_WARNING } from '../lib/accountText';
import { copyText } from '../lib/clipboard';
import { FormError, TextField } from './LoginPage';

/**
 * 保存恢复码（AC-ACC-01-12、F-ACC-05 规则 1）。只有一个"我已保存"按钮，没有返回；确认之前 token 只在内存（SDK 保证）。
 * 手里没有码（服务端说最新一代没确认）：输入密码重新生成。
 */
export function SaveRecoveryPage() {
  const { recovery, account, ackRecovery, showRecovery } = useIm();
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  if (!recovery) return null;

  async function regenerate() {
    if (inFlight.current || !password) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      showRecovery(await account.regenerateRecoveryCode(password));
      setPassword('');
    } catch (e) {
      if (isWrongCredentials(e)) {
        setError('密码错误');
        setPassword('');
      } else if (!(e instanceof SessionEndedError)) setError(accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function ack(gen: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await ackRecovery(gen);
    } catch (e) {
      // recoveryCodeStale：会话已结束，弹窗提示后回登录页（AC-ACC-05-15）。
      const ended = e instanceof SessionEndedError || (e instanceof AccountError && e.reason === 'recoveryCodeStale');
      if (!ended) setError(accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="tt-login" data-testid="recovery-page">
      <Logo />
      <h1 className="tt-topbar-title">保存恢复码</h1>
      <div className="tt-recovery">
        <p className="tt-recovery-warning" data-testid="recovery-warning">
          {RECOVERY_LOST_WARNING}
        </p>
        {'code' in recovery ? (
          <>
            <div className="tt-recovery-code" data-testid="recovery-code">
              {recovery.code}
            </div>
            <button
              className="tt-btn tt-btn-block"
              onClick={async () => setCopied((await copyText(recovery.code)) ? 'ok' : 'failed')}
              data-testid="recovery-copy"
            >
              复制
            </button>
            {copied && (
              <p className="tt-login-hint" role="status" data-testid="recovery-copy-status">
                {copied === 'ok' ? '已复制' : '复制失败，请长按文字手动复制'}
              </p>
            )}
            <FormError text={error} testId="recovery-error" />
            <button
              className="tt-btn tt-btn-primary tt-btn-block"
              disabled={busy}
              onClick={() => void ack(recovery.gen)}
              data-testid="recovery-ack"
            >
              我已保存
            </button>
          </>
        ) : (
          <form
            className="tt-login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void regenerate();
            }}
          >
            <p className="tt-login-hint">你还没有确认保存最新的恢复码，请输入密码重新生成</p>
            <TextField
              label="当前密码"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              testId="recovery-password"
            />
            <FormError text={error} testId="recovery-error" />
            <button
              className="tt-btn tt-btn-primary tt-btn-block"
              type="submit"
              disabled={busy || !password}
              data-testid="recovery-regenerate"
            >
              {busy ? '提交中…' : '重新生成'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
