import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { admin, loginAs, uid } from './helpers';

// 群管理对真实服务端（PRD-ui F-UI-35～F-UI-40）。好友关系走真实的申请流程。

async function users(...ids: string[]) {
  await admin('POST', '/admin/users/import', { users: ids.map((userId) => ({ userId, nickname: userId })) });
}

async function befriend(a: Page, b: Page, bId: string) {
  await a.goto('/contacts/add');
  await a.getByTestId('search-input').fill(bId);
  await a.getByTestId('search-input').press('Enter');
  await a.getByTestId('search-add').click();
  await a.getByTestId('apply-send').click();
  await expect(a.getByTestId('toast')).toHaveText('已发送');
  await b.goto('/contacts/requests');
  await b.getByTestId('request-row').first().getByTestId('request-accept').click();
  await expect(b.getByTestId('request-row').first()).toContainText('已添加');
}

function row(page: Page, u: string) {
  return page.locator(`[data-testid="pick-row"][data-user="${u}"]`);
}

async function createGroup(page: Page, members: string[], name?: string) {
  await page.goto('/chats');
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-new-group').click();
  await expect(page).toHaveURL(/\/groups\/new$/);
  for (const m of members) await row(page, m).getByRole('checkbox').check();
  await page.getByTestId('pick-done').click();
  if (name) await page.getByTestId('group-name-input').fill(name);
  await page.getByTestId('group-create').click();
  await expect(page).toHaveURL(/\/chat\/group/);
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2]!);
}

/** 三个互为好友的人（owner 和其他人）+ owner 建好的群。 */
async function setup(browser: Browser, ...rest: string[]) {
  const ownerId = uid('own');
  const ids = rest.map(uid);
  await users(ownerId, ...ids);
  const owner = await loginAs(browser, ownerId);
  const pages: Page[] = [];
  for (const id of ids) {
    const p = await loginAs(browser, id);
    await befriend(owner, p, id);
    pages.push(p);
  }
  return { owner, ownerId, ids, pages };
}

test('建群 → 提示消息 → 改名、公告多端可见（AC-UI-35-1、36-5、37-1、40-2）', async ({ browser }) => {
  const { owner, ids, pages } = await setup(browser, 'b', 'c');
  const convId = await createGroup(owner, ids);
  await expect(owner.getByTestId('chat-title')).toContainText('（3）');
  await expect(owner.getByTestId('tip').first()).toHaveText('你创建了群聊');

  const bob = pages[0]!;
  await bob.goto(`/chat/${encodeURIComponent(convId)}`);
  await expect(bob.getByTestId('chat-title')).toContainText('（3）');

  await owner.getByTestId('chat-more').click();
  await owner.getByTestId('group-name').click();
  await owner.getByTestId('rename-input').fill('周六球局');
  await owner.getByTestId('rename-save').click();
  await expect(bob.getByTestId('chat-title')).toContainText('周六球局', { timeout: 3_000 });
  await expect(bob.getByTestId('tip').last()).toContainText('修改群名为"周六球局"');

  await owner.getByTestId('group-notice').click();
  await owner.getByTestId('notice-edit').click();
  await owner.getByTestId('notice-input').fill('周六 9 点集合');
  await owner.getByTestId('notice-save').click();
  await expect(owner.getByTestId('notice-text')).toHaveText('周六 9 点集合');
  await expect(bob.getByTestId('tip').last()).toContainText('更新了群公告');
  await bob.getByTestId('tip').last().click();
  await expect(bob.getByTestId('notice-text')).toHaveText('周六 9 点集合');
  await expect(bob.getByTestId('notice-readonly')).toBeVisible();
});

test('邀请、设管理员、移出、转让（AC-UI-39-1、38-2、38-4、38-5）', async ({ browser }) => {
  const { owner, ownerId, ids, pages } = await setup(browser, 'b', 'c', 'd');
  const [b, c, d] = ids as [string, string, string];
  const dave = pages[2]!;
  const bob = pages[0]!;
  const convId = await createGroup(owner, [b, c]);
  const base = `/chat/${encodeURIComponent(convId)}`;

  await owner.goto(`${base}/invite`);
  await expect(row(owner, b)).toContainText('已在群里');
  await row(owner, d).getByRole('checkbox').check();
  await owner.getByTestId('pick-done').click();
  await expect(owner.getByTestId('toast')).toHaveText('已邀请 1 人');
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText('聊天信息（4）');
  await owner.goto(base);
  await expect(owner.getByTestId('tip').last()).toHaveText(`你邀请 ${d} 加入了群聊`);

  // 设管理员：dave 的群设置出现"−"（groupChanged 实时刷新）。
  await dave.goto(`${base}/info`);
  await expect(dave.getByTestId('grid-kick')).toHaveCount(0);
  await owner.goto(`${base}/members?mode=admin`);
  await owner.locator(`[data-testid="member-row"][data-user="${d}"]`).click();
  await expect(owner.locator(`[data-testid="member-row"][data-user="${d}"]`)).toContainText('管理员');
  await expect(dave.getByTestId('grid-kick')).toBeVisible({ timeout: 3_000 });

  // 移出 bob：人数减 1，bob 的聊天页不能发送。
  await bob.goto(base);
  await expect(bob.getByTestId('chat-title')).toContainText('（4）');
  await owner.goto(`${base}/members?mode=kick`);
  await owner.locator(`[data-testid="member-row"][data-user="${b}"]`).click();
  await owner.getByTestId('kick-submit').click();
  await owner.getByTestId('kick-confirm').getByText('移出', { exact: true }).click();
  await expect(owner.locator(`[data-testid="member-row"][data-user="${b}"]`)).toHaveCount(0);
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText('群成员（3）');
  await expect(bob.getByText('你已不在该群，无法发送消息')).toBeVisible();

  // 转让：dave 成为群主排第一，原群主变普通成员。
  await owner.goto(`${base}/members?mode=transfer`);
  await owner.locator(`[data-testid="member-row"][data-user="${d}"]`).click();
  await owner.getByTestId('transfer-confirm').getByText('转让', { exact: true }).click();
  await expect(owner.getByTestId('member-row').first()).toHaveAttribute('data-user', d);
  await expect(owner.getByTestId('member-row').first()).toContainText('群主');
  await expect(owner.locator(`[data-testid="member-row"][data-user="${ownerId}"]`)).not.toContainText('群主');
  await expect(dave.getByTestId('group-dissolve')).toBeVisible({ timeout: 3_000 });
});

test('群主退群转让给最早的管理员；解散后在线成员看到"群聊已解散"（AC-UI-36-6、36-7）', async ({ browser }) => {
  const { owner, ids, pages } = await setup(browser, 'b', 'c');
  const convId = await createGroup(owner, ids, '散伙局');
  const base = `/chat/${encodeURIComponent(convId)}`;
  const [bob, carol] = pages as [Page, Page];
  await owner.goto(`${base}/members?mode=admin`);
  await owner.locator(`[data-testid="member-row"][data-user="${ids[1]!}"]`).click();
  await expect(owner.locator(`[data-testid="member-row"][data-user="${ids[1]!}"]`)).toContainText('管理员');

  await bob.goto(base);
  await expect(bob.getByTestId('chat-title')).toContainText('散伙局');
  await carol.goto(`${base}/info`);
  await expect(carol.getByTestId('group-dissolve')).toHaveCount(0);

  await owner.goto(`${base}/info`);
  await owner.getByTestId('group-leave').click();
  await expect(owner.getByTestId('leave-confirm')).toContainText('你是群主，退出后群主将自动转让给其他成员');
  await owner.getByTestId('leave-confirm').getByText('退出', { exact: true }).click();
  await expect(owner).toHaveURL(/\/chats$/);
  await expect(owner.getByTestId('conv-list')).not.toContainText('散伙局');

  await expect(carol.getByTestId('group-dissolve')).toBeVisible({ timeout: 3_000 });
  await carol.getByTestId('group-dissolve').click();
  await carol.getByTestId('dissolve-confirm').getByText('解散', { exact: true }).click();
  await expect(carol).toHaveURL(/\/chats$/);
  await expect(carol.getByTestId('conv-list')).not.toContainText('散伙局');
  await expect(bob.getByTestId('composer-disabled')).toHaveText('群聊已解散');
});

test('200 人的群：滚动加载全部成员，无重复，第一项是群主（AC-UI-38-1）', async ({ browser }) => {
  const { owner, ownerId, ids } = await setup(browser, 'b', 'c');
  const convId = await createGroup(owner, ids);
  const groupId = convId.slice('group:'.length);
  const prefix = uid('s');
  const extra = Array.from({ length: 197 }, (_, i) => `${prefix}${i}`);
  await users(...extra.slice(0, 197));
  await admin('POST', '/admin/test/social/seed', {
    groupMembers: extra.map((userId) => ({ groupId, userId })),
  });
  await owner.goto(`/chat/${encodeURIComponent(convId)}/members`);
  await expect(owner.getByTestId('member-row').first()).toHaveAttribute('data-user', ownerId);
  await expect(owner.getByTestId('member-row').first()).toContainText('群主');
  const list = owner.getByTestId('member-list');
  await expect
    .poll(
      async () => {
        await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        return owner.getByTestId('member-row').count();
      },
      { timeout: 15_000 },
    )
    .toBe(200);
  const seen = await owner.getByTestId('member-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-user')));
  expect(new Set(seen).size).toBe(200);
});

test('管理接口加人：停在聊天页的标题成员数 3 秒内加 1（AC-UI-06-8）', async ({ browser }) => {
  const a = uid('ga');
  const b = uid('gb');
  const c = uid('gc');
  const g = uid('g');
  await users(a, b, c);
  await admin('POST', '/admin/groups', { groupId: g, name: '托管群', members: [a, b] });
  const alice = await loginAs(browser, a);
  await alice.goto(`/chat/${encodeURIComponent(`group:${g}`)}`);
  await expect(alice.getByTestId('chat-title')).toContainText('（2）');
  await admin('POST', `/admin/groups/${g}/members`, { members: [c] });
  await expect(alice.getByTestId('chat-title')).toContainText('（3）', { timeout: 3_000 });
});

test('同一用户在另一端退群：本端 3 秒内显示"你已退出该群聊"（AC-UI-33-8）', async ({ browser }) => {
  const { owner, ids, pages } = await setup(browser, 'b', 'c');
  const convId = await createGroup(owner, ids);
  const base = `/chat/${encodeURIComponent(convId)}`;
  const bob = pages[0]!;
  const bobOther = await loginAs(browser, ids[0]!);
  await bob.goto(base);
  await expect(bob.getByTestId('chat-title')).toContainText('（3）');
  await bobOther.goto(`${base}/info`);
  await bobOther.getByTestId('group-leave').click();
  await bobOther.getByTestId('leave-confirm').getByText('退出', { exact: true }).click();
  await expect(bobOther).toHaveURL(/\/chats$/);
  await expect(bob.getByTestId('composer-disabled')).toHaveText('你已退出该群聊', { timeout: 3_000 });
});

test('群页面无障碍扫描（颜色对比度、按钮和链接名称、表单标签）', async ({ browser }) => {
  const { owner, ownerId, ids } = await setup(browser, 'b', 'c');
  const convId = await createGroup(owner, ids);
  const base = `/chat/${encodeURIComponent(convId)}`;
  const pages: Array<[string, string]> = [
    [base, 'tip'],
    [`${base}/info`, 'member-grid'],
    [`${base}/notice`, 'notice-empty'],
    [`${base}/members`, 'member-row'],
    [`${base}/members?mode=kick`, 'kick-submit'],
    [`${base}/invite`, 'pick-row'],
    ['/groups/new', 'pick-row'],
  ];
  for (const [path, ready] of pages) {
    // 短时间内反复刷新会触发全量同步限流（突发 10 次），这里只是扫描页面，不测限流。
    await admin('POST', '/admin/test/limits/reset', { userId: ownerId });
    await owner.goto(path);
    await expect(owner.getByTestId(ready).first()).toBeVisible();
    const r = await new AxeBuilder({ page: owner })
      .withRules(['color-contrast', 'button-name', 'link-name', 'label'])
      .analyze();
    expect(r.violations.map((v) => `${path}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
      [],
    );
  }
});

test('routeWebSocket：groupCreate 4030 → "当前不允许创建群聊"（AC-UI-35-5）', async ({ browser }) => {
  const { owner, ids } = await setup(browser, 'b', 'c');
  await owner.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as { id?: string; cmd?: string };
      if (f.cmd === 'groupCreate') {
        ws.send(JSON.stringify({ id: f.id, cmd: 'ack', error: { code: 4030, msg: 'x' } }));
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await owner.goto('/groups/new');
  for (const m of ids) await row(owner, m).getByRole('checkbox').check();
  await owner.getByTestId('pick-done').click();
  await owner.getByTestId('group-create').click();
  await expect(owner.getByTestId('toast')).toHaveText('当前不允许创建群聊');
  await expect(owner).toHaveURL(/\/groups\/new$/);
});
