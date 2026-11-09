// 测试用的图片头部（只有头，没有像素数据：嗅探和像素上限只看头部）。

export function pngHead(w: number, h: number, colorType = 2, trns = false): Uint8Array {
  const b = new Uint8Array(33 + (trns ? 14 : 0) + 12);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8;
  b[25] = colorType;
  let i = 33;
  if (trns) {
    dv.setUint32(i, 2);
    b.set(
      [...'tRNS'].map((c) => c.charCodeAt(0)),
      i + 4,
    );
    i += 14;
  }
  dv.setUint32(i, 0);
  b.set(
    [...'IDAT'].map((c) => c.charCodeAt(0)),
    i + 4,
  );
  return b;
}

/** SOI + 可选 APP1（EXIF，只有方向标签）+ SOF0。 */
export function jpegHead(w: number, h: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation) {
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const body = [...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0], tiff);
    parts.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xda, 0, 2);
  return new Uint8Array(parts);
}

export function gifHead(w: number, h: number): Uint8Array {
  return new Uint8Array(
    [...'GIF89a'].map((c) => c.charCodeAt(0)).concat([w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0]),
  );
}

export function webpVP8X(w: number, h: number, alpha: boolean): Uint8Array {
  const b = new Uint8Array(30);
  const s = (i: number, t: string) =>
    b.set(
      [...t].map((c) => c.charCodeAt(0)),
      i,
    );
  s(0, 'RIFF');
  s(8, 'WEBP');
  s(12, 'VP8X');
  b[20] = alpha ? 0x10 : 0;
  const w1 = w - 1;
  const h1 = h - 1;
  b.set([w1 & 0xff, (w1 >> 8) & 0xff, w1 >> 16, h1 & 0xff, (h1 >> 8) & 0xff, h1 >> 16], 24);
  return b;
}
