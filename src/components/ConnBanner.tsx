import { useBanner, useConnState } from '../im/hooks';
import { Icon } from './Icon';

/** 连接状态条（PRD-ui F-UI-17、F-CONN-02）：断开持续超过 1 秒才显示（由 SDK 的 banner 事件计时）；把内容下推，不覆盖。 */
export function ConnBanner() {
  const show = useBanner();
  useConnState(); // 状态变化时重新读取 navigator.onLine
  if (!show) return null;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  return (
    <div className="tt-banner" role="status" data-testid="conn-banner">
      <Icon name={offline ? 'failed' : 'loading'} size={16} />
      <span>{offline ? '网络不可用' : '连接中…'}</span>
    </div>
  );
}
