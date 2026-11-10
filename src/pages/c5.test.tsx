// FE-683（PRD-chat C5）：会话菜单、置顶和免打扰的显示、删除、总未读（FakeTransport）。真实 im-server 见 e2e/c5.spec.ts。
import { act, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import type { FakeConnection } from '@tianting/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_CONFIG } from '../test/harness-fetch';
import { renderLoggedIn, serverConv, settle, type Conv } from '../test/harness';

const AB = 'c2c:alice:bob';
const AC = 'c2c:alice:carol';
const G = 'group:g1';
const NOW = Date.now();
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;

/** undefined：老服务端，features 里没有这个字段。 */
let convSettings: boolean | undefined = true;
beforeEach(() => {
  convSettings = true;
  document.title = '天听';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/config')) {
      return new Response(
        JSON.stringify({
          ...DEMO_CONFIG,
          features: { files: false, msgActions: true, ...(convSettings === undefined ? {} : { convSettings }) },
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
type C5Conv = Conv & { pinned?: boolean; pinnedAt?: number; notifyOff?: boolean; mentionUnread?: number };

const last = (convId: string, text: string, ts: number, from = convId === G ? 'bob' : convId.split(':')[2]!) => ({
  msgId: `last-${convId}`,
  from,
  type: 'text',
  text,
  ts,
});

/** 三个会话：bob（最新）、carol、群 g1（最旧）。 */
const three = (over: Record<string, Partial<C5Conv>> = {}): C5Conv[] => [
  {
    convId: AB,
    name: 'bob',
    maxSeq: 3,
    lastMsg: last(AB, 'bob 的消息', NOW - 1000),
    updatedAt: NOW - 1000,
    ...over[AB],
  },
  {
    convId: AC,
    name: 'carol',
    maxSeq: 2,
    lastMsg: last(AC, 'carol 的消息', NOW - 2000),
    updatedAt: NOW - 2000,
    ...over[AC],
  },
  { convId: G, name: 'g1', maxSeq: 5, lastMsg: last(G, '群里的消息', NOW - 3000), updatedAt: NOW - 3000, ...over[G] },
];

/** 对还没回过的某种请求全部回 ack（data 或 error）。 */
const answered = new WeakMap<FakeConnection, Set<string>>();
async function answer(c: FakeConnection, cmd: string, reply: { data?: unknown; error?: { code: number } }) {
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

async function event(c: FakeConnection, data: Body) {
  await act(async () => c.receive({ cmd: 'event', data }));
  await settle();
}

async function list(convs: C5Conv[] = three(), path = '/chats') {
  const r = await renderLoggedIn(path, { convs });
  await settle(); // /v1/config
  return r;
}

const item = (convId: string) => document.querySelector<HTMLElement>(`[data-conv-id="${convId}"]`)!;
const order = () =>
  [...document.querySelectorAll('[data-testid="conv-item"]')].map((e) => e.getAttribute('data-conv-id'));
const menu = () => screen.queryByTestId('conv-menu');
const menuTexts = () =>
  within(screen.getByTestId('conv-menu'))
    .getAllByRole('menuitem')
    .map((b) => b.textContent);
const toastText = () => screen.queryAllByTestId('toast').map((t) => t.textContent);
const summary = (convId: string) => item(convId).querySelector('.tt-conv-summary')!.textContent;

async function rightClick(convId: string) {
  fireEvent.contextMenu(item(convId), { clientX: 30, clientY: 40 });
  await settle();
}

async function longPress(convId: string, ms = 600) {
  fireEvent.pointerDown(item(convId), { clientX: 30, clientY: 40, button: 0 });
  await act(async () => new Promise((r) => setTimeout(r, ms)));
  fireEvent.pointerUp(item(convId), { clientX: 30, clientY: 40 });
  fireEvent.click(item(convId));
  await settle();
}

async function pick(testId: 'conv-menu-pin' | 'conv-menu-notify' | 'conv-menu-delete') {
  fireEvent.click(screen.getByTestId(testId));
  await settle();
}

/** ack 用的会话：服务端给回完整会话（第 13.1 节）。 */
const ackConv = (conv: C5Conv) => ({ conv: serverConv(conv) });

describe('会话菜单（AC-CVS-01-6，TC-CVS-01-06）', () => {
  it('窄屏长按、右键、菜单键、Shift+F10 打开同一个菜单，三项文字按当前状态；长按松手不进入聊天页', async () => {
    await list(three({ [AC]: { pinned: true, pinnedAt: NOW - 10, notifyOff: true } }));
    await longPress(AB);
    expect(window.location.pathname).toBe('/chats');
    expect(menu()).toBeInTheDocument();
    expect(menuTexts()).toEqual(['置顶', '免打扰', '删除']);
    expect(screen.getByRole('menu', { name: '会话操作' })).toBe(menu());
    expect(screen.getByTestId('conv-menu-pin')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(menu()).toBeNull();
    expect(item(AB)).toHaveFocus(); // 焦点回到会话项

    await rightClick(AC);
    expect(menuTexts()).toEqual(['取消置顶', '取消免打扰', '删除']);
    fireEvent.click(document.querySelector('.tt-menu-layer')!);
    await settle();
    expect(menu()).toBeNull();

    fireEvent.keyDown(item(G), { key: 'ContextMenu' });
    await settle();
    expect(menuTexts()).toEqual(['置顶', '免打扰', '删除']);
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    fireEvent.keyDown(item(G), { key: 'F10', shiftKey: true });
    await settle();
    expect(menu()).toBeInTheDocument();
    expect(item(G)).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
    expect(item(G)).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('按住不到 500ms、或按住时移动超过 10px：不打开菜单，照常点击进入', async () => {
    await list();
    await longPress(AB, 200);
    expect(menu()).toBeNull();
    expect(window.location.pathname).toBe(at(AB));
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await settle();
    fireEvent.pointerDown(item(AC), { clientX: 30, clientY: 40, button: 0 });
    fireEvent.pointerMove(item(AC), { clientX: 30, clientY: 60 });
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    expect(menu()).toBeNull();
  });

  it('键盘：方向键、Home、End 移动，回车执行"置顶"', async () => {
    const { c } = await list();
    fireEvent.keyDown(item(G), { key: 'ContextMenu' });
    await settle();
    const m = screen.getByTestId('conv-menu');
    fireEvent.keyDown(m, { key: 'ArrowDown' });
    expect(screen.getByTestId('conv-menu-notify')).toHaveFocus();
    fireEvent.keyDown(m, { key: 'End' });
    expect(screen.getByTestId('conv-menu-delete')).toHaveFocus();
    fireEvent.keyDown(m, { key: 'ArrowDown' });
    expect(screen.getByTestId('conv-menu-pin')).toHaveFocus();
    fireEvent.keyDown(m, { key: 'ArrowUp' });
    expect(screen.getByTestId('conv-menu-delete')).toHaveFocus();
    fireEvent.keyDown(m, { key: 'Home' });
    expect(screen.getByTestId('conv-menu-pin')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(c.last('convSet').data).toEqual({ convId: G, pinned: true });
    expect(menu()).toBeNull();
  });

  it.each([
    ['false', false],
    ['老服务端没有这个字段', undefined],
  ])(
    'features.convSettings 为 %s：长按、右键、菜单键都不打开菜单；已有的置顶、免打扰照常显示（P-46 ②）',
    async (_, v) => {
      convSettings = v;
      await list(three({ [G]: { pinned: true, pinnedAt: NOW, notifyOff: true, unread: 5 } }));
      await longPress(AB);
      expect(window.location.pathname).toBe(at(AB)); // 长按后的点击照常进入
      fireEvent.click(screen.getByRole('button', { name: '返回' }));
      await settle();
      fireEvent.contextMenu(item(AC), { clientX: 30, clientY: 40 });
      fireEvent.keyDown(item(AC), { key: 'ContextMenu' });
      fireEvent.keyDown(item(AC), { key: 'F10', shiftKey: true });
      await settle();
      expect(menu()).toBeNull();
      expect(item(AC)).not.toHaveAttribute('aria-haspopup');
      expect(order()[0]).toBe(G);
      expect(item(G)).toHaveClass('tt-conv-pinned');
      expect(within(item(G)).getByRole('img', { name: '免打扰' })).toBeInTheDocument();
    },
  );
});

describe('置顶（F-CVS-01）', () => {
  it('选"置顶"：发 convSet，这一项马上移到最前、有置顶背景；ack 后保持；再"取消置顶"回到按时间的位置', async () => {
    const { c } = await list();
    expect(order()).toEqual([AB, AC, G]);
    expect(item(G)).not.toHaveClass('tt-conv-pinned');
    await rightClick(G);
    await pick('conv-menu-pin');
    expect(c.last('convSet').data).toEqual({ convId: G, pinned: true });
    expect(order()).toEqual([G, AB, AC]); // 乐观更新
    expect(item(G)).toHaveClass('tt-conv-pinned');
    expect(item(G)).toHaveAttribute('data-pinned', 'true');
    await answer(c, 'convSet', { data: ackConv({ ...three()[2]!, pinned: true, pinnedAt: NOW }) });
    expect(order()).toEqual([G, AB, AC]);
    expect(item(G)).toHaveClass('tt-conv-pinned');

    await rightClick(G);
    expect(menuTexts()[0]).toBe('取消置顶');
    await pick('conv-menu-pin');
    expect(c.last('convSet').data).toEqual({ convId: G, pinned: false });
    await answer(c, 'convSet', { data: ackConv(three()[2]!) });
    expect(order()).toEqual([AB, AC, G]);
    expect(item(G)).not.toHaveClass('tt-conv-pinned');
  });

  it('置顶背景只用 token（深色模式另有值），宽屏选中的高亮盖过它', async () => {
    const css = readFileSync('src/global.css', 'utf8');
    expect(css).toMatch(/\.tt-conv-pinned\s*\{\s*background: var\(--tt-color-surface-pinned\);\s*\}/);
    expect(css.indexOf('.tt-conv-pinned {')).toBeLessThan(css.indexOf('.tt-conv-selected {'));
    const tokens = await import('../theme/tokens.json').then((m) => m.default.color as Record<string, Body>);
    expect(tokens['surface.pinned']).toEqual({ light: '#F3F4F8', dark: '#23262E' });
    expect(tokens['surface.pinned']!.light).not.toBe(tokens.surface!.light);
    expect(tokens['surface.pinned']!.dark).not.toBe(tokens.surface!.dark);
  });

  it.each([
    [4220, '最多置顶 20 个会话'],
    [4290, '操作过于频繁'],
    [5000, '服务异常，请稍后重试'],
  ])('失败 %i：SDK 回滚（不再置顶、回到原位置），提示"%s"，不自动重试', async (code, text) => {
    const { c } = await list();
    await rightClick(G);
    await pick('conv-menu-pin');
    expect(order()[0]).toBe(G);
    await answer(c, 'convSet', { error: { code } });
    expect(order()).toEqual([AB, AC, G]);
    expect(item(G)).not.toHaveClass('tt-conv-pinned');
    expect(toastText()).toContain(text);
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(c.frames().filter((f) => f.cmd === 'convSet')).toHaveLength(1);
  });

  it('其他设备改的（convSettingsChanged）：列表跟着变，菜单文字也跟着变（AC-CVS-04-1 的页面部分）', async () => {
    const { c } = await list();
    await event(c, { type: 'convSettingsChanged', convId: AC, pinned: true, pinnedAt: NOW, notifyOff: true });
    expect(order()).toEqual([AC, AB, G]);
    expect(item(AC)).toHaveClass('tt-conv-pinned');
    expect(within(item(AC)).getByRole('img', { name: '免打扰' })).toBeInTheDocument();
    await rightClick(AC);
    expect(menuTexts()).toEqual(['取消置顶', '取消免打扰', '删除']);
    await event(c, { type: 'convSettingsChanged', convId: AC, pinned: false, notifyOff: false });
    expect(menuTexts()).toEqual(['置顶', '免打扰', '删除']); // 开着的菜单按当前状态
    expect(order()).toEqual([AB, AC, G]);
  });
});

describe('免打扰（F-CVS-02）', () => {
  it('TC-CVS-02-03 免打扰未读 5：小红点（没有数字）、"[5 条]"、右侧免打扰图标（有可读名称）', async () => {
    const { c } = await list();
    await rightClick(G);
    await pick('conv-menu-notify');
    expect(c.last('convSet').data).toEqual({ convId: G, notifyOff: true });
    await answer(c, 'convSet', { data: ackConv({ ...three()[2]!, notifyOff: true, unread: 5 }) });
    const g = item(G);
    expect(within(g).getByTestId('conv-dot')).toBeInTheDocument();
    expect(within(g).getByTestId('conv-dot').textContent).toBe('');
    expect(within(g).queryByTestId('conv-badge')).toBeNull();
    expect(summary(G)).toBe('[5 条] bob: 群里的消息');
    expect(within(g).getByRole('img', { name: '免打扰' })).toBeInTheDocument();
    // 取消免打扰：回到数字角标，没有前缀和图标
    await rightClick(G);
    expect(menuTexts()[1]).toBe('取消免打扰');
    await pick('conv-menu-notify');
    expect(c.last('convSet').data).toEqual({ convId: G, notifyOff: false });
    await answer(c, 'convSet', { data: ackConv({ ...three()[2]!, unread: 5 }) });
    expect(within(item(G)).getByTestId('conv-badge')).toHaveTextContent('5');
    expect(within(item(G)).queryByTestId('conv-dot')).toBeNull();
    expect(summary(G)).toBe('bob: 群里的消息');
    expect(within(item(G)).queryByRole('img', { name: '免打扰' })).toBeNull();
  });

  it('没有未读时没有小红点和"[N 条]"，图标还在；N 超过 99 照实显示（第 61 条）', async () => {
    await list(
      three({
        [AB]: { notifyOff: true, unread: 0 },
        [AC]: { notifyOff: true, unread: 120 },
      }),
    );
    expect(within(item(AB)).queryByTestId('conv-dot')).toBeNull();
    expect(summary(AB)).toBe('bob 的消息');
    expect(within(item(AB)).getByRole('img', { name: '免打扰' })).toBeInTheDocument();
    expect(summary(AC)).toBe('[120 条] carol 的消息');
    expect(within(item(AC)).queryByText('99+')).toBeNull();
  });

  it('TC-CVS-02-03 第 2 步：前缀只显示一个，"[有人@我]" > "[草稿]" > "[N 条]"；有 @ 时仍是小红点（第 61 条）', async () => {
    const { c } = await list(three({ [G]: { notifyOff: true, unread: 0, mentionUnread: 0 } }));
    const msg = (seq: number, body: Body) => ({
      cmd: 'msg',
      data: {
        convId: G,
        seq,
        msgId: `m${seq}`,
        clientMsgId: `s${seq}`,
        from: 'bob',
        type: 'text',
        body,
        ts: NOW + seq,
      },
    });
    // 写草稿（打开会话已读完），回到列表
    fireEvent.click(item(G));
    await settle();
    await answer(c, 'sync', { data: { messages: [], hasMore: false } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '还没写完' } });
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await settle();
    // 草稿 + 免打扰未读：草稿盖过"[N 条]"
    await act(async () => c.receive(msg(6, { text: '新消息' })));
    await settle();
    expect(summary(G)).toBe('[草稿] 还没写完');
    expect(within(item(G)).getByTestId('conv-dot')).toBeInTheDocument();
    // 再来一条 @ 我：盖过草稿，仍是小红点
    await act(async () => c.receive(msg(7, { text: '@alice 回一下', mentions: { userIds: ['alice'] } })));
    await settle();
    expect(summary(G)).toBe('[有人@我] bob: @alice 回一下');
    expect(within(item(G)).getByTestId('conv-dot')).toBeInTheDocument();
    expect(within(item(G)).queryByTestId('conv-badge')).toBeNull();
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('1'); // 总未读只算 @ 我的
  });

  it('TC-CVS-02-03 有 @ 我时：小红点，前缀"[有人@我]"，没有"[N 条]"和"[草稿]"', async () => {
    await list(three({ [G]: { notifyOff: true, unread: 6, mentionUnread: 1 } }));
    expect(within(item(G)).getByTestId('conv-dot')).toBeInTheDocument();
    expect(within(item(G)).queryByTestId('conv-badge')).toBeNull();
    expect(summary(G)).toBe('[有人@我] bob: 群里的消息');
  });
});

describe('总未读（F-CVS-02 规则 4，PRD-ui F-UI-23）', () => {
  it('TC-CVS-02-02 普通 2、3，免打扰 5：角标"5"，标题"(5) 天听"；取消免打扰后 10', async () => {
    const { c } = await list(three({ [AB]: { unread: 2 }, [AC]: { unread: 3 }, [G]: { unread: 5, notifyOff: true } }));
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('5');
    expect(document.title).toBe('(5) 天听');
    await rightClick(G);
    await pick('conv-menu-notify');
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('10');
    expect(document.title).toBe('(10) 天听');
    // 失败回滚：又是 5
    await answer(c, 'convSet', { error: { code: 5000 } });
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('5');
    expect(document.title).toBe('(5) 天听');
  });

  it('TC-CVS-02-04 未读全在免打扰会话（合计 7、没有 @）：标题"天听"，角标不显示', async () => {
    await list(three({ [AC]: { unread: 3, notifyOff: true }, [G]: { unread: 4, notifyOff: true } }));
    expect(document.title).toBe('天听');
    expect(screen.queryByTestId('tab-badge')).toBeNull();
    expect(within(item(AC)).getByTestId('conv-dot')).toBeInTheDocument();
  });

  it('TC-CVS-02-05 免打扰未读 5 其中 1 条 @ 我，普通未读 2：角标"3"，标题"(3) 天听"', async () => {
    await list(three({ [AB]: { unread: 2 }, [G]: { unread: 5, mentionUnread: 1, notifyOff: true } }));
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('3');
    expect(document.title).toBe('(3) 天听');
  });
});

/** 打开 AB 的聊天页，第一页历史 3 条（bob 发的，含特征串）。 */
async function chatAB(convs: C5Conv[] = three()) {
  const r = await renderLoggedIn(at(AB), { convs });
  await settle();
  await answer(r.c, 'sync', {
    data: {
      messages: [1, 2, 3].map((seq) => ({
        convId: AB,
        seq,
        msgId: `m${seq}`,
        clientMsgId: `s${seq}`,
        from: 'bob',
        type: 'text',
        body: { text: `ZXQ-CVS-2 第${seq}条` },
        ts: NOW - 5000 + seq,
      })),
      hasMore: false,
    },
  });
  return r;
}

/** 进聊天页数失败消息，再回到列表。 */
async function failedIn(convId: string) {
  fireEvent.click(item(convId));
  await settle();
  const n = document.querySelectorAll('[data-testid="message"][data-status="failed"]').length;
  await back();
  return n;
}

const back = async () => {
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  await settle();
};

/** 聊天页里发一条，服务端回 5000：失败消息（F-UI-09）。再写一段草稿，回到列表。 */
async function failedAndDraft(c: FakeConnection) {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '会失败的' } });
  fireEvent.click(screen.getByTestId('send-button'));
  await settle();
  await answer(c, 'send', { error: { code: 5000 } });
  expect(document.querySelector('[data-testid="message"][data-status="failed"]')).not.toBeNull();
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '草稿内容' } });
  await back();
}

describe('删除（F-CVS-03，AC-CVS-03-8）', () => {
  it('TC-CVS-03-08 确认框；取消时会话、草稿、失败消息都还在；确认后从列表消失，草稿、失败消息、消息都清除；再进入是空的聊天页', async () => {
    const { c } = await chatAB();
    await failedAndDraft(c);
    expect(summary(AB)).toBe('[草稿] 草稿内容');

    await rightClick(AB);
    await pick('conv-menu-delete');
    const dialog = screen.getByTestId('conv-delete-dialog');
    expect(dialog).toHaveTextContent('删除后聊天记录不再显示，确定删除？');
    expect(within(dialog).getByRole('button', { name: '删除' })).toHaveClass('tt-btn-danger');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await settle();
    expect(screen.queryByTestId('conv-delete-dialog')).toBeNull();
    expect(c.frames().some((f) => f.cmd === 'convDelete')).toBe(false);
    expect(order()).toEqual([AB, AC, G]);
    expect(await failedIn(AB)).toBe(1);
    expect(summary(AB)).toBe('[草稿] 草稿内容');

    await rightClick(AB);
    await pick('conv-menu-delete');
    fireEvent.click(within(screen.getByTestId('conv-delete-dialog')).getByRole('button', { name: '删除' }));
    await settle();
    expect(c.last('convDelete').data).toEqual({ convId: AB, upToSeq: 3 });
    expect(order()).toEqual([AC, G]); // 先从列表消失（SDK 乐观更新）
    await answer(c, 'convDelete', { data: { clearedSeq: 3 } });
    expect(order()).toEqual([AC, G]);
    expect(document.body.textContent).not.toContain('ZXQ-CVS-2');

    // 从通讯录（这里直接打开地址）重新进入：空的聊天页，没有草稿，可以发
    window.history.pushState(null, '', at(AB));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '又来了' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await settle();
    expect(c.last('send').data).toMatchObject({ convType: 'c2c', to: 'bob', body: { text: '又来了' } });
  });

  it.each([
    [4290, '操作过于频繁'],
    [5000, '服务异常，请稍后重试'],
  ])('删除失败 %i：会话恢复，草稿、失败消息还在，提示"%s"，不自动重试', async (code, text) => {
    const { c } = await chatAB();
    await failedAndDraft(c);
    await rightClick(AB);
    await pick('conv-menu-delete');
    fireEvent.click(within(screen.getByTestId('conv-delete-dialog')).getByRole('button', { name: '删除' }));
    await settle();
    expect(order()).toEqual([AC, G]);
    await answer(c, 'convDelete', { error: { code } });
    expect(order()).toEqual([AB, AC, G]);
    expect(summary(AB)).toBe('[草稿] 草稿内容');
    expect(toastText()).toContain(text);
    expect(await failedIn(AB)).toBe(1);
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(c.frames().filter((f) => f.cmd === 'convDelete')).toHaveLength(1);
  });

  it('群：删除会话不是退群，从"我的群聊"进入显示空的聊天页，可以发言（F-CVS-03 规则 4）', async () => {
    const { c } = await list();
    await rightClick(G);
    await pick('conv-menu-delete');
    fireEvent.click(within(screen.getByTestId('conv-delete-dialog')).getByRole('button', { name: '删除' }));
    await settle();
    expect(c.last('convDelete').data).toEqual({ convId: G, upToSeq: 5 });
    await answer(c, 'convDelete', { data: { clearedSeq: 5 } });
    expect(order()).toEqual([AB, AC]);
    window.history.pushState(null, '', at(G));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    // 本地没有这个群：向服务端确认（G-UI-26），服务端只给 minSeq 之后的（空）
    await answer(c, 'sync', { data: { messages: [], hasMore: false } });
    expect(screen.queryByTestId('chat-probing')).toBeNull(); // 不会一直"加载中"
    expect(c.last('groupInfo').data).toEqual({ groupId: 'g1' });
    await answer(c, 'groupInfo', { data: { groupId: 'g1', name: '删过的群', owner: 'bob', memberCount: 3 } });
    expect(screen.getByTestId('chat-title')).toHaveTextContent('删过的群');
    expect(screen.queryByText('你已不在该群')).toBeNull();
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '我还在' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await settle();
    expect(c.last('send').data).toMatchObject({ convType: 'group', to: 'g1', body: { text: '我还在' } });
  });
});

describe('多端（F-CVS-04，AC-CVS-04-5、AC-CVS-03-2 的页面部分）', () => {
  it('其他设备删除（convDeleted）：会话消失，这个标签页的草稿也清除（第 55 条）；对方再发，会话重新出现，未读 1，只有新消息', async () => {
    const { c } = await chatAB();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '这台的草稿' } });
    await back();
    expect(summary(AB)).toBe('[草稿] 这台的草稿');
    await event(c, { type: 'convDeleted', convId: AB, clearedSeq: 3 });
    expect(order()).toEqual([AC, G]);
    await act(async () =>
      c.receive({
        cmd: 'msg',
        data: {
          convId: AB,
          seq: 4,
          msgId: 'm4',
          clientMsgId: 's4',
          from: 'bob',
          type: 'text',
          body: { text: '删除后的新消息' },
          ts: NOW + 10,
        },
      }),
    );
    await settle();
    expect(order()[0]).toBe(AB);
    expect(summary(AB)).toBe('删除后的新消息'); // 没有"[草稿]"
    expect(within(item(AB)).getByTestId('conv-badge')).toHaveTextContent('1');
    fireEvent.click(item(AB));
    await settle();
    await answer(c, 'sync', { data: { messages: [], hasMore: false } });
    expect(screen.getAllByTestId('message')).toHaveLength(1);
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(document.body.textContent).not.toContain('ZXQ-CVS-2');
  });

  it('聊天页开着时被其他设备删除：输入框里的内容一起清除，离开后也不留草稿', async () => {
    const { c } = await chatAB();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '正在输入' } });
    await event(c, { type: 'convDeleted', convId: AB, clearedSeq: 3 });
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
    await back();
    expect(item(AB)).toBeNull();
    // 别的会话的事件不影响这里
    fireEvent.click(item(AC));
    await settle();
    await answer(c, 'sync', { data: { messages: [], hasMore: false } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '留着' } });
    await event(c, { type: 'convDeleted', convId: G, clearedSeq: 5 });
    expect(screen.getByTestId('composer-input')).toHaveValue('留着');
  });

  it('菜单开着时会话被其他设备删除：菜单关掉；会话因为新消息重新出现也不再弹出来', async () => {
    const { c } = await list();
    await rightClick(AC);
    expect(menu()).toBeInTheDocument();
    await event(c, { type: 'convDeleted', convId: AC, clearedSeq: 2 });
    expect(menu()).toBeNull();
    await act(async () =>
      c.receive({
        cmd: 'msg',
        data: {
          convId: AC,
          seq: 3,
          msgId: 'x3',
          clientMsgId: 'y3',
          from: 'carol',
          type: 'text',
          body: { text: '又来' },
          ts: NOW + 5,
        },
      }),
    );
    await settle();
    expect(item(AC)).not.toBeNull();
    expect(menu()).toBeNull();
  });
});
