// H5 多标签页互斥（PRD-chat F-ACC-03 规则 9）：sessionStorage 会被复制到新窗口，两个页面共用 refresh token 会互相触发重放。
// 启动时按 sid 取互斥锁，拿不到的页面清 token 回登录页；刷新前再确认一次。

export interface TabGuard {
  /** 占住这个 sid。占着别的 sid 时先放掉。false：别的页面占着。 */
  claim(sid: string): Promise<boolean>;
  /** 刷新前确认这个页面还占着。 */
  confirm(): Promise<boolean>;
  release(): void;
}

/** 刷新页面时旧文档的锁可能还没放掉：多试几次才算拿不到（Chrome 实测，见 e2e/account-session.spec.ts）。 */
const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_MS = 100;
const lockName = (sid: string) => `tt.session.${sid}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** navigator.locks：不依赖对方页面响应，原页面被冻结也有效。 */
export function locksGuard(locks: LockManager): TabGuard {
  let sid: string | null = null;
  let held = false;
  let free: (() => void) | null = null;

  const tryOnce = (name: string, mine: string) =>
    new Promise<boolean>((resolve) => {
      locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          if (sid !== mine) return undefined; // 等的时候换了 sid：这把锁不要了
          held = true;
          resolve(true);
          return new Promise<void>((r) => (free = r));
        })
        .catch(() => {
          // 被别的页面用 steal 抢走，或者浏览器拒绝：都算没有占着。
          if (sid === mine) held = false;
          resolve(false);
        });
    });

  const release = () => {
    sid = null;
    held = false;
    free?.();
    free = null;
  };

  // 正在进行的 claim：登录、改密换了 sid 之后马上要刷新时（access 到手就不足 6 小时，P-35 L3），
  // 刷新前的确认要等它拿到锁，否则把自己当成"别的页面在用"，本地结束会话。
  let claiming: Promise<boolean> | null = null;

  return {
    claim(next) {
      if (sid === next && held) return Promise.resolve(true);
      if (sid === next && claiming) return claiming;
      release();
      sid = next;
      const p = (async () => {
        for (let i = 0; i < LOCK_ATTEMPTS; i++) {
          if (i > 0) await sleep(LOCK_RETRY_MS);
          if (sid !== next) return false;
          if (await tryOnce(lockName(next), next)) return true;
        }
        if (sid === next) sid = null;
        return false;
      })();
      claiming = p;
      void p.finally(() => {
        if (claiming === p) claiming = null;
      });
      return p;
    },
    async confirm() {
      if (claiming) await claiming;
      if (!sid || !held) return false;
      const name = lockName(sid);
      try {
        const state = await locks.query();
        return (state.held ?? []).some((l) => l.name === name);
      } catch {
        return held;
      }
    },
    release,
  };
}

const CHANNEL = 'tt.session.guard';
const ANSWER_WAIT_MS = 300;
type GuardMessage = { type: 'who' | 'here'; sid: string; from: string };

/** 没有 navigator.locks 时的退路。局限：对方页面被冻结时不会回答，这种情况防不住（规则 9 也只把它当退路）。 */
export function broadcastGuard(open: (name: string) => BroadcastChannel, waitMs = ANSWER_WAIT_MS): TabGuard {
  const self = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sid: string | null = null;
  let channel: BroadcastChannel | null = null;
  const answered = new Set<string>();

  const onMessage = (e: MessageEvent<GuardMessage>) => {
    const m = e.data;
    if (m.from === self || m.sid !== sid) return;
    if (m.type === 'here') answered.add(m.sid);
    else channel?.postMessage({ type: 'here', sid: m.sid, from: self } satisfies GuardMessage);
  };

  const ask = async (name: string) => {
    if (!channel) {
      channel = open(CHANNEL);
      channel.onmessage = onMessage;
    }
    answered.delete(name);
    channel.postMessage({ type: 'who', sid: name, from: self } satisfies GuardMessage);
    await sleep(waitMs);
    return !answered.has(name);
  };

  let claiming: Promise<boolean> | null = null; // 同 locksGuard：确认要等正在进行的 claim

  return {
    claim(next) {
      sid = next;
      const p = (async () => {
        if (await ask(next)) return true;
        if (sid === next) sid = null;
        return false;
      })();
      claiming = p;
      void p.finally(() => {
        if (claiming === p) claiming = null;
      });
      return p;
    },
    async confirm() {
      if (claiming) await claiming;
      return sid ? ask(sid) : false;
    },
    release() {
      sid = null;
    },
  };
}

/** 两个接口都没有的浏览器：不拦（第一批支持的浏览器都有，见任务单的问题表）。 */
const noGuard: TabGuard = { claim: async () => true, confirm: async () => true, release() {} };

export function createTabGuard(): TabGuard {
  if (typeof navigator !== 'undefined' && navigator.locks) return locksGuard(navigator.locks);
  if (typeof BroadcastChannel !== 'undefined') return broadcastGuard((name) => new BroadcastChannel(name));
  return noGuard;
}
