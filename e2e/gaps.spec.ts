import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { admin, loginAs, uid } from './helpers';

test('演示登录带昵称：对方的会话列表显示昵称（AC-UI-03-7）', async ({ browser }) => {
  const z = uid('zs');
  const b = uid('bob');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-username').fill(z);
  await page.getByTestId('login-nickname').fill('张三');
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/chats$/);
  const bob = await loginAs(browser, b);
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-menu').getByText('发起单聊').click();
  await page.getByTestId('start-chat-input').fill(b);
  await page.getByTestId('start-chat-input').press('Enter');
  await page.getByTestId('composer-input').fill('你好');
  await page.getByTestId('composer-input').press('Enter');
  await expect(bob.getByTestId('conv-item').first()).toContainText('张三');
});

test('群成员数：进入群聊显示（N）；加人后 30 秒再进入更新（AC-UI-06-6）', async ({ browser }) => {
  test.setTimeout(70_000);
  const a = uid('alice');
  const g = uid('g');
  const others = [uid('m'), uid('m'), uid('m'), uid('m')];
  await admin('POST', '/admin/users/import', { users: [a, ...others].map((userId) => ({ userId })) });
  await admin('POST', '/admin/groups', { groupId: g, name: '周末球局', members: [a, others[0], others[1]] });
  const page = await loginAs(browser, a);
  await page.getByTestId('conv-item').filter({ hasText: '周末球局' }).click();
  await expect(page.getByTestId('chat-title')).toHaveText('周末球局（3）');
  await page.getByLabel('返回').click();
  await admin('POST', `/admin/groups/${g}/members`, { members: [others[2], others[3]] });
  await page.waitForTimeout(31_000);
  await page.getByTestId('conv-item').filter({ hasText: '周末球局' }).click();
  await expect(page.getByTestId('chat-title')).toHaveText('周末球局（5）', { timeout: 3_000 });
});

test('可访问性：主要页面没有 color-contrast、button-name 违规（AC-UI-90-4）', async ({ browser }) => {
  const a = uid('alice');
  const b = uid('bob');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const login = await (await browser.newContext()).newPage();
  await login.goto('/login');
  const scan = async (p: typeof login, label: string) => {
    const r = await new AxeBuilder({ page: p }).withRules(['color-contrast', 'button-name']).analyze();
    expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
      [],
    );
  };
  await scan(login, 'login');
  const page = await loginAs(browser, a);
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-menu').getByText('发起单聊').click();
  await page.getByTestId('start-chat-input').fill(b);
  await page.getByTestId('start-chat-input').press('Enter');
  await page.getByTestId('composer-input').fill('无障碍检查');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  await scan(page, 'chat');
  for (const path of ['/chats', '/contacts', '/me', '/me/settings']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await scan(page, path);
  }
});

test('性能：500 个会话在 CPU 4 倍降速下 500ms 内渲染完（AC-UI-90-6）', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = uid('perf');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }] });
  for (let i = 0; i < 500; i += 25) {
    await Promise.all(
      Array.from({ length: 25 }, (_, j) =>
        admin('POST', '/admin/groups', { groupId: `${a}-${i + j}`, name: `群 ${i + j}`, members: [a] }),
      ),
    );
  }
  const page = await loginAs(browser, a);
  await expect(page.getByTestId('conv-item')).toHaveCount(500);
  const durations: number[] = [];
  for (let run = 0; run < 3; run++) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.reload();
    await expect(page.getByTestId('conv-item')).toHaveCount(500);
    durations.push(
      await page.evaluate(() => {
        const [m] = performance.measure('convs-render', 'tt-convs-loaded', 'tt-convs-rendered').duration
          ? [performance.getEntriesByName('convs-render').at(-1)!]
          : [];
        return m!.duration;
      }),
    );
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  durations.sort((x, y) => x - y);
  console.log(`convs-render (4x CPU): ${durations.map((d) => d.toFixed(0)).join(' / ')} ms`);
  expect(durations[1]).toBeLessThanOrEqual(500);
});
