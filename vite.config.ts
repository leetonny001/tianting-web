import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

// 开发时把 /demo/login 和 /ws 同源转发到本机的 im-server（PRD-ui F-UI-03 规则 7：H5 只支持同源部署）。
const server = process.env.TIANTING_SERVER ?? 'http://127.0.0.1:8080';

// 生产构建的 CSP（PRD-ui NF-UI-14、FE-246）。开发服务器会注入内联脚本（React 热更新），所以只在构建时加。
// frame-ancestors 只能通过响应头设置，见 deploy/nginx.conf。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'", // 头像背景色等少量 style 属性
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const cspPlugin = {
  name: 'tianting-csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    ),
};

export default defineConfig({
  plugins: [react(), cspPlugin],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(process.env.TIANTING_BUILD_ID ?? 'dev'),
  },
  server: {
    proxy: {
      '/demo/login': { target: server, changeOrigin: false },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: {
    // 与 deploy/nginx.conf 一致的响应头（AC-UI-22-2、AC-UI-90-13）：e2e 按生产方式验证。
    headers: { 'Content-Security-Policy': `${CSP}; frame-ancestors 'none'` },
    proxy: {
      '/demo/login': { target: server, changeOrigin: false },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    sourcemap: false, // 生产构建不带源码（FE-220）
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    restoreMocks: true,
  },
});
