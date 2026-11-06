/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** 为 "false" 时是生产构建：服务端说开也不显示演示表单（PRD-chat F-ACC-07 规则 4）。 */
  readonly VITE_DEMO_LOGIN?: string;
}
