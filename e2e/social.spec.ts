import { expect, test, type Page } from '@playwright/test';
import { admin, loginAs, uid } from './helpers';

const users = (...list: Array<[string, string?]>) =>
  admin('POST', '/admin/users/import', {
    users: list.map(([userId, nickname]) => ({ userId, ...(nickname ? { nickname } : {}) })),
  });

async function searchAndOpenApply(page: Page, target: string) {
  await page.goto('/contacts/add');
  await page.getByTestId('search-input').fill(target);
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-add').click();
  await expect(page).toHaveURL(new RegExp(`/contacts/apply/${target}$`));
}

test('搜索 → 申请 → 对方红点 → 同意 → 双方通讯录（AC-UI-26-1、27-2、25-2、13-4、23-4）', async ({ browser }) => {
  const a = uid('a');
  const b = uid('b');
  await users([a, '小爱'], [b, '阿博']);
  const alice = await loginAs(browser, a);
  const bob = await loginAs(browser, b);
  await bob.goto('/contacts');
  await expect(bob.getByTestId('contacts-empty')).toBeVisible();

  await alice.goto('/contacts');
  await expect(alice.getByTestId('contacts-empty')).toBeVisible();
  await searchAndOpenApply(alice, b);
  await expect(alice.getByTestId('apply-name')).toHaveText('阿博');
  await expect(alice.getByTestId('apply-message')).toHaveValue('我是小爱');
  await alice.getByTestId('apply-message').fill('球友');
  await alice.getByTestId('apply-remark').fill('B哥');
  await alice.getByTestId('apply-send').click();
  await expect(alice.getByTestId('toast')).toHaveText('已发送');

  await expect(bob.getByTestId('requests-badge')).toHaveText('1', { timeout: 5_000 });
  await expect(bob.getByTestId('tab-contacts-badge')).toHaveText('1');
  await bob.getByTestId('entry-requests').click();
  const row = bob.getByTestId('request-row');
  await expect(row).toContainText('小爱');
  await expect(row).toContainText('球友');
  await row.getByTestId('request-accept').click();
  await expect(row).toContainText('已添加');
  await expect(bob.getByTestId('tab-contacts-badge')).toHaveCount(0);

  await alice.goto('/contacts');
  await expect(alice.getByTestId('friend-name')).toHaveText('B哥');
  await bob.getByRole('button', { name: '返回' }).click();
  await expect(bob.getByTestId('friend-name')).toHaveText('小爱');
  await expect(bob.getByTestId('contacts-count')).toHaveText('1 位朋友');
});

test('关闭"可被搜索"：与不存在的用户结果相同；重新打开后能搜到（AC-UI-26-2、30-1）', async ({ browser }) => {
  const a = uid('a');
  const b = uid('b');
  await users([a], [b]);
  const bob = await loginAs(browser, b);
  await bob.goto('/me/settings/privacy');
  const sw = bob.getByTestId('privacy-switch');
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect(sw).toBeEnabled();

  const alice = await loginAs(browser, a);
  await alice.goto('/contacts/add');
  const result = async (kw: string) => {
    await alice.getByTestId('search-input').fill(kw);
    await alice.getByTestId('search-input').press('Enter');
    await expect(alice.getByTestId('search-loading')).toHaveCount(0);
    await expect(alice.getByTestId('search-result')).toBeVisible();
    // eslint-disable-next-line no-restricted-syntax -- 只读，用来比较 DOM 结构（防枚举用例）
    return alice.getByTestId('search-result').innerHTML();
  };
  const hidden = await result(b);
  const nobody = await result(`nobody${b}`);
  expect(hidden).toBe(nobody);
  expect(hidden).toContain('未找到该用户');

  await sw.click();
  await expect(sw).toBeChecked();
  await expect(sw).toBeEnabled();
  await alice.getByTestId('search-input').fill(b);
  await alice.getByTestId('search-input').press('Enter');
  await expect(alice.getByTestId('search-card')).toBeVisible();
});

test('资料卡拉黑 → 对方私聊被拒提示 → 黑名单移出 → 恢复；删除朋友后会话还在（AC-UI-14-4、14-5、29-1、29-2、31-2）', async ({
  browser,
}) => {
  const a = uid('a');
  const b = uid('b');
  await users([a], [b]);
  const alice = await loginAs(browser, a);
  const bob = await loginAs(browser, b);
  // 互加好友
  await searchAndOpenApply(alice, b);
  await alice.getByTestId('apply-send').click();
  await expect(alice.getByTestId('toast')).toHaveText('已发送');
  await bob.goto('/contacts/requests');
  await bob.getByTestId('request-accept').click();
  await expect(bob.getByTestId('request-row')).toContainText('已添加');

  await alice.goto(`/user/${b}`);
  await expect(alice.getByTestId('user-chat')).toBeVisible();
  await alice.getByTestId('user-more').click();
  await alice.getByRole('menuitem', { name: '加入黑名单' }).click();
  await alice.getByTestId('block-dialog').getByRole('button', { name: '确定' }).click();
  await expect(alice.getByTestId('user-blocked')).toBeVisible();

  const conv = encodeURIComponent(a < b ? `c2c:${a}:${b}` : `c2c:${b}:${a}`);
  await bob.goto(`/chat/${conv}`);
  await bob.getByTestId('composer-input').fill('在吗');
  await bob.getByTestId('composer-input').press('Enter');
  await expect(bob.getByTestId('permission-tip')).toHaveText('消息已发出，但被对方拒收了');
  await expect(bob.locator('.tt-toast')).toHaveCount(0);

  await alice.goto('/me/settings');
  await expect(alice.getByTestId('settings-blocks')).toContainText('1');
  await alice.getByTestId('settings-blocks').click();
  await alice.getByTestId('block-remove').click();
  await expect(alice.getByText('已移出黑名单')).toBeVisible();
  await expect(alice.getByTestId('blocks-empty')).toBeVisible();

  await bob.getByTestId('composer-input').fill('现在呢');
  await bob.getByTestId('composer-input').press('Enter');
  await expect(bob.getByTestId('message').filter({ hasText: '现在呢' })).toHaveAttribute('data-status', 'sent');

  // 删除朋友：停留在资料卡，通讯录没有对方，会话还在。
  await alice.goto(`/user/${b}`);
  await alice.getByTestId('user-more').click();
  await alice.getByRole('menuitem', { name: '删除朋友' }).click();
  await alice.getByTestId('delete-dialog').getByRole('button', { name: '删除' }).click();
  await expect(alice.getByTestId('user-add')).toBeVisible();
  await alice.goto('/contacts');
  await expect(alice.getByTestId('contacts-empty')).toBeVisible();
  await alice.goto('/chats');
  await expect(alice.getByTestId('conv-item')).toHaveCount(1);
});

test('备注多端同步（AC-UI-28-1）', async ({ browser }) => {
  const a = uid('a');
  const b = uid('b');
  await users([a], [b, '阿博']);
  await admin('POST', '/admin/test/social/seed', {
    friends: [
      { owner: a, peer: b },
      { owner: b, peer: a },
    ],
  });
  const web = await loginAs(browser, a);
  const pc = await loginAs(browser, a);
  await pc.goto('/contacts');
  await expect(pc.getByTestId('friend-name')).toHaveText('阿博');
  await web.goto(`/user/${b}/remark`);
  await web.getByTestId('remark-input').fill('老板');
  await web.getByTestId('remark-done').click();
  await expect(web.getByTestId('user-name')).toContainText('老板');
  await expect(pc.getByTestId('friend-name')).toHaveText('老板', { timeout: 2_000 });
});

test('群聊列表不受 500 上限；群消息显示发送者昵称；从群进入资料卡申请来源 group（AC-UI-32-2、32-4、14-11、AC-SOC-10-7）', async ({
  browser,
}) => {
  const a = uid('a');
  const c = uid('c');
  await users([a], [c, '小卡']);
  const tag = uid('g');
  const members = Array.from({ length: 600 }, (_, i) => ({
    groupId: `${tag}${String(i).padStart(3, '0')}`,
    userId: a,
  }));
  await admin('POST', '/admin/test/social/seed', { groupMembers: members });
  const gid = `${tag}t`;
  await admin('POST', '/admin/groups', { groupId: gid, name: '同事群', members: [a, c] });

  const carol = await loginAs(browser, c);
  const alice = await loginAs(browser, a);
  await alice.goto('/contacts/groups');
  await expect(alice.getByTestId('groups-count')).toHaveText('601 个群聊');
  await expect(alice.getByTestId('group-row')).toHaveCount(601);

  await carol.goto(`/chat/${encodeURIComponent(`group:${gid}`)}`);
  await carol.getByTestId('composer-input').fill('大家好');
  await carol.getByTestId('composer-input').press('Enter');
  await expect(carol.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');

  await alice.goto(`/chat/${encodeURIComponent(`group:${gid}`)}`);
  await expect(alice.locator('.tt-msg-name')).toHaveText('小卡');
  await alice.getByTestId('msg-avatar').click();
  await expect(alice).toHaveURL(new RegExp(`/user/${c}$`));
  await alice.getByTestId('user-add').click();
  await alice.getByTestId('apply-send').click();
  await expect(alice.getByTestId('toast')).toHaveText('已发送');
  await carol.goto('/contacts/requests');
  await carol.getByTestId('request-row').click();
  await expect(carol.getByTestId('request-source')).toHaveText('通过群聊添加');
});

test('性能：2000 个好友，刷新页面到通讯录显示完成 ≤ 2 秒（3 次中位数，AC-SOC-06-14）', async ({ browser }) => {
  const a = uid('a');
  const tag = uid('f');
  const ids = Array.from({ length: 2000 }, (_, i) => `${tag}${i}`);
  await users([a]);
  for (let i = 0; i < ids.length; i += 500)
    await users(...ids.slice(i, i + 500).map((id, k) => [id, `好友${i + k}`] as [string, string]));
  await admin('POST', '/admin/test/social/seed', { friends: ids.map((peer) => ({ owner: a, peer })) });
  const page = await loginAs(browser, a);
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    await page.goto('/contacts');
    await expect(page.getByTestId('contacts-count')).toHaveText('2000 位朋友');
    times.push(Date.now() - start);
  }
  times.sort((x, y) => x - y);
  console.log(`contacts 2000 friends: ${times.join(' / ')} ms`);
  expect(times[1]).toBeLessThanOrEqual(2000);
});
