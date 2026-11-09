// 图片、文件的界面状态（PRD-chat F-FILE-02、03、04，第 13.2 节 H5 一列）：每个登录一份，退出就丢掉。
// - 图片按 fileId + variant 缓存成 blob: 地址（F-FILE-04 规则 5：键不是预签名地址，地址每次都变），只在内存。
// - 懒加载：气泡进入视口才排队，30 毫秒内的合成一次 getFileUrls（SDK 再按 50 个一批，规则 6、AC-FILE-04-10）。
// - 下载的内容先看头部宽高，超过像素上限的不交给浏览器解码（F-FILE-02 规则 3，AC-FILE-02-12）。
// - 预签名地址不写日志、不进状态（规则 5）：只在取到后马上用掉。
// - 上传进度、自己刚发的图片的本地预览按 clientMsgId 记。
import type { FileClient, FileVariant, IMClient } from '@tianting/sdk';
import { decodable, sniffImage } from '../lib/media';

export type MediaState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  /** 4048：不存在、无权访问、已过期或被删除（不区分）。 */
  | { status: 'gone' }
  /** 头部读不到宽高、超过像素上限，或者浏览器解码失败。 */
  | { status: 'broken' }
  /** 网络或对象存储失败：可以点击重试。 */
  | { status: 'error' };

const LOADING: MediaState = { status: 'loading' };
const CACHE_MAX = 300;
const BATCH_WAIT_MS = 30;

export interface AttachmentDeps {
  fetch?: typeof fetch;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

const key = (fileId: string, variant: FileVariant) => `${fileId}\u0000${variant}`;

/** 到期的预签名地址：对象存储一般回 403（签名过期）或 400。 */
const expiredUrl = (status: number) => status === 403 || status === 400;

export class Attachments {
  /** 每次变化加一：界面用它订阅（useAttachments）。 */
  version = 0;
  private media = new Map<string, MediaState>();
  private progress = new Map<string, number>();
  private previews = new Map<string, string>();
  private prompted = new Set<string>();
  private listeners = new Set<() => void>();
  private queue = new Map<string, { fileId: string; variant: FileVariant }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly offExpired: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly createUrl: (b: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(
    private readonly client: IMClient,
    readonly files: FileClient | null,
    deps: AttachmentDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((...a) => globalThis.fetch(...a));
    this.createUrl = deps.createObjectURL ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = deps.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
    // 过期或被删除的文件：SDK 已经丢掉地址，这里丢掉缓存的图片（AC-FILE-06-12）。
    this.offExpired = client.on('filesExpired', (ids) => {
      for (const id of ids) for (const v of ['thumb', 'original'] as const) this.drop(key(id, v));
      this.notify();
    });
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private notify(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  // ---- 图片 ----

  state(fileId: string, variant: FileVariant): MediaState | undefined {
    return this.media.get(key(fileId, variant));
  }

  /** 进入视口时调用。已有结果（成功、4048、解码失败）不再请求；网络失败要点"重试"。 */
  request(fileId: string, variant: FileVariant): void {
    const k = key(fileId, variant);
    if (this.disposed || !this.files || this.media.has(k)) return;
    this.media.set(k, LOADING);
    this.queue.set(k, { fileId, variant });
    this.timer ??= setTimeout(() => this.flush(), BATCH_WAIT_MS);
    this.notify();
  }

  retry(fileId: string, variant: FileVariant): void {
    const k = key(fileId, variant);
    if (this.media.get(k)?.status !== 'error' && this.media.get(k)?.status !== 'broken') return;
    this.media.delete(k);
    this.request(fileId, variant);
  }

  /** 浏览器解码失败（img 的 error 事件）：按解码失败占位，不再请求。 */
  markBroken(fileId: string, variant: FileVariant): void {
    const k = key(fileId, variant);
    const cur = this.media.get(k);
    if (cur?.status === 'ready') this.revokeUrl(cur.url);
    this.media.set(k, { status: 'broken' });
    this.notify();
  }

  private flush(): void {
    this.timer = null;
    const items = [...this.queue.values()];
    this.queue.clear();
    if (items.length) void this.load(items, true);
  }

  private async load(items: { fileId: string; variant: FileVariant }[], first: boolean): Promise<void> {
    let results;
    try {
      results = await this.client.getFileUrls(items);
    } catch {
      for (const i of items) this.set(key(i.fileId, i.variant), { status: 'error' });
      return;
    }
    await Promise.all(
      results.map(async (r) => {
        const k = key(r.fileId, r.variant);
        if (!r.url) return this.set(k, { status: 'gone' });
        let res: Response;
        try {
          res = await this.fetchImpl(r.url, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            redirect: 'error',
          });
        } catch {
          return this.set(k, { status: 'error' });
        }
        if (!res.ok) {
          // F-FILE-03 异常：地址过期时重新申请一次，再失败才算失败。
          if (first && expiredUrl(res.status)) {
            this.files?.forget(r.fileId);
            return this.load([{ fileId: r.fileId, variant: r.variant }], false);
          }
          return this.set(k, { status: 'error' });
        }
        const blob = await res.blob().catch(() => null);
        if (!blob) return this.set(k, { status: 'error' });
        const head = sniffImage(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
        if (!decodable(head)) return this.set(k, { status: 'broken' });
        this.set(k, { status: 'ready', url: this.createUrl(blob) });
      }),
    );
  }

  private set(k: string, s: MediaState): void {
    if (this.disposed) {
      if (s.status === 'ready') this.revokeUrl(s.url);
      return;
    }
    if (!this.media.has(k)) {
      // 已经被 filesExpired 或退出丢掉了：结果作废
      if (s.status === 'ready') this.revokeUrl(s.url);
      return;
    }
    this.media.delete(k); // 重新插入：Map 的顺序就是最近使用的顺序
    this.media.set(k, s);
    this.evict();
    this.notify();
  }

  private evict(): void {
    if (this.media.size <= CACHE_MAX) return;
    for (const [k, v] of this.media) {
      if (this.media.size <= CACHE_MAX) break;
      if (v.status === 'loading') continue;
      this.drop(k);
    }
  }

  private drop(k: string): void {
    const cur = this.media.get(k);
    if (cur?.status === 'ready') this.revokeUrl(cur.url);
    this.media.delete(k);
    this.queue.delete(k);
  }

  // ---- 文件下载 ----

  /** 取原文件的下载地址（F-FILE-03 规则 3、4）：地址只交给浏览器下载，不保存。失败返回错误码或 'network'。 */
  async downloadUrl(fileId: string): Promise<{ url: string } | { error: number | 'network' }> {
    try {
      const [r] = await this.client.getFileUrls([{ fileId, variant: 'original' }]);
      return r?.url ? { url: r.url } : { error: r?.code ?? 4048 };
    } catch {
      return { error: 'network' };
    }
  }

  /** 来源提示每个会话只提示一次（F-FILE-05 规则 3）。只在内存：刷新后再提示一次（偏保守）。 */
  needsPrompt(convId: string): boolean {
    return !this.prompted.has(convId);
  }

  markPrompted(convId: string): void {
    this.prompted.add(convId);
  }

  // ---- 发送中的附件 ----

  progressOf(clientMsgId: string): number | undefined {
    return this.progress.get(clientMsgId);
  }

  setProgress(clientMsgId: string, sent: number, total: number): void {
    if (!clientMsgId || this.disposed) return;
    this.progress.set(clientMsgId, total > 0 ? Math.min(1, sent / total) : 0);
    this.notify();
  }

  previewOf(clientMsgId: string): string | undefined {
    return this.previews.get(clientMsgId);
  }

  /** 自己发的图片：处理好的缩略图直接显示，不用等上传和下载。 */
  setPreview(clientMsgId: string, thumb: Blob): void {
    if (!clientMsgId || this.disposed || this.previews.has(clientMsgId)) return;
    this.previews.set(clientMsgId, this.createUrl(thumb));
    this.notify();
  }

  // ---- 自己的头像 ----

  /**
   * 刚换的头像（F-ACC-06，AC-ACC-06-6）：SDK 的 updateProfile 只把新昵称同步进资料缓存，头像地址要等资料缓存过期
   * （10 分钟）或刷新页面才拿到，所以这次登录里先用上传的那张图显示（问题 H13）。
   */
  ownAvatar: string | undefined;

  setOwnAvatar(blob: Blob): void {
    if (this.disposed) return;
    if (this.ownAvatar) this.revokeUrl(this.ownAvatar);
    this.ownAvatar = this.createUrl(blob);
    this.notify();
  }

  /** 退出登录：图片、预览都只在内存，全部释放。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offExpired();
    if (this.timer) clearTimeout(this.timer);
    for (const v of this.media.values()) if (v.status === 'ready') this.revokeUrl(v.url);
    for (const u of this.previews.values()) this.revokeUrl(u);
    if (this.ownAvatar) this.revokeUrl(this.ownAvatar);
    this.ownAvatar = undefined;
    this.media.clear();
    this.previews.clear();
    this.progress.clear();
    this.queue.clear();
    this.notify();
  }
}
