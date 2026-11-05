import { useBanner, useConnState } from '../im/hooks';
import { useWide } from '../lib/layout';
import { Icon } from './Icon';

/**
 * 连接状态条（PRD-ui F-UI-17、F-CONN-02）：断开持续超过 1 秒才显示（由 SDK 的 banner 事件计时）；把内容下推，不覆盖。
 * 宽屏只有应用顶部一条（global），页面里的不显示。
 */
export function ConnBanner({ global = false }: { global?: boolean }) {
  const show = useBanner();
  const wide = useWide();
  useConnState(); // 状态变化时重新读取 navigator.onLine
  if (!show || wide !== global) return null;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  return (
    <div className="tt-banner" role="status" data-testid="conn-banner">
      <Icon name={offline ? 'failed' : 'loading'} size={16} />
      <span>{offline ? '网络不可用' : '连接中…'}</span>
    </div>
  );
}
