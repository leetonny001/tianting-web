// FE-665、FE-666（PRD-chat C4）：撤回、引用、@ 的页面（FakeTransport + 假时钟）。真实 im-server 见 e2e/c4.spec.ts。
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FakeClock, type FakeConnection } from '@tianting/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_CONFIG } from '../test/harness-fetch';
import { renderLoggedIn, serverConv, settle, type Conv } from '../test/harness';

const AB = 'c2c:alice:bob';
const G = 'group:g1';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
const NOW = Date.now();

let msgActions = true;
beforeEach(() => {
  msgActions = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/config')) {
      return new Response(JSON.stringify({ ...DEMO_CONFIG, features: { files: false, msgActions } }));
    }
    return new Response('{}', { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
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
    ts: NOW - (1000 - seq) * 10,
    ...extra,
  };
}

/** 对还没回过的某种请求全部回 ack。 */
const answered = new WeakMap<FakeConnection, Set<string>>();
async function answer(c: FakeConnection, cmd: string, data: unknown | ((f: { data?: Body }) => unknown)) {
  const done = answered.get(c) ?? new Set<string>();
  answered.set(c, done);
  await act(async () => {
    for (const f of c.frames().filter((x) => x.cmd === cmd && x.id && !done.has(x.id))) {
      done.add(f.id!);
      c.receive({ id: f.id, cmd: 'ack', data: typeof data === 'function' ? data(f as { data?: Body }) : data });
    }
  });
  await settle();
}

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

/**
 * 打开聊天页：回 convs、socialSync（可以带好友备注），再把 msgs 作为第一页历史回给 sync。
 */
async function openChat(
  convId: string,
  msgs: ReturnType<typeof sm>[],
  o: {
    userId?: string;
    conv?: Partial<Conv> & Body;
    friends?: Body[];
    clock?: FakeClock;
    serverTime?: number;
    hasMore?: boolean;
    path?: string;
  } = {},
) {
  const maxSeq = msgs.at(-1)?.seq ?? 0;
  const conv = { convId, name: convId === G ? 'g1' : 'bob', maxSeq, ...o.conv } as Conv;
  const r = await renderLoggedIn(o.path ?? at(convId), {
    userId: o.userId,
    convs: [conv],
    clock: o.clock,
    serverTime: o.serverTime,
  });
  await answer(r.c, 'convs', { convs: [serverConv(conv)], truncated: false });
  await answer(r.c, 'socialSync', sync({ friends: o.friends ?? [] }));
  if (r.c.frames().some((f) => f.cmd === 'sync')) {
    await answer(r.c, 'sync', { messages: msgs, hasMore: o.hasMore ?? false });
  }
  return r;
}

/** 等 SDK 退避后发起新连接（最多 5 秒）。 */
async function reconnected(t: { current: FakeConnection }, old: FakeConnection) {
  for (let i = 0; i < 50 && t.current === old; i++) {
    await act(async () => new Promise((r) => setTimeout(r, 100)));
  }
  expect(t.current).not.toBe(old);
}

const bubbleOf = (text: string) => screen.getByText(text).closest('[data-testid="bubble"]') as HTMLElement;
const menuItems = () =>
  within(screen.getByTestId('bubble-menu'))
    .getAllByRole('menuitem')
    .map((b) => b.textContent);
const input = () => screen.getByTestId<HTMLTextAreaElement>('composer-input');
const toastText = () => screen.getAllByTestId('toast').map((t) => t.textContent);

describe('消息菜单（PRD-ui F-UI-09 规则 3～5，C4）', () => {
  it('TC-UI-09-01 features.msgActions 关闭时只有"复制"，打开时有"复制""引用""撤回"', async () => {
    msgActions = false;
    const first = await openChat(AB, [sm(AB, 1, 'alice', { text: '我发的' }, { ts: NOW - 10_000 })]);
    fireEvent.contextMenu(bubbleOf('我发的'));
    expect(menuItems()).toEqual(['复制']);
    first.unmount();
    sessionStorage.clear();
    msgActions = true;
    await openChat(AB, [sm(AB, 1, 'alice', { text: '我发的' }, { ts: NOW - 10_000 })]);
    fireEvent.contextMenu(bubbleOf('我发的'));
    expect(menuItems()).toEqual(['复制', '引用', '撤回']);
  });

  it('TC-RCL-01-08 撤回按校正后的服务端时间（设备快 10 分钟）：60 秒内有、121 秒后没有；菜单开着过期，点了提示 4097', async () => {
    const clock = new FakeClock(NOW + 600_000); // 设备时钟比服务端快 10 分钟
    const { c } = await openChat(
      AB,
      [
        sm(AB, 1, 'alice', { text: '121 秒前' }, { ts: NOW - 121_000 }),
        sm(AB, 2, 'alice', { text: '60 秒前' }, { ts: NOW - 60_000 }),
        sm(AB, 3, 'alice', { text: '115 秒前' }, { ts: NOW - 115_000 }),
      ],
      { clock, serverTime: NOW },
    );
    fireEvent.contextMenu(bubbleOf('121 秒前'));
    expect(menuItems()).toEqual(['复制', '引用']);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(bubbleOf('60 秒前'));
    expect(menuItems()).toEqual(['复制', '引用', '撤回']);
    fireEvent.keyDown(window, { key: 'Escape' });
    // 菜单开着的时候过了 2 分钟（推进 10 秒，不跨过 30 秒心跳）
    fireEvent.contextMenu(bubbleOf('115 秒前'));
    expect(menuItems()).toEqual(['复制', '引用', '撤回']);
    act(() => clock.advance(10_000));
    fireEvent.click(screen.getByTestId('menu-recall'));
    await settle();
    expect(c.last('recall').data).toEqual({ convId: AB, msgId: 'm3' });
    await act(async () =>
      c.receive({
        id: c.last('recall').id,
        cmd: 'ack',
        error: { code: 4097, msg: 'x', details: { windowSeconds: 120 } },
      }),
    );
    await settle();
    expect(toastText()).toContain('发送时间超过 2 分钟，无法撤回');
    expect(screen.getByText('115 秒前')).toBeInTheDocument(); // 消息不变
    expect(screen.queryByTestId('msg-recalled')).toBeNull();
  });

  it('TC-RCL-02-05 管理员撤回其他管理员：菜单有"撤回"，服务端 4030 提示"你没有权限撤回这条消息"，消息不变', async () => {
    const { c } = await openChat(G, [sm(G, 1, 'admin2', { text: '另一位管理员' }, { ts: NOW - 3_600_000 })], {
      conv: { myRole: 'admin' },
    });
    fireEvent.contextMenu(bubbleOf('另一位管理员'));
    expect(menuItems()).toContain('撤回');
    fireEvent.click(screen.getByTestId('menu-recall'));
    await settle();
    await act(async () => c.ackError('recall', 4030));
    await settle();
    expect(toastText()).toContain('你没有权限撤回这条消息');
    expect(screen.getByText('另一位管理员')).toBeInTheDocument();
  });

  it('普通成员对别人的消息没有"撤回"；群主 7 天内任何人的都有', async () => {
    const msgs = [sm(G, 1, 'bob', { text: '成员的' }, { ts: NOW - 6 * 86_400_000 })];
    const first = await openChat(G, msgs, { conv: { myRole: 'member' } });
    fireEvent.contextMenu(bubbleOf('成员的'));
    expect(menuItems()).toEqual(['复制', '引用']);
    first.unmount();
    sessionStorage.clear();
    await openChat(G, msgs, { conv: { myRole: 'owner' } });
    fireEvent.contextMenu(bubbleOf('成员的'));
    expect(menuItems()).toEqual(['复制', '引用', '撤回']);
  });

  it('TC-CHAT-90-31 键盘：Tab 到气泡，Shift+F10 / 菜单键打开，方向键移动，回车执行"引用"，Esc 关闭焦点回到气泡', async () => {
    const user = userEvent.setup();
    await openChat(AB, [sm(AB, 1, 'bob', { text: '键盘走查' })]);
    const b = bubbleOf('键盘走查');
    expect(b).toHaveAttribute('tabindex', '0');
    b.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByTestId('bubble-menu');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAccessibleName('消息操作');
    expect(document.activeElement).toHaveTextContent('复制');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('引用');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toHaveTextContent('引用'); // 循环
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('bubble-menu')).toBeNull();
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'ContextMenu' });
    expect(document.activeElement).toHaveTextContent('复制');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('quote-bar-text')).toHaveTextContent('bob: 键盘走查');
  });
});

describe('撤回的显示（F-RCL-02 规则 1a、F-RCL-03，F-UI-42 规则 4）', () => {
  it('TC-RCL-01-01 TC-RCL-03-10 单聊撤回自己的：发 recall，ack 后显示"你撤回了一条消息"，提示行没有菜单；对方看到"对方撤回了一条消息"', async () => {
    const mine = await openChat(AB, [sm(AB, 1, 'alice', { text: 'ZXQ-RCL-2 发错了' }, { ts: NOW - 30_000 })]);
    fireEvent.contextMenu(bubbleOf('ZXQ-RCL-2 发错了'));
    fireEvent.click(screen.getByTestId('menu-recall'));
    await settle();
    expect(mine.c.last('recall').data).toEqual({ convId: AB, msgId: 'm1' });
    await act(async () => mine.c.ack('recall', {}));
    await settle();
    expect(screen.getByTestId('msg-recalled')).toHaveTextContent('你撤回了一条消息');
    expect(document.body.textContent).not.toContain('ZXQ-RCL-2');
    expect(fireEvent.contextMenu(screen.getByTestId('msg-recalled'))).toBe(false);
    expect(screen.queryByTestId('bubble-menu')).toBeNull();
    mine.unmount();
    sessionStorage.clear();

    const peer = await openChat(AB, [sm(AB, 1, 'alice', { text: 'ZXQ-RCL-2 发错了' })], { userId: 'bob' });
    await act(async () =>
      peer.c.receive({
        cmd: 'event',
        data: { type: 'msgDeleted', convId: AB, msgIds: ['m1'], seqs: [1], recalled: { by: 'alice', at: NOW } },
      }),
    );
    await settle();
    expect(screen.getByTestId('msg-recalled')).toHaveTextContent('对方撤回了一条消息');
    expect(screen.queryByText('该消息已被删除')).toBeNull();
    expect(document.body.textContent).not.toContain('ZXQ-RCL-2');
  });

  it.each([
    ['admin', '你撤回了 m 的一条消息'],
    ['m', 'admin撤回了你的一条消息'],
    ['n', 'admin撤回了一条成员消息'],
  ])('TC-RCL-02-04 管理员撤回成员的消息：%s 的聊天页和列表摘要一致（"%s"）', async (me, text) => {
    const { c } = await openChat(G, [sm(G, 1, 'm', { text: '广告' })], {
      userId: me,
      conv: { lastMsg: { msgId: 'm1', from: 'm', type: 'text', text: '广告', ts: NOW } },
    });
    await act(async () =>
      c.receive({
        cmd: 'event',
        data: { type: 'msgDeleted', convId: G, msgIds: ['m1'], seqs: [1], recalled: { by: 'admin', at: NOW } },
      }),
    );
    await settle();
    expect(screen.getByTestId('msg-recalled')).toHaveTextContent(text);
    // 会话列表：convs 给的 lastMsg（deleted + recalled + recalledBy），同一张表，不加发送者前缀
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await settle();
    const item = document.querySelector(`[data-conv-id="${G}"] .tt-conv-summary`);
    expect(item?.textContent).toBe(text);
  });

  it('TC-RCL-03-06 群里撤回自己的最后一条：自己看"你撤回了一条消息"，其他人看"{显示名}撤回了一条消息"（convs 路径）', async () => {
    const last = { msgId: 'm9', from: 'u1', type: 'text', ts: NOW, deleted: true, recalled: true, recalledBy: 'u1' };
    const u1 = await renderLoggedIn('/chats', {
      userId: 'u1',
      convs: [{ convId: G, name: 'g1', maxSeq: 9, lastMsg: last } as Conv],
    });
    const summary = () => document.querySelector(`[data-conv-id="${G}"] .tt-conv-summary`)?.textContent;
    expect(summary()).toBe('你撤回了一条消息');
    u1.unmount();
    sessionStorage.clear();
    const n = await renderLoggedIn('/chats', {
      userId: 'n',
      convs: [{ convId: G, name: 'g1', maxSeq: 9, lastMsg: last } as Conv],
    });
    expect(summary()).toBe('u1撤回了一条消息');
    // 显示名到了以后替换（备注优先，问题 19）
    await answer(n.c, 'users', { users: [{ userId: 'u1', nickname: '小一', avatar: '', official: false }] });
    expect(summary()).toBe('小一撤回了一条消息');
  });

  it('TC-RCL-03-03 断网期间被撤回：重连后 modVer 变了重拉这个会话，消息变成撤回文案', async () => {
    const { c, transport } = await openChat(AB, [sm(AB, 1, 'alice', { text: 'ZXQ-RCL-3 原文' })], {
      userId: 'bob',
      conv: { modVer: 1 },
    });
    expect(screen.getByText('ZXQ-RCL-3 原文')).toBeInTheDocument();
    await act(async () => c.drop());
    await reconnected(transport, c);
    const c2 = transport.current;
    await act(async () => {
      c2.open();
      c2.ack('auth', { userId: 'bob', serverTime: Date.now() });
    });
    await settle();
    await answer(c2, 'convs', {
      convs: [serverConv({ convId: AB, name: 'bob', maxSeq: 1, modVer: 2 } as Conv)],
      truncated: false,
    });
    await answer(c2, 'sync', {
      messages: [{ ...sm(AB, 1, 'alice'), body: undefined, deleted: true, recalled: true, recalledBy: 'alice' }],
      hasMore: false,
    });
    expect(screen.getByTestId('msg-recalled')).toHaveTextContent('对方撤回了一条消息');
    expect(document.body.textContent).not.toContain('ZXQ-RCL-3');
  }, 10_000);
});

describe('引用（F-QUO-01、F-QUO-02）', () => {
  const msgs = () => [
    sm(AB, 1, 'bob', { text: '晚上吃什么' }),
    sm(AB, 2, 'bob', { image: { fileId: 'F1', width: 10, height: 10, size: 9, mime: 'image/png' } }, { type: 'image' }),
    sm(AB, 3, 'bob', { file: { fileId: 'F2', name: '报价.pdf', size: 9, mime: 'application/pdf' } }, { type: 'file' }),
  ];

  it('TC-QUO-01-05 选"引用"：输入框上方引用条，可以取消（不发 quote）；再引用发送后气泡顶部显示；图片、文件的摘要', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(AB, msgs());
    fireEvent.contextMenu(bubbleOf('晚上吃什么'));
    fireEvent.click(screen.getByTestId('menu-quote'));
    expect(screen.getByTestId('quote-bar-text')).toHaveTextContent('bob: 晚上吃什么');
    expect(screen.getByTestId('quote-cancel')).toHaveAccessibleName('取消引用');
    fireEvent.click(screen.getByTestId('quote-cancel'));
    expect(screen.queryByTestId('quote-bar')).toBeNull();
    await user.type(input(), '不引用{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '不引用' });

    fireEvent.contextMenu(bubbleOf('晚上吃什么'));
    fireEvent.click(screen.getByTestId('menu-quote'));
    await user.type(input(), '火锅{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '火锅', quote: { msgId: 'm1' } });
    expect(screen.queryByTestId('quote-bar')).toBeNull(); // 发出去后引用条消失
    const sent = screen.getByText('火锅').closest('[data-testid="bubble"]') as HTMLElement;
    expect(within(sent).getByTestId('msg-quote')).toHaveTextContent('bob: 晚上吃什么');

    const quoteOf = async (seq: number) => {
      const b = document.querySelector(`[data-seq="${seq}"] [data-testid="bubble"]`) as HTMLElement;
      fireEvent.contextMenu(b);
      expect(menuItems()).toEqual(['引用']);
      fireEvent.click(screen.getByTestId('menu-quote'));
      return screen.getByTestId('quote-bar-text').textContent;
    };
    expect(await quoteOf(2)).toBe('bob: [图片]');
    expect(await quoteOf(3)).toBe('bob: [文件] 报价.pdf');
    await user.type(input(), '看这个{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '看这个', quote: { msgId: 'm3' } });
  });

  it('引用条四种状态（第 13.4 节）：正常、已撤回、已删除、已过期；不认识的状态"引用内容不可用"', async () => {
    const q = (state: string, extra: Body = {}) => ({
      msgId: 'm1',
      seq: 1,
      from: 'bob',
      type: 'text',
      state,
      ...extra,
    });
    await openChat(AB, [
      sm(AB, 10, 'bob', { text: 'a', quote: q('normal', { text: '原文摘要' }) }),
      sm(AB, 11, 'bob', { text: 'b', quote: q('recalled') }),
      sm(AB, 12, 'bob', { text: 'c', quote: q('deleted') }),
      sm(AB, 13, 'bob', { text: 'd', quote: q('expired', { type: 'file' }) }),
      sm(AB, 14, 'bob', { text: 'e', quote: q('mystery') }),
    ]);
    expect(screen.getAllByTestId('msg-quote').map((x) => x.textContent)).toEqual([
      'bob: 原文摘要',
      '引用内容已被撤回',
      '引用内容已被删除',
      '[文件] 已过期',
      '引用内容不可用',
    ]);
  });

  it('引用条里的那条被撤回：引用条跟着变成"引用内容已被撤回"，不留原文', async () => {
    const { c } = await openChat(AB, [sm(AB, 1, 'bob', { text: 'ZXQ-QUO-1 原文' })]);
    fireEvent.contextMenu(bubbleOf('ZXQ-QUO-1 原文'));
    fireEvent.click(screen.getByTestId('menu-quote'));
    await act(async () =>
      c.receive({
        cmd: 'event',
        data: { type: 'msgDeleted', convId: AB, msgIds: ['m1'], seqs: [1], recalled: { by: 'bob', at: NOW } },
      }),
    );
    await settle();
    expect(screen.getByTestId('quote-bar-text')).toHaveTextContent('引用内容已被撤回');
    expect(document.body.textContent).not.toContain('ZXQ-QUO-1');
  });

  it('TC-QUO-02-05 引用摘要含 HTML：引用条和气泡按原样显示，不生成元素', async () => {
    const html = '<img src=x onerror=alert(1)><b>粗</b>';
    await openChat(AB, [
      sm(AB, 1, 'bob', { text: html }),
      sm(AB, 2, 'bob', {
        text: '回复',
        quote: { msgId: 'm1', seq: 1, from: 'bob', type: 'text', state: 'normal', text: html },
      }),
    ]);
    expect(screen.getByTestId('msg-quote')).toHaveTextContent(`bob: ${html}`);
    fireEvent.contextMenu(screen.getByText(html, { selector: '[data-testid="bubble"]' }));
    fireEvent.click(screen.getByTestId('menu-quote'));
    expect(screen.getByTestId('quote-bar-text').textContent).toBe(`bob: ${html}`);
    expect(document.querySelector('.tt-messages img, .tt-messages b, .tt-quote-bar img, .tt-quote-bar b')).toBeNull();
  });

  it('TC-QUO-02-03 点击引用：100 条以内翻页后高亮；500 条外提示"消息太早，请翻页查看"、不翻页；拉不到提示"消息不存在"', async () => {
    const latest = Array.from({ length: 20 }, (_, i) => sm(AB, 681 + i, 'bob'));
    latest[18] = sm(AB, 699, 'bob', {
      text: 'q1',
      quote: { msgId: 'm581', seq: 581, from: 'bob', type: 'text', state: 'normal', text: '第581条' },
    });
    latest[19] = sm(AB, 700, 'bob', {
      text: 'q2',
      quote: { msgId: 'm100', seq: 100, from: 'bob', type: 'text', state: 'normal', text: '第100条' },
    });
    const { c } = await openChat(AB, latest, { hasMore: true });
    const syncs = () => c.frames().filter((f) => f.cmd === 'sync');
    const before = syncs().length;
    const quoteIn = (text: string) =>
      within(screen.getByText(text).closest('[data-testid="bubble"]') as HTMLElement).getByTestId('msg-quote');
    fireEvent.click(quoteIn('q2'));
    await settle();
    expect(toastText()).toContain('消息太早，请翻页查看');
    expect(syncs()).toHaveLength(before);

    fireEvent.click(quoteIn('q1'));
    await settle();
    expect(c.last('sync').data).toMatchObject({ convId: AB, beforeSeq: 681, limit: 100 });
    await act(async () =>
      c.ack('sync', { messages: Array.from({ length: 100 }, (_, i) => sm(AB, 581 + i, 'bob')), hasMore: true }),
    );
    await settle();
    const target = document.querySelector('[data-seq="581"]')!;
    expect(target).toHaveClass('tt-highlight');
    // 已加载范围连续：581～700 一条不缺
    const seqs = [...document.querySelectorAll('[data-testid="message"]')].map((x) =>
      Number(x.getAttribute('data-seq')),
    );
    expect(seqs).toEqual(Array.from({ length: 120 }, (_, i) => 581 + i));
  });

  it('引用的消息拉不到：提示"消息不存在"', async () => {
    const { c } = await openChat(
      AB,
      [
        sm(AB, 50, 'bob'),
        sm(AB, 51, 'bob', {
          text: 'q',
          quote: { msgId: 'm40', seq: 40, from: 'bob', type: 'text', state: 'normal', text: 'x' },
        }),
      ],
      { hasMore: true },
    );
    fireEvent.click(screen.getByTestId('msg-quote'));
    await settle();
    await act(async () => c.ack('sync', { messages: [], hasMore: false }));
    await settle();
    expect(toastText()).toContain('消息不存在');
  });
});

/** 群里打开 @ 选择后回一页成员。 */
const members = [
  { userId: 'u2', role: 'member', joinedAt: 1, nickname: '小王', avatar: '', official: false },
  { userId: 'u3', role: 'member', joinedAt: 2, nickname: '小王', avatar: '', official: false },
  { userId: 'alice', role: 'owner', joinedAt: 0, nickname: 'alice', avatar: '', official: false },
];
async function pickerAnswer(c: FakeConnection, list = members) {
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  await answer(c, 'groupMembers', { members: list, nextCursor: '' });
}

describe('@ 成员（F-MEN-01、F-MEN-02）', () => {
  it('TC-MEN-01-06 单聊输入 @：不打开成员选择，@ 留在输入框', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(AB, []);
    await user.type(input(), '@');
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    expect(input().value).toBe('@');
    expect(c.frames().some((f) => f.cmd === 'groupMembers')).toBe(false);
  });

  it('TC-MEN-01-07 选择列表显示备注、头像和 userId；插入"@小王 "（昵称，不用备注）；上行搜不到"老板"', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, [], {
      friends: [
        {
          userId: 'u2',
          remark: '老板',
          source: 'other',
          createdAt: NOW,
          ver: 1,
          profile: { nickname: '小王', avatar: '', official: false },
        },
      ],
    });
    await user.type(input(), '你好 @');
    expect(screen.getByTestId('mention-picker')).toBeInTheDocument();
    expect(screen.getByTestId('mention-loading')).toHaveTextContent('加载中');
    expect(c.last('groupMembers').data).toMatchObject({ groupId: 'g1' });
    await pickerAnswer(c);
    const rows = screen.getAllByTestId('mention-row');
    expect(rows.map((r) => r.getAttribute('data-user'))).toEqual(['u2', 'u3']); // 自己不在里面
    expect(rows[0]).toHaveTextContent('老板');
    expect(rows[0]).toHaveTextContent('u2'); // 同名的靠 userId 区分（问题 18）
    expect(rows[1]).toHaveTextContent('小王');
    expect(rows[1]).toHaveTextContent('u3');
    fireEvent.click(rows[0]!);
    expect(input().value).toBe('你好 @小王 ');
    expect(document.activeElement).toBe(input());
    await user.type(input(), '在吗{Enter}');
    const send = c.last('send').data;
    expect(send.body).toEqual({ text: '你好 @小王 在吗', mentions: { userIds: ['u2'] } });
    expect(JSON.stringify(c.frames().filter((f) => f.cmd === 'send'))).not.toContain('老板');
  });

  it('TC-MEN-01-05 选了 u2 又把"@小王 "删掉：发出去没有 mentions', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, []);
    await user.type(input(), '@');
    await pickerAnswer(c);
    fireEvent.click(screen.getAllByTestId('mention-row')[0]!);
    expect(input().value).toBe('@小王 ');
    input().setSelectionRange(0, input().value.length);
    await user.keyboard('{Delete}');
    await user.type(input(), '算了{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '算了' });
  });

  it('TC-MEN-01-12 光标在 @ 后按一次退格：整段删除，发出去没有 mentions；光标不落进 @ 内部', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, []);
    await user.type(input(), '你好 @');
    await pickerAnswer(c);
    fireEvent.click(screen.getAllByTestId('mention-row')[0]!);
    expect(input().value).toBe('你好 @小王 ');
    // 光标进不了 @ 内部：从后面往左进来的去前端，从前面进来的去后端
    input().setSelectionRange(5, 5);
    fireEvent.select(input());
    expect(input().selectionStart).toBe(3);
    input().setSelectionRange(6, 6);
    fireEvent.select(input());
    expect(input().selectionStart).toBe(7);
    await user.keyboard('{Backspace}');
    expect(input().value).toBe('你好 ');
    await user.type(input(), '没事{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '你好 没事' });
  });

  it('TC-MEN-01-08 a@b.com 不打开；行首全角＠打开；粘贴的"@u2"不打开、不产生 mentions', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, []);
    await user.type(input(), 'a@b.com');
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    await user.clear(input());
    await user.type(input(), '＠');
    expect(screen.getByTestId('mention-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mention-cancel'));
    expect(input().value).toBe('＠'); // 关掉选择，@ 是普通文字
    await user.clear(input());
    await user.paste('@');
    expect(screen.queryByTestId('mention-picker')).toBeNull(); // 粘贴一个 @ 也不打开
    await user.clear(input());
    await user.paste('@u2');
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    await user.keyboard('{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '@u2' });
  });

  it('TC-MEN-01-09（自动化部分）组字中输入 @ 不打开、不改模型；组字结束后在空白后敲 @ 正常打开', async () => {
    const { c } = await openChat(G, []);
    const el = input();
    fireEvent.compositionStart(el);
    fireEvent.change(el, { target: { value: '@' } }); // 组字中出现的 @：不打开
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    fireEvent.change(el, { target: { value: 'ni@' } });
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    fireEvent.change(el, { target: { value: '你@' } });
    fireEvent.compositionEnd(el, { data: '你@' });
    expect(screen.queryByTestId('mention-picker')).toBeNull(); // 上屏的是多个字，不是"敲了一个 @"
    expect(el.value).toBe('你@');
    fireEvent.change(el, { target: { value: '你@ ' } });
    fireEvent.change(el, { target: { value: '你@ @' } });
    expect(screen.getByTestId('mention-picker')).toBeInTheDocument();
    await pickerAnswer(c);
    fireEvent.click(screen.getAllByTestId('mention-row')[0]!);
    expect(el.value).toBe('你@ @小王 ');
  });

  it('TC-MEN-02-04 只有群主、管理员看到"所有人"；选了发 mentions.all', async () => {
    const user = userEvent.setup();
    const m = await openChat(G, [], { conv: { myRole: 'member' } });
    await user.type(input(), '@');
    await pickerAnswer(m.c);
    expect(screen.queryByTestId('mention-all')).toBeNull();
    m.unmount();
    sessionStorage.clear();
    const a = await openChat(G, [], { conv: { myRole: 'admin' } });
    await user.type(input(), '@');
    await pickerAnswer(a.c);
    expect(screen.getByTestId('mention-all')).toHaveTextContent('所有人');
    fireEvent.click(screen.getByTestId('mention-all'));
    expect(input().value).toBe('@所有人 ');
    await user.type(input(), '开会{Enter}');
    expect(a.c.last('send').data.body).toEqual({ text: '@所有人 开会', mentions: { all: true } });
  });

  it('@ 选择的状态（第 13.4 节）：搜索、无结果、加载失败（可以继续发普通文本）', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, []);
    await user.type(input(), '@');
    await answer(c, 'groupMembers', { members: [], nextCursor: '' });
    expect(screen.getByTestId('mention-empty')).toHaveTextContent('没有找到群成员');
    await user.type(screen.getByTestId('mention-search'), 'zh');
    await act(async () => new Promise((r) => setTimeout(r, 350)));
    expect(c.last('groupMembers').data).toMatchObject({ groupId: 'g1', keyword: 'zh' });
    await act(async () => c.ackError('groupMembers', 4290));
    await settle();
    expect(screen.getByTestId('mention-error')).toHaveTextContent('加载失败，点击重试');
    fireEvent.click(screen.getByTestId('mention-error'));
    await act(async () => new Promise((r) => setTimeout(r, 350)));
    await answer(c, 'groupMembers', { members, nextCursor: '' });
    expect(screen.getAllByTestId('mention-row')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('mention-picker')).toBeNull();
    await user.type(input(), '普通文本{Enter}');
    expect(c.last('send').data.body).toEqual({ text: '@普通文本' });
  });

  it('TC-MEN-01-10 草稿带 @ 和引用：离开再回来文字、@、引用条都恢复，列表显示"[草稿]"；发送带 mentions 和 quote', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, [sm(G, 1, 'u2', { text: '明天几点' })]);
    fireEvent.contextMenu(bubbleOf('明天几点'));
    fireEvent.click(screen.getByTestId('menu-quote'));
    await user.type(input(), '@');
    await pickerAnswer(c);
    fireEvent.click(screen.getAllByTestId('mention-row')[0]!);
    await user.type(input(), '九点');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await settle();
    const item = document.querySelector(`[data-conv-id="${G}"]`) as HTMLElement;
    expect(within(item).getByTestId('draft-tag')).toHaveTextContent('[草稿]');
    expect(item.querySelector('.tt-conv-summary')?.textContent).toBe('[草稿] @小王 九点');
    fireEvent.click(item);
    await settle();
    expect(input().value).toBe('@小王 九点');
    expect(screen.getByTestId('quote-bar-text')).toHaveTextContent('明天几点');
    await user.type(input(), '{Enter}');
    expect(c.last('send').data.body).toEqual({
      text: '@小王 九点',
      quote: { msgId: 'm1' },
      mentions: { userIds: ['u2'] },
    });
  });

  it('TC-MEN-02-05 服务端 4293：消息标记失败，提示"@所有人次数已用完"，重连后不自动重发', async () => {
    const user = userEvent.setup();
    const { c, transport } = await openChat(G, [], { conv: { myRole: 'owner' } });
    await user.type(input(), '@');
    await pickerAnswer(c);
    fireEvent.click(screen.getByTestId('mention-all'));
    await user.type(input(), '集合{Enter}');
    await act(async () => c.ackError('send', 4293));
    await settle();
    expect(screen.getByText('@所有人 集合').closest('[data-testid="message"]')).toHaveAttribute(
      'data-status',
      'failed',
    );
    expect(toastText().filter((t) => t === '@所有人次数已用完')).toHaveLength(1); // 只提示一次
    await act(async () => c.drop());
    await reconnected(transport, c);
    const c2 = transport.current;
    await act(async () => {
      c2.open();
      c2.ack('auth', { userId: 'alice', serverTime: Date.now() });
    });
    await settle();
    await answer(c2, 'convs', {
      convs: [serverConv({ convId: G, name: 'g1', myRole: 'owner' } as Conv)],
      truncated: false,
    });
    expect(c2.frames().some((f) => f.cmd === 'send')).toBe(false);
  }, 10_000);
});

describe('提及提醒（F-MEN-03）', () => {
  it('TC-MEN-01-01（页面部分）被 @ 的会话列表"[有人@我]"，消息整体样式提示；没被 @ 的没有', async () => {
    const { c } = await renderLoggedIn('/chats', {
      userId: 'u2',
      convs: [
        { convId: G, name: 'g1', maxSeq: 1, unread: 1, mentionUnread: 1, firstMentionSeq: 1 } as Conv,
        { convId: 'group:g2', name: 'g2', maxSeq: 1, unread: 1 } as Conv,
      ],
    });
    const summary = (id: string) => document.querySelector(`[data-conv-id="${id}"] .tt-conv-summary`) as HTMLElement;
    expect(within(summary(G)).getByTestId('mention-tag')).toHaveTextContent('[有人@我]');
    expect(within(summary('group:g2')).queryByTestId('mention-tag')).toBeNull();
    fireEvent.click(document.querySelector(`[data-conv-id="${G}"]`)!);
    await settle();
    await answer(c, 'convs', { convs: [serverConv({ convId: G, name: 'g1', maxSeq: 2 } as Conv)], truncated: false });
    await answer(c, 'socialSync', sync());
    await answer(c, 'sync', {
      messages: [
        sm(G, 1, 'u1', { text: '@u2 看一下', mentions: { userIds: ['u2'] } }),
        sm(G, 2, 'u1', { text: '普通' }),
      ],
      hasMore: false,
    });
    expect(screen.getByText('@u2 看一下').closest('[data-testid="message"]')).toHaveAttribute('data-mentioned', 'true');
    expect(bubbleOf('@u2 看一下')).toHaveClass('tt-bubble-mention');
    expect(screen.getByText('普通').closest('[data-testid="message"]')).not.toHaveAttribute('data-mentioned');
  });

  it('TC-MEN-03-05 有提及又有草稿：列表前缀是"[有人@我]"，不是"[草稿]"', async () => {
    const user = userEvent.setup();
    const { c } = await openChat(G, [sm(G, 1, 'u1')], { conv: { mentionUnread: 0 } });
    await user.type(input(), '没写完');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await settle();
    const item = () => document.querySelector(`[data-conv-id="${G}"] .tt-conv-summary`) as HTMLElement;
    expect(within(item()).getByTestId('draft-tag')).toBeInTheDocument();
    await act(async () =>
      c.receive({
        cmd: 'msg',
        data: sm(G, 2, 'u1', { text: '@alice 回一下', mentions: { userIds: ['alice'] } }),
      }),
    );
    await settle();
    expect(within(item()).getByTestId('mention-tag')).toHaveTextContent('[有人@我]');
    expect(within(item()).queryByTestId('draft-tag')).toBeNull();
    expect(item().textContent).not.toContain('[草稿]');
  });

  it('TC-MEN-03-06 未读 100 条、提及在第 10 条：打开时有"有人@我"，点了翻页滚动并高亮，按钮消失', async () => {
    const latest = Array.from({ length: 20 }, (_, i) => sm(G, 81 + i, 'u1'));
    const { c } = await openChat(G, latest, {
      conv: { unread: 100, readSeq: 0, mentionUnread: 1, firstMentionSeq: 10 },
      hasMore: true,
    });
    const btn = screen.getByTestId('mention-jump');
    expect(btn).toHaveTextContent('有人@我');
    fireEvent.click(btn);
    await settle();
    expect(screen.queryByTestId('mention-jump')).toBeNull();
    expect(c.last('sync').data).toMatchObject({ beforeSeq: 81, limit: 71 });
    await act(async () =>
      c.ack('sync', {
        messages: Array.from({ length: 71 }, (_, i) =>
          i === 0 ? sm(G, 10, 'u1', { text: '@alice 第十条', mentions: { userIds: ['alice'] } }) : sm(G, 10 + i, 'u1'),
        ),
        hasMore: true,
      }),
    );
    await settle();
    expect(document.querySelector('[data-seq="10"]')).toHaveClass('tt-highlight');
    expect(screen.queryByTestId('mention-jump')).toBeNull();
  });
});
