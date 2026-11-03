// 占位头像（PRD-ui F-UI-21）：首字取显示名的第一个码点（拉丁字母转大写），
// 背景色 = 调色板[FNV-1a-32(UTF-8(id)) mod 8]，用户用 userId、群用 groupId，各端一致。
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const avatarColorIndex = (id: string) => fnv1a32(id) % 8;

export function avatarInitial(name: string): string {
  const first = [...name.trim()][0] ?? '?';
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}
