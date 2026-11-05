import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useWide } from '../lib/layout';
import { Icon } from './Icon';

export function TopBar({
  title,
  back,
  right,
  primary,
}: {
  title: ReactNode;
  back?: boolean | string | (() => void);
  right?: ReactNode;
  /** 主区的一级页面：宽屏三栏下没有返回按钮（PRD-ui 3.3、3.4 节）。 */
  primary?: boolean;
}) {
  const navigate = useNavigate();
  const wide = useWide();
  return (
    <header className="tt-topbar">
      <div className="tt-topbar-side">
        {back && !(primary && wide) && (
          <button
            className="tt-icon-btn"
            aria-label="返回"
            onClick={() => {
              if (typeof back === 'function') back();
              else if (typeof back === 'string') navigate(back);
              else navigate(-1);
            }}
          >
            <Icon name="back" />
          </button>
        )}
      </div>
      <h1 className="tt-topbar-title">{title}</h1>
      <div className="tt-topbar-side tt-topbar-right">{right}</div>
    </header>
  );
}
