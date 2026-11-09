// 端到端测试的端口。TT_E2E_PORT_OFFSET：本机同时跑多套时错开（默认不偏移）。
const offset = Number(process.env.TT_E2E_PORT_OFFSET ?? 0);
export const PORTS = {
  server: 18080 + offset,
  admin: 18081 + offset,
  web: 15173 + offset,
  prod: 15174 + offset,
  nodemo: 15175 + offset,
  /** 假 S3（e2e/fake_s3.py，PRD-chat 第 4.5 节）：浏览器直连它上传、下载，跨域。 */
  s3: 19000 + offset,
};
const at = (port: number) => `http://127.0.0.1:${port}`;
export const SERVER = at(PORTS.server);
export const ADMIN = at(PORTS.admin);
export const WEB = at(PORTS.web);
/** 生产构建（带 CSP）。 */
export const PROD = at(PORTS.prod);
/** 生产构建 + VITE_DEMO_LOGIN=false。 */
export const NODEMO = at(PORTS.nodemo);
/** 假 S3 的源（构建变量 VITE_STORAGE_ORIGINS 用它，CSP 的 connect-src 只加这一个）。 */
export const S3 = at(PORTS.s3);
