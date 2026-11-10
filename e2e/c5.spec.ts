// FE-683（PRD-chat C5）：会话菜单、置顶和免打扰的显示、删除、总未读（IM_CONV_SETTINGS_ENABLED=1，演示登录）。
// 两类用例：
// - 真实 im-server：convSet（BE-484）已有；convDelete（BE-485）和 convSettingsChanged、convDelete 事件（BE-486）没有之前，
//   这些用例在服务端回 4001 或收不到事件时如实失败，不跳过、不放宽（"等 BE-483～486"）。
// - 改写帧（routeWebSocket）：服务端还没有的 ack 和事件由测试回给页面，先验页面自己的行为（标题里写"改写帧"）。
// 帧内容（消息原文）只在内存里断言，不打印。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { demoToken, makePng, uploadFile } from './files';
import { admin, c2cId, chatUrl, signed, uid, WIDE } from './helpers';
import { SERVER } from './ports';

// ---- 工具 ----

type Frame = { id?: string; cmd?: string; data?: Record<string, unknown>; error?: { code: number; msg?: string } };

/** 用 WebSocket 以某个用户直接调命令（预先放消息、设置免打扰）。每个调用等 ack。 */
async function wsAs(userId: string) {
  const token = await demoToken(userId);
  const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws?platform=web');
  const pending = new Map<string, (f: Frame) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as Frame;
    if (f.id) pending.get(f.id)?.(f);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws error'));
  });
  ws.onclose = (e) => {
    for (const [, r] of pending) r({ error: { code: e.code } });
    pending.clear();
  };
  let n = 0;
  const call = (cmd: string, data: unknown) =>
    new Promise<Frame>((res) => {
      const id = `c5-${++n}`;
      pending.set(id, (f) => {
        pending.delete(id);
        res(f);
      });
      ws.send(JSON.stringify({ id, cmd, data }));
    });
  const auth = await call('auth', { token });
  if (auth.error) throw new Error(`auth ${auth.error.code}`);
  /** 4290（发送、会话设置的限流）时等一下再调。 */
  const retry = async (cmd: string, data: unknown) => {
    for (let tries = 0; ; tries++) {
      const r = await call(cmd, data);
      if (r.error?.code === 4290 && tries < 100) {
        await new Promise((ok) => setTimeout(ok, 250));
        continue;
      }
      if (r.error) throw new Error(`${cmd} ${r.error.code}`);
      return r.data as Record<string, unknown>;
    }
  };
  return {
    token,
    send: (convType: 'c2c' | 'group', to: string, body: Record<string, unknown>, type = 'text') =>
      retry('send', { convType, to, type, body, clientMsgId: randomBytes(8).toString('hex') }) as Promise<{
        msgId: string;
        seq: number;
      }>,
    ok: retry,
    close: () => ws.close(),
  };
}

async function users(list: Record<string, string>) {
  await admin('POST', '/admin/users/import', {
    users: Object.entries(list).map(([userId, nickname]) => ({ userId, nickname })),
  });
}

async function groupOf(owner: string, members: string[], name = 'C5 群') {
  const g = uid('g');
  await signed('/admin/groups', { groupId: g, name, members: [owner, ...members], owner });
  return `group:${g}`;
}

/** 新上下文里演示登录，记下页面发出的 WebSocket 帧（只在内存）。默认窄屏（Pixel 7，触屏）。 */
async function open(browser: Browser, userId: string, opts?: BrowserContextOptions, path = '/chats') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const sent: Frame[] = [];
  const got: Frame[] = [];
  const parse = (into: Frame[]) => (f: { payload: string | Buffer }) => {
    try {
      into.push(JSON.parse(String(f.payload)) as Frame);
    } catch {
      // 不是 JSON 的帧不管
    }
  };
  // 没有被 routeWebSocket 接管的连接才有这两个事件；接管的由 intercept、switchable 记
  page.on('websocket', (ws) => {
    ws.on('framesent', parse(sent));
    ws.on('framereceived', parse(got));
  });
  await page.goto('/login');
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  if (path !== '/chats') await page.goto(path);
  return Object.assign(page, { sent, got });
}
type P = Awaited<ReturnType<typeof open>>;

/** 等这个命令最近一次请求的 ack，返回它（服务端没有这个命令时是 4001）。 */
async function ackOf(p: P, cmd: string): Promise<Frame> {
  const id = p.sent.filter((f) => f.cmd === cmd).at(-1)?.id;
  expect(id, `${cmd} sent`).toBeTruthy();
  await expect.poll(() => p.got.some((f) => f.id === id), { message: `${cmd} ack` }).toBe(true);
  return p.got.find((f) => f.id === id)!;
}

/**
 * 改写帧（PRD-ui 2.2 节的 routeWebSocket）：up 返回 true 表示这条上行由测试回答（reply 回给页面），不转给服务端；
 * down 可以改下行或返回 null 丢掉。push 给页面塞一条帧（假装是服务端的事件）。设置后重新加载，SDK 走新连接。
 */
async function intercept(
  page: P,
  hooks: { up?: (f: Frame, reply: (r: Frame) => void) => boolean; down?: (f: Frame) => Frame | null } = {},
) {
  const st: { push: (f: Frame) => void } = { push: () => {} };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    st.push = (f) => (page.got.push(f), ws.send(JSON.stringify(f)));
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as Frame;
      page.sent.push(f);
      if (hooks.up?.(f, (r) => (page.got.push(r), ws.send(JSON.stringify(r))))) return;
      server.send(m);
    });
    server.onMessage((m) => {
      const f = JSON.parse(String(m)) as Frame;
      const out = hooks.down ? hooks.down(f) : f;
      if (!out) return;
      page.got.push(out);
      ws.send(JSON.stringify(out));
    });
  });
  await page.reload();
  await expect(page.getByTestId('conv-list')).toBeVisible();
  return st;
}

/** 可以"断网"的页面（同 c4.spec.ts）：offline 期间关掉连接，新连接挂着不接通，online 后再接上。 */
async function switchable(page: P) {
  const st = { online: true, waiters: [] as (() => void)[], close: () => {} };
  await page.routeWebSocket(/\/ws(\?|$)/, async (ws) => {
    if (!st.online) await new Promise<void>((r) => st.waiters.push(r));
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      page.sent.push(JSON.parse(String(m)) as Frame);
      server.send(m);
    });
    server.onMessage((m) => {
      page.got.push(JSON.parse(String(m)) as Frame);
      ws.send(m);
    });
    st.close = () => {
      void ws.close({ code: 1011, reason: 'test offline' });
      void server.close();
    };
  });
  await page.reload();
  return {
    offline() {
      st.online = false;
      st.close();
    },
    online() {
      st.online = true;
      for (const w of st.waiters.splice(0)) w();
    },
  };
}

const item = (page: Page, convId: string) => page.locator(`[data-testid="conv-item"][data-conv-id="${convId}"]`);
const order = (page: Page) =>
  page.getByTestId('conv-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-conv-id')));
const summary = (page: Page, convId: string) => item(page, convId).locator('.tt-conv-summary');
const convMenu = (page: Page) => page.getByTestId('conv-menu');
const menuTexts = (page: Page) => convMenu(page).getByRole('menuitem').allTextContents();
const input = (page: Page) => page.getByTestId('composer-input');
const sentCmd = (p: P, cmd: string) => p.sent.filter((f) => f.cmd === cmd);

/** 窄屏长按（按住 600ms，PRD-ui F-UI-09 规则 1 的 500ms）。 */
async function longPress(page: Page, l: Locator) {
  const b = (await l.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

/** 只用 Tab 走到某个元素（最多 60 下）。 */
async function tabTo(page: Page, target: Locator) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  expect(await target.evaluate((el) => el === document.activeElement)).toBe(true);
}

const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
/** token 在当前配色下解析出来的颜色（和 getComputedStyle 同一种写法，便于比较）。 */
const tokenColor = (page: Page, name: string) =>
  page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.background = `var(${n})`;
    document.body.append(d);
    const c = getComputedStyle(d).backgroundColor;
    d.remove();
    return c;
  }, name);

const axeProblems = async (page: Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.id === 'button-name' || v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
};

/** u1 有 3 个会话：和 u2、u3 的单聊（u3 的最新），一个群（最旧，没有消息）。 */
async function threeConvs(prefix: string) {
  const [u1, u2, u3] = [uid(`${prefix}a`), uid(`${prefix}b`), uid(`${prefix}c`)];
  await users({ [u1]: '小一', [u2]: '小二', [u3]: '小三' });
  const g = await groupOf(u2, [u1, u3]);
  const w2 = await wsAs(u2);
  await w2.send('c2c', u1, { text: '二的消息' });
  w2.close();
  const w3 = await wsAs(u3);
  await w3.send('c2c', u1, { text: '三的消息' });
  w3.close();
  return { u1, u2, u3, g, c2: c2cId(u1, u2), c3: c2cId(u1, u3) };
}

// ---- 会话菜单（AC-CVS-01-6） ----

test('TC-CVS-01-06 窄屏长按打开会话菜单（三项按状态），长按松手不进入聊天页；选"置顶"移到最前、背景来自 token', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('pa');
  const p = await open(browser, u1);
  await expect.poll(() => order(p)).toEqual([c3, c2, g]);
  await longPress(p, item(p, g));
  await expect(convMenu(p)).toBeVisible();
  expect(await menuTexts(p)).toEqual(['置顶', '免打扰', '删除']);
  await expect(p).toHaveURL(/\/chats$/);
  await expect(convMenu(p).getByRole('menuitem', { name: '置顶' })).toBeFocused();
  await convMenu(p).getByRole('menuitem', { name: '置顶' }).click();
  await expect(convMenu(p)).toHaveCount(0);
  await expect.poll(() => order(p)).toEqual([g, c3, c2]);
  expect(sentCmd(p, 'convSet').map((f) => f.data)).toEqual([{ convId: g, pinned: true }]);
  await expect(item(p, g)).toHaveAttribute('data-pinned', 'true');
  // ack 之后（真实服务端）仍然置顶
  await p.waitForTimeout(500);
  await expect(item(p, g)).toHaveAttribute('data-pinned', 'true');
  const pinnedBg = await tokenColor(p, '--tt-color-surface-pinned');
  expect(await bg(item(p, g))).toBe(pinnedBg);
  expect(await bg(item(p, c3))).not.toBe(pinnedBg);
  // 刷新后从 convs 拿到的也是置顶（服务端保存）
  await p.reload();
  await expect.poll(() => order(p)).toEqual([g, c3, c2]);
  await expect(item(p, g)).toHaveAttribute('data-pinned', 'true');
  await longPress(p, item(p, g));
  expect(await menuTexts(p)).toEqual(['取消置顶', '免打扰', '删除']);
  await p.context().close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`TC-CVS-01-06 宽屏右键、键盘菜单键和 Shift+F10 打开同一个菜单；置顶背景和普通项不同（${scheme}）`, async ({
    browser,
  }) => {
    const { u1, g, c2, c3 } = await threeConvs(scheme === 'light' ? 'pb' : 'pd');
    const w1 = await wsAs(u1);
    await w1.ok('convSet', { convId: c2, pinned: true });
    w1.close();
    const p = await open(browser, u1, { ...WIDE, colorScheme: scheme });
    await expect.poll(() => order(p)).toEqual([c2, c3, g]);
    const normal = await bg(item(p, c3));
    const pinned = await bg(item(p, c2));
    expect(pinned).toBe(await tokenColor(p, '--tt-color-surface-pinned'));
    expect(pinned).not.toBe(normal);

    await item(p, c3).click({ button: 'right' });
    await expect(convMenu(p)).toBeVisible();
    expect(await menuTexts(p)).toEqual(['置顶', '免打扰', '删除']);
    await expect(p).toHaveURL(/\/chats$/); // 右键不进入
    await p.keyboard.press('Escape');
    await expect(convMenu(p)).toHaveCount(0);

    await tabTo(p, item(p, c2));
    await p.keyboard.press('Shift+F10');
    await expect(convMenu(p)).toBeVisible();
    expect(await menuTexts(p)).toEqual(['取消置顶', '免打扰', '删除']);
    await expect(convMenu(p).getByRole('menuitem', { name: '取消置顶' })).toBeFocused();
    await p.keyboard.press('Escape');
    await expect(convMenu(p)).toHaveCount(0);
    await expect(item(p, c2)).toBeFocused();
    await p.keyboard.press('ContextMenu');
    await expect(convMenu(p)).toBeVisible();
    // 菜单不超出窗口
    const box = (await convMenu(p).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await p.context().close();
  });
}

test('TC-CVS-01-06 第 3 条：features.convSettings=false 时长按、右键、菜单键都不打开菜单；已有的置顶照常显示（P-46 ②）', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('pf');
  const w1 = await wsAs(u1);
  await w1.ok('convSet', { convId: g, pinned: true });
  w1.close();
  for (const opts of [undefined, WIDE]) {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/v1/config', async (route) => {
      const res = await route.fetch();
      const j = (await res.json()) as { features: Record<string, unknown> };
      j.features.convSettings = false;
      await route.fulfill({ response: res, json: j });
    });
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.getByTestId('login-username').fill(u1);
    await p.getByTestId('login-username').press('Enter');
    await expect.poll(() => order(p)).toEqual([g, c3, c2]);
    await expect(item(p, g)).toHaveAttribute('data-pinned', 'true');
    if (opts) {
      await item(p, c2).click({ button: 'right' });
      await tabTo(p, item(p, c3));
      await p.keyboard.press('ContextMenu');
      await p.keyboard.press('Shift+F10');
    } else {
      await longPress(p, item(p, c2));
    }
    await p.waitForTimeout(300);
    await expect(convMenu(p)).toHaveCount(0);
    await ctx.close();
  }
});

test('TC-CVS-01-02 的页面部分：已置顶 20 个时再置顶，服务端 4220，提示"最多置顶 20 个会话"，回到原位置', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const u1 = uid('pl');
  const u2 = uid('plb');
  await users({ [u1]: '小一', [u2]: '小二' });
  const groups: string[] = [];
  for (let i = 0; i < 21; i++) groups.push(await groupOf(u2, [u1], `群 ${i}`));
  const w1 = await wsAs(u1);
  for (const g of groups.slice(0, 20)) await w1.ok('convSet', { convId: g, pinned: true });
  w1.close();
  const p = await open(browser, u1, WIDE);
  const last = groups[20]!;
  await expect(item(p, last)).toBeVisible();
  const before = await order(p);
  expect(before.indexOf(last)).toBe(20);
  await item(p, last).click({ button: 'right' });
  await convMenu(p).getByRole('menuitem', { name: '置顶' }).click();
  await expect(p.getByTestId('toast')).toHaveText('最多置顶 20 个会话');
  await expect.poll(() => order(p)).toEqual(before);
  await expect(item(p, last)).not.toHaveAttribute('data-pinned');
  expect(sentCmd(p, 'convSet')).toHaveLength(1); // 不自动重试
  await p.context().close();
});

test('改写帧：convSet 4290 提示"操作过于频繁"、5000 提示"服务异常，请稍后重试"，都回滚、不自动重试', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('pr');
  const p = await open(browser, u1, WIDE);
  const codes = [4290, 5000];
  await intercept(p, {
    up: (f, reply) => {
      if (f.cmd !== 'convSet') return false;
      reply({ id: f.id, cmd: 'ack', error: { code: codes.shift() ?? 5000, msg: 'x' } });
      return true;
    },
  });
  for (const text of ['操作过于频繁', '服务异常，请稍后重试']) {
    await item(p, g).click({ button: 'right' });
    await convMenu(p).getByRole('menuitem', { name: '免打扰' }).click();
    await expect(p.getByTestId('toast').filter({ hasText: text })).toBeVisible();
    await expect(item(p, g)).not.toHaveAttribute('data-notify-off');
  }
  expect(await order(p)).toEqual([c3, c2, g]);
  expect(sentCmd(p, 'convSet')).toHaveLength(2);
  await p.context().close();
});

// ---- 免打扰和总未读（F-CVS-02） ----

test('TC-CVS-02-03 菜单设免打扰（真实 convSet）：未读 5 显示小红点、"[5 条]"、免打扰图标（可读名称"免打扰"）；取消后回到数字', async ({
  browser,
}) => {
  const [u1, u2] = [uid('na'), uid('nb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const w2 = await wsAs(u2);
  for (let i = 1; i <= 5; i++) await w2.send('c2c', u1, { text: `第 ${i} 条` });
  w2.close();
  const conv = c2cId(u1, u2);
  const p = await open(browser, u1);
  await expect(item(p, conv).getByTestId('conv-badge')).toHaveText('5');
  await longPress(p, item(p, conv));
  await convMenu(p).getByRole('menuitem', { name: '免打扰' }).click();
  await expect(item(p, conv).getByTestId('conv-dot')).toBeVisible();
  await expect(item(p, conv).getByTestId('conv-badge')).toHaveCount(0);
  await expect(summary(p, conv)).toHaveText('[5 条] 第 5 条');
  await expect(item(p, conv).getByRole('img', { name: '免打扰' })).toBeVisible();
  expect(await item(p, conv).locator('svg.lucide-bell-off').count()).toBe(1); // PRD-ui 6.6 节清单的 bell-off
  await expect(p.getByTestId('tab-badge')).toHaveCount(0);
  await expect(p).toHaveTitle('天听');
  await p.reload();
  await expect(item(p, conv).getByTestId('conv-dot')).toBeVisible(); // 服务端保存
  await longPress(p, item(p, conv));
  expect(await menuTexts(p)).toEqual(['置顶', '取消免打扰', '删除']);
  await convMenu(p).getByRole('menuitem', { name: '取消免打扰' }).click();
  await expect(item(p, conv).getByTestId('conv-badge')).toHaveText('5');
  await expect(summary(p, conv)).toHaveText('第 5 条');
  await expect(p).toHaveTitle('(5) 天听');
  await p.context().close();
});

test('TC-CVS-02-02 普通未读 2、3，免打扰未读 5：角标"5"，标题"(5) 天听"；TC-CVS-02-04 只剩免打扰的未读时标题"天听"', async ({
  browser,
}) => {
  const [u1, u2, u3, u4] = [uid('ta'), uid('tb'), uid('tc'), uid('td')];
  await users({ [u1]: '小一', [u2]: '小二', [u3]: '小三', [u4]: '小四' });
  for (const [u, n] of [
    [u2, 2],
    [u3, 3],
    [u4, 5],
  ] as const) {
    const w = await wsAs(u);
    for (let i = 0; i < n; i++) await w.send('c2c', u1, { text: `${u} ${i}` });
    w.close();
  }
  const w1 = await wsAs(u1);
  await w1.ok('convSet', { convId: c2cId(u1, u4), notifyOff: true });
  w1.close();
  const p = await open(browser, u1);
  await expect(p.getByTestId('tab-badge')).toHaveText('5');
  await expect(p).toHaveTitle('(5) 天听');
  // 读完两个普通会话：只剩免打扰的 5 条（TC-CVS-02-04）
  for (const [u, n, title] of [
    [u2, 2, '(3) 天听'],
    [u3, 3, '天听'],
  ] as const) {
    await item(p, c2cId(u1, u)).click();
    await expect(p.getByTestId('message')).toHaveCount(n);
    await expect(p).toHaveTitle(title); // 已读上报后总未读减少（F-UI-23）
    await p.getByRole('button', { name: '返回' }).click();
  }
  await expect(p).toHaveTitle('天听');
  await expect(p.getByTestId('tab-badge')).toHaveCount(0);
  await expect(item(p, c2cId(u1, u4)).getByTestId('conv-dot')).toBeVisible();
  await p.context().close();
});

test('TC-CVS-02-05 免打扰的群未读 5 其中 1 条 @ 我，普通未读 2：角标"3"，标题"(3) 天听"；前缀"[有人@我]"、小红点', async ({
  browser,
}) => {
  const [u1, u2] = [uid('ma'), uid('mb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const g = await groupOf(u2, [u1]);
  const gid = g.slice('group:'.length);
  const w1 = await wsAs(u1);
  await w1.ok('convSet', { convId: g, notifyOff: true });
  w1.close();
  const w2 = await wsAs(u2);
  for (let i = 0; i < 4; i++) await w2.send('group', gid, { text: `群消息 ${i}` });
  await w2.send('group', gid, { text: '@小一 看一下', mentions: { userIds: [u1] } });
  for (let i = 0; i < 2; i++) await w2.send('c2c', u1, { text: `单聊 ${i}` });
  w2.close();
  const p = await open(browser, u1);
  await expect(p.getByTestId('tab-badge')).toHaveText('3');
  await expect(p).toHaveTitle('(3) 天听');
  await expect(item(p, g).getByTestId('conv-dot')).toBeVisible();
  await expect(summary(p, g)).toHaveText('[有人@我] 小二: @小一 看一下');
  await p.context().close();
});

// ---- 删除（F-CVS-03） ----

/** u1 和 u2 的单聊：u2 发的 3 条（含特征串）和 1 张图片；u1 在页面上看过图片、留下草稿和一条失败消息。 */
async function deletable(browser: Browser, prefix: string, opts?: BrowserContextOptions) {
  const [u1, u2] = [uid(`${prefix}a`), uid(`${prefix}b`)];
  await users({ [u1]: '小一', [u2]: '小二' });
  const w2 = await wsAs(u2);
  for (let i = 1; i <= 3; i++) await w2.send('c2c', u1, { text: `ZXQ-CVS-2 第 ${i} 条` });
  const png = makePng(60, 40, () => [10, 120, 200]);
  const fileId = await uploadFile(w2.token, 'image', 'image.png', png, 'image/png', { data: png, mime: 'image/png' });
  await w2.send('c2c', u1, { image: { fileId } }, 'image');
  w2.close();
  const conv = c2cId(u1, u2);
  const p = await open(browser, u1, opts);
  return { u1, u2, conv, p };
}

/** 在聊天页：等图片显示（blob:），发一条会失败的，再写草稿，回到列表。返回图片的 blob: 地址。 */
async function leaveTraces(p: P, conv: string, arm: () => void) {
  await item(p, conv).click();
  const img = p.getByTestId('img-thumb');
  await expect(img).toHaveAttribute('src', /^blob:/);
  const blob = (await img.getAttribute('src'))!;
  arm();
  await input(p).fill('会失败的');
  await input(p).press('Enter');
  await expect(p.locator('[data-testid="message"][data-status="failed"]')).toHaveCount(1);
  await input(p).fill('ZXQ-CVS-2 草稿');
  await p.getByRole('button', { name: '返回' }).click();
  await expect(summary(p, conv)).toHaveText('[草稿] ZXQ-CVS-2 草稿');
  return blob;
}

/** 页面里能不能还读到这个 blob:（释放后 fetch 失败）。 */
const blobAlive = (p: Page, url: string) =>
  p.evaluate(async (u) => {
    try {
      await fetch(u);
      return true;
    } catch {
      return false;
    }
  }, url);

/** 下一条 send 由测试回 5000（失败消息，F-UI-09）：arm() 之后的第一条。其他上行交给 more。 */
async function failSendOnce(p: P, more: Parameters<typeof intercept>[1] = {}) {
  let fail = false;
  await intercept(p, {
    ...more,
    up: (f, reply) => {
      if (f.cmd === 'send' && fail) {
        fail = false;
        reply({ id: f.id, cmd: 'ack', error: { code: 5000, msg: 'x' } });
        return true;
      }
      return more.up?.(f, reply) ?? false;
    },
  });
  return () => {
    fail = true;
  };
}

test('TC-CVS-03-08 确认框文字；取消时会话、草稿、失败消息、图片都还在；确认删除（真实 convDelete）后都清除，从通讯录再进入是空的', async ({
  browser,
}) => {
  const { conv, p } = await deletable(browser, 'da');
  const arm = await failSendOnce(p);
  const blob = await leaveTraces(p, conv, arm);

  await longPress(p, item(p, conv));
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  const dialog = p.getByTestId('conv-delete-dialog');
  await expect(dialog).toHaveText(/删除后聊天记录不再显示，确定删除？/);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  expect(sentCmd(p, 'convDelete')).toHaveLength(0);
  await expect(summary(p, conv)).toHaveText('[草稿] ZXQ-CVS-2 草稿');
  expect(await blobAlive(p, blob)).toBe(true);
  await item(p, conv).click();
  await expect(p.locator('[data-testid="message"][data-status="failed"]')).toHaveCount(1);
  await p.getByRole('button', { name: '返回' }).click();

  await longPress(p, item(p, conv));
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await dialog.getByRole('button', { name: '删除' }).click();
  // 服务端要成功（BE-485）；没有这个命令时回 4001，用例在这里如实失败
  expect((await ackOf(p, 'convDelete')).error).toBeUndefined();
  expect(sentCmd(p, 'convDelete').map((f) => f.data)).toEqual([{ convId: conv, upToSeq: 4 }]);
  // 服务端成功（BE-485）后：会话不再出现，草稿、失败消息、图片缓存都没有了
  await p.waitForTimeout(1000);
  await expect(item(p, conv)).toHaveCount(0);
  await expect(p.getByTestId('toast')).toHaveCount(0);
  expect(await blobAlive(p, blob)).toBe(false);
  expect(await p.evaluate(() => document.body.innerText)).not.toContain('ZXQ-CVS-2');
  await p.goto(chatUrl(conv));
  await expect(input(p)).toHaveValue('');
  await expect(p.getByTestId('message')).toHaveCount(0);
  await p.reload(); // 服务端 convs 也不再给它
  await p.goto('/chats');
  await expect(p.getByTestId('conv-list')).toBeVisible();
  await p.waitForTimeout(500);
  await expect(item(p, conv)).toHaveCount(0);
  await p.context().close();
});

test('改写帧：TC-CVS-03-08 的页面部分（convDelete 的 ack 由测试回）：确认后草稿、失败消息、图片的 blob: 都清除，再进入是空的', async ({
  browser,
}) => {
  const { conv, p } = await deletable(browser, 'dm');
  const arm = await failSendOnce(p, {
    up: (f, reply) => {
      if (f.cmd !== 'convDelete') return false;
      reply({ id: f.id, cmd: 'ack', data: { clearedSeq: (f.data as { upToSeq: number }).upToSeq } });
      return true;
    },
  });
  const blob = await leaveTraces(p, conv, arm);
  await longPress(p, item(p, conv));
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await p.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  await expect(item(p, conv)).toHaveCount(0);
  expect(sentCmd(p, 'convDelete').map((f) => f.data)).toEqual([{ convId: conv, upToSeq: 4 }]);
  await expect.poll(() => blobAlive(p, blob)).toBe(false);
  expect(await p.evaluate(() => document.body.innerText)).not.toContain('ZXQ-CVS-2');
  await p.goto(chatUrl(conv)); // 同一个标签页（SPA 内存），从地址进入
  await expect(input(p)).toHaveValue('');
  await expect(p.getByTestId('message')).toHaveCount(0);
  await p.context().close();
});

test('改写帧：宽屏删除主区开着的会话，主区回到空白；删除失败 4290 提示"操作过于频繁"，会话恢复', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('dw');
  const p = await open(browser, u1, WIDE);
  let fail = true;
  await intercept(p, {
    up: (f, reply) => {
      if (f.cmd !== 'convDelete') return false;
      if (fail) reply({ id: f.id, cmd: 'ack', error: { code: 4290, msg: 'x' } });
      else reply({ id: f.id, cmd: 'ack', data: { clearedSeq: (f.data as { upToSeq: number }).upToSeq } });
      fail = false;
      return true;
    },
  });
  await item(p, c3).click();
  await expect(p).toHaveURL(/\/chat\//);
  await item(p, c3).click({ button: 'right' });
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await p.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  await expect(p.getByTestId('toast')).toHaveText('操作过于频繁');
  await expect.poll(() => order(p)).toEqual([c3, c2, g]);
  await item(p, c3).click({ button: 'right' });
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await p.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  await expect.poll(() => order(p)).toEqual([c2, g]);
  await expect(p).toHaveURL(/\/chats$/);
  await expect(p.getByTestId('main-empty')).toBeVisible();
  await p.context().close();
});

test('改写帧：其他设备删除（服务端推 convDeleted）：会话消失，这个标签页的草稿和开着的输入框都清除（AC-CVS-04-5 的页面部分）', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('de');
  const p = await open(browser, u1, WIDE);
  const st = await intercept(p);
  await item(p, c2).click();
  await input(p).fill('c2 的草稿');
  await item(p, c3).click();
  await expect(summary(p, c2)).toHaveText('[草稿] c2 的草稿');
  await input(p).fill('c3 正在输入');
  st.push({ cmd: 'event', data: { type: 'convDeleted', convId: c2, clearedSeq: 1 } });
  st.push({ cmd: 'event', data: { type: 'convDeleted', convId: c3, clearedSeq: 1 } });
  await expect.poll(() => order(p)).toEqual([g]);
  await expect(input(p)).toHaveValue('');
  await expect(p.getByTestId('message')).toHaveCount(0);
  await p.goto(chatUrl(c2));
  await expect(input(p)).toHaveValue('');
  await p.context().close();
});

test('群：删除会话后从"我的群聊"进入是空的聊天页，标题是群名，可以发言（F-CVS-03 规则 4）', async ({ browser }) => {
  const [u1, u2] = [uid('ga'), uid('gb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const g = await groupOf(u2, [u1], '删过的群');
  const gid = g.slice('group:'.length);
  const w2 = await wsAs(u2);
  await w2.send('group', gid, { text: 'ZXQ-CVS-3 旧消息' });
  w2.close();
  const p = await open(browser, u1, WIDE);
  await item(p, g).click({ button: 'right' });
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await p.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  // 服务端要成功（BE-485）；没有这个命令时回 4001，用例在这里如实失败
  expect((await ackOf(p, 'convDelete')).error).toBeUndefined();
  await p.waitForTimeout(1000);
  await expect(item(p, g)).toHaveCount(0);
  await p.goto('/contacts/groups');
  await p.getByText('删过的群').click();
  await expect(p.getByTestId('chat-title')).toHaveText('删过的群');
  await expect(p.getByTestId('message')).toHaveCount(0);
  await input(p).fill('我还在');
  await input(p).press('Enter');
  await expect(p.locator('[data-testid="message"][data-status="sent"]')).toHaveCount(1);
  await expect(item(p, g)).toBeVisible(); // 自己发的也是新消息，会话重新出现
  expect(await p.evaluate(() => document.body.innerText)).not.toContain('ZXQ-CVS-3');
  await p.context().close();
});

test('TC-CVS-03-02 删除后对方再发 1 条：会话重新出现，未读 1，打开只有这 1 条，翻页不出现旧消息', async ({
  browser,
}) => {
  const [u1, u2] = [uid('ra'), uid('rb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const w2 = await wsAs(u2);
  for (let i = 1; i <= 10; i++) await w2.send('c2c', u1, { text: `ZXQ-CVS-1 第 ${i} 条` });
  const conv = c2cId(u1, u2);
  const p = await open(browser, u1, WIDE);
  await item(p, conv).click({ button: 'right' });
  await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
  await p.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  // 服务端要成功（BE-485）；没有这个命令时回 4001，用例在这里如实失败
  expect((await ackOf(p, 'convDelete')).error).toBeUndefined();
  await p.waitForTimeout(1000);
  await expect(item(p, conv)).toHaveCount(0);
  await w2.send('c2c', u1, { text: '删除后的第 11 条' });
  w2.close();
  await expect(item(p, conv)).toBeVisible({ timeout: 2000 });
  await expect(item(p, conv).getByTestId('conv-badge')).toHaveText('1');
  await expect(summary(p, conv)).toHaveText('删除后的第 11 条');
  await item(p, conv).click();
  await expect(p.getByTestId('message')).toHaveCount(1);
  await p.getByTestId('message-list').evaluate((el) => el.scrollTo({ top: 0 }));
  await p.waitForTimeout(500);
  await expect(p.getByTestId('message')).toHaveCount(1);
  expect(await p.evaluate(() => document.body.innerText)).not.toContain('ZXQ-CVS-1');
  await p.context().close();
});

// ---- 多端（F-CVS-04） ----

test('TC-CVS-04-01 D1 置顶、免打扰：D2（另一个标签页）2 秒内更新，有置顶背景和免打扰图标', async ({ browser }) => {
  const { u1, g, c2, c3 } = await threeConvs('ma');
  const d1 = await open(browser, u1, WIDE);
  const d2 = await open(browser, u1, WIDE);
  await expect.poll(() => order(d2)).toEqual([c3, c2, g]);
  await item(d1, g).click({ button: 'right' });
  await convMenu(d1).getByRole('menuitem', { name: '置顶' }).click();
  await item(d1, g).click({ button: 'right' });
  await convMenu(d1).getByRole('menuitem', { name: '免打扰' }).click();
  expect((await ackOf(d1, 'convSet')).error).toBeUndefined(); // convSet 有了（BE-484）；D2 靠 convSettingsChanged（BE-486）
  await expect.poll(() => order(d2), { timeout: 2000 }).toEqual([g, c3, c2]);
  await expect(item(d2, g)).toHaveAttribute('data-pinned', 'true', { timeout: 2000 });
  await expect(item(d2, g).getByRole('img', { name: '免打扰' })).toBeVisible({ timeout: 2000 });
  await d1.context().close();
  await d2.context().close();
});

test('TC-CVS-04-05 D1 删除会话：D2 2 秒内会话消失、消息清除，D2 的草稿也清除', async ({ browser }) => {
  const [u1, u2] = [uid('ea'), uid('eb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const w2 = await wsAs(u2);
  await w2.send('c2c', u1, { text: 'ZXQ-CVS-1 要删的' });
  w2.close();
  const conv = c2cId(u1, u2);
  const d1 = await open(browser, u1, WIDE);
  const d2 = await open(browser, u1, WIDE);
  await item(d2, conv).click();
  await expect(d2.getByTestId('message')).toHaveCount(1);
  await input(d2).fill('D2 的草稿');
  await d2.getByTestId('tab-contacts').click(); // 离开聊天页，草稿进列表
  await d2.getByTestId('tab-chats').click();
  await expect(summary(d2, conv)).toHaveText('[草稿] D2 的草稿');
  await item(d1, conv).click({ button: 'right' });
  await convMenu(d1).getByRole('menuitem', { name: '删除' }).click();
  await d1.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  // 服务端要成功（BE-485）；没有这个命令时回 4001，用例在这里如实失败
  expect((await ackOf(d1, 'convDelete')).error).toBeUndefined();
  await expect(item(d2, conv)).toHaveCount(0, { timeout: 2000 });
  expect(await d2.evaluate(() => document.body.innerText)).not.toContain('ZXQ-CVS-1');
  await d2.goto(chatUrl(conv));
  await expect(input(d2)).toHaveValue('');
  await expect(d2.getByTestId('message')).toHaveCount(0);
  await d1.context().close();
  await d2.context().close();
});

test('TC-CVS-04-02 D2 离线时 D1 置顶 c1 并删除 c2：D2 重连后顺序、置顶和 D1 一样，c2 不在列表、消息清除', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('mo');
  const d2 = await open(browser, u1, WIDE);
  const net = await switchable(d2);
  await item(d2, c2).click();
  await expect(d2.getByTestId('message')).toHaveCount(1);
  await d2.getByTestId('tab-chats').click();
  await expect.poll(() => order(d2)).toEqual([c3, c2, g]);
  net.offline();
  await expect(d2.getByTestId('conn-banner')).toBeVisible({ timeout: 10_000 });
  const d1 = await open(browser, u1, WIDE);
  await item(d1, g).click({ button: 'right' });
  await convMenu(d1).getByRole('menuitem', { name: '置顶' }).click();
  await item(d1, c2).click({ button: 'right' });
  await convMenu(d1).getByRole('menuitem', { name: '删除' }).click();
  await d1.getByTestId('conv-delete-dialog').getByRole('button', { name: '删除' }).click();
  // 服务端要成功（BE-485）；没有这个命令时回 4001，用例在这里如实失败
  expect((await ackOf(d1, 'convDelete')).error).toBeUndefined();
  await expect.poll(() => order(d1)).toEqual([g, c3]);
  net.online();
  await expect.poll(() => order(d2), { timeout: 10_000 }).toEqual([g, c3]);
  await expect(item(d2, g)).toHaveAttribute('data-pinned', 'true');
  await d2.goto(chatUrl(c2));
  await expect(d2.getByTestId('message')).toHaveCount(0);
  await d1.context().close();
  await d2.context().close();
});

// ---- 无障碍（AC-CHAT-90-8、90-9，TC-CHAT-90-36、37） ----

for (const scheme of ['light', 'dark'] as const) {
  test(`TC-CHAT-90-37（C5，${scheme}）：置顶、免打扰的列表，会话菜单、删除确认框没有 axe 严重问题和 button-name 违规`, async ({
    browser,
  }) => {
    const { u1, g, c2 } = await threeConvs(scheme === 'light' ? 'xa' : 'xd');
    const w1 = await wsAs(u1);
    await w1.ok('convSet', { convId: g, pinned: true });
    await w1.ok('convSet', { convId: c2, notifyOff: true });
    w1.close();
    const p = await open(browser, u1, { ...WIDE, colorScheme: scheme });
    await expect(item(p, c2).getByRole('img', { name: '免打扰' })).toBeVisible();
    await expect(item(p, c2).getByTestId('conv-dot')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await item(p, c2).click({ button: 'right' });
    await expect(convMenu(p)).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await convMenu(p).getByRole('menuitem', { name: '删除' }).click();
    await expect(p.getByTestId('conv-delete-dialog')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await p.keyboard.press('Escape');
    await expect(p.getByTestId('conv-delete-dialog')).toHaveCount(0);
    expect(sentCmd(p, 'convDelete')).toHaveLength(0);
    await p.context().close();
  });
}

test('TC-CHAT-90-37 键盘走查：Tab 到会话项，菜单键打开，方向键、回车执行"置顶"（真实 convSet），Esc 关闭焦点回到会话项', async ({
  browser,
}) => {
  const { u1, g, c2, c3 } = await threeConvs('ka');
  const p = await open(browser, u1, WIDE);
  await expect.poll(() => order(p)).toEqual([c3, c2, g]);
  await tabTo(p, item(p, g));
  await p.keyboard.press('ContextMenu');
  await expect(convMenu(p).getByRole('menuitem', { name: '置顶' })).toBeFocused();
  await p.keyboard.press('ArrowDown');
  await expect(convMenu(p).getByRole('menuitem', { name: '免打扰' })).toBeFocused();
  await p.keyboard.press('ArrowDown');
  await expect(convMenu(p).getByRole('menuitem', { name: '删除' })).toBeFocused();
  await p.keyboard.press('Escape');
  await expect(convMenu(p)).toHaveCount(0);
  await expect(item(p, g)).toBeFocused();
  await p.keyboard.press('Shift+F10');
  await p.keyboard.press('Enter');
  await expect.poll(() => order(p)).toEqual([g, c3, c2]);
  await expect(item(p, g)).toHaveAttribute('data-pinned', 'true');
  await expect(item(p, g)).toBeFocused();
  await p.context().close();
});
