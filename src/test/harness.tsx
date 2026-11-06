import { IMClient, type Clock } from '@tianting/sdk';
import { FakeClock, FakeHttp, FakeTransport, type FakeConnection } from '@tianting/sdk/testing';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from '../App';
import { saveSession } from '../lib/session';
import { DEMO_CONFIG } from './harness-fetch';

/** 让 SDK 内部的 await 链和 React 的更新执行完。 */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
  });
}

export interface Conv {
  convId: string;
  type?: 'c2c' | 'group';
  name?: string;
  maxSeq?: number;
  unread?: number;
  lastMsg?: { msgId: string; from: string; type: string; text?: string; ts: number; deleted?: boolean } | null;
  updatedAt?: number;
  memberCount?: number;
  mutedUntil?: number | null;
}

export function serverConv(p: Conv) {
  return {
    type: p.convId.startsWith('group:') ? 'group' : 'c2c',
    name: p.convId,
    maxSeq: 0,
    readSeq: 0,
    minSeq: 1,
    unread: 0,
    lastMsg: null,
    updatedAt: 0,
    ...p,
  };
}

/**
 * 以 userId 登录（sessionStorage 里放好 token，模拟刷新后自动重连），打开 path，
 * 用 FakeTransport 完成 auth 和 convs。返回连接，测试可以继续推送帧、回 ack。
 */
export async function renderLoggedIn(
  path: string,
  opts: {
    userId?: string;
    convs?: Conv[];
    truncated?: boolean;
    clock?: Clock;
    /** auth ack 的服务端时间，默认等于本机时间。 */
    serverTime?: number;
    /** auth ack 的 mutedUntil；不传就没有这个字段。 */
    mutedUntil?: number | null;
    /** true：连接没有打开就返回，调用方自己 open、ack（测"第一次连上之前"）。 */
    pending?: boolean;
  } = {},
) {
  const userId = opts.userId ?? 'alice';
  const transport = new FakeTransport();
  let n = 0;
  const factory = () =>
    new IMClient({
      url: 'ws://test/ws',
      transport,
      clock: opts.clock,
      browserEvents: false,
      isVisible: () => true,
      newId: () => `cid-${String(++n).padStart(4, '0')}`,
    });
  saveSession({ userId, token: 't' });
  window.history.pushState(null, '', path);
  const view = render(<App factory={factory} />);
  const c: FakeConnection = transport.current;
  if (opts.pending) return { ...view, c, transport };
  await act(async () => {
    c.open();
    c.ack('auth', {
      userId,
      serverTime: opts.serverTime ?? opts.clock?.now() ?? Date.now(),
      ...(opts.mutedUntil !== undefined ? { mutedUntil: opts.mutedUntil } : {}),
    });
  });
  await settle();
  await act(async () =>
    c.ack('convs', { convs: (opts.convs ?? []).map(serverConv), truncated: opts.truncated ?? false }),
  );
  await settle();
  return { ...view, c, transport };
}

/** 带 sid、gen 的假 access token：SDK 只读这两个声明（lineageOf）。 */
export function fakeAccess(sid: string, gen: number): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64({ sid, gen })}.sig`;
}

/** 假的登录响应。 */
export function authResponse(
  clock: Clock,
  over: { sid?: string; gen?: number; ttlMs?: number; userId?: string; extra?: Record<string, unknown> } = {},
) {
  const { sid = 's1', gen = 1, ttlMs = 24 * 3_600_000, userId = 'alice', extra = {} } = over;
  const exp = clock.now() + ttlMs;
  return {
    userId,
    accessToken: fakeAccess(sid, gen),
    accessExpiresAt: exp,
    refreshToken: `k.${sid}.${gen}.nonce-${gen}.mac`,
    refreshExpiresAt: clock.now() + 24 * 3_600_000,
    absoluteExpiresAt: clock.now() + 365 * 24 * 3_600_000,
    ...extra,
  };
}

/** 账号会话的测试台：FakeHttp + FakeTransport + FakeClock + 假的标签页互斥。 */
export function accountBench(
  opts: {
    config?: Record<string, unknown> | 'fail';
    claim?: boolean;
    browserEvents?: boolean;
  } = {},
) {
  const clock = new FakeClock(Date.now());
  const http = new FakeHttp();
  const transport = new FakeTransport();
  const guard = {
    claim: vi.fn(async () => opts.claim ?? true),
    confirm: vi.fn(async () => true),
    release: vi.fn(),
  };
  http.onRequest = (call) => {
    if (call.path !== '/v1/config') return;
    if (opts.config === 'fail') call.fail();
    else call.respond(200, { ...DEMO_CONFIG, ...opts.config });
  };
  const factory = () =>
    new IMClient({
      url: 'ws://test/ws',
      transport,
      clock,
      browserEvents: opts.browserEvents ?? false,
      isVisible: () => true,
      timings: { heartbeatMs: 1e12 }, // 这里推进几小时的钟，不想每 30 秒回一次 pong
    });
  const show = (path: string) => {
    window.history.pushState(null, '', path);
    return render(<App factory={factory} accountDeps={{ http, clock }} guardFactory={() => guard} />);
  };
  return {
    clock,
    http,
    transport,
    guard,
    show,
    /** 非 /v1/config 的请求。 */
    calls: (path?: string) => http.calls.filter((c) => c.path !== '/v1/config' && (!path || c.path === path)),
    last: (path: string) => {
      const c = http.calls.filter((x) => x.path === path).at(-1);
      if (!c) throw new Error(`no request to ${path}`);
      return c;
    },
    /** 完成当前连接的 auth 和 convs。 */
    async online(userId = 'alice', ack: Record<string, unknown> = {}) {
      await settle();
      const c = transport.current;
      await act(async () => {
        c.open();
        c.ack('auth', { userId, serverTime: clock.now(), ...ack });
      });
      await settle();
      await act(async () => c.ack('convs', { convs: [], truncated: false }));
      await settle();
      return c;
    },
  };
}

/** 存储里放好账号会话（模拟刷新页面）。 */
export function seedAccountSession(resp: ReturnType<typeof authResponse>) {
  const { userId, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, absoluteExpiresAt } = resp;
  sessionStorage.setItem(
    'tt.session',
    JSON.stringify({
      mode: 'account',
      userId,
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
      absoluteExpiresAt,
    }),
  );
}
