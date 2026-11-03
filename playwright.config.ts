import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 端到端测试连真实的 im-server（测试模式 + 演示登录）：服务端源码默认在同级目录 ../tianting-server/server（或旧名 ../im-mvp/server），
// 也可以用 TIANTING_SERVER_DIR 指定。
const serverDir = resolve(
  process.env.TIANTING_SERVER_DIR ??
    (existsSync('../tianting-server/server') ? '../tianting-server/server' : '../im-mvp/server'),
);
const db = join(mkdtempSync(join(tmpdir(), 'tt-web-e2e-')), 'im.db');
export const SERVER = 'http://127.0.0.1:18080';
export const ADMIN = 'http://127.0.0.1:18081';
export const WEB = 'http://127.0.0.1:15173';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: WEB,
    // 本机有 Chrome 时直接用它（不用下载浏览器）；CI 里用 playwright install 装的 Chromium。
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: [
    {
      command: 'go run ./cmd/im-server',
      cwd: serverDir,
      url: `${SERVER}/readyz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        IM_ADDR: '127.0.0.1:18080',
        IM_ADMIN_ADDR: '127.0.0.1:18081',
        IM_METRICS_ADDR: 'off',
        IM_DB: db,
        IM_TEST_MODE: '1',
        IM_DEMO_LOGIN: '1',
        IM_ALLOWED_ORIGINS: WEB,
      },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 15173 --strictPort',
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { TIANTING_SERVER: SERVER },
    },
  ],
});
