import { Link, NavLink, useLocation } from 'react-router';
import { useSelf } from '../im/ImProvider';
import { useFriendRequests, useProfile, useTotalUnread } from '../im/hooks';
import { useWide, type Section } from '../lib/layout';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';

const tabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/chats', label: '消息', icon: 'chats' },
  { to: '/contacts', label: '通讯录', icon: 'contacts' },
  { to: '/me', label: '我', icon: 'me' },
];

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** 底部标签栏（PRD-ui F-UI-01、F-UI-23）："消息"带总未读角标，"通讯录"带新的朋友红点；点击已选中的"消息"让列表回到顶部。 */
export function TabBar({ onReselectChats }: { onReselectChats?: () => void }) {
  const total = useTotalUnread();
  const unseen = useFriendRequests().unseen;
  const { pathname } = useLocation();
  const wide = useWide();
  if (wide) return null; // 宽屏用左侧导航栏
  return (
    <nav className="tt-tabbar" aria-label="主导航">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) => `tt-tab${isActive ? ' tt-tab-active' : ''}`}
          data-testid={`tab-${t.icon}`}
          onClick={(e) => {
            if (t.to === '/chats' && pathname === '/chats') {
              e.preventDefault();
              onReselectChats?.();
            }
          }}
        >
          <span className="tt-tab-icon">
            <Icon name={t.icon} />
            {t.to === '/chats' && total > 0 && (
              <span className="tt-badge" data-testid="tab-badge">
                {badgeText(total)}
              </span>
            )}
            {t.to === '/contacts' && unseen > 0 && (
              <span className="tt-badge" data-testid="tab-contacts-badge">
                {badgeText(unseen)}
              </span>
            )}
          </span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** 宽屏左侧导航栏（PRD-ui 3.3 节，宽 64）：顶部当前用户头像，下面三个导航项，"设置"固定在底部。 */
export function NavRail({ section }: { section: Section }) {
  const total = useTotalUnread();
  const unseen = useFriendRequests().unseen;
  const self = useSelf();
  const profile = useProfile(self);
  const { pathname } = useLocation();
  const inSettings = pathname.startsWith('/me/settings');
  const name = profile?.nickname || self;
  return (
    <nav className="tt-rail" aria-label="主导航" data-testid="nav-rail">
      <span className="tt-rail-avatar" data-testid="rail-avatar">
        <Avatar id={self} name={name} size={36} src={profile?.avatar} />
      </span>
      {tabs.map((t) => {
        const active = t.to === `/${section}` && !inSettings;
        return (
          <Link
            key={t.to}
            to={t.to}
            className={`tt-rail-item${active ? ' tt-tab-active' : ''}`}
            // 角标的数字是能看见的文字，可读名称要包含它（axe label-content-name-mismatch，C5 的免打扰角标测出来的）
            aria-label={
              t.to === '/chats' && total > 0
                ? `${t.label}，${badgeText(total)} 条未读`
                : t.to === '/contacts' && unseen > 0
                  ? `${t.label}，${badgeText(unseen)} 个新的朋友`
                  : t.label
            }
            aria-current={active ? 'page' : undefined}
            title={t.label}
            data-testid={`tab-${t.icon}`}
            onClick={(e) => {
              // 点击已选中的"消息"，列表回到顶部（F-UI-01 规则 4）
              if (t.to === '/chats' && pathname === '/chats') {
                e.preventDefault();
                document.querySelector('[data-testid="conv-list"]')?.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }}
          >
            <span className="tt-tab-icon">
              <Icon name={t.icon} />
              {t.to === '/chats' && total > 0 && (
                <span className="tt-badge" data-testid="tab-badge">
                  {badgeText(total)}
                </span>
              )}
              {t.to === '/contacts' && unseen > 0 && (
                <span className="tt-badge" data-testid="tab-contacts-badge">
                  {badgeText(unseen)}
                </span>
              )}
            </span>
          </Link>
        );
      })}
      <Link
        className={`tt-rail-item tt-rail-bottom${inSettings ? ' tt-tab-active' : ''}`}
        to="/me/settings"
        aria-label="设置"
        aria-current={inSettings ? 'page' : undefined}
        title="设置"
        data-testid="rail-settings"
      >
        <Icon name="settings" />
      </Link>
    </nav>
  );
}
