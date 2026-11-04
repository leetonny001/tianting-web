import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from './Icon';

export function TopBar({
  title,
  back,
  right,
}: {
  title: ReactNode;
  back?: boolean | string | (() => void);
  right?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="tt-topbar">
      <div className="tt-topbar-side">
        {back && (
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
