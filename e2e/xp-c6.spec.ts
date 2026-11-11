// FE-698：C6 的三端跨端（举报和 4510；H5、Android、iOS 对同一个 im-server，管理后台连同一个服务端）。共同约定（tianting-android 的
// CrossPlatformC6E2e、tianting-ios 的 CrossPlatformC6E2ETests、tianting-admin 的 e2e/xp-c6.spec.ts 照抄这一段）：
//   - 运行号 R；端 P = h5、android、ios。每个举报端 X 一个方向（信号的命名空间就是 X）：举报人 rX = xp{R}r{X}，被举报人 vX = xp{R}v{X}
//     （昵称就是 userId）；vX 同时登录在另外两端（接收端 Y、Z，同一个用户的两台设备）。另有 o = xp{R}o（群里发言、撤回）、
//     s = xp{R}s（哨兵）、群 G = xp{R}g「C6群-{R}」（o、rh5、randroid、rios），特征词 W = zxqword{R}（测试里现场加进词库，不是真实词）。
//     协调脚本先放好：vX 给 rX 发「XP6-v-{X}」；o 在 G 发「XP6-M-{R}」，再按 h5、android、ios 的顺序发「XP6-R-{X}」；等 W 生效。
//   - 接收端（vX 在 Y）：① 登录，列表里 rX 的会话摘要是「XP6-v-{X}」、未读 1；停在列表；贴 ready-{Y}，等另一个接收端的 ready
//     （它登录会给这边发新设备提醒，要在开始记录之前），开始记录下行（H5 记 WebSocket 帧、Android 记 SDK 事件、iOS 在中转上记帧），
//     贴 armed-{Y}。② 等到 reported（t0）：协调脚本紧接着让 s 给 vX 发哨兵「XP6-s1-{X}」：2 秒内哨兵出现在列表；等到 t0 + 2 秒，
//     记录到的下行都只和哨兵的会话有关（AC-MOD-03-1、F-MOD-03 规则 7：被举报人收不到任何帧），rX 的会话不变；贴 s1-ok-{Y}，重新开始记录。
//     ③ 等到 blocked（t0）：哨兵「XP6-s2-{X}」，同样 2 秒内出现、到 t0 + 2 秒只有哨兵，rX 的会话不变；打开 rX 的会话，只有
//     「XP6-v-{X}」，没有含 W 的消息（AC-MOD-02-1 的客户端部分）；贴 obs-done-{Y}。
//   - 举报端（rX 在 X）：① 登录，打开 vX 的会话看到「XP6-v-{X}」；等两个接收端的 armed。② 消息菜单「举报」→ 辱骂骚扰 → 提交，
//     轻提示「已提交，感谢你的反馈」、询问拉黑（点取消）；贴 reported。③ 等两个接收端的 s1-ok；发「XP6 含 {W}」：失败、提示
//     「消息包含不当内容，无法发送」、输入框清空；贴 blocked。④ 等两个接收端的 obs-done；打开 G，看到「XP6-M-{R}」「XP6-R-{X}」，
//     停 2 秒让已读报上去，贴 g-seen；协调脚本让 o 撤回「XP6-R-{X}」，贴 recalled（带 msgId）；最后一条撤回提示行的「举报」→ 其他 →
//     提交成功、不问拉黑（AC-MOD-03-11）；「XP6-M-{R}」的菜单「举报」→ 垃圾广告 → 提交成功（AC-MOD-04-1 的三端各举报一次）；贴 r-done。
//   - 最后一段（命名空间 final，三端同时在线）：各端以 rX 登录、打开 G、看到「XP6-M-{R}」，贴 f-ready-{X}；管理后台（审核员）看队列里
//     「XP6-M-{R}」那一行聚合"3 次"、授权看证据（水印）、删除这条消息，点最后一下之前贴 deleting；各端等到 deleting（t0）后
//     「XP6-M-{R}」消失、显示「该消息已被删除」，贴 f-done-{X}（带 ms）；后台结案。
//   - 反证：协调脚本 --fake X:report（没有举报端，协调脚本以 rX 给 vX 发一条再贴 reported）→ 接收端必须在 ② 失败；
//     --fake X:block（协调脚本真的举报，再以 rX 发一条普通消息后贴 blocked）→ 接收端必须在 ③ 失败。
// 环境变量：TT_XP（运行号）、TT_XP_COORD（信号板）、TT_XP_PHASE=reporter | observer | final，observer 还要 TT_XP_DIR（举报端 X）。
// 没有 TT_XP 时跳过。配置见 playwright.xp.config.ts。结果是 Chrome，本地。原文只在页面里断言，不打印。
import { expect, test, type Page } from '@playwright/test';
import { c2cId, chatUrl, WIDE } from './helpers';

const RUN = process.env.TT_XP ?? '';
const PHASE = process.env.TT_XP_PHASE ?? '';
const COORD = process.env.TT_XP_COORD ?? '';
const ME = 'h5';
const P = ['h5', 'android', 'ios'];
const X = PHASE === 'reporter' ? ME : PHASE === 'final' ? 'final' : (process.env.TT_XP_DIR ?? '');
const others = (x: string) => P.filter((y) => y !== x);
const r = (x: string) => `xp${RUN}r${x}`;
const v = (x: string) => `xp${RUN}v${x}`;
const S = `xp${RUN}s`;
const G = `group:xp${RUN}g`;
const WORD = `zxqword${RUN}`;

async function post(name: string, body: unknown = {}) {
  const res = await fetch(`${COORD}/s/${X}/${name}`, { method: 'POST', body: JSON.stringify(body) });
  expect(res.ok, `signal ${name}`).toBe(true);
}
/** 等信号，返回拿到它的本机时间和带的内容。 */
async function wait(name: string, ms = 300_000): Promise<{ seen: number; body: Record<string, string> }> {
  const res = await fetch(`${COORD}/s/${X}/${name}?t=${ms}`, { signal: AbortSignal.timeout(ms + 5000) });
  expect(res.status, `等信号 ${name}`).toBe(200);
  const val = (await res.json()) as { body: Record<string, string> };
  return { seen: Date.now(), body: val.body };
}
const log = (what: string, t0: number) => console.log(`TT-E2E-XP6 ${X} ${ME} ${what} ms=${Date.now() - t0}`);

const item = (page: Page, id: string) => page.locator(`[data-testid="conv-item"][data-conv-id="${id}"]`);
const summary = (page: Page, id: string) => item(page, id).locator('.tt-conv-summary');
const bubble = (page: Page, text: string) => page.locator('[data-testid="bubble"]', { hasText: text });
const toast = (page: Page) => page.getByTestId('toast');
const input = (page: Page) => page.getByTestId('composer-input');

async function login(page: Page, user: string) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-username').press('Enter');
  await expect(page).not.toHaveURL(/\/login/);
}
/** 不重新加载页面换路由。 */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function submit(page: Page, reason: string) {
  await expect(page.getByTestId('report-sheet')).toBeVisible();
  await expect(page.getByTestId('report-hint')).toHaveText('所选内容将提交给平台审核');
  await page.getByTestId(`report-reason-${reason}`).check();
  await page.getByTestId('report-submit').click();
  await expect(toast(page)).toHaveText('已提交，感谢你的反馈');
}

test.describe('FE-698 C6 跨端（H5）', () => {
  test.skip(
    !RUN || !COORD || !['reporter', 'observer', 'final'].includes(PHASE),
    '跨端用例要协调脚本传 TT_XP、TT_XP_COORD、TT_XP_PHASE',
  );

  test('TC-MOD-03-01、03-09、03-11、02-09（跨端，H5 是举报端）', async ({ browser }) => {
    test.skip(PHASE !== 'reporter', 'TT_XP_PHASE=reporter');
    test.setTimeout(900_000);
    const page = await (await browser.newContext(WIDE)).newPage();
    const conv = c2cId(r(X), v(X));
    await login(page, r(X));
    await expect(summary(page, conv)).toHaveText(`XP6-v-${X}`, { timeout: 30_000 });
    await go(page, chatUrl(conv));
    await expect(bubble(page, `XP6-v-${X}`)).toBeVisible();
    for (const y of others(X)) await wait(`armed-${y}`, 600_000);
    // ② 举报这条单聊消息
    await bubble(page, `XP6-v-${X}`).click({ button: 'right' });
    await page.getByTestId('bubble-menu').getByTestId('menu-report').click();
    await submit(page, 'abuse');
    await expect(page.getByTestId('report-block-dialog')).toContainText('要把对方加入黑名单吗？');
    await page.getByTestId('report-block-dialog').getByRole('button', { name: '取消' }).click();
    await post('reported');
    // ③ 4510
    for (const y of others(X)) await wait(`s1-ok-${y}`);
    await input(page).fill(`XP6 含 ${WORD}`);
    await input(page).press('Enter');
    await expect(toast(page)).toHaveText('消息包含不当内容，无法发送');
    await expect(page.getByTestId('message').filter({ hasText: WORD })).toHaveAttribute('data-status', 'failed');
    await expect(input(page)).toHaveValue('');
    await post('blocked');
    // ④ 撤回的群消息、AC-MOD-04-1 的目标
    for (const y of others(X)) await wait(`obs-done-${y}`);
    await go(page, chatUrl(G));
    await expect(bubble(page, `XP6-M-${RUN}`)).toBeVisible({ timeout: 15_000 });
    await expect(bubble(page, `XP6-R-${X}`)).toBeVisible();
    await page.waitForTimeout(2000); // 已读每秒最多报一次（服务端按 readSeq 判断看过没有）
    await post('g-seen');
    await wait('recalled', 60_000);
    await expect(bubble(page, `XP6-R-${X}`)).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId('recall-report').last().click();
    await submit(page, 'other');
    await page.waitForTimeout(800);
    await expect(page.getByTestId('report-block-dialog')).toHaveCount(0);
    await bubble(page, `XP6-M-${RUN}`).click({ button: 'right' });
    await page.getByTestId('bubble-menu').getByTestId('menu-report').click();
    await submit(page, 'spam');
    await page.waitForTimeout(800);
    await expect(page.getByTestId('report-block-dialog')).toHaveCount(0);
    await post('r-done');
    await page.context().close();
  });

  test('TC-MOD-03-01、02-01（跨端，H5 是被举报人的一台设备）', async ({ browser }) => {
    test.skip(PHASE !== 'observer' || !P.includes(X) || X === ME, 'TT_XP_PHASE=observer、TT_XP_DIR=android|ios');
    test.setTimeout(900_000);
    const page = await (await browser.newContext(WIDE)).newPage();
    // 记下所有下行帧（只在内存里）：没有 id 的是服务端推的。
    const frames: { at: number; text: string; push: boolean }[] = [];
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const text = String(m);
        let push = true;
        try {
          push = !(JSON.parse(text) as { id?: string }).id;
        } catch {
          /* 不是 JSON 也算一帧 */
        }
        frames.push({ at: Date.now(), text, push });
        ws.send(m);
      });
    });
    const rc = c2cId(r(X), v(X));
    const sc = c2cId(S, v(X));
    await login(page, v(X));
    await expect(summary(page, rc)).toHaveText(`XP6-v-${X}`, { timeout: 30_000 });
    await expect(item(page, rc).getByTestId('conv-badge')).toHaveCount(0); // vX 自己发的，没有未读
    await post(`ready-${ME}`);
    for (const y of others(X).filter((y) => y !== ME)) await wait(`ready-${y}`, 600_000);
    await page.waitForTimeout(1500); // 另一端登录时的新设备提醒落在记录之前
    let mark = frames.length;
    await post(`armed-${ME}`);
    /** 从 t0 到 t0 + 2 秒：哨兵出现，下行只有和哨兵会话有关的帧，rX 的会话不变。 */
    const window = async (t0: number, sentinel: string, step: string) => {
      await expect
        .poll(async () => ((await item(page, sc).count()) > 0 ? summary(page, sc).textContent() : null), {
          message: `${step}：2 秒内哨兵出现`,
          timeout: Math.max(1, t0 + 2000 - Date.now()),
          intervals: [50],
        })
        .toBe(sentinel);
      log(`${step} sentinel`, t0);
      await page.waitForTimeout(Math.max(0, t0 + 2000 - Date.now()));
      const got = frames.slice(mark).filter((f) => f.push);
      const stray = got.filter((f) => !f.text.includes(sc)).length;
      expect(stray, `${step}：被举报人收到了哨兵以外的帧（${got.length} 帧里 ${stray} 帧）`).toBe(0);
      expect(
        got.some((f) => f.text.includes(sentinel)),
        `${step}：哨兵的帧`,
      ).toBe(true);
      await expect(summary(page, rc)).toHaveText(`XP6-v-${X}`);
      await expect(item(page, rc).getByTestId('conv-badge')).toHaveCount(0);
      mark = frames.length;
    };
    // ②
    let t0 = (await wait('reported')).seen;
    await window(t0, `XP6-s1-${X}`, '举报之后');
    await post(`s1-ok-${ME}`);
    // ③
    t0 = (await wait('blocked')).seen;
    await window(t0, `XP6-s2-${X}`, '4510 之后');
    await item(page, rc).click();
    await expect(bubble(page, `XP6-v-${X}`)).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('message')).toHaveCount(1);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(WORD);
    await post(`obs-done-${ME}`);
    await page.context().close();
  });

  test('AC-MOD-04-1（跨端最后一段，H5）：后台删除的消息消失', async ({ browser }) => {
    test.skip(PHASE !== 'final', 'TT_XP_PHASE=final');
    test.setTimeout(900_000);
    const page = await (await browser.newContext(WIDE)).newPage();
    await login(page, r(ME));
    await go(page, chatUrl(G));
    await expect(bubble(page, `XP6-M-${RUN}`)).toBeVisible({ timeout: 15_000 });
    await post(`f-ready-${ME}`);
    const t0 = (await wait('deleting', 900_000)).seen;
    await expect(bubble(page, `XP6-M-${RUN}`)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('msg-deleted')).toHaveText('该消息已被删除');
    const ms = Date.now() - t0;
    log('deleted', t0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(`XP6-M-${RUN}`);
    await post(`f-done-${ME}`, { ms: String(ms) });
    await page.context().close();
  });
});
