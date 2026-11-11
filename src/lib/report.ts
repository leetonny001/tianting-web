import { REPORT_NOTE_MAX, type Message } from '@tianting/sdk';

// 举报（PRD-chat F-MOD-03，C6，FE-693）。

/** 6 个理由和界面文案（frontend-chat 第 78 条，三端和后台一致）：默认不选，必须选一个才能提交。 */
export const REPORT_REASONS = [
  { value: 'spam', label: '垃圾广告' },
  { value: 'abuse', label: '辱骂骚扰' },
  { value: 'porn', label: '色情低俗' },
  { value: 'fraud', label: '诈骗' },
  { value: 'illegal', label: '违法违规' },
  { value: 'other', label: '其他' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['value'];

export { REPORT_NOTE_MAX };
export const REPORT_HINT = '所选内容将提交给平台审核';
export const REPORT_DONE = '已提交，感谢你的反馈';

/** 补充说明按码点数（和服务端一致，frontend-chat 第 84 条）。 */
export const codePoints = (s: string) => [...s].length;
/** 截断到 max 个码点。 */
export const clampCodePoints = (s: string, max = REPORT_NOTE_MAX) => [...s].slice(0, max).join('');

const REPORTABLE_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'file']);

/**
 * 消息菜单里显示不显示"举报"（frontend-chat 第 77 条）。**临时放在页面里**：问题 88 定了三套 SDK 统一提供
 * `canReport(m)`，sdk-ts 补上之后这里换成调用 SDK（判断条件照抄第 77 条，不要各自改）。
 *
 * - 普通消息：别人发的（`from` 不是自己）、已经发送成功的（`status=sent`，有 `msgId`）`text`、`image`、`file`；
 *   自己的、`tip`、`custom`、发送中和失败的、后台删除的都没有。
 * - 撤回的消息（撤回提示行）：别人的消息，并且是别人撤回的；我自己以群主、管理员身份撤回的不显示；
 *   不知道是谁撤回的（`recalledBy` 为空）按"别人撤回"处理，显示（协调方按第 77、88 条定的口径）。
 *   自己的消息不管谁撤回都不显示（同普通消息"别人发的"）。
 *
 * `features.moderation` 关闭时三类入口都不显示，由调用方判断（第 76 条）。
 */
export function canReport(m: Message, self: string): boolean {
  if (!m.msgId || m.from === self) return false;
  // 撤回提示行：只有别人撤回的；我以群主、管理员身份撤回的别人的消息不显示；recalledBy 为空按"别人撤回"处理。
  if (m.recalled) return !m.recalledBy || m.recalledBy !== self;
  return !m.deleted && m.status === 'sent' && REPORTABLE_TYPES.has(m.type);
}
