// 第二批管理接口（封禁、禁言、删除）要调用方签名，旧 X-Admin-Key 调不了。这里的值只给本机的测试服务端用。
export const CALLER_ID = 'web-e2e';
export const CALLER_SECRET = 'web-e2e-test-only-caller-secret-0123456789';
export const QUARANTINE_KEY = 'web-e2e-test-only-quarantine-key-0123456789';
// 举报证据的密钥（C6，IM_REPORT_KEY：32 字节的 base64，不能和隔离密钥相同）。只给本机测试服务端用。
export const REPORT_KEY = Buffer.from('web-e2e-test-only-report-key-012').toString('base64');
/** extraScopes：服务端新版本才认识的 scope（老版本不认识会拒绝启动，见 playwright.config.ts）。 */
export const callersJson = (extraScopes: string[] = []) =>
  JSON.stringify([
    {
      id: CALLER_ID,
      alg: 'hmac-sha256',
      secret: Buffer.from(CALLER_SECRET).toString('base64'),
      scopes: [
        'user.ban',
        'msg.delete',
        'mute.write',
        'push.user',
        'push.all',
        'group.write',
        'social.settings',
        'account.invite',
        ...extraScopes,
      ],
      // 持有 push.all 必须配 pushTypes，否则 IM_PUSH_ENABLED 开启时启动失败（PRD-live F-PUSH-09 规则 3）。
      pushTypes: ['notice', 'promo'],
    },
  ]);
/** 不带新 scope 的调用方配置。 */
export const CALLERS_JSON = callersJson();
