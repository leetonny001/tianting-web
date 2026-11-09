// 图片和文件用例的工具（PRD-chat 第 6 节）：在 Node 里造图片、直接调 /v1/files/* 和 WebSocket 预先放好消息、读假 S3。
// 预签名地址只在内存里用，不打印。
import { expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { S3, SERVER } from './ports';

// ---- PNG ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 不透明的 RGB PNG。level=0 时不压缩（造"超过 20 MiB"的原图用）。 */
export function makePng(
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number],
  level = 6,
): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) raw.set(px(x, y), row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只有头部、宽高写成 w × h 的 PNG（解码炸弹的替身，AC-FILE-02-12）。 */
export function bombPng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]);
}

/** GIF 的 LZW 编码（标准做法：码长从 minCode + 1 开始，表满 4096 时发 clear）。 */
function lzw(indices: number[], minCode: number): Buffer {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let dict = new Map<string, number>();
  let next = eoi + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let w = String(indices[0]);
  for (const k of indices.slice(1)) {
    const wk = `${w},${k}`;
    if (dict.has(wk)) {
      w = wk;
      continue;
    }
    emit(w.includes(',') ? dict.get(w)! : Number(w));
    if (next < 4096) {
      dict.set(wk, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minCode + 1;
    }
    w = String(k);
  }
  emit(w.includes(',') ? dict.get(w)! : Number(w));
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);
  const blocks: number[] = [minCode];
  for (let i = 0; i < out.length; i += 255) blocks.push(Math.min(255, out.length - i), ...out.slice(i, i + 255));
  blocks.push(0);
  return Buffer.from(blocks);
}

/** 两帧、会循环的 GIF（AC-FILE-02-14：H5 播放，内容不变）：第一帧红，第二帧蓝。 */
export function makeGif(w = 16, h = 16): Buffer {
  const frame = (color: number) =>
    Buffer.concat([
      Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00]), // 图形控制：延时 100ms
      Buffer.from([0x2c, 0, 0, 0, 0, w & 0xff, w >> 8, h & 0xff, h >> 8, 0x00]),
      lzw(new Array<number>(w * h).fill(color), 2),
    ]);
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([w & 0xff, w >> 8, h & 0xff, h >> 8, 0xf1, 0, 0]), // 全局色表 4 色
    Buffer.from([0xff, 0, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff, 0xff]),
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00]),
    frame(0),
    frame(1),
    Buffer.from([0x3b]),
  ]);
}

// ---- JPEG 的 EXIF（AC-FILE-02-4） ----

/** 在 JPEG 的 SOI 后面插一个 EXIF（大端）：Orientation、Make、Model、GPS 经纬度。 */
export function withExif(jpeg: Buffer, orientation: number): Buffer {
  const ascii = (s: string) => Buffer.from(s + '\0', 'ascii');
  const rational = (...v: number[]) => {
    const b = Buffer.alloc(v.length * 8);
    v.forEach((x, i) => {
      b.writeUInt32BE(x, i * 8);
      b.writeUInt32BE(1, i * 8 + 4);
    });
    return b;
  };
  // IFD0：Make、Model、Orientation、GPS 指针；GPS IFD：纬度、经度。偏移从 TIFF 头开始算。
  const make = ascii('TTCamera');
  const model = ascii('ZXQ-MODEL-9');
  const lat = rational(31, 14, 0);
  const lon = rational(121, 28, 0);
  const ifd0Count = 4;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsCount = 4;
  const gpsSize = 2 + gpsCount * 12 + 4;
  let data = 8 + ifd0Size + gpsSize;
  const blobs: Buffer[] = [];
  const place = (b: Buffer) => {
    const at = data;
    blobs.push(b);
    data += b.length;
    return at;
  };
  const makeAt = place(make);
  const modelAt = place(model);
  const latAt = place(lat);
  const lonAt = place(lon);
  const gpsAt = 8 + ifd0Size;
  const ifd = (list: [number, number, number, number | Buffer][]) => {
    const b = Buffer.alloc(2 + list.length * 12 + 4);
    b.writeUInt16BE(list.length, 0);
    list.forEach(([tag, type, count, v], i) => {
      const o = 2 + i * 12;
      b.writeUInt16BE(tag, o);
      b.writeUInt16BE(type, o + 2);
      b.writeUInt32BE(count, o + 4);
      if (typeof v === 'number') {
        if (type === 3) b.writeUInt16BE(v, o + 8);
        else b.writeUInt32BE(v, o + 8);
      } else v.copy(b, o + 8);
    });
    return b;
  };
  const tiff = Buffer.concat([
    Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]),
    ifd([
      [0x010f, 2, make.length, makeAt],
      [0x0110, 2, model.length, modelAt],
      [0x0112, 3, 1, orientation],
      [0x8825, 4, 1, gpsAt],
    ]),
    ifd([
      [0x0001, 2, 2, Buffer.from('N\0\0\0', 'ascii')],
      [0x0002, 5, 3, latAt],
      [0x0003, 2, 2, Buffer.from('E\0\0\0', 'ascii')],
      [0x0004, 5, 3, lonAt],
    ]),
    ...blobs,
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** JPEG 里有没有 APP1（EXIF / XMP）段，以及能不能搜到 EXIF 的特征字节。 */
export function jpegHasMetadata(b: Buffer): boolean {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1]!;
    if (m === 0xda) break;
    if (m === 0xe1) return true;
    i += 2 + b.readUInt16BE(i + 2);
  }
  return b.includes(Buffer.from('Exif\0\0')) || b.includes(Buffer.from('ZXQ-MODEL-9'));
}

/** 在浏览器里用 canvas 编一张 JPEG（左红右蓝，宽 w 高 h）。 */
export async function canvasJpeg(page: Page, w: number, h: number, noise = false, quality = 0.92): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h, noise, quality }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      if (noise) {
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) % 251;
        ctx.putImageData(img, 0, 0);
      } else {
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, w / 2, h);
        ctx.fillStyle = 'blue';
        ctx.fillRect(w / 2, 0, w / 2, h);
      }
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', quality));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { w, h, noise, quality },
  );
  return Buffer.from(b64, 'base64');
}

export const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- 服务端 ----

export async function demoToken(userId: string): Promise<string> {
  const r = await fetch(`${SERVER}/demo/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: userId }),
  });
  if (!r.ok) throw new Error(`demo login ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

async function v1<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(SERVER + path, {
    signal: AbortSignal.timeout(30_000),
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

interface Put {
  url: string;
  headers: Record<string, string>;
}

/** 走完申请、PUT、complete，返回 fileId（PRD-chat F-FILE-01）。 */
export async function uploadFile(
  token: string,
  kind: 'image' | 'file',
  name: string,
  data: Buffer,
  mime: string,
  thumb?: { data: Buffer; mime: string },
): Promise<string> {
  const up = await v1<{ fileId: string; put: Put; thumbPut?: Put }>(token, 'POST', '/v1/files/uploads', {
    kind,
    name,
    size: data.length,
    mime,
    ...(thumb ? { thumb: { size: thumb.data.length, mime: thumb.mime } } : {}),
  });
  const put = async (p: Put, b: Buffer) => {
    // Content-Length、Host 由 fetch 自己设（和 SDK 的 FetchUploadTransport 一样）。
    const headers = Object.fromEntries(Object.entries(p.headers).filter(([k]) => !/^(content-length|host)$/i.test(k)));
    const r = await fetch(p.url, { method: 'PUT', headers, body: b as BodyInit, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`put ${r.status}`);
  };
  await put(up.put, data);
  if (thumb && up.thumbPut) await put(up.thumbPut, thumb.data);
  await v1(token, 'POST', `/v1/files/${up.fileId}/complete`);
  return up.fileId;
}

/** 用 WebSocket 发一批消息（预先放好历史）。每条等 ack。 */
export async function wsSend(
  token: string,
  frames: { convType: 'c2c' | 'group'; to: string; type: string; body: unknown }[],
): Promise<number[]> {
  const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws?platform=web');
  const pending = new Map<string, (f: { error?: { code: number }; data?: { seq: number } }) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as { id?: string; error?: { code: number }; data?: { seq: number } };
    if (f.id) pending.get(f.id)?.(f);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws error'));
  });
  // 连接被关掉时所有等待的请求都失败，不会一直等
  ws.onclose = (e) => {
    for (const [, r] of pending) r({ error: { code: e.code } });
    pending.clear();
  };
  let n = 0;
  const call = (cmd: string, data: unknown) =>
    new Promise<{ error?: { code: number }; data?: { seq: number } }>((res) => {
      const id = `e2e-${++n}`;
      pending.set(id, (f) => {
        pending.delete(id);
        res(f);
      });
      ws.send(JSON.stringify({ id, cmd, data }));
    });
  const auth = await call('auth', { token });
  if (auth.error) throw new Error(`auth ${auth.error.code}`);
  const seqs: number[] = [];
  for (const f of frames) {
    const clientMsgId = randomBytes(8).toString('hex');
    for (let tries = 0; ; tries++) {
      const r = await call('send', { ...f, clientMsgId });
      // 发送限流（4290）：等一下用同一个 clientMsgId 再发
      if (r.error?.code === 4290 && tries < 50) {
        await new Promise((ok) => setTimeout(ok, 300));
        continue;
      }
      if (r.error) throw new Error(`send ${r.error.code}`);
      seqs.push(r.data!.seq);
      break;
    }
  }
  ws.close();
  return seqs;
}

/** 预先放好 n 张图片消息（每张原图、缩略图都是小 PNG）。 */
export async function seedImages(token: string, to: string, convType: 'c2c' | 'group', n: number, w = 300, h = 200) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const png = makePng(w, h, (x, y) => [(x + i * 7) % 256, (y * 3) % 256, (i * 37) % 256]);
    const thumb = makePng(Math.round(w / 2), Math.round(h / 2), () => [(i * 37) % 256, 120, 200]);
    const fileId = await uploadFile(token, 'image', 'image.png', png, 'image/png', { data: thumb, mime: 'image/png' });
    frames.push({ convType, to, type: 'image', body: { image: { fileId } } });
  }
  return wsSend(token, frames);
}

// ---- 假 S3 ----

export async function s3List(prefix: string, bucket = 'chat') {
  const r = await fetch(`${S3}/__list?bucket=${bucket}&prefix=${encodeURIComponent(prefix)}`);
  return (await r.json()) as { key: string; size: number; sha256: string; type: string }[];
}

export async function s3Raw(key: string, bucket = 'chat'): Promise<Buffer> {
  const r = await fetch(`${S3}/__raw?bucket=${bucket}&key=${encodeURIComponent(key)}`);
  expect(r.ok).toBe(true);
  return Buffer.from(await r.arrayBuffer());
}

/** 页面里 /v1/files/urls 请求的每一项、对假 S3 的 GET 和 PUT。只记路径和 variant，不记签名。 */
export function watchFiles(page: Page) {
  const urls: { fileId: string; variant: string }[][] = [];
  const gets: string[] = [];
  const puts: { path: string; body: Buffer | null }[] = [];
  const statuses: number[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/v1/files/urls' && r.method() === 'POST') {
      urls.push((JSON.parse(r.postData() ?? '{}') as { items: { fileId: string; variant: string }[] }).items);
    }
    if (u.origin === S3 && r.method() === 'GET') gets.push(u.pathname);
    if (u.origin === S3 && r.method() === 'PUT') puts.push({ path: u.pathname, body: r.postDataBuffer() });
  });
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v1/files/')) statuses.push(r.status());
  });
  return { urls, gets, puts, statuses };
}
