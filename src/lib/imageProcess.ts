// 发送前的图片处理（PRD-chat F-FILE-02 规则 2～4、F-ACC-06 规则 3）：H5 用 canvas。
// 先按 EXIF 方向转正（createImageBitmap 的 imageOrientation: 'from-image'）再重新编码，所以输出里没有 EXIF、GPS；
// 长边超过 4096 缩小；缩略图长边 480、≤ 512 KiB；GIF 不重新编码（只为缩略图解出首帧）。
// 解码前先看头部的宽高，超过像素上限的不解码（规则 3）。SDK 只接收处理好的结果（R-CF-24）。
import type { ProcessedImage } from '@tianting/sdk';
import {
  AVATAR_MAX_BYTES,
  AVATAR_SIDE,
  IMAGE_MAX_BYTES,
  MAX_PIXELS,
  ORIGINAL_LONG_SIDE,
  sniffImage,
  THUMB_LONG_SIDE,
  THUMB_MAX_BYTES,
  type ImageHead,
} from './media';

/** 解码后的图片（已经按 EXIF 方向转正）。 */
export interface Decoded {
  width: number;
  height: number;
  /** 平台自己的对象（浏览器里是 ImageBitmap）。 */
  source?: unknown;
  close(): void;
}

/** 平台的图片接口：浏览器用 createImageBitmap + canvas，测试替身见 media.test.ts。 */
export interface ImageCodec {
  decode(blob: Blob): Promise<Decoded>;
  /** 把 src 的 (sx, sy, sw, sh) 画到 w × h 再编码。浏览器不支持 mime 时返回的 Blob.type 会不同。 */
  encode(
    src: Decoded,
    rect: { sx: number; sy: number; sw: number; sh: number },
    w: number,
    h: number,
    mime: string,
    quality: number,
  ): Promise<Blob>;
}

/** 处理失败：界面统一提示"无法处理这张图片，请用文件方式发送"（规则 2）。 */
export class ImageProcessError extends Error {
  constructor(readonly why: 'unknown' | 'tooManyPixels' | 'decode' | 'tooLarge' | 'notAllowed') {
    super(`image process: ${why}`);
    this.name = 'ImageProcessError';
  }
}

const HEAD_BYTES = 256 * 1024;

export async function readHead(blob: Blob): Promise<ImageHead | null> {
  return sniffImage(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()));
}

/** 按长边缩放后的尺寸（不放大）。 */
export function fit(w: number, h: number, long: number): { w: number; h: number } {
  const s = Math.min(1, long / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const QUALITIES = [0.9, 0.8, 0.7, 0.55, 0.4];

/** 编码到不超过 max 字节：先降质量，还不行再缩小（缩略图）。返回 null 表示做不到。 */
async function encodeUnder(
  codec: ImageCodec,
  img: Decoded,
  long: number,
  mime: string,
  max: number,
  shrink: boolean,
): Promise<{ blob: Blob; w: number; h: number } | null> {
  const full = { sx: 0, sy: 0, sw: img.width, sh: img.height };
  for (let side = long; side >= 120; side = Math.round(side * 0.75)) {
    const { w, h } = fit(img.width, img.height, side);
    for (const q of mime === 'image/png' ? [1] : QUALITIES) {
      const blob = await codec.encode(img, full, w, h, mime, q);
      if (blob.size <= max) return { blob, w, h };
    }
    if (!shrink) return null;
  }
  return null;
}

/** 浏览器编码不了 webp 时（toBlob 回落成 png）按 png 算。 */
async function outputMime(codec: ImageCodec, img: Decoded, want: string): Promise<string> {
  if (want !== 'image/webp') return want;
  const probe = await codec.encode(img, { sx: 0, sy: 0, sw: 1, sh: 1 }, 1, 1, want, 0.9);
  return probe.type === want ? want : 'image/png';
}

/**
 * 处理一张要发送的图片。格式矩阵（规则 2）：jpeg、不透明 png、HEIC（浏览器能解时）→ jpeg；透明 png → png；
 * webp → webp（浏览器不能编码时 png）；gif 原样；动图 webp、apng 按静态图（canvas 只画第一帧）。
 */
export async function processImage(file: Blob, codec: ImageCodec): Promise<ProcessedImage> {
  const head = await readHead(file);
  if (!head) throw new ImageProcessError('unknown');
  if (head.width && head.height && head.width * head.height > MAX_PIXELS) throw new ImageProcessError('tooManyPixels');
  let img: Decoded;
  try {
    img = await codec.decode(file);
  } catch {
    throw new ImageProcessError('decode'); // HEIC 在 Chrome 里就是这里失败：提示用文件方式发送
  }
  try {
    if (img.width * img.height > MAX_PIXELS) throw new ImageProcessError('tooManyPixels');
    const opaque = head.kind === 'jpeg' || head.kind === 'heic' || (head.kind === 'png' && !head.alpha);
    const thumbMime = await outputMime(codec, img, opaque ? 'image/jpeg' : 'image/webp');
    const thumb = await encodeUnder(codec, img, THUMB_LONG_SIDE, thumbMime, THUMB_MAX_BYTES, true);
    if (!thumb) throw new ImageProcessError('tooLarge');
    if (head.kind === 'gif') {
      // 规则 4：GIF 不重新编码，原样上传（GIF 没有 EXIF）。宽高用头部的值，服务端 complete 时同样从头部读。
      if (file.size > IMAGE_MAX_BYTES) throw new ImageProcessError('tooLarge');
      return {
        original: { data: file, mime: 'image/gif' },
        thumb: { data: thumb.blob, mime: thumbMime },
        width: head.width ?? img.width,
        height: head.height ?? img.height,
        name: 'image.gif',
      };
    }
    const mime = opaque
      ? 'image/jpeg'
      : head.kind === 'webp'
        ? await outputMime(codec, img, 'image/webp')
        : 'image/png';
    const original = await encodeUnder(codec, img, ORIGINAL_LONG_SIDE, mime, IMAGE_MAX_BYTES, false);
    if (!original) throw new ImageProcessError('tooLarge');
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    return {
      original: { data: original.blob, mime },
      thumb: { data: thumb.blob, mime: thumbMime },
      width: original.w,
      height: original.h,
      name: `image.${ext}`,
    };
  } finally {
    img.close();
  }
}

/** 头像只收 jpeg、png、webp（F-ACC-06 规则 3）。 */
export async function avatarSource(file: Blob, codec: ImageCodec): Promise<Decoded> {
  const head = await readHead(file);
  if (!head || !['jpeg', 'png', 'webp'].includes(head.kind)) throw new ImageProcessError('notAllowed');
  if (head.width && head.height && head.width * head.height > MAX_PIXELS) throw new ImageProcessError('tooManyPixels');
  try {
    return await codec.decode(file);
  } catch {
    throw new ImageProcessError('decode');
  }
}

/**
 * 裁剪框对应原图的哪一块（正方形）。zoom = 1 时短边正好铺满框；offset 是框中心相对图片中心的偏移，
 * 单位是框的边长（-0.5～0.5 之间才有意义），超出的部分夹回图片里。
 */
export function cropRect(
  w: number,
  h: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const side = Math.min(w, h) / Math.max(1, zoom);
  const cx = Math.min(Math.max(w / 2 + offsetX * side, side / 2), w - side / 2);
  const cy = Math.min(Math.max(h / 2 + offsetY * side, side / 2), h - side / 2);
  return { sx: cx - side / 2, sy: cy - side / 2, sw: side, sh: side };
}

/** 裁剪并缩放到 512 × 512 的 jpeg，≤ 2 MiB（F-ACC-06 规则 3）。 */
export async function renderAvatar(
  codec: ImageCodec,
  img: Decoded,
  rect: { sx: number; sy: number; sw: number; sh: number },
): Promise<Blob> {
  for (const q of QUALITIES) {
    const blob = await codec.encode(img, rect, AVATAR_SIDE, AVATAR_SIDE, 'image/jpeg', q);
    if (blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw new ImageProcessError('tooLarge');
}

/** 浏览器的实现：createImageBitmap 按 EXIF 方向转正，canvas 重新编码（不带任何元数据）。 */
export const browserCodec: ImageCodec = {
  async decode(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
  },
  encode(src, rect, w, h, mime, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new ImageProcessError('decode'));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.source as CanvasImageSource, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageProcessError('decode'))), mime, quality),
    );
  },
};
