import { IMError, type IMClient } from '@tianting/sdk';
import { messageFor } from './errors';
import { chatPath } from './routes';
import { errCode } from './social';

export const MAX_GROUP_NAME = 50;
export const MAX_NOTICE = 1000;
export const MAX_GROUP_BATCH = 50;
export const MIN_GROUP_PICK = 2;
const GROUP_PREFIX = 'group:';

export const isGroupConv = (convId: string) => convId.startsWith(GROUP_PREFIX);
export const groupIdOf = (convId: string) => convId.slice(GROUP_PREFIX.length);

export const infoPath = (convId: string) => `${chatPath(convId)}/info`;
export const noticePath = (convId: string) => `${chatPath(convId)}/notice`;
export const invitePath = (convId: string) => `${chatPath(convId)}/invite`;
export type MemberMode = 'view' | 'kick' | 'admin' | 'transfer';
export const membersPath = (convId: string, mode: MemberMode = 'view') =>
  `${chatPath(convId)}/members${mode === 'view' ? '' : `?mode=${mode}`}`;

/** 建群 / 邀请的错误文案（F-UI-35 规则 5、F-UI-39 规则 3）：带 userId 时用对方显示名，是自己时用"你"。 */
export function memberErrorText(code: number, userId: string | undefined, cmd: string, c: IMClient, self: string) {
  if (code === 4135 && userId === self) return '你加入的群聊已达上限';
  if (!userId) return messageFor(code, code === 4035 || code === 4135 ? undefined : cmd);
  return messageFor(code, cmd, { name: c.displayName(userId) });
}

export function groupCreateErrorText(e: unknown, c: IMClient, self: string) {
  return memberErrorText(errCode(e), e instanceof IMError ? e.userId : undefined, 'groupCreate', c, self);
}

/** ack 的 failed 文案：最多 3 条，其余合并（F-UI-39 规则 3）。 */
export function inviteResultText(
  added: number,
  failed: ReadonlyArray<{ userId: string; code: number }>,
  c: IMClient,
  self: string,
): string {
  const parts: string[] = added > 0 ? [`已邀请 ${added} 人`] : [];
  for (const f of failed.slice(0, 3)) parts.push(memberErrorText(f.code, f.userId, 'groupInvite', c, self));
  if (failed.length > 3) parts.push(`另有 ${failed.length - 3} 人邀请失败`);
  return parts.join('；');
}
