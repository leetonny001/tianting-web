import { countCodePoints, MAX_TEXT_LENGTH } from '@tianting/sdk';
import { useLayoutEffect, useRef, useState } from 'react';

const MAX_ROWS = 5;
const COMPOSITION_GRACE_MS = 50;

/**
 * 输入区（PRD-ui F-UI-10）：自动增高到 5 行；超过 5000 码点显示"已超出 N 字"并禁用发送（C-28）；
 * Enter 发送、Shift+Enter 换行；输入法组字期间以及 compositionend 后 50ms 内的 Enter 不发送（R-UI-15）。
 */
export function Composer({ onSend }: { onSend: (text: string) => boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const composedAt = useRef(0);
  const over = countCodePoints(text) - MAX_TEXT_LENGTH;
  const empty = text.trim() === '';
  const disabled = empty || over > 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS + 16)}px`;
  }, [text]);

  function send() {
    if (disabled) return;
    if (onSend(text)) setText('');
  }

  return (
    <div className="tt-composer">
      <div className="tt-composer-row">
        <textarea
          ref={ref}
          className="tt-composer-input"
          rows={1}
          value={text}
          enterKeyHint="send"
          aria-label="输入消息"
          onChange={(e) => setText(e.target.value)}
          onCompositionEnd={() => (composedAt.current = performance.now())}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (performance.now() - composedAt.current < COMPOSITION_GRACE_MS) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            send();
          }}
          data-testid="composer-input"
        />
        <button className="tt-btn tt-btn-primary tt-send" disabled={disabled} onClick={send} data-testid="send-button">
          发送
        </button>
      </div>
      {over > 0 && (
        <p className="tt-field-error" data-testid="over-limit">
          已超出 {over} 字
        </p>
      )}
    </div>
  );
}
