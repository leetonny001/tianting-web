// 图片和文件消息的纯函数部分（PRD-chat 第 6 节）：类型嗅探、头部宽高、像素上限、文案、大小、文件名。
// 不碰 canvas 和网络，Vitest 直接测。
import type { Message } from '@tianting/sdk';
import { messageFor, SOURCE_MISSING } from './errors';

/** 解码前的像素上限（F-FILE-02 规则 3，未校准）。 */
export const MAX_PIXELS = 40_000_000;
/** 一次最多选几个（F-FILE-07 规则 6，未校准）。 */
export const MAX_PICK = 9;
/** 处理后的原图上限（IM_IMAGE_MAX_BYTES 默认 20 MiB，F-FILE-02 规则 2 按处理后算）。 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 缩略图上限（F-FILE-02 规则 3）。 */
export const THUMB_MAX_BYTES = 512 * 1024;
export const FILE_MAX_BYTES = 100 * 1024 * 1024;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** 原图长边（F-FILE-02 规则 4）、缩略图长边（规则 3）、头像边长（F-ACC-06 规则 3）。 */
export const ORIGINAL_LONG_SIDE = 4096;
export const THUMB_LONG_SIDE = 480;
export const AVATAR_SIDE = 512;

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic';

export interface ImageHead {
  kind: ImageKind;
  /** 头部读得到时才有（HEIC 不解析）。 */
  width?: number;
  height?: number;
  /** png 有透明通道或 tRNS；webp 的 VP8X 带 alpha 标记、VP8L 一律按可能透明。 */
  alpha?: boolean;
  /** jpeg 的 EXIF 方向（1～8），没有就是 undefined。 */
  orientation?: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** 按内容判断图片类型并读出宽高（不解码像素）。认不出返回 null。 */
export function sniffImage(b: Uint8Array): ImageHead | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegHead(b);
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return pngHead(b);
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return b.length >= 10 ? { kind: 'gif', width: u16le(b, 6), height: u16le(b, 8) } : { kind: 'gif' };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpHead(b);
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { kind: 'heic' };
  }
  return null;
}

function jpegHead(b: Uint8Array): ImageHead {
  const out: ImageHead = { kind: 'jpeg' };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return out;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // 填充
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (marker === 0xe1 && out.orientation === undefined) out.orientation = exifOrientation(b, i + 4, len - 2);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof && i + 9 <= b.length) {
      out.height = u16be(b, i + 5);
      out.width = u16be(b, i + 7);
      return out;
    }
    if (marker === 0xda) return out; // 扫描数据开始还没看到 SOF
    i += 2 + len;
  }
  return out;
}

/** APP1 里的 EXIF 方向标签（0x0112）。 */
function exifOrientation(b: Uint8Array, start: number, len: number): number | undefined {
  if (start + 14 > b.length || ascii(b, start, 4) !== 'Exif') return undefined;
  const t = start + 6;
  const le = ascii(b, t, 2) === 'II';
  const r16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > Math.min(b.length, start + len)) return undefined;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) return undefined;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return undefined;
}

function pngHead(b: Uint8Array): ImageHead {
  if (b.length < 26 || ascii(b, 12, 4) !== 'IHDR') return { kind: 'png' };
  const colorType = b[25]!;
  let alpha = colorType === 4 || colorType === 6;
  // tRNS 在 IDAT 之前（PNG 规范）：一直看到 IDAT 为止。
  let i = 8;
  while (!alpha && i + 8 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return { kind: 'png', width: u32be(b, 16), height: u32be(b, 20), alpha };
}

function webpHead(b: Uint8Array): ImageHead {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { kind: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, alpha: false };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const b0 = b[21]!;
    const b1 = b[22]!;
    const b2 = b[23]!;
    const b3 = b[24]!;
    return {
      kind: 'webp',
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      alpha: true,
    };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { kind: 'webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27), alpha: (b[20]! & 0x10) !== 0 };
  }
  return { kind: 'webp' };
}

/** 宽高都知道且不超过像素上限（解码炸弹，F-FILE-02 规则 3、AC-FILE-02-12）。 */
export function decodable(h: ImageHead | null): boolean {
  return !!h && !!h.width && !!h.height && h.width * h.height <= MAX_PIXELS;
}

/** 选中的文件是不是按图片处理：类型是 image/*，或者内容是认得的图片（类型为空的 HEIC 等）。 */
export function looksLikeImage(f: { type: string; name: string }): boolean {
  return f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(f.name);
}

/** 字节数的显示（文件气泡）：B、KB、MB、GB，一位小数。 */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** 文件名拆成"前段 + 结尾"：前段可以省略，结尾（最多 8 个码点 + 扩展名）始终显示（AC-FILE-03-4 中间省略）。 */
export function splitName(name: string): { head: string; tail: string } {
  const cps = [...(name || 'file')];
  const dot = cps.lastIndexOf('.');
  const ext = dot > 0 && cps.length - dot <= 9 ? cps.length - dot : 0;
  const keep = Math.min(cps.length, ext + 8);
  if (cps.length <= keep + 4) return { head: '', tail: cps.join('') };
  return { head: cps.slice(0, cps.length - keep).join(''), tail: cps.slice(cps.length - keep).join('') };
}

/** 气泡里图片的显示尺寸：按宽高比缩进 box × box，最小边 40（AC-FILE-02-6：加载前就按这个占位）。 */
export function displaySize(
  w: number | undefined,
  h: number | undefined,
  box = 200,
): { width: number; height: number } {
  if (!w || !h) return { width: Math.round(box * 0.8), height: Math.round(box * 0.6) };
  const s = Math.min(box / w, box / h, 1);
  return { width: Math.max(40, Math.round(w * s)), height: Math.max(40, Math.round(h * s)) };
}

/**
 * 附件发送失败的提示（F-FILE-01 规则 6、6a，F-FILE-02 规则 2，F-FILE-07 规则 4、异常）。
 * 只有 PRD 写了文案的用 PRD 的；网络或对象存储失败、超时 PRD 没写（D12），用"发送失败"一类，见问题表。
 */
export function attachmentErrorText(m: Pick<Message, 'type' | 'body' | 'error' | 'errorReason'>): string {
  const e = m.error;
  const image = m.type === 'image';
  // 已经有 fileId：上传完成了，错误来自 send（4292 这时是"发起新聊天"的次数，不是上传额度）。
  const uploaded = !!(m.body.image?.fileId || m.body.file?.fileId);
  if (typeof e === 'number' && uploaded && e !== 4048 && e !== 4096) return messageFor(e, 'send');
  switch (e) {
    case undefined:
      return '';
    case 'process':
      return '无法处理这张图片，请用文件方式发送';
    case 'sourceMissing':
      return SOURCE_MISSING;
    case 'network':
      return image ? '图片上传失败，请检查网络后重发' : '文件上传失败，请检查网络后重发';
    case 'timeout':
    case 'kicked':
      return '发送失败，可以点击重发';
    case 4292:
      return '今天的上传额度已用完';
    case 4290:
      return m.errorReason === 'uploadPendingLimit' ? '上传任务太多，请稍后再试' : messageFor(4290);
    case 4139:
      return `文件过大，最大 ${image ? '20 MB' : '100 MB'}`;
    case 4150:
      return '不支持发送这种文件';
    case 4048:
      return messageFor(4048);
    default:
      return messageFor(e, 'send');
  }
}

/** 会话列表、新消息的摘要（F-FILE-02 规则 5、F-FILE-03 规则 5：文件只显示"[文件]"，不带文件名）。 */
export function attachmentSummary(type: string): string | null {
  return type === 'image' ? '[图片]' : type === 'file' ? '[文件]' : null;
}
