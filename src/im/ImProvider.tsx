import {
  fnv1a32,
  IMClient,
  lineageOf,
  type AccountClient,
  type AccountConfig,
  type AuthResult,
  type FatalReason,
} from '@tianting/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { demoBuildEnabled, wsURL } from '../lib/config';
import { clearSession, loadAccountSession, loadSession, saveSession, type Session } from '../lib/session';
import { createTabGuard, type TabGuard } from '../lib/tabGuard';
import { getPref, removePref, setPref } from '../lib/uiPrefs';
import { createAccountRuntime, type AccountDeps, type AccountRuntime } from './account';
import { DraftStore } from './drafts';
import { NoticeStore, noticeSeenKey } from './notices';

/** 测试注入：创建 SDK 客户端的方式（组件测试用 FakeTransport）。 */
export type ClientFactory = () => IMClient;

const defaultFactory: ClientFactory = () => new IMClient({ url: wsURL(), platform: 'web' });

/** 登录状态。token 不放进来：账号会话的 token 只在 SDK 和 sessionStorage，页面用不到。 */
export interface UiSession {
  userId: string;
  mode: 'demo' | 'account';
}

/** 保存恢复码页的状态。needPassword：服务端说最新一代没确认，手里没有码，要输入密码重新生成（F-ACC-05 规则 1）。 */
export type RecoveryState = { code: string; gen: number } | { needPassword: true };

export type ConfigState = { status: 'loading' | 'failed'; value: null } | { status: 'ok'; value: AccountConfig };

interface ImContextValue {
  client: IMClient | null;
  session: UiSession | null;
  /** 账号接口（HTTP）。一直存在：登录页要用它拉配置和登录。 */
  account: AccountClient;
  /** 不为空时整个应用只显示保存恢复码页（AC-ACC-01-12）。 */
  recovery: RecoveryState | null;
  /** 这个页面启动时发现同一个登录在别的标签页（F-ACC-03 规则 9）。 */
  tabConflict: boolean;
  /** GET /v1/config 这一次的结果。登录页只看它，不用缓存（F-ACC-07 异常：不猜测模式）。 */
  config: ConfigState;
  /** 已登录用：这一次失败时用上次缓存的值，从未成功过时为 null，新功能入口隐藏（F-ACC-07 规则 4）。 */
  knownConfig: AccountConfig | null;
  reloadConfig(): void;
  /** 本次登录的草稿（F-UI-24）：退出登录就换一个新的。 */
  drafts: DraftStore;
  /** 本次登录的系统通知（F-UI-44）：列表只在内存。 */
  notices: NoticeStore | null;
  /** 被踢 / 登录失效：显示不可关闭的弹窗，点"确定"后回登录页（PRD-ui F-UI-18）。 */
  fatal: FatalReason | null;
  /** 演示登录。 */
  login(s: Session): void;
  /** 账号接口换了 token 之后调用：有恢复码进保存页，没有就进入应用。 */
  accountAuthed(r: AuthResult): void;
  /** 显示新一代恢复码（重新生成）。 */
  showRecovery(r: { recoveryCode: string; recoveryCodeGen: number }): void;
  /** 确认已保存。失败时抛出，页面留在保存页；recoveryCodeStale 由 fatal 弹窗处理。 */
  ackRecovery(gen: number): Promise<void>;
  /** keepNoticeSeen：被踢、凭证失效时不删 ui.noticeSeen（PRD-live F-PUSH-12 规则 5），重新登录后不重复提醒。 */
  logout(opts?: { keepNoticeSeen?: boolean }): void;
}

const ImContext = createContext<ImContextValue | null>(null);

type SessionState = Pick<ImContextValue, 'client' | 'session' | 'drafts' | 'notices'> & { demoToken?: string };

const CONFIG_KEY = 'ui.config';

function cachedConfig(): AccountConfig | null {
  try {
    const raw = getPref(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AccountConfig) : null;
  } catch {
    return null;
  }
}

const privacyAckKey = (userId: string) => `ui.privacyAck.${fnv1a32(userId).toString(16)}` as const;
export const getPrivacyAck = (userId: string) => getPref(privacyAckKey(userId));
export const setPrivacyAck = (userId: string, version: string) => setPref(privacyAckKey(userId), version);

function signedOut(): SessionState {
  return { client: null, session: null, notices: null, drafts: new DraftStore() };
}

function signedIn(session: UiSession, factory: ClientFactory, demoToken?: string): SessionState {
  const client = factory();
  return { client, session, demoToken, notices: new NoticeStore(client, session.userId), drafts: new DraftStore() };
}

export function ImProvider({
  children,
  factory = defaultFactory,
  accountDeps,
  guardFactory = createTabGuard,
}: {
  children: ReactNode;
  factory?: ClientFactory;
  accountDeps?: AccountDeps;
  guardFactory?: () => TabGuard;
}) {
  const [guard] = useState(guardFactory);
  const [runtime, setRuntime] = useState<AccountRuntime>(() => createAccountRuntime(guard, accountDeps));
  const account = runtime.client;
  // 刷新后用 sessionStorage 里的 token 自动重连，停留在原页面（PRD-core 第 5 节）。
  // 这里只创建客户端，连接放在 effect 里：StrictMode 会把初始化函数执行两次，被丢弃的那个客户端不能建立连接。
  const [state, setState] = useState<SessionState>(() => {
    const s = loadSession();
    return s ? signedIn({ userId: s.userId, mode: 'demo' }, factory, s.token) : signedOut();
  });
  // 存储里有账号会话：先确认这个标签页是唯一的，再把 refresh token 交给 SDK。结果出来之前什么都不显示，路由守卫不能先跳走。
  const [checking, setChecking] = useState(() => loadAccountSession() !== null);
  const [tabConflict, setTabConflict] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [config, setConfig] = useState<ConfigState>({ status: 'loading', value: null });
  const [fatal, setFatal] = useState<FatalReason | null>(null);
  const current = useRef({ state, runtime });
  useEffect(() => {
    current.current = { state, runtime };
  }, [state, runtime]);

  const enterAccount = useCallback(
    (a: AccountClient) => {
      const s = a.session;
      if (!s) return; // 会话已经结束：不能 connect（问题 K7），结束事件会弹窗
      setFatal(null);
      setState(signedIn({ userId: s.userId, mode: 'account' }, factory));
    },
    [factory],
  );

  // 启动：多标签页互斥（F-ACC-03 规则 9）。StrictMode 下 effect 会执行两次，只做一次：锁不能放了再抢。
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || !checking) return;
    booted.current = true;
    void (async () => {
      const saved = loadAccountSession();
      if (saved && !(await guard.claim(lineageOf(saved.accessToken).sid))) {
        // 只清这个页面自己的副本，不调 logout：那会把原页面一起吊销。
        clearSession();
        setTabConflict(true);
      } else if (saved) {
        await account.start();
        enterAccount(account);
      }
      setChecking(false);
    })();
  }, [account, checking, enterAccount, guard]);

  // 账号事件。IMClient 还没有创建时（保存恢复码页）会话结束也要弹窗。
  useEffect(() => {
    const offs = [
      account.on('tokens', () => {
        const s = account.session;
        if (s) void guard.claim(lineageOf(s.accessToken).sid); // 换了 sid（登录、改密、找回、退出其他设备）换一把锁
      }),
      account.on('recoveryCodeUnacked', () => setRecovery((r) => r ?? { needPassword: true })),
      account.on('ended', (e) => {
        if (e.action === 'logout' || current.current.state.client) return; // 有客户端时从它的 fatal 来，避免两次
        setFatal({
          kind: 'session',
          action: e.action,
          dialog: e.dialog,
          recoverBefore: e.recoverBefore,
          reason: e.reason,
          code: e.code,
        });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [account, guard]);

  useEffect(() => {
    const { client: c, session: s, notices, demoToken } = state;
    if (!c || !s) return;
    const off = c.on('fatal', (r) => setFatal(r));
    const detach = notices?.attach(); // 先订阅再连接：auth 成功时就要补拉（PRD-live C12）
    if (s.mode === 'demo') {
      c.connect(demoToken!); // 已经在连接时 SDK 只更新 token，重复调用没有副作用
    } else {
      // 能走到这里一定登录过（enterAccount 看过 session）。之后才结束的，SDK 发 session 类 fatal（问题 K7），上面已经订阅。
      c.connect(account.tokenProvider);
    }
    return () => {
      off();
      detach?.();
    };
  }, [state, account]);

  // SDK 调试接口（AC-ADM-31-3）：只在开发 / 演示构建里挂到 window，生产构建没有。
  useEffect(() => {
    const c = state.client;
    if (!demoBuildEnabled() || !c) return;
    const w = window as unknown as { __tiantingDebug?: { exportMemory(): unknown } };
    w.__tiantingDebug = { exportMemory: () => c.debugExport() };
    return () => {
      delete w.__tiantingDebug;
    };
  }, [state.client]);

  const [configTry, setConfigTry] = useState(0);
  const reloadConfig = useCallback(() => {
    setConfig({ status: 'loading', value: null });
    setConfigTry((n) => n + 1);
  }, []);
  useEffect(() => {
    let live = true;
    account.getConfig().then(
      (value) => {
        if (!live) return;
        setPref(CONFIG_KEY, JSON.stringify(value));
        setConfig({ status: 'ok', value });
      },
      () => {
        if (live) setConfig({ status: 'failed', value: null });
      },
    );
    return () => {
      live = false;
    };
    // 换 AccountClient（退出）不用重新拉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configTry]);

  const login = useCallback(
    (s: Session) => {
      saveSession(s);
      setFatal(null);
      setTabConflict(false);
      setState(signedIn({ userId: s.userId, mode: 'demo' }, factory, s.token));
    },
    [factory],
  );

  const accountAuthed = useCallback(
    (r: AuthResult) => {
      setTabConflict(false);
      if (r.recoveryCode && r.recoveryCodeGen !== undefined) {
        setRecovery({ code: r.recoveryCode, gen: r.recoveryCodeGen });
        return; // 确认之前不进应用；已经在应用里（改密）时连接照常，只是页面被挡住
      }
      if (!current.current.state.client) enterAccount(account);
    },
    [account, enterAccount],
  );

  const showRecovery = useCallback(
    (r: { recoveryCode: string; recoveryCodeGen: number }) =>
      setRecovery({ code: r.recoveryCode, gen: r.recoveryCodeGen }),
    [],
  );

  const ackRecovery = useCallback(
    async (gen: number) => {
      await account.ackRecoveryCode(gen);
      setRecovery(null);
      if (!current.current.state.client) enterAccount(account);
    },
    [account, enterAccount],
  );

  // 退出登录（F-AUTH-05、F-ACC-04 规则 1）：界面和存储立即清掉，不等 logout 返回；账号会话的断开由 SDK 排在 logout 之后。
  const logout = useCallback(
    (opts?: { keepNoticeSeen?: boolean }) => {
      const { state: st, runtime: rt } = current.current;
      const { client: c, session: s, notices } = st;
      notices?.detach();
      if (s && !opts?.keepNoticeSeen) removePref(noticeSeenKey(s.userId));
      clearSession();
      guard.release();
      setFatal(null);
      setRecovery(null);
      setState(signedOut());
      if (rt.client.session) {
        // 换一个新实例给之后的登录用：旧实例还要等 logout 响应，结束时不能碰新会话和存储。
        rt.detachStore();
        setRuntime(createAccountRuntime(guard, accountDeps));
        void rt.client.logout().finally(() => c?.destroy());
      } else {
        c?.destroy();
      }
    },
    [accountDeps, guard],
  );

  const value = useMemo<ImContextValue>(
    () => ({
      client: state.client,
      session: state.session,
      drafts: state.drafts,
      notices: state.notices,
      account,
      recovery,
      tabConflict,
      config,
      knownConfig: config.status === 'ok' ? config.value : cachedConfig(),
      reloadConfig,
      fatal,
      login,
      accountAuthed,
      showRecovery,
      ackRecovery,
      logout,
    }),
    [
      state,
      account,
      recovery,
      tabConflict,
      config,
      reloadConfig,
      fatal,
      login,
      accountAuthed,
      showRecovery,
      ackRecovery,
      logout,
    ],
  );
  if (checking) return null;
  return <ImContext.Provider value={value}>{children}</ImContext.Provider>;
}

export function useIm(): ImContextValue {
  const v = useContext(ImContext);
  if (!v) throw new Error('useIm must be used inside <ImProvider>');
  return v;
}

/** 登录后的页面里取 SDK 客户端（路由守卫保证非空）。 */
export function useClient(): IMClient {
  const { client } = useIm();
  if (!client) throw new Error('not logged in');
  return client;
}

/**
 * 当前登录的 userId。取自登录会话而不是 SDK 的 client.userId：刷新后页面先于 auth 应答渲染，
 * 那时 client.userId 还是空的，用它判断"是不是会话参与者"会把所有会话都当成不合法。
 */
export function useSelf(): string {
  const { session } = useIm();
  if (!session) throw new Error('not logged in');
  return session.userId;
}
