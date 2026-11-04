import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLoggedIn, serverConv, settle, type Conv } from '../test/harness';

// 群管理页面（PRD-ui F-UI-35～F-UI-40）。

const G = 'group:g1';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
const NOW = Date.now();

function friend(userId: string, extra: Record<string, unknown> = {}) {
  return {
    userId,
    remark: '',
    source: 'other',
    createdAt: NOW,
    ver: 1,
    profile: { nickname: userId, avatar: '', official: false },
    ...extra,
  };
}

const sync = (friends: unknown[] = []) => ({
  full: true,
  untilVer: 5,
  latestVer: 5,
  hasMore: false,
  cursor: '',
  friends,
  requests: [],
  blocks: [],
  requestSeenVer: 0,
  settings: { searchable: true },
  mode: 'open',
  strangerMsgLimit: 0,
  official: false,
});

function info(p: Record<string, unknown> = {}) {
  return {
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
  };
}

const member = (userId: string, role = 'member') => ({
  userId,
  role,
  joinedAt: 1,
  nickname: userId,
  avatar: '',
  official: false,
});

type R = Awaited<ReturnType<typeof renderLoggedIn>>;

/** 回复所有还没回复的 cmd 帧。 */
async function reply(r: R, cmd: string, data: unknown) {
  const seen = (replied.get(r.c) ?? new Set<unknown>()) as Set<unknown>;
  replied.set(r.c, seen);
  await act(async () => {
    for (const f of r.c.frames().filter((x) => x.cmd === cmd && !seen.has(x.id))) {
      seen.add(f.id);
      r.c.receive({ id: f.id, cmd: 'ack', data });
    }
  });
  await settle();
}
const replied = new WeakMap<object, Set<unknown>>();

async function replyError(r: R, cmd: string, code: number, extra: Record<string, unknown> = {}) {
  const f = r.c
    .frames()
    .filter((x) => x.cmd === cmd)
    .at(-1)!;
  await act(async () => r.c.receive({ id: f.id, cmd: 'ack', error: { code, msg: 'x', ...extra } }));
  await settle();
}

async function open(
  path: string,
  o: { friends?: unknown[]; convs?: Conv[]; info?: Record<string, unknown>; members?: unknown[] } = {},
): Promise<R> {
  const r = await renderLoggedIn(path, { convs: o.convs ?? [{ convId: G, name: '球局', memberCount: 3 }] });
  await act(async () => r.c.ack('socialSync', sync(o.friends ?? [])));
  await settle();
  await reply(r, 'groupInfo', info(o.info));
  await reply(r, 'groupMembers', {
    members: o.members ?? [member('owner1', 'owner'), member('alice')],
    nextCursor: '',
  });
  return r;
}

const count = (r: R, cmd: string) => r.c.frames().filter((f) => f.cmd === cmd).length;

afterEach(() => vi.restoreAllMocks());

describe('发起群聊（F-UI-35）', () => {
  const friends = [friend('bob'), friend('carol'), friend('Bo2'), friend('dave')];

  it('只选 1 人时"完成（1）"禁用；选 2 人可点（AC-UI-35-2）', async () => {
    await open('/groups/new', { friends });
    const check = (u: string) => within(screen.getByText(u).closest('label')!).getByRole('checkbox');
    fireEvent.click(check('bob'));
    expect(screen.getByTestId('pick-done')).toHaveTextContent('完成（1）');
    expect(screen.getByTestId('pick-done')).toBeDisabled();
    fireEvent.click(check('carol'));
    expect(screen.getByTestId('pick-done')).toBeEnabled();
    expect(screen.getByTestId('pick-strip').children).toHaveLength(2);
  });

  it('搜索不区分大小写，按显示名或 userId（AC-UI-35-3）', async () => {
    await open('/groups/new', { friends: [...friends, friend('u9', { remark: '老BO' })] });
    await userEvent.type(screen.getByTestId('pick-search'), 'BO');
    const shown = screen.getAllByTestId('pick-row').map((x) => x.dataset.user);
    expect(shown.sort()).toEqual(['Bo2', 'bob', 'u9']);
  });

  async function submit(r: R) {
    for (const u of ['bob', 'carol']) {
      fireEvent.click(within(screen.getByText(u).closest('label')!).getByRole('checkbox'));
    }
    fireEvent.click(screen.getByTestId('pick-done'));
    fireEvent.click(screen.getByTestId('group-create'));
    await settle();
    return r;
  }

  it('成功进入新群聊天页；不填群名时不带 name（AC-UI-35-1）', async () => {
    const r = await open('/groups/new', { friends });
    await submit(r);
    const f = r.c.last('groupCreate');
    expect(f.data).toMatchObject({ members: ['bob', 'carol'] });
    expect(f.data).not.toHaveProperty('name');
    await reply(r, 'groupCreate', {
      groupId: 'g1',
      conv: serverConv({ convId: G, name: 'alice、bob、carol', memberCount: 3 }),
    });
    expect(window.location.pathname).toBe(at(G).replace('group:', 'group%3A'));
    expect(screen.getByTestId('chat-title')).toHaveTextContent('alice、bob、carol（3）');
  });

  it('4035 带 userId：提示对方名字并标红，没有进入新群（AC-UI-35-4）', async () => {
    const r = await open('/groups/new', { friends });
    await submit(r);
    await replyError(r, 'groupCreate', 4035, { userId: 'carol' });
    expect(screen.getByTestId('toast')).toHaveTextContent('carol 不是你的好友，无法邀请');
    const row = screen.getAllByTestId('pick-row').find((x) => x.dataset.user === 'carol')!;
    expect(row).toHaveAttribute('data-error', 'true');
    expect(window.location.pathname).toBe('/groups/new');
  });

  it.each([
    [4030, {}, '当前不允许创建群聊'],
    [4135, { userId: 'bob' }, 'bob 加入的群聊已达上限'],
    [4135, { userId: 'alice' }, '你加入的群聊已达上限'],
    [4130, {}, '群成员已达上限'],
    [4292, {}, '今天的次数已用完，明天再试'],
  ])('错误 %i %o → %s（AC-UI-35-5）', async (code, extra, text) => {
    const r = await open('/groups/new', { friends });
    await submit(r);
    await replyError(r, 'groupCreate', code, extra);
    expect(screen.getByTestId('toast')).toHaveTextContent(text);
  });
});

describe('群设置按角色显示（F-UI-36）', () => {
  const ids = ['grid-invite', 'grid-kick', 'manage-admin', 'manage-transfer', 'group-dissolve', 'group-leave'];
  const visible = () => ids.filter((id) => screen.queryByTestId(id));
  const INFO = `${at(G)}/info`;

  it('普通成员（AC-UI-36-1）', async () => {
    await open(INFO);
    expect(visible()).toEqual(['grid-invite', 'group-leave']);
    expect(screen.getByTestId('group-name')).not.toHaveAttribute('data-editable');
    expect(screen.getByTestId('group-notice')).toBeInTheDocument();
  });

  it('管理员（AC-UI-36-2）', async () => {
    await open(INFO, { info: { myRole: 'admin' } });
    expect(visible()).toEqual(['grid-invite', 'grid-kick', 'group-leave']);
    expect(screen.getByTestId('group-name')).toHaveAttribute('data-editable', 'true');
  });

  it('自建群群主全部可见；托管群群主没有解散（AC-UI-36-3）', async () => {
    const r = await open(INFO, { info: { myRole: 'owner', owner: 'alice' } });
    expect(visible()).toEqual(ids);
    r.unmount();
    await open(INFO, { info: { myRole: 'owner', owner: 'alice', managed: true } });
    expect(visible()).toEqual(ids.filter((x) => x !== 'group-dissolve'));
  });

  it('托管群无群主：只有网格、只读名称、公告、退出；没有"+"（AC-UI-36-4）', async () => {
    await open(INFO, { info: { managed: true, owner: '' } });
    expect(visible()).toEqual(['group-leave']);
  });

  it('改名 4030 → 无权限，并重新查 groupInfo（AC-UI-36-8）', async () => {
    const r = await open(INFO, { info: { myRole: 'admin' } });
    fireEvent.click(screen.getByTestId('group-name'));
    fireEvent.change(screen.getByTestId('rename-input'), { target: { value: '新名' } });
    const before = count(r, 'groupInfo');
    fireEvent.click(screen.getByTestId('rename-save'));
    await settle();
    await replyError(r, 'groupUpdate', 4030);
    expect(screen.getByTestId('toast')).toHaveTextContent('无权限');
    expect(count(r, 'groupInfo')).toBe(before + 1);
  });

  it('群名 51 个码点不能保存', async () => {
    await open(INFO, { info: { myRole: 'owner', owner: 'alice' } });
    fireEvent.click(screen.getByTestId('group-name'));
    fireEvent.change(screen.getByTestId('rename-input'), { target: { value: '名'.repeat(51) } });
    expect(screen.getByTestId('rename-save')).toBeDisabled();
  });

  it('退出确认框文案区分自建群群主（AC-UI-36-6）；成功回到会话列表，群消失', async () => {
    const r = await open(INFO, { info: { myRole: 'owner', owner: 'alice' } });
    fireEvent.click(screen.getByTestId('group-leave'));
    expect(screen.getByTestId('leave-confirm')).toHaveTextContent('你是群主，退出后群主将自动转让给其他成员');
    fireEvent.click(within(screen.getByTestId('leave-confirm')).getByText('退出'));
    await settle();
    await reply(r, 'groupLeave', {});
    expect(window.location.pathname).toBe('/chats');
    expect(screen.queryByText('球局')).not.toBeInTheDocument();
  });

  it('普通成员退出的确认框文案；解散确认框', async () => {
    const r = await open(INFO);
    fireEvent.click(screen.getByTestId('group-leave'));
    expect(screen.getByTestId('leave-confirm')).toHaveTextContent('退出后，将不再接收此群聊消息');
    r.unmount();
    const o = await open(INFO, { info: { myRole: 'owner', owner: 'alice' } });
    fireEvent.click(screen.getByTestId('group-dissolve'));
    expect(screen.getByTestId('dissolve-confirm')).toHaveTextContent('解散后，所有成员将被移出群聊，且不能恢复');
    fireEvent.click(within(screen.getByTestId('dissolve-confirm')).getByText('解散'));
    await settle();
    await reply(o, 'groupDissolve', {});
    expect(window.location.pathname).toBe('/chats');
  });

  it('收到 groupChanged：页面用 SDK 查到的资料更新，只查一次（F-UI-36 规则 1）', async () => {
    const r = await open(INFO);
    const before = count(r, 'groupInfo');
    await act(async () => r.c.receive({ cmd: 'event', data: { type: 'groupChanged', groupId: 'g1' } }));
    await reply(r, 'groupInfo', info({ myRole: 'admin', memberCount: 9 }));
    expect(count(r, 'groupInfo')).toBe(before + 1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('聊天信息（9）');
    expect(screen.getByTestId('grid-kick')).toBeInTheDocument();
  });

  it('本人在其他端退群：页面变为"你已退出该群聊"（F-UI-33 规则 4）', async () => {
    const r = await open(INFO);
    await act(async () => r.c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'left' } }));
    await settle();
    expect(screen.getByTestId('info-removed')).toHaveTextContent('你已退出该群聊');
    expect(screen.queryByTestId('group-leave')).not.toBeInTheDocument();
  });
});

describe('群公告（F-UI-37）', () => {
  const PATH = `${at(G)}/notice`;

  it('普通成员没有"编辑"（AC-UI-37-2）；没有公告时显示"暂无群公告"', async () => {
    await open(PATH);
    expect(screen.queryByTestId('notice-edit')).not.toBeInTheDocument();
    expect(screen.getByTestId('notice-readonly')).toHaveTextContent('仅群主和管理员可编辑');
    expect(screen.getByTestId('notice-empty')).toHaveTextContent('暂无群公告');
  });

  it('1001 码点：计数标红、"完成"禁用（AC-UI-37-3）；1000 可以提交', async () => {
    const r = await open(PATH, { info: { myRole: 'owner', owner: 'alice' } });
    fireEvent.click(screen.getByTestId('notice-edit'));
    fireEvent.change(screen.getByTestId('notice-input'), { target: { value: '公'.repeat(1001) } });
    expect(screen.getByTestId('notice-count')).toHaveTextContent('已输入 1001 / 1000');
    expect(screen.getByTestId('notice-count')).toHaveClass('tt-counter-over');
    expect(screen.getByTestId('notice-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('notice-input'), { target: { value: '公'.repeat(1000) } });
    fireEvent.click(screen.getByTestId('notice-save'));
    await settle();
    expect(r.c.last('groupUpdate').data).toMatchObject({ groupId: 'g1', notice: '公'.repeat(1000) });
  });

  it('清空表示清除公告', async () => {
    const r = await open(PATH, { info: { myRole: 'admin', notice: '旧的' } });
    fireEvent.click(screen.getByTestId('notice-edit'));
    fireEvent.change(screen.getByTestId('notice-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('notice-save'));
    await settle();
    expect(r.c.last('groupUpdate').data).toMatchObject({ notice: '' });
  });

  it('<b>x</b> 原样显示为文本（AC-UI-37-4）；显示发布者', async () => {
    const { container } = await open(PATH, {
      info: { notice: '<b>x</b>\n第二行', noticeBy: 'owner1', noticeAt: NOW },
    });
    expect(screen.getByTestId('notice-text').textContent).toBe('<b>x</b>\n第二行');
    expect(container.querySelector('.tt-notice b')).toBeNull();
    expect(screen.getByTestId('notice-meta')).toHaveTextContent('owner1');
  });
});

describe('群成员列表（F-UI-38）', () => {
  const PATH = `${at(G)}/members`;
  const list = [
    member('owner1', 'owner'),
    member('adm', 'admin'),
    member('alice', 'admin'),
    member('bob'),
    member('carol'),
  ];
  const row = (u: string) => screen.getAllByTestId('member-row').find((x) => x.dataset.user === u)!;

  it('角色标签、服务端顺序；没有搜索框（AC-UI-38-7）', async () => {
    await open(PATH, { members: list });
    expect(screen.getAllByTestId('member-row').map((x) => x.dataset.user)).toEqual(list.map((m) => m.userId));
    expect(screen.getAllByTestId('member-role').map((x) => x.textContent)).toEqual(['群主', '管理员', '管理员']);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('翻页：下一页带游标，同一个人只显示一次', async () => {
    const r = await renderLoggedIn(PATH, { convs: [{ convId: G, name: 'g', memberCount: 3 }] });
    await act(async () => r.c.ack('socialSync', sync()));
    await settle();
    await reply(r, 'groupInfo', info());
    await reply(r, 'groupMembers', { members: [member('a'), member('b')], nextCursor: 'c1' });
    await settle();
    expect(r.c.last('groupMembers').data).toMatchObject({ cursor: 'c1' });
    await reply(r, 'groupMembers', { members: [member('b'), member('c')], nextCursor: '' });
    expect(screen.getAllByTestId('member-row').map((x) => x.dataset.user)).toEqual(['a', 'b', 'c']);
  });

  it('管理员的移出模式：群主和其他管理员不可选（AC-UI-38-3）', async () => {
    await open(`${PATH}?mode=kick`, { info: { myRole: 'admin' }, members: list });
    expect(row('owner1')).toBeDisabled();
    expect(row('adm')).toBeDisabled();
    expect(row('alice')).toBeDisabled();
    expect(row('bob')).toBeEnabled();
  });

  it('群主移出：确认后发 groupKick，回到查看模式', async () => {
    const owner = [member('alice', 'owner'), member('adm', 'admin'), member('bob'), member('carol')];
    const r = await open(`${PATH}?mode=kick`, { info: { myRole: 'owner', owner: 'alice' }, members: owner });
    expect(row('alice')).toBeDisabled();
    expect(row('adm')).toBeEnabled();
    expect(screen.getByTestId('kick-submit')).toBeDisabled();
    fireEvent.click(row('bob'));
    fireEvent.click(row('carol'));
    fireEvent.click(screen.getByTestId('kick-submit'));
    expect(screen.getByTestId('kick-confirm')).toHaveTextContent('确定将 2 人移出群聊？');
    fireEvent.click(within(screen.getByTestId('kick-confirm')).getByText('移出'));
    await settle();
    expect(r.c.last('groupKick').data).toEqual({ groupId: 'g1', members: ['bob', 'carol'] });
    await reply(r, 'groupKick', { removed: ['bob', 'carol'] });
    await reply(r, 'groupInfo', info({ myRole: 'owner', owner: 'alice', memberCount: 2 }));
    await reply(r, 'groupMembers', { members: [member('alice', 'owner'), member('adm', 'admin')], nextCursor: '' });
    expect(window.location.search).toBe('');
    expect(screen.getAllByTestId('member-row').map((x) => x.dataset.user)).toEqual(['alice', 'adm']);
  });

  it('单次最多移出 50 人', async () => {
    const many = [member('alice', 'owner'), ...Array.from({ length: 51 }, (_, i) => member(`m${i}`))];
    await open(`${PATH}?mode=kick`, { info: { myRole: 'owner', owner: 'alice' }, members: many });
    for (let i = 0; i < 51; i++) fireEvent.click(row(`m${i}`));
    expect(screen.getByTestId('kick-submit')).toHaveTextContent('移出（50）');
    expect(screen.getByTestId('toast')).toHaveTextContent('一次最多移出 50 人');
  });

  it('普通成员手动打开 ?mode=transfer：按查看模式显示', async () => {
    await open(`${PATH}?mode=transfer`, { members: list });
    expect(row('bob').tagName).toBe('A');
  });

  it('设置管理员 4136 → "管理员最多 10 人"（AC-UI-38-6）；4046 提示并刷新', async () => {
    const owner = [member('alice', 'owner'), member('bob'), member('adm', 'admin')];
    const r = await open(`${PATH}?mode=admin`, { info: { myRole: 'owner', owner: 'alice' }, members: owner });
    fireEvent.click(row('bob'));
    await settle();
    expect(r.c.last('groupSetAdmin').data).toEqual({ groupId: 'g1', userId: 'bob', admin: true });
    await replyError(r, 'groupSetAdmin', 4136);
    expect(screen.getByTestId('toast')).toHaveTextContent('管理员最多 10 人');

    fireEvent.click(row('adm'));
    await settle();
    expect(r.c.last('groupSetAdmin').data).toEqual({ groupId: 'g1', userId: 'adm', admin: false });
    const before = count(r, 'groupMembers');
    await replyError(r, 'groupSetAdmin', 4046);
    expect(screen.getByTestId('toast')).toHaveTextContent('对方已不在群里');
    expect(count(r, 'groupMembers')).toBe(before + 1);
  });

  it('转让群主：确认框文案；发 groupTransfer', async () => {
    const owner = [member('alice', 'owner'), member('dave')];
    const r = await open(`${PATH}?mode=transfer`, { info: { myRole: 'owner', owner: 'alice' }, members: owner });
    fireEvent.click(row('dave'));
    expect(screen.getByTestId('transfer-confirm')).toHaveTextContent('确定将群主转让给 dave？转让后你将成为普通成员');
    fireEvent.click(within(screen.getByTestId('transfer-confirm')).getByText('转让'));
    await settle();
    expect(r.c.last('groupTransfer').data).toEqual({ groupId: 'g1', to: 'dave' });
  });
});

describe('邀请成员（F-UI-39）', () => {
  const PATH = `${at(G)}/invite`;
  const check = (u: string) =>
    within(screen.getAllByTestId('pick-row').find((x) => x.dataset.user === u)!).getByRole('checkbox');

  it('已加载的群成员显示"已在群里"，不能勾选（AC-UI-39-3）', async () => {
    await open(PATH, { friends: [friend('bob'), friend('eve')], members: [member('alice'), member('bob')] });
    expect(check('bob')).toBeDisabled();
    expect(screen.getByText('已在群里')).toBeInTheDocument();
    expect(check('eve')).toBeEnabled();
  });

  it('第 51 人提示且不被勾选（AC-UI-39-4）', async () => {
    const friends = Array.from({ length: 51 }, (_, i) => friend(`f${String(i).padStart(2, '0')}`));
    await open(PATH, { friends });
    for (const f of friends) fireEvent.click(check(f.userId));
    expect(screen.getByTestId('pick-done')).toHaveTextContent('完成（50）');
    expect(screen.getByTestId('toast')).toHaveTextContent('一次最多邀请 50 人');
    expect(check('f50')).not.toBeChecked();
  });

  it('部分成功：提示人数和失败原因，回到群设置（AC-UI-39-2）', async () => {
    const r = await open(PATH, { friends: [friend('bob'), friend('eve')] });
    fireEvent.click(check('bob'));
    fireEvent.click(check('eve'));
    fireEvent.click(screen.getByTestId('pick-done'));
    await settle();
    await reply(r, 'groupInvite', { added: ['bob'], failed: [{ userId: 'eve', code: 4035 }] });
    expect(screen.getByTestId('toast')).toHaveTextContent('已邀请 1 人；eve 不是你的好友，无法邀请');
    expect(window.location.pathname).toMatch(/\/info$/);
  });

  it('全部失败停留在本页并标红；超过 3 条合并', async () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const r = await open(PATH, { friends: names.map((n) => friend(n)) });
    for (const n of names) fireEvent.click(check(n));
    fireEvent.click(screen.getByTestId('pick-done'));
    await settle();
    await reply(r, 'groupInvite', { added: [], failed: names.map((userId) => ({ userId, code: 4135 })) });
    expect(screen.getByTestId('toast')).toHaveTextContent(
      'a1 加入的群聊已达上限；a2 加入的群聊已达上限；a3 加入的群聊已达上限；另有 2 人邀请失败',
    );
    expect(window.location.pathname).toMatch(/\/invite$/);
    expect(screen.getAllByTestId('pick-row')[0]).toHaveAttribute('data-error', 'true');
  });

  it('4130 → 群成员已达上限（规则 4）', async () => {
    const r = await open(PATH, { friends: [friend('bob')] });
    fireEvent.click(check('bob'));
    fireEvent.click(screen.getByTestId('pick-done'));
    await settle();
    await replyError(r, 'groupInvite', 4130);
    expect(screen.getByTestId('toast')).toHaveTextContent('群成员已达上限');
  });
});

describe('群提示消息（F-UI-40）', () => {
  const tipMsg = (seq: number, tip: Record<string, unknown>, from = 'bob') => ({
    msgId: `m${seq}`,
    clientMsgId: `tip-${seq}`,
    convId: G,
    seq,
    from,
    type: 'tip',
    body: { tip: { actor: '', targets: [], text: '', ...tip } },
    ts: NOW,
  });

  async function chat(tip: Record<string, unknown>, friends: unknown[] = [], from = 'bob') {
    const r = await renderLoggedIn(at(G), { convs: [{ convId: G, name: '球局', memberCount: 3 }] });
    await act(async () => r.c.ack('socialSync', sync(friends)));
    await settle();
    await act(async () => r.c.receive({ cmd: 'msg', data: tipMsg(1, tip, from) }));
    await settle();
    return r;
  }

  it('joined：没有头像和气泡；用本机备注（AC-UI-40-1）', async () => {
    await chat({ kind: 'joined', actor: 'bob', targets: ['carol', 'dave'] }, [friend('carol', { remark: '卡姐' })]);
    expect(screen.getByTestId('tip')).toHaveTextContent('bob 邀请 卡姐、dave 加入了群聊');
    expect(screen.queryByTestId('message')).not.toBeInTheDocument();
  });

  it('ownerChanged 无 actor 无 targets；自己 created 显示"你"（AC-UI-40-2）', async () => {
    const r = await chat({ kind: 'ownerChanged' }, [], '');
    expect(screen.getByTestId('tip')).toHaveTextContent('群主已退出群聊');
    r.unmount();
    await chat({ kind: 'created', actor: 'alice', targets: ['bob'] }, [], 'alice');
    expect(screen.getByTestId('tip')).toHaveTextContent('你创建了群聊');
  });

  it('count 大于 targets：前 3 个加"等 N 人"（AC-UI-40-3）', async () => {
    const targets = Array.from({ length: 20 }, (_, i) => `u${i}`);
    await chat({ kind: 'joined', actor: 'bob', targets, count: 35 });
    expect(screen.getByTestId('tip')).toHaveTextContent('bob 邀请 u0、u1、u2 等 35 人 加入了群聊');
  });

  it('不认识的 kind 显示"[群通知]"，没有 console.error（AC-UI-40-4）', async () => {
    const spy = vi.spyOn(console, 'error');
    await chat({ kind: 'futureKind' });
    expect(screen.getByTestId('tip')).toHaveTextContent('[群通知]');
    expect(spy).not.toHaveBeenCalled();
  });

  it('长按 600ms 不出现菜单（AC-UI-40-5）', async () => {
    await chat({ kind: 'created', actor: 'bob', targets: [] });
    const tip = screen.getByTestId('tip');
    fireEvent.pointerDown(tip, { clientX: 1, clientY: 1 });
    await act(async () => new Promise((res) => setTimeout(res, 650)));
    fireEvent.pointerUp(tip);
    fireEvent.contextMenu(tip);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('noticeUpdated 点击打开群公告页（规则 2）', async () => {
    await chat({ kind: 'noticeUpdated', actor: 'bob' });
    expect(screen.getByTestId('tip')).toHaveAttribute('href', expect.stringMatching(/\/notice$/));
  });

  it('会话列表摘要等于 lastMsg.text，没有发送者前缀（AC-UI-40-6）', async () => {
    await renderLoggedIn('/chats', {
      convs: [
        {
          convId: G,
          name: '球局',
          lastMsg: { msgId: 'm', from: 'bob', type: 'tip', text: 'bob 邀请 dave 加入了群聊', ts: NOW },
        },
      ],
    });
    expect(screen.getByText('bob 邀请 dave 加入了群聊').textContent).toBe('bob 邀请 dave 加入了群聊');
  });

  it('本人退群的聊天页：提示和禁用条（F-UI-33 规则 4）', async () => {
    const r = await renderLoggedIn(at(G), { convs: [{ convId: G, name: '球局', memberCount: 3 }] });
    await act(async () => r.c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'left' } }));
    await settle();
    expect(screen.getAllByText('你已退出该群聊').length).toBeGreaterThanOrEqual(2);
  });
});

describe('群子页面的路由', () => {
  it('单聊 convId 打开群子页面回到会话列表', async () => {
    await renderLoggedIn(`${at('c2c:alice:bob')}/members`);
    expect(window.location.pathname).toBe('/chats');
  });

  it('4033：成员页回到聊天页', async () => {
    const r = await renderLoggedIn(`${at(G)}/members`, { convs: [{ convId: G }] });
    await replyError(r, 'groupInfo', 4033);
    expect(window.location.pathname).not.toMatch(/\/members$/);
  });
});
