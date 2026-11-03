import { expect, test } from '@playwright/test';
import { admin, loginAs, uid } from './helpers';

test('两个用户单聊：发起单聊、发送、对方收到未读并回复（AC-CONV-03-1、AC-MSG-01-1、AC-CONV-02-4）', async ({
  browser,
}) => {
  const a = uid('alice');
  const b = uid('bob');
  await admin('POST', '/admin/users/import', { users: [{ userId: b }] });
  const alice = await loginAs(browser, a);
  const bob = await loginAs(browser, b);

  await alice.getByTestId('plus-button').click();
  await alice.getByTestId('plus-menu').getByText('发起单聊').click();
  await alice.getByTestId('start-chat-input').fill(b);
  await alice.getByTestId('start-chat-input').press('Enter');
  await alice.getByTestId('composer-input').fill('你好，天听');
  await alice.getByTestId('composer-input').press('Enter');
  await expect(alice.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');

  const item = bob.getByTestId('conv-item').filter({ hasText: '你好，天听' });
  await expect(item.getByTestId('conv-badge')).toHaveText('1');
  await expect(bob).toHaveTitle('(1) 天听');
  await item.click();
  await expect(bob.getByTestId('message')).toContainText('你好，天听');
  await expect(bob).toHaveTitle('天听'); // 打开会话后已读
  await bob.getByTestId('composer-input').fill('收到');
  await bob.getByTestId('send-button').click();
  await expect(alice.getByTestId('message').last()).toContainText('收到');
});

test('刷新后自动重连，停留在原页面（PRD-core 第 5 节）', async ({ browser }) => {
  const a = uid('alice');
  const page = await loginAs(browser, a);
  await page.getByTestId('tab-me').click();
  await expect(page.getByTestId('me-name')).toHaveText(a);
  await page.reload();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByTestId('me-name')).toHaveText(a);
});

test('群聊：显示发送者；被移出后输入区禁用（AC-GRP-02-4、AC-GRP-03-3）', async ({ browser }) => {
  const a = uid('alice');
  const b = uid('bob');
  const g = uid('g');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  await admin('POST', '/admin/groups', { groupId: g, name: '周末球局', members: [a, b] });
  const alice = await loginAs(browser, a);
  const bob = await loginAs(browser, b);
  await alice.getByTestId('conv-item').filter({ hasText: '周末球局' }).click();
  await bob.getByTestId('conv-item').filter({ hasText: '周末球局' }).click();
  await bob.getByTestId('composer-input').fill('晚上踢球吗');
  await bob.getByTestId('composer-input').press('Enter');
  const m = alice.getByTestId('message').last();
  await expect(m).toContainText('晚上踢球吗');
  await expect(m.locator('.tt-msg-name')).toHaveText(b);

  await admin('DELETE', `/admin/groups/${g}/members`, { members: [a] });
  await expect(alice.getByTestId('composer-disabled')).toHaveText('你已不在该群，无法发送消息');
});

test('强制下线：弹出"账号已被下线"，点确定回登录页（AC-AUTH-03-5、F-UI-18）', async ({ browser }) => {
  const a = uid('alice');
  const page = await loginAs(browser, a);
  await admin('POST', `/admin/users/${a}/force-logout`, {});
  await expect(page.getByTestId('kicked-dialog')).toContainText('账号已被下线');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('kicked-dialog')).toBeVisible();
  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('登录回跳：恶意地址回到 /chats；合法地址回到原页面（AC-UI-01-3、AC-UI-01-7）', async ({ browser }) => {
  const a = uid('alice');
  const bad = await loginAs(browser, a, '/login?redirect=//evil.com');
  await expect(bad).toHaveURL(/\/chats$/);
  const conv = `c2c:${a}:${a}z`;
  const good = await loginAs(browser, a, `/login?redirect=${encodeURIComponent(`/chat/${encodeURIComponent(conv)}`)}`);
  await expect(good).toHaveURL((u) => decodeURIComponent(u.pathname) === `/chat/${conv}`);
  await expect(good.getByTestId('composer-input')).toBeVisible();
});

test('布局：320 宽没有横向滚动；桌面 1280 宽容器 480 居中（AC-UI-02-5、AC-UI-02-6）', async ({ browser }) => {
  const a = uid('alice');
  const page = await loginAs(browser, a);
  await page.setViewportSize({ width: 320, height: 568 });
  for (const path of ['/chats', '/contacts', '/me', '/me/settings']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(320);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/chats');
  const box = (await page.getByTestId('app').boundingBox())!;
  expect(Math.abs(box.width - 480)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x - 400)).toBeLessThanOrEqual(1);
});
