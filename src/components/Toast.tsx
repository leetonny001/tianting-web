import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const ToastContext = createContext<(text: string) => void>(() => {});

/** 轻提示（PRD-ui F-UI-19 规则 1）：显示 2 秒；同时只显示 1 条，新的替换旧的。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<{ value: string; n: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((value: string) => {
    setText((prev) => ({ value, n: (prev?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (!text) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="tt-toast-layer" aria-live="polite">
        {text && (
          <div className="tt-toast" key={text.n} data-testid="toast">
            {text.value}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
