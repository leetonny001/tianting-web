import { IMClient, type FatalReason } from '@tianting/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_LOGIN, wsURL } from '../lib/config';
import { clearSession, loadSession, saveSession, type Session } from '../lib/session';
import { removePref } from '../lib/uiPrefs';
import { DraftStore } from './drafts';
import { NoticeStore, noticeSeenKey } from './notices';

/** 测试注入：创建 SDK 客户端的方式（组件测试用 FakeTransport）。 */
export type ClientFactory = () => IMClient;

const defaultFactory: ClientFactory = () => new IMClient({ url: wsURL(), platform: 'web' });

interface ImContextValue {
  client: IMClient | null;
  session: Session | null;
  /** 本次登录的草稿（F-UI-24）：退出登录就换一个新的。 */
  drafts: DraftStore;
  /** 本次登录的系统通知（F-UI-44）：列表只在内存。 */
  notices: NoticeStore | null;
  /** 被踢 / 登录失效：显示不可关闭的弹窗，点"确定"后回登录页（PRD-ui F-UI-18）。 */
  fatal: FatalReason | null;
  login(s: Session): void;
  /** keepNoticeSeen：被踢、凭证失效时不删 ui.noticeSeen（PRD-live F-PUSH-12 规则 5），重新登录后不重复提醒。 */
  logout(opts?: { keepNoticeSeen?: boolean }): void;
}

const ImContext = createContext<ImContextValue | null>(null);

type SessionState = Pick<ImContextValue, 'client' | 'session' | 'drafts' | 'notices'>;

function newSession(s: Session | null, factory: ClientFactory): Omit<SessionState, 'drafts'> {
  if (!s) return { client: null, session: null, notices: null };
  const client = factory();
  return { client, session: s, notices: new NoticeStore(client, s.userId) };
}

export function ImProvider({ children, factory = defaultFactory }: { children: ReactNode; factory?: ClientFactory }) {
  // 刷新后用 sessionStorage 里的 token 自动重连，停留在原页面（PRD-core 第 5 节）。
  // 这里只创建客户端，连接放在 effect 里：StrictMode 会把初始化函数执行两次，被丢弃的那个客户端不能建立连接。
  const [state, setState] = useState<SessionState>(() => {
    const s = loadSession();
    return { ...newSession(s, factory), drafts: new DraftStore() };
  });
  const [fatal, setFatal] = useState<FatalReason | null>(null);
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  }, [state]);

  useEffect(() => {
    const { client: c, session: s, notices } = state;
    if (!c || !s) return;
    const detach = notices?.attach(); // 先订阅再连接：auth 成功时就要补拉（PRD-live C12）
    c.connect(s.token); // 已经在连接时 SDK 只更新 token，重复调用没有副作用
    const off = c.on('fatal', (r) => setFatal(r));
    return () => {
      off();
      detach?.();
    };
  }, [state]);

  // SDK 调试接口（AC-ADM-31-3）：只在开发 / 演示构建里挂到 window，生产构建没有。
  useEffect(() => {
    const c = state.client;
    if (!DEMO_LOGIN || !c) return;
    const w = window as unknown as { __tiantingDebug?: { exportMemory(): unknown } };
    w.__tiantingDebug = { exportMemory: () => c.debugExport() };
    return () => {
      delete w.__tiantingDebug;
    };
  }, [state.client]);

  const login = useCallback(
    (s: Session) => {
      saveSession(s);
      setFatal(null);
      setState({ ...newSession(s, factory), drafts: new DraftStore() });
    },
    [factory],
  );

  // 退出登录（F-AUTH-05）：以 1000 关闭、清空内存和 sessionStorage 里的 token。
  const logout = useCallback((opts?: { keepNoticeSeen?: boolean }) => {
    const { client: c, session: s, notices } = current.current;
    notices?.detach();
    c?.disconnect();
    c?.destroy();
    if (s && !opts?.keepNoticeSeen) removePref(noticeSeenKey(s.userId));
    clearSession();
    setFatal(null);
    setState({ client: null, session: null, notices: null, drafts: new DraftStore() });
  }, []);

  const value = useMemo(() => ({ ...state, fatal, login, logout }), [state, fatal, login, logout]);
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
