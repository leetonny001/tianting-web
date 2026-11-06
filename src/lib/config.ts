import type { AccountConfig } from '@tianting/sdk';

export const APP_NAME = '天听';
export const APP_VERSION = __APP_VERSION__;
export const BUILD_ID = __BUILD_ID__;

/** 演示入口的构建开关（F-ACC-07 规则 4）。是上限：生产构建 VITE_DEMO_LOGIN=false，服务端说开也不显示。 */
export const demoBuildEnabled = () => import.meta.env.VITE_DEMO_LOGIN !== 'false';

/** 两者同时为真才显示演示表单（R-CF-11）。 */
export const demoFormEnabled = (config: Pick<AccountConfig, 'demoLogin'>) => demoBuildEnabled() && config.demoLogin;

/** 同源 WebSocket 地址（PRD-ui F-UI-03 规则 7：只支持同源部署，开发时由 Vite 转发）。 */
export function wsURL(loc: Location = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
