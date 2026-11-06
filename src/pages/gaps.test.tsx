import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderLoggedIn, settle } from '../test/harness';

const G = 'group:g1';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;

beforeEach(() => sessionStorage.clear());

describe('会话列表截断提示（AC-UI-04-7）', () => {
  it('truncated = true 时底部显示"仅显示最近 500 个会话"；false 时不显示', async () => {
    const off = await renderLoggedIn('/chats', { convs: [{ convId: G, name: 'g1' }] });
    expect(screen.queryByTestId('convs-truncated')).not.toBeInTheDocument();
    off.unmount();
    sessionStorage.clear();
    await renderLoggedIn('/chats', { convs: [{ convId: G, name: 'g1' }], truncated: true });
    expect(screen.getByTestId('convs-truncated')).toHaveTextContent('仅显示最近 500 个会话');
  });
});

function baseConv(convId: string) {
  return {
    convId,
    type: 'group',
    name: convId,
    maxSeq: 0,
    readSeq: 0,
    minSeq: 1,
    unread: 0,
    lastMsg: null,
    updatedAt: 0,
  };
}

describe('聊天页标题与成员数（AC-UI-06-1、AC-UI-06-2、AC-UI-12-1）', () => {
  it('群聊标题"群名（N）"；memberCount 缺失时只显示群名', async () => {
    await renderLoggedIn(at(G), { convs: [{ convId: G, name: '周末球局', memberCount: 12 }] });
    expect(screen.getByTestId('chat-title')).toHaveTextContent('周末球局（12）');
  });
  it('缺少 memberCount 不显示括号', async () => {
    await renderLoggedIn(at(G), { convs: [{ convId: G, name: '周末球局' }] });
    expect(screen.getByTestId('chat-title').textContent).toBe('周末球局');
  });
});

describe('被移出 / 解散 / 未知会话（F-UI-33）', () => {
  it('收到 convRemoved（dissolved）：标题保留群名、不带成员数，提示"群聊已解散"', async () => {
    const { c } = await renderLoggedIn(at(G), { convs: [{ convId: G, name: '周末球局', memberCount: 3 }] });
    await act(async () => c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'dissolved' } }));
    await settle();
    expect(screen.getByTestId('chat-title').textContent).toBe('周末球局');
    expect(screen.getByTestId('chat-blocked-tip')).toHaveTextContent('群聊已解散');
    expect(screen.getByTestId('composer-disabled')).toHaveTextContent('群聊已解散');
  });

  it('不认识的 reason 按"你已不在该群"；重新被拉进群后输入框恢复（AC-UI-33-11、33-12）', async () => {
    const { c } = await renderLoggedIn(at(G), { convs: [{ convId: G, name: 'g1' }] });
    await act(async () =>
      c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'somethingNew' } }),
    );
    await settle();
    expect(screen.getByTestId('composer-disabled')).toHaveTextContent('你已不在该群，无法发送消息');
    await act(async () => c.receive({ cmd: 'event', data: { type: 'convAdded', conv: baseConv(G) } }));
    await settle();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
  });

  it('被移出后输入内容不保留，重新进群时输入框是空的（F-UI-33 规则 5）', async () => {
    const { c } = await renderLoggedIn(at(G), { convs: [{ convId: G, name: 'g1' }] });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '没发出去的话' } });
    await act(async () => c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'removed' } }));
    await settle();
    expect(screen.getByTestId('composer-disabled')).toBeInTheDocument();
    await act(async () => c.receive({ cmd: 'event', data: { type: 'convAdded', conv: baseConv(G) } }));
    await settle();
    expect(screen.getByTestId('composer-input')).toHaveValue('');
  });

  it('打开不在列表里的群：sync 返回前只显示加载状态；4033 → "你已不在该群"（AC-UI-33-10）', async () => {
    const { c } = await renderLoggedIn(at(G), { convs: [] });
    expect(screen.getByTestId('chat-probing')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-blocked-tip')).not.toBeInTheDocument();
    expect(c.last('sync').data).toMatchObject({ convId: G, beforeSeq: Number.MAX_SAFE_INTEGER });
    await act(async () => c.ackError('sync', 4033));
    await settle();
    expect(screen.getByTestId('chat-title').textContent).toBe('群聊');
    expect(screen.getByTestId('chat-blocked-tip')).toHaveTextContent('你已不在该群');
  });

  it('4043 → "群聊不存在或已解散"', async () => {
    const { c } = await renderLoggedIn(at(G), { convs: [] });
    await act(async () => c.ackError('sync', 4043));
    await settle();
    expect(screen.getByTestId('chat-blocked-tip')).toHaveTextContent('群聊不存在或已解散');
    expect(screen.getByTestId('composer-disabled')).toHaveTextContent('群聊不存在或已解散');
  });
});

describe('第一次连上之前按回车', () => {
  // 单聊：群要先探测成员，连上之前没有输入框。
  const C = 'c2c:alice:bob';
  it('不丢消息：输入框内容保留并提示，没有报错；连上后再按回车发出去', async () => {
    const { c } = await renderLoggedIn(at(C), { pending: true });
    await settle();
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: '先打的字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(input).toHaveValue('先打的字');
    expect(screen.getByTestId('toast')).toHaveTextContent('正在连接，请稍后再发送');
    expect(screen.queryByTestId('message')).not.toBeInTheDocument();

    await act(async () => {
      c.open();
      c.ack('auth', { userId: 'alice', serverTime: Date.now() });
    });
    await settle();
    await act(async () => c.ack('convs', { convs: [{ ...baseConv(C), type: 'c2c' }], truncated: false }));
    await settle();
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await settle();
    expect(screen.getByTestId('composer-input')).toHaveValue('');
    expect(screen.getByTestId('message')).toHaveTextContent('先打的字');
  });
});
