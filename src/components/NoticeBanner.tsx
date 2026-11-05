import { useNavigate } from 'react-router';
import { useIm } from '../im/ImProvider';
import { useNotices } from '../im/hooks';

/** 系统通知横幅（PRD-ui F-UI-44 规则 2）：容器顶部，5 秒；新的替换旧的；点击进系统通知页。文本按纯文本渲染。 */
export function NoticeBanner() {
  const { notices } = useIm();
  const { banner } = useNotices();
  const navigate = useNavigate();
  return (
    <div className="tt-notice-layer" aria-live="polite">
      {banner && (
        <button
          className="tt-notice-banner"
          key={banner.n}
          data-testid="notice-banner"
          onClick={() => {
            notices?.dismissBanner();
            navigate('/me/notices');
          }}
        >
          {banner.text}
        </button>
      )}
    </div>
  );
}
