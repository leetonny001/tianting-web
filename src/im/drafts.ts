/**
 * 草稿（PRD-ui F-UI-24）：只在内存（D4），按 convId。输入区离开时存进来、回来时取走，所以这里只有"离开时没发出去的内容"；
 * 正在输入的会话摘要仍是最后一条消息。每次登录一个实例，退出登录即清空。
 */
export class DraftStore {
  private map: ReadonlyMap<string, string> = new Map();
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  snapshot = () => this.map;

  get(convId: string): string | undefined {
    return this.map.get(convId);
  }

  /** 去掉首尾空白后为空就删除。 */
  put(convId: string, text: string): void {
    if (text.trim() === '') {
      this.remove(convId);
      return;
    }
    if (this.map.get(convId) === text) return;
    this.change((m) => m.set(convId, text));
  }

  remove(convId: string): void {
    if (this.map.has(convId)) this.change((m) => m.delete(convId));
  }

  private change(fn: (m: Map<string, string>) => void) {
    const next = new Map(this.map);
    fn(next);
    this.map = next;
    for (const l of this.listeners) l();
  }
}
