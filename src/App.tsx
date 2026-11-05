import type { FatalReason } from '@tianting/sdk';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  type Location,
} from 'react-router';
import { ConnBanner } from './components/ConnBanner';
import { DemoPanel } from './components/DemoPanel';
import { Dialog } from './components/Dialog';
import { SidePanel } from './components/SidePanel';
import { NoticeBanner } from './components/NoticeBanner';
import { NavRail } from './components/TabBar';
import { ToastProvider, useToast } from './components/Toast';
import { WideEmpty } from './components/WideEmpty';
import { ImProvider, useIm, type ClientFactory } from './im/ImProvider';
import { usePendingCount, useTotalUnread } from './im/hooks';
import { APP_NAME } from './lib/config';
import { bannedText, messageFor } from './lib/errors';
import { isGroupConv } from './lib/group';
import { useWide, wideRoute } from './lib/layout';
import { safeRedirect } from './lib/routes';
import { ChatInfoPage } from './pages/ChatInfoPage';
import { ChatPage, decodeParam } from './pages/ChatPage';
import { ChatsPage } from './pages/ChatsPage';
import { AddFriendPage } from './pages/AddFriendPage';
import { ApplyPage } from './pages/ApplyPage';
import { AppearancePage } from './pages/AppearancePage';
import { BlocksPage } from './pages/BlocksPage';
import { ContactsPage } from './pages/ContactsPage';
import { GroupInvitePage } from './pages/GroupInvitePage';
import { GroupMembersPage } from './pages/GroupMembersPage';
import { GroupNewPage } from './pages/GroupNewPage';
import { GroupNoticePage } from './pages/GroupNoticePage';
import { GroupsPage } from './pages/GroupsPage';
import { LoginPage } from './pages/LoginPage';
import { MePage } from './pages/MePage';
import { NoticesPage } from './pages/NoticesPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { RemarkPage } from './pages/RemarkPage';
import { RequestsPage } from './pages/RequestsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UserPage } from './pages/UserPage';

export function App({ factory }: { factory?: ClientFactory }) {
  return (
    <BrowserRouter>
      <ImProvider factory={factory}>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </ImProvider>
    </BrowserRouter>
  );
}

/** 群子页面只对群会话有效；其他 convId 回到会话列表。 */
function GroupOnly({ page }: { page: ReactNode }) {
  const convId = useParams().convId ?? '';
  return isGroupConv(convId) ? page : <Navigate to="/chats" replace />;
}

export function AppRoutes() {
  const { session } = useIm();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1';
  const wide = useWide() && !!session;
  // 侧板后面的聊天页要记到下一次导航：从聊天页打开的资料卡路由里没有会话 ID（3.3 节）。
  const [chatBehind, setChatBehind] = useState<string | null>(null);
  const route = wideRoute(location.pathname, chatBehind);
  if (route.chatBehind !== chatBehind) setChatBehind(route.chatBehind);
  const panel = wide && route.panel;
  const mainLocation = panel ? { pathname: route.mainPath, search: '', hash: '', state: null, key: 'main' } : location;
  const openConv = wide && route.section === 'chats' && route.mainPath.startsWith('/chat/') ? route.mainPath : null;
  // 窄屏、宽屏共用这一棵树（条件部分只占位）：<main> 里的页面在视口跨过宽屏条件时不重新挂载，
  // 连接在 ImProvider 里更不受影响（F-UI-02 规则 2）。
  return (
    <>
      <div className="tt-app" data-testid="app" data-layout={wide ? 'wide' : 'narrow'}>
        {wide && <NavRail section={route.section} />}
        <div className="tt-body">
          {wide && <ConnBanner global />}
          <div className="tt-columns">
            {wide && (
              <div className="tt-list-col" data-testid="list-column">
                {route.section === 'chats' ? (
                  <ChatsPage activeConvId={openConv ? decodeParam(openConv.slice('/chat/'.length)) : undefined} />
                ) : route.section === 'contacts' ? (
                  <ContactsPage />
                ) : (
                  <MePage />
                )}
              </div>
            )}
            <main className="tt-main" data-testid="main">
              <Pages location={mainLocation} wide={wide} />
              {panel && (
                <SidePanel closeTo={route.mainPath}>
                  <Pages location={location} wide={wide} />
                </SidePanel>
              )}
            </main>
          </div>
        </div>
        {session && <NoticeBanner />}
      </div>
      {session && <SessionEffects />}
      {session && demo && <DemoPanel />}
    </>
  );
}

/** 路由表。宽屏时列表栏已经有一级页面，主区对应显示空态 / 设置内容（3.3 节）。 */
function Pages({ location, wide }: { location: Partial<Location> | Location; wide: boolean }) {
  const { session } = useIm();
  const params = new URLSearchParams(location.search);
  return (
    <Routes location={location}>
      {/* 已登录访问 /login：去 redirect 指定的站内页面（校验后），没有就去 /chats（F-UI-01 规则 2、3）。 */}
      <Route
        path="/login"
        element={session ? <Navigate to={safeRedirect(params.get('redirect'))} replace /> : <LoginPage />}
      />
      <Route
        path="/chats"
        element={<Authed>{wide ? <WideEmpty text="选择一个会话开始聊天" /> : <ChatsPage />}</Authed>}
      />
      <Route
        path="/chat/:convId"
        element={
          <Authed>
            <ChatPage />
          </Authed>
        }
      />
      <Route
        path="/chat/:convId/info"
        element={
          <Authed>
            <ChatInfoPage />
          </Authed>
        }
      />
      <Route path="/contacts" element={<Authed>{wide ? <WideEmpty /> : <ContactsPage />}</Authed>} />
      {(
        [
          ['/groups/new', <GroupNewPage />],
          ['/chat/:convId/notice', <GroupOnly page={<GroupNoticePage />} />],
          ['/chat/:convId/members', <GroupOnly page={<GroupMembersPage />} />],
          ['/chat/:convId/invite', <GroupOnly page={<GroupInvitePage />} />],
          ['/contacts/requests', <RequestsPage />],
          ['/contacts/groups', <GroupsPage />],
          ['/contacts/add', <AddFriendPage />],
          ['/contacts/apply/:userId', <ApplyPage />],
          ['/user/:userId', <UserPage />],
          ['/user/:userId/remark', <RemarkPage />],
          ['/me/notices', <NoticesPage />],
          ['/me/settings/blocks', <BlocksPage />],
          ['/me/settings/privacy', <PrivacyPage />],
          ['/me/settings/appearance', <AppearancePage />],
        ] as const
      ).map(([path, page]) => (
        <Route key={path} path={path} element={<Authed>{page}</Authed>} />
      ))}
      <Route path="/me" element={<Authed>{wide ? <SettingsPage /> : <MePage />}</Authed>} />
      <Route
        path="/me/settings"
        element={
          <Authed>
            <SettingsPage />
          </Authed>
        }
      />
      <Route path="*" element={<Navigate to={session ? '/chats' : '/login'} replace />} />
    </Routes>
  );
}

/** 路由守卫（PRD-ui F-UI-01 规则 2）：未登录跳到 /login?redirect=原路径。 */
function Authed({ children }: { children: ReactNode }) {
  const { session } = useIm();
  const loc = useLocation();
  if (!session) return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

const KICK_TEXT: Record<string, string> = {
  tokenInvalid: '登录已失效，请重新登录',
  tokenExpired: '登录已过期，请重新登录',
  banned: '账号已被下线',
  tooManyConnections: '登录设备过多，当前设备已下线',
};

/** 被踢弹窗文案（PRD-ui F-UI-18）：先按 kicked.reason，不认识时按关闭码。 */
export function fatalText(r: FatalReason): string {
  if (r.kind === 'kicked' && r.reason === 'suspended') return bannedText(r.until);
  if (r.kind === 'kicked' && KICK_TEXT[r.reason]) return KICK_TEXT[r.reason]!;
  if (r.code === 4429) return KICK_TEXT.tooManyConnections!;
  return messageFor(r.code);
}

/** 登录后的全局行为：标签页标题、离开页面提示、发送失败轻提示、被踢弹窗。 */
function SessionEffects() {
  const { client, fatal, logout } = useIm();
  const total = useTotalUnread();
  const pending = usePendingCount();
  const toast = useToast();
  const navigate = useNavigate();

  // 标签页标题（F-UI-23）："(7) 天听"，0 时为"天听"。
  useEffect(() => {
    document.title = total > 0 ? `(${total}) ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [total]);

  // 有发送中 / 失败的消息时离开页面要确认（AC-MSG-03-5）。
  useEffect(() => {
    if (pending === 0) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [pending]);

  // 发送失败每次只提示一次（F-UI-08 规则 3）：超时和被踢不弹轻提示。
  useEffect(
    () =>
      client?.on('sendFailed', (_conv, _id, err) => {
        // 4035 / 4036 / 4137 在聊天页插入提示条（F-UI-31），4031 有禁用条（F-UI-41 规则 5），都不弹轻提示。
        if (typeof err === 'number' && ![4031, 4035, 4036, 4137].includes(err)) toast(messageFor(err, 'send'));
      }) as (() => void) | undefined,
    [client, toast],
  );

  // 被踢弹窗不能用浏览器后退关闭（AC-UI-18-1）：弹窗期间每次后退都把当前地址推回去。
  useEffect(() => {
    if (!fatal) return;
    const here = window.location.href;
    window.history.pushState(null, '', here);
    const onPop = () => window.history.pushState(null, '', here);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [fatal]);

  if (!fatal) return null;
  return (
    <Dialog
      testId="kicked-dialog"
      dismissible={false}
      actions={
        <button
          className="tt-btn tt-btn-primary"
          onClick={() => {
            logout({ keepNoticeSeen: true });
            navigate('/login', { replace: true });
          }}
        >
          确定
        </button>
      }
    >
      {fatalText(fatal)}
    </Dialog>
  );
}
