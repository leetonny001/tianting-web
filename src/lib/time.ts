// 时间显示（PRD-core F-MSG-06 规则 4）：今天 HH:mm，昨天"昨天 HH:mm"，今年 MM-DD HH:mm，更早 YYYY-MM-DD HH:mm。
// 会话列表同样的规则（今天只显示 HH:mm）。消息之间间隔超过 5 分钟才显示时间分隔。
const pad = (n: number) => String(n).padStart(2, '0');

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = startOfDay(n);
  if (ts >= today) return hm;
  if (ts >= today - 86_400_000) return `昨天 ${hm}`;
  if (d.getFullYear() === n.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** YYYY-MM-DD（本机时区）：找回截止日期（PRD-chat F-ACC-03 规则 6a）。 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm（本机时区）。 */
export function formatDateTime(ts: number): string {
  return `${new Date(ts).getFullYear()}-${formatMonthDayTime(ts)}`;
}

/** MM-DD HH:mm（本机时区）。 */
export function formatMonthDayTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const DIVIDER_GAP_MS = 5 * 60 * 1000;

/** 第 i 条消息前是否显示时间分隔：第一条显示；与上一条间隔超过 5 分钟显示。 */
export function needsDivider(prevTs: number | undefined, ts: number): boolean {
  return prevTs === undefined || ts - prevTs > DIVIDER_GAP_MS;
}
