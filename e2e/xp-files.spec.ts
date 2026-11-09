// FE-640：AC-FILE-02-1、AC-FILE-03-1 的三端互发互收（H5、Android、iOS 对同一个 im-server + 假 S3）。三端不能同时跑，
// 所以分两步：先各端用自己的界面发（TT_XP_PHASE=send），再各端用自己的界面收（receive），接收方拉取、下载并核对字节。
// 共同约定（tianting-android 的 CrossPlatformE2e、tianting-ios 的 CrossPlatformE2ETests 照抄这一段）：
//   - 运行号 R（TT_XP），用户 xp{R}h5、xp{R}android、xp{R}ios，群 xp{R}g（三人都在群里；协调脚本先建好）。
//   - 每端给另外两端各发一张 1600×1200 的纯色 jpeg（单聊）：h5 (200,40,40)、android (40,160,60)、ios (40,60,200)。
//   - 每端往群里发一个文件「跨端-{端}.pdf」："%PDF-1.7\n" 加 N 个字节，第 i 个是 (i×31+seed) & 0xFF，N = 1048576 + seed，
//     seed：h5 1、android 2、ios 3。接收方自己按公式算出期望的 SHA-256。
// 接收（TT_XP_FROM，默认另外两端）：单聊里对方的图片显示缩略图、点开显示原图（1600 宽，中心是对方的颜色），H5 的 SDK
// （sdk-ts，页面内存）里的 size、mime、宽高对，按地址取到的原图字节数等于 size、缩略图长边 ≤ 480；群里对方的文件名和大小对，
// 浏览器下载的文件 SHA-256 等于期望值。没有 TT_XP 时跳过。配置见 playwright.xp.config.ts。结果是 Chrome，本地。
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { demoToken, sha256 } from './files';
import { c2cId, chatUrl, loginAs } from './helpers';
import { SERVER } from './ports';

const RUN = process.env.TT_XP ?? '';
const PHASE = process.env.TT_XP_PHASE ?? '';
const ME = 'h5';
const PLATFORMS = ['h5', 'android', 'ios'] as const;
type P = (typeof PLATFORMS)[number];
const COLORS: Record<P, [number, number, number]> = { h5: [200, 40, 40], android: [40, 160, 60], ios: [40, 60, 200] };
const SEEDS: Record<P, number> = { h5: 1, android: 2, ios: 3 };
const W = 1600;
const H = 1200;
const user = (p: P) => `xp${RUN}${p}`;
const GROUP = `group:xp${RUN}g`;
const fileName = (p: P) => `跨端-${p}.pdf`;
function fileBytes(p: P): Buffer {
  const seed = SEEDS[p];
  const n = 1_048_576 + seed;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), b]);
}
const others = PLATFORMS.filter((p) => p !== ME);

type Img = { fileId: string; size: number; mime: string; width: number; height: number };
type Mem = {
  messages: Record<
    string,
    {
      from: string;
      type: string;
      seq?: number;
      body: { image?: Img; file?: { fileId: string; name: string; size: number; mime: string } };
    }[]
  >;
};
const memory = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __tiantingDebug: { exportMemory(): unknown } }).__tiantingDebug.exportMemory(),
  ) as Promise<Mem>;

async function solidJpeg(page: Page, [r, g, b]: [number, number, number]): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ r, g, b, w, h }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, w, h);
      const blob: Blob = await new Promise((res) => c.toBlob((x) => res(x!), 'image/jpeg', 0.92));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { r, g, b, w: W, h: H },
  );
  return Buffer.from(b64, 'base64');
}

/** 页面里解码一段图片字节，返回宽高和中心像素。 */
async function decode(page: Page, bytes: Buffer) {
  return page.evaluate(async (b64) => {
    const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([u]));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data;
    return { w: bmp.width, h: bmp.height, px: [d[0], d[1], d[2]] as [number, number, number] };
  }, bytes.toString('base64'));
}

function expectColor(want: [number, number, number], got: [number, number, number], what: string) {
  for (let i = 0; i < 3; i++)
    expect(Math.abs(want[i]! - got[i]!), `${what}：期望 ${want}，实际 ${got}`).toBeLessThanOrEqual(40);
}

async function fetchVariant(token: string, fileId: string, variant: 'original' | 'thumb'): Promise<Buffer> {
  const r = await fetch(`${SERVER}/v1/files/urls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ fileId, variant }] }),
  });
  expect(r.ok).toBe(true);
  const { items } = (await r.json()) as { items: { url: string }[] };
  const g = await fetch(items[0]!.url);
  expect(g.ok).toBe(true);
  return Buffer.from(await g.arrayBuffer());
}

test.describe('FE-640 三端互发互收（H5）', () => {
  test.skip(!RUN, '跨端用例要协调脚本传 TT_XP');

  test('TC-FILE-02-01、03-01（跨端，H5 发）：给 Android、iOS 各发一张图，往群里发一个文件', async ({ browser }) => {
    test.skip(PHASE !== 'send', 'TT_XP_PHASE=send');
    const page = await loginAs(browser, user(ME));
    for (const p of others) {
      await page.goto(chatUrl(c2cId(user(ME), user(p))));
      await expect(page.getByTestId('attach-button')).toBeVisible();
      const jpeg = await solidJpeg(page, COLORS[ME]);
      await page
        .getByTestId('pick-image')
        .setInputFiles([{ name: `xp-h5-to-${p}.jpg`, mimeType: 'image/jpeg', buffer: jpeg }]);
      await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent', { timeout: 30_000 });
      const mine = (await memory(page)).messages[c2cId(user(ME), user(p))]!.filter(
        (m) => m.type === 'image' && m.from === user(ME),
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]!.body.image).toMatchObject({ width: W, height: H, mime: 'image/jpeg' });
    }
    await page.goto(chatUrl(GROUP));
    await expect(page.getByTestId('attach-button')).toBeVisible();
    await page
      .getByTestId('pick-file')
      .setInputFiles([{ name: fileName(ME), mimeType: 'application/pdf', buffer: fileBytes(ME) }]);
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent', { timeout: 30_000 });
    const f = (await memory(page)).messages[GROUP]!.find((m) => m.type === 'file' && m.from === user(ME))!.body.file!;
    expect(f).toMatchObject({ name: fileName(ME), size: fileBytes(ME).length });
    await page.context().close();
  });

  test('TC-FILE-02-01、03-01（跨端，H5 收）：Android、iOS 发来的图片和文件', async ({ browser }) => {
    test.skip(PHASE !== 'receive', 'TT_XP_PHASE=receive');
    const from = (process.env.TT_XP_FROM ?? others.join(',')).split(',').filter(Boolean) as P[];
    expect(from.length).toBeGreaterThan(0);
    for (const p of from) expect(others).toContain(p);
    const token = await demoToken(user(ME));
    const page = await loginAs(browser, user(ME));
    for (const p of from) {
      const conv = c2cId(user(ME), user(p));
      await page.goto(chatUrl(conv));
      let img: Img | undefined;
      await expect
        .poll(
          async () => {
            img = (await memory(page)).messages[conv]?.find((m) => m.type === 'image' && m.from === user(p))?.body
              .image;
            return !!img;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(img, p).toMatchObject({ width: W, height: H, mime: 'image/jpeg' });
      const bubble = page.locator(`[data-testid="img-bubble"][data-file-id="${img!.fileId}"]`);
      await expect(bubble.getByTestId('img-thumb')).toBeVisible({ timeout: 20_000 });
      await bubble.getByTestId('img-open').click();
      const viewer = page.getByTestId('viewer-original');
      await expect(viewer).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => viewer.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(W);
      const shown = await viewer.evaluate((i: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = i.naturalWidth;
        c.height = i.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(i, 0, 0);
        const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return { h: i.naturalHeight, px: [d[0], d[1], d[2]] as [number, number, number] };
      });
      expect(shown.h).toBe(H);
      expectColor(COLORS[p], shown.px, `${p} 的原图（页面显示）`);
      await page.keyboard.press('Escape');
      // 字节：按地址取原图和缩略图
      const original = await fetchVariant(token, img!.fileId, 'original');
      expect(original.length, `${p} 的原图字节数`).toBe(img!.size);
      const o = await decode(page, original);
      expect([o.w, o.h]).toEqual([W, H]);
      expectColor(COLORS[p], o.px, `${p} 的原图`);
      const thumb = await decode(page, await fetchVariant(token, img!.fileId, 'thumb'));
      expect(Math.max(thumb.w, thumb.h), `${p} 的缩略图长边`).toBeLessThanOrEqual(480);
      expectColor(COLORS[p], thumb.px, `${p} 的缩略图`);
    }
    await page.goto(chatUrl(GROUP));
    let prompted = false;
    for (const p of from) {
      const bubble = page.getByTestId('file-bubble').filter({ hasText: fileName(p) });
      await expect(bubble).toBeVisible({ timeout: 30_000 });
      const f = (await memory(page)).messages[GROUP]!.find((m) => m.type === 'file' && m.from === user(p))!.body.file!;
      expect(f).toMatchObject({ name: fileName(p), size: fileBytes(p).length, mime: 'application/pdf' });
      const download = page.waitForEvent('download');
      await bubble.click();
      if (!prompted) {
        const confirm = page.getByTestId('file-source-confirm');
        await expect(confirm).toBeVisible();
        await confirm.getByText('下载').click();
        prompted = true;
      }
      const d = await download;
      expect(d.suggestedFilename()).toBe(fileName(p));
      expect(sha256(readFileSync((await d.path())!)), `${p} 的文件 SHA-256`).toBe(sha256(fileBytes(p)));
    }
    await page.context().close();
  });
});
