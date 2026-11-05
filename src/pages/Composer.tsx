import { countCodePoints, MAX_TEXT_LENGTH } from '@tianting/sdk';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useIm } from '../im/ImProvider';
import { EMOJI } from '../lib/emoji';
import { useWide } from '../lib/layout';

const MAX_ROWS = 5;
const COMPOSITION_GRACE_MS = 50;

/**
 * 输入区（PRD-ui F-UI-10）：窄屏自动增高到 5 行，宽屏固定高度、框内滚动；超过 5000 码点显示"已超出 N 字"并禁用发送（C-28）；
 * Enter 发送、Shift+Enter 换行；输入法组字期间以及 compositionend 后 50ms 内的 Enter 不发送（R-UI-15）。
 * 进入时取走这个会话的草稿，离开时把没发出去的内容存回去（F-UI-24）。
 */
export function Composer({ convId, onSend }: { convId: string; onSend: (text: string) => boolean }) {
  const { drafts } = useIm();
  const [text, setText] = useState(() => drafts.get(convId) ?? '');
  const [emoji, setEmoji] = useState(false);
  const wide = useWide();
  const ref = useRef<HTMLTextAreaElement>(null);
  const composedAt = useRef(0);
  const caret = useRef<number | null>(null);
  const latest = useRef(text);
  const over = countCodePoints(text) - MAX_TEXT_LENGTH;
  const empty = text.trim() === '';
  const disabled = empty || over > 0;

  useLayoutEffect(() => {
    latest.current = text;
  }, [text]);

  useEffect(() => {
    drafts.remove(convId);
    return () => drafts.put(convId, latest.current);
  }, [drafts, convId]);

  // 宽屏进入聊天页时输入框自动获得焦点；窄屏不自动弹出键盘（F-UI-06 规则 9）。
  useEffect(() => {
    if (wide) ref.current?.focus();
  }, [wide]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    if (wide) {
      el.style.height = ''; // 高度由样式决定
    } else {
      const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
      el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS + 16)}px`;
    }
    if (caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text, wide]);

  function send() {
    if (disabled) return;
    if (!onSend(text)) return;
    setText('');
    if (wide) ref.current?.focus(); // 点"发送"按钮后焦点也回到输入框（F-UI-10 规则 7）
  }

  /** 插入到光标位置（选中的内容被替换），光标移到它后面（AC-UI-11-1）。窄屏不聚焦，不把键盘弹回来。 */
  function insert(e: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    caret.current = start + e.length;
    setText(text.slice(0, start) + e + text.slice(end));
    if (wide) el?.focus();
  }

  return (
    <div
      className="tt-composer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && emoji) {
          setEmoji(false);
          ref.current?.focus();
        }
      }}
    >
      <div className="tt-composer-row">
        <button
          type="button"
          className="tt-icon-btn tt-emoji-btn"
          aria-label="表情"
          aria-expanded={emoji}
          onClick={() => setEmoji((v) => !v)}
          data-testid="emoji-button"
        >
          <Icon name="smile" />
        </button>
        <textarea
          ref={ref}
          className="tt-composer-input"
          rows={1}
          value={text}
          enterKeyHint="send"
          aria-label="输入消息"
          onChange={(e) => setText(e.target.value)}
          onClick={() => setEmoji(false)}
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
      {emoji && (
        <div className="tt-emoji-panel" role="group" aria-label="表情面板" data-testid="emoji-panel">
          {EMOJI.map((e) => (
            <button type="button" className="tt-emoji-item" key={e} onClick={() => insert(e)} data-testid="emoji-item">
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
