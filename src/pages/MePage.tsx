import { Link } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { TabBar } from '../components/TabBar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { Icon } from '../components/Icon';
import { useIm, useSelf } from '../im/ImProvider';
import { useNotices, useOfficial, useProfile } from '../im/hooks';
import { copyText } from '../lib/clipboard';

/** 我（PRD-ui F-UI-15）：账号会话可以改昵称（PRD-chat F-ACC-06，头像随 C2），演示会话不提供。显示名来自 users 缓存里的自己。 */
export function MePage() {
  const userId = useSelf();
  const { session } = useIm();
  const toast = useToast();
  const profile = useProfile(userId);
  const official = useOfficial();
  const { unseen } = useNotices();
  const name = profile?.nickname || userId;
  return (
    <div className="tt-page">
      <TopBar title="我" />
      <div className="tt-scroll">
        <div className="tt-card tt-info-head">
          <Avatar id={userId} name={name} size={64} src={profile?.avatar} />
          <div className="tt-me-info">
            <div className="tt-info-name tt-large" data-testid="me-name">
              {name} {official && <OfficialTag />}
            </div>
            <div className="tt-secondary">
              账号：{userId}
              <button
                className="tt-link tt-inline-btn"
                onClick={async () => toast((await copyText(userId)) ? '已复制' : '复制失败，请长按文字手动复制')}
              >
                复制
              </button>
            </div>
          </div>
          {session?.mode === 'account' && (
            <Link className="tt-icon-btn" to="/me/profile" aria-label="编辑资料" data-testid="me-edit">
              <Icon name="forward" />
            </Link>
          )}
        </div>
        <Link className="tt-row" to="/me/settings" data-testid="me-settings">
          设置
        </Link>
        <Link className="tt-row tt-row-between" to="/me/notices" data-testid="me-notices">
          <span>系统通知</span>
          {unseen > 0 && (
            <span className="tt-count-badge" data-testid="me-notices-count">
              {unseen}
            </span>
          )}
        </Link>
      </div>
      <TabBar />
    </div>
  );
}
