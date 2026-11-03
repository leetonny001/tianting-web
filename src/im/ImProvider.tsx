import { IMClient, type FatalReason } from '@tianting/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { wsURL } from '../lib/config';
import { clearSession, loadSession, saveSession, type Session } from '../lib/session';

/** 测试注入：创建 SDK 客户端的方式（组件测试用 FakeTransport）。 */
export type ClientFactory = () => IMClient;

const defaultFactory: ClientFactory = () => new IMClient({ url: wsURL(), platform: 'web' });

interface ImContextValue {
  client: IMClient | null;
  session: Session | null;
  /** 被踢 / 登录失效：显示不可关闭的弹窗，点"确定"后回登录页（PRD-ui F-UI-18）。 */
  fatal: FatalReason | null;
  login(s: Session): void;
  logout(): void;
}

const ImContext = createContext<ImContextValue | null>(null);

export function ImProvider({ children, factory = defaultFactory }: { children: ReactNode; factory?: ClientFactory }) {
  // 刷新后用 sessionStorage 里的 token 自动重连，停留在原页面（PRD-core 第 5 节）。
  // 这里只创建客户端，连接放在 effect 里：StrictMode 会把初始化函数执行两次，被丢弃的那个客户端不能建立连接。
  const [state, setState] = useState<{ client: IMClient | null; session: Session | null }>(() => {
    const s = loadSession();
    return s ? { client: factory(), session: s } : { client: null, session: null };
  });
  const [fatal, setFatal] = useState<FatalReason | null>(null);
  const current = useRef(state.client);
  useEffect(() => {
    current.current = state.client;
  }, [state.client]);

  useEffect(() => {
    const { client: c, session: s } = state;
    if (!c || !s) return;
    c.connect(s.token); // 已经在连接时 SDK 只更新 token，重复调用没有副作用
    return c.on('fatal', (r) => setFatal(r)) as () => void;
  }, [state]);

  const login = useCallback(
    (s: Session) => {
      saveSession(s);
      setFatal(null);
      setState({ client: factory(), session: s });
    },
    [factory],
  );

  // 退出登录（F-AUTH-05）：以 1000 关闭、清空内存和 sessionStorage 里的 token。
  const logout = useCallback(() => {
    const c = current.current;
    c?.disconnect();
    c?.destroy();
    clearSession();
    setFatal(null);
    setState({ client: null, session: null });
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
