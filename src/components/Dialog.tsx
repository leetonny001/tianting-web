import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 居中弹窗（PRD-ui 3.3 节：宽 = 容器宽 − 48）。dismissible=false 时点遮罩、Esc 都不能关闭（被踢弹窗，F-UI-18）。
 */
export function Dialog({
  title,
  children,
  actions,
  onDismiss,
  dismissible = true,
  testId,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onDismiss?: () => void;
  dismissible?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) onDismiss?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissible, onDismiss]);
  return (
    <div
      className="tt-scrim"
      onClick={() => dismissible && onDismiss?.()}
      data-testid={testId ? `${testId}-scrim` : undefined}
    >
      <div
        className="tt-dialog"
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
