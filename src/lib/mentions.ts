import type { Mentions } from '@tianting/sdk';
import type { MentionRange } from '../im/drafts';

// @ 的输入模型（PRD-chat F-MEN-01 规则 5，R-CF-16）：文本 + [{start, len, userId}]。纯函数，Composer 和单测共用。

/** 打开成员选择的字符：半角和全角 @。 */
const AT = new Set(['@', '＠']);

/**
 * 文本从 prev 变成 next 之后的 @ 区间：改动范围前面的不动，后面的按长度差平移，和改动范围有交叠的整段去掉
 * （删掉"@小王 "里任何一个字，这个 @ 就不算了，AC-MEN-01-5）。
 */
export function reconcile(prev: string, next: string, ranges: readonly MentionRange[]): MentionRange[] {
  if (prev === next) return [...ranges];
  let head = 0;
  const max = Math.min(prev.length, next.length);
  while (head < max && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < max - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const oldEnd = prev.length - tail; // prev 里被替换的是 [head, oldEnd)
  const delta = next.length - prev.length;
  const out: MentionRange[] = [];
  for (const r of ranges) {
    const end = r.start + r.len;
    if (end <= head) out.push(r);
    else if (r.start >= oldEnd) out.push({ ...r, start: r.start + delta });
  }
  return out;
}

/**
 * 这次改动是不是"在行首或空白后敲了一个 @ / ＠"（AC-MEN-01-8）：是就返回 @ 的位置，否则 null。
 * 一次插入多个字（粘贴"@u2"）不算；a@b.com 的 @ 前面是字母，不算。
 */
export function triggerAt(prev: string, next: string): number | null {
  if (next.length !== prev.length + 1) return null;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i++;
  if (next.slice(0, i) + next.slice(i + 1) !== prev) return null;
  if (!AT.has(next[i]!)) return null;
  return i === 0 || /\s/.test(next[i - 1]!) ? i : null;
}

/**
 * 光标落在某段 @ 内部（不含两端）时挪到边上（规则 5：光标不能落进 mention 内部）：从后面往左移进来的去前端，
 * 其余（点进去、从前面往右移）去后端。prev 是上一次的光标位置。
 */
export function clampCaret(pos: number, ranges: readonly MentionRange[], prev?: number): number {
  for (const r of ranges) {
    const end = r.start + r.len;
    if (pos > r.start && pos < end) return prev !== undefined && prev >= end ? r.start : end;
  }
  return pos;
}

/** 退格：光标正好在一段 @ 后面时整段删掉（AC-MEN-01-12）。返回新文本、区间和光标；不是这种情况返回 null。 */
export function backspaceMention(
  text: string,
  ranges: readonly MentionRange[],
  pos: number,
): { text: string; ranges: MentionRange[]; caret: number } | null {
  const hit = ranges.find((r) => r.start + r.len === pos);
  if (!hit) return null;
  const nextText = text.slice(0, hit.start) + text.slice(pos);
  return { text: nextText, ranges: reconcile(text, nextText, ranges), caret: hit.start };
}

/** 在 at 位置把那个 @ 换成"@{名字} "，记下区间（R-CF-03：名字是公开昵称，没有用 userId，不用备注）。 */
export function insertMention(
  text: string,
  ranges: readonly MentionRange[],
  at: number,
  name: string,
  target: { userId: string } | { all: true },
): { text: string; ranges: MentionRange[]; caret: number } {
  const replaced = AT.has(text[at] ?? '') ? 1 : 0;
  const piece = `@${name} `;
  const nextText = text.slice(0, at) + piece + text.slice(at + replaced);
  const moved = reconcile(text, text.slice(0, at) + text.slice(at + replaced), ranges).map((r) =>
    r.start >= at ? { ...r, start: r.start + piece.length } : r,
  );
  const range: MentionRange =
    'all' in target
      ? { start: at, len: piece.length, userId: '', all: true }
      : { start: at, len: piece.length, userId: target.userId };
  return { text: nextText, ranges: [...moved, range].sort((a, b) => a.start - b.start), caret: at + piece.length };
}

/** 发送时带的 mentions：区间里的文字还是以 @ 开头的才算；userIds 去重；都没有时 undefined（不带）。 */
export function toMentions(text: string, ranges: readonly MentionRange[]): Mentions | undefined {
  const ids: string[] = [];
  let all = false;
  for (const r of ranges) {
    if (!AT.has(text[r.start] ?? '') || r.start + r.len > text.length) continue;
    if (r.all) all = true;
    else if (!ids.includes(r.userId)) ids.push(r.userId);
  }
  if (!all && ids.length === 0) return undefined;
  return { ...(ids.length ? { userIds: ids } : {}), ...(all ? { all: true } : {}) };
}
