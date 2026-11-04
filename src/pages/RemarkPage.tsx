import { useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useFriends, useSocialLoaded } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { errCode, MAX_REMARK, textLen, userPath } from '../lib/social';
import { decodeParam } from './ChatPage';

/** 设置备注（PRD-ui F-UI-28）：只有我这一侧的好友可以进入。备注只在我的各端显示。 */
export function RemarkPage() {
  const userId = decodeParam(useParams().userId);
  const friend = useFriends().find((f) => f.userId === userId);
  const loaded = useSocialLoaded();
  if (!friend) return loaded ? <Navigate to={userPath(userId)} replace /> : null;
  return (
    <RemarkForm key={userId} userId={userId} current={friend.remark} placeholder={friend.profile?.nickname ?? ''} />
  );
}

function RemarkForm({ userId, current, placeholder }: { userId: string; current: string; placeholder: string }) {
  const c = useClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [value, setValue] = useState(current);
  const inFlight = useRef(false);
  const tooLong = textLen(value) > MAX_REMARK;
  const back = () => navigate(userPath(userId), { replace: true });

  async function done() {
    if (inFlight.current || tooLong) return;
    const next = value.trim();
    if (next === current) return back();
    inFlight.current = true;
    try {
      await c.setFriendRemark(userId, next);
    } catch (e) {
      toast(messageFor(errCode(e), 'friendRemark'));
    } finally {
      inFlight.current = false;
    }
    back();
  }

  return (
    <div className="tt-page">
      <TopBar
        title="设置备注"
        back={userPath(userId)}
        right={
          <button
            className="tt-link tt-topbar-action"
            disabled={tooLong}
            onClick={() => void done()}
            data-testid="remark-done"
          >
            完成
          </button>
        }
      />
      <div className="tt-form">
        <input
          className="tt-input"
          aria-label="备注"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="remark-input"
        />
        {tooLong && (
          <p className="tt-field-error" role="alert">
            最多 {MAX_REMARK} 个字
          </p>
        )}
      </div>
    </div>
  );
}
