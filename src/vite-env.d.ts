/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** 为 "false" 时是生产构建：不显示演示登录（PRD-ui F-UI-03 规则 8）。 */
  readonly VITE_DEMO_LOGIN?: string;
}
