import { messageFor as commandMessage } from '@tianting/sdk';
import { formatDateTime, formatMonthDayTime } from './time';

// 错误文案（PRD-core 第 5 节文案表、PRD-ui F-UI-19）：先查"命令 + 码"，没有单独列出的用该码的默认文案；
// 从不展示服务端的 msg。errors.json 新增 ws 通道的码时，必须在这里补上文案（errors.test.ts 自动检查）。
/** 原文件不在了，只能删除这条消息（F-FILE-07 规则 4，AC-FILE-07-10）。 */
export const SOURCE_MISSING = '原文件已不可用，请重新选择';

const BY_CODE: Record<number, string> = {
  4000: '请求出错',
  4001: '当前版本过低，请刷新页面',
  4002: '请求出错',
  4003: '请求出错',
  4004: '账号格式不正确',
  4005: '不能发送空白消息',
  4006: '消息过长',
  4007: '请求出错',
  4008: '请求出错',
  4009: '请求出错',
  4010: '登录已失效，请重新登录',
  4011: '登录已过期，请重新登录',
  4012: '账号已被下线',
  4030: '无权限',
  4031: '你已被禁言',
  4032: '请求出错',
  4033: '你已不在该群',
  4035: '对方开启了好友验证，你还不是他的好友',
  4036: '消息已发出，但被对方拒收了',
  4040: '内容不存在',
  4041: '请求出错',
  4042: '用户不存在',
  4043: '群聊不存在或已解散',
  4045: '该申请已过期',
  4046: '对方已不在群里',
  4048: '文件不存在或已过期',
  4090: '请求出错',
  4091: '你们已经是朋友了',
  // 4096：文件未完成上传或已被清理（F-FILE-07 规则 4）。SDK 有源就重新上传，走到界面上的只有没有源的情况。
  4096: SOURCE_MISSING,
  4130: '请求出错',
  4131: '请求出错',
  4132: '你的好友数量已达上限',
  4133: '对方好友数量已达上限',
  4134: '黑名单已满',
  4135: '加入的群聊已达上限',
  4136: '管理员最多 10 人',
  4137: '对方回复之前，发送的消息数量已达上限',
  4290: '发送太频繁，请稍后再试',
  4292: '今天的次数已用完，明天再试',
  5000: '服务异常，请稍后重试',
  5030: '服务异常，请稍后重试',
};

// SDK 的"命令 + 错误码"表（PRD-social 9.4 节）之外，只属于某个页面的文案。
const BY_CMD: Record<string, Record<number, string>> = {
  friendApply: { 4000: '请先将对方移出黑名单' },
  friendRemark: { 4040: '对方已不在你的通讯录中' },
  groupCreate: { 4130: '群成员已达上限' },
  groupInvite: { 4130: '群成员已达上限' },
};

/** 开发期缺陷类的码：只写日志，界面统一提示"请求出错"。 */
export const LOG_ONLY = new Set([4000, 4002, 4003, 4007, 4008]);

/** 按"命令 + 错误码"取文案；不认识的 4xxx 提示"请求出错"，5xxx 提示"服务异常，请稍后重试"（C-09）。 */
export function messageFor(code: number, cmd?: string, ctx?: { strangerMsgLimit?: number; name?: string }): string {
  const special = cmd ? (BY_CMD[cmd]?.[code] ?? commandMessage(cmd, code, ctx)) : undefined;
  if (special) return special;
  if (BY_CODE[code]) return BY_CODE[code];
  return code >= 5000 ? '服务异常，请稍后重试' : '请求出错';
}

/** 被删除的消息和会话摘要（PRD-core 第 5 节）。 */
export const MESSAGE_DELETED = '该消息已被删除';

/** 封禁（4034、kicked.reason = suspended，PRD-core 第 5 节、PRD-ui F-UI-18）：永久（null）或缺字段时没有解封时间。 */
export function bannedText(until: number | null | undefined): string {
  return typeof until === 'number' ? `账号已被封禁，解封时间：${formatDateTime(until)}` : '账号已被封禁';
}

/** 禁言条（4031、muted，PRD-core 第 5 节、PRD-ui F-UI-41）：永久（null）没有解除时间。 */
export function mutedText(until: number | null): string {
  return until !== null ? `你已被禁言，解除时间：${formatMonthDayTime(until)}` : messageFor(4031);
}

/** 全群禁言的禁言条（PRD-ui F-UI-41 规则 3，AC-UI-41-6）。 */
export const GROUP_ALL_MUTED = '群主已开启全员禁言';

export const KNOWN_CODES = Object.keys(BY_CODE).map(Number);
