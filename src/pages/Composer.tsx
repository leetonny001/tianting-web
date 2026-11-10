import { countCodePoints, MAX_TEXT_LENGTH, quoteSummary, type GroupRole, type Mentions } from '@tianting/sdk';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Icon } from '../components/Icon';
import { useIm, useSelf } from '../im/ImProvider';
import type { MentionRange } from '../im/drafts';
import { useDisplayName, useMessages } from '../im/hooks';
import { EMOJI } from '../lib/emoji';
import { useWide } from '../lib/layout';
import { backspaceMention, clampCaret, insertMention, reconcile, toMentions, triggerAt } from '../lib/mentions';
import { MentionPicker, type MentionPick } from './MentionPicker';

const MAX_ROWS = 5;
const COMPOSITION_GRACE_MS = 50;

/** 聊天页从消息菜单里"引用"一条消息（AC-QUO-01-5）：引用条显示在输入框上方。 */
export interface ComposerHandle {
  quote(msgId: string): void;
}

export interface SendExtras {
  quote?: { msgId: string };
  mentions?: Mentions;
}

/**
 * 输入区（PRD-ui F-UI-10）：窄屏自动增高到 5 行，宽屏固定高度、框内滚动；超过 5000 码点显示"已超出 N 字"并禁用发送（C-28）；
 * Enter 发送、Shift+Enter 换行；输入法组字期间以及 compositionend 后 50ms 内的 Enter 不发送（R-UI-15）。
 * 进入时取走这个会话的草稿，离开时把没发出去的内容存回去（F-UI-24）：文字、@ 区间、引用条（结构化草稿，AC-MEN-01-10）。
 *
 * @（PRD-chat F-MEN-01 规则 5）：群聊里在行首或空白后敲 @ / ＠ 才打开成员选择；组字中不改模型、不打开（组字结束再看）；
 * 光标不落进 @ 内部，退格一次删整段；粘贴的 @xxx 只是文字。单聊不打开（AC-MEN-01-6）。
 */
export function Composer({
  convId,
  onSend,
  attach,
  onPasteFiles,
  group,
  ref,
}: {
  convId: string;
  onSend: (text: string, extras: SendExtras) => boolean;
  /** 输入区的"+"（PRD-chat 第 13.3 节）；`features.files` 关闭时不传。 */
  attach?: ReactNode;
  /** 粘贴的是文件（截图等）时交给它（F-FILE-02，第 13.2 节"粘贴"）；不传时按浏览器默认处理。 */
  onPasteFiles?: (files: File[]) => void;
  /** 群聊（可以 @）；单聊不传。 */
  group?: { groupId: string; myRole?: GroupRole };
  ref?: Ref<ComposerHandle>;
}) {
  const { drafts } = useIm();
  const [draft] = useState(() => drafts.get(convId));
  const [text, setText] = useState(draft?.text ?? '');
  const [ranges, setRanges] = useState<readonly MentionRange[]>(group ? (draft?.mentions ?? []) : []);
  const [quote, setQuote] = useState<string | null>(draft?.quote?.msgId ?? null);
  const [picker, setPicker] = useState<number | null>(null); // 打开选择时 @ 的位置
  const [emoji, setEmoji] = useState(false);
  const wide = useWide();
  const ref_ = useRef<HTMLTextAreaElement>(null);
  const composedAt = useRef(0);
  const composing = useRef<string | null>(null); // 组字开始时的文字（组字中为非 null）
  const composedText = useRef<string | null>(null);
  const pasted = useRef(false);
  const caret = useRef<number | null>(null);
  const lastCaret = useRef<number | undefined>(undefined);
  const latest = useRef({ text, ranges, quote });
  const over = countCodePoints(text) - MAX_TEXT_LENGTH;
  const empty = text.trim() === '';
  const disabled = empty || over > 0;

  useLayoutEffect(() => {
    latest.current = { text, ranges, quote };
  }, [text, ranges, quote]);

  useEffect(() => {
    drafts.remove(convId);
    return () => {
      const l = latest.current;
      drafts.put(convId, { text: l.text, mentions: l.ranges, ...(l.quote ? { quote: { msgId: l.quote } } : {}) });
    };
  }, [drafts, convId]);

  useImperativeHandle(ref, () => ({
    quote(msgId: string) {
      setQuote(msgId);
      ref_.current?.focus();
    },
  }));

  // 宽屏进入聊天页时输入框自动获得焦点；窄屏不自动弹出键盘（F-UI-06 规则 9）。
  useEffect(() => {
    if (wide) ref_.current?.focus();
  }, [wide]);

  useLayoutEffect(() => {
    const el = ref_.current;
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
      lastCaret.current = caret.current;
      caret.current = null;
    }
  }, [text, wide]);

  function send() {
    if (disabled) return;
    const mentions = group ? toMentions(text, ranges) : undefined;
    const extras: SendExtras = {
      ...(quote ? { quote: { msgId: quote } } : {}),
      ...(mentions ? { mentions } : {}),
    };
    if (!onSend(text, extras)) return;
    setText('');
    setRanges([]);
    setQuote(null);
    if (wide) ref_.current?.focus(); // 点"发送"按钮后焦点也回到输入框（F-UI-10 规则 7）
  }

  /** 插入到光标位置（选中的内容被替换），光标移到它后面（AC-UI-11-1）。窄屏不聚焦，不把键盘弹回来。 */
  function insert(e: string) {
    const el = ref_.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + e + text.slice(end);
    caret.current = start + e.length;
    setRanges(reconcile(text, next, ranges));
    setText(next);
    if (wide) el?.focus();
  }

  /** 文字变了（不在组字中）：平移或去掉 @ 区间；刚敲了一个 @ 就打开选择。 */
  function changed(prev: string, next: string) {
    setRanges((r) => reconcile(prev, next, r));
    const at = group && !pasted.current ? triggerAt(prev, next) : null;
    pasted.current = false;
    if (at !== null) setPicker(at);
  }

  function pick(p: MentionPick) {
    const at = picker;
    setPicker(null);
    if (at === null) return;
    const r = insertMention(text, ranges, at, p.name, 'all' in p ? { all: true } : { userId: p.userId });
    caret.current = r.caret;
    setText(r.text);
    setRanges(r.ranges);
    ref_.current?.focus();
  }

  return (
    <div
      className="tt-composer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && emoji) {
          setEmoji(false);
          ref_.current?.focus();
        }
      }}
    >
      {quote && <QuoteBar convId={convId} msgId={quote} onCancel={() => setQuote(null)} />}
      <div className="tt-composer-row">
        {attach}
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
          ref={ref_}
          className="tt-composer-input"
          rows={1}
          value={text}
          enterKeyHint="send"
          aria-label="输入消息"
          onChange={(e) => {
            const next = e.target.value;
            // 组字中不改模型；组字结束时已经按结束时的文字处理过的，这里不再算一次
            if (composing.current === null && next !== composedText.current) changed(text, next);
            composedText.current = null;
            setText(next);
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!onPasteFiles || files.length === 0) {
              pasted.current = true; // 粘贴进来的 @xxx 只是文字（AC-MEN-01-8）
              setTimeout(() => (pasted.current = false), 0);
              return;
            }
            e.preventDefault(); // 只要文件；同时带的文字（比如文件名）不插进输入框
            onPasteFiles(files);
          }}
          onClick={() => setEmoji(false)}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart !== el.selectionEnd) return;
            const pos = clampCaret(el.selectionStart, ranges, lastCaret.current);
            if (pos !== el.selectionStart) el.setSelectionRange(pos, pos);
            lastCaret.current = pos;
          }}
          onCompositionStart={() => (composing.current = text)}
          onCompositionEnd={(e) => {
            composedAt.current = performance.now();
            const base = composing.current ?? text;
            composing.current = null;
            composedText.current = e.currentTarget.value;
            changed(base, e.currentTarget.value);
            setText(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && composing.current === null && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              if (el.selectionStart === el.selectionEnd) {
                const r = backspaceMention(text, ranges, el.selectionStart);
                if (r) {
                  e.preventDefault(); // 整段删掉（AC-MEN-01-12）
                  caret.current = r.caret;
                  setText(r.text);
                  setRanges(r.ranges);
                  return;
                }
              }
            }
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
      {group && picker !== null && (
        <MentionPicker
          groupId={group.groupId}
          myRole={group.myRole}
          onPick={pick}
          onClose={() => {
            setPicker(null); // @ 留作普通文字
            ref_.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * 引用条（F-QUO-01、F-QUO-02 规则 3，第 13.4 节"引用条"）：显示已加载的那条消息，被撤回、删除时跟着变；
 * 文字按纯文本渲染（AC-QUO-02-5）。草稿里只记 msgId，这里不留原文。
 */
function QuoteBar({ convId, msgId, onCancel }: { convId: string; msgId: string; onCancel: () => void }) {
  const self = useSelf();
  const m = useMessages(convId).find((x) => x.msgId === msgId);
  const name = useDisplayName(m?.from ?? self);
  const label = !m
    ? '引用内容不可用'
    : m.deleted
      ? m.recalled
        ? '引用内容已被撤回'
        : '引用内容已被删除'
      : `${name}: ${quoteSummary(m)}`;
  return (
    <div className="tt-quote-bar" data-testid="quote-bar">
      <span className="tt-quote-bar-text tt-ellipsis" data-testid="quote-bar-text">
        {label}
      </span>
      <button className="tt-icon-btn" aria-label="取消引用" onClick={onCancel} data-testid="quote-cancel">
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
