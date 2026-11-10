// @ 的输入模型（PRD-chat F-MEN-01 规则 5，R-CF-16）和结构化草稿（AC-MEN-01-10）的纯函数用例。
import { describe, expect, it, vi } from 'vitest';
import { DraftStore, type MentionRange } from '../im/drafts';
import { backspaceMention, clampCaret, insertMention, reconcile, toMentions, triggerAt } from './mentions';

const u2: MentionRange = { start: 3, len: 4, userId: 'u2' }; // "你好 @小王 "

describe('triggerAt：只有行首或空白后敲一个 @ / ＠ 才打开（AC-MEN-01-8）', () => {
  it.each([
    ['', '@', 0],
    ['', '＠', 0],
    ['你好 ', '你好 @', 3],
    ['第一行\n', '第一行\n@', 4],
    ['a', 'a@', null], // a@b.com
    ['ab', 'a@b', null],
    ['', '@u2', null], // 粘贴：一次多个字
    ['你好', '你好@', null],
    ['x ', 'x a', null],
  ])('%j → %j：%s', (prev, next, want) => {
    expect(triggerAt(prev, next)).toBe(want);
  });
});

describe('reconcile：改动前面的不动，后面的平移，碰到的整段去掉（AC-MEN-01-5）', () => {
  const text = '你好 @小王 ';
  it('在前面加字：平移', () => {
    expect(reconcile(text, `嗨${text}`, [u2])).toEqual([{ ...u2, start: 4 }]);
  });
  it('在后面加字：不动', () => {
    expect(reconcile(text, `${text}在吗`, [u2])).toEqual([u2]);
  });
  it('删掉 @ 里的任何一个字：这段不算了', () => {
    expect(reconcile(text, '你好 @小 ', [u2])).toEqual([]);
    expect(reconcile(text, '你好 小王 ', [u2])).toEqual([]);
    expect(reconcile(text, '', [u2])).toEqual([]);
  });
  it('紧挨着 @ 前面插入：平移，不当成改了 @', () => {
    expect(reconcile(text, '你好 x@小王 ', [u2])).toEqual([{ ...u2, start: 4 }]);
  });
  it('没变：原样', () => {
    expect(reconcile(text, text, [u2])).toEqual([u2]);
  });
});

describe('退格和光标（AC-MEN-01-12）', () => {
  it('光标正好在 @ 后面：整段删除，光标到原来的开头', () => {
    expect(backspaceMention('你好 @小王 在吗', [u2], 7)).toEqual({ text: '你好 在吗', ranges: [], caret: 3 });
  });
  it('不在 @ 后面：不处理', () => {
    expect(backspaceMention('你好 @小王 在吗', [u2], 8)).toBeNull();
    expect(backspaceMention('你好 @小王 在吗', [u2], 3)).toBeNull();
  });
  it('光标落进 @ 内部：从后面来的去前端，其余去后端', () => {
    expect(clampCaret(5, [u2], 7)).toBe(3);
    expect(clampCaret(5, [u2], 3)).toBe(7);
    expect(clampCaret(5, [u2])).toBe(7);
    expect(clampCaret(3, [u2], 9)).toBe(3);
    expect(clampCaret(7, [u2], 1)).toBe(7);
  });
});

describe('插入和发送（R-CF-03、F-MEN-01 规则 2）', () => {
  it('把 @ 换成"@昵称 "，后面的区间平移', () => {
    const r = insertMention('@ 和 @小王 ', [{ start: 4, len: 4, userId: 'u2' }], 0, '小李', { userId: 'u3' });
    expect(r.text).toBe('@小李  和 @小王 ');
    expect(r.ranges).toEqual([
      { start: 0, len: 4, userId: 'u3' },
      { start: 7, len: 4, userId: 'u2' },
    ]);
    expect(r.caret).toBe(4);
  });
  it('@所有人：all', () => {
    const r = insertMention('@', [], 0, '所有人', { all: true });
    expect(toMentions(r.text, r.ranges)).toEqual({ all: true });
  });
  it('userIds 去重；区间里的字不是 @ 开头的不算；都没有时不带', () => {
    expect(
      toMentions('@小王 @小王 x', [
        { start: 0, len: 4, userId: 'u2' },
        { start: 4, len: 4, userId: 'u2' },
        { start: 8, len: 1, userId: 'u9' },
      ]),
    ).toEqual({ userIds: ['u2'] });
    expect(toMentions('普通', [])).toBeUndefined();
    expect(toMentions('ab', [{ start: 0, len: 4, userId: 'u2' }])).toBeUndefined();
  });
});

describe('结构化草稿（F-MEN-01 规则 5，AC-MEN-01-10）', () => {
  it('存文字、@ 区间、引用；只有引用没有文字也留着；内容相同不通知；空的删掉', () => {
    const d = new DraftStore();
    const cb = vi.fn();
    d.subscribe(cb);
    d.put('g', { text: '@小王 九点', mentions: [{ start: 0, len: 4, userId: 'u2' }], quote: { msgId: 'm1' } });
    d.put('g', { text: '@小王 九点', mentions: [{ start: 0, len: 4, userId: 'u2' }], quote: { msgId: 'm1' } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(d.get('g')).toEqual({
      text: '@小王 九点',
      mentions: [{ start: 0, len: 4, userId: 'u2' }],
      quote: { msgId: 'm1' },
    });
    d.put('g', { text: '@小王 九点', mentions: [], quote: { msgId: 'm1' } });
    expect(cb).toHaveBeenCalledTimes(2); // @ 不一样也算变化
    d.put('q', { text: '', mentions: [], quote: { msgId: 'm2' } });
    expect(d.get('q')?.quote).toEqual({ msgId: 'm2' });
    d.put('g', { text: '  ', mentions: [] });
    expect(d.get('g')).toBeUndefined();
  });
});
