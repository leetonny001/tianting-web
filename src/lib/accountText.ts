import { AccountError, sessionDialogText, type FatalReason } from '@tianting/sdk';
import { bannedText, messageFor } from './errors';
import { formatDate } from './time';

export const NETWORK_ERROR = '网络异常，请稍后重试';
export const RECOVERY_LOST_WARNING = '恢复码丢失后账号无法找回';
export const PRIVACY_OPEN_FAILED = '暂时打不开，请稍后重试';
/** F-ACC-08 规则 1。 */
export const DELETE_WARNING = '7 天后不可恢复，用户名不能再使用，已发的消息会保留';

const minutes = (seconds: unknown) => Math.max(1, Math.ceil((typeof seconds === 'number' ? seconds : 60) / 60));

/** 账号接口的错误文案（第 13.4 节、AC-ACC-01-18、02-9）。从不展示服务端的 msg。 */
export function accountErrorText(err: unknown): string {
  if (!(err instanceof AccountError)) return NETWORK_ERROR;
  switch (err.code) {
    case 4004:
      return '用户名格式不正确';
    case 4000:
      return err.reason === 'passwordWeak' ? '密码太简单' : messageFor(4000);
    case 4030:
      if (err.reason === 'inviteInvalid') return '邀请码无效';
      if (err.reason === 'registerClosed') return '当前不开放注册';
      return messageFor(4030);
    case 4034:
      return bannedText(err.details?.bannedUntil as number | null | undefined);
    case 4290:
      return '操作太频繁，请稍后再试';
    case 4294:
      return `尝试次数过多，请 ${minutes(err.details?.retryAfterSeconds)} 分钟后再试`;
    case 5030:
      return '服务暂不可用';
    case 4510:
      // 昵称、用户名被拦截（C6，P-48 ⑥）：不是消息，用"内容包含不当信息，请修改后重试"；表单内容保留（frontend-chat 第 82 条）。
      return messageFor(4510, 'account');
    default:
      return err.code >= 5000 ? messageFor(5000) : messageFor(err.code);
  }
}

export const isWrongCredentials = (err: unknown) => err instanceof AccountError && err.code === 4018;

/** 注销冷静期内登录（F-ACC-08 规则 2）。 */
export function deletionPendingAt(err: unknown): number | null {
  if (!(err instanceof AccountError) || err.code !== 4030 || err.reason !== 'accountDeletionPending') return null;
  const at = err.details?.deleteAt;
  return typeof at === 'number' ? at : 0;
}

const KICK_TEXT: Record<string, string> = {
  tokenInvalid: '登录已失效，请重新登录',
  tokenExpired: '登录已过期，请重新登录',
  banned: '账号已被下线',
  tooManyConnections: '登录设备过多，当前设备已下线',
};

/**
 * 被踢、会话结束弹窗文案（PRD-ui F-UI-18、PRD-chat F-ACC-03 规则 6a）：有 recoverBefore 就提示日期，
 * 否则先按 kicked.reason，不认识时按关闭码。
 */
export function fatalText(r: FatalReason): string {
  if (r.kind === 'session') {
    if (r.action === 'banNotice') return bannedText(undefined);
    if (r.reason === 'accountDeleted' && !r.dialog) return '已申请注销账号。7 天内可以用密码登录并撤销';
    return sessionDialogText(r, formatDate) ?? '登录已失效，请重新登录';
  }
  if (r.kind === 'kicked' && r.recoverBefore) {
    return sessionDialogText({ dialog: 'recoverBefore', recoverBefore: r.recoverBefore }, formatDate)!;
  }
  if (r.kind === 'kicked' && r.reason === 'suspended') return bannedText(r.until);
  if (r.kind === 'kicked' && KICK_TEXT[r.reason]) return KICK_TEXT[r.reason]!;
  if (r.code === 4429) return KICK_TEXT.tooManyConnections!;
  return messageFor(r.code);
}

const EVENT_TEXT: Record<string, string> = {
  newDeviceLogin: '新设备登录',
  passwordChanged: '修改密码',
  passwordRecovered: '找回密码',
  loggedOutOthers: '退出其他设备',
  recoveryCodeRegenerated: '重新生成恢复码',
  deletionRequested: '申请注销',
  deletionCanceled: '撤销注销',
  refreshReplay: '检测到登录凭证异常',
  refreshRateLimited: '刷新登录过于频繁',
  newIpPrefix: '从新的网络使用',
};

export const accountEventText = (kind: string) => EVENT_TEXT[kind] ?? '账号安全事件';

const PLATFORM_TEXT: Record<string, string> = { android: 'Android', ios: 'iOS', web: '网页', pc: '电脑' };
export const platformText = (p: string | undefined) => (p ? (PLATFORM_TEXT[p] ?? p) : '');

// 新设备登录的文案来自 PRD（AC-ACC-02-13），其他的是实现时加的，待确认（问题表 A12）。
const SECURITY_NOTICE_TEXT: Record<string, string> = {
  newDeviceLogin: '你的账号在新设备登录',
  recoveryCodeRegenerated: '你的恢复码已重新生成',
  refreshReplay: '检测到你的账号登录凭证异常',
  refreshRateLimited: '你的账号登录凭证刷新过于频繁',
  newIpPrefix: '你的账号正在新的网络使用',
  passwordChanged: '你的账号密码已被修改',
  passwordRecovered: '你的账号已通过恢复码重设密码',
};
export const securityNoticeText = (kind: string) => SECURITY_NOTICE_TEXT[kind] ?? null;
