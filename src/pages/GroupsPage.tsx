import type { MyGroup } from '@tianting/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/Avatar';
import { RowsSkeleton } from '../components/RowsSkeleton';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useConnState } from '../im/hooks';
import { compareNames } from '../lib/pinyin';
import { chatPath } from '../lib/routes';

/** 群聊列表（PRD-ui F-UI-32）：每次进入重新加载；不受会话列表 500 个上限影响。 */
export function GroupsPage() {
  const c = useClient();
  const connected = useConnState() === 'connected';
  const [groups, setGroups] = useState<MyGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    c.loadMyGroups().then(setGroups, () => setFailed(true));
  }, [c]);
  useEffect(() => {
    if (connected) load();
  }, [connected, load]);
  const sorted = useMemo(() => {
    const cmp = compareNames();
    return [...(groups ?? [])].sort(
      (a, b) => cmp(a.name, b.name) || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0),
    );
  }, [groups]);
  return (
    <div className="tt-page">
      <TopBar title="群聊" back="/contacts" primary />
      <div className="tt-scroll" data-testid="groups">
        {failed ? (
          <button
            className="tt-link tt-center tt-block-btn"
            data-testid="groups-retry"
            onClick={() => {
              setFailed(false);
              setGroups(null);
              load();
            }}
          >
            加载失败，点击重试
          </button>
        ) : !groups ? (
          <RowsSkeleton testId="groups-skeleton" />
        ) : groups.length === 0 ? (
          <div className="tt-empty" data-testid="groups-empty">
            <p>还没有加入群聊</p>
          </div>
        ) : (
          <>
            <p className="tt-list-head" data-testid="groups-count">
              {groups.length} 个群聊
            </p>
            {sorted.map((g) => (
              <Link
                className="tt-user-row tt-row-between"
                to={chatPath(`group:${g.groupId}`)}
                key={g.groupId}
                data-testid="group-row"
              >
                <span className="tt-user-main">
                  <Avatar id={g.groupId} name={g.name} size={40} group />
                  <span className="tt-ellipsis">{g.name}</span>
                </span>
                <span className="tt-secondary">{g.memberCount} 人</span>
              </Link>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
