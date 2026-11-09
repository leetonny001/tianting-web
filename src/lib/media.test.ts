import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { storageOrigins } from '../../vite.config';
import {
  avatarSource,
  cropRect,
  fit,
  ImageProcessError,
  processImage,
  renderAvatar,
  type Decoded,
  type ImageCodec,
} from './imageProcess';
import {
  attachmentErrorText,
  attachmentSummary,
  decodable,
  displaySize,
  formatSize,
  looksLikeImage,
  sniffImage,
  splitName,
} from './media';
import { gifHead, jpegHead, pngHead, webpVP8X } from '../test/images';

const blob = (b: Uint8Array, type = '') => new Blob([b as BlobPart], { type });

describe('嗅探和头部宽高（F-FILE-02 规则 2、3）', () => {
  it('jpeg、png、gif、webp、HEIC；认不出的返回 null', () => {
    expect(sniffImage(jpegHead(4000, 3000))).toMatchObject({ kind: 'jpeg', width: 4000, height: 3000 });
    expect(sniffImage(jpegHead(40, 20, 6))).toMatchObject({ kind: 'jpeg', width: 40, height: 20, orientation: 6 });
    expect(sniffImage(pngHead(10, 20))).toEqual({ kind: 'png', width: 10, height: 20, alpha: false });
    expect(sniffImage(pngHead(10, 20, 6))?.alpha).toBe(true);
    expect(sniffImage(pngHead(10, 20, 2, true))?.alpha).toBe(true);
    expect(sniffImage(gifHead(300, 200))).toEqual({ kind: 'gif', width: 300, height: 200 });
    expect(sniffImage(webpVP8X(640, 480, true))).toEqual({ kind: 'webp', width: 640, height: 480, alpha: true });
    const heic = new Uint8Array(12);
    heic.set(
      [...'ftypheic'].map((c) => c.charCodeAt(0)),
      4,
    );
    expect(sniffImage(heic)).toEqual({ kind: 'heic' });
    expect(sniffImage(new TextEncoder().encode('not an image at all'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('像素上限 4000 万（解码炸弹）；宽高读不到也不解码', () => {
    expect(decodable(sniffImage(pngHead(20000, 20000)))).toBe(false);
    expect(decodable(sniffImage(pngHead(8000, 5000)))).toBe(true);
    expect(decodable(sniffImage(pngHead(8001, 5000)))).toBe(false);
    expect(decodable({ kind: 'heic' })).toBe(false);
    expect(decodable(null)).toBe(false);
  });

  it('按类型或扩展名认图片（类型为空的 HEIC 也算）', () => {
    expect(looksLikeImage({ type: 'image/jpeg', name: 'a' })).toBe(true);
    expect(looksLikeImage({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(looksLikeImage({ type: 'application/pdf', name: 'a.pdf' })).toBe(false);
  });
});

describe('文件气泡的文字（F-FILE-03 规则 3，AC-FILE-03-4）', () => {
  it('大小', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(150 * 1024 * 1024)).toBe('150 MB');
  });
  it('中间省略：结尾 8 个字符和扩展名单独放，前段可以省略；短名不拆', () => {
    const long = `${'报'.repeat(196)}.pdf`;
    const { head, tail } = splitName(long);
    expect(tail).toBe(`${'报'.repeat(8)}.pdf`);
    expect(head + tail).toBe(long);
    expect(splitName('合同.pdf')).toEqual({ head: '', tail: '合同.pdf' });
    expect(splitName('')).toEqual({ head: '', tail: 'file' });
  });
  it('图片占位尺寸按宽高比（AC-FILE-02-6 加载前后不跳）', () => {
    expect(displaySize(4000, 3000)).toEqual({ width: 200, height: 150 });
    expect(displaySize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(displaySize(10, 4000)).toEqual({ width: 40, height: 200 });
    expect(displaySize(undefined, undefined)).toEqual({ width: 160, height: 120 });
  });
  it('摘要只有类型（AC-FILE-02-8、03-8）', () => {
    expect(attachmentSummary('image')).toBe('[图片]');
    expect(attachmentSummary('file')).toBe('[文件]');
    expect(attachmentSummary('text')).toBeNull();
  });
});

describe('附件失败的提示（AC-FILE-01-12、01-17、02-13、07-10）', () => {
  const upload = (error: unknown, errorReason?: string, type = 'image') =>
    attachmentErrorText({ type, body: { image: { fileId: '' } }, error, errorReason } as never);
  it('PRD 有文案的用 PRD 的', () => {
    expect(upload(4292)).toBe('今天的上传额度已用完');
    expect(upload(4290, 'uploadPendingLimit')).toBe('上传任务太多，请稍后再试');
    expect(upload(4290)).toBe('发送太频繁，请稍后再试');
    expect(upload('process')).toBe('无法处理这张图片，请用文件方式发送');
    expect(upload('sourceMissing')).toBe('原文件已不可用，请重新选择');
    expect(upload(4150)).toBe('不支持发送这种文件');
    expect(upload(4139, undefined, 'file')).toBe('文件过大，最大 100 MB');
  });
  it('已经上传完的，错误来自 send：4292 是发起新聊天的次数', () => {
    const sent = attachmentErrorText({ type: 'image', body: { image: { fileId: 'F1' } }, error: 4292 } as never);
    expect(sent).toBe('今天发起新聊天的次数已用完，请稍后再试');
  });
});

/** 记录调用的假 codec：输出大小可以指定。 */
function fakeCodec(
  opts: { size?: (w: number, h: number, mime: string, q: number) => number; fail?: boolean; webp?: boolean } = {},
) {
  const encodes: { w: number; h: number; mime: string; q: number; rect: unknown }[] = [];
  let decodes = 0;
  const codec: ImageCodec = {
    async decode(b) {
      decodes++;
      if (opts.fail) throw new Error('cannot decode');
      const h = sniffImage(new Uint8Array(await b.arrayBuffer()));
      return { width: h?.width ?? 100, height: h?.height ?? 100, close: () => {} };
    },
    async encode(_src, rect, w, h, mime, q) {
      encodes.push({ w, h, mime, q, rect });
      const type = mime === 'image/webp' && opts.webp === false ? 'image/png' : mime;
      return new Blob([new Uint8Array(opts.size?.(w, h, mime, q) ?? 1000)], { type });
    },
  };
  return { codec, encodes, decodes: () => decodes };
}

describe('发送前的图片处理（F-FILE-02 规则 2～4）', () => {
  it('jpeg：重新编码成 jpeg，长边 4096，缩略图长边 480', async () => {
    const f = fakeCodec();
    const p = await processImage(blob(jpegHead(6000, 4500, 6), 'image/jpeg'), f.codec);
    expect(p.original.mime).toBe('image/jpeg');
    expect([p.width, p.height]).toEqual([4096, 3072]);
    expect(p.thumb.mime).toBe('image/jpeg');
    expect(f.encodes.find((e) => e.w === 480)).toBeTruthy();
    expect(p.name).toBe('image.jpg');
  });

  it('透明 png 保留透明（png 原图，webp 缩略图；不能编码 webp 时 png）；不透明 png 转 jpeg', async () => {
    let p = await processImage(blob(pngHead(800, 600, 6)), fakeCodec().codec);
    expect([p.original.mime, p.thumb.mime]).toEqual(['image/png', 'image/webp']);
    p = await processImage(blob(pngHead(800, 600, 6)), fakeCodec({ webp: false }).codec);
    expect(p.thumb.mime).toBe('image/png');
    p = await processImage(blob(pngHead(800, 600, 2)), fakeCodec().codec);
    expect(p.original.mime).toBe('image/jpeg');
    p = await processImage(blob(webpVP8X(800, 600, false)), fakeCodec().codec);
    expect(p.original.mime).toBe('image/webp');
  });

  it('GIF 不重新编码，原样上传；只为缩略图解一帧', async () => {
    const f = fakeCodec();
    const src = blob(gifHead(300, 200), 'image/gif');
    const p = await processImage(src, f.codec);
    expect(p.original.data).toBe(src);
    expect(p.original.mime).toBe('image/gif');
    expect([p.width, p.height]).toEqual([300, 200]);
    expect(f.encodes.every((e) => e.w <= 480)).toBe(true);
  });

  it('超过像素上限的不解码；解不了（HEIC、伪装成图片的文本）报处理失败', async () => {
    const f = fakeCodec();
    await expect(processImage(blob(pngHead(20000, 20000)), f.codec)).rejects.toEqual(
      new ImageProcessError('tooManyPixels'),
    );
    expect(f.decodes()).toBe(0);
    await expect(processImage(blob(new TextEncoder().encode('hello, not a jpg')), f.codec)).rejects.toBeInstanceOf(
      ImageProcessError,
    );
    const heic = new Uint8Array(12);
    heic.set(
      [...'ftypheic'].map((c) => c.charCodeAt(0)),
      4,
    );
    await expect(processImage(blob(heic), fakeCodec({ fail: true }).codec)).rejects.toEqual(
      new ImageProcessError('decode'),
    );
  });

  it('按处理后的大小算（AC-FILE-02-13）：压不到 20 MiB 才失败；缩略图降质量直到 ≤ 512 KiB', async () => {
    const big = fakeCodec({
      size: (w, _h, _m, q) => (w > 480 ? (q > 0.8 ? 25 << 20 : 3 << 20) : q > 0.7 ? 600 << 10 : 100 << 10),
    });
    const p = await processImage(blob(jpegHead(6000, 4000)), big.codec);
    expect((p.original.data as Blob).size).toBe(3 << 20);
    expect((p.thumb.data as Blob).size).toBe(100 << 10);
    const never = fakeCodec({ size: (w) => (w > 480 ? 30 << 20 : 1000) });
    await expect(processImage(blob(jpegHead(6000, 4000)), never.codec)).rejects.toEqual(
      new ImageProcessError('tooLarge'),
    );
  });
});

describe('头像（F-ACC-06 规则 3）', () => {
  it('只收 jpeg、png、webp；裁成正方形，512 × 512', async () => {
    const f = fakeCodec();
    await expect(avatarSource(blob(gifHead(10, 10)), f.codec)).rejects.toEqual(new ImageProcessError('notAllowed'));
    const img = (await avatarSource(blob(pngHead(1000, 600)), f.codec)) as Decoded;
    const rect = cropRect(img.width, img.height, 1, 0, 0);
    expect(rect).toEqual({ sx: 200, sy: 0, sw: 600, sh: 600 });
    const out = await renderAvatar(f.codec, img, rect);
    expect(out.type).toBe('image/jpeg');
    expect(f.encodes.at(-1)).toMatchObject({ w: 512, h: 512, rect });
  });
  it('缩放和偏移夹在图片里', () => {
    expect(cropRect(1000, 600, 2, 0, 0)).toEqual({ sx: 350, sy: 150, sw: 300, sh: 300 });
    expect(cropRect(1000, 600, 1, 5, 5)).toEqual({ sx: 400, sy: 0, sw: 600, sh: 600 });
    expect(fit(8000, 6000, 4096)).toEqual({ w: 4096, h: 3072 });
    expect(fit(100, 50, 480)).toEqual({ w: 100, h: 50 });
  });
});

describe('CSP（NF-UI-14，AC-FILE-03-10）', () => {
  it('存储源只收具体的源，不收 https: 或通配', () => {
    expect(storageOrigins('https://files.example.com http://127.0.0.1:19000')).toEqual([
      'https://files.example.com',
      'http://127.0.0.1:19000',
    ]);
    expect(storageOrigins(undefined)).toEqual([]);
    for (const bad of ['https:', '*', 'https://*.example.com', 'http://files.example.com', 'https://a.com/path']) {
      expect(() => storageOrigins(bad), bad).toThrow();
    }
  });
  it('nginx 的响应头和构建的 CSP 一致：img-src 有 blob:，connect-src 只有具体域名', () => {
    const conf = readFileSync('deploy/tianting-headers.conf', 'utf8');
    const csp = /Content-Security-Policy "([^"]+)"/.exec(conf)![1]!;
    expect(csp).toContain("img-src 'self' https: data: blob:");
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!;
    expect(connect).toBe("connect-src 'self' https://files.example.com");
    expect(conf).toContain('Referrer-Policy no-referrer');
    const vite = readFileSync('vite.config.ts', 'utf8');
    expect(vite).toContain(`"img-src 'self' https: data: blob:"`);
    // 每个带 add_header 的 location 都要 include（nginx 不继承）
    const nginx = readFileSync('deploy/nginx.conf', 'utf8');
    for (const block of nginx.split('location ').slice(1)) {
      if (block.split('}')[0]!.includes('add_header'))
        expect(block).toContain('include /etc/nginx/snippets/tianting-headers.conf');
    }
  });
});
