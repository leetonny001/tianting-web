import type { Friend } from '@tianting/sdk';
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { ConnBanner } from '../components/ConnBanner';
import { Icon } from '../components/Icon';
import { RowsSkeleton } from '../components/RowsSkeleton';
import { badgeText, TabBar } from '../components/TabBar';
import { TopBar } from '../components/TopBar';
import { useFriendRequests, useFriends, useSocialLoaded } from '../im/hooks';
import { groupByPinyin } from '../lib/pinyin';
import { userPath } from '../lib/social';

/** 通讯录（PRD-ui F-UI-13）：新的朋友入口 + 群聊入口 + 好友列表。开放模式下也只显示好友。 */
export function ContactsPage() {
  const friends = useFriends();
  const loaded = useSocialLoaded();
  const unseen = useFriendRequests().unseen;
  const navigate = useNavigate();
  const groups = useMemo(
    () =>
      groupByPinyin(
        friends,
        (f) => f.displayName,
        (f) => f.userId,
      ),
    [friends],
  );
  return (
    <div className="tt-page">
      <TopBar
        title="通讯录"
        right={
          <button
            className="tt-icon-btn"
            aria-label="添加朋友"
            onClick={() => navigate('/contacts/add')}
            data-testid="contacts-add"
          >
            <Icon name="addFriend" />
          </button>
        }
      />
      <ConnBanner />
      <div className="tt-scroll" data-testid="contacts">
        <Link className="tt-row tt-row-between" to="/contacts/requests" data-testid="entry-requests">
          <span>新的朋友</span>
          {unseen > 0 && (
            <span className="tt-count-badge" data-testid="requests-badge">
              {badgeText(unseen)}
            </span>
          )}
        </Link>
        <Link className="tt-row" to="/contacts/groups" data-testid="entry-groups">
          群聊
        </Link>
        {!loaded ? (
          <RowsSkeleton testId="contacts-skeleton" />
        ) : friends.length === 0 ? (
          <div className="tt-empty" data-testid="contacts-empty">
            <p>还没有朋友</p>
            <button className="tt-btn tt-btn-primary" onClick={() => navigate('/contacts/add')}>
              添加朋友
            </button>
          </div>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.group} data-testid={`group-${g.group}`}>
                <h2 className="tt-group-letter">{g.group}</h2>
                {g.items.map((f) => (
                  <FriendRow key={f.userId} f={f} />
                ))}
              </section>
            ))}
            <p className="tt-list-foot" data-testid="contacts-count">
              {friends.length} 位朋友
            </p>
          </>
        )}
      </div>
      <TabBar />
    </div>
  );
}

function FriendRow({ f }: { f: Friend }) {
  return (
    <Link className="tt-user-row" to={userPath(f.userId)} data-testid="friend-row" data-user={f.userId}>
      <Avatar id={f.userId} name={f.displayName} size={40} src={f.profile?.avatar} />
      <span className="tt-ellipsis" data-testid="friend-name">
        {f.displayName}
      </span>
      {f.profile?.official && <OfficialTag />}
      {f.blocked && <span className="tt-tag">已拉黑</span>}
    </Link>
  );
}
