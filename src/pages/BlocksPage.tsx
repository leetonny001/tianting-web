import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar } from '../components/Avatar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useBlocks } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { errCode, userPath } from '../lib/social';

/** 黑名单（PRD-ui F-UI-29）：按 createdAt 倒序；拉黑入口只在资料卡。 */
export function BlocksPage() {
  const c = useClient();
  const blocks = useBlocks();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function unblock(userId: string) {
    if (busy) return;
    setBusy(userId);
    try {
      await c.unblock(userId);
      toast('已移出黑名单');
    } catch (e) {
      toast(messageFor(errCode(e), 'unblock'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tt-page">
      <TopBar title="黑名单" back="/me/settings" />
      <div className="tt-scroll" data-testid="blocks">
        {blocks.length === 0 ? (
          <div className="tt-empty" data-testid="blocks-empty">
            <p>黑名单为空</p>
          </div>
        ) : (
          blocks.map((b) => (
            <div
              className="tt-user-row tt-row-between tt-clickable"
              key={b.userId}
              data-testid="block-row"
              data-user={b.userId}
              onClick={() => navigate(userPath(b.userId))}
            >
              <span className="tt-user-main">
                <Avatar id={b.userId} name={b.displayName} size={40} src={b.profile?.avatar} />
                <span className="tt-ellipsis">{b.displayName}</span>
              </span>
              <button
                className="tt-btn tt-btn-small"
                disabled={busy === b.userId}
                onClick={(e) => {
                  e.stopPropagation();
                  void unblock(b.userId);
                }}
                data-testid="block-remove"
              >
                移出
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
