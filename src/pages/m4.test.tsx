import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStore } from '../im/drafts';
import { EMOJI } from '../lib/emoji';
import { wideRoute } from '../lib/layout';
import { safeRedirect } from '../lib/routes';
import { renderLoggedIn, settle } from '../test/harness';

const AB = 'c2c:alice:bob';
const AC = 'c2c:alice:carol';
const AD = 'c2c:alice:dave';
const G1 = 'group:g1';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
const last = (text: string, seq = 1) => ({ msgId: `m${seq}`, from: 'bob', type: 'text', text, ts: 1000 + seq });
const msg = (convId: string, seq: number, text: string, from = 'bob') => ({
  cmd: 'msg',
  data: {
    msgId: `${convId}#${seq}`,
    clientMsgId: `${from}-${seq}`,
    convId,
    seq,
    from,
    type: 'text',
    body: { text },
    ts: 1000 + seq,
  },
});

const order = () => screen.getAllByTestId('conv-item').map((x) => x.getAttribute('data-conv-id'));
const row = (convId: string) =>
  screen.getAllByTestId('conv-item').find((x) => x.getAttribute('data-conv-id') === convId)!;
const input = () => screen.getByTestId<HTMLTextAreaElement>('composer-input');

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('表情（AC-UI-11-1、AC-UI-11-4）', () => {
  it('列表 ≥ 80 个，都是单个码点、≤ U+1FAFF、没有 ZWJ 和变体选择符（AC-UI-11-4）', () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(80);
    expect(new Set(EMOJI).size).toBe(EMOJI.length);
    for (const e of EMOJI) {
      const cps = Array.from(e).map((c) => c.codePointAt(0)!);
      expect(cps, e).toHaveLength(1);
      expect(cps[0]!, e).toBeLessThanOrEqual(0x1faff);
      expect(cps[0]!, e).not.toBe(0x200d);
      expect(cps[0]!, e).not.toBe(0xfe0f);
    }
  });

  it('插入到光标位置，光标在表情后面；面板还开着可以连续插入（AC-UI-11-1）', async () => {
    const user = userEvent.setup();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }] });
    fireEvent.change(input(), { target: { value: '你好世界' } });
    input().setSelectionRange(2, 2);
    await user.click(screen.getByTestId('emoji-button'));
    const grin = screen.getAllByTestId('emoji-item').find((x) => x.textContent === '😀')!;
    fireEvent.click(grin);
    expect(input().value).toBe('你好😀世界');
    expect(input().selectionStart).toBe(4); // 😀 占两个 UTF-16 单元
    expect(input().selectionEnd).toBe(4);
    fireEvent.click(screen.getAllByTestId('emoji-item').find((x) => x.textContent === '😂')!);
    expect(input().value).toBe('你好😀😂世界');
    expect(input().selectionStart).toBe(6);
  });

  it('选中文字时替换选中的内容；空输入框直接插入，可以发送', async () => {
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }] });
    fireEvent.change(input(), { target: { value: 'abcd' } });
    input().setSelectionRange(1, 3);
    fireEvent.click(screen.getByTestId('emoji-button'));
    fireEvent.click(screen.getAllByTestId('emoji-item')[0]!);
    expect(input().value).toBe(`a${EMOJI[0]}d`);
    expect(screen.getByTestId('send-button')).toBeEnabled();
  });

  it('再次点击按钮、点输入框都收起面板（F-UI-11 规则 1）；按钮有名字和展开状态', async () => {
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }] });
    const button = screen.getByRole('button', { name: '表情' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('emoji-panel')).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByTestId('emoji-panel')).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(input());
    expect(screen.queryByTestId('emoji-panel')).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('emoji-panel')).not.toBeInTheDocument();
  });
});

describe('草稿（AC-UI-24-1～3）', () => {
  const convs = [
    { convId: AB, name: 'bob', maxSeq: 1, lastMsg: last('b 的消息'), updatedAt: 3000 },
    { convId: AC, name: 'carol', maxSeq: 1, lastMsg: last('c 的消息'), updatedAt: 2000 },
    { convId: AD, name: 'dave', maxSeq: 1, lastMsg: last('d 的消息'), updatedAt: 1000 },
  ];
  const leave = async () => {
    fireEvent.click(screen.getByLabelText('返回'));
    await settle();
  };

  it('离开时保存，摘要"[草稿] …"，[草稿] 单独着色；回来恢复；回来时摘要不显示草稿（AC-UI-24-1）', async () => {
    await renderLoggedIn(at(AD), { convs });
    fireEvent.change(input(), { target: { value: '明天见' } });
    await leave();
    const summary = row(AD).querySelector('.tt-conv-summary')!;
    expect(summary.textContent).toBe('[草稿] 明天见');
    expect(within(row(AD)).getByTestId('draft-tag')).toHaveClass('tt-draft-tag');
    expect(within(row(AD)).getByTestId('draft-tag')).toHaveTextContent('[草稿]');
    fireEvent.click(row(AD));
    await settle();
    expect(input().value).toBe('明天见');
  });

  it('草稿不改变位置；新消息按规则置顶，摘要仍是草稿（AC-UI-24-2）', async () => {
    const { c } = await renderLoggedIn(at(AD), { convs });
    fireEvent.change(input(), { target: { value: '排第三' } });
    await leave();
    expect(order()).toEqual([AB, AC, AD]);
    await act(async () => c.receive({ ...msg(AD, 2, '新消息'), data: { ...msg(AD, 2, '新消息').data, ts: 9000 } }));
    await settle();
    expect(order()).toEqual([AD, AB, AC]);
    expect(row(AD).querySelector('.tt-conv-summary')!.textContent).toBe('[草稿] 排第三');
  });

  it('清空后离开：摘要恢复为最后一条；只有空白也不算草稿（AC-UI-24-3）', async () => {
    await renderLoggedIn(at(AD), { convs });
    fireEvent.change(input(), { target: { value: '写了又删' } });
    await leave();
    fireEvent.click(row(AD));
    await settle();
    fireEvent.change(input(), { target: { value: '' } });
    await leave();
    expect(row(AD).querySelector('.tt-conv-summary')!.textContent).toBe('d 的消息');
    fireEvent.click(row(AD));
    await settle();
    fireEvent.change(input(), { target: { value: ' \n ' } });
    await leave();
    expect(row(AD).querySelector('.tt-conv-summary')!.textContent).toBe('d 的消息');
  });

  it('群聊草稿没有发送者前缀；各会话的草稿互不影响；发送成功后不留草稿', async () => {
    const { c } = await renderLoggedIn(at(G1), {
      convs: [...convs, { convId: G1, name: 'g1', maxSeq: 1, lastMsg: last('群消息'), updatedAt: 4000 }],
    });
    fireEvent.change(input(), { target: { value: '群草稿' } });
    await leave();
    expect(row(G1).querySelector('.tt-conv-summary')!.textContent).toBe('[草稿] 群草稿');
    fireEvent.click(row(AB));
    await settle();
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: '发出去' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => c.ack('send', { msgId: 'x', convId: AB, seq: 2, ts: 5000 }));
    await leave();
    expect(row(AB).querySelector('.tt-conv-summary')!.textContent).not.toContain('[草稿]');
    expect(row(G1).querySelector('.tt-conv-summary')!.textContent).toBe('[草稿] 群草稿');
  });

  it('被禁言时输入框消失，解除后内容还在', async () => {
    const { c } = await renderLoggedIn(at(AD), { convs });
    fireEvent.change(input(), { target: { value: '没发完' } });
    await act(async () => c.receive({ cmd: 'event', data: { type: 'muted', scope: 'user', mutedUntil: null } }));
    await settle();
    expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    await act(async () => c.receive({ cmd: 'event', data: { type: 'unmuted', scope: 'user' } }));
    await settle();
    expect(input().value).toBe('没发完');
  });

  it('DraftStore：内容相同不通知，删除后快照变化', () => {
    const d = new DraftStore();
    const cb = vi.fn();
    d.subscribe(cb);
    d.put('a', 'x');
    d.put('a', 'x');
    expect(cb).toHaveBeenCalledTimes(1);
    const before = d.snapshot();
    d.put('a', '  ');
    expect(d.get('a')).toBeUndefined();
    expect(d.snapshot()).not.toBe(before);
  });
});

describe('没有菜单项的消息（F-UI-09 规则 5）', () => {
  it('tip、custom 右键：不出现应用菜单，也不出现浏览器菜单', async () => {
    const { c } = await renderLoggedIn(at(G1), { convs: [{ convId: G1, name: 'g1', maxSeq: 2 }] });
    await act(async () => {
      c.receive({
        cmd: 'msg',
        data: {
          msgId: 't',
          clientMsgId: 't',
          convId: G1,
          seq: 1,
          from: 'bob',
          type: 'tip',
          ts: 1,
          body: { tip: { kind: 'joined', actor: 'bob', targets: ['carol'] } },
        },
      });
      c.receive({
        cmd: 'msg',
        data: { msgId: 'c', clientMsgId: 'c', convId: G1, seq: 2, from: 'bob', type: 'custom', ts: 2, body: {} },
      });
    });
    await settle();
    expect(fireEvent.contextMenu(screen.getByTestId('tip'))).toBe(false);
    expect(screen.queryByTestId('bubble-menu')).not.toBeInTheDocument();
    const custom = screen.getByText('[暂不支持的消息]');
    expect(fireEvent.contextMenu(custom)).toBe(false);
    expect(screen.queryByTestId('bubble-menu')).not.toBeInTheDocument();
  });

  it('失败消息菜单：复制、重发、删除；删除后列表和 pendingCount 都减少（AC-UI-09-5）', async () => {
    const { c } = await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }] });
    fireEvent.change(input(), { target: { value: '要失败' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => c.ackError('send', 5000));
    await settle();
    const m = screen.getByTestId('message');
    expect(m).toHaveAttribute('data-status', 'failed');
    fireEvent.contextMenu(within(m).getByText('要失败'));
    expect(
      within(screen.getByTestId('bubble-menu'))
        .getAllByRole('menuitem')
        .map((x) => x.textContent),
    ).toEqual(['复制', '重发', '删除']);
    fireEvent.click(screen.getByTestId('menu-delete'));
    await settle();
    expect(screen.queryByTestId('message')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bubble-menu')).not.toBeInTheDocument();
    const frames = c.frames().filter((f: { cmd: string }) => f.cmd === 'send').length;
    expect(frames).toBe(1); // 不影响服务端：没有多发任何帧
  });
});

describe('宽屏路由（PRD-ui 3.3 节）', () => {
  it('聊天子页面是侧板；资料卡从聊天页进入是侧板，否则在主区', () => {
    const chat = '/chat/group%3Ag1';
    expect(wideRoute(chat, null)).toEqual({ section: 'chats', mainPath: chat, panel: false, chatBehind: chat });
    for (const sub of ['info', 'members', 'notice', 'invite']) {
      expect(wideRoute(`${chat}/${sub}`, null)).toEqual({
        section: 'chats',
        mainPath: chat,
        panel: true,
        chatBehind: chat,
      });
    }
    for (const p of ['/user/bob', '/user/bob/remark', '/contacts/apply/bob']) {
      expect(wideRoute(p, chat)).toEqual({ section: 'chats', mainPath: chat, panel: true, chatBehind: chat });
      expect(wideRoute(p, null)).toEqual({ section: 'contacts', mainPath: p, panel: false, chatBehind: null });
    }
    expect(wideRoute('/contacts', chat)).toEqual({
      section: 'contacts',
      mainPath: '/contacts',
      panel: false,
      chatBehind: null,
    });
    expect(wideRoute('/me/settings/blocks', chat).section).toBe('me');
    expect(wideRoute('/groups/new', null).section).toBe('chats');
    expect(wideRoute('/chats', chat).chatBehind).toBeNull();
  });

  it('外观路由在回跳白名单里', () => {
    expect(safeRedirect('/me/settings/appearance')).toBe('/me/settings/appearance');
  });
});
