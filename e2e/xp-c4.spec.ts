// FE-672：C4 的三端互发互收（撤回、引用、@；H5、Android、iOS 对同一个 im-server）。三端不能同时跑，所以分两步：
// 先各端用自己的界面发（TT_XP_PHASE=send），再各端用自己的界面收（receive）。共同约定（tianting-android 的 CrossPlatformC4E2e、
// tianting-ios 的 CrossPlatformC4E2ETests 照抄这一段）：
//   - 运行号 R，用户 xp{R}h5、xp{R}android、xp{R}ios（昵称就是 userId）。每个发送端 p 有两个群（三人都在，群主是 p）：
//     xp{R}m{p}「C4引用提及-{p}」、xp{R}r{p}「C4撤回-{p}」。others(p) 按 h5、android、ios 的顺序去掉 p，记作 q1、q2。
//   - 协调脚本先放好：q1 在 m 群发「XP4-q-{q1}@{p}」；q1、q2 依次在 r 群发「XP4-r-{q}@{p}」（r 群最后一条是 q2 的）。
//   - 发（p，自己的界面）：① 给每个 q 单聊发「XP4-{p}>{q}-撤回原文」，长按（右键）撤回；② m 群引用「XP4-q-{q1}@{p}」回复
//     「XP4-{p}-引用回复」；再输入 @ 选 q1、@ 选 q2，加「XP4-{p}-提及」发送；③ r 群以群主身份撤回 q2、q1 的消息。
//   - 收（me，自己的界面，TT_XP_FROM 指定发送端）：单聊有「对方撤回了一条消息」、没有原文，列表摘要是撤回文案（AC-RCL-01-1、
//     03-3 的客户端部分：接收方在撤回时不在线，重连后拉到）；m 群列表有「[有人@我]」，引用回复的气泡顶部是
//     「{q1}: XP4-q-{q1}@{p}」，提及消息标记为提到我（AC-QUO-01-1、AC-MEN-01-1）；r 群按 F-RCL-02 规则 1a 第 3 行：
//     自己的那条「{p}撤回了你的一条消息」，另一条「{p}撤回了一条成员消息」，列表摘要按最后一条（AC-RCL-02-4）。
// 没有 TT_XP 时跳过。配置见 playwright.xp.config.ts。结果是 Chrome，本地。引用原文、@ 内容只在页面里断言，不打印。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { c2cId, chatUrl, WIDE } from './helpers';

const RUN = process.env.TT_XP ?? '';
const PHASE = process.env.TT_XP_PHASE ?? '';
const ME = 'h5';
const PLATFORMS = ['h5', 'android', 'ios'] as const;
type P = (typeof PLATFORMS)[number];
const user = (p: P) => `xp${RUN}${p}`;
const others = (p: P): [P, P] => PLATFORMS.filter((x) => x !== p) as [P, P];
const mGroup = (p: P) => `group:xp${RUN}m${p}`;
const rGroup = (p: P) => `group:xp${RUN}r${p}`;
const recallText = (p: P, q: P) => `XP4-${p}>${q}-撤回原文`;
const quoted = (p: P) => `XP4-q-${others(p)[0]}@${p}`;
const reply = (p: P) => `XP4-${p}-引用回复`;
const mention = (p: P) => `XP4-${p}-提及`;
const seed = (q: P, p: P) => `XP4-r-${q}@${p}`;

const bubble = (page: Page, text: string) => page.locator('[data-testid="bubble"]', { hasText: text });
const row = (page: Page, convId: string) => page.locator(`[data-conv-id="${convId}"]`);
const input = (page: Page) => page.getByTestId('composer-input');

async function open(browser: Browser, userId: string) {
  const ctx = await browser.newContext(WIDE);
  const page = await ctx.newPage();
  const sent: { cmd?: string; data?: { body?: { text?: string; mentions?: { userIds: string[] } } } }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        sent.push(JSON.parse(String(f.payload)));
      } catch {
        // 不是 JSON 的帧不管
      }
    }),
  );
  await page.goto('/login');
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  return Object.assign(page, { sent });
}

async function menuItem(page: Page, text: string, item: 'menu-recall' | 'menu-quote') {
  await expect(bubble(page, text)).toBeVisible({ timeout: 30_000 });
  await bubble(page, text).click({ button: 'right' });
  await page.getByTestId(item).click();
}

async function pickMention(page: Page, userId: string) {
  await page.keyboard.type('@');
  const r = page.locator(`[data-testid="mention-row"][data-user="${userId}"]`);
  await expect(r).toBeVisible({ timeout: 10_000 });
  await r.click();
}

test.describe('FE-672 C4 三端互发互收（H5）', () => {
  test.skip(!RUN, '跨端用例要协调脚本传 TT_XP');

  test('TC-RCL-01-01、02-04、QUO-01-01、MEN-01-01（跨端，H5 发）', async ({ browser }) => {
    test.skip(PHASE !== 'send', 'TT_XP_PHASE=send');
    test.setTimeout(180_000);
    const page = await open(browser, user(ME));
    // ① 单聊撤回
    for (const q of others(ME)) {
      await page.goto(chatUrl(c2cId(user(ME), user(q))));
      await input(page).fill(recallText(ME, q));
      await input(page).press('Enter');
      await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent', { timeout: 30_000 });
      await menuItem(page, recallText(ME, q), 'menu-recall');
      await expect(page.getByTestId('msg-recalled').last()).toHaveText('你撤回了一条消息');
      await expect(bubble(page, recallText(ME, q))).toHaveCount(0);
    }
    // ② m 群：引用 q1 的消息回复；@ q1、q2
    const [q1, q2] = others(ME);
    await page.goto(chatUrl(mGroup(ME)));
    await menuItem(page, quoted(ME), 'menu-quote');
    await expect(page.getByTestId('quote-bar-text')).toHaveText(`${user(q1)}: ${quoted(ME)}`);
    await input(page).fill(reply(ME));
    await input(page).press('Enter');
    await expect(bubble(page, reply(ME)).getByTestId('msg-quote')).toHaveText(`${user(q1)}: ${quoted(ME)}`);
    await input(page).click();
    await pickMention(page, user(q1));
    await pickMention(page, user(q2));
    await page.keyboard.type(mention(ME));
    await expect(input(page)).toHaveValue(`@${user(q1)} @${user(q2)} ${mention(ME)}`);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.sent.find((f) => f.cmd === 'send' && f.data?.body?.text?.endsWith(mention(ME)))?.data?.body)
      .toBeTruthy();
    const body = page.sent.find((f) => f.cmd === 'send' && f.data?.body?.text?.endsWith(mention(ME)))!.data!.body!;
    expect([...body.mentions!.userIds].sort()).toEqual([user(q1), user(q2)].sort());
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent', { timeout: 30_000 });
    // ③ r 群：群主撤回两个成员的消息（先 q2 的，它是最后一条）
    await page.goto(chatUrl(rGroup(ME)));
    for (const q of [q2, q1]) {
      await menuItem(page, seed(q, ME), 'menu-recall');
      await expect(page.getByTestId('msg-recalled').filter({ hasText: `你撤回了 ${user(q)} 的一条消息` })).toHaveCount(
        1,
      );
    }
    await expect(page.locator('[data-testid="message"]', { hasText: 'XP4-r-' })).toHaveCount(0); // 宽屏左边的列表可能有别人的群
    await page.goto('/chats');
    await expect(row(page, rGroup(ME)).locator('.tt-conv-summary')).toHaveText(`你撤回了 ${user(q2)} 的一条消息`);
    await page.context().close();
  });

  test('TC-RCL-01-01、02-04、03-03、QUO-01-01、MEN-01-01（跨端，H5 收）', async ({ browser }) => {
    test.skip(PHASE !== 'receive', 'TT_XP_PHASE=receive');
    test.setTimeout(180_000);
    const from = (process.env.TT_XP_FROM ?? others(ME).join(',')).split(',').filter(Boolean) as P[];
    expect(from.length).toBeGreaterThan(0);
    for (const p of from) expect(others(ME)).toContain(p);
    const page = await open(browser, user(ME));
    for (const p of from) {
      const [q1, q2] = others(p);
      // 列表：m 群"[有人@我]"，单聊和 r 群是撤回文案
      await page.goto('/chats');
      await expect(row(page, mGroup(p)).getByTestId('mention-tag')).toHaveText('[有人@我]', { timeout: 30_000 });
      const c2c = c2cId(user(ME), user(p));
      await expect(row(page, c2c).locator('.tt-conv-summary')).toContainText('撤回了一条消息');
      const last = q2 === ME ? `${user(p)}撤回了你的一条消息` : `${user(p)}撤回了一条成员消息`;
      await expect(row(page, rGroup(p)).locator('.tt-conv-summary')).toHaveText(last);
      // 单聊
      await page.goto(chatUrl(c2c));
      await expect(page.getByTestId('msg-recalled').filter({ hasText: '对方撤回了一条消息' }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[data-testid="message"]', { hasText: recallText(p, ME) })).toHaveCount(0);
      // m 群：引用、提及
      await page.goto(chatUrl(mGroup(p)));
      await expect(bubble(page, reply(p)).getByTestId('msg-quote')).toHaveText(`${user(q1)}: ${quoted(p)}`, {
        timeout: 30_000,
      });
      await expect(page.locator('[data-testid="message"]', { hasText: mention(p) })).toHaveAttribute(
        'data-mentioned',
        'true',
      );
      // r 群：规则 1a 第 3 行
      await page.goto(chatUrl(rGroup(p)));
      await expect(page.getByTestId('msg-recalled').filter({ hasText: `${user(p)}撤回了你的一条消息` })).toHaveCount(
        1,
        {
          timeout: 30_000,
        },
      );
      await expect(page.getByTestId('msg-recalled').filter({ hasText: `${user(p)}撤回了一条成员消息` })).toHaveCount(1);
      await expect(page.locator('[data-testid="message"]', { hasText: 'XP4-r-' })).toHaveCount(0); // 宽屏左边的列表可能有别人的群
    }
    await page.context().close();
  });
});
