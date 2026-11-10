// FE-633、FE-634：聊天页的图片和文件（假 HTTP + 假上传 + FakeTransport；canvas 用假的 codec）。真实服务端和真实 Chrome 见 e2e/files-real.spec.ts。
import { act, fireEvent, screen, within } from '@testing-library/react';
import { FakeHttp, FakeUpload, type FakeHttpCall } from '@tianting/sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gifHead, jpegHead, pngHead } from '../test/images';
import { sniffImage } from '../lib/media';
import type { ImageCodec } from '../lib/imageProcess';
import { DEMO_CONFIG } from '../test/harness-fetch';
import { renderLoggedIn, settle } from '../test/harness';
import { setImageCodecForTest } from './Attach';

const AB = 'c2c:alice:bob';
const G = 'group:g1';
const at = (convId: string) => `/chat/${encodeURIComponent(convId)}`;

const codec: ImageCodec = {
  async decode(b) {
    const h = sniffImage(new Uint8Array(await b.arrayBuffer()));
    if (!h?.width) throw new Error('cannot decode');
    return { width: h.width, height: h.height!, close: () => {} };
  },
  async encode(_s, _r, w, h, mime) {
    return new Blob([new Uint8Array(Math.max(10, Math.round((w * h) / 100)))], { type: mime });
  },
};

/** 媒体请求：预签名地址 → 内容。其余（/v1/config）回打开文件功能的配置。 */
let media: Record<string, Uint8Array | number> = {};
let mediaGets: string[] = [];
let created = 0;
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

beforeEach(() => {
  sessionStorage.clear();
  media = {};
  mediaGets = [];
  created = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/config')) {
      return new Response(JSON.stringify({ ...DEMO_CONFIG, features: { files: true } }));
    }
    mediaGets.push(url);
    const body = media[url];
    if (body === undefined) return new Response('', { status: 404 });
    if (typeof body === 'number') return new Response('', { status: body });
    return new Response(body as BlobPart, { status: 200 });
  });
  URL.createObjectURL = () => `blob:test/${++created}`;
  URL.revokeObjectURL = () => {};
  setImageCodecForTest(codec);
});
afterEach(() => {
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  setImageCodecForTest(null);
});

/** 自动回应：申请上传、complete、取地址都按调用回；返回调用记录。 */
function filesBench(over: { uploads?: (c: FakeHttpCall) => boolean } = {}) {
  const http = new FakeHttp();
  const upload = new FakeUpload();
  let n = 0;
  http.onRequest = (c) => {
    if (c.path === '/v1/files/uploads' && !(over.uploads?.(c) ?? false)) {
      const id = `F${++n}`;
      const j = c.json as { thumb?: unknown };
      c.respond(200, {
        fileId: id,
        put: {
          url: `https://s3.test/tmp/${id}/original?X-Amz-Signature=sig`,
          headers: {},
          expiresAt: Date.now() + 9e5,
        },
        ...(j.thumb
          ? {
              thumbPut: {
                url: `https://s3.test/tmp/${id}/thumb?X-Amz-Signature=sig`,
                headers: {},
                expiresAt: Date.now() + 9e5,
              },
            }
          : {}),
      });
    } else if (/^\/v1\/files\/[^/]+\/complete$/.test(c.path)) {
      c.respond(200, { fileId: c.path.split('/')[3], size: 1000, mime: 'image/jpeg', width: 40, height: 20 });
    } else if (c.path === '/v1/files/urls') {
      const items = (c.json as { items: { fileId: string; variant: string }[] }).items;
      c.respond(200, {
        items: items.map((i) =>
          i.fileId.startsWith('gone')
            ? { ...i, code: 4048 }
            : { ...i, url: `https://s3.test/final/${i.fileId}/${i.variant}?sig=1`, expiresAt: Date.now() + 120_000 },
        ),
      });
    } else if (c.path.startsWith('/v1/files/uploads/')) {
      c.respond(200, {});
    }
  };
  return { http, upload };
}

const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });

async function pick(testId: 'pick-image' | 'pick-file', files: File[]) {
  fireEvent.click(screen.getByTestId('attach-button'));
  fireEvent.click(screen.getByTestId(testId === 'pick-image' ? 'attach-image' : 'attach-file'));
  await act(async () => fireEvent.change(screen.getByTestId(testId), { target: { files } }));
  await settle();
}

function serverMsg(seq: number, from: string, type: string, body: object, convId = AB) {
  return {
    convId,
    seq,
    msgId: `m${seq}`,
    clientMsgId: `s${seq}`,
    from,
    type,
    body,
    ts: Date.now() - 1000 * (10 - seq),
  };
}

describe('"+"入口（第 13.3 节）', () => {
  it('features.files 打开且有文件接口才显示；关闭时没有', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    expect(screen.getByTestId('attach-button')).toHaveAccessibleName('发送图片或文件');
  });
  it('features.files 关闭时没有，拖放也不接', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(DEMO_CONFIG)));
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    expect(screen.queryByTestId('attach-button')).toBeNull();
    const files = [file(pngHead(10, 10), 'a.png', 'image/png')];
    await act(async () =>
      fireEvent.drop(screen.getByTestId('chat-page'), { dataTransfer: { files, types: ['Files'] } }),
    );
    await settle();
    expect(f.http.to('/v1/files/uploads')).toHaveLength(0);
  });
  it('拖进来的文件：图片按图片发', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    const files = [file(pngHead(10, 10), 'a.png', 'image/png')];
    await act(async () =>
      fireEvent.drop(screen.getByTestId('chat-page'), { dataTransfer: { files, types: ['Files'] } }),
    );
    await settle();
    expect(f.http.last('/v1/files/uploads').json).toMatchObject({ kind: 'image' });
  });
  it('一次最多 9 个，多了不发（F-FILE-07 规则 6）', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick(
      'pick-file',
      Array.from({ length: 10 }, (_, i) => file(new Uint8Array(3), `${i}.txt`, 'text/plain')),
    );
    expect(screen.getByTestId('toast')).toHaveTextContent('一次最多选择 9 个');
    expect(f.http.to('/v1/files/uploads')).toHaveLength(0);
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
  });
});

describe('发图片（F-FILE-02、07，TC-FILE-02-05、07-04）', () => {
  it('处理 → 申请（带缩略图）→ 上传进度 → complete → send；本地先显示预览', async () => {
    const f = filesBench();
    const { c } = await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-image', [file(jpegHead(40, 20, 6), 'p.jpg', 'image/jpeg')]);
    const req = f.http.last('/v1/files/uploads').json as Record<string, unknown>;
    expect(req).toMatchObject({ kind: 'image', mime: 'image/jpeg', thumb: { mime: 'image/jpeg' } });
    expect(req.name).toBe('image.jpg'); // 原文件名不发给服务端
    expect(screen.getByTestId('img-thumb')).toHaveAttribute('src', 'blob:test/1');
    expect(screen.getByTestId('img-thumb')).toHaveAccessibleName('图片');
    const put = f.upload.calls[0]!;
    await act(async () => put.sent(Math.floor(put.size / 2)));
    expect(screen.getByTestId('att-progress').textContent).toMatch(/^上传中 \d+%$/);
    await act(async () => put.respond(200));
    await settle();
    await act(async () => f.upload.calls[1]!.respond(200));
    await settle();
    const send = c.last('send');
    expect(send.data).toMatchObject({ convType: 'c2c', to: 'bob', type: 'image', body: { image: { fileId: 'F1' } } });
    expect(screen.queryByTestId('att-cancel')).toBeNull(); // 已经在 send，不能取消
  });

  it('上传中点取消：消息消失，发 DELETE，不发 send（AC-FILE-02-5）', async () => {
    const f = filesBench();
    const { c } = await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-image', [file(jpegHead(40, 20), 'p.jpg', 'image/jpeg')]);
    expect(f.upload.calls).toHaveLength(1);
    fireEvent.click(screen.getByTestId('att-cancel'));
    await settle();
    expect(screen.queryAllByTestId('message')).toHaveLength(0);
    expect(f.http.to('/v1/files/uploads/F1').map((x) => x.req.method)).toEqual(['DELETE']);
    expect(f.upload.calls[0]!.aborted).toBe(true);
    expect(c.frames().some((x) => x.cmd === 'send')).toBe(false);
  });

  it('解不了的图片标记失败，提示用文件方式发送（AC-FILE-02-13）；不申请上传', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-image', [file(new TextEncoder().encode('just text'), 'fake.jpg', 'image/jpeg')]);
    expect(screen.getByTestId('message')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('att-error')).toHaveTextContent('无法处理这张图片，请用文件方式发送');
    expect(screen.getByTestId('toast')).toHaveTextContent('无法处理这张图片，请用文件方式发送');
    expect(f.http.to('/v1/files/uploads')).toHaveLength(0);
  });

  it('4292：标记失败，提示"今天的上传额度已用完"，不自动重试（AC-FILE-01-12）', async () => {
    const f = filesBench({
      uploads: (c) => {
        c.respondError(429, 4292);
        return true;
      },
    });
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-image', [file(jpegHead(40, 20), 'p.jpg', 'image/jpeg')]);
    expect(screen.getByTestId('message')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('toast')).toHaveTextContent('今天的上传额度已用完');
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(f.http.to('/v1/files/uploads')).toHaveLength(1);
  });

  it('uploadPendingLimit：提示"上传任务太多，请稍后再试"，不重试（AC-FILE-01-17）', async () => {
    const f = filesBench({
      uploads: (c) => {
        c.respondError(429, 4290, { reason: 'uploadPendingLimit' });
        return true;
      },
    });
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-file', [file(new Uint8Array(5), 'a.zip', 'application/zip')]);
    expect(screen.getByTestId('att-error')).toHaveTextContent('上传任务太多，请稍后再试');
    expect(f.http.to('/v1/files/uploads')).toHaveLength(1);
  });

  it('3 张图按选择顺序，同时只上传 1 个（F-FILE-07 规则 5、6）', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick(
      'pick-image',
      [1, 2, 3].map((i) => file(pngHead(10 * i, 10), `${i}.png`, 'image/png')),
    );
    expect(screen.getAllByTestId('message')).toHaveLength(3);
    expect(f.http.to('/v1/files/uploads')).toHaveLength(1);
    expect(f.upload.pending).toHaveLength(1);
  });
});

describe('发文件（F-FILE-03）', () => {
  it('用"文件"方式选 jpeg：先提示保留原始信息，取消不发，确认才发（AC-FILE-03-6）', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-file', [file(jpegHead(40, 20, 6), 'p.jpg', 'image/jpeg')]);
    const dialog = screen.getByTestId('file-meta-confirm');
    expect(dialog).toHaveTextContent('文件会保留原始信息（可能包含位置）');
    fireEvent.click(within(dialog).getByText('取消'));
    await settle();
    expect(f.http.to('/v1/files/uploads')).toHaveLength(0);
    await pick('pick-file', [file(jpegHead(40, 20, 6), 'p.jpg', 'image/jpeg')]);
    fireEvent.click(within(screen.getByTestId('file-meta-confirm')).getByText('发送'));
    await settle();
    expect(f.http.last('/v1/files/uploads').json).toMatchObject({ kind: 'file', name: 'p.jpg', mime: 'image/jpeg' });
    expect(f.upload.calls[0]!.size).toBe(jpegHead(40, 20, 6).length); // 原样上传，不重新编码
  });

  it('非图片的文件不提示，直接发', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    await pick('pick-file', [file(new Uint8Array(5), '合同.pdf', 'application/pdf')]);
    expect(screen.queryByTestId('file-meta-confirm')).toBeNull();
    expect(f.http.last('/v1/files/uploads').json).toMatchObject({ kind: 'file', name: '合同.pdf' });
  });

  it('粘贴的文件按内容分：图片按图片，其他按文件', async () => {
    const f = filesBench();
    await renderLoggedIn(at(AB), { convs: [{ convId: AB, name: 'bob' }], files: f });
    const files = [file(pngHead(10, 10), 'shot.png', 'image/png'), file(new Uint8Array(3), 'a.txt', 'text/plain')];
    await act(async () => fireEvent.paste(screen.getByTestId('composer-input'), { clipboardData: { files } }));
    await settle();
    expect(f.http.to('/v1/files/uploads').map((c) => (c.json as { kind: string }).kind)).toEqual(['image']);
    expect(screen.getAllByTestId('message').map((m) => m.querySelector('[data-testid=img-bubble]') !== null)).toEqual([
      true,
      false,
    ]);
  });
});

describe('收到图片和文件（F-FILE-02 规则 6，F-FILE-03 规则 3，FE-634）', () => {
  async function open(msgs: ReturnType<typeof serverMsg>[], f = filesBench(), convId = AB) {
    const r = await renderLoggedIn(at(convId), {
      convs: [{ convId, name: 'bob', maxSeq: msgs.length }],
      files: f,
    });
    await act(async () => r.c.ack('sync', { messages: msgs, hasMore: false }));
    await settle();
    await act(async () => new Promise((res) => setTimeout(res, 60))); // 合批的 30 毫秒
    await settle();
    return { ...r, f };
  }

  it('先取缩略图（不取原图），按宽高占位；点开才取原图', async () => {
    media['https://s3.test/final/F9/thumb?sig=1'] = pngHead(400, 300);
    media['https://s3.test/final/F9/original?sig=1'] = pngHead(4000, 3000);
    const { f } = await open([
      serverMsg(1, 'bob', 'image', { image: { fileId: 'F9', width: 4000, height: 3000, size: 9, mime: 'image/png' } }),
    ]);
    const items = (f.http.last('/v1/files/urls').json as { items: unknown[] }).items;
    expect(items).toEqual([{ fileId: 'F9', variant: 'thumb' }]);
    const box = screen.getByTestId('img-bubble');
    expect(box.style.width).toBe('200px');
    expect(box.style.height).toBe('150px');
    expect(screen.getByTestId('img-thumb')).toHaveAttribute('src', 'blob:test/1');
    fireEvent.click(screen.getByTestId('img-open'));
    await act(async () => new Promise((res) => setTimeout(res, 60)));
    await settle();
    expect((f.http.last('/v1/files/urls').json as { items: unknown[] }).items).toEqual([
      { fileId: 'F9', variant: 'original' },
    ]);
    expect(screen.getByTestId('viewer-original')).toHaveAttribute('src', 'blob:test/2');
    fireEvent.click(screen.getByTestId('viewer-zoom-in'));
    expect(screen.getByTestId('viewer-zoom')).toHaveTextContent('125%');
    expect(screen.getByTestId('viewer-save')).toHaveAttribute('href', 'blob:test/2');
  });

  it('缩略图头部超过像素上限：占位，不交给浏览器解码，其他消息正常（AC-FILE-02-12）', async () => {
    media['https://s3.test/final/F9/thumb?sig=1'] = pngHead(20000, 20000);
    await open([
      serverMsg(1, 'bob', 'image', { image: { fileId: 'F9', width: 400, height: 300, size: 9, mime: 'image/png' } }),
      serverMsg(2, 'bob', 'text', { text: '后面的消息' }),
    ]);
    expect(screen.getByTestId('img-broken')).toHaveTextContent('图片无法显示');
    expect(created).toBe(0);
    expect(screen.getAllByTestId('message')[1]).toHaveTextContent('后面的消息');
  });

  it('过期的图片和文件显示"已过期"，不申请地址（AC-FILE-06-6）', async () => {
    const { f } = await open([
      serverMsg(1, 'bob', 'image', {
        image: { fileId: 'F1', width: 40, height: 30, size: 9, mime: 'image/png', expired: true },
      }),
      serverMsg(2, 'bob', 'file', {
        file: { fileId: 'F2', name: '', size: 9, mime: 'application/pdf', expired: true },
      }),
    ]);
    expect(screen.getByTestId('img-expired')).toHaveTextContent('图片已过期');
    expect(screen.getByTestId('file-expired')).toHaveTextContent('文件已过期');
    fireEvent.click(screen.getByTestId('file-bubble'));
    await settle();
    expect(f.http.to('/v1/files/urls')).toHaveLength(0);
    expect(mediaGets).toEqual([]);
  });

  it('取不到地址（4048）的显示已过期；网络失败可以点击重试', async () => {
    media['https://s3.test/final/F2/thumb?sig=1'] = 500;
    await open([
      serverMsg(1, 'bob', 'image', { image: { fileId: 'gone1', width: 40, height: 30, size: 9, mime: 'image/png' } }),
      serverMsg(2, 'bob', 'image', { image: { fileId: 'F2', width: 40, height: 30, size: 9, mime: 'image/png' } }),
    ]);
    expect(screen.getByTestId('img-gone')).toHaveTextContent('图片已过期');
    expect(screen.getByTestId('img-retry')).toHaveTextContent('加载失败，点击重试');
    media['https://s3.test/final/F2/thumb?sig=1'] = pngHead(40, 30);
    fireEvent.click(screen.getByTestId('img-retry'));
    await act(async () => new Promise((res) => setTimeout(res, 60)));
    await settle();
    expect(screen.getAllByTestId('img-thumb')).toHaveLength(1);
  });

  it('文件名按纯文本显示（AC-FILE-02-7），大小、类型图标；中间省略', async () => {
    const evil = '<img src=x onerror=alert(1)>.pdf';
    await open([
      serverMsg(1, 'bob', 'file', { file: { fileId: 'F1', name: evil, size: 5 << 20, mime: 'application/pdf' } }),
    ]);
    const bubble = screen.getByTestId('file-bubble');
    expect(screen.getByTestId('file-name').textContent).toBe(evil);
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble).toHaveTextContent('5 MB');
    expect(bubble).toHaveAccessibleName(`${evil}，5 MB，下载`);
  });

  it('别人的文件：每个会话第一次下载前提示来源，确认后下载；第二次不提示（AC-FILE-05-3）', async () => {
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    };
    try {
      const { f } = await open(
        [
          serverMsg(1, 'bob', 'file', { file: { fileId: 'F1', name: 'a.zip', size: 9, mime: 'application/zip' } }, G),
          serverMsg(2, 'bob', 'file', { file: { fileId: 'F2', name: 'b.zip', size: 9, mime: 'application/zip' } }, G),
        ],
        filesBench(),
        G,
      );
      fireEvent.click(screen.getAllByTestId('file-bubble')[0]!);
      const dialog = screen.getByTestId('file-source-confirm');
      expect(dialog).toHaveTextContent('文件来自其他用户，请确认来源可信');
      expect(f.http.to('/v1/files/urls')).toHaveLength(0);
      fireEvent.click(within(dialog).getByText('下载'));
      await settle();
      expect(clicked).toEqual(['https://s3.test/final/F1/original?sig=1']);
      fireEvent.click(screen.getAllByTestId('file-bubble')[1]!);
      await settle();
      expect(screen.queryByTestId('file-source-confirm')).toBeNull();
      expect(clicked).toHaveLength(2);
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  it('TC-RCL-03-12（H5 部分，问题 33）：取下载地址时被撤回或后台删除，SDK 中止（不等地址回来），提示对应文案，不交给浏览器', async () => {
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    };
    try {
      const bench = filesBench();
      const auto = bench.http.onRequest!;
      // 原文件的地址一直不回：中止只能来自 SDK 的 DownloadAbortedError
      bench.http.onRequest = (c) => {
        const items = c.path === '/v1/files/urls' ? (c.json as { items: { variant: string }[] }).items : [];
        if (!items.some((i) => i.variant === 'original')) auto(c);
      };
      const { c } = await open(
        [
          serverMsg(1, 'alice', 'file', { file: { fileId: 'F1', name: 'a.zip', size: 9, mime: 'application/zip' } }),
          serverMsg(2, 'alice', 'file', { file: { fileId: 'F2', name: 'b.zip', size: 9, mime: 'application/zip' } }),
        ],
        bench,
      );
      for (const [i, recalled, text] of [
        [0, { by: 'bob', at: Date.now() }, '该消息已被撤回'],
        [1, undefined, '该消息已被删除'],
      ] as const) {
        fireEvent.click(screen.getAllByTestId('file-bubble')[0]!); // 撤回、删除的那条已经不是文件气泡
        await settle();
        expect(bench.http.to('/v1/files/urls').at(-1)!.settled).toBe(false);
        await act(async () =>
          c.receive({
            cmd: 'event',
            data: {
              type: 'msgDeleted',
              convId: AB,
              msgIds: [`m${i + 1}`],
              seqs: [i + 1],
              ...(recalled ? { recalled } : {}),
            },
          }),
        );
        await settle();
        expect(screen.getByTestId('toast')).toHaveTextContent(text);
      }
      expect(clicked).toEqual([]);
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  it('GIF 和其他图片一样显示原文件的缩略图（H5 播放，AC-FILE-02-14 的 H5 部分在 e2e）', async () => {
    media['https://s3.test/final/F9/thumb?sig=1'] = gifHead(30, 20);
    await open([
      serverMsg(1, 'bob', 'image', { image: { fileId: 'F9', width: 30, height: 20, size: 9, mime: 'image/gif' } }),
    ]);
    expect(screen.getByTestId('img-thumb')).toBeInTheDocument();
  });

  it('会话列表摘要"[图片]""[文件]"，不带文件名（AC-FILE-02-8、03-8）', async () => {
    await renderLoggedIn('/chats', {
      convs: [
        { convId: AB, name: 'bob', lastMsg: { msgId: 'm1', from: 'bob', type: 'image', text: '', ts: 1 } },
        { convId: G, name: 'g1', lastMsg: { msgId: 'm2', from: 'bob', type: 'file', text: '', ts: 2 } },
      ],
    });
    const summary = (id: string) => document.querySelector(`[data-conv-id="${id}"] .tt-conv-summary`)!.textContent;
    expect(summary(AB)).toBe('[图片]');
    expect(summary(G)).toBe('bob: [文件]');
  });
});
