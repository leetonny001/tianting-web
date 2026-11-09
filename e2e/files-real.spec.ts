// FE-633、FE-634：图片和文件对真实 im-server（IM_FILES_ENABLED=1）+ 假 S3（e2e/fake_s3.py，跨域直传）。结果是 Chrome，本地。
// 调 IM 钟的用例（过期、24 小时清理）在 zz-im-clock.spec.ts。用例编号见 docs/testcases/TC-FILE.md。
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  bombPng,
  canvasJpeg,
  demoToken,
  jpegHasMetadata,
  makeGif,
  makePng,
  s3List,
  s3Raw,
  seedImages,
  sha256,
  uploadFile,
  watchFiles,
  withExif,
  wsSend,
} from './files';
import { accountPage, admin, apiRegister, c2cId, chatUrl, loginAs, uid } from './helpers';
import { PROD, S3 } from './ports';

type Payload = { name: string; mimeType: string; buffer: Buffer };

/** 两个演示用户，alice 打开和 bob 的单聊。 */
async function pair(browser: Browser, opts: Parameters<typeof loginAs>[3] = undefined) {
  const a = uid('fa');
  const b = uid('fb');
  await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
  const alice = await loginAs(browser, a, '/login', opts);
  await alice.goto(chatUrl(c2cId(a, b)));
  await expect(alice.getByTestId('attach-button')).toBeVisible();
  return { a, b, alice, conv: c2cId(a, b) };
}

/** 页面发出的 send 帧（只记类型和 fileId）。 */
function watchSends(page: Page) {
  const sends: { type: string; fileId?: string; clientMsgId: string }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const m = JSON.parse(String(f.payload)) as {
        cmd?: string;
        data?: { type: string; clientMsgId: string; body: { image?: { fileId: string }; file?: { fileId: string } } };
      };
      if (m.cmd === 'send' && m.data) {
        sends.push({
          type: m.data.type,
          clientMsgId: m.data.clientMsgId,
          fileId: m.data.body.image?.fileId ?? m.data.body.file?.fileId,
        });
      }
    }),
  );
  return sends;
}

const pickImages = (page: Page, files: Payload[]) => page.getByTestId('pick-image').setInputFiles(files);
const pickFiles = (page: Page, files: Payload[]) => page.getByTestId('pick-file').setInputFiles(files);
const lastMsg = (page: Page) => page.getByTestId('message').last();
const memory = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __tiantingDebug: { exportMemory(): unknown } }).__tiantingDebug.exportMemory(),
  ) as Promise<{
    messages: Record<
      string,
      { type: string; body: { image?: Record<string, unknown>; file?: Record<string, unknown> } }[]
    >;
  }>;

test.describe('发图片（F-FILE-02、07）', () => {
  test('TC-FILE-02-01（H5）：发 2 MiB 的 jpeg，对方先取缩略图再取原图，两边 size、mime、宽高一致', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { b, alice, conv } = await pair(browser);
    const jpeg = await canvasJpeg(alice, 1400, 1400, true, 0.97);
    expect(jpeg.length).toBeGreaterThan(1_500_000);
    await pickImages(alice, [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent', { timeout: 20_000 });
    const bob = await loginAs(browser, b);
    const net = watchFiles(bob);
    await bob.goto(chatUrl(conv));
    await expect(bob.getByTestId('img-thumb')).toBeVisible();
    expect(net.urls.flat().map((i) => i.variant)).toEqual(['thumb']);
    await bob.getByTestId('img-open').click();
    await expect(bob.getByTestId('viewer-original')).toBeVisible();
    expect(net.urls.flat().map((i) => i.variant)).toEqual(['thumb', 'original']);
    expect(await bob.getByTestId('viewer-original').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1400);
    const mine = (await memory(alice)).messages[conv]!.find((m) => m.type === 'image')!.body.image!;
    const theirs = (await memory(bob)).messages[conv]!.find((m) => m.type === 'image')!.body.image!;
    for (const k of ['fileId', 'size', 'mime', 'width', 'height']) expect(theirs[k], k).toEqual(mine[k]);
    expect(theirs.mime).toBe('image/jpeg');
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-02-04（H5）：原图和缩略图读不到 EXIF（GPS、型号、方向），方向按 Orientation=6 转正', async ({
    browser,
  }) => {
    const { alice } = await pair(browser);
    const net = watchFiles(alice);
    const src = withExif(await canvasJpeg(alice, 40, 20), 6); // 左红右蓝，宽 40 高 20
    expect(jpegHasMetadata(src)).toBe(true);
    await pickImages(alice, [{ name: 'gps.jpg', mimeType: 'image/jpeg', buffer: src }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent', { timeout: 15_000 });
    expect(net.puts).toHaveLength(2);
    const fileId = (await alice.getByTestId('img-bubble').getAttribute('data-file-id'))!;
    // 对象存储里的最终对象（complete 之后的键）：和 PUT 上去的内容相同，都没有 EXIF。
    const finals = (await s3List(`final/${fileId}/`)).filter((o) => /\/(original|thumb)$/.test(o.key));
    expect(finals).toHaveLength(2);
    for (const o of finals) {
      const bytes = await s3Raw(o.key);
      expect(jpegHasMetadata(bytes), o.key).toBe(false);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    // 方向：Orientation=6 是顺时针转 90°，转正后宽 20 高 40，原来左边的红色在上面。
    const original = await s3Raw(finals.find((o) => o.key.endsWith('/original'))!.key);
    const px = await alice.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'none' });
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const top = ctx.getImageData(bmp.width / 2, 5, 1, 1).data;
      const bottom = ctx.getImageData(bmp.width / 2, bmp.height - 5, 1, 1).data;
      return { w: bmp.width, h: bmp.height, top: [...top.slice(0, 3)], bottom: [...bottom.slice(0, 3)] };
    }, original.toString('base64'));
    expect([px.w, px.h]).toEqual([20, 40]);
    expect(px.top[0]).toBeGreaterThan(200);
    expect(px.top[2]).toBeLessThan(60);
    expect(px.bottom[2]).toBeGreaterThan(200);
    await alice.context().close();
  });

  test('TC-FILE-02-05（H5）：上传中点取消，消息消失，发 DELETE，不发 send', async ({ browser }) => {
    const { alice } = await pair(browser);
    const sends = watchSends(alice);
    await alice.reload(); // 先挂上监听再连接
    await expect(alice.getByTestId('attach-button')).toBeVisible();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await alice.route(`${S3}/**`, async (r) => {
      if (r.request().method() === 'PUT') await hold; // PUT 停在半路
      await r.continue().catch(() => undefined);
    });
    const deletes: string[] = [];
    alice.on('request', (r) => {
      if (r.method() === 'DELETE' && r.url().includes('/v1/files/uploads/')) deletes.push(r.url());
    });
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(64, 48, () => [1, 2, 3]) }]);
    await expect(alice.getByTestId('att-progress')).toContainText('上传中');
    await alice.getByTestId('att-cancel').click();
    await expect(alice.getByTestId('message')).toHaveCount(0);
    await expect.poll(() => deletes.length).toBe(1);
    release();
    await alice.waitForTimeout(1000);
    expect(sends).toEqual([]);
    await alice.context().close();
  });

  test('TC-FILE-01-12（H5）：申请上传 4292，标记失败，提示额度用完，只有 1 个请求', async ({ browser }) => {
    const { alice } = await pair(browser);
    let n = 0;
    await alice.route('**/v1/files/uploads', (r) => {
      n++;
      return r.fulfill({ status: 429, json: { code: 4292, msg: 'quota' } });
    });
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(30, 20, () => [9, 9, 9]) }]);
    await expect(alice.getByTestId('toast')).toHaveText('今天的上传额度已用完');
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed');
    await alice.waitForTimeout(5000);
    expect(n).toBe(1);
    await alice.context().close();
  });

  test('TC-FILE-01-17（H5）：uploadPendingLimit 提示、不重试；恢复后上传中取消发 DELETE', async ({ browser }) => {
    const { alice } = await pair(browser);
    let n = 0;
    await alice.route('**/v1/files/uploads', (r) => {
      n++;
      return r.fulfill({ status: 429, json: { code: 4290, msg: 'x', reason: 'uploadPendingLimit' } });
    });
    await pickFiles(alice, [{ name: 'a.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04zip') }]);
    await expect(alice.getByTestId('toast')).toHaveText('上传任务太多，请稍后再试');
    await alice.waitForTimeout(5000);
    expect(n).toBe(1);
    await alice.unroute('**/v1/files/uploads');
    await alice.route(`${S3}/**`, () => undefined); // PUT 一直不回
    const deletes: string[] = [];
    alice.on('request', (r) => r.method() === 'DELETE' && deletes.push(new URL(r.url()).pathname));
    await pickFiles(alice, [{ name: 'b.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04zip2') }]);
    await expect(alice.getByTestId('att-cancel')).toBeVisible();
    await alice.getByTestId('att-cancel').click();
    await expect.poll(() => deletes).toEqual([expect.stringMatching(/^\/v1\/files\/uploads\/[^/]+$/)]);
    await alice.context().close();
  });

  test('TC-FILE-02-13（H5）：伪装成 jpg 的文本失败提示；超过 20 MiB 的 png 重新编码后能发（按处理后算）', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { alice } = await pair(browser);
    await pickImages(alice, [
      { name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('just some text, not a jpeg') },
    ]);
    await expect(alice.getByTestId('att-error')).toHaveText('无法处理这张图片，请用文件方式发送');
    const sizes: number[] = [];
    alice.on('request', (r) => {
      if (r.url().endsWith('/v1/files/uploads') && r.method() === 'POST')
        sizes.push((r.postDataJSON() as { size: number }).size);
    });
    const big = makePng(4000, 2000, (x, y) => [(x >> 4) & 255, (y >> 3) & 255, 128], 0); // 不压缩，约 24 MB
    expect(big.length).toBeGreaterThan(20 * 1024 * 1024);
    await pickImages(alice, [{ name: 'big.png', mimeType: 'image/png', buffer: big }]);
    // 发出的消息有 seq，排在没发出的（失败的那条）前面，所以不能看最后一条。
    await expect(alice.locator('[data-testid=message][data-status=sent]')).toHaveCount(1, { timeout: 60_000 });
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThan(20 * 1024 * 1024);
    await alice.context().close();
  });

  test('TC-FILE-07-04（H5）：第 1 张上传中发文字，文字先发出；3 张图按选择顺序 send，seq 递增，同时只传 1 个', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { alice } = await pair(browser);
    const sends = watchSends(alice);
    await alice.reload(); // 先挂上监听再连接
    await expect(alice.getByTestId('attach-button')).toBeVisible();
    let first = true;
    let active = 0;
    let maxActive = 0;
    await alice.route(`${S3}/**`, async (r) => {
      if (r.request().method() !== 'PUT') return r.continue();
      active++;
      maxActive = Math.max(maxActive, active);
      if (first) {
        first = false;
        await new Promise((f) => setTimeout(f, 5000)); // 第 1 张的原图慢 5 秒
      }
      await r.continue();
      active--;
    });
    const imgs = [1, 2, 3].map((i) => ({
      name: `${i}.png`,
      mimeType: 'image/png',
      buffer: makePng(20 * i, 20, () => [i * 50, 0, 0]),
    }));
    await pickImages(alice, imgs);
    await expect(alice.getByTestId('att-progress').first()).toBeVisible();
    await alice.getByTestId('composer-input').fill('先到的文字');
    await alice.getByTestId('composer-input').press('Enter');
    const text = alice.getByTestId('message').filter({ hasText: '先到的文字' });
    await expect(text).toHaveAttribute('data-status', 'sent');
    expect(sends.map((s) => s.type)).toEqual(['text']);
    await expect(alice.getByTestId('message').filter({ has: alice.getByTestId('img-bubble') })).toHaveCount(3);
    await expect
      .poll(async () => alice.locator('[data-testid=message][data-status=sent]').count(), { timeout: 30_000 })
      .toBe(4);
    expect(sends.map((s) => s.type)).toEqual(['text', 'image', 'image', 'image']);
    expect(maxActive).toBe(1);
    const mem = await memory(alice);
    const list = Object.values(mem.messages)[0] as unknown as {
      type: string;
      seq: number;
      body: { image?: { width: number } };
    }[];
    const images = list.filter((m) => m.type === 'image');
    expect(images.map((m) => m.body.image!.width)).toEqual([20, 40, 60]); // 选择顺序
    expect(images.map((m) => m.seq)).toEqual([...images.map((m) => m.seq)].sort((x, y) => x - y));
    expect(list.find((m) => m.type === 'text')!.seq).toBeLessThan(images[0]!.seq);
    await alice.context().close();
  });

  test('TC-FILE-07-02（H5）：complete 成功但 send 没有 ack，手动重发不再上传，复用 fileId 和 clientMsgId，对方只收到一条', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { b, alice, conv } = await pair(browser);
    const net = watchFiles(alice);
    const sends: string[] = []; // 页面发出的 send：clientMsgId + fileId
    let dropped = false;
    await alice.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const f = JSON.parse(String(m)) as {
          cmd?: string;
          data?: { type?: string; clientMsgId?: string; body?: { image?: { fileId: string } } };
        };
        if (f.cmd === 'send') sends.push(`${f.data?.clientMsgId} ${f.data?.body?.image?.fileId}`);
        if (f.cmd === 'send' && f.data?.type === 'image' && !dropped) {
          dropped = true; // 第一次的 send 不转给服务端：没有 ack
          return;
        }
        server.send(m);
      });
      server.onMessage((m) => ws.send(m));
    });
    await alice.reload();
    await expect(alice.getByTestId('attach-button')).toBeVisible();
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(50, 40, () => [5, 6, 7]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
    const putsBefore = net.puts.length;
    const uploads = () => net.statuses.length;
    const callsBefore = uploads();
    await alice.getByTestId('failed-icon').click();
    await alice.getByTestId('retry-dialog').getByRole('button', { name: '重发' }).click();
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    expect(net.puts.length).toBe(putsBefore);
    expect(uploads()).toBe(callsBefore); // 没有新的 uploads、complete
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(conv));
    await expect(bob.getByTestId('img-bubble')).toHaveCount(1);
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-07-03（H5）：上传失败后不刷新可以重发；再失败一张，刷新前有离开确认，刷新后失败消息不在了', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { alice } = await pair(browser);
    let failNext = true;
    await alice.route(`${S3}/**`, (r) => {
      if (r.request().method() === 'PUT' && failNext) {
        failNext = false;
        return r.fulfill({ status: 500, body: 'boom' });
      }
      return r.continue();
    });
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(30, 30, () => [1, 1, 1]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed');
    await expect(alice.getByTestId('att-error')).toHaveText('图片上传失败，请检查网络后重发');
    await alice.getByTestId('failed-icon').click();
    await alice.getByTestId('retry-dialog').getByRole('button', { name: '重发' }).click();
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    failNext = true;
    await pickImages(alice, [{ name: 'b.png', mimeType: 'image/png', buffer: makePng(31, 30, () => [2, 2, 2]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed');
    let asked = false;
    alice.once('dialog', (d) => {
      asked = d.type() === 'beforeunload';
      void d.accept();
    });
    await alice.reload();
    expect(asked).toBe(true);
    await expect(alice.getByTestId('img-bubble')).toHaveCount(1);
    await expect(alice.locator('[data-testid=message][data-status=failed]')).toHaveCount(0);
    await alice.context().close();
  });

  test('TC-FILE-07-06（H5）：断网时选图标记失败，恢复后重发成功，对方只收到一条', async ({ browser }) => {
    const { b, alice, conv } = await pair(browser);
    await alice.context().setOffline(true);
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(40, 30, () => [3, 3, 3]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed', { timeout: 15_000 });
    await alice.context().setOffline(false);
    await alice.getByTestId('failed-icon').click();
    await alice.getByTestId('retry-dialog').getByRole('button', { name: '重发' }).click();
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent', { timeout: 15_000 });
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(conv));
    await expect(bob.getByTestId('img-thumb')).toBeVisible();
    await expect(bob.getByTestId('img-bubble')).toHaveCount(1);
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-07-07（H5）：同一文件上传失败 5 次：每次都取消（DELETE），从来没有 complete，所以不扣额度', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { alice } = await pair(browser);
    await alice.route(`${S3}/**`, (r) => (r.request().method() === 'PUT' ? r.abort('connectionreset') : r.continue()));
    const calls: string[] = [];
    alice.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/v1/files/')) calls.push(`${r.method()} ${p.replace(/\/[0-9a-zA-Z_-]{8,}/, '/{id}')}`);
    });
    await pickFiles(alice, [{ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 tiny') }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed');
    for (let i = 0; i < 4; i++) {
      await alice.getByTestId('failed-icon').click();
      await alice.getByTestId('retry-dialog').getByRole('button', { name: '重发' }).click();
      await expect(lastMsg(alice)).toHaveAttribute('data-status', 'failed');
    }
    await expect.poll(() => calls.filter((c) => c.startsWith('DELETE')).length).toBe(5);
    expect(calls.filter((c) => c === 'POST /v1/files/uploads')).toHaveLength(5);
    expect(calls.filter((c) => c.endsWith('/complete'))).toEqual([]);
    await alice.context().close();
  });
});

test.describe('收图片（F-FILE-02 规则 6，FE-634）', () => {
  test('TC-FILE-02-06（H5）：4000×3000 的图片加载前后，下一条消息的位置变化 ≤ 1 px', async ({ browser }) => {
    test.setTimeout(60_000);
    const a = uid('fa');
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    const token = await demoToken(a);
    const png = makePng(4000, 3000, (x, y) => [x & 255, y & 255, 7]);
    const fileId = await uploadFile(token, 'image', 'image.png', png, 'image/png', {
      data: makePng(480, 360, () => [10, 20, 30]),
      mime: 'image/png',
    });
    await wsSend(token, [
      { convType: 'c2c', to: b, type: 'image', body: { image: { fileId } } },
      { convType: 'c2c', to: b, type: 'text', body: { text: '图片后面的消息' } },
    ]);
    const bob = await loginAs(browser, b);
    await bob.route(`${S3}/**`, async (r) => {
      await new Promise((f) => setTimeout(f, 2000));
      await r.continue();
    });
    await bob.goto(chatUrl(c2cId(a, b)));
    const next = bob.getByTestId('message').filter({ hasText: '图片后面的消息' });
    await expect(next).toBeVisible();
    await expect(bob.getByTestId('img-loading')).toBeVisible();
    const before = await next.evaluate((el: HTMLElement) => el.offsetTop);
    await expect(bob.getByTestId('img-thumb')).toBeVisible({ timeout: 10_000 });
    const after = await next.evaluate((el: HTMLElement) => el.offsetTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    await bob.context().close();
  });

  test('TC-FILE-02-09（H5）：40 张图的历史，只取视口内的缩略图，不取原图；向上滚才取下一批', async ({ browser }) => {
    test.setTimeout(120_000);
    const a = uid('fa');
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    await seedImages(await demoToken(a), b, 'c2c', 40);
    const bob = await loginAs(browser, b);
    const net = watchFiles(bob);
    await bob.goto(chatUrl(c2cId(a, b)));
    await expect(bob.getByTestId('img-thumb').first()).toBeVisible();
    await bob.waitForTimeout(800);
    const first = net.urls.flat();
    const visible = await bob.getByTestId('img-bubble').evaluateAll((els) => {
      const list = document.querySelector('[data-testid=message-list]')!.getBoundingClientRect();
      return els.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.bottom > list.top - 50 && r.top < list.bottom + 50;
      }).length;
    });
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(visible + 2);
    expect(first.length).toBeLessThan(40);
    expect(first.every((i) => i.variant === 'thumb')).toBe(true);
    expect(net.gets.every((p) => p.endsWith('/thumb'))).toBe(true);
    await bob.getByTestId('message-list').evaluate((el) => (el.scrollTop = el.scrollTop - 600));
    await expect.poll(() => net.urls.flat().length).toBeGreaterThan(first.length);
    expect(net.urls.flat().every((i) => i.variant === 'thumb')).toBe(true);
    await bob.context().close();
  });

  test('TC-FILE-04-10（H5）：200 张图连续滚动没有 4290，一屏合成一批；滚回来命中缓存不再下载', async ({ browser }) => {
    test.setTimeout(300_000);
    const g = uid('g');
    const senders = [uid('s1'), uid('s2'), uid('s3'), uid('s4')];
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [...senders, b].map((userId) => ({ userId })) });
    await admin('POST', '/admin/groups', { groupId: g, name: '两百张图', members: [...senders, b] });
    // 上传申请每人每分钟 60 次（IM_UPLOAD_RATE）：四个人各 50 张。
    await Promise.all(senders.map(async (s) => seedImages(await demoToken(s), g, 'group', 50, 120, 90)));
    const bob = await loginAs(browser, b);
    const net = watchFiles(bob);
    await bob.goto(chatUrl(`group:${g}`));
    await expect(bob.getByTestId('img-thumb').first()).toBeVisible();
    const list = bob.getByTestId('message-list');
    // 一直往上滚到顶（翻页加载历史），再滚回底部
    for (let i = 0; i < 80; i++) {
      await list.evaluate((el) => (el.scrollTop = Math.max(0, el.scrollTop - 500)));
      await bob.waitForTimeout(120);
      if (
        (await bob.getByTestId('history-state').textContent()) === '没有更多了' &&
        (await list.evaluate((el) => el.scrollTop)) === 0
      )
        break;
    }
    await expect(bob.getByTestId('img-bubble')).toHaveCount(200, { timeout: 20_000 });
    const getsBefore = net.gets.length;
    const firstHalf = new Set(net.gets);
    for (let i = 0; i < 80; i++) {
      await list.evaluate((el) => (el.scrollTop = el.scrollTop + 500));
      await bob.waitForTimeout(80);
    }
    await bob.waitForTimeout(500);
    expect(net.statuses.filter((s) => s === 429)).toEqual([]);
    expect(net.urls.every((batch) => batch.length <= 50)).toBe(true);
    // 每张缩略图只下载一次（滚回来时命中按 fileId + variant 的缓存）。
    expect(new Set(net.gets).size).toBe(net.gets.length);
    expect(net.gets.length).toBeLessThanOrEqual(200);
    expect(getsBefore).toBeGreaterThanOrEqual(firstHalf.size);
    console.log(`TC-FILE-04-10 batches ${net.urls.length}, thumbs ${net.gets.length}`);
    await bob.context().close();
  });

  test('TC-FILE-02-12（H5）：下载到的缩略图头部是 20000×20000，显示占位，不解码，其他消息正常', async ({ browser }) => {
    test.setTimeout(60_000);
    const a = uid('fa');
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    const token = await demoToken(a);
    await seedImages(token, b, 'c2c', 1);
    await wsSend(token, [{ convType: 'c2c', to: b, type: 'text', body: { text: '炸弹后面' } }]);
    const bob = await loginAs(browser, b);
    await bob.route(`${S3}/**`, (r) =>
      r.request().url().includes('/thumb')
        ? r.fulfill({ status: 200, body: bombPng(20000, 20000), headers: { 'Access-Control-Allow-Origin': '*' } })
        : r.continue(),
    );
    const errors: string[] = [];
    bob.on('pageerror', (e) => errors.push(e.message));
    await bob.goto(chatUrl(c2cId(a, b)));
    await expect(bob.getByTestId('img-broken')).toHaveText('图片无法显示');
    await expect(bob.getByTestId('message').filter({ hasText: '炸弹后面' })).toBeVisible();
    expect(await bob.locator('img[src^="blob:"]').count()).toBe(0);
    expect(errors).toEqual([]);
    await bob.context().close();
  });

  test('TC-FILE-02-14（H5）：GIF 原样上传、下载内容相同，H5 播放（img 显示 GIF）', async ({ browser }) => {
    const { b, alice, conv } = await pair(browser);
    const gif = makeGif();
    const net = watchFiles(alice);
    await pickImages(alice, [{ name: 'a.gif', mimeType: 'image/gif', buffer: gif }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    expect(net.puts).toHaveLength(2); // 原图、缩略图
    const fileId = (await alice.getByTestId('img-bubble').getAttribute('data-file-id'))!;
    const stored = (await s3List(`final/${fileId}/`)).find((o) => o.key.endsWith('/original'))!;
    expect(stored.sha256).toBe(sha256(gif)); // 原样上传，没有重新编码
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(conv));
    await bob.getByTestId('img-open').click();
    const img = bob.getByTestId('viewer-original');
    await expect(img).toBeVisible();
    const bytes = await img.evaluate(async (el: HTMLImageElement) => {
      const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
      return Array.from(buf);
    });
    expect(sha256(Buffer.from(bytes))).toBe(sha256(gif));
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(16);
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-02-08、03-08（H5）：摘要"[图片]""[文件]"，刷新后也不含文件名', async ({ browser }) => {
    const { b, alice, conv } = await pair(browser);
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(20, 20, () => [0, 0, 0]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    await alice.goto('/chats');
    const item = alice.locator(`[data-conv-id="${conv}"] .tt-conv-summary`);
    await expect(item).toHaveText('[图片]');
    await alice.goto(chatUrl(conv));
    await pickFiles(alice, [
      { name: 'ZXQ-NAME-合同.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') },
    ]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    await alice.goto('/chats');
    await alice.reload();
    await expect(item).toHaveText('[文件]');
    expect(await alice.content()).not.toContain('ZXQ-NAME');
    void b;
    await alice.context().close();
  });
});

test.describe('文件（F-FILE-03、05，FE-634）', () => {
  test('TC-FILE-03-01（H5）：群里发 5 MiB 的 pdf，成员看到文件名和大小，下载内容 SHA-256 相同；TC-FILE-05-03 来源提示', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const g = uid('g');
    const a = uid('fa');
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    await admin('POST', '/admin/groups', { groupId: g, name: '文件群', members: [a, b] });
    const alice = await loginAs(browser, a);
    await alice.goto(chatUrl(`group:${g}`));
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 - 9, 7)]);
    await pickFiles(alice, [{ name: '季度报告.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent', { timeout: 20_000 });
    await pickFiles(alice, [{ name: 'b.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04 second') }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(`group:${g}`));
    const bubble = bob.getByTestId('file-bubble').first();
    await expect(bubble).toContainText('季度报告.pdf');
    await expect(bubble).toContainText('5 MB');
    await bubble.click();
    const confirm = bob.getByTestId('file-source-confirm');
    await expect(confirm).toHaveText(/文件来自其他用户，请确认来源可信/);
    const download = bob.waitForEvent('download');
    await confirm.getByText('下载').click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('季度报告.pdf');
    const path = await d.path();
    const { readFileSync } = await import('node:fs');
    expect(sha256(readFileSync(path))).toBe(sha256(pdf));
    // 同一会话第二个文件不再提示
    const second = bob.waitForEvent('download');
    await bob.getByTestId('file-bubble').nth(1).click();
    await second;
    await expect(bob.getByTestId('file-source-confirm')).toHaveCount(0);
    expect(bob.url()).toContain('/chat/'); // 下载不离开页面
    // 另一个会话第一次又提示；自己发的不提示
    await pickFiles(bob, [{ name: 'mine.txt', mimeType: 'text/plain', buffer: Buffer.from('mine') }]);
    await expect(lastMsg(bob)).toHaveAttribute('data-status', 'sent');
    const own = bob.waitForEvent('download');
    await bob.getByTestId('file-bubble').last().click();
    await own;
    await bob.goto(chatUrl(c2cId(a, b)));
    await wsSend(await demoToken(a), [
      {
        convType: 'c2c',
        to: b,
        type: 'file',
        body: {
          file: {
            fileId: await uploadFile(
              await demoToken(a),
              'file',
              'c.zip',
              Buffer.from('PK\x03\x04c'),
              'application/zip',
            ),
          },
        },
      },
    ]);
    await bob.getByTestId('file-bubble').click();
    await expect(bob.getByTestId('file-source-confirm')).toBeVisible();
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-03-03（H5）：前 64 KB 二进制、后面是 HTML 的 .bin：作为附件下载，响应头 attachment + 服务端记录的类型，页面不渲染', async ({
    browser,
  }) => {
    const { b, alice, conv } = await pair(browser);
    const bin = Buffer.concat([Buffer.alloc(64 * 1024, 0x01), Buffer.from('<html><script>alert(1)</script></html>')]);
    await pickFiles(alice, [{ name: 'data.bin', mimeType: 'application/octet-stream', buffer: bin }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    const bob = await loginAs(browser, b);
    await bob.goto(chatUrl(conv));
    const headers: Record<string, string>[] = [];
    bob.on('response', (r) => {
      if (new URL(r.url()).origin === S3) headers.push(r.headers());
    });
    let dialogs = 0;
    bob.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    await bob.getByTestId('file-bubble').click();
    const download = bob.waitForEvent('download');
    await bob.getByTestId('file-source-confirm').getByText('下载').click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('data.bin');
    await expect.poll(() => headers.length).toBeGreaterThan(0);
    expect(headers[0]!['content-disposition']).toMatch(/^attachment/);
    expect(headers[0]!['content-type']).toBe('application/octet-stream');
    expect(bob.url()).toContain('/chat/');
    expect(dialogs).toBe(0);
    await alice.context().close();
    await bob.context().close();
  });

  test('TC-FILE-03-04、02-07（H5）：200 字符的恶意文件名按纯文本，中间省略、扩展名可见，375 宽没有横向滚动', async ({
    browser,
  }) => {
    const { b, alice, conv } = await pair(browser, { viewport: { width: 375, height: 700 } });
    // 200 个字符（服务端按清洗后 ≤ 255 字节限制，F-FILE-01 规则 7，所以用单字节字符凑满 200 个）
    const name = `<img src=x onerror=alert(1)>${'n'.repeat(168)}.pdf`;
    expect([...name].length).toBe(200);
    await pickFiles(alice, [{ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 y') }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    const bob = await loginAs(browser, b, '/login', { viewport: { width: 375, height: 700 } });
    let dialogs = 0;
    bob.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    await bob.goto(chatUrl(conv));
    const bubble = bob.getByTestId('file-bubble');
    await expect(bubble.getByTestId('file-name')).toHaveText(name);
    expect(await bubble.locator('img').count()).toBe(0);
    const head = bubble.locator('.tt-att-file-head');
    expect(await head.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true); // 前段被省略
    const tail = bubble.locator('.tt-att-file-tail');
    await expect(tail).toHaveText(`${'n'.repeat(8)}.pdf`);
    const box = (await tail.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await bob.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await bob.getByTestId('message-list').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(dialogs).toBe(0);
    await alice.context().close();
    await bob.context().close();
  });
});

test.describe('生产构建的 CSP（NF-UI-14，TC-FILE-03-10）', () => {
  test.use({ baseURL: PROD });
  test('上传、预览、下载都没有 CSP 违规；connect-src 只加了存储的源，不是 https:', async ({ browser }) => {
    test.setTimeout(60_000);
    const a = uid('fa');
    const b = uid('fb');
    await admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    const violations: string[] = [];
    const watch = (p: Page) => {
      p.on('console', (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
      });
    };
    const alice = await loginAs(browser, a, `${PROD}/login`);
    watch(alice);
    const csp = (await alice.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'))!;
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!;
    expect(connect).toBe(`connect-src 'self' ${S3}`);
    expect(csp).toContain('blob:');
    await alice.goto(`${PROD}${chatUrl(c2cId(a, b))}`);
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(80, 60, () => [200, 10, 10]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    await pickFiles(alice, [{ name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('hello csp') }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    const bob = await loginAs(browser, b, `${PROD}/login`);
    watch(bob);
    await bob.goto(`${PROD}${chatUrl(c2cId(a, b))}`);
    await expect(bob.getByTestId('img-thumb')).toBeVisible();
    await bob.getByTestId('img-open').click();
    await expect(bob.getByTestId('viewer-original')).toBeVisible();
    await bob.keyboard.press('Escape');
    await bob.getByTestId('file-bubble').click();
    const download = bob.waitForEvent('download');
    await bob.getByTestId('file-source-confirm').getByText('下载').click();
    await download;
    expect(violations).toEqual([]);
    await alice.context().close();
    await bob.context().close();
  });
});

test('TC-FILE-04-11（H5）：上传、下载过程中控制台搜不到签名、预签名查询串和文件名', async ({ browser }) => {
  const { b, alice, conv } = await pair(browser);
  const logs: string[] = [];
  alice.on('console', (m) => logs.push(m.text()));
  await pickFiles(alice, [{ name: 'ZXQ-LOGNAME.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
  await pickImages(alice, [
    { name: 'ZXQ-LOGNAME.png', mimeType: 'image/png', buffer: makePng(10, 10, () => [1, 2, 3]) },
  ]);
  await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
  const bob = await loginAs(browser, b);
  bob.on('console', (m) => logs.push(m.text()));
  await bob.goto(chatUrl(conv));
  await expect(bob.getByTestId('img-thumb')).toBeVisible();
  const download = bob.waitForEvent('download');
  await bob.getByTestId('file-bubble').click();
  await bob.getByTestId('file-source-confirm').getByText('下载').click();
  await download;
  const all = logs.join('\n');
  expect(all).not.toMatch(/X-Amz-Signature|X-Amz-Credential|ZXQ-LOGNAME/);
  // 存储里也没有地址和文件名：sessionStorage、localStorage 只有会话和 ui. 键
  const stored = await bob.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(stored).not.toMatch(/X-Amz|ZXQ-LOGNAME|127\.0\.0\.1:\d+\/chat/);
  await alice.context().close();
  await bob.context().close();
});

test('AC-ACC-06-6（H5）：我 → 选图、裁剪、保存：上传的是 512×512，马上显示新头像，资料里是公开桶地址', async ({
  browser,
}) => {
  const u = await apiRegister('ava');
  test.setTimeout(60_000);
  const page = await accountPage(browser, u.username);
  const net = watchFiles(page);
  // 站内跳转（刷新页面的话，旧文档的标签页锁可能还没放掉，见问题 H2）
  await page.getByTestId('tab-me').click();
  await page.getByTestId('me-edit').click();
  await expect(page.getByTestId('avatar-change')).toBeVisible();
  await page.getByTestId('avatar-pick').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: makePng(900, 600, (x) => (x < 450 ? [250, 0, 0] : [0, 0, 250])),
  });
  await expect(page.getByTestId('avatar-crop')).toBeVisible();
  expect(
    await new AxeBuilder({ page })
      .include('[data-testid=avatar-crop]')
      .analyze()
      .then((r) => r.violations.map((v) => v.id)),
  ).toEqual([]);
  await page.getByTestId('avatar-crop-area').focus();
  await page.keyboard.press('ArrowLeft');
  const before = new Set((await s3List('', 'avatars')).map((o) => o.key));
  await page.getByTestId('avatar-save').click();
  await expect(page.getByTestId('toast')).toHaveText('头像已更新');
  expect(net.puts).toHaveLength(1); // 只有一张，kind=avatar，没有缩略图
  // 绑定后服务端把它复制到公开桶（F-ACC-06 规则 4）：公开对象就是上传的那张，512 × 512 的 jpeg。
  const added = (await s3List('', 'avatars')).filter((o) => !before.has(o.key));
  expect(added).toHaveLength(1);
  const pub = await s3Raw(added[0]!.key, 'avatars');
  expect(pub.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const dims = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
    return [bmp.width, bmp.height];
  }, pub.toString('base64'));
  expect(dims).toEqual([512, 512]);
  // 不刷新页面回到"我"：新头像马上显示（这次登录里用上传的那张，问题 H13）
  await page.evaluate(() => {
    history.pushState(null, '', '/me');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('me-name')).toBeVisible();
  await expect(page.getByTestId('avatar-img').first()).toHaveAttribute('src', /^blob:/);
  expect(
    await page
      .getByTestId('avatar-img')
      .first()
      .evaluate((i: HTMLImageElement) => i.naturalWidth),
  ).toBe(512);
  await page.context().close();
});

const axeProblems = async (page: Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.id === 'button-name' || v.id === 'image-alt' || v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
};

for (const scheme of ['light', 'dark'] as const) {
  test(`TC-CHAT-90-08（H5，图片和文件页面，${scheme}）：气泡、失败提示、全屏查看、来源提示没有 axe 严重问题，图片有替代文本`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { b, alice, conv } = await pair(browser, { colorScheme: scheme });
    await pickImages(alice, [{ name: 'a.png', mimeType: 'image/png', buffer: makePng(80, 60, () => [20, 120, 220]) }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    await pickFiles(alice, [{ name: '说明.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a11y') }]);
    await expect(lastMsg(alice)).toHaveAttribute('data-status', 'sent');
    await alice.route('**/v1/files/uploads', (r) => r.fulfill({ status: 429, json: { code: 4292, msg: 'quota' } }));
    await pickImages(alice, [{ name: 'b.png', mimeType: 'image/png', buffer: makePng(30, 30, () => [1, 1, 1]) }]);
    await expect(alice.getByTestId('att-error')).toBeVisible();
    await expect(alice.getByTestId('toast')).toHaveCount(0, { timeout: 5000 });
    expect(await axeProblems(alice)).toEqual([]);
    await alice.getByTestId('attach-button').click();
    await expect(alice.getByTestId('attach-menu')).toBeVisible();
    expect(await axeProblems(alice)).toEqual([]);
    await alice.keyboard.press('Escape');
    const bob = await loginAs(browser, b, '/login', { colorScheme: scheme });
    await bob.goto(chatUrl(conv));
    await expect(bob.getByTestId('img-thumb')).toHaveAttribute('alt', '图片');
    await expect(bob.getByTestId('file-bubble')).toHaveAccessibleName(/^说明\.pdf\s*，\s*\d+ B\s*，下载$/);
    await bob.getByTestId('img-open').click();
    await expect(bob.getByTestId('viewer-original')).toBeVisible();
    expect(await axeProblems(bob)).toEqual([]);
    await bob.keyboard.press('Escape');
    await bob.getByTestId('file-bubble').focus();
    await bob.keyboard.press('Enter'); // 键盘也能下载
    await expect(bob.getByTestId('file-source-confirm')).toBeVisible();
    expect(await axeProblems(bob)).toEqual([]);
    await alice.context().close();
    await bob.context().close();
  });
}
