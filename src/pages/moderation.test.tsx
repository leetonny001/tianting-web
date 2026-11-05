// PRD-admin 第二批（FE-431、FE-432、FE-433）的界面：封禁提示、消息被删除、禁言条。
import { FakeClock } from '@tianting/sdk/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { formatDateTime, formatMonthDayTime } from '../lib/time';
import { renderLoggedIn, settle } from '../test/harness';

const AB = 'c2c:alice:bob';
const G1 = 'group:g1';
const G2 = 'group:g2';
const SECRET = 'ZXQ-DEL-555';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
const msg = (convId: string, seq: number, from = 'bob', text = `m${seq}`) => ({
  msgId: `${convId}#${seq}`,
  clientMsgId: `${from}-${seq}`,
  convId,
  seq,
  from,
  type: 'text',
  body: { text },
  ts: 1_000_000 + seq,
});
const deletedEvent = (convId: string, seq: number) => ({
  cmd: 'event',
  data: { type: 'msgDeleted', convId, msgIds: [`${convId}#${seq}`], seqs: [seq] },
});
const event = (data: Record<string, unknown>) => ({ cmd: 'event', data });
const debugMemory = () =>
  JSON.stringify(
    (window as unknown as { __tiantingDebug: { exportMemory(): unknown } }).__tiantingDebug.exportMemory(),
  );

beforeEach(() => sessionStorage.clear());

describe('封禁（AC-ADM-13-11、AC-UI-43-2、AC-UI-43-4）', () => {
  async function kicked(frames: () => unknown[], code = 4012) {
    const clock = new FakeClock(Date.now());
    const r = await renderLoggedIn('/chats', { clock });
    await act(async () => {
      for (const f of frames()) r.c.receive(f);
      r.c.drop(code);
    });
    await settle();
    return { ...r, clock };
  }

  it('有 until：弹窗"账号已被封禁，解封时间：{YYYY-MM-DD HH:mm}"；不重连；点确定回登录页并清掉 token', async () => {
    const until = new Date(2031, 0, 2, 3, 4).getTime();
    const { transport, clock } = await kicked(() => [event({ type: 'kicked', reason: 'suspended', until })]);
    const dialog = screen.getByTestId('kicked-dialog');
    expect(dialog).toHaveTextContent('账号已被封禁，解封时间：2031-01-02 03:04');
    act(() => clock.advance(300_000));
    expect(transport.connections).toHaveLength(1);
    fireEvent.click(within(dialog).getByText('确定'));
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
    expect(transport.connections).toHaveLength(1);
  });

  it('永久（until = null）：只有"账号已被封禁"', async () => {
    await kicked(() => [event({ type: 'kicked', reason: 'suspended', until: null })]);
    expect(screen.getByTestId('kicked-dialog').textContent).toContain('账号已被封禁');
    expect(screen.getByTestId('kicked-dialog').textContent).not.toContain('解封时间');
  });

  it('不认识的 reason + 4012、只有关闭码 4012："账号已被下线"', async () => {
    const a = await kicked(() => [event({ type: 'kicked', reason: 'xyz' })]);
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('账号已被下线');
    a.unmount();
    sessionStorage.clear();
    await kicked(() => []);
    expect(screen.getByTestId('kicked-dialog')).toHaveTextContent('账号已被下线');
  });

  it.each([
    [new Date(2031, 0, 2, 3, 4).getTime(), '账号已被封禁，解封时间：2031-01-02 03:04'],
    [null, '账号已被封禁'],
  ])('/demo/login 返回 403 / 4034（bannedUntil = %s）：登录页提示 %s，停留在登录页', async (bannedUntil, text) => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: 4034, msg: 'x', details: { bannedUntil } }), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState(null, '', '/login');
    render(<App />);
    fireEvent.change(screen.getByTestId('login-username'), { target: { value: 'u1' } });
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => expect(screen.getByTestId('login-error').textContent).toBe(text));
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('消息被删除（AC-ADM-31-1、AC-ADM-31-3、AC-ADM-31-5、AC-UI-42-4）', () => {
  it('在聊天页：原位置显示占位，没有头像和气泡；DOM 和调试导出都搜不到特征串；前后消息不变', async () => {
    const { c, container } = await renderLoggedIn(at(G1), { convs: [{ convId: G1, name: 'g1' }] });
    await act(async () => {
      c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', 'before') });
      c.receive({ cmd: 'msg', data: msg(G1, 2, 'bob', SECRET) });
      c.receive({ cmd: 'msg', data: msg(G1, 3, 'bob', 'after') });
    });
    await settle();
    expect(container.textContent).toContain(SECRET);
    expect(debugMemory()).toContain(SECRET); // 对照：删除之前能搜到
    expect(screen.getAllByTestId('message')).toHaveLength(3);
    await act(async () => c.receive(deletedEvent(G1, 2)));
    await settle();
    expect(screen.getByTestId('msg-deleted')).toHaveTextContent('该消息已被删除');
    expect(screen.getAllByTestId('message')).toHaveLength(2);
    expect(container.textContent).not.toContain(SECRET);
    expect(debugMemory()).not.toContain(SECRET);
    const order = [
      ...screen.getByTestId('message-list').querySelectorAll('[data-testid="message"],[data-testid="msg-deleted"]'),
    ];
    expect(order.map((e) => e.textContent)).toEqual([
      expect.stringContaining('before'),
      '该消息已被删除',
      expect.stringContaining('after'),
    ]);
  });

  it('长按占位 600ms、右键都不出现菜单（AC-UI-42-4）', async () => {
    const { c } = await renderLoggedIn(at(G1), { convs: [{ convId: G1 }] });
    await act(async () => c.receive({ cmd: 'msg', data: msg(G1, 1) }));
    await act(async () => c.receive(deletedEvent(G1, 1)));
    await settle();
    const row = screen.getByTestId('msg-deleted');
    fireEvent.pointerDown(row);
    expect(fireEvent.contextMenu(row)).toBe(false); // false = preventDefault：也不出现浏览器菜单（F-UI-09 规则 5）
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    expect(screen.queryByTestId('bubble-menu')).not.toBeInTheDocument();
  });

  it('菜单开着时消息被删除：菜单关闭，不留能复制原文的入口', async () => {
    const { c, container } = await renderLoggedIn(at(G1), { convs: [{ convId: G1 }] });
    await act(async () => c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', SECRET) }));
    await settle();
    fireEvent.contextMenu(screen.getByText(SECRET));
    expect(screen.getByTestId('bubble-menu')).toBeInTheDocument();
    await act(async () => c.receive(deletedEvent(G1, 1)));
    await settle();
    expect(screen.queryByTestId('bubble-menu')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(SECRET);
  });

  it('sync 回来的 deleted 消息（离线成员）：显示占位', async () => {
    const { c } = await renderLoggedIn(at(G1), { convs: [{ convId: G1, name: 'g1', maxSeq: 2, unread: 2 }] });
    await act(async () =>
      c.ack('sync', {
        messages: [msg(G1, 1), { ...msg(G1, 2), body: undefined, deleted: true, deletedAt: 5 }],
        hasMore: false,
      }),
    );
    await settle();
    expect(screen.getByTestId('msg-deleted')).toHaveTextContent('该消息已被删除');
    expect(screen.getAllByTestId('message')).toHaveLength(1);
  });

  it('会话列表：最后一条被删摘要占位、不带发送者前缀，未读不变（事件和 convs 两条路径）', async () => {
    const { c } = await renderLoggedIn('/chats', {
      convs: [
        { convId: G1, name: 'g1', maxSeq: 0 },
        {
          convId: G2,
          name: 'g2',
          maxSeq: 3,
          unread: 3,
          lastMsg: { msgId: 'x', from: 'bob', type: 'text', ts: 5, deleted: true },
        },
      ],
    });
    const item = (id: string) => document.querySelector(`[data-conv-id="${id}"]`) as HTMLElement;
    // convs 路径
    expect(item(G2).querySelector('.tt-conv-summary')?.textContent).toBe('该消息已被删除');
    expect(within(item(G2)).getByTestId('conv-badge')).toHaveTextContent('3');
    // 事件路径
    await act(async () => c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', SECRET) }));
    await settle();
    expect(item(G1).querySelector('.tt-conv-summary')?.textContent).toContain(SECRET);
    expect(within(item(G1)).getByTestId('conv-badge')).toHaveTextContent('1');
    await act(async () => c.receive(deletedEvent(G1, 1)));
    await settle();
    expect(item(G1).querySelector('.tt-conv-summary')?.textContent).toBe('该消息已被删除');
    expect(within(item(G1)).getByTestId('conv-badge')).toHaveTextContent('1');
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

describe('SDK 调试接口的范围', () => {
  it('生产构建（DEMO_LOGIN = false）不挂到 window', async () => {
    vi.resetModules();
    vi.doMock('../lib/config', async (orig) => ({
      ...(await orig<typeof import('../lib/config')>()),
      DEMO_LOGIN: false,
    }));
    const { renderLoggedIn: render2 } = await import('../test/harness');
    await render2('/chats', { convs: [] });
    expect('__tiantingDebug' in window).toBe(false);
    vi.doUnmock('../lib/config');
    vi.resetModules();
  });
});

describe('禁言条（AC-ADM-40-4、40-5、40-6、41-6、AC-UI-41-2～5）', () => {
  const convs = [
    { convId: G1, name: 'g1' },
    { convId: G2, name: 'g2' },
    { convId: AB, name: 'bob' },
  ];

  it('收到 muted：输入框消失，显示解除时间（MM-DD HH:mm）；unmuted 后输入框恢复', async () => {
    const until = new Date(2031, 5, 7, 8, 9).getTime();
    const { c } = await renderLoggedIn(at(AB), { convs });
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    await act(async () => c.receive(event({ type: 'muted', scope: 'user', mutedUntil: until })));
    await settle();
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言，解除时间：06-07 08:09');
    await act(async () => c.receive(event({ type: 'unmuted', scope: 'user' })));
    await settle();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
  });

  it('永久禁言：只有"你已被禁言"', async () => {
    const { c } = await renderLoggedIn(at(AB), { convs });
    await act(async () => c.receive(event({ type: 'muted', scope: 'user', mutedUntil: null })));
    await settle();
    expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言');
  });

  describe('全群禁言（FE-354、TC-UI-41-07、AC-UI-41-6）', () => {
    const ALL = { scope: 'groupAll', groupId: 'g1', mutedUntil: null };
    const withRole = (myRole?: string, extra = {}) => [
      { ...convs[0]!, ...(myRole ? { myRole } : {}), ...extra },
      convs[1]!,
      convs[2]!,
    ];

    it('muted {scope: groupAll}：禁用条为"群主已开启全员禁言"，没有解除时间；关闭后输入框恢复', async () => {
      const { c } = await renderLoggedIn(at(G1), { convs: withRole('member') });
      expect(screen.getByTestId('composer-input')).toBeInTheDocument();
      await act(async () => c.receive(event({ type: 'muted', ...ALL })));
      await settle();
      expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
      expect(screen.getByTestId('composer-disabled').textContent).toBe('群主已开启全员禁言');
      await act(async () => c.receive(event({ type: 'unmuted', scope: 'groupAll', groupId: 'g1' })));
      await settle();
      expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    });

    it('convs 带 allMuted：一进聊天页就是禁用条；只影响该群', async () => {
      await renderLoggedIn(at(G1), { convs: withRole('member', { allMuted: true }) });
      expect(screen.getByTestId('composer-disabled').textContent).toBe('群主已开启全员禁言');
    });

    it('别的群的聊天页没有禁用条', async () => {
      const { c } = await renderLoggedIn(at(G2), { convs: withRole('member') });
      await act(async () => c.receive(event({ type: 'muted', ...ALL })));
      await settle();
      expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    });

    it.each(['owner', 'admin'])('%s 不受限：收到事件后输入框还在', async (role) => {
      const { c } = await renderLoggedIn(at(G1), { convs: withRole(role, { allMuted: true }) });
      await act(async () => c.receive(event({ type: 'muted', ...ALL })));
      await settle();
      expect(screen.getByTestId('composer-input')).toBeInTheDocument();
      expect(screen.queryByTestId('composer-disabled')).not.toBeInTheDocument();
    });

    it('单独禁言优先：群内禁言显示解除时间，不显示全员禁言文案', async () => {
      const until = new Date(2031, 5, 7, 8, 9).getTime();
      const { c } = await renderLoggedIn(at(G1), { convs: withRole('member', { allMuted: true }) });
      await act(async () => c.receive(event({ type: 'muted', scope: 'group', groupId: 'g1', mutedUntil: until })));
      await settle();
      expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言，解除时间：06-07 08:09');
    });
  });

  it('auth ack 带 mutedUntil：一进聊天页就是禁言条（AC-ADM-40-6）', async () => {
    await renderLoggedIn(at(G2), { convs, mutedUntil: null });
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言');
  });

  it.each([
    [G1, true],
    [G2, false],
    [AB, false],
  ])('convs 里 g1 带 mutedUntil：打开 %s，禁言条 = %s（AC-ADM-41-6）', async (convId, bar) => {
    const until = new Date(2031, 5, 7, 8, 9).getTime();
    await renderLoggedIn(at(convId), { convs: [{ ...convs[0]!, mutedUntil: until }, convs[1]!, convs[2]!] });
    expect(screen.queryByTestId('composer-disabled') !== null).toBe(bar);
    expect(screen.queryByTestId('composer-input') !== null).toBe(!bar);
    if (bar) expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言，解除时间：06-07 08:09');
  });

  it('群内 muted 事件只影响该群：别的群的聊天页没有禁言条', async () => {
    const { c } = await renderLoggedIn(at(G2), { convs });
    await act(async () => c.receive(event({ type: 'muted', scope: 'group', groupId: 'g1', mutedUntil: null })));
    await settle();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    await act(async () => c.receive(event({ type: 'muted', scope: 'group', groupId: 'g2', mutedUntil: null })));
    await settle();
    expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言');
  });

  it('发送返回 4031：消息失败，出现禁用条，不弹轻提示（F-UI-41 规则 5）', async () => {
    const until = new Date(2031, 5, 7, 8, 9).getTime();
    const { c } = await renderLoggedIn(at(G1), { convs });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await act(async () =>
      c.receive({
        id: c.last('send').id,
        cmd: 'ack',
        error: { code: 4031, msg: 'm', details: { scope: 'group', groupId: 'g1', mutedUntil: until } },
      }),
    );
    await settle();
    expect(screen.getByTestId('message')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('composer-disabled').textContent).toBe('你已被禁言，解除时间：06-07 08:09');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('.tt-toast')).toBeNull();
  });

  it('到期按服务端时间恢复：本机时钟比服务端慢 1 小时，没有收到 unmuted（AC-UI-41-4）', async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const serverTime = clock.now() + 3_600_000;
    const { c } = await renderLoggedIn(at(AB), { convs, clock, serverTime });
    await act(async () => c.receive(event({ type: 'muted', scope: 'user', mutedUntil: serverTime + 600_000 })));
    await settle();
    expect(screen.getByTestId('composer-disabled')).toBeInTheDocument();
    await act(async () => clock.advance(599_000));
    expect(screen.getByTestId('composer-disabled')).toBeInTheDocument();
    await act(async () => clock.advance(1_000));
    await settle();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
  });

  it('到期恢复后 send 仍返回 4031：禁用条重新显示（TC-UI-41-05、F-UI-41 规则 4）', async () => {
    const clock = new FakeClock(Date.now());
    const { c } = await renderLoggedIn(at(AB), { convs, clock });
    const until = clock.now() + 5_000;
    await act(async () => c.receive(event({ type: 'muted', scope: 'user', mutedUntil: until })));
    await settle();
    expect(screen.getByTestId('composer-disabled')).toBeInTheDocument();
    await act(async () => clock.advance(6_000));
    await settle();
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: '再试试' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const later = clock.now() + 60_000;
    await act(async () =>
      c.receive({
        id: c.last('send').id,
        cmd: 'ack',
        error: { code: 4031, msg: 'm', details: { scope: 'user', mutedUntil: later } },
      }),
    );
    await settle();
    expect(screen.getByTestId('composer-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
  });

  it('格式化函数：年份、补零', () => {
    const t = new Date(2031, 0, 2, 3, 4).getTime();
    expect(formatDateTime(t)).toBe('2031-01-02 03:04');
    expect(formatMonthDayTime(t)).toBe('01-02 03:04');
  });
});
