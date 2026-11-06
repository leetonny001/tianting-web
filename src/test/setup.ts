import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { stubFetch } from './harness-fetch';

// 页面启动时会拉 GET /v1/config。默认回演示配置，测试自己的 fetch 用 stubFetch 接在后面。
beforeEach(() => {
  stubFetch(async () => new Response('{}', { status: 500 }));
});
afterEach(() => vi.unstubAllGlobals());
