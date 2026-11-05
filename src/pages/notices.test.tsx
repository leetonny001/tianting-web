// 系统通知（FE-353、FE-434）：横幅、列表、未查看条数、ui.noticeSeen（PRD-ui F-UI-44、PRD-live F-PUSH-12）。
import { FakeClock } from '@tianting/sdk/testing';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLoggedIn, settle } from '../test/harness';

const T0 = 1_000_000;
const KEY = 'ui.noticeSeen.alice';
const store = () => window.localStorage;

type Conn = Awaited<ReturnType<typeof renderLoggedIn>>['c'];

const notice = (pushId: string, extra: Record<string, unknown> = {}) => ({
  pushId,
  type: 'notice',
  data: { text: `内容${pushId}` },
  ts: T0 + 1,
  target: 'user',
  ...extra,
});
/** 第一轮补拉的应答。seq 默认按列表顺序给（ts 早于 T0，回放）。 */
const replay = async (c: Conn, seqs: number[], latestSeq = Math.max(0, ...seqs)) => {
  await act(async () => {
    c.ack('pushSync', {
      pushes: seqs.map((s) => notice(`p${s}`, { pushSeq: s, ts: T0 - 1000 + s })),
      hasMore: false,
      latestSeq,
    });
  });
  await settle();
};
const live = (c: Conn, frame: Record<string, unknown>) => act(async () => c.receive({ cmd: 'push', data: frame }));
const open = (path: string, opts: Parameters<typeof renderLoggedIn>[1] = {}) =>
  renderLoggedIn(path, { serverTime: T0, ...opts });
const texts = () => screen.getAllByTestId('notice-item').map((n) => n.querySelector('.tt-notice-text')?.textContent);
const count = () => screen.queryByTestId('me-notices-count')?.textContent ?? null;

beforeEach(() => {
  sessionStorage.clear();
  store().clear();
});

describe('横幅（AC-UI-44-1、AC-PUSH-12-1）', () => {
  it('实时通知：横幅"系统通知：{文本}"，进列表，入口计 1；点横幅进系统通知页', async () => {
    const { c } = await open('/me');
    await replay(c, []);
    await live(c, notice('n1', { pushSeq: 1, data: { text: '今晚 22 点维护' } }));
    expect(screen.getByTestId('notice-banner')).toHaveTextContent('系统通知：今晚 22 点维护');
    expect(count()).toBe('1');
    fireEvent.click(screen.getByTestId('notice-banner'));
    expect(window.location.pathname).toBe('/me/notices');
    expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
    expect(texts()).toEqual(['今晚 22 点维护']);
  });

  it('前 50 码点：emoji 不被截半；列表里是全文', async () => {
    const { c } = await open('/me/notices');
    await replay(c, []);
    const full = '😀'.repeat(60);
    await live(c, notice('n1', { data: { text: full } }));
    expect(screen.getByTestId('notice-banner').textContent).toBe(`系统通知：${'😀'.repeat(50)}`);
    expect(texts()).toEqual([full]);
  });

  it('显示 5 秒：4999ms 还在，5000ms 消失；新的一条重新计时', async () => {
    const { c } = await open('/me');
    await replay(c, []);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await live(c, notice('n1', { target: 'all' }));
      await act(async () => vi.advanceTimersByTime(3000));
      await live(c, notice('n2', { target: 'all' }));
      expect(screen.getByTestId('notice-banner')).toHaveTextContent('内容n2');
      await act(async () => vi.advanceTimersByTime(4999));
      expect(screen.getByTestId('notice-banner')).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replayed=true 不弹横幅，只进列表', async () => {
    const { c } = await open('/me/notices');
    await replay(c, [1]);
    expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
    expect(texts()).toEqual(['内容p1']);
  });
});

describe('type 和内容（AC-UI-44-2、AC-UI-44-3）', () => {
  it('其他 type 不出横幅、不进列表、不计数，日志里只有 type，没有 data', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { c } = await open('/me');
    await replay(c, []);
    await live(c, notice('x', { type: 'promo', pushSeq: 1, data: { text: 'PROMO-SECRET' } }));
    expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
    expect(count()).toBeNull();
    expect(screen.queryByText(/PROMO-SECRET/)).not.toBeInTheDocument();
    expect(info).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).toContain('promo');
    expect(JSON.stringify(info.mock.calls)).not.toContain('PROMO-SECRET');
    fireEvent.click(screen.getByTestId('me-notices'));
    expect(screen.getByTestId('notices-empty')).toBeInTheDocument();
    expect(store().getItem(KEY)).toBe('0'); // promo 不算"已收到"，lastSeenSeq 停在基线
  });

  it('data.text 不是字符串的 notice 忽略', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { c } = await open('/me');
    await replay(c, []);
    await live(c, notice('x', { data: { text: 1 } }));
    await live(c, notice('y', { data: null }));
    expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
    expect(count()).toBeNull();
  });

  it('HTML 原样显示为文本，不产生元素', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const { c } = await open('/me/notices');
    await replay(c, []);
    await live(c, notice('x', { data: { text: xss } }));
    expect(screen.getByTestId('notice-banner').textContent).toBe(`系统通知：${xss}`);
    expect(texts()).toEqual([xss]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

describe('列表（F-PUSH-12 规则 1、AC-PUSH-12-2）', () => {
  it('按 ts 倒序，与到达顺序无关；ts 相同时 pushSeq 倒序', async () => {
    const { c } = await open('/me/notices');
    await replay(c, []);
    await live(c, notice('a', { ts: 200, pushSeq: 1, data: { text: 'ts200' } }));
    await live(c, notice('b', { ts: 100, pushSeq: 2, data: { text: 'ts100' } }));
    await live(c, notice('c', { ts: 300, pushSeq: 3, data: { text: 'ts300-3' } }));
    await live(c, notice('d', { ts: 300, pushSeq: 4, data: { text: 'ts300-4' } }));
    expect(texts()).toEqual(['ts300-4', 'ts300-3', 'ts200', 'ts100']);
  });

  it('最多 100 条，保留 ts 最新的；超出的不显示，但仍计数', async () => {
    store().setItem(KEY, '0');
    const { c } = await open('/me');
    await replay(c, Array.from({ length: 105 }, (_, i) => i + 1).slice(0, 100));
    await act(async () => {
      for (let s = 101; s <= 105; s++) c.receive({ cmd: 'push', data: notice(`p${s}`, { pushSeq: s, ts: T0 - 2000 }) });
    });
    expect(count()).toBe('105');
    fireEvent.click(screen.getByTestId('me-notices'));
    const items = screen.getAllByTestId('notice-item');
    expect(items).toHaveLength(100);
    expect(items[0]!.dataset.push).toBe('p100');
    expect(items.map((i) => i.dataset.push)).not.toContain('p101');
    expect(store().getItem(KEY)).toBe('105');
  });

  it('同一个 pushId 只进一次', async () => {
    const { c } = await open('/me/notices');
    await replay(c, []);
    await live(c, notice('n1', { target: 'all' }));
    await act(async () => {
      c.drop(1006);
    });
    expect(texts()).toEqual(['内容n1']);
  });
});

describe('未查看条数和 lastSeenSeq（F-PUSH-12 规则 3～5）', () => {
  it('AC-PUSH-12-3：lastSeenSeq=40，回放 39、41、42 计 2；打开清零，写入 42', async () => {
    store().setItem(KEY, '40');
    const { c } = await open('/me');
    await replay(c, [39, 41, 42]);
    expect(count()).toBe('2');
    expect(store().getItem(KEY)).toBe('40');
    fireEvent.click(screen.getByTestId('me-notices'));
    expect(store().getItem(KEY)).toBe('42');
    fireEvent.click(screen.getByLabelText('返回'));
    expect(count()).toBeNull();
  });

  it('AC-PUSH-12-5：没有键时这一轮回放不计，写入基线；之后的回放计入', async () => {
    const { c } = await open('/me');
    await replay(c, [1, 2, 3]);
    expect(count()).toBeNull();
    expect(store().getItem(KEY)).toBe('3');
    await live(c, notice('p4', { pushSeq: 4, ts: T0 - 1 }));
    expect(count()).toBe('1');
  });

  it('AC-PUSH-12-8：lastSeenSeq=100、pushSynced 55：回退到 55，56 计入', async () => {
    store().setItem(KEY, '100');
    const clock = new FakeClock(Date.now());
    const { c, transport } = await open('/me', { clock });
    await act(async () => c.ack('pushSync', { pushes: [], hasMore: false, latestSeq: 200 }));
    await settle();
    // 服务端恢复：断线重连后 afterSeq=200，应答 latestSeq=55，C8 重拉一次，这一轮结束时 pushSynced {55}。
    await act(async () => c.drop(1006));
    await act(async () => clock.advance(2000));
    const c2 = transport.current;
    await act(async () => {
      c2.open();
      c2.ack('auth', { userId: 'alice', serverTime: T0 });
    });
    await settle();
    await act(async () => c2.ack('pushSync', { pushes: [], hasMore: false, latestSeq: 55 }));
    await settle();
    await act(async () => c2.ack('pushSync', { pushes: [], hasMore: false, latestSeq: 55 }));
    await settle();
    expect(store().getItem(KEY)).toBe('55');
    await live(c2, notice('p56', { pushSeq: 56, ts: T0 - 1 }));
    expect(count()).toBe('1');
  });

  it('没有 pushSeq 的回放不计；实时的计入；不更新 lastSeenSeq', async () => {
    store().setItem(KEY, '5');
    const { c } = await open('/me');
    await replay(c, [], 5);
    await live(c, notice('a1', { target: 'all', ts: T0 - 1 }));
    expect(count()).toBeNull();
    await live(c, notice('a2', { target: 'all' }));
    expect(count()).toBe('1');
    fireEvent.click(screen.getByTestId('me-notices'));
    expect(store().getItem(KEY)).toBe('5');
  });

  it('AC-PUSH-12-11：停留在页内收到的实时通知进列表、不计数，lastSeenSeq 跟上；离开后入口为 0', async () => {
    const { c } = await open('/me/notices');
    await replay(c, []);
    await live(c, notice('n1', { pushSeq: 1 }));
    expect(texts()).toEqual(['内容n1']);
    expect(store().getItem(KEY)).toBe('1');
    fireEvent.click(screen.getByLabelText('返回'));
    expect(count()).toBeNull();
    // 离开之后再来的才计数。
    await live(c, notice('n2', { pushSeq: 2 }));
    expect(count()).toBe('1');
  });

  it('多标签页：正常更新取 max，不把别的标签页写的大值写小', async () => {
    const { c } = await open('/me/notices');
    await replay(c, [], 5);
    store().setItem(KEY, '50');
    await live(c, notice('n6', { pushSeq: 6 }));
    expect(store().getItem(KEY)).toBe('50');
  });

  it('AC-PUSH-12-7：localStorage 读写抛异常：页面不报错，回放不计，实时计入', async () => {
    // 只让 localStorage 抛异常：token 在 sessionStorage，同一个原型。
    for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
      const real = Storage.prototype[m] as (...args: string[]) => string | null | void;
      vi.spyOn(Storage.prototype, m).mockImplementation(function (this: Storage, ...args: string[]) {
        if (this === window.localStorage) throw new Error('denied');
        return real.apply(this, args);
      } as never);
    }
    const { c } = await open('/me');
    await replay(c, [1, 2]);
    expect(count()).toBeNull();
    await live(c, notice('n3', { pushSeq: 3 }));
    expect(count()).toBe('1');
    expect(screen.getByTestId('notice-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('me-notices'));
    expect(screen.getAllByTestId('notice-item')).toHaveLength(3);
  });

  it('键的值不是数字时按"没有"处理', async () => {
    store().setItem(KEY, 'abc');
    const { c } = await open('/me');
    await replay(c, [1]);
    expect(count()).toBeNull();
    expect(store().getItem(KEY)).toBe('1');
  });
});

describe('存储（AC-PUSH-12-6、AC-PUSH-12-10、NF-UI-13）', () => {
  it('AC-PUSH-12-6：退出登录删除键', async () => {
    store().setItem(KEY, '7');
    store().setItem('ui.noticeSeen.bob', '9');
    await open('/me/settings');
    fireEvent.click(screen.getByTestId('logout'));
    fireEvent.click(within(screen.getByTestId('logout-dialog')).getByText('退出'));
    expect(store().getItem(KEY)).toBeNull();
    expect(store().getItem('ui.noticeSeen.bob')).toBe('9'); // 只删自己的
  });

  it('AC-PUSH-12-6：被踢后点确定不删键，重新登录后不重复提醒', async () => {
    store().setItem(KEY, '3');
    const { c, unmount } = await open('/me');
    await act(async () => {
      c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tokenInvalid' } });
      c.drop(4010);
    });
    await settle();
    fireEvent.click(within(screen.getByTestId('kicked-dialog')).getByText('确定'));
    expect(window.location.pathname).toBe('/login');
    expect(store().getItem(KEY)).toBe('3');
    unmount();

    const again = await open('/me');
    await replay(again.c, [1, 2, 3]);
    expect(count()).toBeNull();
    expect(screen.queryByTestId('notice-banner')).not.toBeInTheDocument();
  });

  it('AC-PUSH-12-10：localStorage 只有 ui.* 键，noticeSeen 是纯数字，搜不到通知文本', async () => {
    const { c } = await open('/me');
    await replay(c, []);
    await live(c, notice('n1', { pushSeq: 1, data: { text: 'NOTICE-TEXT-777' } }));
    fireEvent.click(screen.getByTestId('me-notices'));
    const keys = Array.from({ length: store().length }, (_, i) => store().key(i)!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('ui.'))).toBe(true);
    expect(store().getItem(KEY)).toMatch(/^\d+$/);
    expect(JSON.stringify({ ...store() })).not.toContain('NOTICE-TEXT-777');
  });
});
