import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

// 开发时把 /demo/login 和 /ws 同源转发到本机的 im-server（PRD-ui F-UI-03 规则 7：H5 只支持同源部署）。
const server = process.env.TIANTING_SERVER ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
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
