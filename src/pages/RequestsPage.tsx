import type { FriendRequest } from '@tianting/sdk';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useFriendRequests } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { errCode, userPath } from '../lib/social';

const SOURCE_TEXT: Record<string, string> = {
  search: '通过搜索添加',
  group: '通过群聊添加',
  card: '通过名片添加',
  conv: '通过聊天添加',
};

const SEEN_DEBOUNCE_MS = 200;

/** 新的朋友（PRD-ui F-UI-25）。进入本页即已读；停留期间收到的新申请同样视为已读（去抖 200ms）。 */
export function RequestsPage() {
  const c = useClient();
  const { items, unseen } = useFriendRequests();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<FriendRequest | null>(null);
  const entered = useRef(false);

  useEffect(() => {
    if (!entered.current) {
      entered.current = true;
      c.markFriendRequestsSeen();
      return;
    }
    if (unseen === 0) return;
    const t = setTimeout(() => c.markFriendRequestsSeen(), SEEN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [c, unseen]);

  async function respond(userId: string, action: 'accept' | 'reject') {
    if (busy) return;
    setBusy(userId);
    try {
      await c.respondFriend(userId, action);
    } catch (e) {
      const code = errCode(e);
      toast(messageFor(code, 'friendRespond'));
      if (code === 4045) void c.refreshSocial(); // 该项随后显示"已过期"
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tt-page">
      <TopBar title="新的朋友" back="/contacts" primary />
      <div className="tt-scroll" data-testid="requests">
        {items.length === 0 ? (
          <div className="tt-empty" data-testid="requests-empty">
            <p>暂无新的朋友</p>
          </div>
        ) : (
          items.map((r) => (
            <div
              className="tt-user-row tt-row-between tt-clickable"
              key={`${r.userId}/${r.direction}`}
              data-testid="request-row"
              data-user={r.userId}
              onClick={() =>
                r.direction === 'in' && r.status === 'pending' ? setDetail(r) : navigate(userPath(r.userId))
              }
            >
              <span className="tt-user-main">
                <Avatar id={r.userId} name={r.displayName} size={40} src={r.profile?.avatar} />
                <span className="tt-user-text">
                  <span className="tt-ellipsis">{r.displayName}</span>
                  <span className="tt-secondary tt-ellipsis" data-testid="request-line2">
                    {secondLine(r)}
                  </span>
                </span>
              </span>
              <RequestState
                r={r}
                busy={busy === r.userId}
                onAccept={(e) => {
                  e.stopPropagation();
                  void respond(r.userId, 'accept');
                }}
              />
            </div>
          ))
        )}
      </div>
      {detail && (
        <Dialog
          sheet
          testId="request-sheet"
          onDismiss={() => setDetail(null)}
          actions={
            <>
              <button
                className="tt-btn tt-btn-primary"
                onClick={() => {
                  setDetail(null);
                  void respond(detail.userId, 'accept');
                }}
              >
                同意
              </button>
              <button
                className="tt-btn"
                onClick={() => {
                  setDetail(null);
                  void respond(detail.userId, 'reject');
                }}
              >
                拒绝
              </button>
              <button className="tt-btn" onClick={() => navigate(userPath(detail.userId))}>
                查看资料
              </button>
            </>
          }
        >
          <div className="tt-user-main">
            <Avatar id={detail.userId} name={detail.displayName} size={40} src={detail.profile?.avatar} />
            <span className="tt-user-text">
              <span className="tt-ellipsis">{detail.displayName}</span>
              <span className="tt-secondary">账号：{detail.userId}</span>
            </span>
          </div>
          {detail.message && <p className="tt-sheet-text">{detail.message}</p>}
          {SOURCE_TEXT[detail.source] && (
            <p className="tt-secondary" data-testid="request-source">
              {SOURCE_TEXT[detail.source]}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function secondLine(r: FriendRequest): string {
  if (r.direction === 'in') return r.message || '请求添加你为朋友';
  return r.message ? `我：${r.message}` : '等待对方验证';
}

function RequestState({
  r,
  busy,
  onAccept,
}: {
  r: FriendRequest;
  busy: boolean;
  onAccept: (e: React.MouseEvent) => void;
}) {
  if (r.status === 'expired') return <span className="tt-state-text">已过期</span>;
  if (r.status === 'accepted') return <span className="tt-state-text">已添加</span>;
  if (r.direction === 'out') return <span className="tt-state-text">等待验证</span>;
  if (r.status === 'rejected') return <span className="tt-state-text">已拒绝</span>;
  return (
    <button
      className="tt-btn tt-btn-primary tt-btn-small"
      disabled={busy}
      onClick={onAccept}
      data-testid="request-accept"
    >
      {busy ? '处理中…' : '同意'}
    </button>
  );
}
