import { NavLink, useLocation } from 'react-router';
import { useFriendRequests, useTotalUnread } from '../im/hooks';
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
