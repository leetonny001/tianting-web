import { defineConfig, devices } from '@playwright/test';
import { SERVER, WEB } from './e2e/ports';

// FE-640、FE-672、FE-686 跨端用例（e2e/xp-files.spec.ts、xp-c4.spec.ts、xp-c5.spec.ts）：服务端和假 S3 由别的仓库起好（tianting-android 的 scripts/test-server.sh，
// TT_S3_PORT=19200、TT_S3_ORIGINS 放行这里的页面），这里只起开发服务器。端口用 TT_E2E_PORT_OFFSET=200 对上
// （服务端 18280、管理 18281、假 S3 19200、页面 15373），管理密钥用 TT_E2E_ADMIN_KEY。结果是 Chrome，本地。
//   TT_E2E_PORT_OFFSET=200 TT_E2E_ADMIN_KEY=… TT_XP=… TT_XP_PHASE=send|receive npx playwright test -c playwright.xp.config.ts
//   C5（两端同时在线）：再加 TT_XP_PHASE=d1|d2、TT_XP_FROM=android|ios、TT_XP_COORD=http://127.0.0.1:<信号端口>，只跑 xp-c5.spec.ts
//   C6（FE-698）：TT_XP_PHASE=reporter | observer（再加 TT_XP_DIR）| final、TT_XP_COORD，只跑 xp-c6.spec.ts
export default defineConfig({
  testDir: 'e2e',
  testMatch: /xp-(files|c4|c5|c6)\.spec\.ts/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: WEB, ...(process.env.CI ? {} : { channel: 'chrome' }), trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: [
    {
      command: `npx vite --host 127.0.0.1 --port ${new URL(WEB).port} --strictPort`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { TIANTING_SERVER: SERVER },
    },
  ],
});
