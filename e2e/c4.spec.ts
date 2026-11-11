// FE-665、FE-666（PRD-chat C4）：撤回、引用、@ 对真实 im-server（IM_MSG_ACTIONS_ENABLED=1，演示登录）。
// 帧内容（引用原文、@ 的内容）只在内存里断言，不打印。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { demoToken, makePng, uploadFile } from './files';
import { admin, c2cId, chatUrl, signed, uid, WIDE } from './helpers';
import { SERVER } from './ports';

// ---- 工具 ----

type Frame = { id?: string; cmd?: string; data?: Record<string, unknown>; error?: { code: number } };

/** 用 WebSocket 以某个用户直接调命令（预先放消息、撤回、设管理员）。每个调用等 ack。 */
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
      const id = `c4-${++n}`;
      pending.set(id, (f) => {
        pending.delete(id);
        res(f);
      });
      ws.send(JSON.stringify({ id, cmd, data }));
    });
  const auth = await call('auth', { token });
  if (auth.error) throw new Error(`auth ${auth.error.code}`);
  return {
    call,
    /** 发一条消息，4290 时等一下用同一个 clientMsgId 再发；返回 msgId、seq。 */
    async send(convType: 'c2c' | 'group', to: string, body: Record<string, unknown>, type = 'text') {
      const clientMsgId = randomBytes(8).toString('hex');
      for (let tries = 0; ; tries++) {
        const r = await call('send', { convType, to, type, body, clientMsgId });
        if (r.error?.code === 4290 && tries < 100) {
          await new Promise((ok) => setTimeout(ok, 200));
          continue;
        }
        if (r.error) throw new Error(`send ${r.error.code}`);
        return r.data as { msgId: string; seq: number };
      }
    },
    async ok(cmd: string, data: unknown) {
      const r = await call(cmd, data);
      if (r.error) throw new Error(`${cmd} ${r.error.code}`);
      return r.data;
    },
    close: () => ws.close(),
  };
}

async function users(list: Record<string, string>) {
  await admin('POST', '/admin/users/import', {
    users: Object.entries(list).map(([userId, nickname]) => ({ userId, nickname })),
  });
}

/** 托管群，指定群主（要签名调用），可以再设管理员。 */
async function groupOf(owner: string, members: string[], admins: string[] = []) {
  const g = uid('g');
  await signed('/admin/groups', { groupId: g, name: 'C4 群', members: [owner, ...members], owner });
  if (admins.length) {
    const o = await wsAs(owner);
    for (const a of admins) await o.ok('groupSetAdmin', { groupId: g, userId: a, admin: true });
    o.close();
  }
  return `group:${g}`;
}

/** 新上下文里演示登录，记下页面发出的 WebSocket 帧（只在内存）。 */
async function open(browser: Browser, userId: string, path = '/chats', opts = WIDE) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const sent: Frame[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        sent.push(JSON.parse(String(f.payload)) as Frame);
      } catch {
        // 不是 JSON 的帧不管
      }
    }),
  );
  await page.goto('/login');
  await page.getByTestId('login-username').fill(userId);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
  if (path !== '/chats') await page.goto(path);
  return Object.assign(page, { sent });
}
type P = Awaited<ReturnType<typeof open>>;

const bubble = (page: Page, text: string) => page.locator('[data-testid="bubble"]', { hasText: text });
const summary = (page: Page, convId: string) => page.locator(`[data-conv-id="${convId}"] .tt-conv-summary`);
const sends = (p: P) => p.sent.filter((f) => f.cmd === 'send');
const input = (page: Page) => page.getByTestId('composer-input');

async function menu(page: Page, text: string) {
  await bubble(page, text).click({ button: 'right' });
  return page.getByTestId('bubble-menu');
}

/** 可以"断网"的页面：offline 期间关掉连接，新连接挂着不接通，online 后再接上（SDK 内存不丢，重连后按 modVer 补拉）。 */
async function switchable(page: Page) {
  const st = { online: true, waiters: [] as (() => void)[], close: () => {} };
  await page.routeWebSocket(/\/ws(\?|$)/, async (ws) => {
    if (!st.online) await new Promise<void>((r) => st.waiters.push(r));
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
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

const axeProblems = async (page: Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.id === 'button-name' || v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
};

// ---- 撤回（FE-665） ----

test('TC-RCL-01-01 60 秒内撤回：对方和自己另一端 2 秒内变成撤回文案，DOM 里没有原文；列表摘要一致', async ({
  browser,
}) => {
  const [u1, u2] = [uid('ra'), uid('rb')];
  await users({ [u1]: u1, [u2]: u2 });
  const conv = c2cId(u1, u2);
  const a = await open(browser, u1, chatUrl(conv));
  await input(a).fill('ZXQ-RCL-1 发错了');
  await input(a).press('Enter');
  await expect(a.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
  const a2 = await open(browser, u1, chatUrl(conv));
  const b = await open(browser, u2, chatUrl(conv));
  await expect(bubble(b, 'ZXQ-RCL-1')).toBeVisible();
  await expect(bubble(a2, 'ZXQ-RCL-1')).toBeVisible();
  const m = await menu(a, 'ZXQ-RCL-1');
  await expect(m.getByRole('menuitem')).toHaveText(['复制', '引用', '撤回']);
  await a.getByTestId('menu-recall').click();
  expect(a.sent.filter((f) => f.cmd === 'recall')).toHaveLength(1);
  await expect(a.getByTestId('msg-recalled')).toHaveText('你撤回了一条消息');
  await expect(b.getByTestId('msg-recalled')).toHaveText('对方撤回了一条消息', { timeout: 2000 });
  await expect(a2.getByTestId('msg-recalled')).toHaveText('你撤回了一条消息', { timeout: 2000 });
  for (const p of [a, a2, b]) expect(await p.content()).not.toContain('ZXQ-RCL-1');
  // 提示行没有菜单（F-RCL-03 规则 6）
  await b.getByTestId('msg-recalled').click({ button: 'right' });
  await expect(b.getByTestId('bubble-menu')).toHaveCount(0);
  await b.goto('/chats');
  await expect(summary(b, conv)).toHaveText('对方撤回了一条消息');
  await a.goto('/chats');
  await expect(summary(a, conv)).toHaveText('你撤回了一条消息');
  for (const p of [a, a2, b]) await p.context().close();
});

test('TC-RCL-01-08 撤回菜单按服务端时间：125 秒前的没有"撤回"；菜单开着过了 2 分钟，点了提示 4097，消息不变', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [u1, u2] = [uid('ta'), uid('tb')];
  await users({ [u1]: u1, [u2]: u2 });
  const conv = c2cId(u1, u2);
  const w = await wsAs(u1);
  try {
    await admin('POST', '/admin/test/clock', { nowMs: Date.now() - 125_000 });
    await w.send('c2c', u2, { text: '125 秒前' });
    await admin('POST', '/admin/test/clock', { nowMs: Date.now() - 112_000 });
    await w.send('c2c', u2, { text: '112 秒前' });
  } finally {
    await admin('POST', '/admin/test/clock', { nowMs: null });
    w.close();
  }
  const a = await open(browser, u1, chatUrl(conv));
  await expect((await menu(a, '125 秒前')).getByRole('menuitem')).toHaveText(['复制', '引用']);
  await a.keyboard.press('Escape');
  const m = await menu(a, '112 秒前');
  await expect(m.getByRole('menuitem')).toHaveText(['复制', '引用', '撤回']);
  await a.waitForTimeout(10_000); // 菜单开着，过了 120 秒
  await a.getByTestId('menu-recall').click();
  await expect(a.getByTestId('toast')).toHaveText('发送时间超过 2 分钟，无法撤回');
  await expect(bubble(a, '112 秒前')).toBeVisible();
  await expect(a.getByTestId('msg-recalled')).toHaveCount(0);
  await a.context().close();
});

test('TC-RCL-02-04 TC-RCL-02-05 管理员撤回成员：三方的聊天页和列表摘要按规则 1a 第 3 行；撤回其他管理员提示无权限', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [o, a, a2, m, n] = [uid('o'), uid('adm'), uid('adm2'), uid('mem'), uid('n')];
  await users({ [o]: o, [a]: a, [a2]: a2, [m]: m, [n]: n });
  const g = await groupOf(o, [a, a2, m, n], [a, a2]);
  const gid = g.slice('group:'.length);
  const wa2 = await wsAs(a2);
  await wa2.send('group', gid, { text: '管理员二的话' });
  wa2.close();
  const wm = await wsAs(m);
  await wm.send('group', gid, { text: '成员的广告' });
  wm.close();
  const pa = await open(browser, a, chatUrl(g));
  const pm = await open(browser, m, chatUrl(g));
  const pn = await open(browser, n, chatUrl(g));
  for (const p of [pa, pm, pn]) await expect(bubble(p, '成员的广告')).toBeVisible();
  await (await menu(pa, '成员的广告')).getByTestId('menu-recall').click();
  const want: [Page, string][] = [
    [pa, `你撤回了 ${m} 的一条消息`],
    [pm, `${a}撤回了你的一条消息`],
    [pn, `${a}撤回了一条成员消息`],
  ];
  for (const [p, text] of want) await expect(p.getByTestId('msg-recalled')).toHaveText(text);
  // 管理员撤回其他管理员：菜单里有"撤回"（客户端不知道对方角色），服务端 4030。别人的消息还有"举报"（C6，IM_MOD_ENABLED=1）
  const mm = await menu(pa, '管理员二的话');
  await expect(mm.getByRole('menuitem')).toHaveText(['复制', '引用', '撤回', '举报']);
  await pa.getByTestId('menu-recall').click();
  await expect(pa.getByTestId('toast')).toHaveText('你没有权限撤回这条消息');
  await expect(bubble(pa, '管理员二的话')).toBeVisible();
  for (const [p, text] of want) {
    await p.goto('/chats');
    await expect(summary(p, g)).toHaveText(text);
  }
  for (const p of [pa, pm, pn]) await p.context().close();
});

test('TC-RCL-03-03 断网期间被撤回：恢复网络后（modVer 重拉）变成撤回文案，内存里搜不到原文', async ({ browser }) => {
  test.setTimeout(60_000);
  const [u1, u2] = [uid('na'), uid('nb')];
  await users({ [u1]: u1, [u2]: u2 });
  const conv = c2cId(u1, u2);
  const w = await wsAs(u1);
  const sent = await w.send('c2c', u2, { text: 'ZXQ-RCL-2 断网' });
  const b = await open(browser, u2, chatUrl(conv));
  const net = await switchable(b);
  await expect(bubble(b, 'ZXQ-RCL-2')).toBeVisible();
  net.offline();
  await expect(b.getByTestId('conn-banner')).toBeVisible({ timeout: 10_000 });
  await w.ok('recall', { convId: conv, msgId: sent.msgId });
  w.close();
  await b.waitForTimeout(500);
  await expect(bubble(b, 'ZXQ-RCL-2')).toBeVisible(); // 断网时还没变
  net.online();
  await expect(b.getByTestId('msg-recalled')).toHaveText('对方撤回了一条消息', { timeout: 15_000 });
  const mem = await b.evaluate(() =>
    JSON.stringify(
      (window as unknown as { __tiantingDebug: { exportMemory(): unknown } }).__tiantingDebug.exportMemory(),
    ),
  );
  expect(mem).not.toContain('ZXQ-RCL-2');
  await b.context().close();
});

test('TC-RCL-03-06 群里撤回自己的最后一条：自己列表"你撤回了一条消息"，其他成员"{显示名}撤回了一条消息"', async ({
  browser,
}) => {
  const [u1, n] = [uid('sa'), uid('sn')];
  await users({ [u1]: '阿一', [n]: n });
  const g = await groupOf(u1, [n]);
  const p1 = await open(browser, u1, chatUrl(g));
  await input(p1).fill('最后一条');
  await input(p1).press('Enter');
  await expect(p1.getByTestId('message').last()).toHaveAttribute('data-status', 'sent');
  const pn = await open(browser, n);
  await expect(summary(pn, g)).toContainText('最后一条');
  await (await menu(p1, '最后一条')).getByTestId('menu-recall').click();
  await expect(p1.getByTestId('msg-recalled')).toHaveText('你撤回了一条消息');
  await expect(summary(pn, g)).toHaveText('阿一撤回了一条消息');
  await p1.goto('/chats');
  await expect(summary(p1, g)).toHaveText('你撤回了一条消息');
  await p1.context().close();
  await pn.context().close();
});

test('TC-RCL-03-08 全屏看的图片被撤回：退出全屏，提示"该消息已被撤回"，气泡变撤回文案', async ({ browser }) => {
  test.setTimeout(60_000);
  const [u1, u2] = [uid('ia'), uid('ib')];
  await users({ [u1]: u1, [u2]: u2 });
  const conv = c2cId(u1, u2);
  const token = await demoToken(u1);
  const png = makePng(120, 80, () => [200, 40, 40]);
  const fileId = await uploadFile(token, 'image', 'image.png', png, 'image/png', {
    data: makePng(60, 40, () => [200, 40, 40]),
    mime: 'image/png',
  });
  const w = await wsAs(u1);
  const sent = await w.send('c2c', u2, { image: { fileId } }, 'image');
  const b = await open(browser, u2, chatUrl(conv));
  await b.getByTestId('img-open').click();
  await expect(b.getByTestId('viewer-original')).toBeVisible();
  await w.ok('recall', { convId: conv, msgId: sent.msgId });
  w.close();
  await expect(b.getByTestId('image-viewer')).toHaveCount(0);
  await expect(b.getByTestId('toast')).toHaveText('该消息已被撤回');
  await expect(b.getByTestId('msg-recalled')).toHaveText('对方撤回了一条消息');
  await expect(b.getByTestId('img-thumb')).toHaveCount(0);
  await b.context().close();
});

// ---- 引用（FE-665） ----

test('TC-QUO-01-05 选"引用"：引用条可以取消（不发 quote）；发送后两边气泡顶部显示；图片、文件的摘要', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [u1, u2] = [uid('qa'), uid('qb')];
  await users({ [u1]: '小一', [u2]: '小二' });
  const conv = c2cId(u1, u2);
  const token = await demoToken(u2);
  const img = await uploadFile(
    token,
    'image',
    'image.png',
    makePng(40, 30, () => [1, 2, 3]),
    'image/png',
    { data: makePng(20, 15, () => [1, 2, 3]), mime: 'image/png' },
  );
  const file = await uploadFile(token, 'file', '报价单.pdf', Buffer.from('%PDF-1.4 quote'), 'application/pdf');
  const w = await wsAs(u2);
  await w.send('c2c', u1, { text: '周末去哪' });
  await w.send('c2c', u1, { image: { fileId: img } }, 'image');
  await w.send('c2c', u1, { file: { fileId: file } }, 'file');
  w.close();
  const a = await open(browser, u1, chatUrl(conv));
  await (await menu(a, '周末去哪')).getByTestId('menu-quote').click();
  await expect(a.getByTestId('quote-bar-text')).toHaveText('小二: 周末去哪');
  await expect(input(a)).toBeFocused();
  await a.getByRole('button', { name: '取消引用' }).click();
  await expect(a.getByTestId('quote-bar')).toHaveCount(0);
  await input(a).fill('不引用');
  await input(a).press('Enter');
  await expect.poll(() => sends(a).length).toBe(1);
  expect(sends(a)[0]!.data!.body).toEqual({ text: '不引用' });

  await (await menu(a, '周末去哪')).getByTestId('menu-quote').click();
  await input(a).fill('去爬山');
  await input(a).press('Enter');
  await expect.poll(() => sends(a).length).toBe(2);
  const quoted = sends(a)[1]!.data!.body as { quote?: { msgId: string } };
  expect(Object.keys(quoted.quote ?? {})).toEqual(['msgId']); // 上行只有 msgId
  await expect(bubble(a, '去爬山').getByTestId('msg-quote')).toHaveText('小二: 周末去哪');

  await a
    .locator('[data-testid="message"]', { has: a.getByTestId('img-thumb') })
    .getByTestId('bubble')
    .click({
      button: 'right',
    });
  await expect(a.getByTestId('bubble-menu').getByRole('menuitem')).toHaveText(['引用', '举报']); // 别人的图片：C6 起有"举报"
  await a.getByTestId('menu-quote').click();
  await expect(a.getByTestId('quote-bar-text')).toHaveText('小二: [图片]');
  await input(a).fill('图不错');
  await input(a).press('Enter');
  await (await menu(a, '报价单')).getByTestId('menu-quote').click();
  await expect(a.getByTestId('quote-bar-text')).toHaveText('小二: [文件] 报价单.pdf');
  await input(a).fill('收到文件');
  await input(a).press('Enter');

  const b = await open(browser, u2, chatUrl(conv));
  await expect(bubble(b, '去爬山').getByTestId('msg-quote')).toHaveText('小二: 周末去哪'); // 服务端组装，state=normal
  await expect(bubble(b, '图不错').getByTestId('msg-quote')).toHaveText('小二: [图片]');
  await expect(bubble(b, '收到文件').getByTestId('msg-quote')).toHaveText('小二: [文件] 报价单.pdf');
  await a.context().close();
  await b.context().close();
});

test('TC-QUO-02-05 引用摘要含 HTML：引用条和两边气泡按原样显示，没有生成元素、没有弹窗和请求', async ({ browser }) => {
  const [u1, u2] = [uid('ha'), uid('hb')];
  await users({ [u1]: u1, [u2]: u2 });
  const conv = c2cId(u1, u2);
  const html = '<img src=x onerror=alert(1)><b>粗</b>';
  const w = await wsAs(u2);
  await w.send('c2c', u1, { text: html });
  w.close();
  const a = await open(browser, u1, chatUrl(conv));
  const dialogs: string[] = [];
  const xs: string[] = [];
  a.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  a.on('request', (r) => {
    if (/\/x$/.test(new URL(r.url()).pathname)) xs.push(r.url());
  });
  await (await menu(a, '<b>粗</b>')).getByTestId('menu-quote').click();
  await expect(a.getByTestId('quote-bar-text')).toHaveText(`${u2}: ${html}`);
  await input(a).fill('回复');
  await input(a).press('Enter');
  await expect(bubble(a, '回复').getByTestId('msg-quote')).toHaveText(`${u2}: ${html}`);
  const b = await open(browser, u2, chatUrl(conv));
  await expect(bubble(b, '回复').getByTestId('msg-quote')).toHaveText(`${u2}: ${html}`);
  for (const p of [a, b]) {
    expect(await p.locator('.tt-messages img, .tt-messages b, .tt-quote-bar img').count()).toBe(0);
  }
  expect(dialogs).toEqual([]);
  expect(xs).toEqual([]);
  await a.context().close();
  await b.context().close();
});

test('TC-QUO-02-03 点击引用：100 条以内翻页后滚动并高亮，已加载范围连续；500 条外提示"消息太早，请翻页查看"', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const bots = [uid('bot'), uid('bot'), uid('bot')];
  const v = uid('view');
  await users(Object.fromEntries([...bots, v].map((x) => [x, x])));
  const g = uid('jg');
  await admin('POST', '/admin/groups', { groupId: g, name: '跳转群', members: [...bots, v] });
  const conns = await Promise.all(bots.map(wsAs));
  const sent: { msgId: string; seq: number }[] = [];
  await Promise.all(
    conns.map(async (w, i) => {
      for (let k = 0; k < 200; k++) sent.push(await w.send('group', g, { text: `历史 ${i}-${k}` }));
    }),
  );
  sent.sort((x, y) => x.seq - y.seq);
  const max = sent.at(-1)!.seq; // 600
  // 打开时加载最近 20 条：q1、q2 是最后两条，已加载的最早一条是 max + 2 - 19
  const oldest = max + 2 - 19;
  const near = sent.find((x) => x.seq === oldest - 100)!;
  const far = sent.find((x) => x.seq === oldest - 520)!;
  await conns[0]!.send('group', g, { text: '跳近处', quote: { msgId: near.msgId } });
  await conns[0]!.send('group', g, { text: '跳远处', quote: { msgId: far.msgId } });
  for (const w of conns) w.close();

  const p = await open(browser, v, chatUrl(`group:${g}`));
  await expect(bubble(p, '跳远处')).toBeVisible();
  const syncs = () => p.sent.filter((f) => f.cmd === 'sync').length;
  const before = syncs();
  await bubble(p, '跳远处').getByTestId('msg-quote').click();
  await expect(p.getByTestId('toast')).toHaveText('消息太早，请翻页查看');
  expect(syncs()).toBe(before);
  await bubble(p, '跳近处').getByTestId('msg-quote').click();
  const target = p.locator(`[data-seq="${near.seq}"]`);
  await expect(target).toHaveClass(/tt-highlight/);
  await expect(target).toBeInViewport();
  const seqs = await p
    .locator('[data-testid="message"]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))));
  // 已加载范围连续（中间没有空洞）：从更早的某条一直到最新，包含跳到的那条
  expect(seqs).toContain(near.seq);
  expect(seqs.at(-1)).toBe(max + 2);
  expect(seqs.every((x, i) => i === 0 || x === seqs[i - 1]! + 1)).toBe(true);
  await p.context().close();
});

// ---- @（FE-666） ----

/** u1、u2（昵称"小王"）、u3 的群；u1 给 u2 备注"老板"。 */
async function mentionGroup() {
  const [u1, u2, u3] = [uid('ma'), uid('mb'), uid('mc')];
  await users({ [u1]: '小一', [u2]: '小王', [u3]: '小三' });
  const w1 = await wsAs(u1);
  const w2 = await wsAs(u2);
  await w1.ok('friendApply', { to: u2, source: 'other' });
  await w2.ok('friendRespond', { from: u1, action: 'accept' });
  await w1.ok('friendRemark', { userId: u2, remark: '老板' });
  w1.close();
  w2.close();
  const g = await groupOf(u1, [u2, u3]);
  return { u1, u2, u3, g, gid: g.slice('group:'.length) };
}

test('TC-MEN-01-01 TC-MEN-01-07 @ 小王：列表显示备注和 userId，插入"@小王 "；上行和对方收到的都没有"老板"；u2 列表"[有人@我]"，u3 没有', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { u1, u2, u3, g } = await mentionGroup();
  const p2 = await open(browser, u2);
  const p3 = await open(browser, u3);
  const p1 = await open(browser, u1, chatUrl(g));
  await input(p1).click();
  await p1.keyboard.type('今晚 @');
  const row = p1.locator(`[data-testid="mention-row"][data-user="${u2}"]`);
  await expect(row).toContainText('老板');
  await expect(row).toContainText(u2);
  await row.click();
  await expect(input(p1)).toHaveValue('今晚 @小王 ');
  await p1.keyboard.type('开会');
  await p1.keyboard.press('Enter');
  await expect.poll(() => sends(p1).length).toBe(1);
  expect(sends(p1)[0]!.data!.body).toEqual({ text: '今晚 @小王 开会', mentions: { userIds: [u2] } });
  expect(JSON.stringify(p1.sent)).not.toContain('老板');
  await expect(p2.locator(`[data-conv-id="${g}"]`).getByTestId('mention-tag')).toHaveText('[有人@我]');
  await expect(summary(p3, g)).toContainText('今晚 @小王 开会');
  await expect(p3.locator(`[data-conv-id="${g}"]`).getByTestId('mention-tag')).toHaveCount(0);
  await p2.locator(`[data-conv-id="${g}"]`).click();
  await expect(p2.locator('[data-testid="message"]', { hasText: '开会' })).toHaveAttribute('data-mentioned', 'true');
  await p3.locator(`[data-conv-id="${g}"]`).click();
  await expect(p3.locator('[data-testid="message"]', { hasText: '开会' })).not.toHaveAttribute('data-mentioned');
  expect(await p2.content()).not.toContain('老板');
  for (const p of [p1, p2, p3]) await p.context().close();
});

test('TC-MEN-01-05 TC-MEN-01-12 删掉"@小王 "或退格一次整段删除：发出去没有 mentions', async ({ browser }) => {
  const { u1, g } = await mentionGroup();
  const p = await open(browser, u1, chatUrl(g));
  await input(p).click();
  await p.keyboard.type('@');
  await p.getByTestId('mention-row').first().click();
  await expect(input(p)).toHaveValue('@小王 ');
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.press('Delete');
  await p.keyboard.type('删掉了');
  await p.keyboard.press('Enter');
  await expect.poll(() => sends(p).length).toBe(1);
  expect(sends(p)[0]!.data!.body).toEqual({ text: '删掉了' });

  await p.keyboard.type('你好 @');
  await p.getByTestId('mention-row').first().click();
  await expect(input(p)).toHaveValue('你好 @小王 ');
  await p.keyboard.press('Backspace');
  await expect(input(p)).toHaveValue('你好 ');
  await p.keyboard.type('退格');
  await p.keyboard.press('Enter');
  await expect.poll(() => sends(p).length).toBe(2);
  expect(sends(p)[1]!.data!.body).toEqual({ text: '你好 退格' });
  await p.context().close();
});

test('TC-MEN-01-06 单聊输入 @：不打开成员选择', async ({ browser }) => {
  const [a, b] = [uid('ca'), uid('cb')];
  await users({ [a]: a, [b]: b });
  const p = await open(browser, a, chatUrl(c2cId(a, b)));
  await input(p).click();
  await p.keyboard.type('@');
  await p.waitForTimeout(300);
  await expect(p.getByTestId('mention-picker')).toHaveCount(0);
  await expect(input(p)).toHaveValue('@');
  await p.context().close();
});

test('TC-MEN-01-08 a@b.com 不打开；行首＠打开；粘贴的"@u2"不打开、不产生 mentions', async ({ browser }) => {
  const { u1, u2, g } = await mentionGroup();
  const p = await open(browser, u1, chatUrl(g), { ...WIDE, permissions: ['clipboard-read', 'clipboard-write'] });
  await input(p).click();
  await p.keyboard.type('a@b.com');
  await p.waitForTimeout(300);
  await expect(p.getByTestId('mention-picker')).toHaveCount(0);
  await input(p).fill('');
  await p.keyboard.type('＠');
  await expect(p.getByTestId('mention-picker')).toBeVisible();
  await p.getByTestId('mention-cancel').click();
  await expect(input(p)).toHaveValue('＠');
  await input(p).fill('');
  await p.evaluate((t) => navigator.clipboard.writeText(t), `@${u2}`);
  await input(p).focus();
  await p.keyboard.press('ControlOrMeta+v');
  await expect(input(p)).toHaveValue(`@${u2}`);
  await p.waitForTimeout(300);
  await expect(p.getByTestId('mention-picker')).toHaveCount(0);
  await p.keyboard.press('Enter');
  await expect.poll(() => sends(p).length).toBe(1);
  expect(sends(p)[0]!.data!.body).toEqual({ text: `@${u2}` });
  await p.context().close();
});

test('TC-MEN-01-10 草稿带 @ 和引用：离开再回来都恢复，列表"[草稿]"；发送带 mentions 和 quote，u2 被提及', async ({
  browser,
}) => {
  const { u1, u2, gid, g } = await mentionGroup();
  const w = await wsAs(u2);
  const q = await w.send('group', gid, { text: '几点集合' });
  w.close();
  const p2 = await open(browser, u2);
  const p = await open(browser, u1, chatUrl(g), {}); // 窄屏（项目默认的手机）：有返回按钮
  await (await menu(p, '几点集合')).getByTestId('menu-quote').click();
  await p.keyboard.type('@');
  await p.locator(`[data-testid="mention-row"][data-user="${u2}"]`).click();
  await p.keyboard.type('九点');
  await p.getByRole('button', { name: '返回' }).click(); // 离开会话（页面内跳转，草稿只在内存）
  await expect(p.locator(`[data-conv-id="${g}"]`).getByTestId('draft-tag')).toHaveText('[草稿]');
  await expect(summary(p, g)).toHaveText('[草稿] @小王 九点');
  await p.locator(`[data-conv-id="${g}"]`).click();
  await expect(input(p)).toHaveValue('@小王 九点');
  await expect(p.getByTestId('quote-bar-text')).toHaveText('老板: 几点集合');
  await input(p).press('Enter');
  await expect.poll(() => sends(p).length).toBe(1);
  expect(sends(p)[0]!.data!.body).toEqual({
    text: '@小王 九点',
    quote: { msgId: q.msgId },
    mentions: { userIds: [u2] },
  });
  await expect(p2.locator(`[data-conv-id="${g}"]`).getByTestId('mention-tag')).toHaveText('[有人@我]');
  await p.context().close();
  await p2.context().close();
});

test('TC-MEN-02-04 只有管理员的选择列表里有"所有人"', async ({ browser }) => {
  const [o, a, m] = [uid('ao'), uid('aa'), uid('am')];
  await users({ [o]: o, [a]: a, [m]: m });
  const g = await groupOf(o, [a, m], [a]);
  const pa = await open(browser, a, chatUrl(g));
  const pm = await open(browser, m, chatUrl(g));
  for (const p of [pa, pm]) {
    await input(p).click();
    await p.keyboard.type('@');
    await expect(p.getByTestId('mention-row').first()).toBeVisible();
  }
  await expect(pa.getByTestId('mention-all')).toHaveText(/所有人/);
  await expect(pm.getByTestId('mention-all')).toHaveCount(0);
  await pa.context().close();
  await pm.context().close();
});

test('TC-MEN-02-05 4293：消息失败，提示"@所有人次数已用完"，断线重连后不自动重发', async ({ browser }) => {
  test.setTimeout(60_000);
  const [o, m] = [uid('lo'), uid('lm')];
  await users({ [o]: o, [m]: m });
  const g = await groupOf(o, [m]);
  const w = await wsAs(o);
  for (let i = 0; i < 3; i++)
    await w.send('group', g.slice('group:'.length), { text: `@所有人 ${i}`, mentions: { all: true } });
  w.close();
  const p = await open(browser, o, chatUrl(g));
  const net = await switchable(p);
  await input(p).click();
  await p.keyboard.type('@');
  await p.getByTestId('mention-all').click();
  await p.keyboard.type('第四次');
  await p.keyboard.press('Enter');
  await expect(p.locator('[data-testid="message"]', { hasText: '第四次' })).toHaveAttribute('data-status', 'failed');
  await expect(p.getByTestId('toast')).toHaveText('@所有人次数已用完');
  const before = sends(p).length;
  net.offline();
  await expect(p.getByTestId('conn-banner')).toBeVisible({ timeout: 10_000 });
  net.online();
  await expect(p.getByTestId('conn-banner')).toHaveCount(0, { timeout: 15_000 });
  await p.waitForTimeout(1000);
  expect(sends(p).length).toBe(before);
  await expect(p.locator('[data-testid="message"]', { hasText: '第四次' })).toHaveAttribute('data-status', 'failed');
  await p.context().close();
});

test('TC-MEN-03-05 有提及又有草稿：列表前缀是"[有人@我]"，不是"[草稿]"', async ({ browser }) => {
  const { u1, u2, gid, g } = await mentionGroup();
  const p2 = await open(browser, u2, chatUrl(g), {});
  await input(p2).fill('还没写完');
  await p2.getByRole('button', { name: '返回' }).click();
  await expect(p2.locator(`[data-conv-id="${g}"]`).getByTestId('draft-tag')).toBeVisible();
  const w = await wsAs(u1);
  await w.send('group', gid, { text: '@小王 看下', mentions: { userIds: [u2] } });
  w.close();
  const item = p2.locator(`[data-conv-id="${g}"]`);
  await expect(item.getByTestId('mention-tag')).toHaveText('[有人@我]');
  await expect(item.getByTestId('draft-tag')).toHaveCount(0);
  await p2.context().close();
});

test('TC-MEN-03-06 未读 100 条、提及在第 10 条：打开有"有人@我"，点了滚动到那条并高亮，按钮消失', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { u1, u2, gid, g } = await mentionGroup();
  const w = await wsAs(u1);
  let target = 0;
  for (let i = 1; i <= 100; i++) {
    const r = await w.send(
      'group',
      gid,
      i === 10 ? { text: '@小王 第十条', mentions: { userIds: [u2] } } : { text: `未读 ${i}` },
    );
    if (i === 10) target = r.seq;
  }
  w.close();
  const p = await open(browser, u2, chatUrl(g));
  const btn = p.getByTestId('mention-jump');
  await expect(btn).toHaveText('有人@我');
  await btn.click();
  await expect(btn).toHaveCount(0);
  const el = p.locator(`[data-seq="${target}"]`);
  await expect(el).toHaveClass(/tt-highlight/);
  await expect(el).toBeInViewport();
  await expect(el).toHaveAttribute('data-mentioned', 'true');
  await p.context().close();
});

// ---- 无障碍（AC-CHAT-90-9） ----

for (const scheme of ['light', 'dark'] as const) {
  test(`TC-CHAT-90-31（C4，${scheme}）：消息菜单、引用条、@ 选择、"有人@我"、撤回提示没有 axe 严重问题和 button-name 违规`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { u1, u2, gid, g } = await mentionGroup();
    const w = await wsAs(u2);
    await w.send('group', gid, { text: '@小一 看看', mentions: { userIds: [u1] } });
    for (let i = 0; i < 30; i++) await w.send('group', gid, { text: `填充 ${i}` });
    const r = await w.send('group', gid, { text: '要撤回的' });
    await w.ok('recall', { convId: g, msgId: r.msgId });
    w.close();
    const p = await open(browser, u1, chatUrl(g), { ...WIDE, colorScheme: scheme });
    await expect(p.getByTestId('mention-jump')).toBeVisible();
    await expect(p.getByTestId('msg-recalled')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await (await menu(p, '填充 29')).getByTestId('menu-quote').click();
    await expect(p.getByTestId('quote-bar')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await input(p).click();
    await p.keyboard.type('@');
    await expect(p.getByTestId('mention-row').first()).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await p.keyboard.press('Escape');
    await bubble(p, '填充 28').click({ button: 'right' });
    expect(await axeProblems(p)).toEqual([]);
    await p.context().close();
  });
}

test('TC-CHAT-90-31 键盘走查：Tab 到气泡，Shift+F10 打开菜单，方向键、回车"引用"，Esc 关闭；菜单键也能打开', async ({
  browser,
}) => {
  const [a, b] = [uid('ka'), uid('kb')];
  await users({ [a]: a, [b]: '小二' });
  const w = await wsAs(b);
  await w.send('c2c', a, { text: '键盘能打开吗' });
  w.close();
  const p = await open(browser, a, chatUrl(c2cId(a, b)));
  const target = bubble(p, '键盘能打开吗');
  await expect(target).toBeVisible();
  await p.locator('body').click({ position: { x: 1, y: 1 } });
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await p.keyboard.press('Tab');
    reached = await target.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await p.keyboard.press('Shift+F10');
  const m = p.getByTestId('bubble-menu');
  await expect(m).toBeVisible();
  await expect(m.getByRole('menuitem', { name: '复制' })).toBeFocused();
  await p.keyboard.press('Escape');
  await expect(m).toHaveCount(0);
  await expect(target).toBeFocused();
  await p.keyboard.press('ContextMenu');
  await expect(m).toBeVisible();
  await p.keyboard.press('ArrowDown');
  await expect(m.getByRole('menuitem', { name: '引用' })).toBeFocused();
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('quote-bar-text')).toHaveText('小二: 键盘能打开吗');
  await p.context().close();
});
