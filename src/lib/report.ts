import { REPORT_NOTE_MAX } from '@tianting/sdk';

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

// 哪些消息显示"举报"由 SDK 的 IMClient.canReport(m) 判断（frontend-chat 第 77、88、89、92 条，三套 SDK 同一口径），页面不再自己判断。
