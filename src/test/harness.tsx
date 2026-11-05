import { IMClient, type Clock } from '@tianting/sdk';
import { FakeTransport, type FakeConnection } from '@tianting/sdk/testing';
import { act, render } from '@testing-library/react';
import { App } from '../App';
import { saveSession } from '../lib/session';

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
