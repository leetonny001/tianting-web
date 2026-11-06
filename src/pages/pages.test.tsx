import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { stubFetch } from '../test/harness-fetch';
import { renderLoggedIn, settle } from '../test/harness';

const AB = 'c2c:alice:bob';
const G = 'group:g1';
const msg = (convId: string, seq: number, from = 'bob', text = `m${seq}`, ts = 1_000_000 + seq) => ({
  msgId: `${convId}#${seq}`,
  clientMsgId: `${from}-${seq}`,
  convId,
  seq,
  from,
  type: 'text',
  body: { text },
  ts,
});

beforeEach(() => {
  sessionStorage.clear();
  document.title = '天听';
});
afterEach(() => vi.useRealTimers());

describe('登录与路由守卫（F-UI-01、F-UI-03）', () => {
  it('未登录打开聊天页跳到 /login?redirect=…；用户名为空时按钮禁用（AC-UI-01-3、AC-UI-03-1）', async () => {
    window.history.pushState(null, '', '/chat/c2c%3Aalice%3Abob');
    render(<App />);
    expect(window.location.pathname).toBe('/login');
    expect(new URLSearchParams(window.location.search).get('redirect')).toBe('/chat/c2c%3Aalice%3Abob');
    expect(document.title).toBe('天听');
    const submit = await screen.findByTestId('login-submit');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId('login-username'), '   ');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId('login-username'), 'alice');
    expect(submit).toBeEnabled();
  });

  it('账号格式不合法提示"账号格式不正确"，不发请求（AC-AUTH-04-4）；昵称超过 32 字禁用（AC-UI-03-8）', async () => {
    const fetchMock = stubFetch(async () => new Response('{}', { status: 500 }));
    window.history.pushState(null, '', '/login');
    render(<App />);
    await userEvent.type(await screen.findByTestId('login-username'), 'bad.name{Enter}');
    expect(screen.getByTestId('login-error')).toHaveTextContent('账号格式不正确');
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.type(screen.getByTestId('login-nickname'), '字'.repeat(33));
    expect(screen.getByText('昵称最多 32 个字')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('演示登录 404 提示"登录服务未开启"（AC-UI-03-4）；连续点击只发一次请求（AC-UI-03-3）', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = stubFetch(() => new Promise((r) => (resolve = r)));
    window.history.pushState(null, '', '/login');
    render(<App />);
    await userEvent.type(await screen.findByTestId('login-username'), 'alice');
    const submit = screen.getByTestId('login-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(new Response('404 page not found', { status: 404 })));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('登录服务未开启');
  });

  it('已登录打开 /login 跳到 /chats（AC-UI-01-4）；标签栏三项，"消息"选中（AC-UI-01-1）', async () => {
    await renderLoggedIn('/login');
    expect(window.location.pathname).toBe('/chats');
    const tabs = screen.getAllByRole('link').filter((a) => a.className.includes('tt-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['消息', '通讯录', '我']);
    expect(screen.getByTestId('tab-chats')).toHaveClass('tt-tab-active');
  });
});

describe('会话列表（F-UI-04、F-UI-20、F-UI-23）', () => {
  it('首次加载显示骨架屏；空列表显示"还没有聊天"和"发起单聊"（AC-UI-20-1、AC-CONV-01-6）', async () => {
    await renderLoggedIn('/chats');
    expect(screen.getByTestId('chats-empty')).toHaveTextContent('还没有聊天');
    fireEvent.click(within(screen.getByTestId('chats-empty')).getByText('发起单聊'));
    expect(screen.getByTestId('start-chat-dialog')).toBeInTheDocument();
  });

  it('摘要：群里别人发的带前缀，单聊不带；角标 >99 显示 99+；总未读进标题（AC-UI-04-1、04-2、04-6、AC-UI-23-1、23-2）', async () => {
    await renderLoggedIn('/chats', {
      convs: [
        {
          convId: G,
          name: '周末球局',
          maxSeq: 3,
          unread: 120,
          updatedAt: 3,
          lastMsg: { msgId: 'x', from: 'bob', type: 'text', text: '晚上好', ts: 1 },
        },
        {
          convId: AB,
          name: 'bob',
          maxSeq: 2,
          unread: 5,
          updatedAt: 2,
          lastMsg: { msgId: 'y', from: 'bob', type: 'text', text: '你好', ts: 1 },
        },
        {
          convId: 'c2c:alice:carol',
          name: 'carol',
          maxSeq: 1,
          unread: 0,
          updatedAt: 1,
          lastMsg: { msgId: 'z', from: 'carol', type: 'custom', text: '', ts: 1 },
        },
      ],
    });
    const items = screen.getAllByTestId('conv-item');
    expect(items.map((i) => i.getAttribute('data-conv-id'))).toEqual([G, AB, 'c2c:alice:carol']);
    expect(items[0]).toHaveTextContent('bob: 晚上好');
    expect(items[1]).toHaveTextContent('你好');
    expect(items[1]).not.toHaveTextContent('bob: ');
    expect(items[2]).toHaveTextContent('[暂不支持的消息]');
    expect(within(items[0]!).getByTestId('conv-badge')).toHaveTextContent('99+');
    expect(within(items[1]!).getByTestId('conv-badge')).toHaveTextContent('5');
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('99+');
    expect(document.title).toBe('(125) 天听');
  });

  it('新消息让会话移到顶部（AC-CONV-01-2）', async () => {
    const { c } = await renderLoggedIn('/chats', {
      convs: [
        { convId: AB, name: 'bob', updatedAt: 2 },
        { convId: 'c2c:alice:carol', name: 'carol', updatedAt: 1 },
      ],
    });
    await act(async () => c.receive({ cmd: 'msg', data: msg('c2c:alice:carol', 1, 'carol', 'hi', 10) }));
    await settle();
    expect(screen.getAllByTestId('conv-item')[0]).toHaveAttribute('data-conv-id', 'c2c:alice:carol');
  });

  it('"+"菜单依次为"发起群聊""添加朋友""发起单聊"；发起单聊进入临时会话（AC-UI-05-5、AC-UI-05-2）', async () => {
    await renderLoggedIn('/chats');
    fireEvent.click(screen.getByTestId('plus-button'));
    expect(
      within(screen.getByTestId('plus-menu'))
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['发起群聊', '添加朋友', '发起单聊']);
    fireEvent.click(within(screen.getByTestId('plus-menu')).getByText('发起单聊'));
    expect(screen.getByTestId('start-chat-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('start-chat-input'), 'bob{Enter}');
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:bob');
    expect(screen.queryByTestId('start-chat-dialog')).not.toBeInTheDocument();
  });
});

describe('聊天页（F-UI-06～F-UI-10）', () => {
  it('给自己发消息：c2c:alice:alice 打开聊天页（AC-UI-05-3）', async () => {
    await renderLoggedIn(`/chat/${encodeURIComponent('c2c:alice:alice')}`);
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:alice');
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
  });

  it('不合法的会话 ID 回到会话列表并提示"会话不存在"（V-UI-14）', async () => {
    await renderLoggedIn('/chat/c2c%3Abob%3Acarol');
    expect(window.location.pathname).toBe('/chats');
    expect(screen.getByTestId('toast')).toHaveTextContent('会话不存在');
  });

  it('发送：发送中显示转圈，ack 后消失；失败点"!"确认重发，clientMsgId 不变（AC-UI-08-1、08-2）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(AB)}`, { convs: [{ convId: AB, name: 'bob' }] });
    await userEvent.type(screen.getByTestId('composer-input'), '你好{Enter}');
    const m = screen.getByTestId('message');
    expect(m).toHaveAttribute('data-status', 'sending');
    expect(within(m).getByTestId('sending-icon')).toBeInTheDocument();
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    await act(async () => c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: Date.now() }));
    await settle();
    expect(screen.getByTestId('message')).toHaveAttribute('data-status', 'sent');
    expect(screen.queryByTestId('sending-icon')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('composer-input'), '第二条{Enter}');
    await act(async () => c.ackError('send', 4290));
    await settle();
    expect(screen.getByTestId('toast')).toHaveTextContent('发送太频繁，请稍后再试');
    const failed = screen.getAllByTestId('message')[1]!;
    const cid = failed.getAttribute('data-client-msg-id');
    fireEvent.click(within(failed).getByTestId('failed-icon'));
    expect(screen.getByTestId('retry-dialog')).toHaveTextContent('重发该消息？');
    const before = c.frames().filter((f) => f.cmd === 'send').length;
    fireEvent.click(screen.getByText('重发'));
    const sends = c.frames().filter((f) => f.cmd === 'send');
    expect(sends).toHaveLength(before + 1);
    expect(sends.at(-1)!.data!.clientMsgId).toBe(cid);
  });

  it('群聊：别人的消息上方显示发送者，自己的不显示；纯文本渲染，不生成标签（AC-UI-07-2、AC-UI-07-5）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(G)}`, {
      convs: [{ convId: G, name: '周末球局', maxSeq: 0 }],
    });
    await act(async () => c.receive({ cmd: 'msg', data: msg(G, 1, 'bob', 'https://example.com/a?b=<script>') }));
    await settle();
    const bubble = screen.getByTestId('message');
    expect(bubble).toHaveTextContent('bob');
    expect(bubble).toHaveTextContent('https://example.com/a?b=<script>');
    expect(bubble.querySelector('a, script')).toBeNull();
  });

  it('超过 5000 字显示"已超出 N 字"，按钮禁用、回车不发送（AC-UI-10-4）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(AB)}`, { convs: [{ convId: AB, name: 'bob' }] });
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: '字'.repeat(5003) } });
    expect(screen.getByTestId('over-limit')).toHaveTextContent('已超出 3 字');
    expect(screen.getByTestId('send-button')).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(0);
    fireEvent.change(input, { target: { value: '字'.repeat(5000) } });
    expect(screen.queryByTestId('over-limit')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeEnabled();
  });

  it('输入法组字时 Enter 不发送；compositionend 后 50ms 内的 Enter 不发送（AC-UI-10-2）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(AB)}`, { convs: [{ convId: AB, name: 'bob' }] });
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    fireEvent.compositionEnd(input);
    now.mockReturnValue(1030);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(0);
    now.mockReturnValue(1080);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(1);
  });

  it('被移出群后输入区变为"你已不在该群，无法发送消息"（AC-UI-10-5、AC-GRP-03-3）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(G)}`, { convs: [{ convId: G, name: 'g1' }] });
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    await act(async () => c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G } }));
    await settle();
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-disabled')).toHaveTextContent('你已不在该群，无法发送消息');
  });
});

describe('被踢、退出登录（F-UI-16、F-UI-18）', () => {
  it('被踢弹窗：tooManyConnections 文案；Esc 和点遮罩都不关闭；"确定"回登录页并清掉 token（AC-UI-18-1、18-2）', async () => {
    const { c } = await renderLoggedIn('/chats');
    await act(async () => {
      c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tooManyConnections' } });
      c.drop(4429, 'too many');
    });
    await settle();
    const dialog = screen.getByTestId('kicked-dialog');
    expect(dialog).toHaveTextContent('登录设备过多，当前设备已下线');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('kicked-dialog-scrim'));
    expect(screen.getByTestId('kicked-dialog')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('确定'));
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('退出登录：有 2 条失败消息时提示"有 2 条消息未发送"；取消不断开；确认后 1000 关闭（AC-UI-16-1～3）', async () => {
    const { c } = await renderLoggedIn(`/chat/${encodeURIComponent(AB)}`, { convs: [{ convId: AB, name: 'bob' }] });
    for (const t of ['a', 'b']) {
      await userEvent.type(screen.getByTestId('composer-input'), `${t}{Enter}`);
      await act(async () => c.ackError('send', 4290));
      await settle();
    }
    window.history.pushState(null, '', '/me/settings');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    fireEvent.click(screen.getByTestId('logout'));
    expect(screen.getByTestId('logout-dialog')).toHaveTextContent('有 2 条消息未发送，退出后将丢失');
    fireEvent.click(within(screen.getByTestId('logout-dialog')).getByText('取消'));
    expect(c.closedWith).toBeNull();
    fireEvent.click(screen.getByTestId('logout'));
    fireEvent.click(within(screen.getByTestId('logout-dialog')).getByText('退出'));
    expect(c.closedWith).toEqual({ code: 1000, reason: 'logout' });
    expect(window.location.pathname).toBe('/login');
    expect(sessionStorage.length).toBe(0);
  });

  it('"关于天听"的版本号与 package.json 一致（AC-UI-16-4）', async () => {
    await renderLoggedIn('/me/settings');
    const pkg = (await import('../../package.json')).default as { version: string };
    expect(screen.getByTestId('app-version')).toHaveTextContent(pkg.version);
  });
});
