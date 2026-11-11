// FE-693（PRD-chat C6）：举报入口和举报单、4510 的提示（FakeTransport）。真实 im-server 和浏览器键盘见 e2e/c6.spec.ts。
// 不放真实敏感词：被拦截的内容只用特征串 ZXQWORD（F-MOD-01 规则 5）。
import { AccountError, IMClient } from '@tianting/sdk';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FakeConnection } from '@tianting/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountErrorText } from '../lib/accountText';
import { clampCodePoints, codePoints, REPORT_REASONS } from '../lib/report';
import { DEMO_CONFIG } from '../test/harness-fetch';
import { renderLoggedIn, serverConv, settle, type Conv } from '../test/harness';

const AB = 'c2c:alice:bob';
const G = 'group:g1';
const NOW = Date.now();
const WORD = 'ZXQWORD'; // 特征词，不是真实词库内容
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;

/** undefined：老服务端，features 里没有 moderation。 */
let moderation: boolean | undefined = true;
beforeEach(() => {
  moderation = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/config')) {
      return new Response(
        JSON.stringify({
          ...DEMO_CONFIG,
          features: { files: false, msgActions: true, ...(moderation === undefined ? {} : { moderation }) },
        }),
      );
    }
    return new Response('{}', { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
});

type Body = Record<string, unknown>;
function sm(convId: string, seq: number, from: string, body: Body = { text: `第${seq}条` }, extra: Body = {}) {
  return {
    convId,
    seq,
    msgId: `m${seq}`,
    clientMsgId: `s${seq}`,
    from,
    type: 'text',
    body,
    ts: NOW - 1000 + seq,
    ...extra,
  };
}

const answered = new WeakMap<FakeConnection, Set<string>>();
/** 对还没回过的某种请求全部回 ack（data 或 error）。 */
async function answer(c: FakeConnection, cmd: string, reply: { data?: unknown; error?: Body }) {
  const done = answered.get(c) ?? new Set<string>();
  answered.set(c, done);
  await act(async () => {
    for (const f of c.frames().filter((x) => x.cmd === cmd && x.id && !done.has(x.id))) {
      done.add(f.id!);
      c.receive({
        id: f.id,
        cmd: 'ack',
        ...(reply.error ? { error: { msg: 'x', ...reply.error } } : { data: reply.data }),
      });
    }
  });
  await settle();
}

const block = (userId: string) => ({ userId, createdAt: NOW, ver: 3, profile: null });
const friend = (userId: string) => ({
  userId,
  remark: '',
  source: 'other',
  createdAt: NOW,
  ver: 1,
  profile: { nickname: userId, avatar: '', official: false },
});
const sync = (p: Body = {}) => ({
  full: true,
  untilVer: 5,
  latestVer: 5,
  hasMore: false,
  cursor: '',
  friends: [],
  requests: [],
  blocks: [],
  requestSeenVer: 0,
  settings: { searchable: true },
  mode: 'open',
  strangerMsgLimit: 0,
  official: false,
  ...p,
});

/** 打开聊天页：回 convs、socialSync，再把 msgs 作为第一页历史。 */
async function openChat(convId: string, msgs: ReturnType<typeof sm>[], o: { blocks?: Body[]; conv?: Body } = {}) {
  const maxSeq = msgs.at(-1)?.seq ?? 0;
  const conv = { convId, name: convId === G ? 'g1' : 'bob', maxSeq, ...o.conv } as Conv;
  const r = await renderLoggedIn(at(convId), { convs: [conv] });
  await answer(r.c, 'convs', { data: { convs: [serverConv(conv)], truncated: false } });
  await answer(r.c, 'socialSync', { data: sync({ blocks: o.blocks ?? [] }) });
  if (r.c.frames().some((f) => f.cmd === 'sync'))
    await answer(r.c, 'sync', { data: { messages: msgs, hasMore: false } });
  return r;
}

const bubbleOf = (text: string) => screen.getByText(text).closest('[data-testid="bubble"]') as HTMLElement;
const menuTexts = () =>
  within(screen.getByTestId('bubble-menu'))
    .getAllByRole('menuitem')
    .map((b) => b.textContent);
const toastText = () => screen.queryAllByTestId('toast').map((t) => t.textContent);
const reports = (c: FakeConnection) => c.frames().filter((f) => f.cmd === 'report');
const sheet = () => screen.queryByTestId('report-sheet');

async function openMenu(text: string) {
  fireEvent.contextMenu(bubbleOf(text));
  await settle();
}

async function reportVia(text: string) {
  await openMenu(text);
  fireEvent.click(screen.getByTestId('menu-report'));
  await settle();
}

async function pick(reason: string, note?: string) {
  fireEvent.click(screen.getByTestId(`report-reason-${reason}`));
  if (note !== undefined) fireEvent.change(screen.getByTestId('report-note'), { target: { value: note } });
  fireEvent.click(screen.getByTestId('report-submit'));
  await settle();
}

describe('举报单的常量（第 78、84 条）', () => {
  it('补充说明按码点数，截断到 200 个码点（第 84 条）', () => {
    expect(codePoints('😀'.repeat(3))).toBe(3);
    expect(clampCodePoints('😀'.repeat(201))).toBe('😀'.repeat(200));
    expect(REPORT_REASONS.map((r) => r.label)).toEqual([
      '垃圾广告',
      '辱骂骚扰',
      '色情低俗',
      '诈骗',
      '违法违规',
      '其他',
    ]);
    expect(REPORT_REASONS.map((r) => r.value)).toEqual(['spam', 'abuse', 'porn', 'fraud', 'illegal', 'other']);
  });
});

describe('消息菜单"举报"（F-MOD-03 规则 8，TC-MOD-03-09 第 4 条）', () => {
  it('别人的消息菜单有"举报"（排在最后）；自己的没有；tip 没有菜单', async () => {
    await openChat(G, [
      sm(G, 1, 'bob', { text: 'bob 说' }),
      sm(G, 2, 'alice', { text: '我说' }),
      {
        ...sm(G, 3, 'owner1'),
        type: 'tip',
        body: { tip: { kind: 'memberJoined', actor: 'owner1', targets: ['bob'] } },
      },
    ]);
    await openMenu('bob 说');
    expect(menuTexts()).toEqual(['复制', '引用', '举报']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    await openMenu('我说');
    expect(menuTexts()).not.toContain('举报');
    expect(screen.getByTestId('tip').querySelector('button')).toBeNull();
  });

  it('显示不显示由 SDK 的 canReport 决定（第 88 条）：SDK 说不行时别人的消息也没有"举报"，页面问的是每一条消息', async () => {
    const spy = vi.spyOn(IMClient.prototype, 'canReport').mockReturnValue(false);
    try {
      await openChat(G, [sm(G, 1, 'bob', { text: 'bob 说' })]);
      await openMenu('bob 说');
      expect(menuTexts()).toEqual(['复制', '引用']);
      expect(spy.mock.calls.some(([m]) => m.msgId === 'm1')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('会话不在本地列表（从别处打开、服务端补拉的历史）：别人的消息也没有"举报"（第 92 条）', async () => {
    const r = await renderLoggedIn(at(AB), { convs: [] });
    await answer(r.c, 'socialSync', { data: sync() });
    await answer(r.c, 'sync', { data: { messages: [sm(AB, 1, 'bob', { text: 'bob 说' })], hasMore: false } });
    await openMenu('bob 说');
    expect(menuTexts()).toEqual(['复制', '引用']);
  });

  it('features.moderation 关闭、老服务端没有这个字段：都没有"举报"（第 76 条）', async () => {
    for (const v of [false, undefined]) {
      moderation = v;
      const r = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
      await openMenu('bob 说');
      expect(menuTexts(), String(v)).toEqual(['复制', '引用']);
      r.unmount();
      sessionStorage.clear();
    }
  });
});

describe('举报单（AC-MOD-03-9，TC-MOD-03-09）', () => {
  it('单聊消息：6 个理由、计数、提示；不选不能提交；提交中禁用；成功轻提示并询问拉黑，选"加入黑名单"发 block', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    const s = sheet()!;
    expect(
      within(s)
        .getAllByRole('radio')
        .map((x) => x.closest('label')!.textContent),
    ).toEqual(['垃圾广告', '辱骂骚扰', '色情低俗', '诈骗', '违法违规', '其他']);
    expect(
      within(s)
        .getAllByRole('radio')
        .some((x) => (x as HTMLInputElement).checked),
    ).toBe(false);
    expect(screen.getByTestId('report-count')).toHaveTextContent('0/200');
    expect(screen.getByTestId('report-hint')).toHaveTextContent('所选内容将提交给平台审核');
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    expect(within(s).getByRole('textbox', { name: '补充说明（可选）' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('report-reason-abuse'));
    fireEvent.change(screen.getByTestId('report-note'), { target: { value: ' 补充 ZXQ-RPT-NOTE ' } });
    expect(screen.getByTestId('report-count')).toHaveTextContent('17/200');
    fireEvent.click(screen.getByTestId('report-submit'));
    await settle();
    expect(reports(c)).toHaveLength(1);
    expect(c.last('report').data).toEqual({
      targetType: 'message',
      convId: AB,
      msgIds: ['m1'],
      reason: 'abuse',
      note: '补充 ZXQ-RPT-NOTE',
    });
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    expect(screen.getByTestId('report-submit')).toHaveTextContent('提交中…');
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(reports(c)).toHaveLength(1);

    await answer(c, 'report', { data: { reportId: 'r1' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(sheet()).toBeNull();
    const ask = screen.getByTestId('report-block-dialog');
    expect(ask).toHaveTextContent('要把对方加入黑名单吗？');
    fireEvent.click(within(ask).getByText('加入黑名单'));
    await settle();
    expect(c.last('block').data).toEqual({ userId: 'bob' });
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
  });

  it('没有补充说明时不带 note；询问拉黑选"取消"不发 block', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    await pick('spam', '   ');
    expect(c.last('report').data).toEqual({ targetType: 'message', convId: AB, msgIds: ['m1'], reason: 'spam' });
    await answer(c, 'report', { data: { reportId: 'r1' } });
    fireEvent.click(within(screen.getByTestId('report-block-dialog')).getByText('取消'));
    await settle();
    expect(c.frames().some((f) => f.cmd === 'block')).toBe(false);
  });

  it('群消息成功后不询问拉黑；对方已在黑名单的单聊也不问（第 79 条）', async () => {
    const g = await openChat(G, [sm(G, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    await pick('porn');
    expect(g.c.last('report').data).toMatchObject({ targetType: 'message', convId: G, msgIds: ['m1'] });
    await answer(g.c, 'report', { data: { reportId: 'r1' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
    g.unmount();
    sessionStorage.clear();

    const b = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })], { blocks: [block('bob')] });
    await reportVia('bob 说');
    await pick('fraud');
    await answer(b.c, 'report', { data: { reportId: 'r2' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
  });

  it('拉黑失败单独提示，举报的成功提示照旧（第 79 条）', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    await pick('abuse');
    await answer(c, 'report', { data: { reportId: 'r1' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    fireEvent.click(within(screen.getByTestId('report-block-dialog')).getByText('加入黑名单'));
    await settle();
    await answer(c, 'block', { error: { code: 4134 } });
    expect(toastText()).toContain('黑名单已满');
    expect(reports(c)).toHaveLength(1); // 举报不受影响、不重发
  });

  it('4292、4040、4030 按"命令 + 码"提示并关闭；不自动重试（第 83 条）', async () => {
    const cases: [number, string, Body?][] = [
      [4292, '今天的举报次数已用完'],
      [4040, '无法举报该内容', { reason: 'reportTargetInvalid' }],
      [4030, '举报功能暂不可用', { reason: 'featureDisabled' }],
    ];
    for (const [code, text, extra] of cases) {
      const r = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
      await reportVia('bob 说');
      await pick('other');
      await answer(r.c, 'report', { error: { code, ...extra } });
      expect(toastText(), String(code)).toContain(text);
      expect(sheet()).toBeNull();
      expect(screen.queryByTestId('report-block-dialog')).toBeNull();
      await act(async () => new Promise((ok) => setTimeout(ok, 50)));
      expect(reports(r.c)).toHaveLength(1);
      r.unmount();
      sessionStorage.clear();
    }
  });

  it('5000、断线：举报单留着、内容保留，可以手动再提交（FE-693 第 2 条）', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    await pick('illegal', '说明');
    await answer(c, 'report', { error: { code: 5000 } });
    expect(toastText()).toContain('服务异常，请稍后重试');
    expect(sheet()).not.toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('report-reason-illegal').checked).toBe(true);
    expect(screen.getByTestId('report-note')).toHaveValue('说明');
    expect(screen.getByTestId('report-submit')).toBeEnabled();
    expect(reports(c)).toHaveLength(1); // 不自动重试
    fireEvent.click(screen.getByTestId('report-submit'));
    await settle();
    expect(reports(c)).toHaveLength(2);
    // 断线：SDK 抛出非 IMError，提示网络异常，举报单仍在
    await act(async () => c.drop(1006));
    await settle();
    expect(toastText()).toContain('网络异常，请稍后重试');
    expect(sheet()).not.toBeNull();
  });

  it('补充说明：超过 200 个码点不能再输入；粘贴超长的截断到 200 并提示（第 84 条）', async () => {
    await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    await reportVia('bob 说');
    const note = screen.getByTestId<HTMLTextAreaElement>('report-note');
    fireEvent.change(note, { target: { value: '😀'.repeat(200) } });
    expect(screen.getByTestId('report-count')).toHaveTextContent('200/200');
    fireEvent.change(note, { target: { value: '😀'.repeat(200) + 'a' } });
    expect(note.value).toBe('😀'.repeat(200));
    expect(screen.queryByTestId('report-clipped')).toBeNull();
    fireEvent.paste(note);
    fireEvent.change(note, { target: { value: '字'.repeat(250) } });
    expect(note.value).toBe('字'.repeat(200));
    expect(screen.getByTestId('report-clipped')).toHaveTextContent('补充说明最多 200 个字');
  });

  it('Esc、"取消"关闭举报单，不发帧；菜单的键盘入口沿用 C4（AC-CHAT-90-9）', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'bob 说' })]);
    bubbleOf('bob 说').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await settle();
    expect(document.activeElement).toHaveTextContent('复制');
    await user.keyboard('{End}{Enter}');
    await settle();
    expect(sheet()).not.toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await settle();
    expect(sheet()).toBeNull();
    await reportVia('bob 说');
    fireEvent.click(screen.getByTestId('report-cancel'));
    await settle();
    expect(sheet()).toBeNull();
    expect(reports(c)).toHaveLength(0);
  });
});

describe('撤回提示行"举报"（AC-MOD-03-11，F-MOD-03 规则 2a）', () => {
  const recalled = (convId: string, seq: number, from: string, by?: string) =>
    sm(convId, seq, from, {}, { deleted: true, recalled: true, recalledAt: NOW, ...(by ? { recalledBy: by } : {}) });

  it('群里别人撤回的、看过的：有"举报"，提交单条 msgId，不询问拉黑', async () => {
    const { c } = await openChat(G, [sm(G, 1, 'bob', { text: '先说' }), recalled(G, 2, 'bob', 'bob')]);
    const row = screen.getByTestId('msg-recalled');
    expect(row.textContent).toBe('bob撤回了一条消息');
    expect(screen.getByTestId('recall-row')).toContainElement(row);
    fireEvent.click(screen.getByTestId('recall-report'));
    await settle();
    await pick('abuse');
    expect(c.last('report').data).toEqual({ targetType: 'message', convId: G, msgIds: ['m2'], reason: 'abuse' });
    await answer(c, 'report', { data: { reportId: 'r1' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
  });

  it('单聊对方撤回的：举报后询问拉黑', async () => {
    const { c } = await openChat(AB, [recalled(AB, 1, 'bob', 'bob')]);
    fireEvent.click(screen.getByTestId('recall-report'));
    await settle();
    await pick('spam');
    await answer(c, 'report', { data: { reportId: 'r1' } });
    expect(screen.getByTestId('report-block-dialog')).toBeInTheDocument();
  });

  it('自己撤回的、自己被撤回的、我撤回别人的都没有"举报"；开关关闭也没有', async () => {
    await openChat(G, [
      recalled(G, 1, 'alice', 'alice'),
      recalled(G, 2, 'alice', 'owner1'),
      recalled(G, 3, 'bob', 'alice'),
    ]);
    expect(screen.getAllByTestId('msg-recalled')).toHaveLength(3);
    expect(screen.queryByTestId('recall-report')).toBeNull();
  });

  it('不知道是谁撤回的（recalledBy 为空，老服务端）：按别人撤回，有"举报"（第 89 条）', async () => {
    await openChat(G, [recalled(G, 1, 'bob')]);
    expect(screen.getByTestId('recall-report')).toBeInTheDocument();
  });

  it('features.moderation 关闭：别人撤回的也没有', async () => {
    moderation = false;
    await openChat(G, [recalled(G, 1, 'bob', 'bob')]);
    expect(screen.getByTestId('msg-recalled')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-report')).toBeNull();
  });
});

describe('资料卡、群信息页"举报"', () => {
  async function openUser(path: string, p: Body = {}) {
    const r = await renderLoggedIn(path, {});
    await answer(r.c, 'socialSync', { data: sync(p) });
    return r;
  }

  it('资料卡：菜单"举报"举报用户，成功后询问拉黑（第 79 条）；已拉黑的不问', async () => {
    const r = await openUser('/user/bob', { friends: [friend('bob')] });
    fireEvent.click(screen.getByTestId('user-more'));
    fireEvent.click(screen.getByTestId('user-report'));
    await settle();
    await pick('fraud');
    expect(r.c.last('report').data).toEqual({ targetType: 'user', userId: 'bob', reason: 'fraud' });
    await answer(r.c, 'report', { data: { reportId: 'r1' } });
    expect(screen.getByTestId('report-block-dialog')).toBeInTheDocument();
    r.unmount();
    sessionStorage.clear();

    const b = await openUser('/user/eve', { blocks: [block('eve')] });
    fireEvent.click(screen.getByTestId('user-more'));
    fireEvent.click(screen.getByTestId('user-report'));
    await settle();
    await pick('spam');
    await answer(b.c, 'report', { data: { reportId: 'r2' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
  });

  it('资料卡：开关关闭时菜单里没有"举报"；自己的资料卡没有菜单', async () => {
    moderation = false;
    const r = await openUser('/user/bob', { friends: [friend('bob')] });
    fireEvent.click(screen.getByTestId('user-more'));
    expect(screen.getByTestId('user-menu')).not.toHaveTextContent('举报');
    r.unmount();
    sessionStorage.clear();
    moderation = true;
    await openUser('/user/alice');
    expect(screen.queryByTestId('user-more')).toBeNull();
  });

  const info = (p: Body = {}) => ({
    groupId: 'g1',
    name: '球局',
    notice: '',
    noticeBy: '',
    noticeAt: 0,
    owner: 'owner1',
    managed: false,
    myRole: 'member',
    memberCount: 3,
    maxMembers: 500,
    historyVisible: false,
    createdAt: 1,
    ...p,
  });
  const member = (userId: string, role = 'member') => ({
    userId,
    role,
    joinedAt: 1,
    nickname: userId,
    avatar: '',
    official: false,
  });
  async function openGroup(p: Body = {}) {
    const r = await renderLoggedIn(`${at(G)}/info`, { convs: [{ convId: G, name: '球局', memberCount: 3 }] });
    await answer(r.c, 'socialSync', { data: sync() });
    await answer(r.c, 'groupInfo', { data: info(p) });
    await answer(r.c, 'groupMembers', {
      data: { members: [member('owner1', 'owner'), member('alice')], nextCursor: '' },
    });
    return r;
  }

  it('群信息页（当前成员）："举报"举报群，不询问拉黑；开关关闭时没有', async () => {
    const r = await openGroup();
    fireEvent.click(screen.getByTestId('group-report'));
    await settle();
    await pick('illegal');
    expect(r.c.last('report').data).toEqual({ targetType: 'group', groupId: 'g1', reason: 'illegal' });
    await answer(r.c, 'report', { data: { reportId: 'r1' } });
    expect(toastText()).toContain('已提交，感谢你的反馈');
    expect(screen.queryByTestId('report-block-dialog')).toBeNull();
    r.unmount();
    sessionStorage.clear();
    moderation = false;
    await openGroup();
    expect(screen.getByTestId('group-leave')).toBeInTheDocument();
    expect(screen.queryByTestId('group-report')).toBeNull();
  });

  it('不在群里的只读页没有"举报"', async () => {
    const r = await renderLoggedIn(`${at(G)}/info`, { convs: [{ convId: G, name: '球局', memberCount: 3 }] });
    await answer(r.c, 'socialSync', { data: sync() });
    await answer(r.c, 'groupInfo', { error: { code: 4033 } });
    expect(await screen.findByTestId('info-head')).toBeInTheDocument();
    expect(screen.queryByTestId('group-leave')).toBeNull();
    expect(screen.queryByTestId('group-report')).toBeNull();
  });

  it('改群名被拦截（4510）：提示"内容包含不当信息，请修改后重试"，改名框重新打开、内容保留（第 82 条）', async () => {
    const r = await openGroup({ myRole: 'owner', owner: 'alice' });
    fireEvent.click(screen.getByTestId('group-name'));
    fireEvent.change(screen.getByTestId('rename-input'), { target: { value: `新名${WORD}` } });
    fireEvent.click(screen.getByTestId('rename-save'));
    await settle();
    await answer(r.c, 'groupUpdate', { error: { code: 4510 } });
    expect(toastText()).toContain('内容包含不当信息，请修改后重试');
    expect(toastText().join()).not.toContain(WORD);
    expect(screen.getByTestId('rename-input')).toHaveValue(`新名${WORD}`);
  });

  it('改群公告被拦截（4510）：同样的提示，编辑内容保留', async () => {
    const r = await renderLoggedIn(`${at(G)}/notice`, { convs: [{ convId: G, name: '球局', memberCount: 3 }] });
    await answer(r.c, 'socialSync', { data: sync() });
    await answer(r.c, 'groupInfo', { data: info({ myRole: 'owner', owner: 'alice' }) });
    fireEvent.click(screen.getByTestId('notice-edit'));
    fireEvent.change(screen.getByTestId('notice-input'), { target: { value: `公告${WORD}` } });
    fireEvent.click(screen.getByTestId('notice-save'));
    await settle();
    await answer(r.c, 'groupUpdate', { error: { code: 4510 } });
    expect(toastText()).toContain('内容包含不当信息，请修改后重试');
    expect(screen.getByTestId('notice-input')).toHaveValue(`公告${WORD}`);
  });
});

describe('4510（AC-MOD-02-9，TC-MOD-02-09）', () => {
  it('发送被拦截：标记失败、输入框清空、提示"消息包含不当内容，无法发送"、不自动重发；菜单只有"复制""删除"', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: '你好' })]);
    const input = screen.getByTestId<HTMLTextAreaElement>('composer-input');
    await userEvent.type(input, `含${WORD}的话{Enter}`);
    expect(input.value).toBe('');
    await act(async () => c.ackError('send', 4510));
    await settle();
    const msg = screen.getByText(`含${WORD}的话`).closest('[data-testid="message"]')!;
    expect(msg).toHaveAttribute('data-status', 'failed');
    expect(toastText()).toEqual(['消息包含不当内容，无法发送']);
    expect(input.value).toBe('');
    await act(async () => new Promise((ok) => setTimeout(ok, 100)));
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(1);

    await openMenu(`含${WORD}的话`);
    expect(menuTexts()).toEqual(['复制', '删除']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    // 失败图标：读出原因，点了只能删除（没有"重发"）
    const icon = within(msg as HTMLElement).getByTestId('failed-icon');
    expect(icon).toHaveAccessibleName('发送失败：消息包含不当内容，无法发送');
    fireEvent.click(icon);
    await settle();
    const dlg = screen.getByTestId('no-retry-dialog');
    expect(dlg).toHaveTextContent('消息包含不当内容，无法发送');
    expect(within(dlg).queryByText('重发')).toBeNull();
    fireEvent.click(within(dlg).getByText('删除'));
    await settle();
    expect(screen.queryByText(`含${WORD}的话`)).toBeNull();
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(1);
  });

  it('其他失败（5000）照旧有"重发"（对照）', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: '你好' })]);
    await userEvent.type(screen.getByTestId('composer-input'), '普通的话{Enter}');
    await act(async () => c.ackError('send', 5000));
    await settle();
    await openMenu('普通的话');
    expect(menuTexts()).toEqual(['复制', '重发', '删除']);
  });

  it('好友申请附言被拦截（4510）：提示另一句，附言保留（第 82 条）', async () => {
    const r = await renderLoggedIn('/contacts/apply/bob', {});
    await answer(r.c, 'socialSync', { data: sync() });
    fireEvent.change(screen.getByTestId('apply-message'), { target: { value: `附言${WORD}` } });
    fireEvent.click(screen.getByTestId('apply-send'));
    await settle();
    await answer(r.c, 'friendApply', { error: { code: 4510 } });
    expect(toastText()).toContain('内容包含不当信息，请修改后重试');
    expect(screen.getByTestId('apply-message')).toHaveValue(`附言${WORD}`);
  });

  it('建群的群名被拦截（4510）：命名框留着、群名保留', async () => {
    const r = await renderLoggedIn('/groups/new', {});
    await answer(r.c, 'socialSync', { data: sync({ friends: [friend('bob'), friend('carol')] }) });
    for (const u of ['bob', 'carol'])
      fireEvent.click(within(screen.getByText(u).closest('label')!).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('pick-done'));
    fireEvent.change(screen.getByTestId('group-name-input'), { target: { value: `群${WORD}` } });
    fireEvent.click(screen.getByTestId('group-create'));
    await settle();
    await answer(r.c, 'groupCreate', { error: { code: 4510 } });
    expect(toastText()).toContain('内容包含不当信息，请修改后重试');
    expect(screen.getByTestId('group-name-input')).toHaveValue(`群${WORD}`);
  });

  it('账号接口的 4510（注册、改昵称）：内容包含不当信息，请修改后重试', () => {
    expect(accountErrorText(new AccountError(451, 4510, 'x'))).toBe('内容包含不当信息，请修改后重试');
  });
});
