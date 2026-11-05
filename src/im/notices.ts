import type { IMClient, Push } from '@tianting/sdk';
import { getPref, setPref } from '../lib/uiPrefs';

// 系统通知（PRD-ui F-UI-44、PRD-live F-PUSH-12）：只处理 type=notice。列表只在内存，靠回放恢复；
// localStorage 只有 ui.noticeSeen.{userId} 这一个数字（lastSeenSeq），读写失败按"没有"处理。

export interface Notice {
  pushId: string;
  text: string;
  ts: number;
  pushSeq?: number;
}

export interface NoticeSnapshot {
  list: readonly Notice[];
  unseen: number;
  /** 当前的横幅；n 每条加一，React 用它重新计时和渲染。 */
  banner: { text: string; n: number } | null;
}

const LIST_MAX = 100;
const BANNER_CHARS = 50;
const BANNER_MS = 5000;

export const noticeSeenKey = (userId: string) => `ui.noticeSeen.${userId}` as const;

/** 前 50 码点（emoji 不被截断成半个）。 */
export const bannerText = (text: string) => `系统通知：${[...text].slice(0, BANNER_CHARS).join('')}`;

/** ts 倒序，ts 相同时 pushSeq 倒序（规则 1）。 */
function byNewest(a: Notice, b: Notice): number {
  return b.ts - a.ts || (b.pushSeq ?? -1) - (a.pushSeq ?? -1);
}

export class NoticeStore {
  private snap: NoticeSnapshot = { list: [], unseen: 0, banner: null };
  private readonly listeners = new Set<() => void>();
  private readonly seenIds = new Set<string>(); // 至少一次语义：业务按 pushId 幂等（PRD-live 4.8 节）
  private maxSeq = 0; // 本实例收到的 notice 的最大 pushSeq
  private pages = 0; // 打开着的系统通知页
  private bannerN = 0;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly client: IMClient,
    private readonly userId: string,
  ) {}

  /** 要在 connect 之前调用：有订阅者 SDK 才补拉。StrictMode 下会 attach → detach → attach。 */
  attach(): () => void {
    if (!this.off) {
      const offPush = this.client.on('push', (p) => this.onPush(p));
      const offSynced = this.client.on('pushSynced', (e) => this.onSynced(e.latestSeq));
      this.off = () => {
        offPush();
        offSynced();
      };
    }
    return () => this.detach();
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.clearBannerTimer();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): NoticeSnapshot => this.snap;

  /** 打开系统通知页：清零，lastSeenSeq 跟上已收到的最大序号（规则 3、4）。 */
  enterPage(): void {
    this.pages++;
    this.raiseLastSeen();
    this.publish({ unseen: 0 });
  }

  leavePage(): void {
    this.pages--;
  }

  dismissBanner(): void {
    this.clearBannerTimer();
    this.publish({ banner: null });
  }

  private onPush(p: Push): void {
    if (p.type !== 'notice') {
      console.info(`im: push ignored, type=${p.type}`); // 只记 type，data 可能含账号（F-PUSH-08 规则 3）
      return;
    }
    const text = (p.data as { text?: unknown } | null | undefined)?.text;
    if (typeof text !== 'string') {
      console.info('im: notice without text ignored');
      return;
    }
    if (this.seenIds.has(p.pushId)) return;
    this.seenIds.add(p.pushId);
    if (p.pushSeq !== undefined && p.pushSeq > this.maxSeq) this.maxSeq = p.pushSeq;

    const notice: Notice = { pushId: p.pushId, text, ts: p.ts };
    if (p.pushSeq !== undefined) notice.pushSeq = p.pushSeq;
    const list = [...this.snap.list, notice].sort(byNewest).slice(0, LIST_MAX); // 超出的不显示，但仍计数

    let unseen = this.snap.unseen;
    if (this.pages > 0) this.raiseLastSeen();
    else if (!p.replayed) unseen++;
    else if (p.pushSeq !== undefined) {
      const last = this.readLastSeen();
      if (last !== null && p.pushSeq > last) unseen++;
    }

    if (p.replayed) {
      this.publish({ list, unseen });
      return;
    }
    this.clearBannerTimer();
    this.bannerTimer = setTimeout(() => this.dismissBanner(), BANNER_MS);
    this.publish({ list, unseen, banner: { text: bannerText(text), n: ++this.bannerN } });
  }

  /** 一轮补拉结束：建立基线（L-18 接受的退化：这一轮回放不计未查看）；服务端恢复后序号回退时直接覆盖（规则 4、5）。 */
  private onSynced(latestSeq: number): void {
    const last = this.readLastSeen();
    if (last === null || last > latestSeq) setPref(noticeSeenKey(this.userId), String(latestSeq));
  }

  private readLastSeen(): number | null {
    const raw = getPref(noticeSeenKey(this.userId));
    return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  }

  /** 多标签页各自写，正常更新取 max（规则 5）。没有收到带 pushSeq 的通知时不写。 */
  private raiseLastSeen(): void {
    if (this.maxSeq === 0) return;
    const last = this.readLastSeen();
    if (last === null || this.maxSeq > last) setPref(noticeSeenKey(this.userId), String(this.maxSeq));
  }

  private clearBannerTimer(): void {
    if (this.bannerTimer !== null) clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
  }

  private publish(patch: Partial<NoticeSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
}
