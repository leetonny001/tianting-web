import {
  AccountClient,
  FetchHttpTransport,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@tianting/sdk';
import { createSessionStore } from '../lib/session';
import type { TabGuard } from '../lib/tabGuard';

const REFRESH_PATH = '/v1/account/token/refresh';

/**
 * 刷新前再确认一次还占着这个 sid（F-ACC-03 规则 9）。确认失败时不发请求，本地按"会话已失效"结束：
 * 这时另一个页面在用同一个 refresh token，发出去就可能是重放；也不能调 logout，否则把另一个页面一起吊销。
 */
export class GuardedHttp implements HttpTransport {
  constructor(
    private readonly inner: HttpTransport,
    private readonly guard: TabGuard,
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (new URL(req.url).pathname === REFRESH_PATH && !(await this.guard.confirm())) {
      return { status: 401, text: JSON.stringify({ code: 4019, msg: 'local', reason: 'revoked' }) };
    }
    return this.inner.request(req);
  }
}

export interface AccountDeps {
  /** 测试注入。 */
  http?: HttpTransport;
  clock?: Clock;
}

export interface AccountRuntime {
  client: AccountClient;
  detachStore(): void;
}

export function createAccountRuntime(guard: TabGuard, deps?: AccountDeps): AccountRuntime {
  const store = createSessionStore();
  const client = new AccountClient({
    baseUrl: window.location.origin,
    platform: 'web',
    store,
    http: new GuardedHttp(deps?.http ?? new FetchHttpTransport(), guard),
    clock: deps?.clock,
  });
  return { client, detachStore: store.detach };
}
