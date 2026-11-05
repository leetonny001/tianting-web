import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareNames, groupByPinyin, pinyinGroup } from '../lib/pinyin';
import { renderLoggedIn, serverConv, settle } from '../test/harness';

const NOW = Date.now();
const profile = (nickname: string, official = false) => ({ nickname, avatar: '', official });

function friend(userId: string, extra: Record<string, unknown> = {}) {
  return { userId, remark: '', source: 'other', createdAt: NOW, ver: 1, profile: profile(userId), ...extra };
}

function req(userId: string, direction: 'in' | 'out', extra: Record<string, unknown> = {}) {
  return {
    userId,
    direction,
    status: 'pending',
    message: '',
    source: 'other',
    applyCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    expireAt: NOW + 7 * 86_400_000,
    ver: 2,
    profile: direction === 'in' ? profile(userId) : null,
    ...extra,
  };
}

function block(userId: string, extra: Record<string, unknown> = {}) {
  return { userId, createdAt: NOW, ver: 3, profile: null, ...extra };
}

function page(p: Record<string, unknown> = {}) {
  return {
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
  };
}

/** 登录、回第一轮同步。 */
async function open(
  path: string,
  sync: Record<string, unknown> = {},
  convs: Parameters<typeof renderLoggedIn>[1] = {},
) {
  const r = await renderLoggedIn(path, convs);
  // 群聊天页进入时会多发一次 convs（刷新成员数）：全部回复，首次同步才能走到 socialSync。
  await act(async () => {
    for (const f of r.c.frames().filter((x) => x.cmd === 'convs')) {
      r.c.receive({ id: f.id, cmd: 'ack', data: { convs: (convs.convs ?? []).map(serverConv), truncated: false } });
    }
  });
  await settle();
  await act(async () => r.c.ack('socialSync', page(sync)));
  await settle();
  return r;
}

const sentCmds = (c: { frames(): Array<{ cmd: string }> }, cmd: string) =>
  c.frames().filter((f) => f.cmd === cmd).length;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('拼音分组（F-UI-13 规则 4，FE-210）', () => {
  const spec = JSON.parse(readFileSync('node_modules/@tianting/sdk/protocol/vectors/pinyin-groups.json', 'utf8')) as {
    cases: Array<{ name: string; group: string }>;
  };

  it('protocol/vectors/pinyin-groups.json 全部用例（AC-UI-13-9）', () => {
    expect(spec.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of spec.cases) expect(pinyinGroup(c.name), c.name).toBe(c.group);
  });

  it('A～Z 分组、# 放最后；组内按显示名，相同按 id 字节序', () => {
    const items = [
      { id: 'z', n: '张三' },
      { id: 'b', n: 'bob' },
      { id: 'a2', n: 'alice' },
      { id: 'a1', n: 'alice' },
      { id: 'n', n: '123' },
      { id: 'e', n: '😀abc' },
    ];
    const out = groupByPinyin(
      items,
      (x) => x.n,
      (x) => x.id,
    );
    expect(out.map((g) => g.group)).toEqual(['A', 'B', 'Z', '#']);
    expect(out[0]!.items.map((x) => x.id)).toEqual(['a1', 'a2']);
  });

  it('运行环境不支持拼音排序：汉字归 #，组内按码点，不报错（AC-UI-13-10）', () => {
    const Real = Intl.Collator;
    vi.stubGlobal('Intl', {
      ...Intl,
      Collator: function () {
        const c = new Real('en');
        return { compare: c.compare, resolvedOptions: () => ({ ...c.resolvedOptions(), collation: 'default' }) };
      },
    });
    expect(pinyinGroup('张三')).toBe('#');
    expect(pinyinGroup('Alice')).toBe('A');
    expect(compareNames()('a', 'b')).toBe(-1);
  });
});

describe('通讯录（F-UI-13、F-UI-20）', () => {
  it('第一轮 socialSync 结束前显示骨架屏，不出现"还没有朋友"（AC-UI-20-2）；无好友时显示空状态（AC-UI-13-5）', async () => {
    const { c } = await renderLoggedIn('/contacts');
    expect(screen.getByTestId('contacts-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('还没有朋友')).not.toBeInTheDocument();
    await act(async () => c.ack('socialSync', page()));
    await settle();
    expect(screen.getByText('还没有朋友')).toBeInTheDocument();
    expect(screen.getByTestId('entry-requests')).toBeInTheDocument();
    expect(screen.getByTestId('entry-groups')).toBeInTheDocument();
  });

  it('分组、底部人数、备注优先、已拉黑标签；陌生人会话不进通讯录（AC-UI-13-1、13-2、13-7、13-8）', async () => {
    await open(
      '/contacts',
      {
        friends: [
          friend('bob', { remark: '阿博' }),
          friend('alice2'),
          friend('zhangsan', { profile: profile('张三') }),
          friend('n1', { profile: profile('123') }),
          friend('dave'),
        ],
        blocks: [block('dave')],
      },
      { convs: [{ convId: 'c2c:alice:carol', name: 'carol' }] },
    );
    expect(
      within(screen.getByTestId('group-A'))
        .getAllByTestId('friend-name')
        .map((e) => e.textContent),
    ).toEqual(['alice2', '阿博']);
    expect(within(screen.getByTestId('group-Z')).getByText('张三')).toBeInTheDocument();
    expect(within(screen.getByTestId('group-D')).getByText('已拉黑')).toBeInTheDocument();
    const letters = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(letters).toEqual(['A', 'D', 'Z', '#']);
    expect(screen.getByTestId('contacts-count')).toHaveTextContent('5 位朋友');
    expect(screen.queryByText('carol')).not.toBeInTheDocument();
  });

  it('"新的朋友"红点与标签角标（AC-UI-13-6）', async () => {
    await open('/contacts', { requests: [req('a', 'in'), req('b', 'in'), req('c', 'in')] });
    expect(screen.getByTestId('requests-badge')).toHaveTextContent('3');
    expect(screen.getByTestId('tab-contacts-badge')).toHaveTextContent('3');
  });
});

describe('新的朋友（F-UI-25）', () => {
  it('列表第二行与状态、进入即已读（AC-UI-25-1、25-4、25-5、25-6）', async () => {
    const { c } = await open('/contacts/requests', {
      untilVer: 9,
      latestVer: 9,
      requests: [
        req('carol', 'in', { message: '我是 carol', updatedAt: NOW - 100 }),
        req('dave', 'in', { updatedAt: NOW - 10 }),
        req('eve', 'out', { message: '你好', updatedAt: NOW - 200 }),
        req('late', 'in', { expireAt: NOW - 1, updatedAt: NOW - 300 }),
      ],
    });
    const rows = screen.getAllByTestId('request-row');
    expect(rows.map((r) => r.dataset.user)).toEqual(['dave', 'carol', 'eve', 'late']);
    expect(within(rows[0]!).getByTestId('request-line2')).toHaveTextContent('请求添加你为朋友');
    expect(within(rows[1]!).getByTestId('request-line2')).toHaveTextContent('我是 carol');
    expect(within(rows[2]!).getByTestId('request-line2')).toHaveTextContent('我：你好');
    expect(within(rows[2]!).getByText('等待验证')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('已过期')).toBeInTheDocument();
    expect(within(rows[3]!).queryByTestId('request-accept')).not.toBeInTheDocument();
    // 第一轮同步在进入页面之后才结束：拿到数据后 200ms 内标记已读（规则 5 的去抖）。
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    expect(c.last('friendRequestsSeen').data).toEqual({ ver: 9 });
  });

  it('同意：加载态 → 已添加；点行弹详情，拒绝不二次确认（AC-UI-25-2、25-3）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/contacts/requests', {
      requests: [req('carol', 'in', { updatedAt: NOW - 1 }), req('dave', 'in', { source: 'search', message: '球友' })],
    });
    const rows = screen.getAllByTestId('request-row');
    await user.click(within(rows[1]!).getByTestId('request-accept'));
    expect(c.last('friendRespond').data).toMatchObject({ from: 'carol', action: 'accept' });
    await act(async () =>
      c.ack('friendRespond', {
        ver: 6,
        changed: true,
        items: {
          friends: [friend('carol', { ver: 6 })],
          requests: [req('carol', 'in', { status: 'accepted', ver: 6, updatedAt: NOW - 1 })],
          blocks: [],
        },
      }),
    );
    await settle();
    const carol = screen.getAllByTestId('request-row').find((r) => r.dataset.user === 'carol')!;
    expect(within(carol).getByText('已添加')).toBeInTheDocument();

    const dave = screen.getAllByTestId('request-row').find((r) => r.dataset.user === 'dave')!;
    await user.click(within(dave).getByTestId('request-line2'));
    const sheet = screen.getByTestId('request-sheet');
    expect(within(sheet).getByTestId('request-source')).toHaveTextContent('通过搜索添加');
    expect(within(sheet).getByText('球友')).toBeInTheDocument();
    await user.click(within(sheet).getByText('拒绝'));
    expect(c.last('friendRespond').data).toMatchObject({ from: 'dave', action: 'reject' });
  });

  it('4045：提示"该申请已过期"并同步一轮（AC-UI-25-7）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/contacts/requests', { requests: [req('carol', 'in')] });
    const before = sentCmds(c, 'socialSync');
    await user.click(screen.getByTestId('request-accept'));
    await act(async () => c.ackError('friendRespond', 4045));
    await settle();
    expect(screen.getByText('该申请已过期')).toBeInTheDocument();
    expect(sentCmds(c, 'socialSync')).toBe(before + 1);
  });

  it('空状态（AC-UI-20-3）', async () => {
    await open('/contacts/requests');
    expect(screen.getByText('暂无新的朋友')).toBeInTheDocument();
  });
});

describe('添加朋友（F-UI-26）', () => {
  const search = async (text: string) => {
    const user = userEvent.setup();
    await user.type(screen.getByTestId('search-input'), `${text}{Enter}`);
    return user;
  };

  it('不合法不发请求；加载期间重复提交只发 1 次；null 显示"未找到该用户"（AC-UI-26-3、26-7）', async () => {
    const { c } = await open('/contacts/add');
    await search('a b');
    expect(screen.getByTestId('search-error')).toHaveTextContent('账号格式不正确');
    expect(sentCmds(c, 'userSearch')).toBe(0);
    const input = screen.getByTestId('search-input');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'nobody{Enter}{Enter}{Enter}');
    expect(sentCmds(c, 'userSearch')).toBe(1);
    await act(async () => c.ack('userSearch', { user: null }));
    await settle();
    expect(screen.getByTestId('search-result')).toHaveTextContent('未找到该用户');
  });

  it.each([
    ['self', '这是你自己', ['发消息', '添加到通讯录']],
    ['friend', '发消息', ['添加到通讯录']],
    ['pendingOut', '已发送申请', ['添加到通讯录']],
    ['blocked', '已加入黑名单', ['添加到通讯录']],
    ['none', '添加到通讯录', []],
  ])('relation=%s（AC-UI-26-1、26-4）', async (relation, shown, hidden) => {
    const { c } = await open('/contacts/add');
    await search('bob');
    await act(async () =>
      c.ack('userSearch', { user: { userId: 'bob', nickname: '阿博', avatar: '', official: false, relation } }),
    );
    await settle();
    const card = screen.getByTestId('search-card');
    expect(card).toHaveTextContent(shown);
    expect(card).toHaveTextContent('账号：bob');
    for (const h of hidden) expect(card).not.toHaveTextContent(h);
  });

  it('官方标识；4292 文案（AC-UI-26-5、26-6）', async () => {
    const { c } = await open('/contacts/add');
    await search('kefu');
    await act(async () =>
      c.ack('userSearch', { user: { userId: 'kefu', nickname: '客服', avatar: '', official: true, relation: 'none' } }),
    );
    await settle();
    expect(screen.getByTestId('official')).toHaveTextContent('官方');
    const input = screen.getByTestId('search-input');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'x{Enter}');
    await act(async () => c.ackError('userSearch', 4292));
    await settle();
    expect(screen.getByTestId('search-error')).toHaveTextContent('今天的次数已用完，明天再试');
  });
});

describe('申请添加朋友（F-UI-27）', () => {
  const ackUsers = async (c: Awaited<ReturnType<typeof open>>['c']) => {
    await settle();
    await act(async () => c.ack('users', { users: [] }));
    await settle();
  };

  it('默认附言与计数、超长禁用（AC-UI-27-1、27-3）', async () => {
    const { c } = await open('/contacts/apply/bob');
    await ackUsers(c);
    const msg = screen.getByTestId<HTMLTextAreaElement>('apply-message');
    expect(msg.value).toBe('我是alice');
    expect(screen.getByTestId('apply-count')).toHaveTextContent('7 / 50');
    const user = userEvent.setup();
    await user.clear(msg);
    await user.paste('字'.repeat(51));
    expect(screen.getByText('最多 50 个字')).toBeInTheDocument();
    expect(screen.getByTestId('apply-send')).toBeDisabled();
    await user.clear(msg);
    await user.click(screen.getByTestId('apply-remark'));
    await user.paste('字'.repeat(33));
    expect(screen.getByText('最多 32 个字')).toBeInTheDocument();
    expect(screen.getByTestId('apply-send')).toBeDisabled();
  });

  it('直接打开来源 other；防重复提交只发 1 次；pending → 已发送（AC-UI-27-6、27-7）', async () => {
    const { c } = await open('/contacts/apply/bob');
    await ackUsers(c);
    const user = userEvent.setup();
    const send = screen.getByTestId('apply-send');
    await user.click(send);
    await user.click(send);
    await user.click(send);
    expect(sentCmds(c, 'friendApply')).toBe(1);
    expect(c.last('friendApply').data).toMatchObject({ to: 'bob', source: 'other', message: '我是alice' });
    await act(async () =>
      c.ack('friendApply', {
        status: 'pending',
        ver: 6,
        changed: true,
        items: { friends: [], requests: [req('bob', 'out', { ver: 6 })], blocks: [] },
      }),
    );
    await settle();
    expect(screen.getByText('已发送')).toBeInTheDocument();
  });

  it('accepted → 已添加到通讯录，替换为资料卡（AC-UI-27-4）；4000 → 请先将对方移出黑名单', async () => {
    const { c } = await open('/contacts/apply/bob');
    await ackUsers(c);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('apply-send'));
    await act(async () => c.ackError('friendApply', 4000));
    await settle();
    expect(screen.getByText('请先将对方移出黑名单')).toBeInTheDocument();
    await user.click(screen.getByTestId('apply-send'));
    await act(async () =>
      c.ack('friendApply', {
        status: 'accepted',
        ver: 6,
        changed: true,
        items: { friends: [friend('bob', { ver: 6 })], requests: [], blocks: [] },
      }),
    );
    await settle();
    expect(screen.getByText('已添加到通讯录')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/user/bob');
    expect(screen.getByTestId('user-chat')).toBeInTheDocument();
  });

  it('打开自己：提示"不能添加自己"，不发请求（AC-UI-27-8）', async () => {
    const { c } = await open('/contacts/apply/alice');
    expect(screen.getByText('不能添加自己')).toBeInTheDocument();
    expect(sentCmds(c, 'friendApply')).toBe(0);
  });
});

describe('资料卡（F-UI-14）', () => {
  const ackUsers = async (c: Awaited<ReturnType<typeof open>>['c'], users: unknown[] = []) => {
    await settle();
    await act(async () => c.ack('users', { users }));
    await settle();
  };
  const actions = () => screen.getByTestId('user-actions').textContent;

  it('标题、昵称、账号；备注优先（AC-UI-14-3）', async () => {
    await open('/user/bob', { friends: [friend('bob', { remark: '老板', profile: profile('阿博') })] });
    const head = screen.getByTestId('user-head');
    expect(screen.getByTestId('user-name')).toHaveTextContent('老板');
    expect(head).toHaveTextContent('昵称：阿博');
    expect(head).toHaveTextContent('账号：bob');
  });

  it('自己：没有任何操作（AC-UI-14-2）', async () => {
    const { c } = await open('/user/alice');
    await ackUsers(c);
    expect(actions()).toBe('');
    expect(screen.queryByTestId('user-more')).not.toBeInTheDocument();
  });

  it('none：开放模式有"发消息"，好友制只有"添加到通讯录"（AC-UI-14-7）', async () => {
    const a = await open('/user/carol');
    await ackUsers(a.c);
    expect(actions()).toContain('添加到通讯录');
    expect(actions()).toContain('发消息');
    a.unmount();
    const b = await open('/user/carol', { mode: 'friends' });
    await ackUsers(b.c);
    expect(actions()).toContain('添加到通讯录');
    expect(actions()).not.toContain('发消息');
  });

  it('好友制发起单聊：非好友先提示，好友直接进入（AC-UI-05-6）', async () => {
    const startFor = async (id: string) => {
      fireEvent.click(screen.getByTestId('plus-button'));
      fireEvent.click(within(screen.getByTestId('plus-menu')).getByText('发起单聊'));
      await userEvent.type(screen.getByTestId('start-chat-input'), `${id}{Enter}`);
    };
    await open('/chats', { mode: 'friends', friends: [friend('bob')] });
    await startFor('carol');
    expect(screen.getByTestId('start-chat-warn')).toHaveTextContent('对方不是你的好友，可能无法发送消息');
    expect(window.location.pathname).toBe('/chats');
    // 改输入后回到普通状态。
    await userEvent.type(screen.getByTestId('start-chat-input'), 'x');
    expect(screen.queryByTestId('start-chat-warn')).not.toBeInTheDocument();
    expect(screen.getByTestId('start-chat-submit')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('start-chat-input'), '{Backspace}{Enter}');
    fireEvent.click(screen.getByTestId('start-chat-anyway'));
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:carol');
  });

  it('好友制发起单聊：好友和自己不提示；"添加朋友"去申请页（AC-UI-05-6）', async () => {
    const startFor = async (id: string) => {
      fireEvent.click(screen.getByTestId('plus-button'));
      fireEvent.click(within(screen.getByTestId('plus-menu')).getByText('发起单聊'));
      await userEvent.type(screen.getByTestId('start-chat-input'), `${id}{Enter}`);
    };
    const a = await open('/chats', { mode: 'friends', friends: [friend('bob')] });
    await startFor('bob');
    expect(screen.queryByTestId('start-chat-warn')).not.toBeInTheDocument();
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:bob');
    a.unmount();
    const b = await open('/chats', { mode: 'friends', friends: [friend('bob')] });
    await startFor('alice');
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:alice');
    b.unmount();
    await open('/chats', { mode: 'friends', friends: [friend('bob')] });
    await startFor('carol');
    fireEvent.click(screen.getByTestId('start-chat-apply'));
    expect(window.location.pathname).toBe('/contacts/apply/carol');
  });

  it('开放模式发起单聊不提示', async () => {
    await open('/chats');
    fireEvent.click(screen.getByTestId('plus-button'));
    fireEvent.click(within(screen.getByTestId('plus-menu')).getByText('发起单聊'));
    await userEvent.type(screen.getByTestId('start-chat-input'), 'carol{Enter}');
    expect(screen.queryByTestId('start-chat-warn')).not.toBeInTheDocument();
    expect(decodeURIComponent(window.location.pathname)).toBe('/chat/c2c:alice:carol');
  });

  it('好友制下 none 的官方账号可以发消息', async () => {
    const { c } = await open('/user/kefu', { mode: 'friends' });
    await ackUsers(c, [{ userId: 'kefu', nickname: '客服', avatar: '', official: true }]);
    expect(actions()).toContain('发消息');
    expect(screen.getByTestId('official')).toBeInTheDocument();
  });

  it('拉黑的非好友：没有"添加到通讯录"（AC-UI-14-8）', async () => {
    const { c } = await open('/user/eve', { blocks: [block('eve')] });
    await ackUsers(c);
    expect(screen.getByTestId('user-blocked')).toHaveTextContent('已加入黑名单');
    expect(actions()).not.toContain('添加到通讯录');
  });

  it('不可见与不存在的用户：DOM 结构相同，不显示"用户不存在"（AC-UI-14-10）', async () => {
    const shape = () =>
      // eslint-disable-next-line no-restricted-syntax -- 只读，用来比较 DOM 结构（防枚举用例）
      screen
        .getByTestId('user-head')
        .innerHTML.replaceAll(/frank|nobody/g, 'X')
        .replaceAll(/data-[a-z-]+="[^"]*"/g, '')
        .replace(/--tt-avatar-\d/, '')
        .replace(/>[FN]</, '>?<');
    const a = await open('/user/frank');
    await ackUsers(a.c);
    const first = shape();
    expect(document.body).not.toHaveTextContent('用户不存在');
    a.unmount();
    const b = await open('/user/nobody');
    await ackUsers(b.c);
    expect(shape()).toBe(first);
  });

  it('拉黑确认框正文；删除确认框按模式（AC-UI-14-4、14-6）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/user/bob', { mode: 'friends', friends: [friend('bob')] });
    await user.click(screen.getByTestId('user-more'));
    await user.click(screen.getByText('加入黑名单'));
    expect(screen.getByTestId('block-dialog')).toHaveTextContent(
      '加入黑名单后，你将不再收到对方的私聊消息和好友申请；在共同的群聊里仍能看到对方的发言',
    );
    await user.click(within(screen.getByTestId('block-dialog')).getByText('确定'));
    expect(c.last('block').data).toEqual({ userId: 'bob' });
    await act(async () =>
      c.ack('block', {
        ver: 6,
        changed: true,
        items: { friends: [], requests: [], blocks: [block('bob', { ver: 6 })] },
      }),
    );
    await settle();
    expect(screen.getByTestId('user-blocked')).toBeInTheDocument();
    await user.click(screen.getByTestId('user-more'));
    expect(screen.getByTestId('user-menu')).toHaveTextContent('移出黑名单');
    await user.click(screen.getByText('删除朋友'));
    expect(screen.getByTestId('delete-dialog')).toHaveTextContent('删除后你们将无法继续私聊');
  });

  it('开放模式删除确认框不含"无法继续私聊"；删除后停留，变为"添加到通讯录"（AC-UI-14-5、14-6）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/user/bob', { friends: [friend('bob')] });
    await user.click(screen.getByTestId('user-more'));
    await user.click(screen.getByText('删除朋友'));
    expect(screen.getByTestId('delete-dialog')).not.toHaveTextContent('无法继续私聊');
    await user.click(within(screen.getByTestId('delete-dialog')).getByText('删除'));
    await act(async () =>
      c.ack('friendDelete', {
        ver: 6,
        changed: true,
        items: { friends: [friend('bob', { ver: 6, deleted: true })], requests: [], blocks: [] },
      }),
    );
    await settle();
    expect(window.location.pathname).toBe('/user/bob');
    expect(screen.getByTestId('user-add')).toBeInTheDocument();
  });

  it('pendingIn："通过验证"后变为"发消息"（AC-UI-14-9）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/user/dave', { requests: [req('dave', 'in')] });
    await user.click(screen.getByText('通过验证'));
    await act(async () =>
      c.ack('friendRespond', {
        ver: 6,
        changed: true,
        items: {
          friends: [friend('dave', { ver: 6 })],
          requests: [req('dave', 'in', { status: 'accepted', ver: 6 })],
          blocks: [],
        },
      }),
    );
    await settle();
    expect(actions()).toContain('发消息');
    expect(actions()).not.toContain('通过验证');
  });
});

describe('备注、黑名单、隐私（F-UI-28～30）', () => {
  it('备注：超长禁用；未变化不发请求；空白清除（AC-UI-28-2、28-3、28-4）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/user/bob/remark', { friends: [friend('bob', { remark: '老板' })] });
    const input = screen.getByTestId<HTMLInputElement>('remark-input');
    expect(input.value).toBe('老板');
    await user.clear(input);
    await user.paste('字'.repeat(33));
    expect(screen.getByText('最多 32 个字')).toBeInTheDocument();
    expect(screen.getByTestId('remark-done')).toBeDisabled();
    await user.clear(input);
    await user.type(input, '  ');
    await user.click(screen.getByTestId('remark-done'));
    expect(c.last('friendRemark').data).toEqual({ userId: 'bob', remark: '' });
  });

  it('备注未变化直接返回（AC-UI-28-4）；4040 提示并返回（AC-UI-28-5）', async () => {
    const user = userEvent.setup();
    const a = await open('/user/bob/remark', { friends: [friend('bob', { remark: '老板' })] });
    await user.click(screen.getByTestId('remark-done'));
    expect(sentCmds(a.c, 'friendRemark')).toBe(0);
    expect(window.location.pathname).toBe('/user/bob');
    a.unmount();
    const b = await open('/user/bob/remark', { friends: [friend('bob')] });
    await user.type(screen.getByTestId('remark-input'), 'x');
    await user.click(screen.getByTestId('remark-done'));
    await act(async () => b.c.ackError('friendRemark', 4040));
    await settle();
    expect(screen.getByText('对方已不在你的通讯录中')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/user/bob');
  });

  it('非好友进入备注页回到资料卡', async () => {
    await open('/user/carol/remark');
    expect(window.location.pathname).toBe('/user/carol');
  });

  it('黑名单：倒序、profile=null 显示 userId、移出后提示（AC-UI-29-1、29-2、29-3）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/me/settings/blocks', {
      blocks: [block('bob', { createdAt: NOW - 10, profile: profile('阿博') }), block('frank', { createdAt: NOW })],
    });
    const rows = screen.getAllByTestId('block-row');
    expect(rows.map((r) => r.dataset.user)).toEqual(['frank', 'bob']);
    expect(rows[1]).toHaveTextContent('阿博');
    await user.click(within(rows[0]!).getByTestId('block-remove'));
    expect(c.last('unblock').data).toEqual({ userId: 'frank' });
    await act(async () =>
      c.ack('unblock', {
        ver: 6,
        changed: true,
        items: { friends: [], requests: [], blocks: [block('frank', { ver: 6, deleted: true })] },
      }),
    );
    await settle();
    expect(screen.getByText('已移出黑名单')).toBeInTheDocument();
    expect(screen.getAllByTestId('block-row')).toHaveLength(1);
  });

  it('设置页依次出现隐私、黑名单（带人数）、外观、关于、退出（AC-UI-16-6 的 M4 顺序、29-1）', async () => {
    await open('/me/settings', { blocks: [block('a'), block('b')] });
    expect(screen.getByTestId('settings-blocks')).toHaveTextContent('2');
    const text = document.body.textContent ?? '';
    expect(text.indexOf('隐私')).toBeLessThan(text.indexOf('黑名单'));
    expect(text.indexOf('黑名单')).toBeLessThan(text.indexOf('外观'));
    expect(text.indexOf('外观')).toBeLessThan(text.indexOf('关于'));
    expect(text.indexOf('关于')).toBeLessThan(text.indexOf('退出登录'));
  });

  it('隐私：请求期间禁用；失败回到原值并提示（AC-UI-30-2、30-3）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/me/settings/privacy');
    const sw = screen.getByTestId<HTMLInputElement>('privacy-switch');
    expect(sw.checked).toBe(true);
    await user.click(sw);
    expect(sw).toBeDisabled();
    expect(c.last('setPrivacy').data).toEqual({ searchable: false });
    await act(async () => c.ackError('setPrivacy', 4290));
    await settle();
    expect(sw.checked).toBe(true);
    expect(sw).not.toBeDisabled();
    expect(screen.getByText('操作太频繁，请稍后再试')).toBeInTheDocument();
  });
});

describe('群聊列表（F-UI-32）', () => {
  it('按群名排序、人数、总数（AC-UI-32-1）；空状态', async () => {
    const { c } = await open('/contacts/groups');
    await settle();
    expect(screen.getByTestId('groups-skeleton')).toBeInTheDocument();
    await act(async () =>
      c.ack('myGroups', {
        groups: [
          { groupId: 'g1', name: '周末球局', memberCount: 12, joinedAt: 1 },
          { groupId: 'g2', name: 'Alpha', memberCount: 3, joinedAt: 2 },
        ],
        nextCursor: '',
      }),
    );
    await settle();
    expect(screen.getByTestId('groups-count')).toHaveTextContent('2 个群聊');
    const rows = screen.getAllByTestId('group-row');
    expect(rows[0]).toHaveTextContent('Alpha');
    expect(rows[0]).toHaveTextContent('3 人');
    expect(rows[1]).toHaveTextContent('周末球局');
    expect(rows[1]).toHaveTextContent('12 人');
  });

  it('5000 → "加载失败，点击重试"，点击后重新请求（AC-UI-32-3）', async () => {
    const user = userEvent.setup();
    const { c } = await open('/contacts/groups');
    await settle();
    await act(async () => c.ackError('myGroups', 5000));
    await settle();
    await user.click(screen.getByTestId('groups-retry'));
    await act(async () => c.ack('myGroups', { groups: [], nextCursor: '' }));
    await settle();
    expect(screen.getByText('还没有加入群聊')).toBeInTheDocument();
  });
});

describe('私聊权限提示（F-UI-31）', () => {
  const C = 'c2c:alice:carol';
  const at = `/chat/${encodeURIComponent(C)}`;
  const send = async (text: string) => {
    const user = userEvent.setup();
    await user.type(screen.getByTestId('composer-input'), `${text}{Enter}`);
  };

  it('4035：提示条 + 申请链接，来源 conv；连续失败只保留最后一条（AC-UI-31-1、31-4）', async () => {
    const { c } = await open(at);
    for (const t of ['一', '二', '三']) {
      await send(t);
      await act(async () => c.ackError('send', 4035));
      await settle();
    }
    const tips = screen.getAllByTestId('permission-tip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('对方开启了好友验证，你还不是他的好友');
    const list = screen.getByTestId('message-list');
    const children = [...list.querySelectorAll('[data-testid="message"],[data-testid="permission-tip"]')];
    expect(children.at(-1)?.getAttribute('data-testid')).toBe('permission-tip');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('permission-apply'));
    expect(window.location.pathname).toBe('/contacts/apply/carol');
    await settle();
    await act(async () => c.ack('users', { users: [] }));
    await settle();
    await user.click(screen.getByTestId('apply-send'));
    expect(c.last('friendApply').data).toMatchObject({ to: 'carol', source: 'conv' });
  });

  it('4036 / 4137 提示条，没有轻提示；N 取 strangerMsgLimit（AC-UI-31-2、31-3）', async () => {
    const { c } = await open(at, { strangerMsgLimit: 3 });
    await send('一');
    await act(async () => c.ackError('send', 4036));
    await settle();
    expect(screen.getByTestId('permission-tip')).toHaveTextContent('消息已发出，但被对方拒收了');
    expect(screen.getAllByText('消息已发出，但被对方拒收了')).toHaveLength(1);
    await send('二');
    await act(async () => c.ackError('send', 4137));
    await settle();
    expect(screen.getAllByTestId('permission-tip').at(-1)).toHaveTextContent('对方回复之前，最多只能发送 3 条消息');
  });

  it('4292 只弹轻提示（AC-UI-31-5）', async () => {
    const { c } = await open(at);
    await send('一');
    await act(async () => c.ackError('send', 4292));
    await settle();
    expect(screen.getByText('今天发起新聊天的次数已用完，请稍后再试')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-tip')).not.toBeInTheDocument();
  });
});

describe('聊天页的资料入口与发送者昵称（AC-UI-14-1、14-11、AC-SOC-10-7、AC-UI-04-9）', () => {
  const G = 'group:g1';
  const msg = {
    msgId: 'm1',
    clientMsgId: 'c1',
    convId: G,
    seq: 1,
    from: 'carol',
    type: 'text',
    body: { text: '嗨' },
    ts: NOW,
  };

  it('群消息显示发送者昵称；点头像进资料卡，申请来源 group（AC-SOC-10-7、AC-UI-14-11）', async () => {
    const user = userEvent.setup();
    const { c } = await open(`/chat/${encodeURIComponent(G)}`, {}, { convs: [{ convId: G, name: 'g1', maxSeq: 0 }] });
    await act(async () => c.receive({ cmd: 'msg', data: msg }));
    await settle();
    expect(screen.getByText('carol')).toBeInTheDocument(); // 缓存未就绪先显示 userId
    expect(c.last('users').data).toMatchObject({ userIds: expect.arrayContaining(['carol']) });
    await act(async () =>
      c.ack('users', { users: [{ userId: 'carol', nickname: '小卡', avatar: '', official: false }] }),
    );
    await settle();
    expect(screen.getByText('小卡')).toBeInTheDocument();
    await user.click(screen.getByTestId('msg-avatar'));
    expect(window.location.pathname).toBe('/user/carol');
    await user.click(screen.getByTestId('user-add'));
    expect(window.location.pathname).toBe('/contacts/apply/carol');
    await user.click(screen.getByTestId('apply-send'));
    expect(c.last('friendApply').data).toMatchObject({ source: 'group', sourceRef: 'g1' });
  });

  it('会话列表：单聊备注优先；群摘要前缀按备注（AC-UI-04-9）', async () => {
    await open(
      '/chats',
      { friends: [friend('carol', { remark: '卡姐', profile: profile('小卡') }), friend('bob', { remark: '老板' })] },
      {
        convs: [
          { convId: 'c2c:alice:bob', name: 'bob' },
          { convId: G, name: 'g1', lastMsg: { msgId: 'm', from: 'carol', type: 'text', text: '嗨', ts: NOW } },
        ],
      },
    );
    const items = screen.getAllByTestId('conv-item');
    const text = items.map((i) => i.textContent).join('|');
    expect(text).toContain('老板');
    expect(text).toContain('卡姐: 嗨');
  });
});
