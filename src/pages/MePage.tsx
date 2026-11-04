import { Link } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { TabBar } from '../components/TabBar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useSelf } from '../im/ImProvider';
import { useOfficial, useProfile } from '../im/hooks';
import { copyText } from '../lib/clipboard';

/** 我（PRD-ui F-UI-15）：一期不提供资料编辑。显示名来自 users 缓存里的自己。 */
export function MePage() {
  const userId = useSelf();
  const toast = useToast();
  const profile = useProfile(userId);
  const official = useOfficial();
  const name = profile?.nickname || userId;
  return (
    <div className="tt-page">
      <TopBar title="我" />
      <div className="tt-scroll">
        <div className="tt-card tt-info-head">
          <Avatar id={userId} name={name} size={64} src={profile?.avatar} />
          <div>
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
        </div>
        <Link className="tt-row" to="/me/settings" data-testid="me-settings">
          设置
        </Link>
      </div>
      <TabBar />
    </div>
  );
}
