import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { isTopLayer, useFocusTrap } from '../lib/focus';

/**
 * 居中弹窗（PRD-ui 3.3 节：窄屏宽 = 容器宽 − 48，宽屏 400）。dismissible=false 时点遮罩、Esc 都不能关闭（被踢弹窗，F-UI-18）。
 * 打开时焦点移进来并留在里面，关闭时还给触发按钮（FE-301）；触发按钮会消失时用 returnFocus 指定。
 */
export function Dialog({
  title,
  children,
  actions,
  onDismiss,
  dismissible = true,
  sheet = false,
  testId,
  returnFocus,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onDismiss?: () => void;
  dismissible?: boolean;
  /** 底部菜单样式（申请详情，F-UI-25 规则 4）。 */
  sheet?: boolean;
  testId?: string;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { fallback: () => returnFocus?.current });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible && isTopLayer(ref.current)) onDismiss?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissible, onDismiss]);
  return (
    <div
      className={`tt-scrim${sheet ? ' tt-scrim-sheet' : ''}`}
      onClick={() => dismissible && onDismiss?.()}
      data-testid={testId ? `${testId}-scrim` : undefined}
    >
      <div
        className={`tt-dialog${sheet ? ' tt-sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        {title && <h2 className="tt-dialog-title">{title}</h2>}
        {children && <div className="tt-dialog-body">{children}</div>}
        <div className="tt-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

/** 确认框：取消 / 确定两个按钮。 */
export function Confirm({
  text,
  ok,
  danger,
  onOk,
  onCancel,
  testId,
}: {
  text: ReactNode;
  ok: string;
  danger?: boolean;
  onOk: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <Dialog
      testId={testId}
      onDismiss={onCancel}
      actions={
        <>
          <button className="tt-btn" onClick={onCancel}>
            取消
          </button>
          <button className={`tt-btn ${danger ? 'tt-btn-danger' : 'tt-btn-primary'}`} onClick={onOk}>
            {ok}
          </button>
        </>
      }
    >
      {text}
    </Dialog>
  );
}
