import { avatarColorIndex, avatarInitial } from '@tianting/sdk';

/** 头像（PRD-ui F-UI-21）：一期只有占位头像；用户圆形，群圆角方形。图片头像随 users 命令（FE-103）接入。 */
export function Avatar({ id, name, size, group = false }: { id: string; name: string; size: number; group?: boolean }) {
  return (
    <span
      className={`tt-avatar${group ? ' tt-avatar-group' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `var(--tt-avatar-${avatarColorIndex(id)})`,
      }}
      aria-hidden="true"
      data-testid="avatar"
    >
      {avatarInitial(name)}
    </span>
  );
}
