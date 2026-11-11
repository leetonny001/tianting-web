// FE-693（PRD-chat C6）：举报入口和举报单、4510 的提示（IM_MOD_ENABLED=1，演示登录）。
// 两类用例：
// - 真实 im-server：report（BE-495）、词库管理接口（BE-493）、发送检查（BE-494）没有之前，这些用例在服务端回 4001、
//   词库接口 404 或消息照常发出时如实失败，不跳过、不放宽（"等 BE-493～495"）。
// - 改写帧（routeWebSocket）：服务端还没有的 ack 由测试回给页面，先验页面自己的行为（标题里写"改写帧"）。
// 不放真实敏感词：被拦截的内容只用特征串（zxqword…，F-MOD-01 规则 5）。帧内容只在内存里断言，不打印。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { demoToken } from './files';
import { admin, c2cId, chatUrl, signed, uid, WIDE } from './helpers';
import { SERVER } from './ports';

// ---- 工具 ----

type Frame = { id?: string; cmd?: string; data?: Record<string, unknown>; error?: { code: number; msg?: string } };

/** 用 WebSocket 以某个用户直接调命令（预先放消息、撤回）。got 记下所有下行帧（被举报人收不到帧的断言用）。 */
async function wsAs(userId: string) {
  const token = await demoToken(userId);
  const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws?platform=web');
  const pending = new Map<string, (f: Frame) => void>();
  const got: Frame[] = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as Frame;
    got.push(f);
    if (f.id) pending.get(f.id)?.(f);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws error'));
  });
  let n = 0;
  const call = (cmd: string, data: unknown) =>
    new Promise<Frame>((res) => {
      const id = `c6-${++n}`;
      pending.set(id, (f) => {
        pending.delete(id);
        res(f);
      });
      ws.send(JSON.stringify({ id, cmd, data }));
    });
  const auth = await call('auth', { token });
  if (auth.error) throw new Error(`auth ${auth.error.code}`);
  const ok = async (cmd: string, data: unknown) => {
    for (let tries = 0; ; tries++) {
      const r = await call(cmd, data);
      if (r.error?.code === 4290 && tries < 100) {
        await new Promise((res) => setTimeout(res, 250));
        continue;
      }
      if (r.error) throw new Error(`${cmd} ${r.error.code}`);
      return r.data as Record<string, unknown>;
    }
  };
  return {
    got,
    send: (convType: 'c2c' | 'group', to: string, text: string) =>
      ok('send', {
        convType,
        to,
        type: 'text',
        body: { text },
        clientMsgId: randomBytes(8).toString('hex'),
      }) as Promise<{
        msgId: string;
        seq: number;
      }>,
    ok,
    close: () => ws.close(),
  };
}

async function users(list: Record<string, string>) {
  await admin('POST', '/admin/users/import', {
    users: Object.entries(list).map(([userId, nickname]) => ({ userId, nickname })),
  });
}

async function groupOf(owner: string, members: string[], name = 'C6 群') {
  const g = uid('g');
  await signed('/admin/groups', { groupId: g, name, members: [owner, ...members], owner });
  return { groupId: g, convId: `group:${g}` };
}

/** 同一个 id 和 cmd 只记一次（被 routeWebSocket 接管的连接 Playwright 也会报 framesent，同 c5.spec.ts）。 */
function record(into: Frame[], f: Frame) {
  if (f.id && into.some((x) => x.id === f.id && x.cmd === f.cmd)) return;
  into.push(f);
}

/** 新上下文里演示登录，记下页面的 WebSocket 帧（只在内存）。默认窄屏（Pixel 7，触屏）。 */
async function open(browser: Browser, userId: string, opts?: BrowserContextOptions, path = '/chats') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const sent: Frame[] = [];
  const got: Frame[] = [];
  const parse = (into: Frame[]) => (f: { payload: string | Buffer }) => {
    try {
      record(into, JSON.parse(String(f.payload)) as Frame);
    } catch {
      // 不是 JSON 的帧不管
    }
  };
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

/** 改写帧：up 返回 true 表示这条上行由测试回答，不转给服务端。设置后重新加载。 */
async function intercept(page: P, up: (f: Frame, reply: (r: Frame) => void) => boolean) {
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as Frame;
      record(page.sent, f);
      if (up(f, (r) => (record(page.got, r), ws.send(JSON.stringify(r))))) return;
      server.send(m);
    });
    server.onMessage((m) => {
      record(page.got, JSON.parse(String(m)) as Frame);
      ws.send(m);
    });
  });
  await page.reload();
}

/** 举报由测试回答：replies 按顺序用（最后一个重复用），记下页面发出的 report。 */
async function fakeReports(page: P, ...replies: Array<{ reportId: string } | { code: number; reason?: string }>) {
  let i = 0;
  await intercept(page, (f, reply) => {
    if (f.cmd !== 'report') return false;
    const r = replies[Math.min(i++, replies.length - 1)]!;
    reply(
      'code' in r
        ? { id: f.id, cmd: 'ack', error: { code: r.code, msg: 'x', ...(r.reason ? { reason: r.reason } : {}) } }
        : { id: f.id, cmd: 'ack', data: r },
    );
    return true;
  });
}

/** 让 GET /v1/config 的 features.moderation 为 false（其余照真实服务端）。 */
async function moderationOff(page: Page) {
  await page.route('**/v1/config', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { features?: Record<string, unknown> };
    await route.fulfill({ response: res, json: { ...json, features: { ...json.features, moderation: false } } });
  });
}

/** 等这个命令最近一次请求的 ack（服务端还没有这个命令时是 4001）。 */
async function ackOf(p: P, cmd: string): Promise<Frame> {
  const id = p.sent.filter((f) => f.cmd === cmd).at(-1)?.id;
  expect(id, `${cmd} sent`).toBeTruthy();
  await expect.poll(() => p.got.some((f) => f.id === id), { message: `${cmd} ack` }).toBe(true);
  return p.got.find((f) => f.id === id)!;
}

const bubble = (page: Page, text: string) => page.locator('[data-testid="bubble"]', { hasText: text });
const sheet = (page: Page) => page.getByTestId('report-sheet');
const toast = (page: Page) => page.getByTestId('toast');
const reports = (p: P) => p.sent.filter((f) => f.cmd === 'report');
const input = (page: Page) => page.getByTestId('composer-input');

async function menu(page: Page, text: string) {
  const m = page.getByTestId('bubble-menu');
  await bubble(page, text).click({ button: 'right' });
  await expect(m).toBeVisible();
  return m;
}

/** 从消息菜单打开举报单，选理由、填说明、提交。 */
async function reportMessage(page: Page, text: string, reason: string, note?: string) {
  await (await menu(page, text)).getByTestId('menu-report').click();
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId(`report-reason-${reason}`).check();
  if (note !== undefined) await page.getByTestId('report-note').fill(note);
  await page.getByTestId('report-submit').click();
}

/**
 * 撤回提示行的"举报"点击区域不小于 44×44（PRD-ui 最小触控区域，frontend-chat 第 93 条）；字号和提示行文字一样，没有变大。
 * 在按钮区域边缘（中心上下 20px）点也落在按钮上。
 */
async function expectTouchTarget(page: Page) {
  const btn = page.getByTestId('recall-report');
  const box = (await btn.boundingBox())!;
  expect(box.width, 'width').toBeGreaterThanOrEqual(44);
  expect(box.height, 'height').toBeGreaterThanOrEqual(44);
  const font = (l: typeof btn) => l.evaluate((el) => getComputedStyle(el).fontSize);
  expect(await font(btn)).toBe(await font(page.getByTestId('msg-recalled')));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const y of [cy - 20, cy + 20]) {
    expect(
      await page.evaluate(([x, yy]) => document.elementFromPoint(x!, yy!)?.getAttribute('data-testid'), [cx, y]),
    ).toBe('recall-report');
  }
}

const axeProblems = async (page: Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.id === 'button-name' || v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
};

/** token 在当前配色下解析出来的颜色（和 getComputedStyle 同一种写法）。 */
const tokenColor = (page: Page, name: string) =>
  page.evaluate((n) => {
    const d = document.createElement('div');
    d.style.color = `var(${n})`;
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);

/** u1 给 u2 发一条单聊消息。 */
async function c2cWith(prefix: string, text: string) {
  const [u1, u2] = [uid(`${prefix}a`), uid(`${prefix}b`)];
  await users({ [u1]: '小一', [u2]: '小二' });
  const w = await wsAs(u1);
  await w.send('c2c', u2, text);
  return { u1, u2, w, conv: c2cId(u1, u2) };
}

/** 词库加一个特征词（moderation.words，BE-493），返回 wordId 以便删掉。 */
async function addWord(word: string): Promise<string> {
  const r = (await signed('/admin/moderation/words', { word })) as { word: { wordId: string } };
  return r.word.wordId;
}
async function removeWord(wordId: string | undefined) {
  if (!wordId) return;
  await admin('DELETE', `/admin/moderation/words/${wordId}`).catch(() => {});
}
/** 词库变更 10 秒内生效（F-MOD-01 规则 2）：发探针直到被拦截（最多 12 秒）。 */
async function waitBlocked(w: Awaited<ReturnType<typeof wsAs>>, to: string, word: string) {
  for (let i = 0; i < 24; i++) {
    try {
      await w.send('c2c', to, `探针 ${word}`);
    } catch (e) {
      if (String(e).includes('4510')) return;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('word never took effect');
}

// ---- 真实 im-server ----

test('TC-MOD-03-09 TC-MOD-03-01（真实 report，等 BE-495）：窄屏长按单聊消息"举报"，提交前有提示，成功轻提示并询问拉黑；被举报人 2 秒内收不到帧', async ({
  browser,
}) => {
  const { u1, u2, w, conv } = await c2cWith('rp', 'ZXQ-RPT-1 一条单聊');
  const p = await open(browser, u2, undefined, chatUrl(conv));
  const b = bubble(p, 'ZXQ-RPT-1');
  await expect(b).toBeVisible();
  // 窄屏长按 600ms
  const box = (await b.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(600);
  await p.mouse.up();
  await expect(p.getByTestId('bubble-menu').getByRole('menuitem')).toHaveText(['复制', '引用', '举报']);
  await p.getByTestId('menu-report').click();
  await expect(sheet(p).getByRole('radio')).toHaveCount(6);
  await expect(p.getByTestId('report-count')).toHaveText('0/200');
  await expect(p.getByTestId('report-hint')).toHaveText('所选内容将提交给平台审核');
  await expect(p.getByTestId('report-submit')).toBeDisabled();
  await p.getByTestId('report-reason-abuse').check();
  await p.getByTestId('report-note').fill('ZXQ-RPT-NOTE 补充');
  const before = w.got.length;
  await p.getByTestId('report-submit').click();
  const ack = await ackOf(p, 'report');
  expect(reports(p)[0]!.data).toEqual({
    targetType: 'message',
    convId: conv,
    msgIds: [expect.any(String)],
    reason: 'abuse',
    note: 'ZXQ-RPT-NOTE 补充',
  });
  expect(ack.error?.code, 'report ack error（BE-495 之前是 4001）').toBeUndefined();
  expect(typeof ack.data?.reportId).toBe('string');
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  await expect(p.getByTestId('report-block-dialog')).toContainText('要把对方加入黑名单吗？');
  await p.waitForTimeout(2000);
  expect(w.got.slice(before), `${u1} 收到了帧`).toEqual([]);
  w.close();
  await p.context().close();
});

test('TC-MOD-03-09 第 3 条（真实 report，等 BE-495）：宽屏右键群消息"举报"，成功后不询问拉黑', async ({ browser }) => {
  const [u1, u2] = [uid('rga'), uid('rgb')];
  await users({ [u1]: '群一', [u2]: '群二' });
  const g = await groupOf(u1, [u2]);
  const w = await wsAs(u1);
  await w.send('group', g.groupId, 'ZXQ-RPT-G 群消息');
  w.close();
  const p = await open(browser, u2, WIDE, chatUrl(g.convId));
  await reportMessage(p, 'ZXQ-RPT-G', 'spam');
  const ack = await ackOf(p, 'report');
  expect(ack.error?.code, 'report ack error（BE-495 之前是 4001）').toBeUndefined();
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  await expect(p.getByTestId('report-block-dialog')).toHaveCount(0);
  await p.context().close();
});

test('TC-MOD-03-11（真实 report，等 BE-495）：群里看过后被撤回的消息，提示行"举报"成功；撤回者自己的提示行没有"举报"', async ({
  browser,
}) => {
  const [u1, u2] = [uid('rca'), uid('rcb')];
  await users({ [u1]: '撤一', [u2]: '撤二' });
  const g = await groupOf(u1, [u2]);
  const w = await wsAs(u1);
  const m = await w.send('group', g.groupId, 'ZXQ-RPT-3 要撤回的');
  const p = await open(browser, u2, undefined, chatUrl(g.convId));
  await expect(bubble(p, 'ZXQ-RPT-3')).toBeVisible();
  await w.ok('recall', { convId: g.convId, msgId: m.msgId });
  w.close();
  await expect(p.getByTestId('msg-recalled')).toHaveText('撤一撤回了一条消息');
  await expectTouchTarget(p);
  await p.getByTestId('recall-report').click();
  await p.getByTestId('report-reason-other').check();
  await p.getByTestId('report-submit').click();
  expect((await ackOf(p, 'report')).error?.code, 'report ack error（BE-495 之前是 4001）').toBeUndefined();
  expect(reports(p)[0]!.data).toMatchObject({ targetType: 'message', convId: g.convId, msgIds: [m.msgId] });
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  const own = await open(browser, u1, undefined, chatUrl(g.convId));
  await expect(own.getByTestId('msg-recalled')).toHaveText('你撤回了一条消息');
  await expect(own.getByTestId('recall-report')).toHaveCount(0);
  await p.context().close();
  await own.context().close();
});

test('TC-MOD-02-09（真实发送检查，等 BE-493、BE-494）：特征词被拦截：失败、输入框清空、提示不含词、30 秒不重发，菜单只有"复制""删除"', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const word = `zxqword${randomBytes(4).toString('hex')}`;
  const [u1, u2] = [uid('bwa'), uid('bwb')];
  await users({ [u1]: '发一', [u2]: '收二' });
  let wordId: string | undefined;
  try {
    wordId = await addWord(word);
    const w = await wsAs(u1);
    await waitBlocked(w, u2, word);
    w.close();
    const p = await open(browser, u1, undefined, chatUrl(c2cId(u1, u2)));
    await input(p).fill(`说一句 ${word}`);
    await input(p).press('Enter');
    await expect(input(p)).toHaveValue('');
    const msg = p.getByTestId('message').filter({ hasText: word });
    await expect(msg).toHaveAttribute('data-status', 'failed');
    await expect(toast(p)).toHaveText('消息包含不当内容，无法发送');
    const ack = await ackOf(p, 'send');
    expect(ack.error?.code).toBe(4510);
    expect(JSON.stringify(ack.error)).not.toContain(word);
    await p.waitForTimeout(30_000);
    expect(p.sent.filter((f) => f.cmd === 'send')).toHaveLength(1);
    await expect((await menu(p, word)).getByRole('menuitem')).toHaveText(['复制', '删除']);
    await p.context().close();
  } finally {
    await removeWord(wordId);
  }
});

test('AC-MOD-02-5 的页面部分（真实 groupUpdate，等 BE-493、BE-494）：群名被拦截提示"内容包含不当信息，请修改后重试"，改名框重新打开、内容保留', async ({
  browser,
}) => {
  const word = `zxqword${randomBytes(4).toString('hex')}`;
  const [u1, u2] = [uid('gna'), uid('gnb')];
  await users({ [u1]: '群主', [u2]: '成员' });
  const g = await groupOf(u1, [u2]);
  let wordId: string | undefined;
  try {
    wordId = await addWord(word);
    const w = await wsAs(u1);
    await waitBlocked(w, u2, word);
    w.close();
    const p = await open(browser, u1, undefined, `${chatUrl(g.convId)}/info`);
    await p.getByTestId('group-name').click();
    await p.getByTestId('rename-input').fill(`新名 ${word}`);
    await p.getByTestId('rename-save').click();
    await expect(toast(p)).toHaveText('内容包含不当信息，请修改后重试');
    await expect(p.getByTestId('rename-input')).toHaveValue(`新名 ${word}`);
    await p.context().close();
  } finally {
    await removeWord(wordId);
  }
});

test('第 76 条：真实服务端 features.moderation=true 时三类入口都在；改写成 false 时消息菜单、撤回提示行、资料卡、群信息页都没有"举报"', async ({
  browser,
}) => {
  const [u1, u2] = [uid('ofa'), uid('ofb')];
  await users({ [u1]: '开一', [u2]: '开二' });
  const g = await groupOf(u1, [u2]);
  const w = await wsAs(u1);
  await w.send('group', g.groupId, '留着的话');
  const m = await w.send('group', g.groupId, '要撤回的话');
  const on = await open(browser, u2, undefined, chatUrl(g.convId));
  await expect(bubble(on, '要撤回的话')).toBeVisible();
  await w.ok('recall', { convId: g.convId, msgId: m.msgId });
  w.close();
  await expect(on.getByTestId('recall-report')).toBeVisible();
  await expect((await menu(on, '留着的话')).getByRole('menuitem')).toHaveText(['复制', '引用', '举报']);
  await on.keyboard.press('Escape');
  await on.goto(`/user/${u1}`);
  await on.getByTestId('user-more').click();
  await expect(on.getByTestId('user-report')).toBeVisible();
  await on.goto(`${chatUrl(g.convId)}/info`);
  await expect(on.getByTestId('group-report')).toBeVisible();
  await on.context().close();

  const off = await open(browser, u2);
  await moderationOff(off);
  await off.goto(chatUrl(g.convId));
  await expect(off.getByTestId('msg-recalled')).toBeVisible();
  await expect(off.getByTestId('recall-report')).toHaveCount(0);
  await expect((await menu(off, '留着的话')).getByRole('menuitem')).toHaveText(['复制', '引用']);
  await off.keyboard.press('Escape');
  await off.goto(`/user/${u1}`);
  await off.getByTestId('user-more').click();
  await expect(off.getByTestId('user-menu')).toBeVisible();
  await expect(off.getByTestId('user-report')).toHaveCount(0);
  await off.goto(`${chatUrl(g.convId)}/info`);
  await expect(off.getByTestId('group-leave')).toBeVisible();
  await expect(off.getByTestId('group-report')).toHaveCount(0);
  await off.context().close();
});

// ---- 改写帧 ----

test('改写帧：TC-CHAT-90-45 只用键盘完成举报：Tab 到气泡、Shift+F10、End 到"举报"、回车、方向键选理由、Tab 到提交、回车；Esc 能关闭举报单', async ({
  browser,
}) => {
  const { u2, w, conv } = await c2cWith('kb', 'ZXQ-KB 键盘举报');
  w.close();
  const p = await open(browser, u2, WIDE, chatUrl(conv));
  await fakeReports(p, { reportId: 'r-kb' });
  const b = bubble(p, 'ZXQ-KB');
  await expect(b).toBeVisible();
  await b.focus();
  await p.keyboard.press('Shift+F10');
  await expect(p.getByTestId('bubble-menu').getByRole('menuitem', { name: '复制' })).toBeFocused();
  await p.keyboard.press('End');
  await expect(p.getByTestId('menu-report')).toBeFocused();
  await p.keyboard.press('Enter');
  await expect(sheet(p)).toBeVisible();
  // Esc 关闭，焦点不丢
  await p.keyboard.press('Escape');
  await expect(sheet(p)).toHaveCount(0);
  await b.focus();
  await p.keyboard.press('Shift+F10');
  await p.keyboard.press('End');
  await p.keyboard.press('Enter');
  await expect(sheet(p)).toBeVisible();
  const first = p.getByTestId('report-reason-spam');
  for (let i = 0; i < 10 && !(await first.evaluate((el) => el === document.activeElement)); i++)
    await p.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await p.keyboard.press('ArrowDown');
  await expect(p.getByTestId('report-reason-abuse')).toBeChecked();
  await expect(p.getByTestId('report-reason-abuse')).toBeFocused();
  await p.keyboard.press('Tab');
  await expect(p.getByTestId('report-note')).toBeFocused();
  await p.keyboard.type('键盘说明');
  await p.keyboard.press('Tab');
  await expect(p.getByTestId('report-submit')).toBeFocused();
  await p.keyboard.press('Enter');
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  expect(reports(p)).toHaveLength(1);
  expect(reports(p)[0]!.data).toMatchObject({ targetType: 'message', convId: conv, reason: 'abuse', note: '键盘说明' });
  await expect(p.getByTestId('report-block-dialog')).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('report-block-dialog')).toHaveCount(0);
  await p.context().close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`改写帧：TC-CHAT-90-44、45 axe（${scheme}）：举报单、询问拉黑、撤回提示行、资料卡菜单没有 button-name 等违规；图标是 Lucide flag，颜色来自 token`, async ({
    browser,
  }) => {
    const [u1, u2] = [uid(scheme === 'light' ? 'axa' : 'axd'), uid(scheme === 'light' ? 'axb' : 'axe')];
    await users({ [u1]: '甲', [u2]: '乙' });
    const w = await wsAs(u1);
    await w.send('c2c', u2, '留着');
    const m = await w.send('c2c', u2, '撤回的');
    const conv = c2cId(u1, u2);
    const p = await open(browser, u2, { ...WIDE, colorScheme: scheme }, chatUrl(conv));
    await fakeReports(p, { reportId: 'r-axe' });
    await expect(bubble(p, '撤回的')).toBeVisible();
    await w.ok('recall', { convId: conv, msgId: m.msgId });
    w.close();
    await expect(p.getByTestId('recall-report')).toBeVisible();
    await expect(p.getByTestId('msg-recalled')).toHaveText('对方撤回了一条消息');
    await expectTouchTarget(p);
    expect(await p.getByTestId('recall-report').evaluate((el) => getComputedStyle(el).color)).toBe(
      await tokenColor(p, '--tt-color-brand'),
    );
    expect(await axeProblems(p)).toEqual([]);

    await p.getByTestId('recall-report').click();
    await expect(sheet(p)).toBeVisible();
    await expect(sheet(p).locator('svg.lucide-flag')).toHaveCount(1);
    await expect(sheet(p).locator('svg.lucide-flag')).toHaveAttribute('aria-hidden', 'true');
    await expect(sheet(p)).toHaveAccessibleName('举报');
    expect(await p.getByTestId('report-reason-spam').evaluate((el) => getComputedStyle(el).accentColor)).toBe(
      await tokenColor(p, '--tt-color-brand'),
    );
    expect(await axeProblems(p)).toEqual([]);
    await p.getByTestId('report-reason-porn').check();
    await p.getByTestId('report-note').dispatchEvent('paste'); // 粘贴超长（第 84 条）
    await p.getByTestId('report-note').fill('😀'.repeat(150) + '字'.repeat(60));
    await expect(p.getByTestId('report-note')).toHaveValue('😀'.repeat(150) + '字'.repeat(50));
    await expect(p.getByTestId('report-count')).toHaveText('200/200');
    await expect(p.getByTestId('report-clipped')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await p.getByTestId('report-submit').click();
    await expect(p.getByTestId('report-block-dialog')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await p.getByTestId('report-block-dialog').getByRole('button', { name: '取消' }).click();

    await p.goto(`/user/${u1}`);
    await p.getByTestId('user-more').click();
    await expect(p.getByTestId('user-report')).toBeVisible();
    expect(await axeProblems(p)).toEqual([]);
    await p.context().close();
  });
}

test('改写帧：举报失败 4292、4040、4030 按"命令 + 码"提示并关闭；5000 提示后举报单留着，手动再提交成功；都不自动重试', async ({
  browser,
}) => {
  const { u2, w, conv } = await c2cWith('er', 'ZXQ-ERR 举报失败');
  w.close();
  const p = await open(browser, u2, undefined, chatUrl(conv));
  await fakeReports(
    p,
    { code: 4292 },
    { code: 4040, reason: 'reportTargetInvalid' },
    { code: 4030, reason: 'featureDisabled' },
    { code: 5000 },
    { reportId: 'r-ok' },
  );
  for (const text of ['今天的举报次数已用完', '无法举报该内容', '举报功能暂不可用']) {
    const n = reports(p).length;
    await reportMessage(p, 'ZXQ-ERR', 'other');
    await expect(toast(p)).toHaveText(text);
    await expect(sheet(p)).toHaveCount(0);
    await p.waitForTimeout(300);
    expect(reports(p)).toHaveLength(n + 1);
  }
  await reportMessage(p, 'ZXQ-ERR', 'fraud', '说明留着');
  await expect(toast(p)).toHaveText('服务异常，请稍后重试');
  await expect(sheet(p)).toBeVisible();
  await expect(p.getByTestId('report-note')).toHaveValue('说明留着');
  await expect(p.getByTestId('report-reason-fraud')).toBeChecked();
  expect(reports(p)).toHaveLength(4);
  await p.getByTestId('report-submit').click();
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  expect(reports(p)).toHaveLength(5);
  await p.context().close();
});

test('改写帧：TC-MOD-02-09 的页面部分（send 回 4510）：失败、输入框清空、提示一次、不重发；失败图标读出原因，点了只能删除', async ({
  browser,
}) => {
  const [u1, u2] = [uid('fba'), uid('fbb')];
  await users({ [u1]: '发', [u2]: '收' });
  const p = await open(browser, u1, undefined, chatUrl(c2cId(u1, u2)));
  await intercept(p, (f, reply) => {
    if (f.cmd !== 'send') return false;
    reply({ id: f.id, cmd: 'ack', error: { code: 4510, msg: 'content blocked' } });
    return true;
  });
  await input(p).fill('ZXQWORD 被拦的话');
  await input(p).press('Enter');
  await expect(input(p)).toHaveValue('');
  const msg = p.getByTestId('message').filter({ hasText: 'ZXQWORD' });
  await expect(msg).toHaveAttribute('data-status', 'failed');
  await expect(toast(p)).toHaveText('消息包含不当内容，无法发送');
  await p.waitForTimeout(3000);
  expect(p.sent.filter((f) => f.cmd === 'send')).toHaveLength(1);
  await expect((await menu(p, 'ZXQWORD')).getByRole('menuitem')).toHaveText(['复制', '删除']);
  await p.keyboard.press('Escape');
  const icon = msg.getByTestId('failed-icon');
  await expect(icon).toHaveAccessibleName('发送失败：消息包含不当内容，无法发送');
  await icon.click();
  const dlg = p.getByTestId('no-retry-dialog');
  await expect(dlg).toContainText('消息包含不当内容，无法发送');
  await expect(dlg.getByRole('button')).toHaveText(['取消', '删除']);
  await dlg.getByRole('button', { name: '删除' }).click();
  await expect(msg).toHaveCount(0);
  expect(p.sent.filter((f) => f.cmd === 'send')).toHaveLength(1);
  await p.context().close();
});

test('改写帧：资料卡"举报"举报用户，成功后选"加入黑名单"走真实拉黑；群信息页"举报"举报群，不询问拉黑', async ({
  browser,
}) => {
  const [u1, u2] = [uid('uca'), uid('ucb')];
  await users({ [u1]: '卡一', [u2]: '卡二' });
  const g = await groupOf(u1, [u2]);
  const p = await open(browser, u2, undefined, `/user/${u1}`);
  await fakeReports(p, { reportId: 'r-user' }, { reportId: 'r-group' });
  await p.getByTestId('user-more').click();
  await p.getByTestId('user-report').click();
  await p.getByTestId('report-reason-spam').check();
  await p.getByTestId('report-submit').click();
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  expect(reports(p)[0]!.data).toEqual({ targetType: 'user', userId: u1, reason: 'spam' });
  await p.getByTestId('report-block-dialog').getByRole('button', { name: '加入黑名单' }).click();
  expect((await ackOf(p, 'block')).error).toBeUndefined();
  await expect(p.getByTestId('user-blocked')).toBeVisible();

  await p.goto(`${chatUrl(g.convId)}/info`);
  await p.getByTestId('group-report').click();
  await p.getByTestId('report-reason-illegal').check();
  await p.getByTestId('report-submit').click();
  await expect(toast(p)).toHaveText('已提交，感谢你的反馈');
  expect(reports(p).at(-1)!.data).toEqual({ targetType: 'group', groupId: g.groupId, reason: 'illegal' });
  await expect(p.getByTestId('report-block-dialog')).toHaveCount(0);
  await p.context().close();
});
