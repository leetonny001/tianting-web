import { type GroupMemberInfo, type GroupRole } from '@tianting/sdk';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { useClient, useSelf } from '../im/ImProvider';
import { useFriends } from '../im/hooks';

const SEARCH_DELAY_MS = 300; // 每人每分钟 30 次（F-MEN-01 规则 6）：停下来再搜

export type MentionPick = { userId: string; name: string } | { all: true; name: string };

/**
 * @ 成员选择（PRD-chat F-MEN-01 规则 4、6，F-MEN-02 规则 3，第 13.4 节"@ 选择"）：keyword 搜索；加载中、无结果、加载失败；
 * 列表显示本机显示名（备注优先）、头像和 userId（同名成员靠这两样区分，问题 18），插入文字用公开昵称（R-CF-03）。
 * "所有人"只给群主、管理员（AC-MEN-02-4）。关掉选择时 @ 留作普通文字，可以继续发（加载失败也一样）。
 */
export function MentionPicker({
  groupId,
  myRole,
  onPick,
  onClose,
}: {
  groupId: string;
  myRole?: GroupRole;
  onPick: (p: MentionPick) => void;
  onClose: () => void;
}) {
  const c = useClient();
  const self = useSelf();
  useFriends(); // 备注变化时刷新
  const [keyword, setKeyword] = useState('');
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [members, setMembers] = useState<GroupMemberInfo[]>([]);
  const [cursor, setCursor] = useState('');
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 发起搜索前进入"加载中"，和请求是同一个外部同步过程
    setState('loading');
    const t = setTimeout(
      () => {
        c.searchGroupMembers(groupId, keyword.trim()).then(
          (r) => {
            if (mine !== generation.current) return;
            setMembers(r.members);
            setCursor(r.nextCursor);
            setState('ok');
          },
          () => {
            if (mine === generation.current) setState('error');
          },
        );
      },
      keyword ? SEARCH_DELAY_MS : 0,
    );
    return () => clearTimeout(t);
  }, [c, groupId, keyword, attempt]);

  async function more() {
    const mine = generation.current;
    try {
      const r = await c.searchGroupMembers(groupId, keyword.trim(), cursor);
      if (mine !== generation.current) return;
      const seen = new Set(members.map((m) => m.userId));
      setMembers([...members, ...r.members.filter((m) => !seen.has(m.userId))]);
      setCursor(r.nextCursor);
    } catch {
      // 留着已有的列表，再点一次
    }
  }

  const list = members.filter((m) => m.userId !== self); // 自己 @ 自己不算提及（F-MEN-03 规则 6）
  const canAll = (myRole === 'owner' || myRole === 'admin') && keyword.trim() === '';
  return (
    <Dialog
      sheet
      title="选择提醒的人"
      testId="mention-picker"
      onDismiss={onClose}
      actions={
        <button className="tt-btn" onClick={onClose} data-testid="mention-cancel">
          取消
        </button>
      }
    >
      <input
        className="tt-input"
        type="search"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="搜索群成员"
        aria-label="搜索群成员"
        enterKeyHint="search"
        autoFocus
        data-testid="mention-search"
      />
      <div className="tt-mention-list" aria-busy={state === 'loading'} data-testid="mention-list">
        {canAll && (
          <button
            className="tt-user-row tt-mention-row"
            onClick={() => onPick({ all: true, name: '所有人' })}
            data-testid="mention-all"
          >
            <span className="tt-mention-all-mark" aria-hidden="true">
              @
            </span>
            <span className="tt-ellipsis">所有人</span>
          </button>
        )}
        {state === 'loading' ? (
          <p className="tt-mention-state" data-testid="mention-loading">
            加载中…
          </p>
        ) : state === 'error' ? (
          <button
            className="tt-link tt-mention-state"
            onClick={() => setAttempt((n) => n + 1)}
            data-testid="mention-error"
          >
            加载失败，点击重试
          </button>
        ) : list.length === 0 ? (
          <p className="tt-mention-state" data-testid="mention-empty">
            没有找到群成员
          </p>
        ) : (
          list.map((m) => {
            const shown = c.displayName(m.userId);
            return (
              <button
                key={m.userId}
                className="tt-user-row tt-mention-row"
                onClick={() => onPick({ userId: m.userId, name: m.nickname || m.userId })}
                data-testid="mention-row"
                data-user={m.userId}
              >
                <Avatar id={m.userId} name={shown} size={40} src={m.avatar} />
                <span className="tt-mention-names">
                  <span className="tt-ellipsis">{shown}</span>
                  <span className="tt-mention-id tt-ellipsis">{m.userId}</span>
                </span>
              </button>
            );
          })
        )}
        {state === 'ok' && cursor && (
          <button className="tt-link tt-mention-state" onClick={() => void more()} data-testid="mention-more">
            加载更多
          </button>
        )}
      </div>
    </Dialog>
  );
}
