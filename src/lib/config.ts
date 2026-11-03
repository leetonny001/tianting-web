export const APP_NAME = '天听';
export const APP_VERSION = __APP_VERSION__;
export const BUILD_ID = __BUILD_ID__;
/** 演示登录只在开发 / 演示构建中开启；生产构建（VITE_DEMO_LOGIN=false）只显示"请从业务方入口进入天听"。 */
export const DEMO_LOGIN = import.meta.env.VITE_DEMO_LOGIN !== 'false';

/** 同源 WebSocket 地址（PRD-ui F-UI-03 规则 7：只支持同源部署，开发时由 Vite 转发）。 */
export function wsURL(loc: Location = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
