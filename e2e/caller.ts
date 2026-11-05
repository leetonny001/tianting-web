// 第二批管理接口（封禁、禁言、删除）要调用方签名，旧 X-Admin-Key 调不了。这里的值只给本机的测试服务端用。
export const CALLER_ID = 'web-e2e';
export const CALLER_SECRET = 'web-e2e-test-only-caller-secret-0123456789';
export const QUARANTINE_KEY = 'web-e2e-test-only-quarantine-key-0123456789';
export const CALLERS_JSON = JSON.stringify([
  {
    id: CALLER_ID,
    alg: 'hmac-sha256',
    secret: Buffer.from(CALLER_SECRET).toString('base64'),
    scopes: ['user.ban', 'msg.delete', 'mute.write'],
  },
]);
