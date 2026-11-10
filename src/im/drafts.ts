/**
 * 输入框里的一段 @（PRD-chat F-MEN-01 规则 5，R-CF-16）：文本里 [start, start + len) 这一段对应 userId；
 * all 是"@所有人"（F-MEN-02），这时 userId 为空。
 */
export interface MentionRange {
  start: number;
  len: number;
  userId: string;
  all?: boolean;
}

/**
 * 草稿（PRD-ui F-UI-24，PRD-chat F-MEN-01 规则 5"草稿改为结构化"）：文字、@ 区间、引用（只记 msgId，显示时取已加载的消息，
 * 被撤回后不会留着原文）。只在内存（D4，问题 15），按 convId。
 */
export interface Draft {
  text: string;
  mentions: readonly MentionRange[];
  quote?: { msgId: string };
}

/**
 * 输入区离开时存进来、回来时取走，所以这里只有"离开时没发出去的内容"；正在输入的会话摘要仍是最后一条消息。
 * 每次登录一个实例，退出登录即清空。
 */
export class DraftStore {
  private map: ReadonlyMap<string, Draft> = new Map();
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  snapshot = () => this.map;

  get(convId: string): Draft | undefined {
    return this.map.get(convId);
  }

  /** 文字去掉首尾空白后为空、也没有引用就删除。字符串等于只有文字的草稿。 */
  put(convId: string, draft: Draft | string): void {
    const d: Draft = typeof draft === 'string' ? { text: draft, mentions: [] } : draft;
    if (d.text.trim() === '' && !d.quote) {
      this.remove(convId);
      return;
    }
    if (sameDraft(this.map.get(convId), d)) return;
    this.change((m) => m.set(convId, d));
  }

  remove(convId: string): void {
    if (this.map.has(convId)) this.change((m) => m.delete(convId));
  }

  private change(fn: (m: Map<string, Draft>) => void) {
    const next = new Map(this.map);
    fn(next);
    this.map = next;
    for (const l of this.listeners) l();
  }
}

function sameDraft(a: Draft | undefined, b: Draft): boolean {
  if (!a || a.text !== b.text || a.quote?.msgId !== b.quote?.msgId || a.mentions.length !== b.mentions.length) {
    return false;
  }
  return a.mentions.every((m, i) => {
    const n = b.mentions[i]!;
    return m.start === n.start && m.len === n.len && m.userId === n.userId && !!m.all === !!n.all;
  });
}
