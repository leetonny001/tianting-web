// PRD-admin 第二批 × 真实 im-server（IM_V13_ADMIN_FEATURES=1）：封禁、消息删除、禁言。
import { expect, test, type Page } from '@playwright/test';
import { admin, loginAs, signed, uid } from './helpers';

const pad = (n: number) => String(n).padStart(2, '0');
const monthDay = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dateTime = (ts: number) => `${new Date(ts).getFullYear()}-${monthDay(ts)}`;
const chat = (convId: string) => `/chat/${encodeURIComponent(convId)}`;
const c2c = (a: string, b: string) => (a < b ? `c2c:${a}:${b}` : `c2c:${b}:${a}`);

async function group(name: string, ...members: string[]) {
  const g = uid('g');
  await admin('POST', '/admin/users/import', { users: members.map((userId) => ({ userId })) });
  await admin('POST', '/admin/groups', { groupId: g, name, members });
  return { groupId: g, convId: `group:${g}` };
}

/** 页面里执行 SDK 调试接口，导出内存（AC-ADM-31-3）。 */
const memory = (p: Page) =>
  p.evaluate(() =>
    JSON.stringify(
      (window as unknown as { __tiantingDebug: { exportMemory(): unknown } }).__tiantingDebug.exportMemory(),
    ),
  );

test('封禁 1 天：弹窗带解封时间，不重连；刷新用旧 token 同样被踢；回登录页后登录被拒（AC-ADM-13-11、AC-UI-43-1、43-3）', async ({
  browser,
}) => {
  const u = uid('ban');
  const page = await loginAs(browser, u);
  let sockets = 0;
  page.on('websocket', () => sockets++);
  const { ban } = await signed(`/admin/users/${u}/ban`, { durationSeconds: 86_400, reason: 'e2e' });
  const text = `账号已被封禁，解封时间：${dateTime(ban.until)}`;
  await expect(page.getByTestId('kicked-dialog')).toContainText(text, { timeout: 3_000 });
  await page.waitForTimeout(3_000); // 退避第一次是 1 秒：如果重连，这里已经发生了
  expect(sockets).toBe(0);

  await page.reload();
  await expect(page.getByTestId('kicked-dialog')).toContainText(text);

  await page.getByTestId('kicked-dialog').getByText('确定').click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText(text);
  await expect(page).toHaveURL(/\/login/);
});

test('永久封禁：弹窗和登录页都只有"账号已被封禁"（AC-ADM-13-11）', async ({ browser }) => {
  const u = uid('ban');
  const page = await loginAs(browser, u);
  await signed(`/admin/users/${u}/ban`, { durationSeconds: null, reason: 'e2e' });
  const dialog = page.getByTestId('kicked-dialog');
  await expect(dialog).toContainText('账号已被封禁', { timeout: 3_000 });
  await expect(dialog).not.toContainText('解封时间');
  await dialog.getByText('确定').click();
  await page.getByTestId('login-username').fill(u);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('账号已被封禁');
});

test('/demo/login 返回 4034（page.route）：显示同一文案（AC-UI-43-2）', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.route('**/demo/login', (r) =>
    r.fulfill({ status: 403, json: { code: 4034, msg: 'banned', details: { bannedUntil: null } } }),
  );
  await page.goto('/login');
  await page.getByTestId('login-username').fill('someone');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('账号已被封禁');
});

test('删除群消息：在线端都显示占位，DOM 和 SDK 导出搜不到特征串；摘要占位、未读不变；离线成员也一样（AC-ADM-31-1、31-3、31-5）', async ({
  browser,
}) => {
  const [s, b, m, off] = [uid('s'), uid('b'), uid('m'), uid('off')];
  const { convId } = await group('删除群', s, b, m, off);
  const secret = `ZXQ-DEL-${uid('x')}`;
  const sender = await loginAs(browser, s, chat(convId));
  const sender2 = await loginAs(browser, s, chat(convId));
  const member = await loginAs(browser, b, chat(convId));
  const lister = await loginAs(browser, m); // 停在会话列表：未读不被清零

  await sender.getByTestId('composer-input').fill(secret);
  await sender.getByTestId('composer-input').press('Enter');
  const open = [sender, sender2, member];
  for (const p of open) await expect(p.getByTestId('message-list')).toContainText(secret);
  const item = lister.locator(`[data-conv-id="${convId}"]`);
  await expect(item).toContainText(secret);
  const badge = await item.getByTestId('conv-badge').textContent();
  expect(await memory(member)).toContain(secret); // 对照：删除之前能搜到

  const dump = JSON.parse(await memory(sender)) as {
    messages: Record<string, { msgId?: string; body: { text?: string } }[]>;
  };
  const msgId = dump.messages[convId]!.find((x) => x.body.text === secret)!.msgId!;
  const { deleted } = await signed('/admin/messages/delete', { convId, msgIds: [msgId], reason: 'e2e' });
  expect(deleted[0].msgId).toBe(msgId);

  for (const p of open) {
    await expect(p.getByTestId('msg-deleted')).toHaveText('该消息已被删除', { timeout: 3_000 });
    expect(await p.content()).not.toContain(secret);
    expect(await memory(p)).not.toContain(secret);
  }
  await expect(item.locator('.tt-conv-summary')).toHaveText('该消息已被删除', { timeout: 3_000 });
  expect(await lister.content()).not.toContain(secret);
  expect(await memory(lister)).not.toContain(secret);
  await expect(item.getByTestId('conv-badge')).toHaveText(badge!);

  // 拉 convs（刷新）：摘要仍是占位，未读不变（AC-ADM-31-5）。
  await lister.reload();
  await expect(item.locator('.tt-conv-summary')).toHaveText('该消息已被删除');
  await expect(item.getByTestId('conv-badge')).toHaveText(badge!);

  // 离线成员上线后打开（AC-UI-42-3）。
  const offline = await loginAs(browser, off, chat(convId));
  await expect(offline.getByTestId('msg-deleted')).toHaveText('该消息已被删除');
  expect(await offline.content()).not.toContain(secret);
  expect(await memory(offline)).not.toContain(secret);

  // 新消息之后摘要恢复。
  await sender.getByTestId('composer-input').fill('fresh');
  await sender.getByTestId('composer-input').press('Enter');
  await expect(item.locator('.tt-conv-summary')).toContainText('fresh');
});

test('用户级禁言：单聊和群聊都显示禁言条；解除后输入框恢复、发送成功（AC-ADM-40-4、40-5）', async ({ browser }) => {
  const [u, p] = [uid('u'), uid('p')];
  const { convId } = await group('禁言群', u, p);
  const page = await loginAs(browser, u, chat(convId));
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const { mutedUntil } = await signed('/admin/mute', { scope: 'user', userId: u, durationSeconds: 600, reason: 'e2e' });
  const bar = page.getByTestId('composer-disabled');
  await expect(bar).toHaveText(`你已被禁言，解除时间：${monthDay(mutedUntil)}`, { timeout: 3_000 });
  await expect(page.getByTestId('composer-input')).toHaveCount(0);

  await page.goto(chat(c2c(u, p)));
  await expect(bar).toHaveText(`你已被禁言，解除时间：${monthDay(mutedUntil)}`);

  await signed('/admin/unmute', { scope: 'user', userId: u, reason: 'e2e' });
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 3_000 });
  await page.getByTestId('composer-input').fill('恢复了');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
});

test('离线时被用户级禁言（永久）：上线打开任一会话，输入框一开始就没有（AC-ADM-40-6、AC-UI-41-5）', async ({
  browser,
}) => {
  const [u, p] = [uid('u'), uid('p')];
  const { convId } = await group('离线禁言', u, p);
  await signed('/admin/mute', { scope: 'user', userId: u, durationSeconds: null, reason: 'e2e' });
  const page = await loginAs(browser, u, chat(convId));
  await expect(page.getByTestId('composer-disabled')).toHaveText('你已被禁言');
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
});

test('离线时在 g1 被禁言：g1 输入框禁用；g2 和单聊可以发（AC-ADM-41-6、AC-UI-41-2）', async ({ browser }) => {
  const [u, p] = [uid('u'), uid('p')];
  const g1 = await group('一群', u, p);
  const g2 = await group('二群', u, p);
  const { mutedUntil } = await signed('/admin/mute', {
    scope: 'group',
    groupId: g1.groupId,
    userId: u,
    durationSeconds: 3600,
    reason: 'e2e',
  });
  const page = await loginAs(browser, u, chat(g1.convId));
  await expect(page.getByTestId('composer-disabled')).toHaveText(`你已被禁言，解除时间：${monthDay(mutedUntil)}`);
  for (const id of [g2.convId, c2c(u, p)]) {
    await page.goto(chat(id));
    await page.getByTestId('composer-input').fill('可以发');
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
    await expect(page.getByTestId('composer-disabled')).toHaveCount(0);
  }
});

test('禁言到期：没有 unmuted 事件，输入框自动恢复，发送成功（AC-UI-41-4，真实 60 秒）', async ({ browser }) => {
  test.setTimeout(100_000);
  const [u, p] = [uid('u'), uid('p')];
  const { convId } = await group('到期群', u, p);
  const page = await loginAs(browser, u, chat(convId));
  await signed('/admin/mute', { scope: 'user', userId: u, durationSeconds: 60, reason: 'e2e' });
  await expect(page.getByTestId('composer-disabled')).toBeVisible({ timeout: 3_000 });
  await page.waitForTimeout(50_000);
  await expect(page.getByTestId('composer-disabled')).toBeVisible(); // 没到期不恢复
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('composer-input').fill('到期了');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
});
