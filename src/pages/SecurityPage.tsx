import { SessionEndedError, type AccountEvents } from '@tianting/sdk';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useIm } from '../im/ImProvider';
import {
  accountErrorText,
  accountEventText,
  DELETE_WARNING,
  isWrongCredentials,
  platformText,
} from '../lib/accountText';
import { formatDateTime } from '../lib/time';
import { FormError, TextField } from './LoginPage';

type Action = 'regenerate' | 'logoutOthers' | 'delete';

const ACTION_TEXT: Record<Action, { title: string; body?: string; ok: string; danger?: boolean }> = {
  regenerate: {
    title: '重新生成恢复码',
    body: '生成新的恢复码后，旧恢复码 7 天后失效',
    ok: '生成',
  },
  logoutOthers: { title: '退出其他设备', body: '其他设备会被下线，密码不变', ok: '退出其他设备', danger: true },
  delete: { title: '注销账号', body: DELETE_WARNING, ok: '注销', danger: true },
};

/** 要当前密码的确认框：密码错误原地提示（AC-ACC-08-6、AC-ACC-04-10）。 */
function PasswordDialog({
  action,
  onClose,
  run,
}: {
  action: Action;
  onClose: () => void;
  run: (p: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const t = ACTION_TEXT[action];

  async function submit() {
    if (inFlight.current || !password) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await run(password);
    } catch (e) {
      if (e instanceof SessionEndedError) return; // 会话结束的弹窗已经出来了
      if (isWrongCredentials(e)) {
        setError('密码错误');
        setPassword('');
      } else setError(accountErrorText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      testId={`${action}-dialog`}
      title={t.title}
      onDismiss={onClose}
      actions={
        <>
          <button className="tt-btn" onClick={onClose}>
            取消
          </button>
          <button
            className={`tt-btn ${t.danger ? 'tt-btn-danger' : 'tt-btn-primary'}`}
            disabled={busy || !password}
            onClick={() => void submit()}
            data-testid={`${action}-ok`}
          >
            {busy ? '提交中…' : t.ok}
          </button>
        </>
      }
    >
      {t.body}
      <form
        className="tt-dialog-field"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="当前密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          testId={`${action}-password`}
        />
        <FormError text={error} testId={`${action}-error`} />
      </form>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <p className="tt-secondary tt-note">{title}</p>
      {children}
    </>
  );
}

/** 账号安全（PRD-chat 第 13.3 节）：演示会话没有入口（AC-ACC-07-8）。 */
export function SecurityPage() {
  const { account, accountAuthed, showRecovery } = useIm();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [events, setEvents] = useState<AccountEvents | 'loading' | 'failed'>('loading');
  const [loadN, setLoadN] = useState(0);

  useEffect(() => {
    let live = true;
    account.listEvents().then(
      (r) => {
        if (live) setEvents(r);
      },
      () => {
        if (live) setEvents('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [account, loadN]);

  const reload = () => {
    setEvents('loading');
    setLoadN((n) => n + 1);
  };

  const run: Record<Action, (p: string) => Promise<void>> = {
    regenerate: async (p) => {
      showRecovery(await account.regenerateRecoveryCode(p));
      setAction(null);
    },
    logoutOthers: async (p) => {
      accountAuthed(await account.logoutOthers(p));
      setAction(null);
      toast('已退出其他设备');
      reload();
    },
    delete: async (p) => {
      await account.requestDelete(p); // 成功后 SDK 结束会话，弹窗后回登录页
    },
  };

  return (
    <div className="tt-page">
      <TopBar title="账号安全" back="/me/settings" />
      <div className="tt-scroll">
        <Link className="tt-row" to="/me/settings/security/password" data-testid="security-password">
          修改密码
        </Link>
        <button className="tt-row" onClick={() => setAction('regenerate')} data-testid="security-regenerate">
          重新生成恢复码
        </button>
        <button
          className="tt-row tt-row-between"
          onClick={() => setAction('logoutOthers')}
          data-testid="security-logout-others"
        >
          <span>退出其他设备</span>
          {typeof events === 'object' && (
            <span className="tt-secondary" data-testid="security-other-sessions">
              {events.otherSessions.count > 0
                ? `其他 ${events.otherSessions.count} 个会话${
                    events.otherSessions.lastActiveAt
                      ? `，最近活跃 ${formatDateTime(events.otherSessions.lastActiveAt)}`
                      : ''
                  }`
                : '没有其他会话'}
            </span>
          )}
        </button>
        <button className="tt-row tt-danger-text" onClick={() => setAction('delete')} data-testid="security-delete">
          注销账号
        </button>
        <Section title="最近登录记录">
          {events === 'loading' && <div className="tt-row-static tt-secondary">加载中…</div>}
          {events === 'failed' && (
            <button className="tt-row tt-secondary" onClick={reload} data-testid="security-events-retry">
              加载失败，点击重试
            </button>
          )}
          {typeof events === 'object' && events.events.length === 0 && (
            <div className="tt-row-static tt-secondary">暂无记录</div>
          )}
          {typeof events === 'object' &&
            events.events.map((e, i) => (
              <div className="tt-row-static tt-row-between" key={`${e.at}-${i}`} data-testid="security-event">
                <span>
                  {accountEventText(e.kind)}
                  {e.platform ? `（${platformText(e.platform)}）` : ''}
                </span>
                <span className="tt-secondary">{formatDateTime(e.at)}</span>
              </div>
            ))}
        </Section>
      </div>
      {action && <PasswordDialog action={action} onClose={() => setAction(null)} run={run[action]} />}
    </div>
  );
}

/** 改密（F-ACC-04 规则 2、3）。成功后响应带新恢复码，进保存页。 */
export function ChangePasswordPage() {
  const { account, accountAuthed } = useIm();
  const navigate = useNavigate();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const canSubmit = oldPassword !== '' && newPassword !== '' && !busy;

  async function submit() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await account.changePassword(oldPassword, newPassword);
      navigate('/me/settings/security', { replace: true });
      accountAuthed(r);
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      if (isWrongCredentials(e)) {
        setError('当前密码错误');
        setOld('');
      } else setError(accountErrorText(e)); // 超时、失败：提示后缓存的踢线随后生效（AC-ACC-04-27）
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="tt-page">
      <TopBar title="修改密码" back="/me/settings/security" />
      <form
        className="tt-scroll tt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="当前密码"
          type="password"
          value={oldPassword}
          onChange={setOld}
          autoComplete="current-password"
          testId="password-old"
        />
        <TextField
          label="新密码"
          type="password"
          value={newPassword}
          onChange={setNew}
          autoComplete="new-password"
          testId="password-new"
        />
        <FormError text={error} testId="password-error" />
        <button
          className="tt-btn tt-btn-primary tt-btn-block"
          type="submit"
          disabled={!canSubmit}
          data-testid="password-submit"
        >
          {busy ? '提交中…' : '修改密码'}
        </button>
      </form>
    </div>
  );
}
