import { vi } from 'vitest';

export const DEMO_CONFIG = {
  registerMode: 'invite',
  demoLogin: true,
  features: { files: false },
  limits: {
    usernameMinLen: 4,
    usernameMaxLen: 32,
    passwordMinLen: 8,
    passwordMaxLen: 128,
    nicknameMaxLen: 32,
    deviceNameMaxLen: 64,
  },
};

/** 替换 fetch：GET /v1/config 回演示配置，其他请求交给 rest。返回只记录 rest 那部分调用的 mock。 */
export function stubFetch(rest: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(rest);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/config')) return Promise.resolve(new Response(JSON.stringify(DEMO_CONFIG)));
    return mock(input, init);
  });
  return mock;
}
