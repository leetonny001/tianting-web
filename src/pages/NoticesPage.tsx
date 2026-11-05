import { useEffect } from 'react';
import { TopBar } from '../components/TopBar';
import { useIm } from '../im/ImProvider';
import { useNotices } from '../im/hooks';
import { formatTime } from '../lib/time';

/** 我 → 系统通知（PRD-ui F-UI-44、PRD-live F-PUSH-12）：按 ts 倒序，最多 100 条；打开时未查看清零，停留期间不计数。 */
export function NoticesPage() {
  const { notices } = useIm();
  const { list } = useNotices();
  useEffect(() => {
    notices?.enterPage();
    return () => notices?.leavePage();
  }, [notices]);
  return (
    <div className="tt-page">
      <TopBar title="系统通知" back="/me" />
      <div className="tt-scroll" data-testid="notices">
        {list.length === 0 ? (
          <div className="tt-empty" data-testid="notices-empty">
            <p>暂无系统通知</p>
          </div>
        ) : (
          list.map((n) => (
            <div className="tt-card tt-notice-item" key={n.pushId} data-testid="notice-item" data-push={n.pushId}>
              <div className="tt-notice-text">{n.text}</div>
              <div className="tt-secondary tt-notice-time">{formatTime(n.ts)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
