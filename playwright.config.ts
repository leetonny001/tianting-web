import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CALLERS_JSON, QUARANTINE_KEY } from './e2e/caller';
import { ADMIN, NODEMO, PORTS, PROD, S3, SERVER, WEB } from './e2e/ports';

// 端到端测试连真实的 im-server（测试模式 + 演示登录）：服务端源码默认在同级目录 ../tianting-server/server（或旧名 ../im-mvp/server），
// 也可以用 TIANTING_SERVER_DIR 指定。
const serverDir = resolve(
  process.env.TIANTING_SERVER_DIR ??
    (existsSync('../tianting-server/server') ? '../tianting-server/server' : '../im-mvp/server'),
);
// TT_E2E_TMP：临时库和构建放这里，跑完整个目录一起删（默认系统临时目录，配置每次求值都会多一个）。
const tmp = mkdtempSync(join(process.env.TT_E2E_TMP ?? tmpdir(), 'tt-web-e2e-'));
const nodemoDist = join(tmp, 'dist-nodemo');
const db = join(tmp, 'im.db');
const callers = join(tmp, 'callers.json');
writeFileSync(callers, CALLERS_JSON, { mode: 0o600 }); // 服务端要求 0600
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
      // 假 S3（PRD-chat 第 4.5 节）：im-server 的对象存储和浏览器的直传、下载都打到这里；CORS 只放行三个页面的源。
      command: `python3 -I e2e/fake_s3.py --port ${PORTS.s3} --origins ${WEB},${PROD},${NODEMO}`,
      url: `${S3}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // TT_E2E_SERVER_BIN：已经 go build 好的二进制（本地并行跑多个 agent 时用，配合 TT_E2E_PORT_OFFSET 换端口）。
      command: process.env.TT_E2E_SERVER_BIN ?? 'go run ./cmd/im-server',
      cwd: serverDir,
      url: `${SERVER}/readyz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        IM_ADDR: new URL(SERVER).host,
        IM_ADMIN_ADDR: new URL(ADMIN).host,
        IM_METRICS_ADDR: 'off',
        IM_DB: db,
        IM_TEST_MODE: '1',
        IM_DEMO_LOGIN: '1',
        IM_V13_ADMIN_FEATURES: '1',
        IM_PUSH_ENABLED: '1',
        IM_QUARANTINE_KEY: QUARANTINE_KEY,
        IM_ADMIN_CALLERS: callers,
        IM_ALLOWED_ORIGINS: `${WEB},${PROD},${NODEMO}`,
        IM_REGISTER_MODE: 'invite', // PRD-chat F-ACC-01：账号页面用 /admin/invites 发的邀请码
        IM_TEST_DISABLE_AUTH_LOCK: '1', // 用例共用一个 IP，真实限流在服务端 e2e（TC-ACC-02-04 等）
        // 图片和文件（C2）：对象存储是上面的假 S3。凭证只是假 S3 的占位，不是真的密钥。
        IM_FILES_ENABLED: '1',
        IM_OBJSTORE_ENDPOINT: S3,
        IM_OBJSTORE_REGION: 'us-east-1',
        IM_OBJSTORE_BUCKET: 'chat',
        IM_OBJSTORE_PUBLIC_BUCKET: 'avatars',
        IM_OBJSTORE_PUBLIC_BASE_URL: `${S3}/avatars`,
        IM_OBJSTORE_ACCESS_KEY: 'web-e2e-fake-s3',
        IM_OBJSTORE_SECRET_KEY: 'web-e2e-fake-s3-not-a-secret',
      },
    },
    {
      // 生产构建（带 CSP meta）：csp.spec.ts 用它检查没有 CSP 违规。
      command: `npx vite build --logLevel warn && npx vite preview --host 127.0.0.1 --port ${PORTS.prod} --strictPort`,
      url: PROD,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TIANTING_SERVER: SERVER, VITE_STORAGE_ORIGINS: S3 },
    },
    {
      // 生产开关的构建（VITE_DEMO_LOGIN=false，TC-ACC-07-07）：服务端说开也不能显示演示表单。输出到临时目录，不碰 dist。
      command: `npx vite build --logLevel warn --outDir ${nodemoDist} --emptyOutDir && npx vite preview --outDir ${nodemoDist} --host 127.0.0.1 --port ${PORTS.nodemo} --strictPort`,
      url: NODEMO,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TIANTING_SERVER: SERVER, VITE_DEMO_LOGIN: 'false', VITE_STORAGE_ORIGINS: S3 },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${PORTS.web} --strictPort`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { TIANTING_SERVER: SERVER },
    },
  ],
});
