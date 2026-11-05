import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isTopLayer, useFocusTrap } from '../lib/focus';

const InPanel = createContext(false);

/** 这个页面是不是显示在宽屏侧板里（后面还留着聊天页）。 */
export const useInPanel = () => useContext(InPanel);

/**
 * 宽屏右侧侧板（PRD-ui 3.3 节，宽 360）：聊天信息、成员、资料卡。点遮罩或 Esc 关闭（回到主区的路由），
 * 焦点还给打开它的按钮，没有时给聊天页的"更多"（AC-UI-90-9）。
 */
export function SidePanel({ closeTo, children }: { closeTo: string; children: ReactNode }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, {
    initial: 'first',
    fallback: () => document.querySelector<HTMLElement>('[data-testid="chat-more"]'),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopLayer(ref.current)) navigate(closeTo);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeTo, navigate]);
  return (
    <>
      <div className="tt-panel-scrim" onClick={() => navigate(closeTo)} data-testid="panel-scrim" />
      <aside className="tt-panel" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} data-testid="side-panel">
        <InPanel.Provider value={true}>{children}</InPanel.Provider>
      </aside>
    </>
  );
}
