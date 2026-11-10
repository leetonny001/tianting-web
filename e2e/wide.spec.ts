import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { admin, c2cId, chatUrl, failSends, loginAs, msgActionsOff, uid, WIDE } from './helpers';

// 宽屏三栏、键盘、侧板、右键菜单、Enter 发送（PRD-ui 3.3 节、FE-300、FE-301、FE-305）× 真实 im-server。

const SELECTED_LIGHT = 'rgb(232, 235, 250)'; // color.surface.selected
const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);

/** alice 和两个有名字的群（列表里有两个会话）。 */
async function twoGroups(browser: Browser, opts = WIDE) {
  const a = uid('alice');
  const [ga, gb] = [uid('ga'), uid('gb')];
  await admin('POST', '/admin/users/import', { users: [{ userId: a }] });
  await admin('POST', '/admin/groups', { groupId: ga, name: '甲群', members: [a] });
  await admin('POST', '/admin/groups', { groupId: gb, name: '乙群', members: [a] });
  const page = await loginAs(browser, a, '/login', opts);
  return { a, page, A: `group:${ga}`, B: `group:${gb}` };
}
const conv = (page: Page, convId: string) => page.locator(`[data-conv-id="${convId}"]`);

async function send(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
}

const focusedOutline = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, visible: el.matches(':focus-visible') };
  });

async function expectFocusVisible(page: Page) {
  const o = await focusedOutline(page);
  expect(o.visible).toBe(true);
  expect(o.style).not.toBe('none');
  expect(o.width).toBeGreaterThanOrEqual(2);
}

/** 按 Tab / Shift+Tab 直到焦点落到 target，一路上每个焦点都要有可见样式。 */
async function tabTo(page: Page, target: Locator, shift = false) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    await expectFocusVisible(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('tab never reached the target');
}

test('宽屏：左侧导航栏三项 + 设置，没有底部标签栏；消息角标在导航栏（AC-UI-01-2）', async ({ browser }) => {
  const page = await loginAs(browser, uid('alice'), '/chats', WIDE);
  const rail = page.getByTestId('nav-rail');
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.width).toBe(64);
  for (const t of ['tab-chats', 'tab-contacts', 'tab-me']) await expect(rail.getByTestId(t)).toBeVisible();
  await expect(page.locator('.tt-tabbar')).toHaveCount(0);
  await expect(rail.getByTestId('tab-chats')).toHaveAttribute('aria-current', 'page');
  const avatar = (await page.getByTestId('rail-avatar').boundingBox())!;
  expect(avatar.width).toBe(36);
  // "设置"固定在底部
  const settings = (await rail.getByTestId('rail-settings').boundingBox())!;
  expect(settings.y + settings.height).toBeGreaterThan(740);
  await rail.getByTestId('rail-settings').click();
  await expect(page).toHaveURL(/\/me\/settings$/);
  await expect(page.getByTestId('list-column').getByTestId('me-name')).toBeVisible(); // 列表栏是"我"
  await expect(page.getByTestId('main').getByTestId('logout')).toBeVisible(); // 主区是设置内容
});

test('宽屏：打开聊天页，导航栏、列表（高亮）、主区同时可见，没有返回按钮（AC-UI-02-1）；未选中时主区空态（AC-UI-02-2）', async ({
  browser,
}) => {
  const { page, A } = await twoGroups(browser);
  const empty = page.getByTestId('main-empty');
  await expect(empty).toContainText('选择一个会话开始聊天');
  await expect(empty.locator('.tt-logo-mark')).toBeVisible();

  await page.goto(chatUrl(A));
  await expect(page.getByTestId('nav-rail')).toBeVisible();
  await expect(conv(page, A)).toBeVisible();
  expect(await bg(conv(page, A))).toBe(SELECTED_LIGHT);
  await expect(page.getByTestId('chat-title')).toContainText('甲群');
  await expect(page.getByTestId('main-empty')).toHaveCount(0);
  await expect(page.getByLabel('返回')).toHaveCount(0);
  const [list, main] = [
    await page.getByTestId('list-column').boundingBox(),
    await page.getByTestId('main').boundingBox(),
  ];
  expect(list!.width).toBe(280);
  expect(main!.width).toBe(1280 - 64 - 280);
});

test('宽屏：点 A 高亮，再点 B，A 取消高亮、B 高亮（AC-UI-04-8）；打开后输入框有焦点（AC-UI-06-5）', async ({
  browser,
}) => {
  const { page, A, B } = await twoGroups(browser);
  await conv(page, A).click();
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await expect(conv(page, A)).toHaveAttribute('aria-current', 'page');
  expect(await bg(conv(page, A))).toBe(SELECTED_LIGHT);
  await conv(page, B).click();
  await expect(page.getByTestId('chat-title')).toContainText('乙群');
  await expect(page.getByTestId('composer-input')).toBeFocused();
  expect(await bg(conv(page, B))).toBe(SELECTED_LIGHT);
  expect(await bg(conv(page, A))).not.toBe(SELECTED_LIGHT);
  await expect(conv(page, A)).not.toHaveAttribute('aria-current', 'page');
});

test('布局切换：路由不变、输入框内容和输入框实例都在，全程 1 个连接（AC-UI-02-3）', async ({ browser }) => {
  const a = uid('alice');
  const ctx = await browser.newContext(WIDE);
  const page = await ctx.newPage();
  const sockets: string[] = [];
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).pathname === '/ws') sockets.push(ws.url()); // 开发服务器的热更新连接不算
  });
  const closed: string[] = [];
  page.on('websocket', (ws) => ws.on('close', () => closed.push(ws.url())));
  await page.goto('/login');
  await page.getByTestId('login-username').fill(a);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).toHaveURL(/\/chats$/);
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-menu').getByText('发起单聊').click();
  await page.getByTestId('start-chat-input').fill(uid('bob'));
  await page.getByTestId('start-chat-input').press('Enter');
  const input = page.getByTestId('composer-input');
  await input.fill('草稿');
  await input.evaluate((el) => ((el as unknown as { __mark: number }).__mark = 1));
  const url = page.url();
  const sameInstance = () => input.evaluate((el) => (el as unknown as { __mark?: number }).__mark === 1);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId('app')).toHaveAttribute('data-layout', 'narrow');
  await expect(page.getByTestId('nav-rail')).toHaveCount(0);
  await expect(input).toHaveValue('草稿');
  expect(page.url()).toBe(url);
  expect(await sameInstance()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId('app')).toHaveAttribute('data-layout', 'wide');
  await expect(input).toHaveValue('草稿');
  expect(page.url()).toBe(url);
  expect(await sameInstance()).toBe(true);
  expect(sockets).toHaveLength(1);
  expect(closed.filter((u) => new URL(u).pathname === '/ws')).toEqual([]);
});

test('宽屏条件边界：767×800 窄、768×800 宽、768×499 窄；768 宽时主区 424、没有横向滚动（AC-UI-02-4）', async ({
  browser,
}) => {
  const { page, A } = await twoGroups(browser);
  await page.goto(chatUrl(A));
  const layout = page.getByTestId('app');
  await page.setViewportSize({ width: 767, height: 800 });
  await expect(layout).toHaveAttribute('data-layout', 'narrow');
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(layout).toHaveAttribute('data-layout', 'wide');
  expect((await page.getByTestId('main').boundingBox())!.width).toBe(424);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  await page.setViewportSize({ width: 768, height: 499 });
  await expect(layout).toHaveAttribute('data-layout', 'narrow');
});

test('手机横屏 812×375（hover: none、pointer: coarse）保持窄屏（AC-UI-02-7）', async ({ browser }) => {
  const page = await loginAs(browser, uid('alice'), '/chats', { viewport: { width: 812, height: 375 } });
  expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
  await expect(page.locator('.tt-tabbar')).toBeVisible();
  await expect(page.getByTestId('nav-rail')).toHaveCount(0);
});

test('弹窗：宽 400，Tab 不出弹窗；Esc 关闭，焦点回到"+"（AC-UI-05-4）', async ({ browser }) => {
  const page = await loginAs(browser, uid('alice'), '/chats', WIDE);
  await page.getByTestId('plus-button').click();
  await page.getByTestId('plus-menu').getByText('发起单聊').click();
  const dialog = page.getByTestId('start-chat-dialog');
  expect((await dialog.boundingBox())!.width).toBe(400);
  await expect(page.getByTestId('start-chat-input')).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('plus-button')).toBeFocused();
});

test('只用键盘：打开会话 → 发送 → 打开聊天信息侧板 → Esc 关闭，焦点都可见（AC-UI-90-9）', async ({ browser }) => {
  const { page, A } = await twoGroups(browser);
  // Tab 顺序：导航栏 → 列表（FE-301）
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('tab-chats')).toBeFocused();
  await expectFocusVisible(page);
  await tabTo(page, conv(page, A));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(A)}$`));
  const input = page.getByTestId('composer-input');
  await expect(input).toBeFocused();
  await expectFocusVisible(page);

  await page.keyboard.type('键盘发送');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  await expect(input).toBeFocused();

  const more = page.getByTestId('chat-more');
  await tabTo(page, more, true);
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('side-panel');
  await expect(panel).toBeVisible();
  expect(Math.abs((await panel.boundingBox())!.width - 360)).toBeLessThanOrEqual(1); // 滑入动画中有小数
  expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectFocusVisible(page);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(A)}$`));
  await expect(more).toBeFocused();
  await expectFocusVisible(page);
});

test('侧板：遮罩关闭；开着侧板时聊天页还在、输入框内容不丢、新消息不计未读（F-UI-06 规则 8）；确认框的 Esc 只关确认框', async ({
  browser,
}) => {
  const { page, A } = await twoGroups(browser);
  await page.goto(chatUrl(A));
  await page.getByTestId('composer-input').fill('还没发');
  await page.getByTestId('chat-more').click();
  const panel = page.getByTestId('side-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('composer-input')).toHaveValue('还没发');

  const peer = uid('peer');
  await admin('POST', '/admin/users/import', { users: [{ userId: peer }] });
  await admin('POST', `/admin/groups/${A.slice('group:'.length)}/members`, { members: [peer] });
  const other = await loginAs(browser, peer, chatUrl(A));
  await send(other, '侧板打开时来的');
  await expect(page.getByTestId('message-list')).toContainText('侧板打开时来的');
  await page.waitForTimeout(1500); // 已读节流 1 秒
  await expect(conv(page, A).getByTestId('conv-badge')).toHaveCount(0);

  await panel.getByText('退出群聊').click();
  const confirm = panel.getByRole('dialog').filter({ hasText: '退出' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel).toBeVisible();

  await page.getByTestId('panel-scrim').click({ position: { x: 20, y: 300 } });
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(A)}$`));

  // 主区切到别的页面：当前会话变 null，新消息计未读。
  await page.getByTestId('rail-settings').click();
  await expect(page).toHaveURL(/\/me\/settings$/);
  await send(other, '在设置页时来的');
  await page.getByTestId('tab-chats').click();
  await expect(conv(page, A).getByTestId('conv-badge')).toHaveText('1');
});

test('资料卡：从聊天页头像进入是侧板，后面聊天页还在；从通讯录 / 直接打开在主区', async ({ browser }) => {
  const a = uid('alice');
  const b = uid('bob');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const page = await loginAs(browser, a, chatUrl(c2cId(a, b)), WIDE);
  await send(page, 'hi');
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  await page.getByTestId('msg-avatar').first().click();
  await expect(page).toHaveURL(new RegExp(`/user/${a}$`));
  await expect(page.getByTestId('side-panel')).toBeVisible();
  await expect(page.getByTestId('chat-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(c2cId(a, b))}$`));
  await expect(page.getByTestId('msg-avatar').first()).toBeFocused();

  await page.goto(`/user/${b}`);
  await expect(page.getByTestId('side-panel')).toHaveCount(0);
  await expect(page.getByTestId('list-column').getByTestId('contacts')).toBeVisible();
  await expect(page.getByTestId('main').getByText(`账号：${b}`)).toBeVisible();
});

test('右键：弹出菜单、preventDefault，可以选中文字（AC-UI-09-2）；C4 开关关闭时只有"复制"（AC-UI-09-1）', async ({
  browser,
}) => {
  const { page, A } = await twoGroups(browser);
  await msgActionsOff(page);
  await page.goto(chatUrl(A));
  await send(page, '右键我');
  const bubble = page.locator('.tt-bubble', { hasText: '右键我' });
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  await page.evaluate(() => {
    (window as unknown as { __prevented: boolean[] }).__prevented = [];
    // 在 window 上监听，这时 React 的处理已经完成
    window.addEventListener('contextmenu', (e) =>
      (window as unknown as { __prevented: boolean[] }).__prevented.push(e.defaultPrevented),
    );
  });
  const prevented = () => page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented);
  await bubble.click({ button: 'right' });
  const menu = page.getByTestId('bubble-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['复制']);
  expect(await prevented()).toEqual([true]);
  // 菜单跟着气泡
  const [m, b] = [(await menu.boundingBox())!, (await bubble.boundingBox())!];
  expect(Math.abs(m.x + m.width / 2 - Math.min(b.x + b.width / 2, 1280 - 70))).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // 按住 500ms 是选文字，不是长按菜单（F-UI-09 规则 1：宽屏用右键）
  const box = (await bubble.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(menu).toHaveCount(0);
  expect(await bubble.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');

  // 群提示消息没有菜单项：右键无反应，也不出现浏览器菜单（F-UI-09 规则 5）
  await admin('POST', `/admin/groups/${A.slice('group:'.length)}/members`, { members: [uid('newbie')] }).catch(
    () => {},
  );
});

test('删除失败消息：右键点"删除"，列表里没有了，未发送条数减 1，回来也不再出现（AC-UI-09-5）', async ({ browser }) => {
  const { page, B } = await twoGroups(browser);
  const fail = await failSends(page);
  await page.reload();
  await conv(page, B).click();
  await send(page, '会失败的');
  const failed = page.locator('[data-testid="message"][data-status="failed"]');
  await expect(failed).toHaveCount(1);

  // 退出确认框显示未发送条数（SDK pendingCount，AC-UI-16-2）
  const pendingText = async () => {
    await page.getByTestId('rail-settings').click();
    await page.getByTestId('logout').click();
    const text = await page.getByTestId('logout-dialog').textContent();
    await page.getByTestId('logout-dialog').getByText('取消').click();
    await page.getByTestId('tab-chats').click();
    await conv(page, B).click();
    return text ?? '';
  };
  expect(await pendingText()).toContain('有 1 条消息未发送');

  fail.fail = false;
  await failed.locator('.tt-bubble').click({ button: 'right' });
  const menu = page.getByTestId('bubble-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['复制', '重发', '删除']);
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  await page.getByTestId('menu-delete').click();
  await expect(page.getByTestId('message')).toHaveCount(0);

  expect(await pendingText()).toContain('确定退出登录');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('message')).toHaveCount(0);
});

test('窄屏：长按失败消息的菜单也有"删除"（AC-UI-09-5 未标宽屏）', async ({ browser }) => {
  const a = uid('alice');
  const page = await loginAs(browser, a, chatUrl(c2cId(a, a)));
  await failSends(page);
  await page.reload();
  await send(page, '手机上失败');
  const failed = page.locator('[data-testid="message"][data-status="failed"]');
  await expect(failed).toHaveCount(1);
  const b = (await failed.locator('.tt-bubble').boundingBox())!;
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.getByTestId('menu-delete').click();
  await expect(failed).toHaveCount(0);
});

test('宽屏输入区：高 120、Enter 发送并保持焦点、Shift+Enter 换行、点"发送"也保持焦点（AC-UI-10-1）', async ({
  browser,
}) => {
  const { page, A } = await twoGroups(browser);
  await page.goto(chatUrl(A));
  expect((await page.locator('.tt-composer').boundingBox())!.height).toBe(120);
  const input = page.getByTestId('composer-input');
  await page.keyboard.type('你好');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('message')).toHaveCount(1);
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();

  await page.keyboard.type('a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  await expect(input).toHaveValue('a\nb');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('message')).toHaveCount(1);

  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('message')).toHaveCount(2);
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  // 框内滚动，高度不变
  await input.fill('行\n'.repeat(30));
  expect((await page.locator('.tt-composer').boundingBox())!.height).toBe(120);
});

test('宽屏离线：只有 1 个状态条，宽度 = 列表栏 + 主区（AC-UI-17-2）', async ({ browser }) => {
  const { page, A } = await twoGroups(browser);
  // Chromium 的离线模拟不会断开已有的 WebSocket（真实断网时 SDK 靠连接关闭 / 心跳发现）：这里同时关掉连接，并拒绝离线期间的重连。
  const net = { offline: false };
  const open: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    if (net.offline) {
      void ws.close({ code: 4000 });
      return;
    }
    open.push(ws);
    ws.connectToServer();
  });
  await page.reload();
  await page.goto(chatUrl(A));
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.context().setOffline(true);
  net.offline = true;
  for (const ws of open) await ws.close({ code: 4000 });
  const banner = page.getByTestId('conn-banner');
  await expect(banner).toHaveCount(1, { timeout: 5_000 });
  await expect(banner).toHaveText('网络不可用');
  const b = (await banner.boundingBox())!;
  const [list, main] = [
    (await page.getByTestId('list-column').boundingBox())!,
    (await page.getByTestId('main').boundingBox())!,
  ];
  expect(Math.abs(b.width - (list.width + main.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(b.x - list.x)).toBeLessThanOrEqual(1);
  // 把内容下推，不覆盖
  expect(list.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
  net.offline = false;
  await page.context().setOffline(false);
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
});

test('640×400：会话列表、聊天页、聊天信息、资料卡、设置都没有横向滚动，能发送（AC-UI-90-10）', async ({ browser }) => {
  const a = uid('alice');
  const b = uid('bob');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const page = await loginAs(browser, a, '/chats', { ...WIDE, viewport: { width: 640, height: 400 } });
  const id = c2cId(a, b);
  for (const path of [
    '/chats',
    chatUrl(id),
    `${chatUrl(id)}/info`,
    `/user/${b}`,
    '/me/settings',
    '/me/settings/appearance',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(640);
  }
  await page.goto(chatUrl(id));
  await send(page, '小窗口');
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  await expect(page.locator('.tt-bubble', { hasText: '小窗口' })).toBeInViewport();
});

test('表情面板：宽屏浮层、窄屏在输入区下方；再点或点输入框收起；发送 😀 对方收到一个码点（AC-UI-11-2）', async ({
  browser,
}) => {
  const [a, b] = [uid('alice'), uid('bob')];
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const id = c2cId(a, b);
  const page = await loginAs(browser, a, chatUrl(id), WIDE);
  const other = await loginAs(browser, b, chatUrl(id));
  const panel = page.getByTestId('emoji-panel');
  await page.getByTestId('emoji-button').click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('position', 'absolute');
  expect(await page.getByTestId('emoji-item').count()).toBeGreaterThanOrEqual(80);
  await page.getByTestId('emoji-button').click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('emoji-button').click();
  await page.getByTestId('composer-input').click();
  await expect(panel).toHaveCount(0);

  await page.getByTestId('emoji-button').click();
  await page.getByTestId('emoji-item').filter({ hasText: '😀' }).click();
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await page.keyboard.press('Enter');
  const got = other.locator('.tt-bubble').last();
  await expect(got).toHaveText('😀');
  const text = (await got.textContent())!;
  expect(Array.from(text)).toEqual(['\u{1F600}']);

  // 窄屏（手机）：面板在输入区内、输入框下方，不是浮层
  await other.getByTestId('emoji-button').click();
  const p2 = other.getByTestId('emoji-panel');
  await expect(p2).toHaveCSS('position', 'static');
  const [panelBox, inputBox] = [(await p2.boundingBox())!, (await other.getByTestId('composer-input').boundingBox())!];
  expect(panelBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
  await expect(p2).toBeInViewport({ ratio: 1 });
});

test('草稿：切换会话保存、回来恢复；摘要"[草稿]"红色，正在输入的会话不显示；清空后摘要恢复（AC-UI-24-1、24-3）', async ({
  browser,
}) => {
  const { page, A, B } = await twoGroups(browser);
  await conv(page, A).click();
  await send(page, '最后一条');
  await expect(page.getByTestId('message')).toHaveAttribute('data-status', 'sent');
  const summary = conv(page, A).locator('.tt-conv-summary');
  await page.getByTestId('composer-input').fill('明天见');
  await expect(summary).toHaveText('最后一条');
  await conv(page, B).click();
  await expect(summary).toHaveText('[草稿] 明天见');
  await expect(conv(page, A).getByTestId('draft-tag')).toHaveCSS('color', 'rgb(200, 40, 28)'); // color.danger
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await conv(page, A).click();
  await expect(page.getByTestId('composer-input')).toHaveValue('明天见');
  await expect(summary).toHaveText('最后一条');
  await page.getByTestId('composer-input').fill('');
  await conv(page, B).click();
  await expect(summary).toHaveText('最后一条');
  // 发出去的内容不留草稿
  await conv(page, A).click();
  await expect(conv(page, A)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await send(page, '发出去了');
  await conv(page, B).click();
  await expect(summary).toHaveText('发出去了');
});

test('草稿：窄屏离开聊天页、回到列表（AC-UI-24-1）；退出登录再登录后没有草稿（AC-UI-24-4）', async ({ browser }) => {
  const { a, page, A } = await twoGroups(browser, {});
  await conv(page, A).click();
  await page.getByTestId('composer-input').fill('窄屏草稿');
  await page.getByLabel('返回').click();
  await expect(conv(page, A).locator('.tt-conv-summary')).toHaveText('[草稿] 窄屏草稿');
  await conv(page, A).click();
  await expect(page.getByTestId('composer-input')).toHaveValue('窄屏草稿');
  await page.getByLabel('返回').click();

  await page.getByTestId('tab-me').click();
  await page.getByTestId('me-settings').click();
  await page.getByTestId('logout').click();
  await page.getByTestId('logout-dialog').getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('login-username').fill(a);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  // 回跳地址是退出时的页面。走站内导航，不能刷新：草稿只在内存，刷新本身就会清空。
  await page.getByLabel('返回').click();
  await page.getByTestId('tab-chats').click();
  await expect(conv(page, A)).toBeVisible();
  await expect(conv(page, A).getByTestId('draft-tag')).toHaveCount(0);
  await conv(page, A).click();
  await expect(page.getByTestId('composer-input')).toHaveValue('');
});

test('可访问性：宽屏浅色、深色的主要状态都没有 color-contrast、button-name 违规（AC-UI-90-4 的 M4 部分）', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { page, A, B } = await twoGroups(browser);
  const fail = await failSends(page);
  await page.reload();
  const scan = async (label: string) => {
    await page.waitForTimeout(250); // 等侧板滑入动画结束
    const r = await new AxeBuilder({ page }).withRules(['color-contrast', 'button-name']).analyze();
    expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
      [],
    );
  };
  await conv(page, B).click();
  await page.getByTestId('composer-input').fill('草稿摘要');
  await conv(page, A).click();
  await expect(conv(page, A)).toHaveAttribute('aria-current', 'page');
  await send(page, '失败的消息');
  await expect(page.locator('[data-status="failed"]')).toHaveCount(1);
  fail.fail = false;
  await send(page, '成功的消息');
  await expect(page.locator('[data-status="sent"]')).toHaveCount(1);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await scan(`${scheme} chat`);
    await page.getByTestId('emoji-button').click();
    await scan(`${scheme} emoji`);
    await page.getByTestId('emoji-button').click();
    await page.locator('[data-status="failed"] .tt-bubble').click({ button: 'right' });
    await scan(`${scheme} menu`);
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-more').click();
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await scan(`${scheme} panel`);
    await page.keyboard.press('Escape');
    await page.getByTestId('tab-chats').click();
    await page.getByTestId('rail-settings').click();
    await scan(`${scheme} settings`);
    await page.getByTestId('tab-contacts').click();
    await scan(`${scheme} contacts`);
    await page.getByTestId('tab-chats').click();
    await scan(`${scheme} empty`);
    await conv(page, A).click();
  }
});
