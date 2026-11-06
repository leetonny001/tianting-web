import { describe, expect, it, vi } from 'vitest';
import { broadcastGuard, locksGuard } from './tabGuard';

/** 假的 LockManager：同名锁一次一个，放掉之后才能再拿；和浏览器一样，一个 manager 代表整个源。 */
function fakeLocks() {
  const held = new Set<string>();
  const manager = {
    request: async (
      name: string,
      _opts: { ifAvailable: boolean },
      cb: (lock: { name: string } | null) => Promise<void> | undefined,
    ) => {
      if (held.has(name)) return cb(null);
      held.add(name);
      const done = cb({ name });
      await done;
      held.delete(name);
      return undefined;
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  };
  return { manager: manager as unknown as LockManager, held };
}

/** 假的 BroadcastChannel：同一个总线上的实例互相收到（不包括自己）。 */
function fakeBus() {
  const peers = new Set<{ onmessage: ((e: MessageEvent) => void) | null }>();
  return () => {
    const ch = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(data: unknown) {
        for (const p of peers) if (p !== ch) setTimeout(() => p.onmessage?.({ data } as MessageEvent), 0);
      },
    };
    peers.add(ch);
    return ch as unknown as BroadcastChannel;
  };
}

describe('多标签页互斥（F-ACC-03 规则 9，TC-ACC-03-14）', () => {
  it('navigator.locks：第二个页面拿不到同一个 sid，第一个页面放掉之后能拿到', async () => {
    const { manager } = fakeLocks();
    const a = locksGuard(manager);
    const b = locksGuard(manager);
    expect(await a.claim('s1')).toBe(true);
    expect(await a.confirm()).toBe(true);
    expect(await b.claim('s1')).toBe(false);
    expect(await b.confirm()).toBe(false);
    a.release();
    expect(await b.claim('s1')).toBe(true);
  });

  it('换 sid 时放掉旧的锁：旧 sid 可以被别人拿到，新 sid 互斥', async () => {
    const { manager, held } = fakeLocks();
    const a = locksGuard(manager);
    await a.claim('s1');
    await a.claim('s2');
    await vi.waitFor(() => expect([...held]).toEqual(['tt.session.s2']));
    expect(await a.confirm()).toBe(true);
  });

  it('刷新页面时旧文档的锁晚一点才放：重试之后拿到，不会把刷新当成第二个标签页', async () => {
    const { manager } = fakeLocks();
    const old = locksGuard(manager);
    await old.claim('s1');
    setTimeout(() => old.release(), 150);
    expect(await locksGuard(manager).claim('s1')).toBe(true);
  });

  it('锁被抢走（steal）后 confirm 为假：刷新前确认能发现', async () => {
    const { manager, held } = fakeLocks();
    const a = locksGuard(manager);
    await a.claim('s1');
    held.clear(); // 浏览器那边这把锁已经不是这个页面的
    expect(await a.confirm()).toBe(false);
  });

  it('没有 navigator.locks 时退回 BroadcastChannel：有人回答就算占用，放掉之后不再回答', async () => {
    const open = fakeBus();
    const a = broadcastGuard(open, 20);
    const b = broadcastGuard(open, 20);
    expect(await a.claim('s1')).toBe(true);
    expect(await b.claim('s1')).toBe(false);
    expect(await a.confirm()).toBe(true);
    a.release();
    expect(await b.claim('s1')).toBe(true);
  });

  it('BroadcastChannel：不同 sid 互不影响；刷新前确认发现另一个页面也占着', async () => {
    const open = fakeBus();
    const a = broadcastGuard(open, 20);
    const b = broadcastGuard(open, 20);
    expect(await a.claim('s1')).toBe(true);
    expect(await b.claim('s2')).toBe(true);
    await b.claim('s1').then((ok) => expect(ok).toBe(false));
    // 对方被冻结时启动没发现，解冻后在刷新前确认：
    const c = broadcastGuard(open, 20);
    await c.claim('s3');
    const d = broadcastGuard(open, 20);
    await d.claim('s4');
    (d as unknown as { release(): void }).release();
    await d.claim('s3').then((ok) => expect(ok).toBe(false));
    expect(await c.confirm()).toBe(true);
  });
});
