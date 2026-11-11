// FE-686：C5 的三端互发互收（置顶、免打扰、删除的多端同步；H5、Android、iOS 对同一个 im-server）。同一个用户的两台设备分在两端，
// 两端同时在线：D1（发送端，TT_XP_PHASE=d1）在自己的界面上操作，D2（接收端，d2）在自己的界面上看。TT_XP_FROM 是另一端。
// 两端靠协调脚本的信号板对齐步骤（TT_XP_COORD，POST/GET /s/{dir}/{name}，GET 最多等 t 毫秒）。共同约定（tianting-android 的
// CrossPlatformC5E2e、tianting-ios 的 CrossPlatformC5E2ETests 照抄这一段）：
//   - 运行号 R；方向 dir = {D1}2{D2}（如 h52android），每个方向一个用户 U = xp{R}{dir}（昵称就是 userId）；对方 pa、pb、pc =
//     xp{R}pa、xp{R}pb、xp{R}pc。协调脚本先放好（按这个顺序）：pa 在群 G = xp{R}g{dir}「C5群-{dir}」（pa、U）发「XP5-g-{dir}」；
//     pc 给 U 发「ZXQ-XP5-c-{dir}」（会话 C）；pb 发「ZXQ-XP5-b-{dir}」（B）；pa 发「XP5-a1-{dir}」「XP5-a2-{dir}」（A，未读 2）。
//     初始顺序 A、B、C、G。
//   - D2：① 登录，列表是 A、B、C、G，A 未读 2；打开 C（看到原文）、打开 B 写草稿「XP5草稿-{dir}」，回到列表（B 显示 [草稿]）；
//     贴 d2-ready。② 等到 pin：2 秒内 A 在最前、置顶（AC-CVS-04-1）；贴 d2-pin。③ 等到 mute：2 秒内 A 免打扰（图标、小红点、
//     没有数字）；贴 d2-mute。④ 等到 del：2 秒内 B 从列表消失（AC-CVS-04-5）；贴 d2-del。⑤ 协调脚本在 d1-del、d2-del 都到了以后
//     让 pb 再发「XP5-b-new-{dir}」：B 重新出现，未读 1，摘要是新消息、没有 [草稿]；等到 d1-back 再打开（打开会把已读同步给 D1），只有这 1 条、输入框是空的（AC-CVS-03-2、
//     第 55 条）；贴 d2-back。⑥ 断网（H5 断 WebSocket、Android 飞行模式、iOS 断中转），贴 d2-offline。⑦ 等到 offline-done：
//     断网时 C 还在；恢复网络后列表的顺序、置顶、免打扰和 D1 贴的一样（G、A、B，G 和 A 置顶，A 免打扰），C 不在列表，打开 C
//     没有消息（AC-CVS-04-2）；贴 d2-done。
//   - D1：① 登录，等 d2-ready。② 长按（H5 右键）A，菜单出来后贴 pin 再点「置顶」；等 d2-pin。③ 同样贴 mute 再点「免打扰」；
//     等 d2-mute。④ 长按 B 点「删除」，确认框出来后贴 del 再点确认；B 消失后贴 d1-del。⑤ B 重新出现（未读 1）后贴 d1-back；等 d2-offline。
//     ⑥ 置顶 G、删除 C，列表是 G、A、B 后贴 offline-done（带上自己列表的 order、pinned、muted，用 a/b/c/g 表示）；等 d2-done。
//   - "2 秒"从 D2 拿到信号算起，D1 是先贴信号再点，所以 D1 的点击和界面也算在 2 秒里。
//   - 反证：协调脚本 --fake-sender {dir}，没有 D1，d2-ready 后协调脚本自己贴 pin，D2 必须在 ② 失败。
// 没有 TT_XP 时跳过。配置见 playwright.xp.config.ts。结果是 Chrome，本地。原文只在页面里断言，不打印。
import { expect, test, type Page } from '@playwright/test';
import { c2cId, chatUrl, WIDE } from './helpers';

const RUN = process.env.TT_XP ?? '';
const PHASE = process.env.TT_XP_PHASE ?? '';
const WITH = process.env.TT_XP_FROM ?? '';
const COORD = process.env.TT_XP_COORD ?? '';
const ME = 'h5';
const dir = PHASE === 'd1' ? `${ME}2${WITH}` : `${WITH}2${ME}`;
const U = `xp${RUN}${dir}`;
const conv = {
  a: c2cId(U, `xp${RUN}pa`),
  b: c2cId(U, `xp${RUN}pb`),
  c: c2cId(U, `xp${RUN}pc`),
  g: `group:xp${RUN}g${dir}`,
};
type K = keyof typeof conv;
const key = (id: string | null) => (Object.keys(conv) as K[]).find((k) => conv[k] === id) ?? `?${id}`;

async function post(name: string, body: unknown = {}) {
  const r = await fetch(`${COORD}/s/${dir}/${name}`, { method: 'POST', body: JSON.stringify(body) });
  expect(r.ok, `signal ${name}`).toBe(true);
}
/** 等信号，返回拿到它的本机时间和带的内容。 */
async function wait(name: string, ms = 180_000): Promise<{ seen: number; body: Record<string, string> }> {
  const r = await fetch(`${COORD}/s/${dir}/${name}?t=${ms}`, { signal: AbortSignal.timeout(ms + 5000) });
  expect(r.status, `等信号 ${name}`).toBe(200);
  const v = (await r.json()) as { body: Record<string, string> };
  return { seen: Date.now(), body: v.body };
}
/** 从 t0 算起 2 秒内成立。 */
async function within2s(t0: number, what: string, fn: () => Promise<boolean>) {
  await expect.poll(fn, { message: what, timeout: Math.max(1, t0 + 2000 - Date.now()), intervals: [50] }).toBe(true);
}

const item = (page: Page, id: string) => page.locator(`[data-testid="conv-item"][data-conv-id="${id}"]`);
const order = (page: Page) =>
  page.getByTestId('conv-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-conv-id')));
const keys = async (page: Page) => (await order(page)).map(key).join(',');
const summary = (page: Page, id: string) => item(page, id).locator('.tt-conv-summary');
const convMenu = (page: Page) => page.getByTestId('conv-menu');
const input = (page: Page) => page.getByTestId('composer-input');
const pinned = (page: Page, id: string) =>
  item(page, id)
    .getAttribute('data-pinned')
    .then((v) => v === 'true');
const muted = async (page: Page, id: string) =>
  (await item(page, id).getAttribute('data-notify-off')) !== null &&
  (await item(page, id).getByRole('img', { name: '免打扰' }).count()) === 1;
/** 页面自己的列表状态（a/b/c/g）。 */
async function state(page: Page) {
  const ks = (await order(page)).map(key);
  const p: string[] = [];
  const m: string[] = [];
  for (const k of ks) {
    if (await pinned(page, conv[k as K])) p.push(k);
    if (await muted(page, conv[k as K])) m.push(k);
  }
  return { order: ks.join(','), pinned: p.join(','), muted: m.join(',') };
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(U);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
}

/** 不重新加载页面换路由（重新加载会丢掉页面内存里的状态）。 */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function menu(page: Page, id: string) {
  await item(page, id).click({ button: 'right' });
  await expect(convMenu(page)).toBeVisible();
}

test.describe('FE-686 C5 跨端多端同步（H5）', () => {
  test.skip(
    !RUN || !COORD || !['android', 'ios'].includes(WITH),
    '跨端用例要协调脚本传 TT_XP、TT_XP_COORD、TT_XP_FROM',
  );

  test('TC-CVS-04-01、04-05、03-02、04-02（跨端，H5 是 D1）', async ({ browser }) => {
    test.skip(PHASE !== 'd1', 'TT_XP_PHASE=d1');
    test.setTimeout(600_000);
    const page = await (await browser.newContext(WIDE)).newPage();
    await login(page);
    await expect.poll(() => keys(page), { timeout: 30_000 }).toBe('a,b,c,g');
    await wait('d2-ready', 300_000);
    // ② 置顶 A
    await menu(page, conv.a);
    await post('pin');
    await convMenu(page).getByRole('menuitem', { name: '置顶' }).click();
    await expect(item(page, conv.a)).toHaveAttribute('data-pinned', 'true');
    await wait('d2-pin');
    // ③ 免打扰 A
    await menu(page, conv.a);
    await post('mute');
    await convMenu(page).getByRole('menuitem', { name: '免打扰' }).click();
    await expect.poll(() => muted(page, conv.a)).toBe(true);
    await wait('d2-mute');
    // ④ 删除 B
    await menu(page, conv.b);
    await convMenu(page).getByRole('menuitem', { name: '删除' }).click();
    const dialog = page.getByTestId('conv-delete-dialog');
    await expect(dialog).toBeVisible();
    await post('del');
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect(item(page, conv.b)).toHaveCount(0);
    await page.waitForTimeout(1000); // ack 之后仍然没有
    await expect(item(page, conv.b)).toHaveCount(0);
    await post('d1-del');
    // ⑤ pb 再发一条：B 重新出现，未读 1
    await expect(item(page, conv.b).getByTestId('conv-badge')).toHaveText('1', { timeout: 30_000 });
    await expect(summary(page, conv.b)).toHaveText(`XP5-b-new-${dir}`);
    await post('d1-back');
    await wait('d2-offline');
    // ⑥ D2 断网时：置顶 G、删除 C
    await menu(page, conv.g);
    await convMenu(page).getByRole('menuitem', { name: '置顶' }).click();
    await expect(item(page, conv.g)).toHaveAttribute('data-pinned', 'true');
    await menu(page, conv.c);
    await convMenu(page).getByRole('menuitem', { name: '删除' }).click();
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect.poll(() => keys(page)).toBe('g,a,b');
    await page.waitForTimeout(1000);
    const mine = await state(page);
    expect(mine).toEqual({ order: 'g,a,b', pinned: 'g,a', muted: 'a' });
    await post('offline-done', mine);
    await wait('d2-done');
    await page.context().close();
  });

  test('TC-CVS-04-01、04-05、03-02、04-02（跨端，H5 是 D2）', async ({ browser }) => {
    test.skip(PHASE !== 'd2', 'TT_XP_PHASE=d2');
    test.setTimeout(600_000);
    const page = await (await browser.newContext(WIDE)).newPage();
    // 可以"断网"的连接（同 c5.spec.ts 的 switchable）：offline 时关掉，新连接挂着不接通，online 后接上
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
    await login(page);
    // ① 初始状态；打开 C、在 B 写草稿
    await expect.poll(() => keys(page), { timeout: 30_000 }).toBe('a,b,c,g');
    await expect(item(page, conv.a).getByTestId('conv-badge')).toHaveText('2');
    await item(page, conv.c).click();
    await expect(page.getByTestId('message').filter({ hasText: `ZXQ-XP5-c-${dir}` })).toHaveCount(1);
    await item(page, conv.b).click();
    await expect(page.getByTestId('message').filter({ hasText: `ZXQ-XP5-b-${dir}` })).toHaveCount(1);
    await input(page).fill(`XP5草稿-${dir}`);
    await page.getByTestId('tab-contacts').click(); // 离开聊天页，草稿进列表
    await page.getByTestId('tab-chats').click();
    await expect(summary(page, conv.b)).toHaveText(`[草稿] XP5草稿-${dir}`);
    expect(await state(page)).toEqual({ order: 'a,b,c,g', pinned: '', muted: '' });
    await post('d2-ready');
    // ② 置顶
    let t0 = (await wait('pin')).seen;
    await within2s(
      t0,
      'A 在最前且置顶',
      async () => (await keys(page)).startsWith('a,') && (await pinned(page, conv.a)),
    );
    await post('d2-pin');
    // ③ 免打扰：图标、小红点、没有数字
    t0 = (await wait('mute')).seen;
    await within2s(
      t0,
      'A 免打扰',
      async () =>
        (await muted(page, conv.a)) &&
        (await item(page, conv.a).getByTestId('conv-dot').count()) === 1 &&
        (await item(page, conv.a).getByTestId('conv-badge').count()) === 0,
    );
    await expect(summary(page, conv.a)).toHaveText(`[2 条] XP5-a2-${dir}`);
    await post('d2-mute');
    // ④ 删除
    t0 = (await wait('del')).seen;
    await within2s(t0, 'B 从列表消失', async () => (await item(page, conv.b).count()) === 0);
    await post('d2-del');
    // ⑤ 重新出现：只有新消息，草稿已清
    await expect(item(page, conv.b).getByTestId('conv-badge')).toHaveText('1', { timeout: 30_000 });
    await expect(summary(page, conv.b)).toHaveText(`XP5-b-new-${dir}`);
    await wait('d1-back'); // 打开会把已读同步给 D1：D1 先看完"未读 1"
    await item(page, conv.b).click();
    await expect(page.getByTestId('message')).toHaveCount(1);
    await expect(page.getByTestId('message')).toContainText(`XP5-b-new-${dir}`);
    await page.getByTestId('message-list').evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(500);
    await expect(page.getByTestId('message')).toHaveCount(1);
    await expect(input(page)).toHaveValue('');
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(`ZXQ-XP5-b-${dir}`);
    await page.getByTestId('tab-chats').click();
    await post('d2-back');
    // ⑥ 断网
    st.online = false;
    st.close();
    await expect(page.getByTestId('conn-banner')).toBeVisible({ timeout: 15_000 });
    await post('d2-offline');
    // ⑦ D1 改完后：断网时还是旧的，恢复后和 D1 一样
    const done = await wait('offline-done', 300_000);
    await expect(item(page, conv.c)).toHaveCount(1);
    st.online = true;
    for (const w of st.waiters.splice(0)) w();
    await expect(page.getByTestId('conn-banner')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => state(page), { timeout: 20_000 }).toEqual(done.body);
    expect(done.body).toEqual({ order: 'g,a,b', pinned: 'g,a', muted: 'a' });
    await go(page, chatUrl(conv.c));
    await expect(input(page)).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('message')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(`ZXQ-XP5-c-${dir}`);
    await post('d2-done');
    await page.context().close();
  });
});
